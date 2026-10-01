import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { captureInvocation, type InvocationHandle, type InvocationInput, type InvocationResult, type StopReason, type TaskClone, type UnreleasedResource } from '../agents/contract.ts';
import type { AttemptRecord, LedgerEntry, Store } from './store.ts';
import { ATTEMPT_PHASES, GuardRefusal, ShuttingDownError, WRITABLE_KINDS, bounded, sameContext, type AttemptKind, type Classification, type FirstReason, type ShutdownCapability, settleWith } from './lifecycle.ts';

/** What F's host-side preparation hands to D's start call. */
export interface PreparedAttempt {
  readonly clone: TaskClone;
  readonly vendor: 'claude' | 'codex';
  readonly approvedArgv: readonly (readonly string[])[];
  /** Opaque data the deps keep for their own finish/release steps (for example the task workspace). */
  readonly private?: unknown;
}
/** The ledger record saved with `completed` in the same transaction (runner-lifecycle.md, publication step 3). */
export interface HistoryRecord { readonly base: string; readonly head: string; readonly entries: readonly LedgerEntry[] }
/** A finish step's failure with its own actionable diagnostic (for example a safety violation). */
export class FinishFailure extends Error {}
/**
 * Preparation failed after it allocated task storage. `allocated` lets the coordinator remove that storage after the
 * terminal write, as on every other path (runner-lifecycle.md, "Task storage is never removed before the terminal write").
 */
export class PreparationFailure extends Error {
  readonly allocated: PreparedAttempt;
  constructor(cause: unknown, allocated: PreparedAttempt) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.allocated = allocated; }
}
export interface RunnerDeps {
  /**
   * The runner token D labels every resource with (32 lowercase hex characters). `prepare` must allocate task storage
   * under the same token, because D refuses storage owned by another runner.
   */
  readonly runnerOwner: string;
  /**
   * Host-side preparation (clone, prompt). On abort it must stop and await every subprocess it started, then reject.
   * It never leaves work running after it settles.
   */
  prepare(attempt: AttemptRecord, signal: AbortSignal): Promise<PreparedAttempt>;
  /**
   * Remove host-side preparation files only: before the terminal write when D never ran, after it once D settled.
   * Task storage waits for the terminal write.
   */
  cleanupPreparation(attempt: AttemptRecord): Promise<void>;
  /** D's start call: returns a handle at once, or throws with nothing left running. */
  start(input: InvocationInput, prepared: PreparedAttempt): InvocationHandle;
  /** Validate a clean result; throw with an actionable reason if it is invalid. Returns the value to persist. */
  validate(attempt: AttemptRecord, result: InvocationResult): unknown;
  /**
   * Optional asynchronous replacement for validate, used by writable attempts: audit, make the runner commit inside
   * task storage, and return the value plus the ledger record. Nothing is written to the Store here; the record is
   * saved with `completed` in one transaction. Throw FinishFailure with an actionable diagnostic to fail the attempt.
   */
  finish?(attempt: AttemptRecord, result: InvocationResult, prepared: PreparedAttempt, signal: AbortSignal): Promise<{ value: unknown; history?: HistoryRecord }>;
  /**
   * Optional, for writable attempts whose agent ended badly on its own (a non-zero exit, a D stop reason, or a result
   * that is not this attempt's, with no first reason): check what it left before the terminal write, recording any safety finding durably, so a failed run that
   * did something unsafe goes to a person instead of being retried (#87 item 2). It commits nothing and never throws
   * past its own failures: the attempt fails either way.
   */
  auditFailed?(attempt: AttemptRecord, prepared: PreparedAttempt, signal: AbortSignal): Promise<void>;
  /**
   * Optional, for writable attempts that did not complete: save their partial output before the terminal write, which
   * stores the reference (`diagnostic_ref`). It bounds itself and reports a failure instead of throwing.
   */
  exportPartial?(attempt: AttemptRecord, prepared: PreparedAttempt): Promise<{ diagnosticRef?: string; failure?: string }>;
  /** Optional: remove task storage after the terminal write and before the slot is freed. A failure keeps the slot under a marker. */
  release?(attempt: AttemptRecord, prepared: PreparedAttempt): Promise<void>;
  now?(): number;
}
export interface SlotLimits { readonly writable: number; readonly readOnly: number }
export interface StartRequest {
  expectedStateVersion: number; kind: AttemptKind; item?: string | null; deadline: number; budgetMs?: number; retryOf?: string;
  expectedContext: AttemptRecord['context'];
}
export interface RunnerStatus {
  active: boolean;
  stopRequested: { attemptId: string; reason: FirstReason; saved: boolean } | null;
  unresolved: { attemptId: string; reason: UnresolvedReason } | null;
}
/**
 * Why a task's slot stays held until restart: the terminal write failed, pending -> running failed, the host-side
 * preparation files could not be removed, or task storage could not be removed after a saved terminal write.
 */
export type UnresolvedReason = 'result-not-saved' | 'start-not-saved' | 'preparation-not-removed' | 'storage-not-removed';
type Group = 'writable' | 'readOnly';
interface Job {
  identity: PlanIdentity; key: string; group: Group; attemptId: string; attempt?: AttemptRecord;
  firstReason: FirstReason | null; reasonSaved: boolean; preparationTimedOut: boolean; staleCause?: string;
  /**
   * The outcome is fixed: before launch once the job starts ending (cleanup, then the terminal write), after launch once
   * the terminal write is done. A later stop has nothing left to change.
   */
  decided?: boolean;
  /** A cancel task the Store recorded on a job that no longer takes stops; shown in status only. */
  cancelShown?: boolean;
  controller: AbortController; handle?: InvocationHandle; timers: ReturnType<typeof setTimeout>[]; done?: Promise<void>;
}
interface Marker { group: Group; attemptId: string; reason: UnresolvedReason }

const D_REASON: Record<FirstReason, StopReason> = { cancelled: 'cancelled', stale: 'cancelled', shutdown: 'shutdown', 'time-limit': 'timeout' };
/** setTimeout accepts at most 2^31-1 ms; longer waits are re-armed. */
const MAX_TIMER = 2_147_483_647;
const PREPARATION_TIMEOUT = 'Timed out while preparing.';
export const NEEDS_RESTART: Readonly<Record<UnresolvedReason, string>> = {
  'result-not-saved': 'Needs restart: the last result could not be saved.',
  'start-not-saved': 'Needs restart: the start of the last attempt could not be saved.',
  'preparation-not-removed': 'Needs restart: the last attempt\'s preparation files could not be removed.',
  'storage-not-removed': 'Needs restart: the last attempt\'s task storage could not be removed.',
};
const FOREIGN_RESULT = 'The agent returned a result for a different attempt; it was not saved.';
const NOT_STARTED_UNRELEASED = 'Not started: an earlier agent\'s cleanup could not be confirmed. Restart codeboost to run it again.';

/**
 * One runner coordinator per process and Store. Owns in-memory jobs, slots and unresolved markers.
 * See docs/implementation/runner-lifecycle.md ("Slots and concurrency", "Launch", "Rules for the running state").
 */
export class RunnerCoordinator {
  #store: Store; #deps: RunnerDeps; #limits: SlotLimits;
  #jobs = new Map<string, Job>(); #markers = new Map<string, Marker>();
  #closing = false;
  /** Set once D settles with `unreleased`: no new work until a restart's recovery confirms their removal. */
  #unreleased: UnreleasedResource[] | null = null;
  /** Settlement writes run with the shutdown capability, so they still land after the write gate closes. */
  #write: <T>(fn: () => T) => T;
  constructor(store: Store, deps: RunnerDeps, limits: SlotLimits = { writable: 1, readOnly: 1 }, capability?: ShutdownCapability) {
    if (![limits.writable, limits.readOnly].every(n => Number.isSafeInteger(n) && n >= 1)) throw new Error('Slot limits must be positive integers.');
    this.#store = store; this.#deps = deps; this.#limits = limits;
    this.#write = settleWith(capability);
  }
  /** Shutdown step 1: reject admission synchronously, in the same turn as the server flag and the Store gate. */
  rejectAdmission(): void { this.#closing = true; }
  get closing(): boolean { return this.#closing; }
  /** Resources D could not confirm removed; non-null keeps the runner closed to new work until restart. */
  get unreleased(): readonly UnreleasedResource[] | null { return this.#unreleased; }
  #now(): number { return this.#deps.now?.() ?? Date.now(); }
  #used(group: Group): number {
    let used = 0;
    for (const job of this.#jobs.values()) if (job.group === group) used++;
    for (const marker of this.#markers.values()) if (marker.group === group) used++;
    return used;
  }
  /**
   * Admission. In-memory checks and the slot reservation happen in one synchronous turn before the Store transaction;
   * a refused transaction releases the reservation in the same turn.
   */
  start(identity: PlanIdentity, request: StartRequest): AttemptRecord {
    if (this.#closing) throw new ShuttingDownError();
    if (this.#unreleased) throw new GuardRefusal('Needs restart: an agent\'s cleanup could not be confirmed, so its containers or files may remain.');
    const key = identityKey(identity);
    if (this.#jobs.has(key)) throw new GuardRefusal('An attempt is already active for this task.');
    const marker = this.#markers.get(key);
    if (marker) throw new GuardRefusal(NEEDS_RESTART[marker.reason]);
    if (!(request.kind in ATTEMPT_PHASES)) throw new GuardRefusal('Unknown attempt kind.');
    const group: Group = WRITABLE_KINDS.includes(request.kind) ? 'writable' : 'readOnly';
    if (this.#used(group) >= this.#limits[group]) throw new GuardRefusal('No free runner slot. Try again when the current attempt finishes.');
    const job: Job = { identity: { ...identity }, key, group, attemptId: '', firstReason: null, reasonSaved: true, preparationTimedOut: false, controller: new AbortController(), timers: [] };
    this.#jobs.set(key, job);
    let attempt: AttemptRecord;
    try { attempt = this.#store.admitAttempt(identity, { ...request, now: this.#now() }); }
    catch (error) { this.#jobs.delete(key); throw error; }
    job.attemptId = attempt.id; job.attempt = attempt;
    job.done = this.#run(job, attempt);
    return attempt;
  }
  /** Retry is a new attempt bound to the latest failed or cancelled one. */
  retry(identity: PlanIdentity, attemptId: string, request: Omit<StartRequest, 'retryOf'>): AttemptRecord {
    return this.start(identity, { ...request, retryOf: attemptId });
  }
  /**
   * User stop or detected staleness. The first reason wins; nothing is freed until settlement.
   * `cause` says what made the attempt stale (for example "plan revision 4 replaced 3") and is kept only if `stale` wins.
   */
  stop(identity: PlanIdentity, attemptId: string, reason: 'cancelled' | 'stale', cause?: string): boolean {
    const job = this.#jobs.get(identityKey(identity));
    if (!job || job.attemptId !== attemptId) return false;
    const won = this.#requestStop(job, reason);
    if (won && reason === 'stale' && cause !== undefined) job.staleCause = bounded(cause);
    return won;
  }
  /** Cancel task: the Store records the reason and the pending close; the coordinator stops the running work. */
  cancelTask(identity: PlanIdentity, expectedStateVersion: number, actionId: string): 'closed' | 'stopping' {
    const job = this.#jobs.get(identityKey(identity));
    // The Store writes `cancelled` wherever the row has no reason yet, so save an earlier unsaved reason first. That write
    // bumps the state version, so it is made only when the caller's version is current, and the cancel then uses the new one.
    if (job?.firstReason && !job.reasonSaved) {
      try {
        if (this.#store.getTask(identity).stateVersion === expectedStateVersion
          && this.#store.recordFirstReason(job.identity, job.attemptId, job.firstReason)) {
          job.reasonSaved = true; this.#confirmSaved(job);
          expectedStateVersion = this.#store.getTask(identity).stateVersion;
        }
      } catch { /* still unsaved; the Store's own write below is likely to fail the same way */ }
    }
    const outcome = this.#store.cancelTask(identity, expectedStateVersion, actionId);
    if (outcome === 'stopping' && job && !this.#requestStop(job, 'cancelled') && !job.firstReason) {
      // The Store already wrote `cancelled` onto the row (a pending cancel task wins, even over a preparation timeout).
      // Status shows it, but it never becomes the job's reason: the write may roll back with the caller's transaction,
      // and the terminal write reads the row's own reason anyway.
      job.cancelShown = true;
      queueMicrotask(() => {
        try { if (this.#store.getAttempt(job.identity, job.attemptId).firstReason !== 'cancelled') job.cancelShown = false; }
        catch { /* unreadable: keep showing what the Store reported */ }
      });
    }
    return outcome;
  }
  isActive(identity: PlanIdentity): boolean { return this.#jobs.has(identityKey(identity)); }
  status(identity: PlanIdentity): RunnerStatus {
    const key = identityKey(identity), job = this.#jobs.get(key), marker = this.#markers.get(key);
    return {
      active: !!job,
      stopRequested: job?.firstReason ? { attemptId: job.attemptId, reason: job.firstReason, saved: job.reasonSaved }
        : job?.cancelShown ? { attemptId: job.attemptId, reason: 'cancelled', saved: true } : null,
      unresolved: marker ? { attemptId: marker.attemptId, reason: marker.reason } : null,
    };
  }
  /** Resolves when the task's current job has settled (or immediately if there is none). */
  async settled(identity: PlanIdentity): Promise<void> { await this.#jobs.get(identityKey(identity))?.done; }
  /**
   * Shutdown step 4: reject admission, record `shutdown` only where no reason is set, stop everything and await settlement.
   * No timer abandons a job (decision 4); the Store stays open for the caller to close afterwards.
   */
  async close(): Promise<void> {
    this.#closing = true;
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) this.#requestStop(job, 'shutdown');
    await Promise.all(jobs.map(job => job.done));
  }

  #requestStop(job: Job, reason: FirstReason): boolean {
    // The attempt deadline passed before launch: it ends `failed` with no first reason, so a later stop cannot claim it.
    if (job.decided || (job.preparationTimedOut && !job.firstReason)) return false;
    if (job.firstReason) { job.handle?.cancel(D_REASON[job.firstReason]); return false; }
    job.firstReason = reason;
    try {
      if (job.attemptId && !this.#write(() => this.#store.recordFirstReason(job.identity, job.attemptId, reason))) {
        // Another writer (for example cancel task) recorded a reason first; adopt the durable one.
        const durable = this.#store.getAttempt(job.identity, job.attemptId).firstReason;
        if (durable) job.firstReason = durable;
      }
      job.reasonSaved = true; this.#confirmSaved(job);
    } catch { job.reasonSaved = false; }
    job.controller.abort(new Error(`Stopped: ${job.firstReason}`));
    job.handle?.cancel(D_REASON[job.firstReason]);
    return true;
  }
  /**
   * A reason write may be part of the caller's transaction (userAction) and roll back with it. Once that transaction
   * has ended, check the row, so an undone write shows as unsaved and the next cancel task saves it again.
   */
  #confirmSaved(job: Job): void {
    queueMicrotask(() => {
      if (!job.firstReason || !job.reasonSaved) return;
      try { if (this.#store.getAttempt(job.identity, job.attemptId).firstReason !== job.firstReason) job.reasonSaved = false; }
      catch { /* unreadable: keep what the write reported */ }
    });
  }
  /** Task budget and, before launch, the attempt deadline. D enforces the deadline once it runs. */
  #arm(job: Job, attempt: AttemptRecord): void {
    const at = (when: number, fire: () => void) => {
      const wait = () => {
        const remaining = when - this.#now();
        if (remaining <= 0) return fire();
        job.timers.push(setTimeout(wait, Math.min(remaining, MAX_TIMER)));
      };
      wait();
    };
    const budget = this.#store.getTask(job.identity).budgetDeadline;
    if (budget !== null) at(budget, () => this.#requestStop(job, 'time-limit'));
    at(attempt.deadline, () => { if (!job.handle && !job.firstReason) { job.preparationTimedOut = true; job.controller.abort(new Error(PREPARATION_TIMEOUT)); } });
  }
  async #run(job: Job, attempt: AttemptRecord): Promise<void> {
    try {
      // Admission may be part of the caller's transaction (userAction). Start nothing until that transaction has ended:
      // if it rolled back, the row is gone and the job only gives back its reservation.
      await null;
      if (!this.#store.getAttempts(job.identity).some(row => row.id === attempt.id)) return;
      // A failed read ends the attempt before preparation.
      try { this.#arm(job, attempt); }
      catch (error) { return await this.#endBeforeLaunch(job, attempt, { detail: `Could not arm the task time limit: ${message(error)}` }); }
      // A stop can land before this point; do not start preparation for it.
      if (job.firstReason) return await this.#endBeforeLaunch(job, attempt, {});
      let prepared: PreparedAttempt;
      try { prepared = await this.#deps.prepare(attempt, job.controller.signal); }
      catch (error) {
        // Storage that preparation allocated before it failed is removed after the terminal write, like every other path.
        return await this.#endBeforeLaunch(job, attempt, this.#preparationDetail(job, error), error instanceof PreparationFailure ? error.allocated : undefined);
      }
      if (job.firstReason || job.preparationTimedOut) return await this.#endBeforeLaunch(job, attempt, this.#preparationDetail(job), prepared);
      // Launch check: one synchronous turn, no await between the checks and D's start call.
      const now = this.#now(), row = this.#store.getAttempt(job.identity, attempt.id), task = this.#store.getTask(job.identity);
      if (row.firstReason && !job.firstReason) job.firstReason = row.firstReason;
      if (row.state !== 'pending' || job.firstReason) return await this.#endBeforeLaunch(job, attempt, {}, prepared);
      // A context change comes before both time checks, as in the settlement order and startup recovery.
      if (!sameContext(row.context, this.#store.currentContext(job.identity))) {
        // Recorded like any stale stop, so the row keeps it even if a cancel task lands during cleanup.
        this.#requestStop(job, 'stale');
        return await this.#endBeforeLaunch(job, attempt, {}, prepared);
      }
      if (task.budgetDeadline !== null && now >= task.budgetDeadline) { this.#requestStop(job, 'time-limit'); return await this.#endBeforeLaunch(job, attempt, {}, prepared); }
      if (now >= attempt.deadline) { job.preparationTimedOut = true; return await this.#endBeforeLaunch(job, attempt, { detail: PREPARATION_TIMEOUT }, prepared); }
      // Fail closed: once D reported resources it could not remove, no new invocation starts, even one already admitted.
      if (this.#unreleased) return await this.#endBeforeLaunch(job, attempt, { detail: NOT_STARTED_UNRELEASED }, prepared);
      let handle: InvocationHandle;
      try {
        const input = captureInvocation({ clone: prepared.clone, phase: ATTEMPT_PHASES[attempt.kind], vendor: prepared.vendor,
          approvedArgv: prepared.approvedArgv, deadline: attempt.deadline, attemptId: attempt.id, runnerOwner: this.#deps.runnerOwner, context: attempt.context }, now);
        handle = this.#deps.start(input, prepared);
      } catch (error) { return await this.#endBeforeLaunch(job, attempt, { detail: `Launch failed: ${message(error)}` }, prepared); }
      job.handle = handle;
      let running: boolean | undefined;
      try { running = this.#write(() => this.#store.markRunning(job.identity, attempt.id)); } catch { running = undefined; }
      if (running === undefined) {
        // A storage error, not a stop: keep ownership until D settles, then hold the slot under a marker.
        handle.cancel('capture-failure');
        const result = await handle.settled.catch(() => undefined);
        if (result) this.#noteUnreleased(result);
        this.#markers.set(job.key, { group: job.group, attemptId: attempt.id, reason: 'start-not-saved' });
        return;
      }
      if (!running) {
        // Refused because a first reason is now recorded: a normal stop.
        // A read failure must not strand the live handle: fall back to the in-memory reason and still await D.
        let durable: FirstReason | null = null;
        try { durable = this.#store.getAttempt(job.identity, attempt.id).firstReason; } catch { /* keep the in-memory reason */ }
        if (durable && !job.firstReason) job.firstReason = durable;
        handle.cancel(D_REASON[job.firstReason ?? 'cancelled']);
      } else if (job.firstReason) handle.cancel(D_REASON[job.firstReason]);
      const result = await handle.settled;
      this.#noteUnreleased(result);
      // Accept only the result of this exact invocation, as the question path does. Anything else is never validated
      // or saved: the attempt fails closed.
      if (result.attemptId !== attempt.id || !result.context || !sameContext(result.context, attempt.context)) {
        // The result is not this attempt's, but the storage is: what the agent left is audited and kept all the same.
        const evidence = await this.#keepEvidence(job, attempt, prepared, job.firstReason === 'stale' ? job.staleCause : FOREIGN_RESULT, true);
        const foreignSaved = this.#settle(job, { stopReason: 'capture-failure', exitCode: null, signal: null, valid: false, ...evidence });
        job.decided = true;
        // Task storage and host-side preparation files wait for the terminal write, as on every other path.
        if (foreignSaved) await this.#release(job, attempt, prepared);
        if (foreignSaved && !(await this.#removePreparation(job, attempt))) this.#holdForPreparation(job);
        return;
      }
      // The agent's stderr is its own text: quote it (AGENTS.md), so it cannot forge a runner line in the diagnostic.
      let valid = false, value: unknown, history: HistoryRecord | undefined, detail = result.stderr ? JSON.stringify(bounded(result.stderr)) : undefined;
      if (!job.firstReason && result.exitCode === 0 && !result.stopReason) {
        try {
          if (this.#deps.finish) { const done = await this.#deps.finish(attempt, result, prepared, job.controller.signal); value = done.value; history = done.history; }
          else value = this.#deps.validate(attempt, result);
          valid = true;
        } catch (error) { detail = error instanceof FinishFailure ? bounded(error.message) : `Invalid output: ${message(error)}`; }
      }
      // A stale stop keeps its own cause; the agent's stderr is not a reason the attempt went stale.
      if (job.firstReason === 'stale') detail = job.staleCause;
      // A clean exit was audited by finish already; only a run that ended badly on its own is audited here.
      const clean = !job.firstReason && result.exitCode === 0 && !result.stopReason;
      const evidence = valid ? { detail } : await this.#keepEvidence(job, attempt, prepared, detail, !clean);
      const saved = this.#settle(job, { stopReason: result.stopReason, exitCode: result.exitCode, signal: result.signal, valid, result: value, history, ...evidence });
      job.decided = true;
      // Task storage goes after the terminal write too; a failed removal holds the slot under a marker.
      if (saved) await this.#release(job, attempt, prepared);
      // Host-side preparation files go after the terminal write, so a failed write leaves them for startup recovery.
      if (saved && !(await this.#removePreparation(job, attempt))) this.#holdForPreparation(job);
    } catch (error) {
      // Set the marker before the job goes, so the slot is never free in between.
      this.#unexpected(job, error);
    } finally {
      for (const timer of job.timers) clearTimeout(timer);
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    }
  }
  /**
   * For an attempt that ran and did not complete, before its terminal write: audit what the agent left when it ended
   * badly on its own (no first reason), recording any safety finding, and keep its partial output for diagnosis. Returns
   * the terminal write's detail and `diagnosticRef`.
   */
  async #keepEvidence(job: Job, attempt: AttemptRecord, prepared: PreparedAttempt, detail: string | undefined, audit: boolean)
    : Promise<{ detail?: string; diagnosticRef?: string }> {
    if (audit && !job.firstReason && this.#deps.auditFailed) {
      // The attempt fails whatever this finds.
      try { await this.#deps.auditFailed(attempt, prepared, job.controller.signal); }
      catch (error) { console.error(`Runner job ${job.attemptId} could not audit its failed run: ${JSON.stringify(message(error))}`); }
    }
    if (!this.#deps.exportPartial) return { detail };
    let exported: { diagnosticRef?: string; failure?: string };
    try { exported = await this.#deps.exportPartial(attempt, prepared); }
    catch (error) { exported = { failure: message(error) }; }
    // The reason can quote agent-chosen paths: quoted, like the agent's own text.
    return { diagnosticRef: exported.diagnosticRef, detail: exported.failure
      ? bounded(`${detail ?? ''} Partial output could not be exported: ${JSON.stringify(exported.failure)}`.trim()) : detail };
  }
  /** D gave up on cleanup (presence, not length, is the signal): fail closed until restart, as Ask does. */
  #noteUnreleased(result: InvocationResult): void {
    if (result.unreleased === undefined) return;
    this.#unreleased = [...(this.#unreleased ?? []), ...result.unreleased];
    console.error(`Runner job ${result.attemptId} left resources whose removal was not confirmed; new work is refused until restart.`);
  }
  #preparationDetail(job: Job, error?: unknown): { detail?: string } {
    // D never ran, so there is no D stop reason; without one the Store keeps this text instead of "Timed out.".
    if (job.preparationTimedOut && !job.firstReason) return { detail: PREPARATION_TIMEOUT };
    // Preparation errors can name repository paths an agent chose (an earlier item's files): quote them (AGENTS.md).
    return error === undefined || job.firstReason ? {} : { detail: `Preparation failed: ${JSON.stringify(message(error))}` };
  }
  /** Ending without a handle: host-side cleanup, then the terminal write from the first reason. */
  async #endBeforeLaunch(job: Job, attempt: AttemptRecord, s: { detail?: string }, prepared?: PreparedAttempt): Promise<void> {
    // Stops that land while preparation finishes are taken into account; once the job is ending, the outcome is fixed.
    job.decided = true;
    const removed = await this.#removePreparation(job, attempt);
    const saved = this.#settle(job, { exitCode: null, signal: null, valid: false, detail: job.firstReason === 'stale' ? job.staleCause : s.detail });
    // Task storage (if preparation allocated it) waits for the terminal write, like every other path.
    if (saved && prepared) await this.#release(job, attempt, prepared);
    if (!removed) this.#holdForPreparation(job);
  }
  /**
   * Remove host-side preparation files. If that fails, they still hold a clone of the task, so the caller keeps the slot
   * held under a marker until startup recovery removes the attempt directory.
   */
  async #removePreparation(job: Job, attempt: AttemptRecord): Promise<boolean> {
    try { await this.#deps.cleanupPreparation(attempt); return true; }
    catch (error) {
      console.error(`Runner job ${job.attemptId} could not remove its preparation files: ${JSON.stringify(message(error))}`);
      return false;
    }
  }
  /** Set in the same turn the job goes, so the slot is never free in between. A failed terminal write's marker stays. */
  #holdForPreparation(job: Job): void {
    if (!this.#markers.has(job.key)) this.#markers.set(job.key, { group: job.group, attemptId: job.attemptId, reason: 'preparation-not-removed' });
  }
  /** After the terminal write: remove task storage, then the slot is freed. A failure keeps the slot under a marker. */
  async #release(job: Job, attempt: AttemptRecord, prepared: PreparedAttempt): Promise<void> {
    if (!this.#deps.release) return;
    try { await this.#deps.release(attempt, prepared); }
    catch (error) {
      console.error(`Runner job ${job.attemptId} could not remove its task storage: ${JSON.stringify(message(error))}`);
      if (!this.#markers.has(job.key)) this.#markers.set(job.key, { group: job.group, attemptId: job.attemptId, reason: 'storage-not-removed' });
    }
  }
  #settle(job: Job, s: { stopReason?: StopReason; exitCode: number | null; signal: string | null; valid: boolean; result?: unknown; detail?: string; history?: HistoryRecord; diagnosticRef?: string }): Classification | undefined {
    try {
      return this.#write(() => this.#store.settleAttempt(job.identity, job.attemptId, { ...s, firstReason: job.firstReason }));
    } catch {
      // The row's outcome is unknown: hold the slot until startup recovery reconciles it.
      this.#markers.set(job.key, { group: job.group, attemptId: job.attemptId, reason: 'result-not-saved' });
      return undefined;
    }
  }
  #unexpected(job: Job, error: unknown): void {
    // Fail closed: an unexpected error keeps the slot held until restart.
    this.#markers.set(job.key, { group: job.group, attemptId: job.attemptId, reason: 'result-not-saved' });
    console.error(`Runner job ${job.attemptId} failed unexpectedly: ${JSON.stringify(message(error))}`);
  }
}
const message = (error: unknown) => bounded(error instanceof Error ? error.message : String(error));

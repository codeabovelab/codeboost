import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { captureInvocation, type InvocationHandle, type InvocationInput, type InvocationResult, type StopReason, type TaskClone } from '../agents/contract.ts';
import type { AttemptRecord, Store } from './store.ts';
import { ATTEMPT_PHASES, GuardRefusal, ShuttingDownError, WRITABLE_KINDS, bounded, sameContext, type AttemptKind, type Classification, type FirstReason, type ShutdownCapability } from './lifecycle.ts';

/** What F's host-side preparation hands to D's start call. */
export interface PreparedAttempt {
  readonly clone: TaskClone;
  readonly vendor: 'claude' | 'codex';
  readonly approvedArgv: readonly (readonly string[])[];
}
export interface RunnerDeps {
  /**
   * Host-side preparation (clone, prompt). On abort it must stop and await every subprocess it started, then reject.
   * It never leaves work running after it settles.
   */
  prepare(attempt: AttemptRecord, signal: AbortSignal): Promise<PreparedAttempt>;
  /** Remove host-side preparation files only. Task storage waits for the terminal write. */
  cleanupPreparation(attempt: AttemptRecord): Promise<void>;
  /** D's start call: returns a handle at once, or throws with nothing left running. */
  start(input: InvocationInput, prepared: PreparedAttempt): InvocationHandle;
  /** Validate a clean result; throw with an actionable reason if it is invalid. Returns the value to persist. */
  validate(attempt: AttemptRecord, result: InvocationResult): unknown;
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
  unresolved: { attemptId: string; reason: 'result-not-saved' | 'start-not-saved' } | null;
}
type Group = 'writable' | 'readOnly';
interface Job {
  identity: PlanIdentity; key: string; group: Group; attemptId: string; attempt?: AttemptRecord;
  firstReason: FirstReason | null; reasonSaved: boolean; preparationTimedOut: boolean;
  controller: AbortController; handle?: InvocationHandle; timers: ReturnType<typeof setTimeout>[]; done?: Promise<void>;
}
interface Marker { group: Group; attemptId: string; reason: 'result-not-saved' | 'start-not-saved' }

const D_REASON: Record<FirstReason, StopReason> = { cancelled: 'cancelled', stale: 'cancelled', shutdown: 'shutdown', 'time-limit': 'timeout' };
/** setTimeout accepts at most 2^31-1 ms; longer waits are re-armed. */
const MAX_TIMER = 2_147_483_647;

/**
 * One runner coordinator per process and Store. Owns in-memory jobs, slots and unresolved markers.
 * See docs/implementation/runner-lifecycle.md ("Slots and concurrency", "Launch", "Rules for the running state").
 */
export class RunnerCoordinator {
  #store: Store; #deps: RunnerDeps; #limits: SlotLimits;
  #jobs = new Map<string, Job>(); #markers = new Map<string, Marker>();
  #closing = false;
  /** Settlement writes run with the shutdown capability, so they still land after the write gate closes. */
  #write: <T>(fn: () => T) => T;
  constructor(store: Store, deps: RunnerDeps, limits: SlotLimits = { writable: 1, readOnly: 1 }, capability?: ShutdownCapability) {
    if (![limits.writable, limits.readOnly].every(n => Number.isSafeInteger(n) && n >= 1)) throw new Error('Slot limits must be positive integers.');
    this.#store = store; this.#deps = deps; this.#limits = limits;
    this.#write = capability ? fn => capability.run(fn) : fn => fn();
  }
  /** Shutdown step 1: reject admission synchronously, in the same turn as the server flag and the Store gate. */
  rejectAdmission(): void { this.#closing = true; }
  get closing(): boolean { return this.#closing; }
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
    const key = identityKey(identity);
    if (this.#jobs.has(key)) throw new GuardRefusal('An attempt is already active for this task.');
    const marker = this.#markers.get(key);
    if (marker) throw new GuardRefusal('Needs restart: the last result could not be saved.');
    if (!(request.kind in ATTEMPT_PHASES)) throw new GuardRefusal('Unknown attempt kind.');
    const group: Group = WRITABLE_KINDS.includes(request.kind) ? 'writable' : 'readOnly';
    if (this.#used(group) >= this.#limits[group]) throw new GuardRefusal('No free runner slot. Try again when the current attempt finishes.');
    const job: Job = { identity: { ...identity }, key, group, attemptId: '', firstReason: null, reasonSaved: true, preparationTimedOut: false, controller: new AbortController(), timers: [] };
    this.#jobs.set(key, job);
    let attempt: AttemptRecord;
    try { attempt = this.#store.admitAttempt(identity, { ...request, now: this.#now() }); }
    catch (error) { this.#jobs.delete(key); throw error; }
    job.attemptId = attempt.id; job.attempt = attempt;
    this.#arm(job, attempt);
    // Start after the caller's transaction commits: a rolled-back admission must not leave a job running.
    job.done = Promise.resolve().then(() => this.#run(job, attempt)).catch(error => this.#unexpected(job, error));
    return attempt;
  }
  /** Retry is a new attempt bound to the latest failed or cancelled one. */
  retry(identity: PlanIdentity, attemptId: string, request: Omit<StartRequest, 'retryOf'>): AttemptRecord {
    return this.start(identity, { ...request, retryOf: attemptId });
  }
  /** User stop or detected staleness. The first reason wins; nothing is freed until settlement. */
  stop(identity: PlanIdentity, attemptId: string, reason: 'cancelled' | 'stale'): boolean {
    const job = this.#jobs.get(identityKey(identity));
    if (!job || job.attemptId !== attemptId) return false;
    return this.#requestStop(job, reason);
  }
  /** Cancel task: the Store records the reason and the pending close; the coordinator stops the running work. */
  cancelTask(identity: PlanIdentity, expectedStateVersion: number, actionId: string): 'closed' | 'stopping' {
    const outcome = this.#store.cancelTask(identity, expectedStateVersion, actionId);
    const job = this.#jobs.get(identityKey(identity));
    if (outcome === 'stopping' && job) this.#requestStop(job, 'cancelled');
    return outcome;
  }
  isActive(identity: PlanIdentity): boolean { return this.#jobs.has(identityKey(identity)); }
  status(identity: PlanIdentity): RunnerStatus {
    const key = identityKey(identity), job = this.#jobs.get(key), marker = this.#markers.get(key);
    return {
      active: !!job,
      stopRequested: job?.firstReason ? { attemptId: job.attemptId, reason: job.firstReason, saved: job.reasonSaved } : null,
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
    if (job.firstReason) { job.handle?.cancel(D_REASON[job.firstReason]); return false; }
    job.firstReason = reason;
    try {
      if (job.attemptId && !this.#write(() => this.#store.recordFirstReason(job.identity, job.attemptId, reason))) {
        // Another writer (for example cancel task) recorded a reason first; adopt the durable one.
        const durable = this.#store.getAttempt(job.identity, job.attemptId).firstReason;
        if (durable) job.firstReason = durable;
      }
      job.reasonSaved = true;
    } catch { job.reasonSaved = false; }
    job.controller.abort(new Error(`Stopped: ${job.firstReason}`));
    job.handle?.cancel(D_REASON[job.firstReason]);
    return true;
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
    at(attempt.deadline, () => { if (!job.handle && !job.firstReason) { job.preparationTimedOut = true; job.controller.abort(new Error('Timed out while preparing.')); } });
  }
  async #run(job: Job, attempt: AttemptRecord): Promise<void> {
    try {
      if (!this.#store.getAttempts(job.identity).some(row => row.id === attempt.id)) return; // admission was rolled back
      let prepared: PreparedAttempt;
      try { prepared = await this.#deps.prepare(attempt, job.controller.signal); }
      catch (error) { return await this.#endBeforeLaunch(job, attempt, this.#preparationDetail(job, error)); }
      if (job.firstReason || job.preparationTimedOut) return await this.#endBeforeLaunch(job, attempt, this.#preparationDetail(job));
      // Launch check: one synchronous turn, no await between the checks and D's start call.
      const now = this.#now(), row = this.#store.getAttempt(job.identity, attempt.id), task = this.#store.getTask(job.identity);
      if (row.firstReason && !job.firstReason) job.firstReason = row.firstReason;
      if (row.state !== 'pending' || job.firstReason) return await this.#endBeforeLaunch(job, attempt, {});
      if (task.budgetDeadline !== null && now >= task.budgetDeadline) { this.#requestStop(job, 'time-limit'); return await this.#endBeforeLaunch(job, attempt, {}); }
      if (now >= attempt.deadline) return await this.#endBeforeLaunch(job, attempt, { stopReason: 'timeout', detail: 'Timed out while preparing.' });
      if (!sameContext(row.context, this.#store.currentContext(job.identity))) return await this.#endBeforeLaunch(job, attempt, {});
      let handle: InvocationHandle;
      try {
        const input = captureInvocation({ clone: prepared.clone, phase: ATTEMPT_PHASES[attempt.kind], vendor: prepared.vendor,
          approvedArgv: prepared.approvedArgv, deadline: attempt.deadline, attemptId: attempt.id, context: attempt.context }, now);
        handle = this.#deps.start(input, prepared);
      } catch (error) { return await this.#endBeforeLaunch(job, attempt, { detail: `Launch failed: ${message(error)}` }); }
      job.handle = handle;
      let running: boolean | undefined;
      try { running = this.#write(() => this.#store.markRunning(job.identity, attempt.id)); } catch { running = undefined; }
      if (running === undefined) {
        // A storage error, not a stop: keep ownership until D settles, then hold the slot under a marker.
        handle.cancel('capture-failure');
        await handle.settled.catch(() => undefined);
        this.#markers.set(job.key, { group: job.group, attemptId: attempt.id, reason: 'start-not-saved' });
        return;
      }
      if (!running) {
        // Refused because a first reason is now recorded: a normal stop.
        const durable = this.#store.getAttempt(job.identity, attempt.id).firstReason;
        if (durable && !job.firstReason) job.firstReason = durable;
        handle.cancel(D_REASON[job.firstReason ?? 'cancelled']);
      } else if (job.firstReason) handle.cancel(D_REASON[job.firstReason]);
      const result = await handle.settled;
      let valid = false, value: unknown, detail = result.stderr ? bounded(result.stderr) : undefined;
      if (!job.firstReason && result.exitCode === 0 && !result.stopReason) {
        try { value = this.#deps.validate(attempt, result); valid = true; }
        catch (error) { detail = `Invalid output: ${message(error)}`; }
      }
      this.#settle(job, { stopReason: result.stopReason, exitCode: result.exitCode, signal: result.signal, valid, result: value, detail });
    } finally {
      for (const timer of job.timers) clearTimeout(timer);
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    }
  }
  #preparationDetail(job: Job, error?: unknown): { stopReason?: StopReason; detail?: string } {
    if (job.preparationTimedOut && !job.firstReason) return { stopReason: 'timeout', detail: 'Timed out while preparing.' };
    return error === undefined || job.firstReason ? {} : { detail: `Preparation failed: ${message(error)}` };
  }
  /** Ending without a handle: host-side cleanup, then the terminal write from the first reason. */
  async #endBeforeLaunch(job: Job, attempt: AttemptRecord, s: { stopReason?: StopReason; detail?: string }): Promise<void> {
    await this.#deps.cleanupPreparation(attempt).catch(() => undefined);
    this.#settle(job, { stopReason: s.stopReason, exitCode: null, signal: null, valid: false, detail: s.detail });
  }
  #settle(job: Job, s: { stopReason?: StopReason; exitCode: number | null; signal: string | null; valid: boolean; result?: unknown; detail?: string }): Classification | undefined {
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
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    console.error(`Runner job ${job.attemptId} failed unexpectedly: ${message(error)}`);
  }
}
const message = (error: unknown) => bounded(error instanceof Error ? error.message : String(error));

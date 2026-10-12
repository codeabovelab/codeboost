import { randomUUID } from 'node:crypto';
import { GuardRefusal, MERGEABLE_STATUSES, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { MergeOutcomeUnknown, type MergeCoordinator, type MergeStatus } from './merge.ts';
import type { PreMergeCoordinator } from './pre-merge.ts';
import type { ReviewService } from './review.ts';
import type { MergeJob, MergeJobState } from './store.ts';

/** How long a job waits for GitHub's required checks on the pushed head (docs/implementation/merge-handoff.md). */
export const REQUIRED_CHECK_WAIT_MS = 30 * 60_000;
/** The wait between required-check inspections starts here and doubles up to the maximum. */
export const REQUIRED_CHECK_FIRST_DELAY_MS = 10_000;
export const REQUIRED_CHECK_MAX_DELAY_MS = 60_000;

/** A job's answer to the browser: everything but the click's review token. */
export type MergeJobView = Omit<MergeJob, 'token'>;
export const mergeJobView = ({ token: _token, ...job }: MergeJob): MergeJobView => job;

export interface MergeJobTiming { checkWaitMs?: number; firstDelayMs?: number; maxDelayMs?: number }

/** Why the wait for required checks ended. */
type CheckVerdict = { kind: 'ready' } | { kind: 'wait'; checks: { context: string; state: string }[] }
  | { kind: 'blocked'; reason: string } | { kind: 'failed'; reason: string } | { kind: 'cancelled' };

/**
 * The one-click merge (F6b of #22): preparation, the wait for GitHub's required checks on the pushed head, then the
 * guarded merge. One job per task at a time; its progress is saved in `merge_jobs`, never on the task, so the readiness
 * preparation records stays bound while the job waits.
 */
export class MergeJobCoordinator {
  readonly service: ReviewService;
  readonly preMerge: PreMergeCoordinator;
  readonly merges: MergeCoordinator;
  readonly checkWaitMs: number; readonly firstDelayMs: number; readonly maxDelayMs: number;
  readonly settle: <T>(fn: () => T) => T;
  #active: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #closing = false;

  constructor(service: ReviewService, preMerge: PreMergeCoordinator, merges: MergeCoordinator, capability?: ShutdownCapability,
    timing: MergeJobTiming = {}) {
    this.service = service; this.preMerge = preMerge; this.merges = merges;
    this.checkWaitMs = timing.checkWaitMs ?? REQUIRED_CHECK_WAIT_MS;
    this.firstDelayMs = timing.firstDelayMs ?? REQUIRED_CHECK_FIRST_DELAY_MS;
    this.maxDelayMs = timing.maxDelayMs ?? REQUIRED_CHECK_MAX_DELAY_MS;
    for (const value of [this.checkWaitMs, this.firstDelayMs, this.maxDelayMs])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid merge job timing.');
    this.settle = settleWith(capability);
  }

  get active(): boolean { return this.#active !== null; }
  /** The running job's settlement, for the server's after-work hooks; null when none runs. */
  get current(): Promise<void> | null { return this.#active; }
  latest(): MergeJobView | null {
    const job = this.service.store.latestMergeJob(this.service.config.identity);
    return job ? mergeJobView(job) : null;
  }

  /**
   * Admit the click and start its job after the caller's transaction commits. A resend of the same click returns its
   * job without starting another. Refusals save nothing, so the same click may be sent again.
   */
  start(token: unknown, actionId: string, busy: () => string | null = () => null): MergeJobView {
    const { store, config } = this.service, identity = config.identity;
    const saved = store.getMergeJob(identity, actionId);
    if (saved) return mergeJobView(store.beginMergeJob(identity, { actionId, token: token as string }).job);
    if (this.#closing) throw new GuardRefusal('The server is shutting down.');
    if (this.#active) throw new GuardRefusal('A merge is already running for this task.');
    if (typeof token !== 'string' || this.service.load().token !== token) throw new GuardRefusal('Stale review state. Refresh before merging.');
    const task = store.getTask(identity);
    if (!MERGEABLE_STATUSES.includes(task.status)) throw new GuardRefusal(`The task is ${task.status}; merge it from review.`);
    if (task.cancelRequested !== null) throw new GuardRefusal('The task is being cancelled.');
    const reason = busy();
    if (reason) throw new GuardRefusal(reason);
    this.preMerge.assertStartable();
    const { job } = store.beginMergeJob(identity, { actionId, token });
    const abort = new AbortController(); this.#abort = abort;
    const run = Promise.resolve().then(() => this.#run(job, abort.signal)).catch(error => {
      // Anything unexpected ends the job, unless shutdown stopped it: startup then settles it.
      if (!abort.signal.aborted || !this.#closing) this.#finish(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }).finally(() => { if (this.#active === run) { this.#active = null; this.#abort = null; } });
    this.#active = run;
    return mergeJobView(job);
  }

  /** The task was cancelled: stop waiting at once. Preparation and the guarded merge stop through their own routes. */
  cancel(): void { this.#abort?.abort(Object.assign(new Error('Task cancelled.'), { code: 'CANCELLED' })); }

  /** Shutdown's first, synchronous step: no job starts, and a running one stops before it can ask GitHub to merge. */
  stop(): void {
    this.#closing = true;
    this.#abort?.abort(new Error('Server shutdown.'));
  }
  async close(): Promise<void> {
    this.stop();
    await this.#active;
  }

  #finish(id: string, state: Exclude<MergeJobState, 'running'>, reason: string | null = null, url: string | null = null): void {
    try { this.settle(() => this.service.store.finishMergeJob(this.service.config.identity, id, { state, reason, url })); }
    catch { /* Startup settles a job that could not be ended now. */ }
  }

  async #run(job: MergeJob, signal: AbortSignal): Promise<void> {
    const { store, config } = this.service, identity = config.identity;
    // 1. Prepare: refresh, rebase, review check, push, cmd: checks.
    let view = this.service.load();
    const prepareId = randomUUID(), task = store.getTask(identity);
    store.userAction(identity, { actionId: prepareId, kind: 'prepare-merge',
      request: { expectedStateVersion: task.stateVersion, expectedReviewVersion: view.expected.reviewVersion, mergeJob: job.id } },
    () => ({ outcome: 'preparing' }));
    const prepared = await this.preMerge.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
      snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head, actionId: prepareId });
    if (signal.aborted || this.#cancelled()) return this.#end(job, signal);
    if (prepared.state !== 'ready')
      return this.#finish(job.id, prepared.state === 'review-required' ? 'review-required' : 'failed', prepared.reason);
    // 2. Wait for GitHub's required checks on the pushed head.
    this.settle(() => store.updateMergeJob(identity, job.id, { step: 'checks' }));
    const verdict = await this.#awaitChecks(job, signal);
    if (verdict.kind === 'cancelled') return this.#end(job, signal);
    if (verdict.kind === 'blocked') return this.#block(job, verdict.reason);
    if (verdict.kind === 'failed') return this.#finish(job.id, 'failed', verdict.reason);
    // 3. Merge through the guarded merge, which re-validates everything and reruns the already-fixed check.
    // The merge's action ID is saved first: after a restart, the attempt carrying it gives the job's outcome.
    const mergeId = randomUUID();
    this.settle(() => store.updateMergeJob(identity, job.id, { step: 'merging', checks: [], mergeActionId: mergeId }));
    view = this.service.load();
    try {
      // The job's signal stops the guarded merge as shutdown or a deadline stops a click: before GitHub is asked, nothing
      // is applied; after, the outcome is unknown.
      const merged = await this.merges.merge(view.token, mergeId, signal);
      const attempt = store.getMergeAttempt(identity);
      this.#finish(job.id, attempt?.kind === 'queue' && attempt.state !== 'merged' ? 'queued' : 'merged', null, merged.result.url || null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Once this job's merge attempt exists, GitHub was asked: its recorded state is the answer, whatever else (a cancel,
      // shutdown) happened meanwhile. A refusal blocks (design: "GitHub refused the merge"); anything else is unknown.
      const attempt = store.getMergeAttempt(identity);
      if (attempt?.actionId === mergeId) {
        if (attempt.state === 'failed' || attempt.state === 'removed') return this.#block(job, `GitHub refused the merge: ${attempt.reason ?? reason}`);
        if (attempt.state === 'merged') return this.#finish(job.id, 'merged', null, attempt.url);
        if (attempt.state === 'queued') return this.#finish(job.id, 'queued', null, attempt.url);
        return this.#finish(job.id, 'submitted', reason);
      }
      if (error instanceof MergeOutcomeUnknown) return this.#finish(job.id, 'submitted', reason);
      // A cancel or shutdown, whichever way the merge reported it (stopped, or refused because the task was cancelled).
      if (signal.aborted || this.#cancelled()) return this.#end(job, signal);
      this.#finish(job.id, 'failed', reason);
    }
  }

  #cancelled(): boolean {
    const task = this.service.store.getTask(this.service.config.identity);
    return task.status === 'cancelled' || task.cancelRequested !== null;
  }
  /** A cancelled task ends the job, however the job learned of it; shutdown leaves it running on disk for startup. */
  #end(job: MergeJob, signal: AbortSignal): void {
    if ((signal.reason as { code?: string } | undefined)?.code === 'CANCELLED' || this.#cancelled())
      this.#finish(job.id, 'cancelled', 'Task cancelled.');
  }

  /** Approved, merge blocked: the task's next merge prepares again from the start. One Store transaction. */
  #block(job: MergeJob, reason: string): void {
    try { this.settle(() => this.service.store.blockMergeJob(this.service.config.identity, job.id, reason)); }
    catch { /* Startup settles a job that could not be ended now. */ }
  }

  async #awaitChecks(job: MergeJob, signal: AbortSignal): Promise<CheckVerdict> {
    const { store, config } = this.service, identity = config.identity;
    const until = performance.now() + this.checkWaitMs;
    let delay = this.firstDelayMs, waiting: { context: string; state: string }[] = [];
    for (;;) {
      if (signal.aborted) return { kind: 'cancelled' };
      const task = store.getTask(identity);
      if (task.status === 'cancelled' || task.cancelRequested !== null) return { kind: 'cancelled' };
      let status: MergeStatus;
      try { status = await this.merges.status(this.service.load(), true, signal); }
      catch (error) {
        if (signal.aborted) return { kind: 'cancelled' };
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      const verdict = classify(status);
      if (verdict.kind !== 'wait') return verdict;
      waiting = verdict.checks;
      this.settle(() => store.updateMergeJob(identity, job.id, { checks: waiting }));
      const left = until - performance.now();
      if (left <= 0) return { kind: 'blocked', reason: `Required checks did not pass within ${Math.round(this.checkWaitMs / 60_000)} minutes: ${
        waiting.length ? waiting.map(check => `${check.context} is ${check.state}`).join(', ') : 'GitHub has not determined mergeability'}.` };
      await sleep(Math.min(delay, left), signal).catch(() => undefined);
      delay = Math.min(delay * 2, this.maxDelayMs);
    }
  }
}

/** Blockers the merge job resolves itself: it prepares (rebase, push, cmd: checks) and waits for required checks. */
const JOB_RESOLVES = new Set(['preparation', 'base', 'acceptance', 'check']);

/**
 * The merge status the browser sees when merging runs as a job: ready when only blockers the job resolves remain (or
 * GitHub is still computing mergeability), and never while a job or merge attempt is in flight. After a blocked job the
 * action is a retry. The latest job rides along.
 */
export function withMergeJob<T extends { ready: boolean; action: 'merge' | 'retry' | null; blockers: { code: string; message: string }[];
  remote: { mergeable: string } | null; queue: { state: string } | null }>(status: T, job: MergeJobView | null, taskStatus: string): T & { job: MergeJobView | null } {
  const running = job?.state === 'running';
  const attempt = status.queue?.state === 'submitting' || status.queue?.state === 'queued' || status.queue?.state === 'merged';
  const computing = status.remote?.mergeable === 'UNKNOWN';
  // A conflict after the base moved is the job's too: its preparation rebases, through the sandboxed conflict path.
  const rebaseResolves = status.remote?.mergeable === 'CONFLICTING' && status.blockers.some(blocker => blocker.code === 'base');
  const personal = status.blockers.filter(blocker => !JOB_RESOLVES.has(blocker.code) && !(blocker.code === 'mergeable' && (computing || rebaseResolves)));
  const ready = !running && !attempt && status.remote !== null && personal.length === 0;
  return { ...status, ready, action: ready ? (taskStatus === 'approved but merge blocked' || status.action === 'retry' ? 'retry' : 'merge') : null, job };
}

/**
 * One fresh inspection's answer for the wait: a failing required check blocks; pending or missing ones, and GitHub
 * still computing mergeability, wait; any other blocker (the PR moved, readiness lost, the already-fixed check, rules)
 * ends the job for a person to act.
 */
export function classify(status: MergeStatus): CheckVerdict {
  // Another blocker comes first: checks failing on a head nobody reviewed (a collaborator pushed) say nothing about this
  // review, so the job ends for a person to look, rather than blocking on those checks.
  const computing = status.remote.mergeable === 'UNKNOWN';
  const other = status.blockers.filter(blocker => blocker.code !== 'check' && !(blocker.code === 'mergeable' && computing));
  if (other.length) return { kind: 'failed', reason: other[0]!.message };
  const failing = status.remote.requiredChecks.filter(check => check.state === 'failure');
  if (failing.length) return { kind: 'blocked', reason: `Required check${failing.length === 1 ? '' : 's'} failed: ${failing.map(check => check.context).join(', ')}.` };
  const waiting = status.remote.requiredChecks.filter(check => check.state !== 'success')
    .map(check => ({ context: check.context, state: check.state }));
  if (waiting.length || computing) return { kind: 'wait', checks: waiting };
  return status.ready ? { kind: 'ready' } : { kind: 'failed', reason: status.blockers[0]?.message ?? 'Merge is blocked.' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

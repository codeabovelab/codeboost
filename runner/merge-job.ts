import { randomUUID } from 'node:crypto';
import { GuardRefusal, MERGEABLE_STATUSES, ShuttingDownError, settleWith, type ShutdownCapability } from './lifecycle.ts';
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
 * guarded merge. One job per task at a time; its progress is saved in `merge_jobs`, never on the task, so the
 * preparation's readiness record stays bound while the job waits.
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
  /** Whether this click already has a saved job or refusal, which a resend replays without new admission reads. */
  saved(actionId: string): boolean { return this.service.store.getMergeJob(this.service.config.identity, actionId) !== null; }
  latest(): MergeJobView | null {
    const job = this.service.store.latestMergeJob(this.service.config.identity);
    return job ? mergeJobView(job) : null;
  }

  /**
   * Admit the click and start its job after the caller's transaction commits. A resend of the same click returns its
   * job without starting another. A definite refusal is saved under the click's action ID and replayed on resend; only a
   * refusal during shutdown saves nothing, so that click may be sent again.
   */
  async start(token: unknown, actionId: string, busy: () => string | null = () => null, signal?: AbortSignal): Promise<MergeJobView> {
    const { store, config } = this.service, identity = config.identity;
    const replay = () => {
      const { job } = store.beginMergeJob(identity, { actionId, token: token as string });
      // A refused click replays its refusal; anything else is the job this click started.
      if (job.refused) throw new GuardRefusal(job.reason ?? 'The merge was refused.');
      return mergeJobView(job);
    };
    if (store.getMergeJob(identity, actionId)) return replay();
    // Shutdown decides nothing about this click: nothing is saved, and the route answers 503 so the same click is resent.
    if (this.#closing) throw new ShuttingDownError();
    // The review load awaits a history worker (#170), so it comes first: everything after it, from the token check to the
    // job's admission, runs in one turn. A load stopped by shutdown decides nothing, as above.
    let reviewToken: string;
    try { reviewToken = (await this.service.load({ signal })).token; }
    catch (error) { if (this.#closing || signal?.aborted) throw new ShuttingDownError(); throw error; }
    // A resend of this click, or shutdown, may have arrived while the review loaded.
    if (store.getMergeJob(identity, actionId)) return replay();
    if (this.#closing) throw new ShuttingDownError();
    const refusal = this.#admissionRefusal(token, reviewToken, busy);
    if (refusal !== null) {
      // A definite refusal is this click's outcome; a resend replays it (as the guarded merge does).
      if (typeof token === 'string' && token) store.recordMergeJobRefusal(identity, { actionId, token, reason: refusal });
      throw new GuardRefusal(refusal);
    }
    const { job } = store.beginMergeJob(identity, { actionId, token: token as string });
    const abort = new AbortController(); this.#abort = abort;
    const run = Promise.resolve().then(() => this.#run(job, abort.signal)).catch(error => {
      // Anything unexpected ends the job, unless shutdown stopped it (startup then settles it) or the task was cancelled
      // (a cancel during one of the job's own review loads, which await a history worker since #170).
      if (abort.signal.aborted && this.#closing) return;
      if ((abort.signal.reason as { code?: string } | undefined)?.code === 'CANCELLED' || this.#cancelled()) return this.#end(job, abort.signal);
      this.#finish(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }).finally(() => { if (this.#active === run) { this.#active = null; this.#abort = null; } });
    this.#active = run;
    return mergeJobView(job);
  }

  /** Why this click may not start a job now, or null. A preparation stopping for shutdown throws instead (not definite). */
  #admissionRefusal(token: unknown, reviewToken: string, busy: () => string | null): string | null {
    const { store, config } = this.service, identity = config.identity;
    if (this.#active) return 'A merge is already running for this task.';
    if (typeof token !== 'string' || reviewToken !== token) return 'Stale review state. Refresh before merging.';
    const task = store.getTask(identity);
    if (!MERGEABLE_STATUSES.includes(task.status)) return `The task is ${task.status}; merge it from review.`;
    if (task.cancelRequested !== null) return 'The task is being cancelled.';
    const reason = busy();
    if (reason) return reason;
    try { this.preMerge.assertStartable(); }
    catch (error) {
      if (error instanceof GuardRefusal && /shutting down/i.test(error.message)) throw new ShuttingDownError();
      if (!(error instanceof GuardRefusal)) throw error;
      return error.message;
    }
    return null;
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
    let view = await this.service.load({ signal });
    // The load awaited a history worker (#170). A cancel or shutdown during it ends here; otherwise the preparation is
    // bound to the task and review as they are now, all read in this turn (the preparation refuses if they move).
    if (signal.aborted || this.#cancelled()) return this.#end(job, signal);
    const prepareId = randomUUID(), task = store.getTask(identity), snapshot = store.getSnapshot(identity);
    const reviewVersion = store.reviewVersion(identity);
    // Refused here, before the placeholder below is saved, if a preparation cannot start now (the preparation's own check
    // repeats it in this turn).
    this.preMerge.assertStartable();
    store.userAction(identity, { actionId: prepareId, kind: 'prepare-merge',
      request: { expectedStateVersion: task.stateVersion, expectedReviewVersion: reviewVersion, mergeJob: job.id } },
    () => ({ outcome: 'preparing' }));
    const prepared = await this.preMerge.start({ stateVersion: task.stateVersion, reviewVersion,
      snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head, actionId: prepareId });
    if (signal.aborted || this.#cancelled()) return this.#end(job, signal);
    if (prepared.state !== 'ready')
      return this.#finish(job.id, prepared.state === 'review-required' ? 'review-required' : 'failed', prepared.reason);
    // 2. Wait for GitHub's required checks on the pushed head.
    this.settle(() => store.updateMergeJob(identity, job.id, { step: 'checks' }));
    const verdict = await this.#awaitChecks(job, signal);
    if (verdict.kind === 'cancelled') return this.#end(job, signal);
    // A failing or slow check blocks only while the readiness it was read for still holds (in the block's transaction).
    if (verdict.kind === 'blocked') return this.#block(job, verdict.reason, true);
    if (verdict.kind === 'failed') return this.#finish(job.id, 'failed', verdict.reason);
    // 3. Merge through the guarded merge, which re-validates everything and reruns the already-fixed check.
    // The merge's action ID is saved first: after a restart, the attempt carrying it gives the job's outcome.
    const mergeId = randomUUID();
    this.settle(() => store.updateMergeJob(identity, job.id, { step: 'merging', checks: [], mergeActionId: mergeId }));
    view = await this.service.load({ signal });
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
        // A refusal because the head changed needs a fresh review, not a retry: the task is not "approved" any more.
        if ((attempt.state === 'failed' || attempt.state === 'removed') && attempt.requiresFreshReview)
          return this.#finish(job.id, 'failed', `GitHub refused the merge: ${attempt.reason ?? reason} Review the new head, then merge again.`);
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
  #block(job: MergeJob, reason: string, whileReady = false): void {
    const readyFor = whileReady ? { commandPolicyDigest: this.service.commandPolicyDigest() } : undefined;
    try { this.settle(() => this.service.store.blockMergeJob(this.service.config.identity, job.id, reason, readyFor)); }
    catch { /* Startup settles a job that could not be ended now. */ }
  }

  async #awaitChecks(job: MergeJob, signal: AbortSignal): Promise<CheckVerdict> {
    const { store, config } = this.service, identity = config.identity;
    const until = performance.now() + this.checkWaitMs;
    let delay = this.firstDelayMs, waiting: { context: string; state: string }[] = [];
    const timedOut = (): CheckVerdict => ({ kind: 'blocked', reason: `Required checks did not pass within ${Math.round(this.checkWaitMs / 60_000)} minutes: ${
      waiting.length ? waiting.map(check => `${check.context} is ${check.state}`).join(', ') : 'GitHub has not determined mergeability'}.` });
    for (;;) {
      if (signal.aborted) return { kind: 'cancelled' };
      const task = store.getTask(identity);
      if (task.status === 'cancelled' || task.cancelRequested !== null) return { kind: 'cancelled' };
      // No inspection starts after the wait's limit, and each one is stopped when the limit arrives.
      const left = Math.floor(until - performance.now());
      if (left < 1) return timedOut();
      const limit = AbortSignal.timeout(left);
      let status: MergeStatus;
      try { status = await this.merges.status(undefined, true, AbortSignal.any([signal, limit])); }
      catch (error) {
        if (signal.aborted) return { kind: 'cancelled' };
        if (limit.aborted) return timedOut();
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      const verdict = classify(status);
      if (verdict.kind !== 'wait') return verdict;
      waiting = verdict.checks;
      this.settle(() => store.updateMergeJob(identity, job.id, { checks: waiting }));
      const remaining = until - performance.now();
      if (remaining <= 0) return timedOut();
      await sleep(Math.min(delay, remaining), signal).catch(() => undefined);
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
  // The task's status is read after the inspection that produced `status`: a task cancelled or merged meanwhile is never
  // offered Merge PR, even if that inspection had no task blocker.
  const ready = !running && !attempt && status.remote !== null && personal.length === 0
    && MERGEABLE_STATUSES.includes(taskStatus as (typeof MERGEABLE_STATUSES)[number]);
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

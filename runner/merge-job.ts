import { randomUUID } from 'node:crypto';
import { ActionIdReused, GuardRefusal, MERGEABLE_STATUSES, ShuttingDownError, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { MergeBlocked, MergeOutcomeUnknown, PUSH_UNSETTLED, type MergeCoordinator, type MergeStatus } from './merge.ts';
import type { PreMergeCoordinator } from './pre-merge.ts';
import type { ReviewService } from './review.ts';
import { FIX_THEN_RETRY, MAX_MERGE_JOB_TOKEN_LENGTH, type MergeAttempt, type MergeJob, type MergeJobState } from './store.ts';

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
  | { kind: 'blocked'; reason: string; next: string } | { kind: 'failed'; reason: string } | { kind: 'cancelled' };

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
   * job without starting another. A definite refusal is saved under the click's action ID and replayed on resend. A
   * refusal during shutdown saves nothing, so that click may be sent again, and neither does one for a click without a
   * usable review token (missing, not a string, or too long): it is refused, as stale or because a job runs, and nothing
   * is saved, since the store saves a refusal only under a usable token. A resend under an action ID already saved with
   * another token is refused as a reused ID.
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
    catch (error) {
      // A resend of this click may have been admitted while this load was pending: its job is this click's answer.
      if (store.getMergeJob(identity, actionId)) return replay();
      if (this.#closing || signal?.aborted) throw new ShuttingDownError();
      throw error;
    }
    // A resend of this click, or shutdown, may have arrived while the review loaded.
    if (store.getMergeJob(identity, actionId)) return replay();
    if (this.#closing) throw new ShuttingDownError();
    const refusal = this.#admissionRefusal(token, reviewToken, busy);
    if (refusal !== null) {
      // A definite refusal is this click's outcome; a resend replays it (as the guarded merge does).
      if (typeof token === 'string' && token && token.length <= MAX_MERGE_JOB_TOKEN_LENGTH) store.recordMergeJobRefusal(identity, { actionId, token, reason: refusal });
      throw new GuardRefusal(refusal);
    }
    let job: MergeJob;
    try { ({ job } = store.beginMergeJob(identity, { actionId, token: token as string })); }
    catch (error) {
      // The store's own refusal (a job still running on disk after its ending write failed) is definite too: saved and
      // replayed like the refusals above. Its closed-task refusal is defensive here: admission refused that task above,
      // in this same turn.
      if (error instanceof GuardRefusal && !(error instanceof ActionIdReused))
        store.recordMergeJobRefusal(identity, { actionId, token: token as string, reason: error.message });
      throw error;
    }
    const abort = new AbortController(); this.#abort = abort;
    const run = Promise.resolve().then(() => this.#run(job, abort.signal)).catch(error => {
      // Anything unexpected ends the job, unless shutdown stopped it (startup then settles it) or the task was cancelled
      // (a cancel during one of the job's own review loads, which await a history worker since #170). Never rejects: if
      // even reading the task fails here, the job stays running for startup, as when ending it fails.
      try {
        // A cancel is checked before shutdown: a task cancelled before shutdown began ends the job `cancelled` even when
        // the stopped work rejects only after shutdown began (the store's write gate closes after the job is awaited).
        if ((abort.signal.reason as { code?: string } | undefined)?.code === 'CANCELLED' || this.#cancelled()) return this.#end(job, abort.signal);
        if (abort.signal.aborted && this.#closing) return;
        this.#finish(job.id, 'failed', error instanceof Error ? error.message : String(error));
      } catch (unended) { this.#unended(job.id, unended); }
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
    catch (error) { this.#unended(id, error); }
  }

  /** Startup settles a job that could not be ended now; until then it shows as running and a new click is refused. */
  #unended(id: string, error: unknown): void {
    console.error(`Could not end merge job ${id}; it shows as running until the server restarts: ${JSON.stringify((error as Error)?.message ?? String(error))}`);
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
    // repeats it in this turn). Defensive: admission checked it, the server refuses a standalone preparation while a job
    // runs, and shutdown aborts the job (checked above) in the turn before it stops preparation.
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
    if (verdict.kind === 'blocked') return this.#block(job, verdict.reason, verdict.next, true);
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
      // A fulfilled merge does not prove its outcome: when saving it fails, the attempt stays submitting and reconciles
      // from GitHub. This job's own attempt decides, as when the merge rejects. A queue poll that ended the attempt
      // (removed or failed) while GitHub was asked makes the guarded merge reject instead; one ending it after the save is
      // defensive here: the save and this read run in one turn, and a poll's result needs I/O.
      const attempt = store.getMergeAttempt(identity);
      if (attempt?.actionId !== mergeId || attempt.state === 'submitting')
        return this.#finish(job.id, 'submitted', 'GitHub accepted the merge, but its outcome was not saved; it reconciles from GitHub.');
      return this.#endAsAttempt(job, attempt, 'no reason given.', merged.result.url || attempt.url || null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Once this job's merge attempt exists, GitHub was asked: its recorded state is the answer, whatever else (a cancel,
      // shutdown) happened meanwhile. A refusal blocks (design: "GitHub refused the merge"); anything else is unknown.
      const attempt = store.getMergeAttempt(identity);
      if (attempt?.actionId === mergeId) return this.#endAsAttempt(job, attempt, reason, attempt.url);
      if (error instanceof MergeOutcomeUnknown) return this.#finish(job.id, 'submitted', reason);
      // A cancel or shutdown, whichever way the merge reported it (stopped, or refused because the task was cancelled).
      if (signal.aborted || this.#cancelled()) return this.#end(job, signal);
      // The guarded merge's own refusal asks the person to rebase or prepare; the job's reason says what merging does.
      this.#finish(job.id, 'failed', error instanceof MergeBlocked && error.blocker ? `${error.prefix}${inJobTerms(error.blocker).message}` : reason);
    }
  }

  /**
   * End the job as its own merge attempt records GitHub's answer, after the guarded merge fulfilled or rejected: one
   * mapping for both, and for every state the attempt can reach. `reason` stands in when a refusal saved none.
   */
  #endAsAttempt(job: MergeJob, attempt: MergeAttempt, reason: string, url: string | null): void {
    if (attempt.state === 'merged' || attempt.state === 'queued') return this.#finish(job.id, attempt.state, null, url);
    // Reached through the merge's rejection. After a fulfilled merge this is defensive (see #run): a removal or failure
    // recorded while GitHub was asked makes the guarded merge reject, and nothing can end the attempt after its save
    // before the job reads it.
    if (attempt.state === 'failed' || attempt.state === 'removed') {
      // A refusal because the head changed needs a fresh review, not a retry: the task is not "approved" any more.
      if (attempt.requiresFreshReview)
        return this.#finish(job.id, 'failed', `GitHub refused the merge: ${attempt.reason ?? reason} Review the new head first.`);
      return this.#block(job, `GitHub refused the merge: ${attempt.reason ?? reason}`, FIX_THEN_RETRY);
    }
    this.#finish(job.id, 'submitted', reason);
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

  /**
   * Approved, merge blocked: the task's next merge prepares again from the start. One Store transaction. `next` is the
   * person's next step, saved after the reason only when the job ends blocked.
   */
  #block(job: MergeJob, reason: string, next: string, whileReady = false): void {
    const readyFor = whileReady ? { commandPolicyDigest: this.service.commandPolicyDigest() } : undefined;
    try { this.settle(() => this.service.store.blockMergeJob(this.service.config.identity, job.id, reason, readyFor, next)); }
    catch (error) { this.#unended(job.id, error); }
  }

  async #awaitChecks(job: MergeJob, signal: AbortSignal): Promise<CheckVerdict> {
    const { store, config } = this.service, identity = config.identity;
    const until = performance.now() + this.checkWaitMs;
    let delay = this.firstDelayMs, waiting: { context: string; state: string }[] = [], waited = false;
    // Nothing failed: the person waits for the checks (or GitHub) rather than fixing anything. Before any inspection
    // finished within the limit, nothing was seen pending or computing.
    const timedOut = (): CheckVerdict => ({ kind: 'blocked', reason: `Required checks did not pass within ${Math.round(this.checkWaitMs / 60_000)} minutes: ${
      waiting.length ? waiting.map(check => `${check.context} is ${check.state}`).join(', ')
        : waited ? 'GitHub has not determined mergeability' : 'no inspection of them finished in time'}.`,
    next: waiting.length || !waited ? 'Wait for the checks to pass, then Retry merge.' : 'Wait for GitHub to determine mergeability, then Retry merge.' });
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
        // Only the limit's own abort is the wait's timeout: every layer below rejects with that reason, unchanged. A
        // failure that came first (a GitHub stage failing while its stopped peers settle past the limit) keeps its error.
        if (limit.aborted && error === limit.reason) return timedOut();
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      const verdict = classify(status);
      // Only checks seen passing within the limit count. Work at the end of an inspection can cross the limit before
      // its timer runs, so a ready answer is checked against the clock too; a failing check or other blocker stands.
      // The checks did pass, so the reason says so rather than naming the last wait, and the record drops its waiting list.
      if (verdict.kind === 'ready' && performance.now() >= until) {
        this.settle(() => store.updateMergeJob(identity, job.id, { checks: [] }));
        return { kind: 'blocked', reason: `Required checks passed only after the ${Math.round(this.checkWaitMs / 60_000)}-minute limit.`, next: 'Retry merge.' };
      }
      if (verdict.kind !== 'wait') return verdict;
      waiting = verdict.checks; waited = true;
      this.settle(() => store.updateMergeJob(identity, job.id, { checks: waiting }));
      const remaining = until - performance.now();
      if (remaining <= 0) return timedOut();
      await sleep(Math.min(delay, remaining), signal).catch(() => undefined);
      delay = Math.min(delay * 2, this.maxDelayMs);
    }
  }

}

/** Blockers the merge job resolves itself: it prepares (rebase, push, cmd: checks) and waits for required checks. */
export const JOB_RESOLVES: ReadonlySet<string> = new Set(['preparation', 'base', 'acceptance', 'check']);

/**
 * How a job-resolved blocker reads when merging runs as a job. The guarded merge's own wording asks the person to rebase
 * or prepare, but the job's screen offers neither: merging does both (docs/implementation/merge-handoff.md). Used for
 * the merge status the browser sees and for the reason a job ends `failed` with, so both say the same.
 */
const JOB_WORDING: Readonly<Record<string, string>> = Object.freeze({
  base: 'The base branch moved; merging rebases onto it and prepares again, so the result may need review.',
  preparation: 'The merge has not been prepared for the current review; merging prepares it.',
});
/** An unsettled push is a preparation blocker too, but its own: merging reads the push's outcome before it prepares. */
const PUSH_UNSETTLED_JOB = 'A push of the rewritten head has not settled; merging reads its outcome and prepares again.';
export function inJobTerms<T extends { code: string; message: string }>(blocker: T): T {
  const message = blocker.code === 'preparation' && blocker.message === PUSH_UNSETTLED ? PUSH_UNSETTLED_JOB : JOB_WORDING[blocker.code];
  return message === undefined ? blocker : { ...blocker, message };
}

/**
 * Blockers settled by the time a job asks GitHub to merge: the job's resolved blockers, and mergeability, since the
 * guarded merge starts only after `classify` found no blocker at all. A job that ended `merged`, `queued` or `submitted`
 * got that far; the browser drops these from the review it read before or during that job. Any other outcome settled
 * none of them for certain.
 */
export const SETTLED_BEFORE_JOB_MERGE: readonly string[] = Object.freeze([...JOB_RESOLVES, 'mergeable']);

/**
 * The merge status the browser sees when merging runs as a job: ready when only blockers the job resolves remain (or
 * GitHub is still computing mergeability), and never while a job or merge attempt is in flight. After a blocked job the
 * action is a retry. The latest job rides along, with the blockers a job that reached the merge has settled.
 */
export function withMergeJob<T extends { ready: boolean; action: 'merge' | 'retry' | null; blockers: { code: string; message: string }[];
  remote: { mergeable: string } | null; queue: { state: string } | null }>(status: T, job: MergeJobView | null, taskStatus: string): T & { job: MergeJobView | null; settledBeforeJobMerge: readonly string[] } {
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
  return { ...status, blockers: status.blockers.map(inJobTerms), ready,
    action: ready ? (taskStatus === 'approved but merge blocked' || status.action === 'retry' ? 'retry' : 'merge') : null, job,
    settledBeforeJobMerge: SETTLED_BEFORE_JOB_MERGE };
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
  if (other.length) return { kind: 'failed', reason: inJobTerms(other[0]!).message };
  const failing = status.remote.requiredChecks.filter(check => check.state === 'failure');
  if (failing.length) return { kind: 'blocked', reason: `Required check${failing.length === 1 ? '' : 's'} failed: ${failing.map(check => check.context).join(', ')}.`,
    next: failing.length === 1 ? FIX_THEN_RETRY : 'Fix them, then Retry merge.' };
  const waiting = status.remote.requiredChecks.filter(check => check.state !== 'success')
    .map(check => ({ context: check.context, state: check.state }));
  if (waiting.length || computing) return { kind: 'wait', checks: waiting };
  return status.ready ? { kind: 'ready' } : { kind: 'failed', reason: status.blockers[0] ? inJobTerms(status.blockers[0]).message : 'Merge is blocked.' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

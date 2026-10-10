import { readHistory } from '../git/history.ts';
import { DEFAULT_PROCESS_SETTLEMENT_MS } from '../agents/process-group.ts';
import type { PlanIdentity } from '../core/identity.ts';
import type { RunnerCoordinator } from './coordinator.ts';
import { GuardRefusal, MERGEABLE_STATUSES, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { MAX_REBASE_TIMEOUT_MS, MIN_REBASE_CLEANUP_TIMEOUT_MS, MIN_REBASE_TIMEOUT_MS,
  RebaseResourcesUnsettled, type GitRebaser } from './rebase.ts';
import type { ReviewService } from './review.ts';
import { BranchPushRefused } from './branch-push.ts';
import type { PreMergeReadiness, PushMarker, PushOutcome, RebaseMarker } from './store.ts';

/** `branch` is the task PR's head branch, present when the runner published the PR. */
export interface RemotePair { base: string; head: string; branch?: string }
export interface PreMergeRemote {
  inspect(signal?: AbortSignal): Promise<RemotePair>;
  fetch(pair: RemotePair, signal?: AbortSignal): Promise<void>;
  /**
   * Make the task branch point at `to`, leased to exactly `from`. Throws `BranchPushRefused` when nothing was pushed
   * because the branch holds something else; any other failure leaves the outcome unknown.
   */
  push(input: { branch: string; from: string; to: string; beforePush: () => void }, signal?: AbortSignal): Promise<void>;
  /** The commit the task branch points at on GitHub, or null when it does not exist. */
  readBranch(branch: string, signal?: AbortSignal): Promise<string | null>;
}
/** One bounded read of the branch settles a push whose outcome is unknown. */
export const PUSH_SETTLEMENT_TIMEOUT_MS = 30_000;
/**
 * GitHub's pull-request API reports a pushed head asynchronously. After a push, no new inspection starts once this long
 * has passed; the last one may still take its own timeout to answer.
 */
export const PUSHED_HEAD_VISIBLE_TIMEOUT_MS = 30_000;
export interface PreMergeAuthorization {
  /** Complete the last external authorization read before a later external operation. */
  refresh(): Promise<void>;
  /** Recheck only local trust state after that operation, without opening another external race. */
  validate(): void;
}
export interface PreMergeResult {
  state: 'ready' | 'review-required' | 'failed';
  base: string; head: string; checked: readonly string[]; reason: string | null;
}
type PreparedResult = PreMergeResult & { readiness?: PreMergeReadiness };

// D may spend 30 s on its first cleanup and 60 s retrying it; F may then spend 30 s releasing task storage. Keep all
// of that ownership settlement inside the preparation's one overall deadline.
export const COMMAND_CHECK_SETTLEMENT_RESERVE_MS = 120_000;
/** Git and GitHub subprocesses abort before the advertised operation deadline, leaving their bounded stop/drain time. */
export const PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS = DEFAULT_PROCESS_SETTLEMENT_MS;
/** Keep a full process-settlement window between live rebase expiry and its separately budgeted durable cleanup. */
const REBASE_CLEANUP_HANDOFF_RESERVE_MS = PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS;

/** Production preparation: refresh, rebase, re-review, push the rewritten head, then exact-head command checks. */
export class PreMergeCoordinator {
  readonly service: ReviewService;
  readonly runner: RunnerCoordinator;
  readonly rebaser: GitRebaser;
  readonly remote: PreMergeRemote;
  readonly operationTimeoutMs: number;
  readonly processSettlementReserveMs: number;
  readonly commandSettlementReserveMs: number;
  readonly pushVisibleTimeoutMs: number;
  readonly authorize?: (signal: AbortSignal) => Promise<PreMergeAuthorization>;
  readonly settle: <T>(fn: () => T) => T;
  #active: Promise<unknown> | null = null;
  #abort: AbortController | null = null;
  /** Aborted only by shutdown: a cancel must not stop the branch read that settles a push and closes the task. */
  readonly #shutdown = new AbortController();
  #closing = false;
  #last: PreMergeResult | null = null;
  #lastBinding: { stateVersion: number; reviewVersion: number; snapshotId: string } | null = null;

  constructor(service: ReviewService, runner: RunnerCoordinator, rebaser: GitRebaser, remote: PreMergeRemote,
    operationTimeoutMs = 10 * 60_000, capability?: ShutdownCapability,
    authorize?: (signal: AbortSignal) => Promise<PreMergeAuthorization>,
    reserves: { processMs?: number; commandMs?: number; pushVisibleMs?: number } = {}) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 60 * 60_000)
      throw new Error('Invalid pre-merge operation deadline.');
    this.service = service; this.runner = runner; this.rebaser = rebaser; this.remote = remote;
    this.operationTimeoutMs = operationTimeoutMs; this.authorize = authorize;
    this.processSettlementReserveMs = reserves.processMs ?? PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS;
    this.commandSettlementReserveMs = reserves.commandMs ?? COMMAND_CHECK_SETTLEMENT_RESERVE_MS;
    this.pushVisibleTimeoutMs = reserves.pushVisibleMs ?? PUSHED_HEAD_VISIBLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.processSettlementReserveMs) || this.processSettlementReserveMs < 0
      || !Number.isSafeInteger(this.commandSettlementReserveMs) || this.commandSettlementReserveMs < 0
      || !Number.isSafeInteger(this.pushVisibleTimeoutMs) || this.pushVisibleTimeoutMs < 0)
      throw new Error('Invalid pre-merge settlement reserve.');
    this.settle = settleWith(capability);
  }

  get active(): boolean { return this.#active !== null; }
  get last(): (PreMergeResult & { stale: boolean }) | null {
    if (!this.#last) return null;
    let stale = this.#lastBinding === null;
    if (this.#lastBinding) try {
      const task = this.service.store.getTask(this.service.config.identity);
      stale = task.stateVersion !== this.#lastBinding.stateVersion
        || this.service.store.reviewVersion(this.service.config.identity) !== this.#lastBinding.reviewVersion
        || this.service.store.getSnapshot(this.service.config.identity).id !== this.#lastBinding.snapshotId;
    } catch { stale = true; }
    return { ...this.#last, stale };
  }
  assertStartable(): void {
    if (this.#closing) throw new GuardRefusal('The server is shutting down.');
    if (this.#active) throw new GuardRefusal('Pre-merge preparation is already running.');
  }
  start(expected: { stateVersion: number; reviewVersion: number; snapshotId: string; base: string; head: string; actionId?: string }): Promise<PreMergeResult> {
    this.assertStartable();
    const controller = new AbortController(); this.#abort = controller;
    const deadline = performance.now() + this.operationTimeoutMs;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Pre-merge preparation deadline exceeded.'),
      { code: 'ETIMEDOUT' })), Math.max(0, this.operationTimeoutMs - this.processSettlementReserveMs));
    // Admission reserves the coordinator synchronously, but expensive Git/GitHub work begins after the user-action
    // transaction and HTTP handler can finish.
    let readiness: PreMergeReadiness | null = null;
    let failureChecked: readonly string[] = [];
    let failurePair = { base: expected.base, head: expected.head };
    let failureBinding = { stateVersion: expected.stateVersion, reviewVersion: expected.reviewVersion,
      snapshotId: expected.snapshotId };
    const remember = (input: PreparedResult) => {
      const { readiness: readyBinding, ...plain } = input;
      readiness = readyBinding ?? null;
      let result: PreMergeResult = plain;
      this.#lastBinding = null;
      if (result.state === 'ready' && readiness) this.#lastBinding = readiness;
      else if (result.state === 'ready') result = { ...result, state: 'failed',
        reason: 'Could not bind preparation readiness: preparation readiness was not bound to the final review.' };
      else this.#lastBinding = failureBinding;
      this.#last = result;
      return result;
    };
    const active = Promise.resolve().then(() => this.#run(expected, controller.signal, deadline,
      observation => { failurePair = observation.pair; failureBinding = observation.binding; },
      checked => { failureChecked = Object.freeze([...checked]); })).then(remember, error => {
      // Failure settlement must not rebuild Git history: the original failure may itself be a repository-read error.
      const result: PreMergeResult = { state: 'failed', ...failurePair,
        checked: failureChecked, reason: error instanceof Error ? error.message : String(error) };
      return remember(result);
    }).then(result => {
      if (!expected.actionId) return result;
      try {
        const effective = this.settle(() => this.service.store.settlePreMergeAction(
          this.service.config.identity, expected.actionId!, result, readiness));
        if (effective !== result) result = remember(effective);
      }
      catch (error) {
        // No terminal response or readiness was committed. Remove only this action's pending placeholder, so the same
        // key can start the preparation again instead of replaying work that no longer exists.
        try { this.settle(() => this.service.store.makePreMergeActionResendable(this.service.config.identity, expected.actionId!)); }
        catch { /* The original storage failure remains the result; startup recovery handles a placeholder we could not remove. */ }
        const failed: PreMergeResult = { ...result, state: 'failed',
          reason: error instanceof Error ? error.message : String(error) };
        return remember(failed);
      }
      return result;
    }).finally(() => { clearTimeout(timer); if (this.#active === active) { this.#active = null; this.#abort = null; } });
    this.#active = active;
    return active;
  }
  async close(): Promise<void> {
    this.#closing = true; this.#shutdown.abort(new Error('Server shutdown.')); this.#abort?.abort(new Error('Server shutdown.'));
    await this.#active;
  }
  /** Cancel the task and promptly stop whichever rebase, remote read or command check this preparation owns. */
  cancelTask(expectedStateVersion: number, actionId: string): 'closed' | 'stopping' {
    const identity = this.service.config.identity;
    const outcome = this.runner.isActive(identity)
      ? this.runner.cancelTask(identity, expectedStateVersion, actionId)
      : this.service.store.cancelTask(identity, expectedStateVersion, actionId);
    this.service.store.afterCommit(() => this.#abort?.abort(new Error('Task cancelled.')));
    return outcome;
  }

  /**
   * Settle a push whose outcome is unknown (a crash, shutdown or failure during the push) by reading the branch, then
   * clear its marker. Returns null when no push is pending; throws when the branch could not be read.
   */
  async settleInterruptedPush(): Promise<PushOutcome | null> {
    const marker = this.service.store.getTask(this.service.config.identity).pushInProgress;
    return marker ? (await this.#settlePush(marker)).outcome : null;
  }
  /**
   * Settle a push left by a crash, shutdown or unreadable branch, as one tracked job that shutdown aborts and awaits:
   * after startup recovery, and when a task is cancelled with no preparation running. While it runs, a preparation is
   * refused as already running. Never throws: a failed read leaves the marker for the next preparation, and a server
   * already closing or busy skips it.
   */
  settlePendingPush(): Promise<PushOutcome | null> {
    if (this.#closing || this.#active) return Promise.resolve(null);
    const active = this.settleInterruptedPush().catch(() => null)
      .finally(() => { if (this.#active === active) this.#active = null; });
    this.#active = active;
    return active;
  }
  /** Clear the marker; returns the task state version just before and just after, read in the same turn. */
  #finishPush(marker: PushMarker): { before: number; after: number } {
    const identity = this.service.config.identity, before = this.service.store.getTask(identity).stateVersion;
    this.settle(() => this.service.store.finishPrePush(this.service.store.getTask(identity).planKey, marker.attemptId));
    return { before, after: this.service.store.getTask(identity).stateVersion };
  }
  /**
   * One branch read, all of it, Git's settlement after an abort included, within `limitMs` (at most
   * PUSH_SETTLEMENT_TIMEOUT_MS): the read is aborted the process-settlement reserve before that, and does not start
   * when less than the reserve is left.
   */
  async #settlePush(marker: PushMarker, limitMs = PUSH_SETTLEMENT_TIMEOUT_MS): Promise<{ outcome: PushOutcome; before: number; after: number }> {
    const readMs = Math.min(PUSH_SETTLEMENT_TIMEOUT_MS, limitMs) - this.processSettlementReserveMs;
    if (readMs < 1) throw Object.assign(new Error('Too little time is left to read the branch and settle Git.'), { code: 'ETIMEDOUT' });
    const read = await this.remote.readBranch(marker.branch, AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(readMs)]));
    const outcome: PushOutcome = read === marker.to ? 'pushed' : read === marker.from ? 'not-pushed' : 'moved';
    return { outcome, ...this.#finishPush(marker) };
  }

  #refresh(pair: RemotePair, remaining: () => number, priorHead?: string) {
    const historyOptions = () => ({ maxDurationMs: Math.min(30_000, remaining()) });
    const view = this.service.load(historyOptions());
    const repository = this.service.reviewRepository().path;
    let history: ReturnType<typeof readHistory>;
    try { history = readHistory(repository, pair.base, pair.head, historyOptions()); }
    catch (error) {
      // A collaborator may push on the old remote head while the base moves (or while F5 retains an unpushed local
      // rebase). Review that head against the latest stored base it actually descended from; the next preparation can
      // then rebase the newly attributed head. Only ancestry mismatch permits this fallback: every other read failure
      // remains fail-closed.
      if (!priorHead || !(error instanceof Error)
        || !/linear history descended from the base|base must be an ancestor of the head/i.test(error.message)) throw error;
      let recovered: ReturnType<typeof readHistory> | null = null;
      for (const candidate of [priorHead, ...this.service.store.rewrittenAncestors(this.service.config.identity, priorHead)]) {
        const priorId = this.service.store.snapshotWithHead(this.service.config.identity, candidate);
        if (!priorId) continue;
        try { recovered = readHistory(repository, this.service.store.getSnapshot(this.service.config.identity, priorId).base,
          pair.head, historyOptions()); break; }
        catch (fallback) {
          if (!(fallback instanceof Error)
            || !/linear history descended from the base|base must be an ancestor of the head/i.test(fallback.message)) throw fallback;
        }
      }
      if (!recovered) throw error;
      history = recovered;
    }
    this.service.store.recordHistory(this.service.config.identity, view.expected, history.base, history.head, []);
    return this.service.load(historyOptions());
  }
  #reviewBlocker(view: ReturnType<ReviewService['load']>, requireChecks = false): string | null {
    const invalidCommand = view.items.find(item => item.checks.tests === '✕ Invalid command');
    if (invalidCommand) return `${invalidCommand.id} has an invalid command check; amend the plan before preparing the merge.`;
    const item = view.items.find(value => value.state !== 'approved' || value.outside.length);
    if (item) return `${item.id} requires refreshed attribution or approval.`;
    if (view.segments.some(segment => segment.row === 'Ambiguous')) return 'Ambiguous changes require attribution.';
    if (view.segments.some(segment => segment.row === 'Unplanned')) return 'Unplanned changes require a plan amendment.';
    const changes = view.notes.filter(note => note.kind === 'change' && note.revision === view.plan.revision
      && note.snapshotId === view.snapshot.id).length;
    if (changes) return `${changes} change request${changes === 1 ? ' remains' : 's remain'} open.`;
    if (requireChecks) {
      const unchecked = view.items.find(item => item.acceptance.some(check => check.type === 'cmd') && item.checks.tests !== '✓ Passed');
      if (unchecked) return `${unchecked.id} command checks have not passed on this head.`;
    }
    return null;
  }
  async #cleanupRebase(identity: PlanIdentity, marker: RebaseMarker, timeoutMs: number): Promise<void> {
    const current = this.service.store.getTask(identity).rebaseInProgress as RebaseMarker | null;
    if (current?.attemptId !== marker.attemptId) throw new GuardRefusal('This rebase attempt no longer owns cleanup.');
    await this.rebaser.abort(marker.attemptId, current.resultHead ?? undefined, current.resultState, timeoutMs);
    if (!this.settle(() => this.service.store.abortRebase(this.service.store.getTask(identity).planKey, marker.attemptId)))
      throw new GuardRefusal('This rebase attempt no longer owns its durable marker.');
  }
  /**
   * Inspect the PR until GitHub reports a head other than the pre-push head, with backoff. No inspection starts after
   * `pushVisibleTimeoutMs`, so the wait lasts at most that plus one inspection, within the preparation deadline. A PR
   * still at the pre-push head after that fails the preparation without refreshing the review: the branch itself
   * already holds another head.
   */
  async #awaitHeadChange(before: RemotePair, signal: AbortSignal, remaining: () => number): Promise<RemotePair> {
    const until = performance.now() + this.pushVisibleTimeoutMs;
    for (let delay = 250; ; delay = Math.min(delay * 2, 4_000)) {
      const seen = await this.remote.inspect(signal); signal.throwIfAborted();
      // Only the head shows whether GitHub caught up: a base that moved meanwhile says nothing about the pushed head.
      if (seen.head !== before.head) return seen;
      const wait = Math.min(delay, until - performance.now(), remaining() - this.processSettlementReserveMs);
      if (wait < 1) throw new GuardRefusal(`GitHub has not reported the pull request's new head yet; it still shows ${before.head}. Prepare the merge again shortly.`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, wait);
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', stop, { once: true });
      });
    }
  }
  /**
   * Push the reviewed, rewritten head over exactly the remote head it rewrote. The durable marker is written before the
   * first external write and cleared only after a read of the branch settles the outcome; when that read is impossible
   * (shutdown, or GitHub unreachable) the marker stays for the next preparation or startup.
   */
  async #pushRewrite(remote: RemotePair, view: ReturnType<ReviewService['load']>, signal: AbortSignal, deadline: number,
    authorize: () => Promise<PreMergeAuthorization | undefined>,
    bind: (reviewed: { reviewVersion: number; snapshotId: string }, pair: RemotePair, stateVersion?: number) => void):
    Promise<{ result: 'pushed' | 'refused'; stateVersion: number }> {
    const identity = this.service.config.identity;
    if (!remote.branch) throw new GuardRefusal('The pull request was not published by the runner, so its rewritten head cannot be pushed.');
    const reviewed = { revision: view.expected.revision, snapshotId: view.expected.snapshotId,
      reviewVersion: view.expected.reviewVersion! };
    // Captured before the asynchronous authorization read: any task write that lands during it (a reassignment, a
    // referenced-code change) must refuse the claim, not be adopted by it.
    const admitted = this.service.store.getTask(identity).stateVersion;
    const authorization = await authorize();
    signal.throwIfAborted();
    const marker = this.service.store.beginPrePush(identity, reviewed, admitted,
      { branch: remote.branch, from: remote.head, to: view.snapshot.head });
    const binding = this.service.store.getTask(identity).stateVersion;
    // The task state this push left, for binding a later failure: the version clearing the marker produced when nothing
    // else wrote since the claim, else the claim's own. A write while the push or its read was in flight, such as a plan
    // revision, must leave a later failure stale.
    const owned = (cleared: { before: number; after: number }) => cleared.before === binding ? cleared.after : binding;
    try {
      await this.remote.push({ branch: marker.branch, from: marker.from, to: marker.to, beforePush: () => {
        // The last local checks before the external write: trust, and no task or review change since the claim.
        authorization?.validate();
        const task = this.service.store.getTask(identity);
        if (task.stateVersion !== binding || task.cancelRequested !== null
          || this.service.store.reviewVersion(identity) !== reviewed.reviewVersion
          || this.service.store.getSnapshot(identity).id !== reviewed.snapshotId)
          throw new GuardRefusal('The task or review changed before the rewritten head was pushed. Reload first.');
        signal.throwIfAborted();
      } }, signal);
    } catch (error) {
      if (error instanceof BranchPushRefused) return { result: 'refused', stateVersion: owned(this.#finishPush(marker)) };
      // Shutdown: no new GitHub read may start; startup settles the marker. Otherwise one read, within what is left of
      // the preparation's deadline (its settlement reserve included), settles it. A cancel does not stop that read.
      let settled = binding;
      const left = Math.floor(deadline - performance.now());
      if (!this.#closing && left >= 1) {
        try { settled = owned(await this.#settlePush(marker, left)); }
        catch { /* The marker stays; the next preparation or startup reads the branch again. */ }
      }
      bind(reviewed, { base: view.snapshot.base, head: view.snapshot.head }, settled);
      throw error;
    }
    return { result: 'pushed', stateVersion: owned(this.#finishPush(marker)) };
  }
  async #run(expected: { stateVersion: number; reviewVersion: number; snapshotId: string; actionId?: string }, signal: AbortSignal,
    deadline: number, onObserved: (value: { pair: RemotePair; binding: { stateVersion: number; reviewVersion: number;
      snapshotId: string } }) => void, onChecked: (checked: readonly string[]) => void): Promise<PreparedResult> {
    const identity = this.service.config.identity;
    const remaining = () => {
      const value = Math.ceil(deadline - performance.now());
      if (value < 1) throw Object.assign(new Error('Pre-merge preparation deadline exceeded.'), { code: 'ETIMEDOUT' });
      return value;
    };
    const reviewBudget = () => {
      const value = Math.ceil(deadline - performance.now() - this.processSettlementReserveMs);
      if (value < 1) throw Object.assign(new Error('Pre-merge preparation deadline exceeded before process settlement could be reserved.'),
        { code: 'ETIMEDOUT' });
      return value;
    };
    const commandBudget = () => {
      const value = Math.ceil(deadline - performance.now() - this.commandSettlementReserveMs);
      if (value < 1) throw Object.assign(new Error('Pre-merge preparation deadline exceeded before command-check settlement could be reserved.'),
        { code: 'ETIMEDOUT' });
      return value;
    };
    const rebaseBudget = (cleanupOnly = false) => {
      // A failed live run still needs a separate abort that clears its durable marker. Keep that minimum outside the
      // run's scope instead of letting the run consume the whole operation budget.
      const available = remaining() - (cleanupOnly ? 0
        : MIN_REBASE_CLEANUP_TIMEOUT_MS + REBASE_CLEANUP_HANDOFF_RESERVE_MS);
      const value = Math.min(MAX_REBASE_TIMEOUT_MS, available);
      if (value < (cleanupOnly ? MIN_REBASE_CLEANUP_TIMEOUT_MS : MIN_REBASE_TIMEOUT_MS))
        throw Object.assign(new Error(`Pre-merge preparation deadline exceeded before rebase ${cleanupOnly ? 'cleanup' : 'work and cleanup'} could be reserved.`),
          { code: 'ETIMEDOUT' });
      return value;
    };
    const authorize = async () => {
      if (!this.authorize) return;
      const authorization = await this.authorize(signal);
      await authorization.refresh(); authorization.validate(); signal.throwIfAborted(); remaining();
      return authorization;
    };
    const track = <T extends ReturnType<ReviewService['load']>>(current: T): T => {
      onObserved({ pair: { base: current.snapshot.base, head: current.snapshot.head }, binding: {
        stateVersion: this.service.store.getTask(identity).stateVersion,
        reviewVersion: this.service.store.reviewVersion(identity), snapshotId: current.snapshot.id,
      } });
      return current;
    };
    // Rebase lifecycle writes advance task state without changing the review that admitted them. Bind a resulting
    // failure to that original review/snapshot while adopting only the task-state transition owned by the rebase. If a
    // read fails, the older binding remains safely stale.
    const bindRebaseFailure = (reviewed: { reviewVersion: number; snapshotId: string }, pair: RemotePair, stateVersion?: number) => {
      try {
        onObserved({ pair, binding: {
          stateVersion: stateVersion ?? this.service.store.getTask(identity).stateVersion,
          reviewVersion: reviewed.reviewVersion, snapshotId: reviewed.snapshotId,
        } });
      } catch { /* An unbound failure is conservatively historical. */ }
    };
    const load = () => track(this.service.load({ maxDurationMs: Math.min(30_000, reviewBudget()) }));
    signal.throwIfAborted();
    if (this.runner.isActive(identity)) throw new GuardRefusal('An attempt is already active for this task.');
    const runnerStatus = this.runner.status(identity);
    if (runnerStatus.unresolved || this.runner.unreleased)
      throw new GuardRefusal('Runner cleanup is unresolved; restart and recover owned resources before preparing a merge.');
    if (this.service.store.getTask(identity).rebaseInProgress !== null)
      throw new GuardRefusal('Rebase cleanup is unresolved; restart and recover the owned rebase before preparing a merge.');
    const pending = this.service.store.getTask(identity).pushInProgress;
    if (pending) {
      // Not this preparation's signal: a cancel must let the read finish, so the cleared marker can close the task.
      try { await this.#settlePush(pending, remaining()); }
      catch (error) {
        signal.throwIfAborted();
        throw new GuardRefusal(`The outcome of an earlier push of the rewritten head is unknown, and the branch could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      signal.throwIfAborted();
      // Settling advanced task state. The caller's binding is stale now; it reloads and starts again.
      throw new GuardRefusal('An earlier push of the rewritten head was settled. Reload, then prepare the merge again.');
    }
    let view = load(), task = this.service.store.getTask(identity);
    if (task.stateVersion !== expected.stateVersion || view.expected.reviewVersion !== expected.reviewVersion
      || view.snapshot.id !== expected.snapshotId) throw new GuardRefusal('The review changed before preparation started. Reload first.');
    if (!MERGEABLE_STATUSES.includes(task.status)) throw new GuardRefusal(`The task is ${task.status}; prepare it from review.`);
    if (task.cancelRequested !== null) throw new GuardRefusal('The task is being cancelled.');
    if (!this.service.reviewRepository().runnerOwned)
      throw new GuardRefusal('Pre-merge preparation requires a runner-owned head.');
    const merge = this.service.store.getMergeAttempt(identity);
    if (merge && (merge.state === 'submitting' || merge.state === 'queued'))
      throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    const assertCurrent = (guard: { stateVersion: number; reviewVersion: number; snapshotId: string }) => {
      const currentTask = this.service.store.getTask(identity);
      if (currentTask.stateVersion !== guard.stateVersion || !MERGEABLE_STATUSES.includes(currentTask.status)
        || currentTask.cancelRequested !== null || this.service.store.reviewVersion(identity) !== guard.reviewVersion
        || this.service.store.getSnapshot(identity).id !== guard.snapshotId)
        throw new GuardRefusal('The task or review changed during preparation. Reload first.');
    };
    let initial = await this.remote.inspect(signal); await this.remote.fetch(initial, signal); signal.throwIfAborted();
    assertCurrent(expected);
    // A rewrite is pushed only once its review is clear. Until then (a review stop, or a failed or refused push), a retry
    // must recognize the durable rewrite lineage instead of mistaking codeboost's still-remote predecessor for a
    // collaborator push.
    const retainedRemoteHead = initial.head !== view.snapshot.head
      && this.service.store.isRewrittenHead(identity, initial.head, view.snapshot.head);
    if (initial.head !== view.snapshot.head && !retainedRemoteHead) {
      view = track(this.#refresh(initial, reviewBudget, view.snapshot.head));
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked: [],
        reason: 'The pull request head moved; attribution and approvals were refreshed.' };
    }
    if (initial.base !== view.snapshot.base) {
      const repository = this.service.reviewRepository().path;
      const old = readHistory(repository, view.snapshot.base, view.snapshot.head,
        { maxDurationMs: Math.min(30_000, reviewBudget()) }).commits.map(commit => commit.sha);
      task = this.service.store.getTask(identity);
      const reviewed = { revision: view.expected.revision, snapshotId: view.expected.snapshotId,
        reviewVersion: view.expected.reviewVersion! };
      const oldBase = view.snapshot.base, oldHead = view.snapshot.head;
      await authorize();
      signal.throwIfAborted();
      const rebaseTimeoutMs = rebaseBudget();
      const marker = this.service.store.beginRebase(identity, reviewed, task.stateVersion,
        { oldBase: view.snapshot.base, oldHead: view.snapshot.head, oldHistory: old, onto: initial.base });
      try {
        const result = await this.rebaser.run({ attemptId: marker.attemptId, oldBase,
          oldHead, oldHistory: old, onto: initial.base,
          ledger: this.service.store.getLedger(identity), signal, timeoutMs: rebaseTimeoutMs });
        signal.throwIfAborted();
        this.service.store.finishRebase(identity, reviewed, task.stateVersion, marker.attemptId,
          result.base, result.head, result.mappings);
      } catch (error) {
        if (error instanceof RebaseResourcesUnsettled) {
          bindRebaseFailure(reviewed, { base: oldBase, head: oldHead });
          throw error;
        }
        try { await this.#cleanupRebase(identity, marker, rebaseBudget(true)); }
        catch (cleanup) {
          bindRebaseFailure(reviewed, { base: oldBase, head: oldHead });
          throw new AggregateError([error, cleanup], error instanceof Error ? error.message : 'Rebase failed.', { cause: error });
        }
        bindRebaseFailure(reviewed, { base: oldBase, head: oldHead });
        throw error;
      }
      view = load();
    }
    const blocker = this.#reviewBlocker(view);
    if (blocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head,
      checked: [], reason: blocker };
    if (initial.head !== view.snapshot.head) {
      const { result: pushed, stateVersion: pushState } = await this.#pushRewrite(initial, view, signal, deadline, authorize,
        bindRebaseFailure);
      // Bind any later failure to the state the push (or refusal) left, so it is reported as current, not stale.
      bindRebaseFailure({ reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id },
        { base: view.snapshot.base, head: view.snapshot.head }, pushState);
      // Either way the branch no longer holds the pre-push head: ours after a push, someone else's after a refusal.
      // GitHub's PR API reports that asynchronously, so wait for it; its lag must not read as the old head.
      const seen = await this.#awaitHeadChange(initial, signal, remaining);
      if (pushed !== 'pushed' || seen.head !== view.snapshot.head || seen.base !== initial.base) {
        const moved = seen; await this.remote.fetch(moved, signal); signal.throwIfAborted();
        // Traced from the reviewed head and its rewrite lineage, nearest first. That lineage holds the pushed head, every
        // earlier rewrite codeboost may already have pushed, and the original head a collaborator may have built on.
        view = track(this.#refresh(moved, reviewBudget, view.snapshot.head));
        return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked: [],
          reason: pushed === 'pushed'
            ? 'The pull request moved after the rewritten head was pushed; attribution and approvals were refreshed.'
            : 'The pull request branch moved before the rewritten head could be pushed; attribution and approvals were refreshed.' };
      }
      // Nothing but this push may have changed the task meanwhile: a plan revision or review edit applied while it was in
      // flight would otherwise be adopted by the reload below and run checks under approvals it made stale.
      assertCurrent({ stateVersion: pushState, reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id });
      initial = seen;
      view = load();
    }
    const checked: string[] = [];
    for (const item of view.items.filter(candidate => candidate.acceptance.some(check => check.type === 'cmd'))) {
      signal.throwIfAborted();
      task = this.service.store.getTask(identity);
      const attempt = this.runner.start(identity, { expectedStateVersion: task.stateVersion, kind: 'check', item: item.id,
        deadline: Date.now() + commandBudget(), expectedContext: this.service.store.currentContext(identity),
        ...(this.authorize ? { authorize: async (checkSignal: AbortSignal) => {
          const authorization = await this.authorize!(checkSignal);
          await authorization.refresh();
          return () => authorization.validate();
        } } : {}) });
      const stop = () => {
        // The invocation owns the same deadline and reports its own timeout. `time-limit` is reserved for the
        // code-writing task budget: recording it here would incorrectly move an in-review task to needs human.
        // The check's own deadline remains distinct from the code-writing budget, but an outer timeout still owns and
        // must stop this attempt. Settlement then consumes the reserve kept inside the operation-wide deadline.
        if (this.#closing) this.runner.stop(identity, attempt.id, 'shutdown');
        else if ((signal.reason as { code?: unknown } | undefined)?.code === 'ETIMEDOUT') this.runner.timeout(identity, attempt.id);
        else this.runner.stop(identity, attempt.id, 'cancelled');
      };
      signal.addEventListener('abort', stop, { once: true });
      // Adding a listener does not replay an abort that won the race after admission but before registration.
      if (signal.aborted) stop();
      try { await this.runner.settled(identity); } finally { signal.removeEventListener('abort', stop); }
      // The check attempt itself advances task state even when it fails. Bind that owned transition without adopting a
      // concurrent review edit; such an edit must leave the preparation historical and stale.
      if (this.service.store.reviewVersion(identity) === view.expected.reviewVersion) {
        const snapshot = this.service.store.getSnapshot(identity);
        onObserved({ pair: { base: snapshot.base, head: snapshot.head }, binding: {
          stateVersion: this.service.store.getTask(identity).stateVersion,
          reviewVersion: view.expected.reviewVersion!, snapshotId: snapshot.id,
        } });
      }
      signal.throwIfAborted();
      const settled = this.service.store.getAttempt(identity, attempt.id);
      const runnerStatus = this.runner.status(identity);
      if (runnerStatus.unresolved || this.runner.unreleased)
        throw new GuardRefusal('Command-check cleanup could not be confirmed; restart and recover owned resources before preparing a merge.');
      if (settled.state !== 'completed') throw new GuardRefusal(settled.exitCode === null && settled.diagnostic
        ? settled.diagnostic : `${item.id} command checks did not pass.`);
      checked.push(item.id); onChecked(checked); view = load();
      const changed = this.#reviewBlocker(view);
      if (changed) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked, reason: changed };
    }
    const prepared = { base: view.snapshot.base, head: view.snapshot.head };
    const guarded = { stateVersion: this.service.store.getTask(identity).stateVersion,
      // Rebase and command attempts advance task/snapshot state, but this preparation never owns a review edit.
      reviewVersion: expected.reviewVersion, snapshotId: view.snapshot.id };
    const final = await this.remote.inspect(signal); signal.throwIfAborted();
    assertCurrent(guarded);
    if (final.base !== initial.base || final.head !== initial.head) {
      await this.remote.fetch(final, signal); signal.throwIfAborted(); assertCurrent(guarded);
      view = track(this.#refresh(final, reviewBudget, initial.head));
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The pull request moved during preparation; attribution and approvals were refreshed.' };
    }
    view = load();
    if (view.snapshot.base !== prepared.base || view.snapshot.head !== prepared.head)
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The local review changed during preparation; reload it.' };
    const finalBlocker = this.#reviewBlocker(view, true);
    if (finalBlocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
      reason: finalBlocker };
    const authorization = await authorize();
    // Authorization is asynchronous. A review edit during that read invalidates its result just as one during the
    // final remote inspection does; nothing may persist readiness from the pre-authorization view.
    assertCurrent(guarded);
    view = load();
    if (view.snapshot.base !== prepared.base || view.snapshot.head !== prepared.head)
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The local review changed during final authorization; reload it.' };
    const authorizedBlocker = this.#reviewBlocker(view, true);
    if (authorizedBlocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
      reason: authorizedBlocker };
    // The authorization read above is asynchronous, so the PR may have moved after the earlier inspection. Reinspect
    // it, then immediately recheck every local generation before recording readiness.
    const authorizedRemote = await this.remote.inspect(signal); signal.throwIfAborted();
    assertCurrent(guarded);
    authorization?.validate();
    if (authorizedRemote.base !== initial.base || authorizedRemote.head !== initial.head) {
      await this.remote.fetch(authorizedRemote, signal); signal.throwIfAborted(); assertCurrent(guarded);
      view = track(this.#refresh(authorizedRemote, reviewBudget, initial.head));
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The pull request moved during final authorization; attribution and approvals were refreshed.' };
    }
    view = load();
    if (view.snapshot.base !== prepared.base || view.snapshot.head !== prepared.head)
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The local review changed after final authorization; reload it.' };
    const postAuthorizationBlocker = this.#reviewBlocker(view, true);
    if (postAuthorizationBlocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head,
      checked, reason: postAuthorizationBlocker };
    return { state: 'ready', base: view.snapshot.base, head: view.snapshot.head, checked, reason: null,
      readiness: { stateVersion: this.service.store.getTask(identity).stateVersion,
        reviewVersion: this.service.store.reviewVersion(identity), snapshotId: view.snapshot.id,
        base: view.snapshot.base, head: view.snapshot.head,
        commandPolicyDigest: this.service.commandPolicyDigest() } };
  }
}

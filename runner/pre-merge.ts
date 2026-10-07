import { readHistory } from '../git/history.ts';
import type { PlanIdentity } from '../core/identity.ts';
import type { RunnerCoordinator } from './coordinator.ts';
import { GuardRefusal, MERGEABLE_STATUSES, settleWith, type ShutdownCapability } from './lifecycle.ts';
import type { GitRebaser } from './rebase.ts';
import type { ReviewService } from './review.ts';
import type { RebaseMarker } from './store.ts';

export interface RemotePair { base: string; head: string }
export interface PreMergeRemote {
  inspect(signal?: AbortSignal): Promise<RemotePair>;
  fetch(pair: RemotePair, signal?: AbortSignal): Promise<void>;
}
export interface PreMergeResult {
  state: 'ready' | 'review-required' | 'failed';
  base: string; head: string; checked: readonly string[]; reason: string | null;
}

/** Production preparation before F6: refresh, rebase, re-review, then exact-head command checks. */
export class PreMergeCoordinator {
  readonly service: ReviewService;
  readonly runner: RunnerCoordinator;
  readonly rebaser: GitRebaser;
  readonly remote: PreMergeRemote;
  readonly checkTimeoutMs: number;
  readonly settle: <T>(fn: () => T) => T;
  #active: Promise<PreMergeResult> | null = null;
  #abort: AbortController | null = null;
  #closing = false;
  #last: PreMergeResult | null = null;

  constructor(service: ReviewService, runner: RunnerCoordinator, rebaser: GitRebaser, remote: PreMergeRemote,
    checkTimeoutMs = 10 * 60_000, capability?: ShutdownCapability) {
    if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1 || checkTimeoutMs > 60 * 60_000)
      throw new Error('Invalid command-check deadline.');
    this.service = service; this.runner = runner; this.rebaser = rebaser; this.remote = remote;
    this.checkTimeoutMs = checkTimeoutMs;
    this.settle = settleWith(capability);
  }

  get active(): boolean { return this.#active !== null; }
  get last(): PreMergeResult | null { return this.#last; }
  assertStartable(): void {
    if (this.#closing) throw new GuardRefusal('The server is shutting down.');
    if (this.#active) throw new GuardRefusal('Pre-merge preparation is already running.');
  }
  start(expected: { stateVersion: number; reviewVersion: number; snapshotId: string; actionId?: string }): Promise<PreMergeResult> {
    this.assertStartable();
    const controller = new AbortController(); this.#abort = controller;
    // Admission reserves the coordinator synchronously, but expensive Git/GitHub work begins after the user-action
    // transaction and HTTP handler can finish.
    const active = Promise.resolve().then(() => this.#run(expected, controller.signal)).then(result => (this.#last = result), error => {
      // Failure settlement must not rebuild Git history: the original failure may itself be a repository-read error.
      const snapshot = this.service.store.getSnapshot(this.service.config.identity);
      const result: PreMergeResult = { state: 'failed', base: snapshot.base, head: snapshot.head,
        checked: [], reason: error instanceof Error ? error.message : String(error) };
      this.#last = result; return result;
    }).then(result => {
      if (!expected.actionId) return result;
      try { this.settle(() => this.service.store.settlePreMergeAction(this.service.config.identity, expected.actionId!, result)); }
      catch (error) {
        const failed: PreMergeResult = { ...result, state: 'failed',
          reason: error instanceof Error ? error.message : String(error) };
        this.#last = failed;
        return failed;
      }
      return result;
    }).finally(() => { if (this.#active === active) { this.#active = null; this.#abort = null; } });
    this.#active = active;
    return active;
  }
  async close(): Promise<void> {
    this.#closing = true; this.#abort?.abort(new Error('Server shutdown.')); await this.#active;
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

  #refresh(pair: RemotePair) {
    const view = this.service.load();
    const history = readHistory(this.service.reviewRepository().path, pair.base, pair.head);
    this.service.store.recordHistory(this.service.config.identity, view.expected, history.base, history.head, []);
    return this.service.load();
  }
  #reviewBlocker(view: ReturnType<ReviewService['load']>, requireChecks = false): string | null {
    const item = view.items.find(value => value.state !== 'approved' || value.outside.length);
    if (item) return `${item.id} requires refreshed attribution or approval.`;
    if (view.segments.some(segment => segment.row === 'Ambiguous')) return 'Ambiguous changes require attribution.';
    if (view.segments.some(segment => segment.row === 'Unplanned')) return 'Unplanned changes require a plan amendment.';
    if (requireChecks) {
      const unchecked = view.items.find(item => item.acceptance.some(check => check.type === 'cmd') && item.checks.tests !== '✓ Passed');
      if (unchecked) return `${unchecked.id} command checks have not passed on this head.`;
    }
    return null;
  }
  async #cleanupRebase(identity: PlanIdentity, marker: RebaseMarker): Promise<void> {
    const current = this.service.store.getTask(identity).rebaseInProgress as RebaseMarker | null;
    if (current?.attemptId !== marker.attemptId) throw new GuardRefusal('This rebase attempt no longer owns cleanup.');
    await this.rebaser.abort(marker.attemptId, current.resultHead ?? undefined, current.resultState);
    if (!this.settle(() => this.service.store.abortRebase(this.service.store.getTask(identity).planKey, marker.attemptId)))
      throw new GuardRefusal('This rebase attempt no longer owns its durable marker.');
  }
  async #run(expected: { stateVersion: number; reviewVersion: number; snapshotId: string; actionId?: string }, signal: AbortSignal): Promise<PreMergeResult> {
    const identity = this.service.config.identity;
    let view = this.service.load(), task = this.service.store.getTask(identity);
    if (task.stateVersion !== expected.stateVersion || view.expected.reviewVersion !== expected.reviewVersion
      || view.snapshot.id !== expected.snapshotId) throw new GuardRefusal('The review changed before preparation started. Reload first.');
    if (!MERGEABLE_STATUSES.includes(task.status)) throw new GuardRefusal(`The task is ${task.status}; prepare it from review.`);
    if (task.cancelRequested !== null) throw new GuardRefusal('The task is being cancelled.');
    if (!this.service.reviewRepository().runnerOwned)
      throw new GuardRefusal('Pre-merge preparation requires a runner-owned head.');
    if (this.runner.isActive(identity)) throw new GuardRefusal('An attempt is already active for this task.');
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
    const initial = await this.remote.inspect(signal); await this.remote.fetch(initial, signal); signal.throwIfAborted();
    assertCurrent(expected);
    // F6 will push the rewritten head. Until then, a retry must recognize the durable rewrite lineage instead of
    // mistaking codeboost's still-remote predecessor for a collaborator push.
    const retainedRemoteHead = initial.head !== view.snapshot.head
      && this.service.store.isRewrittenHead(identity, initial.head, view.snapshot.head);
    if (initial.head !== view.snapshot.head && !retainedRemoteHead) {
      view = this.#refresh(initial);
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked: [],
        reason: 'The pull request head moved; attribution and approvals were refreshed.' };
    }
    if (initial.base !== view.snapshot.base) {
      const repository = this.service.reviewRepository().path;
      const old = readHistory(repository, view.snapshot.base, view.snapshot.head).commits.map(commit => commit.sha);
      task = this.service.store.getTask(identity);
      const reviewed = { revision: view.expected.revision, snapshotId: view.expected.snapshotId,
        reviewVersion: view.expected.reviewVersion! };
      const oldBase = view.snapshot.base, oldHead = view.snapshot.head;
      const marker = this.service.store.beginRebase(identity, reviewed, task.stateVersion,
        { oldBase: view.snapshot.base, oldHead: view.snapshot.head, oldHistory: old, onto: initial.base });
      try {
        const result = await this.rebaser.run({ attemptId: marker.attemptId, oldBase,
          oldHead, oldHistory: old, onto: initial.base,
          ledger: this.service.store.getLedger(identity), signal });
        signal.throwIfAborted();
        this.service.store.finishRebase(identity, reviewed, task.stateVersion, marker.attemptId,
          result.base, result.head, result.mappings);
      } catch (error) {
        try { await this.#cleanupRebase(identity, marker); }
        catch (cleanup) { throw new AggregateError([error, cleanup], error instanceof Error ? error.message : 'Rebase failed.', { cause: error }); }
        throw error;
      }
      view = this.service.load();
    }
    const blocker = this.#reviewBlocker(view);
    if (blocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head,
      checked: [], reason: blocker };
    const checked: string[] = [];
    for (const item of view.items.filter(candidate => candidate.acceptance.some(check => check.type === 'cmd'))) {
      signal.throwIfAborted();
      task = this.service.store.getTask(identity);
      const attempt = this.runner.start(identity, { expectedStateVersion: task.stateVersion, kind: 'check', item: item.id,
        deadline: Date.now() + this.checkTimeoutMs, expectedContext: this.service.store.currentContext(identity) });
      const stop = () => this.runner.stop(identity, attempt.id, this.#closing ? 'shutdown' : 'cancelled');
      signal.addEventListener('abort', stop, { once: true });
      try { await this.runner.settled(identity); } finally { signal.removeEventListener('abort', stop); }
      signal.throwIfAborted();
      const settled = this.service.store.getAttempt(identity, attempt.id);
      if (settled.state !== 'completed') throw new GuardRefusal(`${item.id} command checks did not pass.`);
      checked.push(item.id); view = this.service.load();
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
      await this.remote.fetch(final, signal); view = this.#refresh(final);
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The pull request moved during preparation; attribution and approvals were refreshed.' };
    }
    view = this.service.load();
    if (view.snapshot.base !== prepared.base || view.snapshot.head !== prepared.head)
      return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
        reason: 'The local review changed during preparation; reload it.' };
    const finalBlocker = this.#reviewBlocker(view, true);
    if (finalBlocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head, checked,
      reason: finalBlocker };
    return { state: 'ready', base: view.snapshot.base, head: view.snapshot.head, checked, reason: null };
  }
}

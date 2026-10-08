import { readHistory } from '../git/history.ts';
import { DEFAULT_PROCESS_SETTLEMENT_MS } from '../agents/process-group.ts';
import type { PlanIdentity } from '../core/identity.ts';
import type { RunnerCoordinator } from './coordinator.ts';
import { GuardRefusal, MERGEABLE_STATUSES, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { MAX_REBASE_TIMEOUT_MS, MIN_REBASE_CLEANUP_TIMEOUT_MS, MIN_REBASE_TIMEOUT_MS,
  RebaseResourcesUnsettled, type GitRebaser } from './rebase.ts';
import type { ReviewService } from './review.ts';
import type { PreMergeReadiness, RebaseMarker } from './store.ts';

export interface RemotePair { base: string; head: string }
export interface PreMergeRemote {
  inspect(signal?: AbortSignal): Promise<RemotePair>;
  fetch(pair: RemotePair, signal?: AbortSignal): Promise<void>;
}
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

/** Production preparation before F6: refresh, rebase, re-review, then exact-head command checks. */
export class PreMergeCoordinator {
  readonly service: ReviewService;
  readonly runner: RunnerCoordinator;
  readonly rebaser: GitRebaser;
  readonly remote: PreMergeRemote;
  readonly operationTimeoutMs: number;
  readonly processSettlementReserveMs: number;
  readonly commandSettlementReserveMs: number;
  readonly authorize?: (signal: AbortSignal) => Promise<PreMergeAuthorization>;
  readonly settle: <T>(fn: () => T) => T;
  #active: Promise<PreMergeResult> | null = null;
  #abort: AbortController | null = null;
  #closing = false;
  #last: PreMergeResult | null = null;
  #lastBinding: { stateVersion: number; reviewVersion: number; snapshotId: string } | null = null;

  constructor(service: ReviewService, runner: RunnerCoordinator, rebaser: GitRebaser, remote: PreMergeRemote,
    operationTimeoutMs = 10 * 60_000, capability?: ShutdownCapability,
    authorize?: (signal: AbortSignal) => Promise<PreMergeAuthorization>,
    reserves: { processMs?: number; commandMs?: number } = {}) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 60 * 60_000)
      throw new Error('Invalid pre-merge operation deadline.');
    this.service = service; this.runner = runner; this.rebaser = rebaser; this.remote = remote;
    this.operationTimeoutMs = operationTimeoutMs; this.authorize = authorize;
    this.processSettlementReserveMs = reserves.processMs ?? PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS;
    this.commandSettlementReserveMs = reserves.commandMs ?? COMMAND_CHECK_SETTLEMENT_RESERVE_MS;
    if (!Number.isSafeInteger(this.processSettlementReserveMs) || this.processSettlementReserveMs < 0
      || !Number.isSafeInteger(this.commandSettlementReserveMs) || this.commandSettlementReserveMs < 0)
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
      const available = remaining() - (cleanupOnly ? 0 : MIN_REBASE_CLEANUP_TIMEOUT_MS);
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
    // Rebase lifecycle writes advance task state without changing the reviewed pair. Bind a resulting failure to that
    // settled durable state without rebuilding history; if a read fails, the older binding remains safely stale.
    const bindCurrentFailure = () => {
      try {
        const snapshot = this.service.store.getSnapshot(identity);
        onObserved({ pair: { base: snapshot.base, head: snapshot.head }, binding: {
          stateVersion: this.service.store.getTask(identity).stateVersion,
          reviewVersion: this.service.store.reviewVersion(identity), snapshotId: snapshot.id,
        } });
      } catch { /* An unbound failure is conservatively historical. */ }
    };
    const load = () => track(this.service.load({ maxDurationMs: Math.min(30_000, reviewBudget()) }));
    let view = load(), task = this.service.store.getTask(identity);
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
          bindCurrentFailure();
          throw error;
        }
        try { await this.#cleanupRebase(identity, marker, rebaseBudget(true)); }
        catch (cleanup) {
          bindCurrentFailure();
          throw new AggregateError([error, cleanup], error instanceof Error ? error.message : 'Rebase failed.', { cause: error });
        }
        bindCurrentFailure();
        throw error;
      }
      view = load();
    }
    const blocker = this.#reviewBlocker(view);
    if (blocker) return { state: 'review-required', base: view.snapshot.base, head: view.snapshot.head,
      checked: [], reason: blocker };
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

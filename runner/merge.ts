import type { ReviewService } from './review.ts';
import { mergeActionResponse, type MergeAttempt } from './store.ts';
import { ActionIdReused, GuardRefusal, MERGEABLE_STATUSES, ShuttingDownError, assertUuidV4, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { MERGE_INSPECTION_TIMEOUT_MS, MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type MergeQueueObservation, type MergeResult, type MergeTarget, type RemoteMergeState } from '../github/merge.ts';
import { openingMarker } from '../github/pull-requests.ts';

type ReviewView = ReturnType<ReviewService['load']>;
type QueueGateway = MergeGateway & MergeQueueGateway;
export interface MergeBlocker { code: string; message: string; }
/** The longest a merge click may run before it is aborted; its last gh call's stop wait comes on top (github/merge.ts). */
export const MERGE_OPERATION_TIMEOUT_MS = 14_000;
const storageError = (error: unknown) => (error as { code?: string } | null)?.code === 'ERR_SQLITE_ERROR';
/** The merge was not applied for a passing reason (deadline, shutdown); the same click may be sent again. */
export class MergeNotApplied extends Error {}
/** A concurrent poll already committed this attempt's terminal failure; it is the answer, passed through as is. */
class CommittedFailure extends Error {}
/** The click was admitted but GitHub's outcome is unknown; its attempt stays in flight, so the key must be kept. */
export class MergeOutcomeUnknown extends Error {}
export interface MergeQueueStatus {
  kind: MergeAttempt['kind']; state: MergeAttempt['state']; reviewedHead: string; url: string | null; reason: string | null;
  phase: MergeAttempt['phase']; position: number | null; occurredAt: string | null; retryable: boolean;
  /** The click that started this attempt, so the browser can tell when a retained key has been resolved. */
  actionId: string | null;
  observationError?: string;
}
export interface MergeStatus {
  available: true; ready: boolean; action: 'merge' | 'retry' | null; blockers: MergeBlocker[];
  remote: RemoteMergeState; queue: MergeQueueStatus | null;
}
export interface MergeUnavailableStatus { available: true; ready: false; action: null; blockers: MergeBlocker[]; remote: null; queue: MergeQueueStatus | null; }
/**
 * With a runner block (#121), the merge targets the task's published PR, not `github.pullRequest`: the opened record
 * whose opening began last among the task's records in `repository` and `baseBranch`. GitHub must show it from the task
 * branch, into that base, with that record's marker as its first line, as the only open PR from the branch.
 */
export interface PublishedTarget {
  repository: string;
  baseBranch: string;
  /** `github.pullRequest`, if the configuration still names one. It must be the task's PR. */
  configured?: number;
}
/** No PR can be inspected. The display keeps the blockers found before the target was resolved. */
class MergeTargetUnavailable extends Error { blockers: MergeBlocker[] = []; }
/** The PR one status read inspected. `openingId` is set for the task's published PR, which admission re-reads. */
interface ResolvedTarget { target?: MergeTarget; openingId: string | null; marker?: string; headBranch?: string }

function queueGateway(gateway: MergeGateway): gateway is QueueGateway {
  const queue = gateway as Partial<MergeQueueGateway>;
  return typeof queue.inspectQueue === 'function' && typeof queue.queueWatermark === 'function';
}

export class MergeCoordinator {
  #active: Promise<{ status: MergeStatus | MergeUnavailableStatus; result: MergeResult }> | null = null;
  /** The click the active merge serves; a resend of it joins that merge before its action is saved. */
  #activeClick: { actionId: string; token: string } | null = null;
  #abort: AbortController | null = null;
  #queuePoll: Promise<MergeQueueStatus | null> | null = null;
  #queueAbort: AbortController | null = null;
  #closing = false;
  readonly service: ReviewService;
  readonly gateway: MergeGateway;
  readonly operationTimeoutMs: number;
  readonly published: PublishedTarget | null;
  /** Settlement of an irreversible merge keeps its writes after the Store gate closes; request-path reconciliation does not. */
  #settle: <T>(fn: () => T) => T;
  constructor(service: ReviewService, gateway: MergeGateway, operationTimeoutMs = MERGE_OPERATION_TIMEOUT_MS, capability?: ShutdownCapability, published?: PublishedTarget) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > MERGE_OPERATION_TIMEOUT_MS) throw new Error('Invalid merge operation deadline.');
    if (published && (published.configured !== undefined && (!Number.isSafeInteger(published.configured) || published.configured < 1))) throw new Error('Invalid configured pull request.');
    this.service = service; this.gateway = gateway; this.operationTimeoutMs = operationTimeoutMs; this.published = published ?? null;
    this.#settle = settleWith(capability);
  }

  #attempt(): MergeAttempt | null {
    return this.service.store?.getMergeAttempt(this.service.config.identity) ?? null;
  }

  /**
   * The PR to inspect. An attempt in flight or merged keeps the PR it was started for. Otherwise, without a runner block,
   * the gateway's configured PR; with one, the task's opened PR in the configured base whose opening began last (#121).
   */
  #resolve(attempt: MergeAttempt | null): ResolvedTarget {
    const pinned = attempt && (attempt.state === 'submitting' || attempt.state === 'queued' || attempt.state === 'merged') ? attempt : null;
    const published = this.published;
    if (!published) return { ...(pinned?.pullRequest ? { target: { pullRequest: pinned.pullRequest } } : {}), openingId: null };
    const rows = this.service.store.taskPullRequests(this.service.config.identity);
    const here = rows.filter(pr => pr.repository.toLowerCase() === published.repository.toLowerCase());
    const ownPullRequests = [...new Set(here.flatMap(pr => pr.number === null ? [] : [pr.number]))];
    if (pinned) {
      // An attempt saved before #121 has no PR: it merged the configured one.
      const number = pinned.pullRequest ?? published.configured;
      if (!number) throw new MergeTargetUnavailable('This merge attempt was saved without its pull request, and github.pullRequest is not set. Set github.pullRequest to the pull request it merged.');
      return { target: { pullRequest: number, ownPullRequests }, openingId: null };
    }
    if (rows.some(pr => pr.state === 'opening' || pr.refresh !== null))
      throw new MergeTargetUnavailable('The task\'s pull request is being opened or updated. Wait for publishing to finish, then refresh.');
    const latest = here.filter(pr => pr.state === 'opened' && pr.base === published.baseBranch).at(-1);
    if (!latest || latest.number === null) throw new MergeTargetUnavailable(`The task has no published pull request into ${published.baseBranch}.`);
    if (published.configured !== undefined && published.configured !== latest.number)
      throw new MergeTargetUnavailable(`github.pullRequest is #${published.configured}, but the task's pull request is #${latest.number}. Remove github.pullRequest from the review configuration.`);
    return { target: { pullRequest: latest.number, ownPullRequests, headBranch: latest.headBranch }, openingId: latest.openingId,
      marker: openingMarker(latest.openingId), headBranch: latest.headBranch };
  }

  /** Whether GitHub shows the task's published PR where it was opened, as the only open PR from its branch. */
  #publishedBlockers(remote: RemoteMergeState, resolved: ResolvedTarget): MergeBlocker[] {
    const number = resolved.target!.pullRequest, branch = resolved.headBranch!, base = this.published!.baseBranch, seen = remote.published;
    const blocker = (message: string) => [{ code: 'pull-request', message }];
    if (remote.pullRequest !== number || !seen) return blocker(`GitHub did not report pull request #${number} as the task's pull request.`);
    if (seen.crossRepository || seen.headBranch !== branch || seen.baseBranch !== base)
      return blocker(`Pull request #${number} is no longer from ${branch} into ${base}. Restore its branch and base, or close it and publish the task again.`);
    if (seen.marker !== resolved.marker) return blocker(`Pull request #${number} no longer starts with its codeboost marker. Restore its first line.`);
    if (remote.pullRequestState !== 'OPEN') return [];
    const others = seen.branchOpen.filter(pr => pr.number !== number);
    if (others.length) return blocker(`Pull request #${number} must be the only open pull request from ${branch}. Close ${others.map(pr => `#${pr.number} (into ${pr.base})`).join(', ')}.`);
    if (!seen.branchOpen.some(pr => pr.number === number && pr.base === base)) return blocker(`GitHub's pull request list does not show #${number} yet. Refresh later.`);
    return [];
  }

  #current(attempt: MergeAttempt): boolean {
    const { store, config } = this.service;
    if (!store || !config) return false;
    const snapshot = store.getSnapshot(config.identity);
    return store.getPlan(config.identity).revision === attempt.revision && snapshot.id === attempt.snapshotId &&
      snapshot.head === attempt.reviewedHead && store.reviewVersion(config.identity) === attempt.reviewVersion;
  }

  #queueStatus(attempt = this.#attempt(), observationError?: string): MergeQueueStatus | null {
    if (!attempt) return null;
    return {
      kind: attempt.kind, state: attempt.state, reviewedHead: attempt.reviewedHead, url: attempt.url, reason: attempt.reason,
      phase: attempt.phase, position: attempt.position, occurredAt: attempt.occurredAt, actionId: attempt.actionId ?? null,
      retryable: (attempt.state === 'removed' || attempt.state === 'failed') && !attempt.requiresFreshReview && this.#current(attempt),
      ...(observationError ? { observationError } : {}),
    };
  }

  #freshReviewComplete(attempt: MergeAttempt): boolean {
    const { store, config } = this.service;
    const plan = store.getPlan(config.identity), snapshot = store.getSnapshot(config.identity);
    if (snapshot.id === attempt.snapshotId && plan.revision === attempt.revision && !attempt.requiresFreshReview) return true;
    const approvals = store.getReview(config.identity).approvals;
    return store.reviewVersion(config.identity) > attempt.reviewVersion && plan.items.every(item => approvals.some(approval => approval.item === item.id &&
      approval.revision === plan.revision && approval.snapshotId === snapshot.id && approval.reviewVersion !== undefined && approval.reviewVersion >= attempt.reviewVersion));
  }

  async status(view = this.service.load(), fresh = false, signal?: AbortSignal): Promise<MergeStatus> {
    return (await this.#status(view, fresh, signal)).status;
  }

  /** Fresh exact base/head pair for pre-merge preparation, using the same task-PR resolution as merge admission. */
  async remotePair(signal?: AbortSignal): Promise<{ base: string; head: string }> {
    const resolved = this.#resolve(this.#attempt());
    const remote = await this.gateway.inspect({ fresh: true, timeoutMs: 6_000, signal,
      ...(resolved.target ? { target: resolved.target } : {}) });
    signal?.throwIfAborted();
    if (resolved.target && remote.pullRequest !== resolved.target.pullRequest)
      throw new Error('GitHub returned a different pull request.');
    if (resolved.headBranch !== undefined) {
      const blockers = this.#publishedBlockers(remote, resolved);
      if (blockers.length) throw new GuardRefusal(blockers[0]!.message);
    }
    return { base: remote.base, head: remote.head };
  }

  async #status(view: ReviewView, fresh: boolean, signal?: AbortSignal): Promise<{ status: MergeStatus; resolved: ResolvedTarget }> {
    const blockers: MergeBlocker[] = [];
    for (const item of view.items) {
      if (item.state !== 'approved') blockers.push({ code: 'approval', message: `${item.id} is ${item.state}.` });
      if (item.outside.length) blockers.push({ code: 'scope', message: `${item.id} has ${item.outside.length} out-of-scope file${item.outside.length === 1 ? '' : 's'} and requires a plan amendment.` });
      if (item.acceptance.some(check => check.type === 'cmd') && item.checks.tests !== '✓ Passed') blockers.push({ code: 'acceptance', message: `${item.id} command checks have not passed on this head.` });
    }
    const ambiguous = view.segments.filter(segment => segment.row === 'Ambiguous').length;
    const unplanned = view.segments.filter(segment => segment.row === 'Unplanned').length;
    if (ambiguous) blockers.push({ code: 'ambiguous', message: `${ambiguous} ambiguous change${ambiguous === 1 ? '' : 's'} remain.` });
    if (unplanned) blockers.push({ code: 'unplanned', message: `${unplanned} unplanned change${unplanned === 1 ? '' : 's'} remain.` });
    const changes = view.notes.filter(note => note.kind === 'change' && note.revision === view.plan.revision && note.snapshotId === view.snapshot.id).length;
    if (changes) blockers.push({ code: 'changes', message: `${changes} change request${changes === 1 ? '' : 's'} remain open.` });
    // Readiness follows the same task-status gate as admission, so Merge PR never renders ready for runner work.
    if (this.service.store && this.service.config) {
      const task = this.service.store.getTask(this.service.config.identity);
      if (task.status !== 'merged' && !MERGEABLE_STATUSES.includes(task.status)) blockers.push({ code: 'task', message: `The task is ${task.status}; merge it from review.` });
    }
    let resolved: ResolvedTarget;
    try { resolved = this.#resolve(this.#attempt()); }
    catch (error) { if (error instanceof MergeTargetUnavailable) error.blockers = blockers; throw error; }
    const remote = await this.gateway.inspect({ fresh, timeoutMs: fresh ? 6_000 : undefined, signal, ...(resolved.target ? { target: resolved.target } : {}) });
    if (signal?.aborted) throw signal.reason;
    if (resolved.target && remote.pullRequest !== resolved.target.pullRequest) throw new Error('GitHub returned a different pull request.');
    if (resolved.headBranch !== undefined) blockers.push(...this.#publishedBlockers(remote, resolved));
    if (remote.draft) blockers.push({ code: 'draft', message: `Pull request #${remote.pullRequest} is a draft; GitHub does not merge a draft.` });
    if (remote.pullRequestState !== 'OPEN') blockers.push({ code: 'pr-state', message: `Pull request is ${remote.pullRequestState.toLowerCase()}.` });
    if (remote.base !== view.snapshot.base) blockers.push({ code: 'base', message: 'The base branch moved. Rebase and review the resulting snapshot.' });
    if (remote.head !== view.snapshot.head) blockers.push({ code: 'head', message: 'The pull request head moved. Refresh the review.' });
    if (remote.mergeable !== 'MERGEABLE') blockers.push({ code: 'mergeable', message: remote.mergeable === 'CONFLICTING' ? 'The pull request has merge conflicts.' : 'GitHub has not determined mergeability.' });
    if (!remote.rulesKnown) blockers.push({ code: 'rules', message: 'Required branch checks could not be read.' });
    if (remote.mergeQueue && !queueGateway(this.gateway)) blockers.push({ code: 'merge-queue', message: 'This GitHub adapter cannot verify the merge-queue lifecycle.' });
    if (!remote.atomicBaseGuard) blockers.push({ code: 'base-guard', message: 'GitHub does not expose a server-enforced guard for the validated base.' });
    for (const check of remote.requiredChecks) if (check.state !== 'success') blockers.push({ code: 'check', message: `${check.context} is ${check.state}.` });
    // Once this PR has merged, the check counts it as the fix; the pr-state blocker already says so.
    if (remote.pullRequestState !== 'MERGED' && remote.alreadyFixed === 'found') blockers.push({ code: 'already-fixed', message: remote.alreadyFixedDetail
      ? `The issue may already be fixed: ${remote.alreadyFixedDetail}.`
      : 'The issue may already be fixed: it is closed, another open or merged pull request refers to it, or a new base-branch commit mentions it.' });
    if (remote.pullRequestState !== 'MERGED' && remote.alreadyFixed === 'unknown') blockers.push({ code: 'already-fixed', message: remote.alreadyFixedDetail
      ? `The already-fixed check could not be completed: ${remote.alreadyFixedDetail}`
      : 'The already-fixed check could not be completed.' });

    let attempt = this.#attempt();
    if (attempt?.kind === 'direct' && attempt.state === 'submitting') {
      // Only a read of the attempt's own PR settles it (#121); an attempt saved before #121 merged the PR read here.
      if (remote.pullRequestState === 'MERGED' && remote.head === attempt.reviewedHead && (attempt.pullRequest == null || attempt.pullRequest === remote.pullRequest))
        // Reconciling a lost response: keep GitHub's PR URL, so a replayed click reports it as the first response would.
        this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, { state: 'merged', ...(remote.url ? { url: remote.url } : {}) });
      attempt = this.#attempt();
    }
    const queue = this.#queueStatus(attempt);
    const attemptBlocker = this.#attemptBlocker(attempt);
    if (attemptBlocker) blockers.unshift(attemptBlocker);
    const active = attempt?.state === 'submitting' || attempt?.state === 'queued' || attempt?.state === 'merged';
    const retry = !!queue?.retryable;
    const ready = !active && blockers.length === 0;
    return { status: { available: true, ready, action: ready ? (retry ? 'retry' : 'merge') : null, blockers, remote, queue }, resolved };
  }

  /** What the merge attempt on record says, shown first. */
  #attemptBlocker(attempt: MergeAttempt | null): MergeBlocker | null {
    if (attempt?.state === 'submitting' || attempt?.state === 'queued') return { code: 'queue-active', message: attempt.state === 'submitting'
      ? attempt.reason ? `The merge submission outcome is unknown. ${attempt.reason} Waiting for GitHub reconciliation.` : attempt.kind === 'queue' ? 'The reviewed head is being submitted to the merge queue.' : 'The reviewed head is being submitted for direct merge.'
      : 'The reviewed head is queued. Waiting for GitHub to confirm the outcome.' };
    if (attempt?.state === 'merged') return { code: 'queue-merged', message: 'GitHub confirmed that the reviewed head was merged.' };
    if (attempt && !this.#freshReviewComplete(attempt)) return { code: 'queue-head', message: attempt.reason ?? 'The pull request snapshot changed after the queue attempt. Review the replacement snapshot.' };
    return null;
  }

  async displayStatus(view = this.service.load(), signal?: AbortSignal): Promise<MergeStatus | MergeUnavailableStatus> {
    try { return await this.status(view, false, signal); }
    catch (error) {
      if (error instanceof ShuttingDownError) throw error;
      if (signal?.aborted) throw signal.reason;
      if (error instanceof MergeTargetUnavailable) {
        const attempt = this.#attempt(), attemptBlocker = this.#attemptBlocker(attempt);
        const blockers = [...(attemptBlocker ? [attemptBlocker] : []), { code: 'pull-request', message: error.message }, ...error.blockers];
        return { available: true, ready: false, action: null, blockers, remote: null, queue: this.#queueStatus(attempt) };
      }
      return { available: true, ready: false, action: null, blockers: [{ code: 'github', message: `Could not read GitHub merge state. ${error instanceof Error ? error.message : 'Unknown error.'}` }], remote: null, queue: this.#queueStatus() };
    }
  }

  /**
   * `actionId` is the click's idempotency key. A resend with the same key (after a lost response) returns the saved
   * attempt's current outcome and never submits again.
   */
  async merge(token: unknown, actionId?: unknown): Promise<{ status: MergeStatus | MergeUnavailableStatus; result: MergeResult }> {
    if (actionId !== undefined) assertUuidV4(actionId, 'Action ID');
    // A resend of the click still in progress joins it, so it gets the final result rather than a saved interim state.
    if (this.#active && typeof actionId === 'string' && this.#activeClick?.actionId === actionId) {
      if (this.#activeClick.token !== token) throw new ActionIdReused('Action ID already used for a different request.');
      return this.#active;
    }
    // Otherwise replay before every other guard, shutdown included: a resend after a lost response is not a second click.
    const replay = typeof token === 'string' && typeof actionId === 'string' ? this.#replay(token, actionId) : undefined;
    if (replay) return replay;
    if (this.#closing) throw new MergeNotApplied('Merge coordinator is shutting down.');
    if (this.#active) {
      const refusal = new Error('A merge attempt is already running.');
      const saved = typeof token === 'string' && typeof actionId === 'string' ? this.#recordRefusal(token, actionId, refusal) : undefined;
      if (saved) return saved;
      throw refusal;
    }
    if (typeof token !== 'string') throw new Error('Stale review state. Refresh before merging.');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Merge request deadline exceeded.')), this.operationTimeoutMs);
    this.#abort = abort;
    const attempt = this.#merge(token, abort.signal, actionId as string | undefined).finally(() => {
      clearTimeout(timer);
      if (this.#active === attempt) { this.#active = null; this.#activeClick = null; }
      if (this.#abort === abort) this.#abort = null;
    });
    this.#active = attempt;
    this.#activeClick = typeof actionId === 'string' ? { actionId, token } : null;
    return attempt;
  }

  /**
   * Save a definite refusal as this click's outcome, so a resend replays it instead of being evaluated again.
   * Returns undefined when this refusal was saved (the caller answers with it). If another coordinator saved the
   * click first, its outcome is the answer: a saved success comes back as a replay, a saved refusal or a reused key
   * is thrown.
   */
  #recordRefusal(token: string, actionId: string, refusal: unknown): ReturnType<MergeCoordinator['merge']> | undefined {
    if (!this.service.store || !this.service.config) return undefined;
    const action = { actionId, kind: 'merge', request: { token } };
    try {
      // Returning normally means userAction replayed a success saved concurrently: answer from that record.
      this.service.store.userAction(this.service.config.identity, action, () => { throw refusal; });
      return this.#replay(token, actionId);
    } catch (error) {
      // A storage error, whether it was the refusal itself or the failed save, recorded nothing: resend.
      if (storageError(refusal) || storageError(error)) throw new MergeNotApplied('The merge outcome could not be saved. Try again.', { cause: error });
      // userAction re-raised this refusal after saving it.
      if (error === refusal) return undefined;
      // A refusal saved concurrently under this key, or the key reused for another request: that is the answer.
      if (error instanceof GuardRefusal) throw error;
      // Anything else left the refusal unsaved: nothing was applied, so resend.
      throw new MergeNotApplied('The merge refusal could not be saved. Try again.', { cause: error });
    }
  }

  /** The saved outcome of this click, if it has one. Validation never runs again for a replay. */
  #replay(token: string, actionId: string): Promise<{ status: MergeStatus | MergeUnavailableStatus; result: MergeResult }> | undefined {
    if (!this.service.store || !this.service.config) return undefined;
    const { store, config } = this.service;
    const read = () => {
      try { return store.savedAction<ReturnType<typeof mergeActionResponse>>(config.identity, { actionId, kind: 'merge', request: { token } }); }
      catch (error) {
        // A storage failure says nothing about this click: answer "resend" (503) so the browser keeps its key.
        // A saved refusal or a reused key is a definite answer and passes through.
        if (storageError(error)) throw new MergeNotApplied('The saved merge outcome could not be read. Try again.', { cause: error });
        throw error;
      }
    };
    const saved = read();
    if (!saved) return undefined;
    // A refused or removed merge replays as the failure the first response reported, never as a submission.
    const answer = (response: ReturnType<typeof mergeActionResponse>, status: MergeStatus | MergeUnavailableStatus) => {
      if (response.state === 'failed' || response.state === 'removed') throw new Error(response.reason ?? 'GitHub did not merge this pull request.');
      // Still submitting after the refresh: GitHub's outcome is unknown, as the first answer said. Keep the key.
      if (response.state === 'submitting') throw new MergeOutcomeUnknown(response.reason ?? 'The merge outcome is not confirmed yet. Refresh to check GitHub.');
      return { status, result: { url: response.url ?? '' } };
    };
    if (saved.response.state === 'failed' || saved.response.state === 'removed')
      return Promise.reject(new Error(saved.response.reason ?? 'GitHub did not merge this pull request.'));
    // The saved outcome is committed; a failing local refresh must not turn it into a blocked merge.
    const unavailable = (error: unknown): MergeUnavailableStatus => ({ available: true, ready: false, action: null, remote: null, queue: null,
      blockers: [{ code: 'refresh', message: `Merge was submitted. Refresh to confirm GitHub state. ${error instanceof Error ? error.message : ''}`.trim() }] });
    // The status refresh may reconcile the attempt (merged URL, queue failure), so answer from the record re-read after
    // it. A failed re-read is not answered with the older record: read() turns a storage error into "resend" (503).
    const current = () => read()?.response ?? saved.response;
    let view: ReviewView;
    try { view = this.service.load(); } catch (error) { return Promise.resolve().then(() => answer(current(), unavailable(error))); }
    return this.displayStatus(view).then(status => answer(current(), status), error => answer(current(), unavailable(error)));
  }

  async #merge(token: string, signal: AbortSignal, actionId?: string): Promise<{ status: MergeStatus | MergeUnavailableStatus; result: MergeResult }> {
    let queueAttempt: MergeAttempt | null = null;
    const action = actionId ? { actionId, kind: 'merge', request: { token } } : null;
    try {
      // Captured when the request arrives and re-checked in the admission transaction after the final await.
      const taskStateVersion = this.service.store && this.service.config ? this.service.store.getTask(this.service.config.identity).stateVersion : null;
      let view = this.service.load();
      if (view.token !== token) throw new Error('Stale review state. Refresh before merging.');
      const { status, resolved } = await this.#statusForMerge(view, signal);
      if (!status.ready) throw new Error(status.blockers[0]?.message ?? 'Merge is blocked.');
      view = this.service.load();
      if (view.token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      const { status: finalStatus, resolved: finalTarget } = await this.#statusForMerge(view, signal);
      // The same PR, opened by the same opening, in every pass (#121).
      const samePullRequest = (other: { status: MergeStatus; resolved: ResolvedTarget }) =>
        other.status.remote.pullRequest === status.remote.pullRequest && other.resolved.openingId === resolved.openingId;
      if (finalStatus.remote.base !== status.remote.base || finalStatus.remote.head !== status.remote.head || !samePullRequest({ status: finalStatus, resolved: finalTarget }))
        throw new Error('The pull request changed during merge validation. Refresh before merging.');
      if (finalStatus.remote.mergeQueue !== status.remote.mergeQueue) throw new Error('Merge-queue requirements changed during validation. Refresh before merging.');
      if (!finalStatus.ready) throw new Error(`Merge requirements changed during validation. ${finalStatus.blockers[0]!.message}`);
      let commandStatus = finalStatus;
      let queueWatermark: string | null = null;
      if (status.remote.mergeQueue) {
        if (!queueGateway(this.gateway)) throw new Error('This GitHub adapter cannot verify the merge-queue lifecycle.');
        if (view.expected.reviewVersion === undefined) throw new Error('A current review version is required for merging.');
        queueWatermark = await this.gateway.queueWatermark(status.remote.head, { signal, timeoutMs: 6_000, pullRequest: status.remote.pullRequest });
        const command = await this.#statusForMerge(view, signal);
        commandStatus = command.status;
        if (commandStatus.remote.base !== finalStatus.remote.base || commandStatus.remote.head !== finalStatus.remote.head || commandStatus.remote.mergeQueue !== finalStatus.remote.mergeQueue || !samePullRequest(command))
          throw new Error('Merge-queue requirements changed after queue correlation. Refresh before merging.');
        if (!commandStatus.ready) throw new Error(`Merge requirements changed after queue correlation. ${commandStatus.blockers[0]!.message}`);
      }
      if (this.service.load().token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      if (signal.aborted) throw signal.reason;
      if (this.service.store && this.service.config && view.expected.reviewVersion !== undefined) {
        const { store, config } = this.service, reviewVersion = view.expected.reviewVersion;
        const begin = () => store.beginMergeAttempt(config.identity, { ...view.expected, reviewVersion }, commandStatus.remote.head, queueWatermark,
          commandStatus.remote.mergeQueue ? 'queue' : 'direct', actionId ?? null, taskStateVersion, { pullRequest: commandStatus.remote.pullRequest, openingId: resolved.openingId });
        let begun: MergeAttempt | null = null;
        // The attempt and the click's saved response commit in one transaction, or neither does.
        if (action) store.userAction(config.identity, action, () => mergeActionResponse(begun = begin()));
        else begun = begin();
        // Saved meanwhile by another coordinator on this database: the catch below replays its outcome.
        if (!begun) throw new Error('This merge click was already submitted. Refresh to see its outcome.');
        queueAttempt = begun;
      }
      const result = await this.gateway.merge(commandStatus.remote.head, { signal, pullRequest: commandStatus.remote.pullRequest });
      if (queueAttempt) {
        // The enqueue command has already committed externally. A local refresh failure must not
        // report that action as failed; the durable submitting record is recoverable by polling.
        let applied = true;
        try {
          const attempt = queueAttempt;
          applied = this.#settle(() => attempt.kind === 'queue'
            ? this.service.store.queueMergeAttempt(this.service.config.identity, attempt.id, result.url)
            : this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, { state: 'merged', url: result.url }));
        } catch {}
        // Not applied: a concurrent poll changed the attempt first. A committed failure is the answer, not this success.
        if (!applied) {
          const current = this.service.store.getMergeAttempt(this.service.config.identity);
          if (current?.id === queueAttempt.id && (current.state === 'failed' || current.state === 'removed'))
            throw new CommittedFailure(current.reason ?? 'GitHub did not merge this pull request.');
          // A newer attempt started while this command ran (only possible across processes before the single-runner
          // lock): this command's result cannot be tied to either attempt, so fail closed rather than report success.
          if (current?.id !== queueAttempt.id)
            throw new MergeOutcomeUnknown('A newer merge attempt started while this merge ran. Refresh to confirm GitHub state.');
        }
      }
      return { status: commandStatus, result };
    } catch (error) {
      if (error instanceof CommittedFailure) throw error;
      // GitHub's refusal is definite only once the attempt's failed state (and the click's saved answer) is durable.
      let refusalSaved = false;
      if (queueAttempt) try { const attempt = queueAttempt; this.#settle(() => {
        const message = error instanceof Error ? error.message : 'GitHub merge submission outcome is unknown.';
        if (error instanceof MergeSubmissionError && error.outcome === 'refused') {
          refusalSaved = this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, {
            state: 'failed', reason: message,
            requiresFreshReview: /head (?:branch |commit )?(?:was )?(?:modified|changed)|does not match.*head|stale review/i.test(message),
          });
        } else this.service.store.recordMergeAttemptDiagnostic(this.service.config.identity, attempt.id, message);
      }); } catch {}
      // A definite refusal before admission is this click's outcome; a resend replays it. Aborts, the deadline and
      // shutdown applied nothing for a passing reason, so the same click may be sent again.
      if (!queueAttempt && !signal.aborted && action) {
        // If another coordinator saved this click meanwhile, its outcome is the answer, not this refusal.
        const replay = this.#replay(token, action.actionId) ?? this.#recordRefusal(token, action.actionId, error);
        if (replay) return await replay;
      }
      // Before admission an abort applied nothing, so the click may be resent (503). After admission the GitHub outcome
      // is unknown: the durable attempt stays in flight and reconciles on refresh, so report the original error.
      if (signal.aborted && !queueAttempt) throw new MergeNotApplied(signal.reason instanceof Error ? signal.reason.message : 'Merge request stopped.', { cause: signal.reason });
      // After admission only GitHub's confirmed refusal, durably recorded, is definite (the attempt is now failed);
      // anything else, including a refusal whose failed state could not be saved, leaves the attempt in flight.
      const refused = error instanceof MergeSubmissionError && error.outcome === 'refused' && refusalSaved;
      const failure = signal.aborted && signal.reason instanceof Error ? signal.reason : error;
      if (queueAttempt && !refused) throw new MergeOutcomeUnknown(failure instanceof Error ? failure.message : 'The merge outcome is unknown.', { cause: failure });
      throw failure;
    }
  }

  #statusForMerge(view: ReviewView, signal: AbortSignal): Promise<{ status: MergeStatus; resolved: ResolvedTarget }> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return this.#status(view, true, signal);
  }

  async pollQueue(): Promise<MergeQueueStatus | null> {
    if (this.#closing) throw new Error('Merge coordinator is shutting down.');
    if (this.#queuePoll) return this.#queuePoll;
    const attempt = this.#attempt();
    if (!attempt || (attempt.state !== 'submitting' && attempt.state !== 'queued')) return this.#queueStatus(attempt);
    if (attempt.kind === 'direct') return this.#queueStatus(attempt);
    if (!queueGateway(this.gateway)) return this.#queueStatus(attempt, 'This GitHub adapter cannot verify the merge-queue lifecycle.');
    // The attempt's own PR; an attempt saved before #121 queued the configured one.
    const pullRequest = attempt.pullRequest ?? this.published?.configured;
    if (this.published && !pullRequest) return this.#queueStatus(attempt, 'This merge attempt was saved without its pull request, and github.pullRequest is not set. Set github.pullRequest to the pull request it queued.');
    const abort = new AbortController();
    this.#queueAbort = abort;
    const poll = this.#pollQueue(attempt, pullRequest ?? undefined, abort.signal).finally(() => {
      if (this.#queuePoll === poll) this.#queuePoll = null;
      if (this.#queueAbort === abort) this.#queueAbort = null;
    });
    this.#queuePoll = poll;
    return poll;
  }

  queueSnapshot(): MergeQueueStatus | null { return this.#queueStatus(); }

  async #pollQueue(attempt: MergeAttempt, pullRequest: number | undefined, signal: AbortSignal): Promise<MergeQueueStatus | null> {
    try {
      const observation = await (this.gateway as QueueGateway).inspectQueue(attempt.reviewedHead, { signal, timeoutMs: MERGE_INSPECTION_TIMEOUT_MS, afterCursor: attempt.queueWatermark ?? null,
        ...(pullRequest !== undefined ? { pullRequest } : {}) });
      this.#publishQueueObservation(attempt, observation);
      return this.#queueStatus();
    } catch (error) {
      if (error instanceof ShuttingDownError) throw error;
      if (signal.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : 'Could not read the merge queue.';
      if (/head changed after review/i.test(message)) {
        this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, { state: 'failed', reason: message, requiresFreshReview: true });
        return this.#queueStatus();
      }
      return this.#queueStatus(attempt, message);
    }
  }

  #publishQueueObservation(attempt: MergeAttempt, observation: MergeQueueObservation): void {
    const { store } = this.service, { identity } = this.service.config;
    if (observation.reviewedHead !== attempt.reviewedHead) throw new Error('GitHub returned a merge-queue observation for a different reviewed head.');
    if (observation.state === 'queued') {
      store.observeQueuedMerge(identity, attempt.id, { entryId: observation.entryId, phase: observation.phase, position: observation.position });
    } else if (observation.state === 'merged') {
      store.finishMergeAttempt(identity, attempt.id, { state: 'merged', occurredAt: observation.mergedAt });
    } else if (observation.state === 'removed') {
      store.finishMergeAttempt(identity, attempt.id, { state: 'removed', reason: observation.reason, occurredAt: observation.removedAt });
    } else {
      store.finishMergeAttempt(identity, attempt.id, { state: 'failed', reason: observation.reason });
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const active = this.#active, poll = this.#queuePoll;
    this.#abort?.abort(new Error('Merge cancelled during shutdown.'));
    this.#queueAbort?.abort(new Error('Merge-queue inspection cancelled during shutdown.'));
    if (active) try { await active; } catch {}
    if (poll) try { await poll; } catch {}
  }
}

import type { ReviewService } from './review.ts';
import { mergeActionResponse, type MergeAttempt } from './store.ts';
import { ActionIdReused, GuardRefusal, MERGEABLE_STATUSES, assertUuidV4 } from './lifecycle.ts';
import { MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type MergeQueueObservation, type MergeResult, type RemoteMergeState } from '../github/merge.ts';

type ReviewView = ReturnType<ReviewService['load']>;
type QueueGateway = MergeGateway & MergeQueueGateway;
export interface MergeBlocker { code: string; message: string; }
const storageError = (error: unknown) => (error as { code?: string } | null)?.code === 'ERR_SQLITE_ERROR';
/** The merge was not applied for a passing reason (deadline, shutdown); the same click may be sent again. */
export class MergeNotApplied extends Error {}
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
  constructor(service: ReviewService, gateway: MergeGateway, operationTimeoutMs = 14_000) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 14_000) throw new Error('Invalid merge operation deadline.');
    this.service = service; this.gateway = gateway; this.operationTimeoutMs = operationTimeoutMs;
  }

  #attempt(): MergeAttempt | null {
    return this.service.store?.getMergeAttempt(this.service.config.identity) ?? null;
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
    const remote = await this.gateway.inspect({ fresh, timeoutMs: fresh ? 6_000 : undefined, signal });
    if (signal?.aborted) throw signal.reason;
    if (remote.pullRequestState !== 'OPEN') blockers.push({ code: 'pr-state', message: `Pull request is ${remote.pullRequestState.toLowerCase()}.` });
    if (remote.base !== view.snapshot.base) blockers.push({ code: 'base', message: 'The base branch moved. Rebase and review the resulting snapshot.' });
    if (remote.head !== view.snapshot.head) blockers.push({ code: 'head', message: 'The pull request head moved. Refresh the review.' });
    if (remote.mergeable !== 'MERGEABLE') blockers.push({ code: 'mergeable', message: remote.mergeable === 'CONFLICTING' ? 'The pull request has merge conflicts.' : 'GitHub has not determined mergeability.' });
    if (!remote.rulesKnown) blockers.push({ code: 'rules', message: 'Required branch checks could not be read.' });
    if (remote.mergeQueue && !queueGateway(this.gateway)) blockers.push({ code: 'merge-queue', message: 'This GitHub adapter cannot verify the merge-queue lifecycle.' });
    if (!remote.atomicBaseGuard) blockers.push({ code: 'base-guard', message: 'GitHub does not expose a server-enforced guard for the validated base.' });
    for (const check of remote.requiredChecks) if (check.state !== 'success') blockers.push({ code: 'check', message: `${check.context} is ${check.state}.` });
    if (remote.alreadyFixed === 'found') blockers.push({ code: 'already-fixed', message: 'Another open or merged pull request references this issue.' });
    if (remote.alreadyFixed === 'unknown') blockers.push({ code: 'already-fixed', message: 'The already-fixed check could not be completed.' });

    let attempt = this.#attempt();
    if (attempt?.kind === 'direct' && attempt.state === 'submitting') {
      if (remote.pullRequestState === 'MERGED' && remote.head === attempt.reviewedHead)
        // Reconciling a lost response: keep GitHub's PR URL, so a replayed click reports it as the first response would.
        this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, { state: 'merged', ...(remote.url ? { url: remote.url } : {}) });
      attempt = this.#attempt();
    }
    const queue = this.#queueStatus(attempt);
    if (attempt?.state === 'submitting' || attempt?.state === 'queued') {
      blockers.unshift({ code: 'queue-active', message: attempt.state === 'submitting'
        ? attempt.reason ? `The merge submission outcome is unknown. ${attempt.reason} Waiting for GitHub reconciliation.` : attempt.kind === 'queue' ? 'The reviewed head is being submitted to the merge queue.' : 'The reviewed head is being submitted for direct merge.'
        : 'The reviewed head is queued. Waiting for GitHub to confirm the outcome.' });
    } else if (attempt?.state === 'merged') {
      blockers.unshift({ code: 'queue-merged', message: 'GitHub confirmed that the reviewed head was merged.' });
    } else if (attempt && !this.#freshReviewComplete(attempt)) {
      blockers.unshift({ code: 'queue-head', message: attempt.reason ?? 'The pull request snapshot changed after the queue attempt. Review the replacement snapshot.' });
    }
    const active = attempt?.state === 'submitting' || attempt?.state === 'queued' || attempt?.state === 'merged';
    const retry = !!queue?.retryable;
    const ready = !active && blockers.length === 0;
    return { available: true, ready, action: ready ? (retry ? 'retry' : 'merge') : null, blockers, remote, queue };
  }

  async displayStatus(view = this.service.load(), signal?: AbortSignal): Promise<MergeStatus | MergeUnavailableStatus> {
    try { return await this.status(view, false, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
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
      if (typeof token === 'string' && typeof actionId === 'string') this.#recordRefusal({ actionId, kind: 'merge', request: { token } }, refusal);
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

  /** Save a definite refusal as this click's outcome, so a resend replays it instead of being evaluated again. */
  #recordRefusal(action: { actionId: string; kind: string; request: unknown } | null, refusal: unknown): void {
    if (!action || !this.service.store || !this.service.config) return;
    try { this.service.store.userAction(this.service.config.identity, action, () => { throw refusal; }); }
    catch (error) {
      // A storage error, whether it was the refusal itself or the failed save, recorded nothing: resend.
      if (storageError(refusal) || storageError(error)) throw new MergeNotApplied('The merge outcome could not be saved. Try again.', { cause: error });
      // userAction re-raises the refusal once saved, or a saved outcome's refusal for this key: both are settled.
      if (error === refusal || error instanceof GuardRefusal) return;
      // Anything else (a busy or failed database) left the refusal unsaved: nothing was applied, so resend.
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
      return { status, result: { url: response.url ?? '' } };
    };
    if (saved.response.state === 'failed' || saved.response.state === 'removed')
      return Promise.reject(new Error(saved.response.reason ?? 'GitHub did not merge this pull request.'));
    // The saved outcome is committed; a failing local refresh must not turn it into a blocked merge.
    const unavailable = (error: unknown): MergeUnavailableStatus => ({ available: true, ready: false, action: null, remote: null, queue: null,
      blockers: [{ code: 'refresh', message: `Merge was submitted. Refresh to confirm GitHub state. ${error instanceof Error ? error.message : ''}`.trim() }] });
    // The status refresh may reconcile the attempt (merged URL, queue failure), so answer from the record re-read after it.
    const current = () => { try { return read()?.response ?? saved.response; } catch { return saved.response; } };
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
      const status = await this.#statusForMerge(view, signal);
      if (!status.ready) throw new Error(status.blockers[0]?.message ?? 'Merge is blocked.');
      view = this.service.load();
      if (view.token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      const finalStatus = await this.#statusForMerge(view, signal);
      if (finalStatus.remote.base !== status.remote.base || finalStatus.remote.head !== status.remote.head) throw new Error('The pull request changed during merge validation. Refresh before merging.');
      if (finalStatus.remote.mergeQueue !== status.remote.mergeQueue) throw new Error('Merge-queue requirements changed during validation. Refresh before merging.');
      if (!finalStatus.ready) throw new Error(`Merge requirements changed during validation. ${finalStatus.blockers[0]!.message}`);
      let commandStatus = finalStatus;
      let queueWatermark: string | null = null;
      if (status.remote.mergeQueue) {
        if (!queueGateway(this.gateway)) throw new Error('This GitHub adapter cannot verify the merge-queue lifecycle.');
        if (view.expected.reviewVersion === undefined) throw new Error('A current review version is required for merging.');
        queueWatermark = await this.gateway.queueWatermark(status.remote.head, { signal, timeoutMs: 6_000 });
        commandStatus = await this.#statusForMerge(view, signal);
        if (commandStatus.remote.base !== finalStatus.remote.base || commandStatus.remote.head !== finalStatus.remote.head || commandStatus.remote.mergeQueue !== finalStatus.remote.mergeQueue)
          throw new Error('Merge-queue requirements changed after queue correlation. Refresh before merging.');
        if (!commandStatus.ready) throw new Error(`Merge requirements changed after queue correlation. ${commandStatus.blockers[0]!.message}`);
      }
      if (this.service.load().token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      if (signal.aborted) throw signal.reason;
      if (this.service.store && this.service.config && view.expected.reviewVersion !== undefined) {
        const { store, config } = this.service, reviewVersion = view.expected.reviewVersion;
        const begin = () => store.beginMergeAttempt(config.identity, { ...view.expected, reviewVersion }, commandStatus.remote.head, queueWatermark,
          commandStatus.remote.mergeQueue ? 'queue' : 'direct', actionId ?? null, taskStateVersion);
        let begun: MergeAttempt | null = null;
        // The attempt and the click's saved response commit in one transaction, or neither does.
        if (action) store.userAction(config.identity, action, () => mergeActionResponse(begun = begin()));
        else begun = begin();
        // Saved meanwhile by another coordinator on this database: the catch below replays its outcome.
        if (!begun) throw new Error('This merge click was already submitted. Refresh to see its outcome.');
        queueAttempt = begun;
      }
      const result = await this.gateway.merge(commandStatus.remote.head, { signal });
      if (queueAttempt) {
        // The enqueue command has already committed externally. A local refresh failure must not
        // report that action as failed; the durable submitting record is recoverable by polling.
        try {
          if (queueAttempt.kind === 'queue') this.service.store.queueMergeAttempt(this.service.config.identity, queueAttempt.id, result.url);
          else this.service.store.finishMergeAttempt(this.service.config.identity, queueAttempt.id, { state: 'merged', url: result.url });
        } catch {}
      }
      return { status: commandStatus, result };
    } catch (error) {
      if (queueAttempt) try {
        const message = error instanceof Error ? error.message : 'GitHub merge submission outcome is unknown.';
        if (error instanceof MergeSubmissionError && error.outcome === 'refused') {
          this.service.store.finishMergeAttempt(this.service.config.identity, queueAttempt.id, {
            state: 'failed', reason: message,
            requiresFreshReview: /head (?:branch |commit )?(?:was )?(?:modified|changed)|does not match.*head|stale review/i.test(message),
          });
        } else this.service.store.recordMergeAttemptDiagnostic(this.service.config.identity, queueAttempt.id, message);
      } catch {}
      // A definite refusal before admission is this click's outcome; a resend replays it. Aborts, the deadline and
      // shutdown applied nothing for a passing reason, so the same click may be sent again.
      if (!queueAttempt && !signal.aborted && action) {
        // If another coordinator saved this click meanwhile, its outcome is the answer, not this refusal.
        const replay = this.#replay(token, action.actionId);
        if (replay) return await replay;
        this.#recordRefusal(action, error);
      }
      // Before admission an abort applied nothing, so the click may be resent (503). After admission the GitHub outcome
      // is unknown: the durable attempt stays in flight and reconciles on refresh, so report the original error.
      if (signal.aborted && !queueAttempt) throw new MergeNotApplied(signal.reason instanceof Error ? signal.reason.message : 'Merge request stopped.', { cause: signal.reason });
      // After admission only GitHub's confirmed refusal is definite (the attempt is now failed); anything else leaves
      // the attempt in flight, and the answer must say so.
      const refused = error instanceof MergeSubmissionError && error.outcome === 'refused';
      const failure = signal.aborted && signal.reason instanceof Error ? signal.reason : error;
      if (queueAttempt && !refused) throw new MergeOutcomeUnknown(failure instanceof Error ? failure.message : 'The merge outcome is unknown.', { cause: failure });
      throw failure;
    }
  }

  #statusForMerge(view: ReviewView, signal: AbortSignal): Promise<MergeStatus> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return this.status(view, true, signal);
  }

  async pollQueue(): Promise<MergeQueueStatus | null> {
    if (this.#closing) throw new Error('Merge coordinator is shutting down.');
    if (this.#queuePoll) return this.#queuePoll;
    const attempt = this.#attempt();
    if (!attempt || (attempt.state !== 'submitting' && attempt.state !== 'queued')) return this.#queueStatus(attempt);
    if (attempt.kind === 'direct') return this.#queueStatus(attempt);
    if (!queueGateway(this.gateway)) return this.#queueStatus(attempt, 'This GitHub adapter cannot verify the merge-queue lifecycle.');
    const abort = new AbortController();
    this.#queueAbort = abort;
    const poll = this.#pollQueue(attempt, abort.signal).finally(() => {
      if (this.#queuePoll === poll) this.#queuePoll = null;
      if (this.#queueAbort === abort) this.#queueAbort = null;
    });
    this.#queuePoll = poll;
    return poll;
  }

  queueSnapshot(): MergeQueueStatus | null { return this.#queueStatus(); }

  async #pollQueue(attempt: MergeAttempt, signal: AbortSignal): Promise<MergeQueueStatus | null> {
    try {
      const observation = await (this.gateway as QueueGateway).inspectQueue(attempt.reviewedHead, { signal, timeoutMs: 12_000, afterCursor: attempt.queueWatermark ?? null });
      this.#publishQueueObservation(attempt, observation);
      return this.#queueStatus();
    } catch (error) {
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

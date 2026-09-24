import type { ReviewService } from './review.ts';
import type { MergeAttempt } from './store.ts';
import { MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type MergeQueueObservation, type MergeResult, type RemoteMergeState } from '../github/merge.ts';

type ReviewView = ReturnType<ReviewService['load']>;
type QueueGateway = MergeGateway & MergeQueueGateway;
export interface MergeBlocker { code: string; message: string; }
export interface MergeQueueStatus {
  state: MergeAttempt['state']; reviewedHead: string; url: string | null; reason: string | null;
  phase: MergeAttempt['phase']; position: number | null; occurredAt: string | null; retryable: boolean;
  observationError?: string;
}
export interface MergeStatus {
  available: true; ready: boolean; action: 'merge' | 'retry' | null; blockers: MergeBlocker[];
  remote: RemoteMergeState; queue: MergeQueueStatus | null;
}
export interface MergeUnavailableStatus { available: true; ready: false; action: null; blockers: MergeBlocker[]; remote: null; queue: MergeQueueStatus | null; }

function queueGateway(gateway: MergeGateway): gateway is QueueGateway {
  return typeof (gateway as Partial<MergeQueueGateway>).inspectQueue === 'function';
}

export class MergeCoordinator {
  #active: Promise<{ status: MergeStatus; result: MergeResult }> | null = null;
  #abort: AbortController | null = null;
  #queuePoll: Promise<MergeQueueStatus | null> | null = null;
  #queueAbort: AbortController | null = null;
  #closing = false;
  readonly service: ReviewService;
  readonly gateway: MergeGateway;
  constructor(service: ReviewService, gateway: MergeGateway) { this.service = service; this.gateway = gateway; }

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
      state: attempt.state, reviewedHead: attempt.reviewedHead, url: attempt.url, reason: attempt.reason,
      phase: attempt.phase, position: attempt.position, occurredAt: attempt.occurredAt,
      retryable: (attempt.state === 'removed' || attempt.state === 'failed') && !attempt.requiresFreshReview && this.#current(attempt),
      ...(observationError ? { observationError } : {}),
    };
  }

  #freshReviewComplete(attempt: MergeAttempt): boolean {
    if (!attempt.requiresFreshReview) return true;
    const { store, config } = this.service;
    const plan = store.getPlan(config.identity), snapshot = store.getSnapshot(config.identity);
    if (snapshot.id === attempt.snapshotId) return false;
    const approvals = store.getReview(config.identity).approvals;
    return plan.items.every(item => approvals.some(approval => approval.item === item.id && approval.revision === plan.revision && approval.snapshotId === snapshot.id));
  }

  async status(view = this.service.load(), fresh = false): Promise<MergeStatus> {
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
    const remote = await this.gateway.inspect({ fresh, timeoutMs: fresh ? 6_000 : undefined });
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

    const attempt = this.#attempt(), queue = this.#queueStatus(attempt);
    if (attempt?.state === 'submitting' || attempt?.state === 'queued') {
      blockers.unshift({ code: 'queue-active', message: attempt.state === 'submitting' ? 'The reviewed head is being submitted to the merge queue.' : 'The reviewed head is queued. Waiting for GitHub to confirm the outcome.' });
    } else if (attempt?.state === 'merged') {
      blockers.unshift({ code: 'queue-merged', message: 'GitHub confirmed that the reviewed head was merged.' });
    } else if (attempt?.requiresFreshReview && !this.#freshReviewComplete(attempt)) {
      blockers.unshift({ code: 'queue-head', message: attempt.reason ?? 'The pull request head changed. Refresh and review the replacement head.' });
    }
    const active = attempt?.state === 'submitting' || attempt?.state === 'queued' || attempt?.state === 'merged';
    const retry = !!queue?.retryable;
    const ready = !active && blockers.length === 0;
    return { available: true, ready, action: ready ? (retry ? 'retry' : 'merge') : null, blockers, remote, queue };
  }

  async displayStatus(view = this.service.load()): Promise<MergeStatus | MergeUnavailableStatus> {
    try { return await this.status(view); }
    catch (error) { return { available: true, ready: false, action: null, blockers: [{ code: 'github', message: `Could not read GitHub merge state. ${error instanceof Error ? error.message : 'Unknown error.'}` }], remote: null, queue: this.#queueStatus() }; }
  }

  async merge(token: unknown): Promise<{ status: MergeStatus; result: MergeResult }> {
    if (this.#closing) throw new Error('Merge coordinator is shutting down.');
    if (this.#active) throw new Error('A merge attempt is already running.');
    if (typeof token !== 'string') throw new Error('Stale review state. Refresh before merging.');
    const abort = new AbortController();
    this.#abort = abort;
    const attempt = this.#merge(token, abort.signal).finally(() => {
      if (this.#active === attempt) this.#active = null;
      if (this.#abort === abort) this.#abort = null;
    });
    this.#active = attempt;
    return attempt;
  }

  async #merge(token: string, signal: AbortSignal): Promise<{ status: MergeStatus; result: MergeResult }> {
    let queueAttempt: MergeAttempt | null = null;
    try {
      let view = this.service.load();
      if (view.token !== token) throw new Error('Stale review state. Refresh before merging.');
      const status = await this.status(view, true);
      if (!status.ready) throw new Error(status.blockers[0]?.message ?? 'Merge is blocked.');
      view = this.service.load();
      if (view.token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      const finalStatus = await this.status(view, true);
      if (finalStatus.remote.base !== status.remote.base || finalStatus.remote.head !== status.remote.head) throw new Error('The pull request changed during merge validation. Refresh before merging.');
      if (finalStatus.remote.mergeQueue !== status.remote.mergeQueue) throw new Error('Merge-queue requirements changed during validation. Refresh before merging.');
      if (!finalStatus.ready) throw new Error(`Merge requirements changed during validation. ${finalStatus.blockers[0]!.message}`);
      if (this.service.load().token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      if (signal.aborted) throw signal.reason;
      if (status.remote.mergeQueue) {
        if (!queueGateway(this.gateway)) throw new Error('This GitHub adapter cannot verify the merge-queue lifecycle.');
        if (view.expected.reviewVersion === undefined) throw new Error('A current review version is required for merging.');
        queueAttempt = this.service.store.beginMergeAttempt(this.service.config.identity, { ...view.expected, reviewVersion: view.expected.reviewVersion }, status.remote.head);
      }
      const result = await this.gateway.merge(status.remote.head, { signal });
      if (queueAttempt) {
        // The enqueue command has already committed externally. A local refresh failure must not
        // report that action as failed; the durable submitting record is recoverable by polling.
        try { this.service.store.queueMergeAttempt(this.service.config.identity, queueAttempt.id, result.url); } catch {}
      }
      return { status, result };
    } catch (error) {
      if (queueAttempt && error instanceof MergeSubmissionError && error.outcome === 'refused') try {
        this.service.store.finishMergeAttempt(this.service.config.identity, queueAttempt.id, {
          state: 'failed', reason: error.message,
          requiresFreshReview: /head (?:branch |commit )?(?:was )?(?:modified|changed)|does not match.*head|stale review/i.test(error.message),
        });
      } catch {}
      if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
      throw error;
    }
  }

  async pollQueue(): Promise<MergeQueueStatus | null> {
    if (this.#closing) throw new Error('Merge coordinator is shutting down.');
    if (this.#queuePoll) return this.#queuePoll;
    const attempt = this.#attempt();
    if (!attempt || (attempt.state !== 'submitting' && attempt.state !== 'queued')) return this.#queueStatus(attempt);
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
      const observation = await (this.gateway as QueueGateway).inspectQueue(attempt.reviewedHead, { signal, timeoutMs: 12_000, notBefore: attempt.createdAt });
      this.#publishQueueObservation(attempt, observation);
      return this.#queueStatus();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : 'Could not read the merge queue.';
      if (/head changed after review/i.test(message)) {
        this.service.store.finishMergeAttempt(this.service.config.identity, attempt.id, { state: 'failed', reason: message, requiresFreshReview: true });
        return this.#queueStatus();
      }
      return this.#queueStatus(undefined, message);
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

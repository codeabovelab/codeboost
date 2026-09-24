import type { ReviewService } from './review.ts';
import type { MergeGateway, MergeResult, RemoteMergeState } from '../github/merge.ts';

type ReviewView = ReturnType<ReviewService['load']>;
export interface MergeBlocker { code: string; message: string; }
export interface MergeStatus { available: true; ready: boolean; blockers: MergeBlocker[]; remote: RemoteMergeState; }
export interface MergeUnavailableStatus { available: true; ready: false; blockers: MergeBlocker[]; remote: null; }

export class MergeCoordinator {
  #active: Promise<{ status: MergeStatus; result: MergeResult }> | null = null;
  #abort: AbortController | null = null;
  #closing = false;
  readonly service: ReviewService;
  readonly gateway: MergeGateway;
  constructor(service: ReviewService, gateway: MergeGateway) { this.service = service; this.gateway = gateway; }

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
    if (remote.mergeQueue) blockers.push({ code: 'merge-queue', message: 'Merge queues are not supported by this merge action yet.' });
    if (!remote.atomicBaseGuard) blockers.push({ code: 'base-guard', message: 'GitHub does not expose a server-enforced guard for the validated base.' });
    for (const check of remote.requiredChecks) if (check.state !== 'success') blockers.push({ code: 'check', message: `${check.context} is ${check.state}.` });
    if (remote.alreadyFixed === 'found') blockers.push({ code: 'already-fixed', message: 'Another open or merged pull request references this issue.' });
    if (remote.alreadyFixed === 'unknown') blockers.push({ code: 'already-fixed', message: 'The already-fixed check could not be completed.' });
    return { available: true, ready: blockers.length === 0, blockers, remote };
  }

  async displayStatus(view = this.service.load()): Promise<MergeStatus | MergeUnavailableStatus> {
    try { return await this.status(view); }
    catch (error) { return { available: true, ready: false, blockers: [{ code: 'github', message: `Could not read GitHub merge state. ${error instanceof Error ? error.message : 'Unknown error.'}` }], remote: null }; }
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
    try {
      let view = this.service.load();
      if (view.token !== token) throw new Error('Stale review state. Refresh before merging.');
      const status = await this.status(view, true);
      if (!status.ready) throw new Error(status.blockers[0]?.message ?? 'Merge is blocked.');
      view = this.service.load();
      if (view.token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      const finalStatus = await this.status(view, true);
      if (finalStatus.remote.base !== status.remote.base || finalStatus.remote.head !== status.remote.head) throw new Error('The pull request changed during merge validation. Refresh before merging.');
      if (!finalStatus.ready) throw new Error(`Merge requirements changed during validation. ${finalStatus.blockers[0]!.message}`);
      if (this.service.load().token !== token) throw new Error('Review changed during merge validation. Refresh before merging.');
      if (signal.aborted) throw signal.reason;
      const result = await this.gateway.merge(status.remote.head, { signal });
      return { status, result };
    } catch (error) {
      if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const active = this.#active;
    if (!active) return;
    this.#abort?.abort(new Error('Merge cancelled during shutdown.'));
    try { await active; } catch {}
  }
}

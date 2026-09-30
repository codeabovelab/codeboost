import { createHash } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { pullRequestBody, pullRequestTitle } from '../core/pull-request-body.ts';
import type { AlreadyFixedGateway, AlreadyFixedResult } from '../github/already-fixed.ts';
import { DraftsUnsupported, type PullRequestGateway } from '../github/pull-requests.ts';
import { GuardRefusal, MERGEABLE_STATUSES, ShuttingDownError } from './lifecycle.ts';
import type { Store, TaskPullRequest } from './store.ts';

/**
 * F2d: the pre-PR "already fixed" check and PR opening (design, "Checking whether the issue is already fixed" and
 * "Needs human"). Pushing the task head to its branch is D's export plus a runner push; until that exists it is injected.
 */
export interface BranchPusher {
  /** Makes `refs/heads/<branch>` on GitHub point at `head`. Settles only when the push finished or failed. */
  push(identity: PlanIdentity, input: { head: string; branch: string }, signal?: AbortSignal): Promise<void>;
}
export interface PublishConfig {
  repository: string; baseBranch: string;
  /** How long an opening whose outcome was lost stays owned before an empty lookup may abandon it. Default 10 minutes. */
  settleMs?: number; now?: () => number;
}
/** An earlier opening's outcome is still unknown; nothing new is opened until it settles. Retry later. */
export class OpeningUnsettled extends Error {}
export const DEFAULT_SETTLE_MS = 10 * 60_000;
export type PublishOutcome =
  /** `leftReady`: the PR opened or was updated, but could not be made a draft although its task is not in review. */
  | { kind: 'opened'; number: number; url: string; draft: boolean; status: string; leftReady?: number }
  /** `leftReady`: the task's earlier PR could not be made a draft because the repository does not support drafts. */
  | { kind: 'possibly already fixed'; result: AlreadyFixedResult; leftReady?: number }
  /** A needs-human task whose check matched: no draft PR is opened, and the task stays in needs human. */
  | { kind: 'draft skipped'; result: AlreadyFixedResult; leftReady?: number }
  /**
   * The repository does not support draft PRs, so a needs-human task gets none (a ready PR would invite review of work
   * that needs a person). `number` is the task's existing PR, left as it was, if there is one. Nothing is left in flight.
   */
  | { kind: 'draft unsupported'; number: number | null }
  /**
   * The task head is its base: there is nothing to open a PR for. A running task moves to needs human. `leftReady`: the
   * task's earlier PR could not be made a draft because the repository does not support drafts.
   */
  | { kind: 'no changes'; leftReady?: number };

const marker = (openingId: string) => `<!-- codeboost:opening=${openingId} -->`;
/**
 * Tasks with a publish in progress, per Store, shared by every publisher over that Store. One publish per task at a
 * time, so an update is never cleared or overtaken while its GitHub calls run. The runner lock rules out a second process.
 */
const publishing = new WeakMap<Store, Set<string>>();

export class PullRequestPublisher {
  #store: Store; #checks: AlreadyFixedGateway; #pulls: PullRequestGateway; #pusher: BranchPusher; #config: PublishConfig;
  /** The coordinator's `closing` flag (shutdown step 1), read before each push, opening and ready change. */
  #coordinatorClosing: () => boolean;
  #closing = false;
  /** Publishes in progress, so shutdown can abort them and await their settlement. */
  #running = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  constructor(store: Store, deps: { checks: AlreadyFixedGateway; pulls: PullRequestGateway; pusher: BranchPusher; closing?: () => boolean }, config: PublishConfig) {
    // The Store records PRs under config.repository; a gateway that calls another repository would open them elsewhere.
    for (const gateway of [deps.checks, deps.pulls]) {
      if (gateway.repository !== undefined && gateway.repository.toLowerCase() !== config.repository.toLowerCase())
        throw new Error('The publisher and its GitHub gateways must use the same repository.');
    }
    this.#store = store; this.#checks = deps.checks; this.#pulls = deps.pulls; this.#pusher = deps.pusher; this.#config = config;
    this.#coordinatorClosing = deps.closing ?? (() => false);
  }

  /**
   * Shutdown: refuse new publishes and every later push, opening or ready change, abort the publishes in progress and
   * await their settlement, so nothing is left running when the Store closes (AGENTS.md: in-flight irreversible work).
   */
  async close(): Promise<void> {
    this.#closing = true;
    const running = [...this.#running];
    for (const publish of running) publish.abort.abort(new ShuttingDownError());
    await Promise.allSettled(running.map(publish => publish.done));
  }

  /** Right before an irreversible GitHub change, with no await since (runner-lifecycle.md, "Irreversible actions"). */
  #assertOpen(): void {
    if (this.#closing || this.#coordinatorClosing()) throw new ShuttingDownError();
  }

  /**
   * The task's branch. The readable slug may collide (`Task_42` and `task-42`); the suffix, a hash of the exact task
   * identity, keeps branches of different tasks apart.
   */
  branch(identity: PlanIdentity): string {
    const plan = this.#store.getPlan(identity);
    const slug = identity.taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
    const suffix = createHash('sha256').update(identityKey(identity)).digest('hex').slice(0, 16);
    return `codeboost/issue-${plan.issue}-${slug}-${suffix}`;
  }

  /**
   * Opens the task's PR, or a draft PR with the open problems when `problems` is given (the task is in needs human).
   * Order: recover a lost opening; check; push; record the opening; open. A match or an unreadable check opens nothing.
   */
  async publish(identity: PlanIdentity, input: { problems?: readonly string[] } = {}, signal?: AbortSignal): Promise<PublishOutcome> {
    signal?.throwIfAborted();
    this.#assertOpen();
    const key = identityKey(identity);
    let inflight = publishing.get(this.#store);
    if (!inflight) publishing.set(this.#store, inflight = new Set());
    if (inflight.has(key)) throw new GuardRefusal('A pull request is already being published for this task.');
    inflight.add(key);
    const abort = new AbortController();
    const publish = { abort, done: this.#publish(identity, input, signal ? AbortSignal.any([signal, abort.signal]) : abort.signal) };
    this.#running.add(publish);
    try { return await publish.done; }
    finally { inflight.delete(key); this.#running.delete(publish); }
  }

  async #publish(identity: PlanIdentity, input: { problems?: readonly string[] }, signal?: AbortSignal): Promise<PublishOutcome> {
    const draft = input.problems !== undefined;
    const recovered = await this.#recover(identity, draft, signal);
    if (recovered) return recovered;
    const notes = await this.#draftStranded(identity, signal);
    const task = this.#store.getTask(identity), snapshot = this.#store.getSnapshot(identity), plan = this.#store.getPlan(identity);
    const reviewVersion = this.#store.reviewVersion(identity);
    // The full publish guard (status, no attempt, merge, requeue or rebase) before any GitHub call.
    try { this.#store.assertPublishableNow(identity, draft); }
    catch (error) {
      if (!(error instanceof GuardRefusal) || !notes.length) throw error;
      throw new GuardRefusal(`${error.message} ${notes.join(' ')}`);
    }
    const prs = this.#store.taskPullRequests(identity), branch = this.branch(identity);
    // The task's earlier PR (a needs-human draft, or an abandoned opening's PR that became visible later) is reused while
    // it is still open: GitHub allows one open PR per branch. It is looked up before the check, because an abandoned
    // opening's PR links the issue too and has no recorded number; the marker proves it is the task's own.
    const candidates = this.#branchRows(prs, branch, this.#config.baseBranch).filter(pr => pr.state !== 'opening');
    // Always asked, even with no known markers: an open PR on this branch that codeboost did not open is refused here,
    // before the push could move it.
    const live = await this.#pulls.findOpened({ base: this.#config.baseBranch, headBranch: branch, markers: candidates.map(pr => marker(pr.openingId)) }, signal);
    signal?.throwIfAborted();
    let earlier = live ? candidates.find(pr => marker(pr.openingId) === live.marker)! : undefined;
    // What GitHub shows is the truth for the draft flag: a draft change whose record was lost is repaired here.
    let stateVersion = task.stateVersion;
    // An abandoned opening's PR that is now visible is adopted at once, whatever the check says next, so the record
    // always names every PR the task has on GitHub (for reuse, cancel or cleanup). It does not change the task status.
    if (earlier && live && earlier.state === 'abandoned') {
      stateVersion = this.#store.adoptOpening(identity, earlier.openingId, live, { stateVersion, reviewVersion });
      earlier = { ...earlier, state: 'opened', number: live.number, url: live.url, draft: live.draft };
    }
    if (earlier && live && earlier.state === 'opened' && earlier.number === live.number && earlier.draft !== live.draft)
      stateVersion = this.#store.recordPullRequestDraft(identity, earlier.openingId, live.number, live.draft, { stateVersion, reviewVersion });
    // Checked before any GitHub change on every path: a refused publish must neither draft the PR nor move the branch.
    if (earlier && live && earlier.state === 'opened' && live.number !== earlier.number) throw new GuardRefusal('GitHub returned a different pull request for this branch.');
    // Nothing to publish: the task's PR, if it is open and ready, must not stay ready for review.
    if (snapshot.head === snapshot.base) {
      // The full publish guard (versions, snapshot, status, no attempt, merge, requeue or rebase), after the lookup's
      // await: interrupted work waiting to be requeued must not be sent to a person as "no changes".
      this.#store.assertUnchangedSince(identity, { stateVersion, reviewVersion, snapshotId: snapshot.id, draft });
      let leftReady: number | undefined;
      if (earlier && live && !live.draft) {
        try {
          const drafted = await this.#pulls.markDraft(live.number, { base: this.#config.baseBranch, headBranch: branch, marker: marker(earlier.openingId) }, signal);
          stateVersion = this.#store.recordPullRequestDraft(identity, earlier.openingId, drafted.number, drafted.draft, { stateVersion, reviewVersion });
        } catch (error) {
          if (!(error instanceof DraftsUnsupported)) throw error;
          leftReady = live.number;
          // Re-read after the refused call's await, as a successful one is by recordPullRequestDraft.
          this.#store.assertUnchangedSince(identity, { stateVersion, reviewVersion, snapshotId: snapshot.id, draft });
        }
      }
      // A cancelled publish still records a draft change that landed (above), but moves no task.
      signal?.throwIfAborted();
      if (!draft) this.#store.transitionTask(identity, stateVersion, 'needs human');
      return leftReady === undefined ? { kind: 'no changes' } : { kind: 'no changes', leftReady };
    }
    const own = new Set(prs.filter(pr => pr.number !== null && pr.repository.toLowerCase() === this.#config.repository.toLowerCase()).map(pr => pr.number!));
    if (live) own.add(live.number);
    const result = await this.#checks.check({
      issue: plan.issue, taskBase: snapshot.base, baseBranch: this.#config.baseBranch,
      ownPullRequests: [...own],
      ownCommits: new Set(this.#store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha)),
    }, signal);
    signal?.throwIfAborted();
    // A task that is not published as ready never leaves its PR ready for review: on a match its earlier ready PR becomes
    // a draft. This comes before the result is recorded, so if it fails the task is still running and a retry repeats it.
    // It is still a GitHub change for this task, so the task is re-read first: a reassignment or review during the check
    // means this publish is stale and must not touch the current generation's PR.
    const needsDraft = result.outcome !== 'clear' && earlier && live && !live.draft;
    if (needsDraft) this.#store.assertUnchangedSince(identity, { stateVersion, reviewVersion, snapshotId: snapshot.id, draft });
    let drafted = null, leftReady: number | undefined;
    if (needsDraft && earlier && live) {
      try { drafted = await this.#pulls.markDraft(live.number, { base: this.#config.baseBranch, headBranch: branch, marker: marker(earlier.openingId) }, signal); }
      catch (error) { if (!(error instanceof DraftsUnsupported)) throw error; leftReady = live.number; }
    }
    signal?.throwIfAborted();
    const check = this.#store.recordAlreadyFixed(identity, stateVersion, { snapshotId: snapshot.id, reviewVersion, draft, result });
    if (drafted && earlier!.state === 'opened') this.#store.recordPullRequestDraft(identity, earlier!.openingId, drafted.number, drafted.draft, { stateVersion: check.stateVersion, reviewVersion: check.reviewVersion });
    const ready = leftReady === undefined ? {} : { leftReady };
    if (result.outcome !== 'clear') return draft ? { kind: 'draft skipped', result, ...ready } : { kind: 'possibly already fixed', result, ...ready };
    if (earlier && live) {
      // A needs-human task's ready PR becomes a draft first, before anything else about it changes: if the repository
      // has no drafts, the refusal comes while the PR is still exactly as it was (no push, no new description).
      if (draft && !live.draft) {
        try { await this.#pulls.markDraft(live.number, { base: this.#config.baseBranch, headBranch: branch, marker: marker(earlier.openingId) }, signal); }
        catch (error) { if (error instanceof DraftsUnsupported) return { kind: 'draft unsupported', number: live.number }; throw error; }
        signal?.throwIfAborted();
      }
      // The push is a refresh's first content write (it moves the open PR's head), so the refresh is recorded before it;
      // beginRefresh re-reads the task after the draft change's await. A task change during the push cannot strand it.
      this.#assertOpen();
      const stateVersion = this.#store.beginRefresh(identity, { checkId: check.id, openingId: earlier.openingId, headSha: snapshot.head, draft });
      await this.#pusher.push(identity, { head: snapshot.head, branch }, signal);
      signal?.throwIfAborted();
      // Re-read after the push's await, before anything else about the PR changes (description, ready or draft): a
      // cancel, reassignment or review during the push leaves the update in flight and the PR as it was.
      this.#assertOpen();
      this.#store.assertRefreshCurrent(identity, earlier.openingId, draft);
      // Any failure here, including a draft refusal after the PR was made ready again meanwhile, leaves the update
      // recorded as in flight; the next publish settles it and starts again from the draft step above.
      const pr = await this.#pulls.refresh(live.number, {
        base: earlier.base, headBranch: branch, draft, ready: !draft, headSha: snapshot.head, marker: marker(earlier.openingId),
        beforeReady: () => { this.#assertOpen(); this.#store.assertRefreshCurrent(identity, earlier.openingId, draft); },
        title: pullRequestTitle(plan), body: pullRequestBody({ plan, marker: marker(earlier.openingId), problems: input.problems }),
      }, signal);
      const status = this.#store.recordRefreshConfirmed(identity, earlier.openingId, pr, { head: snapshot.head, stateVersion });
      return this.#settleHead(identity, earlier.openingId, pr, snapshot.head, draft, status, branch, signal);
    }
    // No PR exists yet, so moving the branch changes nothing a reviewer sees.
    this.#assertOpen();
    await this.#pusher.push(identity, { head: snapshot.head, branch }, signal);
    signal?.throwIfAborted();
    // The last await before the irreversible call is behind us: beginPullRequest re-reads the task state in its transaction.
    this.#assertOpen();
    const opening = this.#store.beginPullRequest(identity, {
      checkId: check.id, repository: this.#config.repository, base: this.#config.baseBranch, headBranch: branch, headSha: snapshot.head, draft,
    });
    let pr;
    try {
      pr = await this.#pulls.open({
        base: opening.base, headBranch: branch, draft, marker: marker(opening.openingId),
        title: pullRequestTitle(plan), body: pullRequestBody({ plan, marker: marker(opening.openingId), problems: input.problems }),
      }, signal);
    } catch (error) {
      if (!(error instanceof DraftsUnsupported)) throw error;
      // A definite refusal: GitHub created nothing, so the opening is dropped rather than left to settle.
      this.#store.abandonPullRequestOpening(identity, opening.openingId);
      return { kind: 'draft unsupported', number: null };
    }
    const status = this.#store.recordPullRequestOpened(identity, opening.openingId, pr);
    return this.#settleHead(identity, opening.openingId, pr, snapshot.head, draft, status, branch, signal);
  }

  /**
   * A ready PR is left ready only for a task now in review. Otherwise (GitHub shows another head than the one pushed,
   * or the task or its review changed during the call) it becomes a draft until a later publish reconciles it. The
   * open or refresh already succeeded and is recorded, so a failure here is reported as `leftReady`, not as a failure
   * of the whole publish (AGENTS.md: a later step's failure must not turn a succeeded irreversible action into one).
   */
  async #settleHead(identity: PlanIdentity, openingId: string, pr: { number: number; url: string; headSha: string; draft: boolean }, head: string,
    draft: boolean, status: string, branch: string, signal?: AbortSignal, base = this.#config.baseBranch): Promise<PublishOutcome> {
    const opened = { kind: 'opened' as const, number: pr.number, url: pr.url, draft: pr.draft, status };
    // Left ready only for a ready publish whose task is now in review at the pushed head; a draft publish's PR is always
    // a draft, whatever GitHub returned.
    if (pr.draft || (!draft && status === 'in review' && pr.headSha === head)) return opened;
    let drafted;
    // Only the GitHub call's failure becomes leftReady (the PR stays ready; the next publish reconciles it). A Store
    // failure after a draft change that landed propagates, so it is not misreported as a ready PR.
    try { drafted = await this.#pulls.markDraft(pr.number, { base, headBranch: branch, marker: marker(openingId) }, signal); }
    catch { return { ...opened, leftReady: pr.number }; }
    // A fact about the PR, recorded against the versions read right now (no await since).
    this.#store.recordPullRequestDraft(identity, openingId, drafted.number, drafted.draft,
      { stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
    return { kind: 'opened', number: drafted.number, url: drafted.url, draft: drafted.draft, status: this.#store.getTask(identity).status };
  }

  /** Whether a lost opening is the current publish's own: neither the task nor its review changed since it began, and the mode matches. */
  #isCurrent(identity: PlanIdentity, lost: TaskPullRequest, draft: boolean): boolean {
    return this.#store.getTask(identity).stateVersion === lost.ownerVersion && this.#store.reviewVersion(identity) === lost.ownerReviewVersion && lost.draft === draft;
  }

  /** The task's PR records for one branch into one base, in the configured repository. */
  #branchRows(prs: readonly TaskPullRequest[], branch: string, base: string): TaskPullRequest[] {
    return prs.filter(pr => pr.headBranch === branch && pr.base === base && pr.repository.toLowerCase() === this.#config.repository.toLowerCase());
  }

  /**
   * An opening whose GitHub outcome was lost (a crash or a timeout): adopt the PR if GitHub has it. An empty lookup
   * does not prove the request was refused while GitHub may still apply or show it, so the opening stays owned until
   * the settle time has passed; only then is it abandoned. The caller retries after OpeningUnsettled.
   */
  async #recover(identity: PlanIdentity, draft: boolean, signal?: AbortSignal): Promise<PublishOutcome | null> {
    // An update whose confirmation was lost is repeated, not adopted: its description may or may not have landed. What
    // GitHub shows now (draft flag, head) is recorded first, so a change that did land is not forgotten.
    for (const refreshing of this.#store.taskPullRequests(identity).filter(pr => pr.refresh !== null)) {
      if (refreshing.repository.toLowerCase() !== this.#config.repository.toLowerCase()) throw new GuardRefusal('A pull request update is in flight in another repository.');
      const observed = await this.#pulls.findOpened({ base: refreshing.base, headBranch: refreshing.headBranch, markers: [marker(refreshing.openingId)] }, signal);
      signal?.throwIfAborted();
      this.#store.settleUnconfirmedRefresh(identity, refreshing.openingId, observed);
    }
    // Read once: the settlements above are the only writes before this point.
    const prs = this.#store.taskPullRequests(identity);
    const lost = prs.find((pr: TaskPullRequest) => pr.state === 'opening');
    if (!lost) return null;
    if (lost.repository.toLowerCase() !== this.#config.repository.toLowerCase()) throw new GuardRefusal('A pull request was being opened in another repository.');
    const rows = this.#branchRows(prs, lost.headBranch, lost.base);
    const pr = await this.#pulls.findOpened({ base: lost.base, headBranch: lost.headBranch, markers: rows.map(row => marker(row.openingId)) }, signal);
    signal?.throwIfAborted();
    if (pr && pr.marker !== marker(lost.openingId)) {
      // The branch's open PR belongs to another of the task's openings, so this opening's request created nothing
      // (GitHub allows one open PR per branch). Drop it. If that other opening was abandoned, its PR is adopted here,
      // not only on the main path, which a task that can no longer publish never reaches.
      this.#store.abandonPullRequestOpening(identity, lost.openingId);
      const owner = rows.find(row => marker(row.openingId) === pr.marker);
      if (owner?.state === 'abandoned') {
        this.#store.adoptOpening(identity, owner.openingId, pr,
          { stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
      }
      return null;
    }
    if (!pr) {
      const age = (this.#config.now ?? Date.now)() - Date.parse(lost.createdAt);
      if (!(age >= (this.#config.settleMs ?? DEFAULT_SETTLE_MS))) throw new OpeningUnsettled('An earlier pull request opening has not settled yet. Try again later.');
      this.#store.abandonPullRequestOpening(identity, lost.openingId);
      return null;
    }
    // A lost draft opening must end as a draft: if the PR was made ready meanwhile, turn it back before confirming. Any
    // failure keeps the opening owned (the next publish retries); drafts being unsupported is definite, so the PR is
    // recorded as it is and reported.
    let found: { number: number; url: string; headSha: string; draft: boolean } = pr;
    // Only when this publish is itself a draft publish; a ready publish's main path marks the PR ready anyway.
    if (lost.draft && draft && !pr.draft) {
      try { found = await this.#pulls.markDraft(pr.number, { base: lost.base, headBranch: lost.headBranch, marker: marker(lost.openingId) }, signal); }
      catch (error) {
        if (!(error instanceof DraftsUnsupported)) throw error;
        const current = this.#isCurrent(identity, lost, draft);
        this.#store.recordPullRequestOpened(identity, lost.openingId, pr);
        return current ? { kind: 'draft unsupported', number: pr.number } : null;
      }
    }
    // The recovered opening finishes this publish only if it is this publish's own work: same task version and same
    // draft mode. Otherwise (the task was rerun, or moved between ready and needs human) the PR is recorded and this
    // publish continues, so the main path pushes the current head and refreshes the PR into the current mode.
    const current = this.#isCurrent(identity, lost, draft);
    const status = this.#store.recordPullRequestOpened(identity, lost.openingId, found);
    if (current) return this.#settleHead(identity, lost.openingId, found, lost.headSha, draft, status, lost.headBranch, signal, lost.base);
    return null;
  }

  /**
   * A task that is not in review, approved, merged, or publishable as ready (cancelled, needs human, possibly already
   * fixed, an attempt active, and so on) never keeps a ready PR: the main path may refuse on status, so nothing else
   * would draft it. Its record saying "ready" is what makes the draft owed, so an earlier draft change that failed
   * (`leftReady`) is repeated by the next publish, and a PR that recovery has just recorded is covered too. A draft flag
   * GitHub already shows is only recorded. A GitHub failure does not replace the status refusal that follows: it is
   * returned as a note for it, and the record stays "ready" so the next publish tries again.
   */
  async #draftStranded(identity: PlanIdentity, signal?: AbortSignal): Promise<string[]> {
    const status = this.#store.getTask(identity).status;
    // An approved task's PR must stay ready: GitHub does not merge a draft.
    if (MERGEABLE_STATUSES.includes(status) || status === 'merged' || this.#store.canPublish(identity, false)) return [];
    const prs = this.#store.taskPullRequests(identity), notes: string[] = [];
    const ready = prs.filter(pr => pr.state === 'opened' && !pr.draft && pr.repository.toLowerCase() === this.#config.repository.toLowerCase());
    for (const row of ready) {
      const markers = this.#branchRows(prs, row.headBranch, row.base).filter(pr => pr.state !== 'opening').map(pr => marker(pr.openingId));
      let drafted;
      try {
        const live = await this.#pulls.findOpened({ base: row.base, headBranch: row.headBranch, markers }, signal);
        // Closed or merged, or the branch's open PR is another opening's: this PR is not ready for review.
        if (!live || live.number !== row.number) continue;
        drafted = live.draft ? live : await this.#pulls.markDraft(live.number, { base: row.base, headBranch: row.headBranch, marker: marker(row.openingId) }, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        notes.push(error instanceof DraftsUnsupported
          ? `Pull request #${row.number} stays ready for review: this repository does not support draft pull requests.`
          : `Pull request #${row.number} could not be made a draft and may still be ready for review; the next publish tries again (${error instanceof Error ? error.message : String(error)}).`);
        continue;
      }
      // A fact about the PR, recorded even after a cancel, against the versions read right now (no await since).
      this.#store.recordPullRequestDraft(identity, row.openingId, drafted.number, drafted.draft,
        { stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
      signal?.throwIfAborted();
    }
    return notes;
  }
}

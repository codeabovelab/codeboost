import { createHash } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { pullRequestBody, pullRequestTitle } from '../core/pull-request-body.ts';
import type { AlreadyFixedGateway, AlreadyFixedResult } from '../github/already-fixed.ts';
import { DraftsUnsupported, PullRequestMisplaced, PullRequestRefused, type OpenedPullRequest, type PullRequestGateway } from '../github/pull-requests.ts';
import { GuardRefusal, MERGEABLE_STATUSES, ShuttingDownError } from './lifecycle.ts';
import type { Store, TaskPullRequest } from './store.ts';

/**
 * F2d: the pre-PR "already fixed" check and PR opening (design, "Checking whether the issue is already fixed" and
 * "Needs human"). The push of the task head to its branch is injected; `GitBranchPusher` (`branch-push.ts`) is the real one.
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
const pullRequestList = (prs: readonly { number: number }[]) => `Pull requests ${prs.map(pr => `#${pr.number}`).join(' and ')}`;
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

  /**
   * How long until the task's lost opening may be abandoned (0 when it may be now, null when there is none): its own
   * deadline, its creation plus the settle time, on the clock recovery uses.
   */
  settleRemaining(identity: PlanIdentity): number | null {
    const lost = this.#store.taskPullRequests(identity).find(pr => pr.state === 'opening');
    if (!lost) return null;
    return Math.max(0, Date.parse(lost.createdAt) + (this.#config.settleMs ?? DEFAULT_SETTLE_MS) - (this.#config.now ?? Date.now)());
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
    // it is still open: the branch has at most one open PR (GitHub allows one per base, and the lookup refuses one into
    // another base). It is looked up before the check, because an abandoned
    // opening's PR links the issue too and has no recorded number; the marker proves it is the task's own.
    const candidates = this.#branchRows(prs, branch).filter(pr => pr.state !== 'opening');
    // Always asked, even with no known markers: an open PR on this branch that codeboost did not open is refused here,
    // before the push could move it.
    let live;
    try {
      live = await this.#pulls.findOpened({ base: this.#config.baseBranch, headBranch: branch, markers: candidates.map(pr => marker(pr.openingId)),
        numbers: candidates.flatMap(pr => pr.number === null ? [] : [pr.number]) }, signal);
    }
    catch (error) {
      if (!(error instanceof PullRequestMisplaced)) throw error;
      // The task's PRs are not where it can publish, and a person has to decide: none of them stays ready meanwhile,
      // although the task itself could otherwise be published as ready.
      // Only this run's notes: it looks every PR up again, so an earlier run's failure it has since fixed is not reported.
      const latest = await this.#draftStranded(identity, signal, true);
      throw new PullRequestMisplaced(latest.length ? `${error.message} ${latest.join(' ')}` : error.message);
    }
    signal?.throwIfAborted();
    if (!live) {
      // GitHub's PR list can lag behind a PR: a PR recorded as opened that the list does not show is read directly, so a
      // push never moves an open PR's head with no update recorded as in flight.
      for (const row of candidates) {
        if (row.state !== 'opened' || row.number === null) continue;
        const pr = await this.#pulls.readPull(row.number, signal);
        signal?.throwIfAborted();
        if (!pr.open) continue;
        // Still on the branch, into the configured base, with its marker: only the list is behind, so a retry will do.
        if (pr.headBranch === branch && pr.base === this.#config.baseBranch && pr.marker === marker(row.openingId))
          throw new OpeningUnsettled(`Pull request #${row.number} is open, but GitHub's pull request list does not show it yet. Try again later.`);
        // Moved by a person (branch renamed, marker removed, retargeted): a retry would never see it, so a person decides.
        // Like every misplaced PR, it does not stay ready meanwhile: it is made a draft where it is, while its marker
        // still identifies it.
        let state = 'It may still be ready for review: its first line no longer identifies it.';
        // Re-read after the direct read's await: a task approved meanwhile keeps its PR ready (GitHub merges no draft).
        if (this.#mayKeepReady(identity)) state = 'It is left as it is: the task is now in review, approved or merged.';
        else if (pr.marker === marker(row.openingId)) {
          let drafted;
          try { drafted = await this.#pulls.markDraft(row.number, { base: pr.base, headBranch: pr.headBranch, marker: pr.marker }, signal); }
          catch (error) {
            if (signal?.aborted) throw error;
            state = error instanceof DraftsUnsupported ? 'It stays ready for review: this repository does not support draft pull requests.'
              : `It could not be made a draft and may still be ready for review (${error instanceof Error ? error.message : String(error)}).`;
          }
          // Only the GitHub call's failure is reported as "may still be ready"; a Store failure after a draft that landed
          // propagates. The flag is recorded only where it differs, so a retry does not move the task's version.
          if (drafted) {
            if (drafted.draft !== row.draft) this.#store.recordPullRequestDraft(identity, row.openingId, drafted.number, drafted.draft,
              { stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
            state = 'It is now a draft.';
          }
        }
        throw new PullRequestMisplaced(`The task's pull request #${row.number} is open, but no longer from ${branch} into ${this.#config.baseBranch} with its marker. Close it, or restore its branch, base and first line. ${state}`);
      }
    }
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
        // The PR's base on GitHub: the lookup only returns a PR into the configured base.
        base: this.#config.baseBranch, headBranch: branch, draft, ready: !draft, headSha: snapshot.head, marker: marker(earlier.openingId),
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
      // Definite refusals: GitHub created nothing, so the opening is dropped rather than left to settle for 10 minutes.
      if (error instanceof PullRequestRefused) { this.#store.abandonPullRequestOpening(identity, opening.openingId); throw error; }
      if (!(error instanceof DraftsUnsupported)) throw error;
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
    draft: boolean, status: string, branch: string, signal?: AbortSignal): Promise<PublishOutcome> {
    const base = this.#config.baseBranch;
    const opened = { kind: 'opened' as const, number: pr.number, url: pr.url, draft: pr.draft, status };
    // Left ready only for a ready publish whose task is now in review at the pushed head; a draft publish's PR is always
    // a draft, whatever GitHub returned.
    if (pr.draft || (!draft && status === 'in review' && pr.headSha === head)) return opened;
    let drafted;
    // Only the GitHub call's failure becomes leftReady (the PR stays ready; the next publish of a task that can still be published reconciles it). A Store
    // failure after a draft change that landed propagates, so it is not misreported as a ready PR.
    try { drafted = await this.#pulls.markDraft(pr.number, { base, headBranch: branch, marker: marker(openingId) }, signal); }
    catch (error) { if (signal?.aborted) throw error; return { ...opened, leftReady: pr.number }; }
    // A fact about the PR, recorded against the versions read right now (no await since).
    this.#store.recordPullRequestDraft(identity, openingId, drafted.number, drafted.draft,
      { stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
    return { kind: 'opened', number: drafted.number, url: drafted.url, draft: drafted.draft, status: this.#store.getTask(identity).status };
  }

  /** The task may keep a ready PR: it is in review, approved (GitHub merges no draft) or merged. Read with no await since. */
  #mayKeepReady(identity: PlanIdentity): boolean {
    const status = this.#store.getTask(identity).status;
    return MERGEABLE_STATUSES.includes(status) || status === 'merged';
  }

  /** Whether a lost opening is the current publish's own: neither the task nor its review changed since it began, and the mode matches. */
  #isCurrent(identity: PlanIdentity, lost: TaskPullRequest, draft: boolean): boolean {
    return this.#store.getTask(identity).stateVersion === lost.ownerVersion && this.#store.reviewVersion(identity) === lost.ownerReviewVersion && lost.draft === draft;
  }

  /**
   * The task's PR records for one branch, whatever their base, in the configured repository: their markers go with every
   * lookup, so the task's own PR is recognised even after the base setting changed or a person retargeted it.
   */
  #branchRows(prs: readonly TaskPullRequest[], branch: string): TaskPullRequest[] {
    return prs.filter(pr => pr.headBranch === branch && pr.repository.toLowerCase() === this.#config.repository.toLowerCase());
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
      // An observation in any base: recording what GitHub shows is safe wherever the PR is, and a refusal here would keep
      // the update in flight and stop the draft step below from running. A marker is editable text, so another PR may
      // carry it too (a copied description); the update's PR is the one with the recorded number, which cannot be edited,
      // whatever order GitHub lists them in. A copy is left to the main path and the draft step.
      const found = await this.#pulls.findOwned({ headBranch: refreshing.headBranch, markers: [marker(refreshing.openingId)] }, signal);
      signal?.throwIfAborted();
      this.#store.settleUnconfirmedRefresh(identity, refreshing.openingId, found.find(pr => pr.number === refreshing.number) ?? null);
    }
    // Read once: the settlements above are the only writes before this point.
    const prs = this.#store.taskPullRequests(identity);
    const lost = prs.find((pr: TaskPullRequest) => pr.state === 'opening');
    if (!lost) return null;
    if (lost.repository.toLowerCase() !== this.#config.repository.toLowerCase()) throw new GuardRefusal('A pull request was being opened in another repository.');
    const rows = this.#branchRows(prs, lost.headBranch);
    // The task's own PRs in any base: the lost opening's PR is recorded wherever it is now (a person may have moved it).
    const owned = await this.#pulls.findOwned({ headBranch: lost.headBranch, markers: rows.map(row => marker(row.openingId)) }, signal);
    signal?.throwIfAborted();
    const mine = owned.filter(candidate => candidate.marker === marker(lost.openingId));
    // Two PRs carrying the lost opening's marker (a copied description): no number was recorded, so which one it opened is
    // unknown, and it stays owned. Neither can be drafted safely, since one is someone else's.
    if (mine.length > 1) throw new PullRequestMisplaced(`${pullRequestList(mine)} carry the first line of a pull request the task was opening, so codeboost cannot tell which is its own. Close the one that is not (compare their authors and creation times). The task's pull request may still be ready for review.`);
    const pr = mine[0];
    const blocking = pr ? undefined : owned.find(candidate => candidate.base === lost.base);
    if (blocking) {
      // Another of the task's openings has the open PR from this branch into the base this opening asked for, so this
      // opening's request created nothing (GitHub allows one per head and base). Drop it. If that other opening was
      // abandoned, the main path (a running task) or the draft step (a stopped one) adopts its PR next.
      this.#store.abandonPullRequestOpening(identity, lost.openingId);
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
    // Re-read after the lookup's await, as before every other draft change: an approved task keeps its PR ready.
    if (lost.draft && draft && !pr.draft && !this.#mayKeepReady(identity)) {
      try { found = await this.#pulls.markDraft(pr.number, { base: pr.base, headBranch: lost.headBranch, marker: marker(lost.openingId) }, signal); }
      catch (error) {
        if (!(error instanceof DraftsUnsupported)) throw error;
        // Definite: the PR is recorded as it is, and the main path reports it (`draft unsupported`, or the misplaced
        // refusal for a PR it would not accept).
        this.#store.recordPullRequestOpened(identity, lost.openingId, pr, false);
        return null;
      }
    }
    // The recovered opening finishes this publish only if it is this publish's own work: same task version and same
    // draft mode. Otherwise (the task was rerun, or moved between ready and needs human) the PR is recorded and this
    // publish continues, so the main path pushes the current head and refreshes the PR into the current mode.
    const current = this.#isCurrent(identity, lost, draft);
    // Moving the task to in review is a change, not an observation: only for a PR the main path would accept, in the
    // configured base with no other of the task's PRs open. Any other is recorded; the main path drafts and refuses it.
    const mayReview = pr.base === this.#config.baseBranch && owned.length === 1;
    const status = this.#store.recordPullRequestOpened(identity, lost.openingId, found, mayReview);
    // It ends the publish only for a PR the main path would accept. Any other goes on to the main path, which makes all of
    // the task's PRs drafts and refuses with what a person has to do, as it does for every misplaced PR.
    if (current && mayReview) return this.#settleHead(identity, lost.openingId, found, lost.headSha, draft, status, lost.headBranch, signal);
    return null;
  }

  /**
   * A task that is not in review, approved, merged, or publishable as ready (cancelled, needs human, possibly already
   * fixed, an attempt active, and so on) never keeps a ready PR: the main path may refuse on status, so nothing else
   * would draft it. Its record saying "ready" is what makes the draft owed, so an earlier draft change that failed
   * (`leftReady`) is repeated by the next publish, and a PR that recovery has just recorded is covered too. An abandoned
   * opening's PR that has appeared since is adopted here too (AGENTS.md: a late result is adopted), because the main path,
   * which also adopts, may refuse first. A draft flag GitHub already shows is only recorded. A GitHub failure does not
   * replace the status refusal that follows: it is returned as a note for it, and the next publish tries again.
   */
  async #draftStranded(identity: PlanIdentity, signal?: AbortSignal, misplaced = false): Promise<string[]> {
    // `misplaced`: the main path found the task's PRs where it cannot publish, so being publishable keeps nothing ready.
    const keepsReady = () => this.#mayKeepReady(identity) || (!misplaced && this.#store.canPublish(identity, false));
    if (keepsReady()) return [];
    const prs = this.#store.taskPullRequests(identity), notes: string[] = [];
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
    // One lookup per branch with a PR recorded as ready, or with an abandoned opening whose PR may have appeared since.
    // A record's base is only where the PR was opened; the lookup finds the task's own PRs in any base.
    const branches = new Set<string>();
    for (const pr of prs) {
      // Misplaced PRs are all looked up: one recorded as a draft may have been made ready by the person who moved it.
      if (pr.repository.toLowerCase() === this.#config.repository.toLowerCase() && ((pr.state === 'opened' && (!pr.draft || misplaced)) || pr.state === 'abandoned'))
        branches.add(pr.headBranch);
    }
    for (const headBranch of branches) {
      const rows = this.#branchRows(prs, headBranch).filter(pr => pr.state !== 'opening');
      let owned;
      // In any base: a stopped task's PRs are drafted wherever they are (a draft is safe anywhere), all of them.
      try { owned = await this.#pulls.findOwned({ headBranch, markers: rows.map(row => marker(row.openingId)) }, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        notes.push(`The open pull requests from ${headBranch} could not be looked up, so one of this task's pull requests may still be ready for review; the next publish tries again (${reason(error)}).`);
        continue;
      }
      signal?.throwIfAborted();
      for (const live of owned) {
        const row = rows.find(candidate => marker(candidate.openingId) === live.marker);
        // Not the one recorded for its opening: nothing known is ready for review here.
        if (!row || (row.state === 'opened' && row.number !== live.number)) continue;
        // Versions read right now, with no await since: recording what GitHub shows is a fact, even after a cancel.
        const current = () => ({ stateVersion: this.#store.getTask(identity).stateVersion, reviewVersion: this.#store.reviewVersion(identity) });
        if (row.state === 'abandoned') this.#store.adoptOpening(identity, row.openingId, live, current());
        let drafted: { number: number; draft: boolean } = live;
        // Re-read after the lookup's await: a task that was approved meanwhile keeps its PR ready.
        if (!live.draft && !keepsReady()) {
          try { drafted = await this.#pulls.markDraft(live.number, { base: live.base, headBranch, marker: live.marker }, signal); }
          catch (error) {
            if (signal?.aborted) throw error;
            notes.push(error instanceof DraftsUnsupported
              ? `Pull request #${live.number} stays ready for review: this repository does not support draft pull requests.`
              : `Pull request #${live.number} could not be made a draft and may still be ready for review; the next publish tries again (${reason(error)}).`);
            continue;
          }
        }
        // The record is corrected only where it differs: the draft change just made, or one GitHub already shows.
        const recorded = row.state === 'abandoned' ? live.draft : row.draft;
        if (drafted.draft !== recorded) this.#store.recordPullRequestDraft(identity, row.openingId, drafted.number, drafted.draft, current());
        signal?.throwIfAborted();
      }
    }
    return notes;
  }
}

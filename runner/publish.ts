import { createHash } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { pullRequestBody, pullRequestTitle } from '../core/pull-request-body.ts';
import type { AlreadyFixedGateway, AlreadyFixedResult } from '../github/already-fixed.ts';
import { DraftsUnsupported, type PullRequestGateway } from '../github/pull-requests.ts';
import { GuardRefusal } from './lifecycle.ts';
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
  | { kind: 'opened'; number: number; url: string; draft: boolean; status: string }
  /** `leftReady`: the task's earlier PR could not be made a draft because the repository does not support drafts. */
  | { kind: 'possibly already fixed'; result: AlreadyFixedResult; leftReady?: number }
  /** A needs-human task whose check matched: no draft PR is opened, and the task stays in needs human. */
  | { kind: 'draft skipped'; result: AlreadyFixedResult; leftReady?: number }
  /**
   * The repository does not support draft PRs, so a needs-human task gets none (a ready PR would invite review of work
   * that needs a person). `number` is the task's existing PR, left as it was, if there is one. Nothing is left in flight.
   */
  | { kind: 'draft unsupported'; number: number | null }
  /** The task head is its base: there is nothing to open a PR for. A running task moves to needs human. */
  | { kind: 'no changes' };

const marker = (openingId: string) => `<!-- codeboost:opening=${openingId} -->`;
/**
 * Tasks with a publish in progress, per Store, shared by every publisher over that Store. One publish per task at a
 * time, so an update is never cleared or overtaken while its GitHub calls run. The runner lock rules out a second process.
 */
const publishing = new WeakMap<Store, Set<string>>();

export class PullRequestPublisher {
  #store: Store; #checks: AlreadyFixedGateway; #pulls: PullRequestGateway; #pusher: BranchPusher; #config: PublishConfig;
  constructor(store: Store, deps: { checks: AlreadyFixedGateway; pulls: PullRequestGateway; pusher: BranchPusher }, config: PublishConfig) {
    this.#store = store; this.#checks = deps.checks; this.#pulls = deps.pulls; this.#pusher = deps.pusher; this.#config = config;
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
    const key = identityKey(identity);
    let inflight = publishing.get(this.#store);
    if (!inflight) publishing.set(this.#store, inflight = new Set());
    if (inflight.has(key)) throw new GuardRefusal('A pull request is already being published for this task.');
    inflight.add(key);
    try { return await this.#publish(identity, input, signal); }
    finally { inflight.delete(key); }
  }

  async #publish(identity: PlanIdentity, input: { problems?: readonly string[] }, signal?: AbortSignal): Promise<PublishOutcome> {
    const draft = input.problems !== undefined;
    const recovered = await this.#recover(identity, signal);
    if (recovered) return recovered;
    const task = this.#store.getTask(identity), snapshot = this.#store.getSnapshot(identity), plan = this.#store.getPlan(identity);
    const reviewVersion = this.#store.reviewVersion(identity);
    if (task.status !== (draft ? 'needs human' : 'running')) throw new GuardRefusal(`A ${draft ? 'draft ' : ''}pull request cannot be opened while the task is ${task.status}.`);
    if (snapshot.head === snapshot.base) {
      if (!draft) this.#store.transitionTask(identity, task.stateVersion, 'needs human');
      return { kind: 'no changes' };
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
    const earlier = live ? candidates.find(pr => marker(pr.openingId) === live.marker)! : undefined;
    // What GitHub shows is the truth for the draft flag: a draft change whose record was lost is repaired here.
    let stateVersion = task.stateVersion;
    if (earlier && live && earlier.state === 'opened' && earlier.number === live.number && earlier.draft !== live.draft)
      stateVersion = this.#store.recordPullRequestDraft(identity, earlier.openingId, live.number, live.draft, stateVersion);
    const own = new Set(prs.filter(pr => pr.number !== null && pr.repository.toLowerCase() === this.#config.repository.toLowerCase()).map(pr => pr.number!));
    if (live) own.add(live.number);
    const result = await this.#checks.check({
      issue: plan.issue, taskBase: snapshot.base, baseBranch: this.#config.baseBranch,
      ownPullRequests: [...own],
      ownCommits: new Set(this.#store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha)),
    }, signal);
    signal?.throwIfAborted();
    // Checked before any GitHub change: a refused publish must neither draft the PR nor move the branch.
    if (earlier && live && earlier.state === 'opened' && live.number !== earlier.number) throw new GuardRefusal('GitHub returned a different pull request for this branch.');
    // A task that is not published as ready never leaves its PR ready for review: on a match its earlier ready PR becomes
    // a draft. This comes before the result is recorded, so if it fails the task is still running and a retry repeats it.
    // It is still a GitHub change for this task, so the task is re-read first: a reassignment or review during the check
    // means this publish is stale and must not touch the current generation's PR.
    const needsDraft = result.outcome !== 'clear' && earlier && live && !live.draft;
    if (needsDraft) this.#store.assertUnchangedSince(identity, { stateVersion, reviewVersion, snapshotId: snapshot.id, draft });
    let drafted = null, leftReady: number | undefined;
    if (needsDraft) {
      try { drafted = await this.#pulls.markDraft(live.number, { base: this.#config.baseBranch, headBranch: branch, marker: marker(earlier.openingId) }, signal); }
      catch (error) { if (!(error instanceof DraftsUnsupported)) throw error; leftReady = live.number; }
    }
    signal?.throwIfAborted();
    const check = this.#store.recordAlreadyFixed(identity, stateVersion, { snapshotId: snapshot.id, draft, result });
    if (drafted && earlier!.state === 'opened') this.#store.recordPullRequestDraft(identity, earlier!.openingId, drafted.number, drafted.draft, check.stateVersion);
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
      const stateVersion = this.#store.beginRefresh(identity, { checkId: check.id, openingId: earlier.openingId, headSha: snapshot.head, draft,
        ...(earlier.state === 'abandoned' ? { adopt: { number: live.number, url: live.url } } : {}) });
      await this.#pusher.push(identity, { head: snapshot.head, branch }, signal);
      signal?.throwIfAborted();
      // Any failure here, including a draft refusal after the PR was made ready again meanwhile, leaves the update
      // recorded as in flight; the next publish drops it and starts again from the draft step above.
      const pr = await this.#pulls.refresh(live.number, {
        base: earlier.base, headBranch: branch, draft, ready: !draft, headSha: snapshot.head, marker: marker(earlier.openingId),
        title: pullRequestTitle(plan), body: pullRequestBody({ plan, marker: marker(earlier.openingId), problems: input.problems }),
      }, signal);
      const status = this.#store.recordRefreshConfirmed(identity, earlier.openingId, pr, { head: snapshot.head, stateVersion });
      return { kind: 'opened', number: pr.number, url: pr.url, draft: pr.draft, status };
    }
    // No PR exists yet, so moving the branch changes nothing a reviewer sees.
    await this.#pusher.push(identity, { head: snapshot.head, branch }, signal);
    signal?.throwIfAborted();
    // The last await before the irreversible call is behind us: beginPullRequest re-reads the task state in its transaction.
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
    return { kind: 'opened', number: pr.number, url: pr.url, draft: pr.draft, status };
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
  async #recover(identity: PlanIdentity, signal?: AbortSignal): Promise<PublishOutcome | null> {
    // An update whose confirmation was lost is repeated, not adopted: its description may or may not have landed.
    const refreshing = this.#store.taskPullRequests(identity).find(pr => pr.refresh !== null);
    if (refreshing) this.#store.abandonRefresh(identity, refreshing.openingId);
    // Read once: abandonRefresh above is the only write before this point.
    const prs = this.#store.taskPullRequests(identity);
    const lost = prs.find((pr: TaskPullRequest) => pr.state === 'opening');
    if (!lost) return null;
    if (lost.repository.toLowerCase() !== this.#config.repository.toLowerCase()) throw new GuardRefusal('A pull request was being opened in another repository.');
    const rows = this.#branchRows(prs, lost.headBranch, lost.base);
    const pr = await this.#pulls.findOpened({ base: lost.base, headBranch: lost.headBranch, markers: rows.map(row => marker(row.openingId)) }, signal);
    signal?.throwIfAborted();
    if (pr && pr.marker !== marker(lost.openingId)) {
      // The branch's open PR belongs to another of the task's openings, so this opening's request created nothing
      // (GitHub allows one open PR per branch). Drop it; the main path reuses, or adopts, the PR that is there.
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
    if (lost.draft && !pr.draft) {
      try { found = await this.#pulls.markDraft(pr.number, { base: lost.base, headBranch: lost.headBranch, marker: marker(lost.openingId) }, signal); }
      catch (error) {
        if (!(error instanceof DraftsUnsupported)) throw error;
        this.#store.recordPullRequestOpened(identity, lost.openingId, pr);
        return { kind: 'draft unsupported', number: pr.number };
      }
    }
    const status = this.#store.recordPullRequestOpened(identity, lost.openingId, found);
    return { kind: 'opened', number: found.number, url: found.url, draft: found.draft, status };
  }
}

import { createHash } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { pullRequestBody, pullRequestTitle } from '../core/pull-request-body.ts';
import type { AlreadyFixedGateway, AlreadyFixedResult } from '../github/already-fixed.ts';
import type { PullRequestGateway } from '../github/pull-requests.ts';
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
  | { kind: 'possibly already fixed'; result: AlreadyFixedResult }
  /** A needs-human task whose check matched: no draft PR is opened, and the task stays in needs human. */
  | { kind: 'draft skipped'; result: AlreadyFixedResult }
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
    const live = candidates.length ? await this.#pulls.findOpened({ base: this.#config.baseBranch, headBranch: branch, markers: candidates.map(pr => marker(pr.openingId)) }, signal) : null;
    signal?.throwIfAborted();
    const earlier = live ? candidates.find(pr => marker(pr.openingId) === live.marker)! : undefined;
    const own = new Set(prs.filter(pr => pr.number !== null && pr.repository.toLowerCase() === this.#config.repository.toLowerCase()).map(pr => pr.number!));
    if (live) own.add(live.number);
    const result = await this.#checks.check({
      issue: plan.issue, taskBase: snapshot.base, baseBranch: this.#config.baseBranch,
      ownPullRequests: [...own],
      ownCommits: new Set(this.#store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha)),
    }, signal);
    signal?.throwIfAborted();
    const check = this.#store.recordAlreadyFixed(identity, task.stateVersion, { snapshotId: snapshot.id, draft, result });
    if (result.outcome !== 'clear') return draft ? { kind: 'draft skipped', result } : { kind: 'possibly already fixed', result };
    // Checked before the push: a refused publish must not move the branch.
    if (earlier && live && earlier.state === 'opened' && live.number !== earlier.number) throw new GuardRefusal('GitHub returned a different pull request for this branch.');
    // No await since recordAlreadyFixed, whose transaction re-read the task: the push follows it directly.
    await this.#pusher.push(identity, { head: snapshot.head, branch }, signal);
    signal?.throwIfAborted();
    if (earlier && live) {
      const stateVersion = this.#store.beginRefresh(identity, { checkId: check.id, openingId: earlier.openingId, headSha: snapshot.head, draft,
        ...(earlier.state === 'abandoned' ? { adopt: { number: live.number, url: live.url } } : {}) });
      const pr = await this.#pulls.refresh(live.number, {
        base: earlier.base, headBranch: branch, draft, ready: !draft, marker: marker(earlier.openingId),
        title: pullRequestTitle(plan), body: pullRequestBody({ plan, marker: marker(earlier.openingId), problems: input.problems }),
      }, signal);
      const status = this.#store.recordPullRequestOpened(identity, earlier.openingId, pr, { head: snapshot.head, stateVersion });
      return { kind: 'opened', number: pr.number, url: pr.url, draft: pr.draft, status };
    }
    // The last await before the irreversible call is behind us: beginPullRequest re-reads the task state in its transaction.
    const opening = this.#store.beginPullRequest(identity, {
      checkId: check.id, repository: this.#config.repository, base: this.#config.baseBranch, headBranch: branch, headSha: snapshot.head, draft,
    });
    const pr = await this.#pulls.open({
      base: opening.base, headBranch: branch, draft, marker: marker(opening.openingId),
      title: pullRequestTitle(plan), body: pullRequestBody({ plan, marker: marker(opening.openingId), problems: input.problems }),
    }, signal);
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
    const lost = this.#store.taskPullRequests(identity).find((pr: TaskPullRequest) => pr.state === 'opening');
    if (!lost) return null;
    if (lost.repository.toLowerCase() !== this.#config.repository.toLowerCase()) throw new GuardRefusal('A pull request was being opened in another repository.');
    const rows = this.#branchRows(this.#store.taskPullRequests(identity), lost.headBranch, lost.base);
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
    const status = this.#store.recordPullRequestOpened(identity, lost.openingId, pr);
    return { kind: 'opened', number: pr.number, url: pr.url, draft: pr.draft, status };
  }
}

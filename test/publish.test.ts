import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { OpeningUnsettled, PullRequestPublisher, type BranchPusher, type PublishConfig } from '../runner/publish.ts';
import { GH_ENV_ALLOWLIST, ghEnvironment } from '../github/gh-env.ts';
import { runWithInput } from '../github/run-with-input.ts';
import { DraftsUnsupported, GhPullRequestGateway, type OpenPullRequestInput, type OpenedPullRequest, type PullRequestGateway } from '../github/pull-requests.ts';
import type { AlreadyFixedGateway, AlreadyFixedInput, AlreadyFixedResult } from '../github/already-fixed.ts';
import { fenced, neutralizeReferences, pullRequestBody, pullRequestTitle, MAX_BODY } from '../core/pull-request-body.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 'repo', taskId: 'Task_42', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 12, revision: 1, summary: 'Stop the crash', questions: [], items: [
  { id: 'P1', title: 'Guard input', intent: 'Reject empty input', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'Check it' }], acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] }] };
const context: PlanContext = { identity, issue: 12, baseEntries: [{ path: 'a.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [['npm', 'test']] };
const config: PublishConfig = { repository: 'owner/repo', baseBranch: 'main' };
const BRANCH = /^codeboost\/issue-12-task-42-[0-9a-f]{16}$/;

/** A task whose last attempt settled while it runs, with head `oid(2)` over base `oid(1)` and one owned commit. */
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function runningTask(options: { head?: string } = {}) {
  const store = new Store(':memory:');
  stores.push(store);
  const head = options.head ?? oid(2);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), head);
  if (head !== oid(1)) store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
  store.markRunning(identity, attempt.id);
  store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
  expect(store.getTask(identity).status).toBe('running');
  return store;
}

/** `live` is GitHub's set of open PRs by marker; share it between harnesses to model later runs of the same task. */
function harness(store: Store, options: { results?: AlreadyFixedResult[]; open?: (input: OpenPullRequestInput) => Promise<OpenedPullRequest>; found?: OpenedPullRequest | null;
  push?: BranchPusher['push']; live?: Map<string, OpenedPullRequest>; next?: { value: number }; config?: Partial<PublishConfig>; draftAfterRefresh?: boolean;
  onFind?: () => void; refreshFails?: boolean; closed?: Set<number>; hidden?: Set<string>; openTimesOut?: boolean; draftFails?: boolean; draftsUnsupported?: boolean; onDraft?: () => void; onRefresh?: () => void } = {}) {
  const live = options.live ?? new Map<string, OpenedPullRequest>(), counter = options.next ?? { value: 100 }, closed = options.closed ?? new Set<number>();
  const log: string[] = [], checks: AlreadyFixedInput[] = [], opened: OpenPullRequestInput[] = [];
  const results = options.results ? [...options.results] : [];
  // Like GitHub, the default check reports every visible open PR on the branch (it links the issue) unless it is listed as own.
  const gate: AlreadyFixedGateway = { async check(input) {
    log.push('check'); checks.push(input);
    if (options.results) return results.shift() ?? { outcome: 'clear', baseHead: oid(9) };
    const foreign = [...live].filter(([m, pr]) => !closed.has(pr.number) && !options.hidden?.has(m) && !input.ownPullRequests.includes(pr.number));
    return foreign.length ? { outcome: 'found', baseHead: oid(9), matches: foreign.map(([, pr]) => ({ kind: 'pull request' as const, repository: 'owner/repo', number: pr.number, state: 'OPEN' as const, draft: pr.draft })) }
      : { outcome: 'clear', baseHead: oid(9) };
  } };
  const pulls: PullRequestGateway = {
    async open(input) {
      log.push(`open ${input.draft ? 'draft' : 'ready'}`); opened.push(input);
      if (options.open) return options.open(input);
      if (options.draftsUnsupported && input.draft) throw new DraftsUnsupported('no drafts');
      // Like GitHub: one open PR per branch.
      if ([...live].some(([, pr]) => !closed.has(pr.number))) throw new Error('HTTP 422: A pull request already exists.');
      const pr = { number: counter.value++, url: 'https://github.com/owner/repo/pull/1', headSha: store.getSnapshot(identity).head, draft: input.draft };
      live.set(input.marker, pr);
      if (options.openTimesOut) throw new Error('timeout');
      return pr;
    },
    async findOpened(input) {
      log.push(`find ${input.markers.join(' ')}`); options.onFind?.();
      if (options.found !== undefined) return options.found && { ...options.found, marker: input.markers.at(-1)! };
      // GitHub shows at most one open PR per branch; find it among every live PR, then match its marker.
      const open = [...live].find(([m, pr]) => !closed.has(pr.number) && !options.hidden?.has(m));
      if (!open) return null;
      if (!input.markers.includes(open[0])) throw new Error('An open pull request exists that codeboost did not open.');
      return { ...open[1], marker: open[0] };
    },
    async markDraft(number, input) {
      log.push(`draft ${number}`);
      options.onDraft?.();
      if (options.draftsUnsupported) throw new DraftsUnsupported('no drafts');
      if (options.draftFails) throw new Error('timeout marking the PR a draft');
      const pr = { ...live.get(input.marker)!, draft: true }; live.set(input.marker, pr); return pr;
    },
    async refresh(number, input) {
      log.push(`refresh ${number} ${input.ready ? 'ready' : 'draft'}`); opened.push(input);
      options.onRefresh?.();
      if (options.refreshFails) throw new Error('timeout reading the PR back');
      if (options.draftsUnsupported && input.draft) throw new DraftsUnsupported('no drafts');
      const pr = { ...live.get(input.marker)!, draft: options.draftAfterRefresh ?? input.draft, headSha: store.getSnapshot(identity).head };
      live.set(input.marker, pr); return pr;
    },
  };
  const pusher: BranchPusher = { async push(id, input, signal) { log.push(`push ${input.branch.replace(/-[0-9a-f]{16}$/, '')} ${input.head.slice(-3)}`); await options.push?.(id, input, signal); } };
  return { log, checks, opened, pulls, publisher: new PullRequestPublisher(store, { checks: gate, pulls, pusher }, { ...config, ...options.config }) };
}

describe('opening the task PR', () => {
  it('checks, pushes, then opens the PR and moves the task to in review', async () => {
    const store = runningTask();
    const { publisher, log, checks, opened } = harness(store);
    const outcome = await publisher.publish(identity);
    expect(outcome).toMatchObject({ kind: 'opened', number: 100, draft: false, status: 'in review' });
    expect(log).toEqual(['find ', 'check', 'push codeboost/issue-12-task-42 002', 'open ready']);
    expect(checks[0]).toMatchObject({ issue: 12, taskBase: oid(1), baseBranch: 'main', ownPullRequests: [] });
    expect([...checks[0]!.ownCommits]).toEqual([oid(2)]);
    expect(opened[0]).toMatchObject({ base: 'main', headBranch: expect.stringMatching(BRANCH), title: 'Stop the crash (#12)' });
    expect(opened[0]!.body).toContain(opened[0]!.marker);
    expect(store.getTask(identity).status).toBe('in review');
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100, headSha: oid(2), draft: false }]);
    expect(store.latestAlreadyFixed(identity)).toMatchObject({ result: { outcome: 'clear' } });
  });
  it('opens nothing and moves to possibly already fixed on a match', async () => {
    const store = runningTask();
    const result: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'pull request', repository: 'owner/repo', number: 401, state: 'OPEN', draft: false }] };
    const { publisher, log } = harness(store, { results: [result] });
    expect(await publisher.publish(identity)).toEqual({ kind: 'possibly already fixed', result });
    expect(log).toEqual(['find ', 'check']);
    expect(store.getTask(identity).status).toBe('possibly already fixed');
    expect(store.taskPullRequests(identity)).toEqual([]);
    expect(store.latestAlreadyFixed(identity)!.result).toEqual(result);
  });
  it('fails closed: a check that could not be completed also opens nothing', async () => {
    const store = runningTask();
    const { publisher, log } = harness(store, { results: [{ outcome: 'unknown', reason: 'GitHub could not be read.' }] });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(log).toEqual(['find ', 'check']);
    expect(store.getTask(identity).status).toBe('possibly already fixed');
  });
  it('opens a draft PR with the open problems for a needs-human task, and keeps it in needs human', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const { publisher, opened } = harness(store);
    expect(await publisher.publish(identity, { problems: ['Review round 3: @someone Fixes #99 still fails'] })).toMatchObject({ kind: 'opened', draft: true, status: 'needs human' });
    expect(opened[0]).toMatchObject({ draft: true });
    expect(opened[0]!.body).toMatch(/```text\nReview round 3: @someone Fixes ＃99 still fails\n```/);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('skips the draft on a match and leaves the task in needs human', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const { publisher, log } = harness(store, { results: [{ outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] }] });
    expect(await publisher.publish(identity, { problems: ['x'] })).toMatchObject({ kind: 'draft skipped' });
    expect(log).toEqual(['find ', 'check']);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('opens no PR when the task changed nothing, and moves it to needs human', async () => {
    const store = runningTask({ head: oid(1) });
    const { publisher, log } = harness(store);
    expect(await publisher.publish(identity)).toEqual({ kind: 'no changes' });
    // The branch is looked up first (a foreign PR there would be refused); nothing is checked, pushed or opened.
    expect(log).toEqual(['find ']);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('turns the earlier ready PR into a draft when a rerun changes nothing', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    // The task is sent back, reruns, and its head goes back to its base.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    store.markRunning(identity, attempt.id);
    store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
    store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(1), []);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toEqual({ kind: 'no changes' });
    expect(again.log).toContain('draft 100');
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: true }]);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('refuses to open when the task changed after the check (a cancel during the push)', async () => {
    const store = runningTask();
    const { publisher, log } = harness(store, { push: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human'); } });
    await expect(publisher.publish(identity)).rejects.toThrow(GuardRefusal);
    expect(log).not.toContain('open ready');
    expect(store.taskPullRequests(identity)).toEqual([]);
  });
  it('refuses to open when anything else about the task changed after the check, such as its assignment', async () => {
    const store = runningTask();
    const { publisher, log } = harness(store, { push: async () => { store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code'); } });
    await expect(publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(log).not.toContain('open ready');
    expect(store.getTask(identity).status).toBe('running');
  });
  it('refuses to open the PR when a review note is added during the push', async () => {
    const store = runningTask();
    const { publisher, log } = harness(store, { push: async () => {
      store.addReviewNote(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, 'P1', 'question', 'Why this file?');
    } });
    await expect(publisher.publish(identity)).rejects.toThrow(/review changed/);
    expect(log.some(line => line.startsWith('open'))).toBe(false);
    expect(store.taskPullRequests(identity)).toEqual([]);
  });
  it('refuses a PR on the branch that codeboost did not open before pushing, even when the task has no PR records', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>();
    live.set('<!-- someone else -->', { number: 77, url: 'https://github.com/owner/repo/pull/77', headSha: oid(8), draft: false });
    const { publisher, log } = harness(store, { live });
    await expect(publisher.publish(identity)).rejects.toThrow(/did not open/);
    expect(log.some(line => line.startsWith('push') || line.startsWith('open'))).toBe(false);
  });
  it('refuses to open when the head moved during the check', async () => {
    const store = runningTask();
    const gate: AlreadyFixedGateway = { async check() {
      store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(3), [{ sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null }]);
      return { outcome: 'clear', baseHead: oid(9) };
    } };
    const opened: string[] = [];
    const publisher = new PullRequestPublisher(store, { checks: gate, pusher: { async push() {} },
      pulls: { async open() { opened.push('open'); throw new Error('unreachable'); }, async findOpened() { return null; }, async refresh() { throw new Error('unreachable'); }, async markDraft() { throw new Error('unreachable'); } } }, config);
    await expect(publisher.publish(identity)).rejects.toThrow(GuardRefusal);
    expect(opened).toEqual([]);
  });
  it('refuses to publish a task that is not running', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    await expect(harness(store).publisher.publish(identity)).rejects.toThrow(/cannot be opened while the task is queued/);
  });
  it('keeps the branches of tasks whose IDs normalize alike apart', () => {
    const store = runningTask();
    const other = { ...identity, taskId: 'task-42' };
    store.createPlan(JSON.stringify(plan), 'json', { ...context, identity: other }, oid(1), oid(2));
    const publisher = harness(store).publisher;
    expect(publisher.branch(identity)).toMatch(BRANCH);
    expect(publisher.branch(other)).not.toBe(publisher.branch(identity));
    expect(publisher.branch(other)).toMatch(BRANCH);
  });
  it('checks the task status before the no-changes shortcut', async () => {
    const queuedTask = runningTask({ head: oid(1) });
    queuedTask.transitionTask(identity, queuedTask.getTask(identity).stateVersion, 'queued');
    await expect(harness(queuedTask).publisher.publish(identity)).rejects.toThrow(/while the task is queued/);
    expect(queuedTask.getTask(identity).status).toBe('queued');
    const cancelled = runningTask({ head: oid(1) });
    cancelled.cancelTask(identity, cancelled.getTask(identity).stateVersion, crypto.randomUUID());
    await expect(harness(cancelled).publisher.publish(identity, { problems: ['x'] })).rejects.toThrow(/while the task is cancelled/);
  });
  it('records a PR whose response arrives after the task changed, without letting it move the task', async () => {
    const store = runningTask();
    const { publisher } = harness(store, { open: async input => {
      store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code');
      return { number: 6, url: 'https://github.com/owner/repo/pull/6', headSha: oid(2), draft: input.draft };
    } });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 6, status: 'running' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 6 }]);
  });
  it('keeps the task running and makes the PR a draft when GitHub shows another head than the one pushed', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>();
    const { publisher, log } = harness(store, { live, open: async input => {
      const pr = { number: 5, url: 'https://github.com/owner/repo/pull/5', headSha: oid(77), draft: input.draft };
      live.set(input.marker, pr); return pr;
    } });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 5, draft: true, status: 'running' });
    expect(log.at(-1)).toBe('draft 5');
    // The record keeps the head GitHub reported, not the head that was pushed.
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 5, draft: true, headSha: oid(77) }]);
    expect(store.getTask(identity).status).toBe('running');
  });
});

describe('schema v7', () => {
  it('upgrades a populated v6 database: adds the check and PR tables, keeps the tasks', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'codeboost-v7-')), path = join(dir, 'state.sqlite');
    try {
      const first = new Store(path);
      first.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
      first.transitionTask(identity, first.getTask(identity).stateVersion, 'queued');
      const before = first.getTask(identity);
      first.close();
      const legacy = new DatabaseSync(path);
      legacy.exec('DROP TABLE task_pull_requests; DROP TABLE already_fixed_checks; PRAGMA user_version=6;');
      legacy.close();
      const upgraded = new Store(path);
      stores.push(upgraded);
      expect(upgraded.getTask(identity)).toMatchObject({ status: 'queued', stateVersion: before.stateVersion });
      expect(upgraded.taskPullRequests(identity)).toEqual([]);
      expect(upgraded.latestAlreadyFixed(identity)).toBeNull();
      const db = new DatabaseSync(path, { readOnly: true });
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND (name LIKE '%pull_requests%' OR name='already_fixed_checks') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all().map(row => row.name);
      expect(names).toEqual(['already_fixed_checks', 'task_pull_requests', 'task_pull_requests_number', 'task_pull_requests_opening']);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review changes during GitHub calls', () => {
  const note = (store: Store) => store.addReviewNote(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, 'P1', 'question', 'Why this file?');
  it('refuses to record a matching check when the review changed during the draft change', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    await expect(harness(store, { live, next, results: [found], onDraft: () => note(store) }).publisher.publish(identity)).rejects.toThrow(/review changed/);
    expect(store.getTask(identity).status).toBe('running');
  });
  it('records a PR opened while the review changed, but does not move the task to in review', async () => {
    const store = runningTask();
    const { publisher } = harness(store, { open: async input => { note(store); return { number: 5, url: 'https://github.com/owner/repo/pull/5', headSha: oid(2), draft: input.draft }; } });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 5, status: 'running' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 5 }]);
  });
  it('records a refresh that landed while the review changed, but does not move the task to in review', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    expect(await harness(store, { live, next, onRefresh: () => note(store) }).publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, status: 'running' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, refresh: null, headSha: oid(3) }]);
  });
  it('does not end a publish with a recovered opening whose review has changed since', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    note(store);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, status: 'in review' });
    // The recovered opening was recorded, then publishing continued: a new check and a refresh under current review state.
    expect(again.log).toContain('check');
    expect(again.log.at(-1)).toBe('refresh 100 ready');
  });
});

describe('guards found by the independent review', () => {
  const note = (store: Store) => store.addReviewNote(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, 'P1', 'question', 'Why this file?');
  const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
  it('does not draft the PR when the review changed during the check', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    const gate = harness(store, { live, next });
    const publisher = new PullRequestPublisher(store, { checks: { async check() { note(store); return found; } }, pulls: gate.pulls, pusher: { async push() {} } }, config);
    await expect(publisher.publish(identity)).rejects.toThrow(/review changed/);
    expect(gate.log.some(line => line.startsWith('draft'))).toBe(false);
  });
  it('does not update the PR when the review changed during the push', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    const again = harness(store, { live, next, push: async () => { note(store); } });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/review changed/);
    expect(again.log.some(line => line.startsWith('refresh'))).toBe(false);
  });
  it('does not adopt or repair records when the review changed during the lookup', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    for (const [m, pr] of live) live.set(m, { ...pr, draft: true });
    rerun(store);
    await expect(harness(store, { live, next, onFind: () => note(store) }).publisher.publish(identity)).rejects.toThrow(/review changed/);
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: false }]);
  });
  it('records what GitHub shows for an update whose confirmation was lost, then settles it', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    // The ready update lands on GitHub, but its read-back fails.
    await expect(harness(store, { live, next, refreshFails: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    for (const [m, pr] of live) live.set(m, { ...pr, draft: false, headSha: oid(3) });
    // Then the task is cancelled: the next publish refuses on status, but first records what GitHub shows.
    store.cancelTask(identity, store.getTask(identity).stateVersion, crypto.randomUUID());
    await expect(harness(store, { live, next }).publisher.publish(identity)).rejects.toThrow(/cancelled/);
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: false, headSha: oid(3), refresh: null }]);
  });
  it('refuses to publish while an attempt is active', async () => {
    const store = runningTask();
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    expect(attempt).toBeTruthy();
    const { publisher, log } = harness(store);
    await expect(publisher.publish(identity)).rejects.toThrow(/attempt is still active/);
    expect(log.some(line => line.startsWith('push') || line.startsWith('open'))).toBe(false);
  });
  it('refuses to publish a task with interrupted work waiting to be requeued, or with a rebase in progress', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    for (const column of ["requeue_pending=1", "rebase_in_progress='{}'"]) {
      const dir = mkdtempSync(join(tmpdir(), 'codeboost-guard-')), path = join(dir, 'state.sqlite');
      try {
        const first = new Store(path);
        first.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
        first.recordHistory(identity, { revision: 1, snapshotId: first.getSnapshot(identity).id }, oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
        first.close();
        const db = new DatabaseSync(path); db.exec(`UPDATE tasks SET status='running', ${column}`); db.close();
        const store = new Store(path); stores.push(store);
        const { publisher, log } = harness(store);
        await expect(publisher.publish(identity)).rejects.toThrow(/requeued|rebase is in progress/);
        expect(log.some(line => line.startsWith('push'))).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  it('reports drafts unsupported when recovery cannot turn a lost draft opening back into a draft', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity, { problems: ['x'] })).rejects.toThrow('timeout');
    for (const [m, pr] of live) live.set(m, { ...pr, draft: false });
    expect(await harness(store, { live, next, draftsUnsupported: true }).publisher.publish(identity, { problems: ['x'] })).toEqual({ kind: 'draft unsupported', number: 100 });
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100 }]);
  });
  it('refuses to recover an opening recorded for another repository', async () => {
    const store = runningTask();
    const check = store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
    store.beginPullRequest(identity, { checkId: check.id, repository: 'other/repo', base: 'main', headBranch: 'b', headSha: oid(2), draft: false });
    const { publisher, log } = harness(store);
    await expect(publisher.publish(identity)).rejects.toThrow(/another repository/);
    expect(log).toEqual([]);
  });
});

describe('PR records', () => {
  it('keeps the record of a PR that opened after the task was cancelled, without reopening the task', async () => {
    const store = runningTask();
    const { publisher } = harness(store, { open: async input => {
      store.cancelTask(identity, store.getTask(identity).stateVersion, crypto.randomUUID());
      return { number: 9, url: 'https://github.com/owner/repo/pull/9', headSha: oid(2), draft: input.draft };
    } });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 9, status: 'cancelled' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 9 }]);
  });
  it('refreshes only an opened PR: an abandoned opening must be adopted first', async () => {
    const store = runningTask();
    const clear = () => store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
    const opening = store.beginPullRequest(identity, { checkId: clear().id, repository: 'owner/repo', base: 'main', headBranch: 'b', headSha: oid(2), draft: false });
    store.abandonPullRequestOpening(identity, opening.openingId);
    expect(() => store.beginRefresh(identity, { checkId: clear().id, openingId: opening.openingId, headSha: oid(2), draft: false })).toThrow(/Unknown pull request/);
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'abandoned', number: null, refresh: null }]);
  });
  it('binds an opening to the checked head, with no task change since the check', async () => {
    const store = runningTask();
    const check = store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
    const pr = { checkId: check.id, repository: 'owner/repo', base: 'main', headBranch: 'b', headSha: oid(2), draft: false };
    expect(() => store.beginPullRequest(identity, { ...pr, headSha: oid(3) })).toThrow(/head changed/);
    expect(() => store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: 'old', reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } })).toThrow(/head changed/);
    store.beginPullRequest(identity, pr);
    expect(() => store.beginPullRequest(identity, pr)).toThrow(GuardRefusal);
  });
});

describe('a repository without draft PRs', () => {
  it('opens no PR for a needs-human task, drops the opening, and says why', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const { publisher } = harness(store, { draftsUnsupported: true });
    expect(await publisher.publish(identity, { problems: ['x'] })).toEqual({ kind: 'draft unsupported', number: null });
    expect(store.taskPullRequests(identity).map(pr => pr.state)).toEqual(['abandoned']);
    expect(store.getTask(identity).status).toBe('needs human');
    // Nothing is left in flight: the next publish does not wait for a settle time.
    expect(await harness(store, { draftsUnsupported: true }).publisher.publish(identity, { problems: ['x'] })).toEqual({ kind: 'draft unsupported', number: null });
  });
  it('leaves the existing ready PR exactly as it is: the draft refusal comes before any push or description change', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const again = harness(store, { live, next, draftsUnsupported: true });
    expect(await again.publisher.publish(identity, { problems: ['x'] })).toEqual({ kind: 'draft unsupported', number: 100 });
    // The draft step comes first, so the refusal leaves the PR exactly as it was: no push, no new description.
    expect(again.log.some(line => line.startsWith('push') || line.startsWith('refresh'))).toBe(false);
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, refresh: null, headSha: oid(2) }]);
  });
  it('reports a ready PR it could not make a draft when the check matches', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    expect(await harness(store, { live, next, results: [found], draftsUnsupported: true }).publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed', leftReady: 100 });
    expect(store.getTask(identity).status).toBe('possibly already fixed');
  });
});

describe('recovering a lost opening', () => {
  it('adopts the PR GitHub has for the recorded marker, without opening another', async () => {
    const store = runningTask();
    const first = harness(store, { open: async () => { throw new Error('timeout'); } });
    await expect(first.publisher.publish(identity)).rejects.toThrow('timeout');
    const [lost] = store.taskPullRequests(identity);
    expect(lost).toMatchObject({ state: 'opening' });
    const second = harness(store, { found: { number: 55, url: 'https://github.com/owner/repo/pull/55', headSha: oid(2), draft: false } });
    expect(await second.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 55, status: 'in review' });
    expect(second.log).toEqual([`find <!-- codeboost:opening=${lost!.openingId} -->`]);
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 55 }]);
  });
  it('turns a lost draft opening back into a draft when the PR it finds was made ready meanwhile', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity, { problems: ['x'] })).rejects.toThrow('timeout');
    for (const [m, pr] of live) live.set(m, { ...pr, draft: false });
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity, { problems: ['x'] })).toMatchObject({ kind: 'opened', number: 100, draft: true });
    expect(again.log).toContain('draft 100');
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100, draft: true }]);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('records a recovered opening from an older run, then continues the current publish with the new head and mode', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    // A needs-human draft POST lands, but its answer is lost.
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity, { problems: ['x'] })).rejects.toThrow('timeout');
    // The person sends the task back; it reruns (new head oid3) and now publishes as ready.
    rerun(store);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, draft: false, status: 'in review' });
    expect(again.log.filter(line => !line.startsWith('find'))).toEqual(['check', 'push codeboost/issue-12-task-42 003', 'refresh 100 ready']);
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100, draft: false, headSha: oid(3) }]);
  });
  it('keeps an unconfirmed opening owned until it settles, then abandons it, checks again and opens a new PR', async () => {
    const store = runningTask();
    await expect(harness(store, { open: async () => { throw new Error('timeout'); } }).publisher.publish(identity)).rejects.toThrow('timeout');
    // Within the settle time an empty lookup proves nothing: the opening stays owned and nothing is posted.
    const early = harness(store);
    await expect(early.publisher.publish(identity)).rejects.toThrow(OpeningUnsettled);
    expect(early.log).toEqual([expect.stringMatching(/^find /)]);
    expect(store.taskPullRequests(identity).map(pr => pr.state)).toEqual(['opening']);
    const second = harness(store, { config: { now: () => Date.now() + 10 * 60_000 } });
    expect(await second.publisher.publish(identity)).toMatchObject({ kind: 'opened', status: 'in review' });
    // The abandoned opening is still looked up by its marker, in case its PR appears later.
    expect(second.log).toEqual([expect.stringMatching(/^find /), expect.stringMatching(/^find /), 'check', 'push codeboost/issue-12-task-42 002', 'open ready']);
    expect(store.taskPullRequests(identity).map(pr => pr.state)).toEqual(['abandoned', 'opened']);
  });
  it('reuses the still-open draft for the next run: updates it and marks it ready instead of opening a second PR', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, draft: false, status: 'in review' });
    expect(again.checks[0]!.ownPullRequests).toEqual([100]);
    const [draft] = store.taskPullRequests(identity);
    expect(again.log).toEqual([`find <!-- codeboost:opening=${draft!.openingId} -->`, 'check', 'push codeboost/issue-12-task-42 003', 'refresh 100 ready']);
    expect(again.opened[0]!.body).not.toContain('Needs human');
    // The refresh waits for GitHub to show the pushed head.
    expect(again.opened[0]).toMatchObject({ headSha: oid(3) });
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: false, headSha: oid(3), state: 'opened' }]);
  });
  it('keeps a needs-human task in needs human when it reuses its earlier ready PR, and turns that PR back into a draft', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    expect(store.getTask(identity).status).toBe('in review');
    rerun(store);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity, { problems: ['still failing'] })).toMatchObject({ kind: 'opened', number: 100, draft: true, status: 'needs human' });
    expect(again.log.at(-1)).toBe('refresh 100 draft');
    expect(store.getTask(identity).status).toBe('needs human');
    // Even if GitHub still reports the PR as ready, a needs-human task never moves to in review.
    rerun(store);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    expect(await harness(store, { live, next, draftAfterRefresh: false }).publisher.publish(identity, { problems: ['x'] })).toMatchObject({ draft: false, status: 'needs human' });
  });
  it('does not push when the task changed while the earlier PR was looked up (the check refuses to record)', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    const again = harness(store, { live, next, onFind: () => store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code') });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(again.log.some(line => line.startsWith('push'))).toBe(false);
  });
  it('records an update of the open PR before it starts, and repeats it after its confirmation was lost', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    await expect(harness(store, { live, next, refreshFails: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, refresh: { head: oid(3), draft: false } }]);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, status: 'in review' });
    expect(again.log.at(-1)).toBe('refresh 100 ready');
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, refresh: null, headSha: oid(3) }]);
  });
  it('drops an unconfirmed update when the next check matches, so no stale update stays pending', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    await expect(harness(store, { live, next, refreshFails: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    const again = harness(store, { live, next, results: [{ outcome: 'unknown', reason: 'GitHub could not be read.' }] });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, refresh: null }]);
  });
  it('records the refresh before the push, and changes nothing else about the PR when the task changed during the push', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    rerun(store);
    let refreshRecordedAtPush: unknown = undefined;
    const again = harness(store, { live, next, push: async () => {
      refreshRecordedAtPush = store.taskPullRequests(identity)[0]!.refresh;
      store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code');
    } });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(refreshRecordedAtPush).toMatchObject({ head: oid(3), draft: false });
    // The draft is not marked ready and its description is not replaced; the update stays in flight for the next publish.
    expect(again.log.some(line => line.startsWith('refresh'))).toBe(false);
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: true, refresh: { head: oid(3) } }]);
  });
  it('runs one publish per task at a time, across publishers over the same Store', async () => {
    const store = runningTask();
    let release!: () => void;
    const pushed = new Promise<void>(resolve => { release = resolve; });
    const { publisher } = harness(store, { push: () => pushed });
    const first = publisher.publish(identity);
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(publisher.publish(identity)).rejects.toThrow(/already being published/);
    // A second publisher over the same Store is refused too.
    await expect(harness(store).publisher.publish(identity)).rejects.toThrow(/already being published/);
    release();
    expect(await first).toMatchObject({ kind: 'opened', status: 'in review' });
    // The guard is released afterwards.
    await expect(publisher.publish(identity)).rejects.toThrow(/while the task is in review/);
  });
  it('changes nothing when the signal is already aborted', async () => {
    const store = runningTask({ head: oid(1) });
    const controller = new AbortController(); controller.abort();
    const { publisher, log } = harness(store);
    await expect(publisher.publish(identity, {}, controller.signal)).rejects.toThrow();
    expect(log).toEqual([]);
    expect(store.getTask(identity).status).toBe('running');
  });
  it('turns the earlier ready PR back into a draft when the check matches, so it is never left ready for review', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    expect(store.getTask(identity).status).toBe('in review');
    rerun(store);
    const again = harness(store, { live, next, results: [{ outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] }] });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(again.log).toEqual([expect.stringMatching(/^find /), 'check', 'draft 100']);
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: true }]);
    expect(store.getTask(identity).status).toBe('possibly already fixed');
  });
  it('does not draft the PR when the task was reassigned during the check', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    const gate = harness(store, { live, next, results: [found] });
    const publisher = new PullRequestPublisher(store, { checks: { async check() {
      store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code'); return found;
    } }, pulls: { ...gate.pulls }, pusher: { async push() {} } }, config);
    await expect(publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(gate.log.some(line => line.startsWith('draft'))).toBe(false);
  });
  it('keeps the task running when marking the earlier PR a draft fails, so a retry repeats it', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    rerun(store);
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    await expect(harness(store, { live, next, results: [found], draftFails: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    expect(store.getTask(identity).status).toBe('running');
    const retry = harness(store, { live, next, results: [found] });
    expect(await retry.publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(retry.log).toContain('draft 100');
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: true }]);
  });
  it('refuses a PR-number mismatch before drafting anything', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    for (const [m, pr] of live) live.set(m, { ...pr, number: 999 });
    rerun(store);
    const again = harness(store, { live, next, results: [{ outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] }] });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/different pull request/);
    expect(again.log.some(line => line.startsWith('draft'))).toBe(false);
  });
  it('repairs a draft flag whose change landed on GitHub but was never recorded', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    // The PR became a draft on GitHub (a draft change whose record was lost to a crash).
    for (const [m, pr] of live) live.set(m, { ...pr, draft: true });
    rerun(store);
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    expect(await harness(store, { live, next, results: [found] }).publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: true }]);
  });
  it('still notices a task change during the lookup when it repairs the draft flag', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    await harness(store, { live, next }).publisher.publish(identity);
    for (const [m, pr] of live) live.set(m, { ...pr, draft: true });
    rerun(store);
    const again = harness(store, { live, next, onFind: () => store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code') });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(again.log).not.toContain('check');
  });
  it('opens a new PR when the earlier draft was closed, and still excludes the old draft from the check', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    live.clear();
    rerun(store);
    const again = harness(store, { live, next });
    expect(await again.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 101, status: 'in review' });
    expect(again.checks[0]!.ownPullRequests).toEqual([100]);
    expect(store.taskPullRequests(identity).map(pr => pr.number)).toEqual([100, 101]);
  });
});

/** The person sends a needs-human task back; one more item runs and commits `oid(3)`. */
function rerun(store: Store) {
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
  store.markRunning(identity, attempt.id);
  store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
  store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(3), [{ sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null }]);
}

describe('recovering from an abandoned opening whose PR appears later', () => {
  it('adopts that PR instead of getting stuck behind GitHub refusing a second PR for the branch', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 }, hidden = new Set<string>();
    const later = { now: () => Date.now() + 10 * 60_000 };
    // The POST lands, but its answer is lost and GitHub does not show the PR yet.
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    const [first] = store.taskPullRequests(identity);
    for (const m of live.keys()) hidden.add(m);
    // After the settle time the opening is abandoned; the new POST is refused because the first PR now exists.
    await expect(harness(store, { live, next, hidden, config: later }).publisher.publish(identity)).rejects.toThrow(/already exists/);
    expect(store.taskPullRequests(identity).map(pr => pr.state)).toEqual(['abandoned', 'opening']);
    // The first PR becomes visible: it is adopted, the second opening is dropped, and publishing finishes.
    hidden.clear();
    const third = harness(store, { live, next, config: later });
    expect(await third.publisher.publish(identity)).toMatchObject({ kind: 'opened', number: 100, status: 'in review' });
    expect(store.taskPullRequests(identity)).toMatchObject([{ openingId: first!.openingId, state: 'opened', number: 100 }, { state: 'abandoned' }]);
    expect(third.log.filter(line => line.startsWith('open'))).toEqual([]);
  });
  it('adopts an abandoned opening\'s PR as soon as it is seen, even when the check then matches', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 }, hidden = new Set<string>();
    const later = { now: () => Date.now() + 10 * 60_000 };
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    for (const m of live.keys()) hidden.add(m);
    // The opening is abandoned after its settle time; a new POST is refused (the first PR exists), leaving one opening.
    await expect(harness(store, { live, next, hidden, config: later }).publisher.publish(identity)).rejects.toThrow(/already exists/);
    hidden.clear();
    const found: AlreadyFixedResult = { outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] };
    expect(await harness(store, { live, next, results: [found], config: later }).publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    // The first opening's PR is now recorded with its number and URL, so it can be found and closed later.
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100, url: expect.stringContaining('github.com') }, { state: 'abandoned' }]);
  });
  it('does not adopt when the task changed during the lookup', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 }, hidden = new Set<string>();
    const later = { now: () => Date.now() + 10 * 60_000 };
    await expect(harness(store, { live, next, openTimesOut: true }).publisher.publish(identity)).rejects.toThrow('timeout');
    for (const m of live.keys()) hidden.add(m);
    await expect(harness(store, { live, next, hidden, config: later }).publisher.publish(identity)).rejects.toThrow(/already exists/);
    hidden.clear();
    // Recovery drops the second opening; then the task changes while the branch lookup runs.
    let finds = 0;
    const again = harness(store, { live, next, config: later, onFind: () => { if (++finds === 2) store.setAssignment(identity, store.getTask(identity).stateVersion, 'someone-else', 'code'); } });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/Stale task state/);
    expect(store.taskPullRequests(identity).map(pr => pr.state)).toEqual(['abandoned', 'abandoned']);
  });
  it('refuses before pushing when the branch PR has the earlier marker but another number', async () => {
    const store = runningTask(), live = new Map<string, OpenedPullRequest>(), next = { value: 100 };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    await harness(store, { live, next }).publisher.publish(identity, { problems: ['x'] });
    for (const [m, pr] of live) live.set(m, { ...pr, number: 999 });
    rerun(store);
    const again = harness(store, { live, next });
    await expect(again.publisher.publish(identity)).rejects.toThrow(/different pull request/);
    expect(again.log.some(line => line.startsWith('push'))).toBe(false);
  });
});

describe('the PR description', () => {
  it('fences plan text so closing keywords and mentions in it do nothing, even with backticks in the text', () => {
    const hostile: Plan = { ...plan, items: [{ ...plan.items[0]!, intent: 'Closes #1 @admin ```\n# injected' }] };
    const body = pullRequestBody({ plan: hostile, marker: '<!-- codeboost:opening=00000000-0000-4000-8000-000000000000 -->' });
    expect(body.split('\n').slice(0, 2)).toEqual(['<!-- codeboost:opening=00000000-0000-4000-8000-000000000000 -->', 'Fixes #12']);
    expect(body).toContain('````text\nP1: Guard input\n  Intent: Closes ＃1 @admin ```\n# injected');
    expect(fenced('a ```` b')).toMatch(/^`````text\n/);
  });
  it('handles text with very many backtick runs without overflowing the stack', () => {
    expect(fenced('`a'.repeat(300_000)).startsWith('```text\n')).toBe(true);
  });
  it('lists only item titles when the full plan is too long, and refuses when even that is too long', () => {
    const long: Plan = { ...plan, items: [{ ...plan.items[0]!, intent: 'x'.repeat(MAX_BODY) }] };
    const body = pullRequestBody({ plan: long, marker: 'm' });
    expect(body).toContain('items only');
    expect(body).not.toContain('Intent:');
    const huge: Plan = { ...plan, items: [{ ...plan.items[0]!, title: 'y'.repeat(MAX_BODY) }] };
    expect(() => pullRequestBody({ plan: huge, marker: 'm' })).toThrow(/too long/);
  });
  it('keeps the description bound with problems made of astral characters', () => {
    const body = pullRequestBody({ plan, marker: 'm', problems: Array.from({ length: 20 }, () => '😀'.repeat(2500)) });
    expect(body.length).toBeLessThan(MAX_BODY);
  });
  it('cuts each shown problem to exactly the documented 2,000 characters', () => {
    const body = pullRequestBody({ plan, marker: 'm', problems: ['a'.repeat(3000)] });
    expect(body).toContain(`${'a'.repeat(1999)}…\n`);
    expect(body).not.toContain('a'.repeat(2000));
  });
  it('bounds the open problems it shows', () => {
    const body = pullRequestBody({ plan, marker: 'm', problems: Array.from({ length: 25 }, (_, i) => `problem ${i} ${'z'.repeat(3000)}`) });
    expect(body).toContain('(5 more in codeboost)');
    expect(body).not.toContain('problem 20 ');
    expect(body.length).toBeLessThan(MAX_BODY);
  });
  it('neutralises every issue reference in the title, plan and problems, since commit messages ignore fences', () => {
    const hostile: Plan = { ...plan, summary: 'Fix #7 crash', items: [{ ...plan.items[0]!, intent: 'fixes #5, closes GH-6, resolves https://github.com/owner/repo/issues/8 and owner/repo#9' }] };
    const title = pullRequestTitle(hostile);
    expect(title).toBe('Fix ＃7 crash (#12)');
    const body = pullRequestBody({ plan: hostile, marker: 'm', problems: ['Fixes #10'] });
    expect(body).toContain('Fixes #12');
    expect(body.replace('Fixes #12', '').replace('(#12)', '')).not.toMatch(/#\d|GH-\d|\/issues\/\d/i);
    expect(neutralizeReferences('owner/repo#9 and #x and GH-a')).toBe('owner/repo＃9 and #x and GH-a');
  });
  it('cuts titles and problems by code point, and never leaves an empty summary', () => {
    const emoji = '😀'.repeat(300);
    const title = pullRequestTitle({ ...plan, summary: emoji });
    expect(title.endsWith('… (#12)')).toBe(true);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(pullRequestTitle({ ...plan, summary: ' \u0007 ' })).toBe('codeboost plan (#12)');
    const body = pullRequestBody({ plan, marker: 'm', problems: ['😀'.repeat(3000)] });
    expect(body).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
  it('neutralises @-mentions in the unfenced title', () => {
    expect(pullRequestTitle({ ...plan, summary: 'Investigate @admin and @org/team, not a@b' })).toBe('Investigate ＠admin and ＠org/team, not a＠b (#12)');
  });
  it('makes a one-line, bounded title', () => {
    expect(pullRequestTitle({ ...plan, summary: 'a\nb\u0007c' })).toBe('a b c (#12)');
    expect(pullRequestTitle({ ...plan, summary: 'w'.repeat(500) })).toHaveLength(200);
  });
});

describe('running gh with a request body on stdin', () => {
  it('passes a body far past the per-argument limit, including a NUL, through stdin', async () => {
    const body = `${'€'.repeat(60_000)}\u0000end`;
    const out = await runWithInput(process.execPath, ['-e', 'let n=0;process.stdin.on("data",c=>n+=c.length).on("end",()=>process.stdout.write(String(n)))'], { input: body });
    expect(Number(out)).toBe(Buffer.byteLength(body));
  });
  it('rejects on abort only after the process has exited', async () => {
    const controller = new AbortController();
    const started = runWithInput(process.execPath, ['-e', 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(1),150));setInterval(()=>{},1000)'], { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 200));
    const aborted = Date.now(); controller.abort(new Error('stop'));
    await expect(started).rejects.toThrow('stop');
    expect(Date.now() - aborted).toBeGreaterThanOrEqual(100);
  });
  it('kills a process that ignores SIGTERM after the grace period, and still settles', async () => {
    const controller = new AbortController();
    const started = runWithInput(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { signal: controller.signal, killGraceMs: 100 });
    await new Promise(resolve => setTimeout(resolve, 200));
    controller.abort(new Error('stop'));
    await expect(started).rejects.toThrow('stop');
  });
  it('settles after the process exits even when a child it started keeps the pipes open', async () => {
    const started = Date.now();
    const script = 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{stdio:["ignore","inherit","inherit"]}).unref();process.exit(0)';
    await expect(runWithInput(process.execPath, ['-e', script], { pipeGraceMs: 100 })).resolves.toBe('');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('reports a failing exit with its stderr', async () => {
    await expect(runWithInput(process.execPath, ['-e', 'console.error("HTTP 422");process.exit(1)'], {})).rejects.toThrow(/exit 1\): HTTP 422/);
  });
});

describe('gh subprocess environment', () => {
  it('passes only the allowlisted variables, and turns prompts off', () => {
    const env = ghEnvironment({ PATH: '/bin', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'y', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 't', HOME: '/h', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' });
    expect(GH_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY' as never);
    // Windows needs its system and profile directories, and has no `cat` for a pager.
    expect(ghEnvironment({ SYSTEMROOT: 'C:\\Windows', APPDATA: 'A', LOCALAPPDATA: 'L', USERPROFILE: 'U', PATHEXT: '.EXE' }, 'win32'))
      .toMatchObject({ SYSTEMROOT: 'C:\\Windows', APPDATA: 'A', LOCALAPPDATA: 'L', USERPROFILE: 'U', PATHEXT: '.EXE', GH_PAGER: '' });
    // Linux keyring sign-in needs the session bus.
    expect(ghEnvironment({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', XDG_RUNTIME_DIR: '/run/user/1' })).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', XDG_RUNTIME_DIR: '/run/user/1' });
  });
});

describe('GitHub PR adapter', () => {
  const marker = '<!-- codeboost:opening=11111111-1111-4111-8111-111111111111 -->';
  const response = (over: Record<string, unknown> = {}) => ({ number: 7, html_url: 'https://github.com/owner/repo/pull/7', state: 'open', draft: true, body: `${marker}\nplan`,
    head: { sha: oid(2), ref: 'codeboost/issue-12-task', repo: { full_name: 'Owner/Repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, ...over });
  const input = { base: 'main', headBranch: 'codeboost/issue-12-task', title: 'T', body: `${marker}\nplan`, draft: true, marker };
  it('opens with literal argv, sends the title and description as a JSON body on stdin, and validates the answer', async () => {
    const calls: string[][] = [], inputs: (string | undefined)[] = [];
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async (args, options) => { calls.push([...args]); inputs.push(options?.input); return JSON.stringify(response()); });
    expect(await gh.open(input)).toEqual({ number: 7, url: 'https://github.com/owner/repo/pull/7', headSha: oid(2), draft: true });
    expect(calls[0]).toEqual(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/owner/repo/pulls', '--input', '-']);
    expect(JSON.parse(inputs[0]!)).toEqual({ title: 'T', body: `${marker}\nplan`, head: 'codeboost/issue-12-task', base: 'main', draft: true });
    expect(calls[0]!.join(' ')).not.toContain('plan');
  });
  it('refuses answers for another branch or repository, and bodies without the marker', async () => {
    for (const over of [{ head: { sha: oid(2), ref: 'other', repo: { full_name: 'owner/repo' } } }, { head: { sha: oid(2), ref: 'codeboost/issue-12-task', repo: { full_name: 'fork/repo' } } },
      { base: { ref: 'dev', repo: { full_name: 'owner/repo' } } }, { body: 'no marker' }, { state: 'closed' }, { number: 0 }, { head: { sha: 'x', ref: 'codeboost/issue-12-task', repo: { full_name: 'owner/repo' } } }]) {
      const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response(over)));
      await expect(gh.open(input), JSON.stringify(over)).rejects.toThrow();
    }
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => '{}').open({ ...input, body: 'no marker' })).rejects.toThrow(/marker/);
  });
  it('refreshes the description, then marks a draft ready, then reads the PR back', async () => {
    const calls: string[][] = [];
    let draft = true;
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => {
      calls.push([...args]);
      if (args[0] === 'pr') { draft = false; return ''; }
      return JSON.stringify(response({ draft }));
    });
    expect(await gh.refresh(7, { ...input, draft: false, ready: true })).toMatchObject({ number: 7, draft: false });
    expect(calls.map(call => call.slice(0, 3))).toEqual([['api', '-X', 'PATCH'], ['pr', 'ready', '7'], ['api', '-H', 'Accept: application/vnd.github+json']]);
    expect(calls[1]).toEqual(['pr', 'ready', '7', '--repo', 'owner/repo']);
    const undo: string[][] = [];
    let undone = false;
    await new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { undo.push([...args]); if (args[0] === 'pr') { undone = true; return ''; } return JSON.stringify(response({ draft: undone })); })
      .refresh(7, { ...input, draft: true, ready: false });
    expect(undo[1]).toEqual(['pr', 'ready', '7', '--undo', '--repo', 'owner/repo']);
    // GitHub never applying the draft change fails the refresh instead of reporting success.
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async args => args[0] === 'pr' ? '' : JSON.stringify(response({ draft: false })))
      .refresh(7, { ...input, draft: true, ready: false })).rejects.toThrow(/did not turn the pull request into a draft/);
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response({ number: 8 }))).refresh(7, { ...input, ready: false })).rejects.toThrow(/different/);
    // Closed between the lookup and the refresh: refused, so the task never moves to in review without an open PR.
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response({ state: 'closed' }))).refresh(7, { ...input, ready: false })).rejects.toThrow(/not open/);
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ state: 'closed' })])).findOpened({ ...input, markers: [marker] })).rejects.toThrow(/not open/);
  });
  it('waits for GitHub to show the pushed head before returning a refresh', async () => {
    let gets = 0;
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => {
      if (args[0] === 'pr') return '';
      if (args.includes('GET') || !args.includes('-X')) { gets++; return JSON.stringify(response({ draft: false, head: { sha: gets < 3 ? oid(2) : oid(3), ref: 'codeboost/issue-12-task', repo: { full_name: 'owner/repo' } } })); }
      return JSON.stringify(response({ draft: false }));
    });
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...a: Parameters<typeof add>) => { if (a[0] === 'abort') listeners++; return add(...a); }) as typeof add;
    controller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { if (a[0] === 'abort') listeners--; return remove(...a); }) as typeof remove;
    expect(await gh.refresh(7, { ...input, draft: false, ready: true, headSha: oid(3) }, controller.signal)).toMatchObject({ headSha: oid(3) });
    expect(gets).toBe(3);
    // Each wait removes its abort listener, so a long-lived signal does not collect them.
    expect(listeners).toBe(0);
  });
  it('marks an open ready PR as a draft, and leaves a draft alone', async () => {
    const calls: string[][] = [];
    let draft = false;
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => {
      calls.push([...args]); if (args[0] === 'pr') { draft = true; return ''; } return JSON.stringify(response({ draft }));
    });
    expect(await gh.markDraft(7, input)).toMatchObject({ draft: true });
    // No read before the change: the caller has just read the PR as ready.
    expect(calls.map(call => call[0] === 'pr' ? 'undo' : 'get')).toEqual(['undo', 'get']);
    expect(calls[0]).toEqual(['pr', 'ready', '7', '--undo', '--repo', 'owner/repo']);
    // A refusal because the PR already became a draft meanwhile is success.
    const already = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { if (args[0] === 'pr') throw new Error('pull request #7 is already a draft'); return JSON.stringify(response({ draft: true })); });
    expect(await already.markDraft(7, input)).toMatchObject({ draft: true });
    // A real refusal is reported.
    const refused = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { if (args[0] === 'pr') throw new Error('HTTP 403'); return JSON.stringify(response({ draft: false })); });
    await expect(refused.markDraft(7, input)).rejects.toThrow('HTTP 403');
  });
  it('turns GitHub refusing drafts into DraftsUnsupported on open, refresh and markDraft', async () => {
    const unsupported = new Error('gh: Draft pull requests are not supported in this repository. (HTTP 422)');
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => {
      if (args[0] === 'pr' || args.includes('POST')) throw unsupported; return JSON.stringify(response({ draft: false }));
    });
    await expect(gh.open({ ...input, draft: true })).rejects.toBeInstanceOf(DraftsUnsupported);
    await expect(gh.refresh(7, { ...input, draft: true, ready: false })).rejects.toBeInstanceOf(DraftsUnsupported);
    await expect(gh.markDraft(7, input)).rejects.toBeInstanceOf(DraftsUnsupported);
    // A ready PR is not a draft request, so the same text is not reinterpreted.
    await expect(gh.open({ ...input, draft: false })).rejects.toBe(unsupported);
  });
  it('fails markDraft when GitHub never shows the PR as a draft', async () => {
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => args[0] === 'pr' ? '' : JSON.stringify(response({ draft: false })));
    await expect(gh.markDraft(7, input)).rejects.toThrow(/did not turn the pull request into a draft/);
  });
  it('looks up the branch with no markers: an open PR there is refused, no PR is null', async () => {
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response()])).findOpened({ ...input, markers: [] })).rejects.toThrow(/did not open/);
    expect(await new GhPullRequestGateway({ repository: 'owner/repo' }, async () => '[]').findOpened({ ...input, markers: [] })).toBeNull();
    // Every other call still needs its marker.
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => '{}').markDraft(7, { ...input, marker: '' })).rejects.toThrow(/marker/);
  });
  it('reads the marker only from the first line, so a marker quoted in plan text identifies nothing', async () => {
    const other = '<!-- codeboost:opening=22222222-2222-4222-8222-222222222222 -->';
    // A foreign PR that quotes our marker in its text is not ours.
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ body: `Someone's PR\n${marker}` })]))
      .findOpened({ ...input, markers: [marker] })).rejects.toThrow(/did not open/);
    // Our PR whose plan text quotes an older marker still matches exactly one: its own first line.
    expect(await new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ body: `${marker}\nplan quoting ${other}` })]))
      .findOpened({ ...input, markers: [other, marker] })).toMatchObject({ marker });
  });
  it('fails a draft opening that GitHub created as ready, so the opening stays owned for recovery', async () => {
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response({ draft: false })));
    await expect(gh.open({ ...input, draft: true })).rejects.toThrow(/as ready, not as a draft/);
    expect(await gh.open({ ...input, draft: false })).toMatchObject({ draft: false });
  });
  it('bounds a whole refresh by one deadline, not a fresh allowance per command or poll', async () => {
    let calls = 0, lastSignal: AbortSignal | undefined;
    const gh = new GhPullRequestGateway({ repository: 'owner/repo', operationMs: 300 }, async (args, options) => {
      calls++; lastSignal = options?.signal;
      await new Promise(resolve => setTimeout(resolve, 40));
      // GitHub never shows the pushed head, so the refresh would poll 5 times at 500 ms without the deadline.
      return args[0] === 'pr' ? '' : JSON.stringify(response({ draft: false, head: { sha: oid(2), ref: 'codeboost/issue-12-task', repo: { full_name: 'owner/repo' } } }));
    });
    const started = Date.now();
    await expect(gh.refresh(7, { ...input, draft: false, ready: true, headSha: oid(3) })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(lastSignal?.aborted).toBe(true);
    expect(calls).toBeLessThan(5);
  });
  it('finds a lost PR only by its marker, and refuses a PR on the branch that codeboost did not open', async () => {
    const calls: string[][] = [];
    const found = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { calls.push([...args]); return JSON.stringify([response()]); });
    expect(await found.findOpened({ ...input, markers: [marker] })).toMatchObject({ number: 7, marker });
    // It reports which of several markers the PR carries.
    const other = '<!-- codeboost:opening=22222222-2222-4222-8222-222222222222 -->';
    expect(await found.findOpened({ ...input, markers: [other, marker] })).toMatchObject({ marker });
    expect(calls[0]!.at(-1)).toBe('repos/owner/repo/pulls?state=open&head=owner%3Acodeboost%2Fissue-12-task&base=main&per_page=100');
    expect(await new GhPullRequestGateway({ repository: 'owner/repo' }, async () => '[]').findOpened({ ...input, markers: [marker] })).toBeNull();
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ body: 'someone else' })])).findOpened({ ...input, markers: [marker] })).rejects.toThrow(/did not open/);
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response(), response()])).findOpened({ ...input, markers: [marker] })).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { OpeningUnsettled, PullRequestPublisher, type BranchPusher, type PublishConfig } from '../runner/publish.ts';
import { GH_ENV_ALLOWLIST, ghEnvironment } from '../github/gh-env.ts';
import { GhPullRequestGateway, type OpenPullRequestInput, type OpenedPullRequest, type PullRequestGateway } from '../github/pull-requests.ts';
import type { AlreadyFixedGateway, AlreadyFixedInput, AlreadyFixedResult } from '../github/already-fixed.ts';
import { fenced, pullRequestBody, pullRequestTitle, MAX_BODY } from '../core/pull-request-body.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 'repo', taskId: 'Task_42', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 12, revision: 1, summary: 'Stop the crash', questions: [], items: [
  { id: 'P1', title: 'Guard input', intent: 'Reject empty input', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'Check it' }], acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] }] };
const context: PlanContext = { identity, issue: 12, baseEntries: [{ path: 'a.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [['npm', 'test']] };
const config: PublishConfig = { repository: 'owner/repo', baseBranch: 'main' };
const BRANCH = /^codeboost\/issue-12-task-42-[0-9a-f]{16}$/;

/** A task whose last attempt settled while it runs, with head `oid(2)` over base `oid(1)` and one owned commit. */
function runningTask(options: { head?: string } = {}) {
  const store = new Store(':memory:');
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
  push?: BranchPusher['push']; live?: Map<string, OpenedPullRequest>; next?: { value: number }; config?: Partial<PublishConfig> } = {}) {
  const live = options.live ?? new Map<string, OpenedPullRequest>(), counter = options.next ?? { value: 100 };
  const log: string[] = [], checks: AlreadyFixedInput[] = [], opened: OpenPullRequestInput[] = [];
  const results = options.results ?? [{ outcome: 'clear', baseHead: oid(9) }];
  const gate: AlreadyFixedGateway = { async check(input) { log.push('check'); checks.push(input); return results.shift() ?? { outcome: 'clear', baseHead: oid(9) }; } };
  const pulls: PullRequestGateway = {
    async open(input) {
      log.push(`open ${input.draft ? 'draft' : 'ready'}`); opened.push(input);
      if (options.open) return options.open(input);
      const pr = { number: counter.value++, url: 'https://github.com/owner/repo/pull/1', headSha: store.getSnapshot(identity).head, draft: input.draft };
      live.set(input.marker, pr); return pr;
    },
    async findOpened(input) { log.push(`find ${input.marker}`); return options.found !== undefined ? options.found : live.get(input.marker) ?? null; },
    async refresh(number, input) {
      log.push(`refresh ${number} ${input.ready ? 'ready' : 'draft'}`); opened.push(input);
      const pr = { ...live.get(input.marker)!, draft: input.draft, headSha: store.getSnapshot(identity).head };
      live.set(input.marker, pr); return pr;
    },
  };
  const pusher: BranchPusher = { async push(id, input, signal) { log.push(`push ${input.branch.replace(/-[0-9a-f]{16}$/, '')} ${input.head.slice(-3)}`); await options.push?.(id, input, signal); } };
  return { log, checks, opened, publisher: new PullRequestPublisher(store, { checks: gate, pulls, pusher }, { ...config, ...options.config }) };
}

describe('opening the task PR', () => {
  it('checks, pushes, then opens the PR and moves the task to in review', async () => {
    const store = runningTask();
    const { publisher, log, checks, opened } = harness(store);
    const outcome = await publisher.publish(identity);
    expect(outcome).toMatchObject({ kind: 'opened', number: 100, draft: false, status: 'in review' });
    expect(log).toEqual(['check', 'push codeboost/issue-12-task-42 002', 'open ready']);
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
    expect(log).toEqual(['check']);
    expect(store.getTask(identity).status).toBe('possibly already fixed');
    expect(store.taskPullRequests(identity)).toEqual([]);
    expect(store.latestAlreadyFixed(identity)!.result).toEqual(result);
  });
  it('fails closed: a check that could not be completed also opens nothing', async () => {
    const store = runningTask();
    const { publisher, log } = harness(store, { results: [{ outcome: 'unknown', reason: 'GitHub could not be read.' }] });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'possibly already fixed' });
    expect(log).toEqual(['check']);
    expect(store.getTask(identity).status).toBe('possibly already fixed');
  });
  it('opens a draft PR with the open problems for a needs-human task, and keeps it in needs human', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const { publisher, opened } = harness(store);
    expect(await publisher.publish(identity, { problems: ['Review round 3: @someone Fixes #99 still fails'] })).toMatchObject({ kind: 'opened', draft: true, status: 'needs human' });
    expect(opened[0]).toMatchObject({ draft: true });
    expect(opened[0]!.body).toMatch(/```text\nReview round 3: @someone Fixes #99 still fails\n```/);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('skips the draft on a match and leaves the task in needs human', async () => {
    const store = runningTask();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const { publisher, log } = harness(store, { results: [{ outcome: 'found', baseHead: oid(9), matches: [{ kind: 'closed', by: 'owner/repo#5' }] }] });
    expect(await publisher.publish(identity, { problems: ['x'] })).toMatchObject({ kind: 'draft skipped' });
    expect(log).toEqual(['check']);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('opens no PR when the task changed nothing, and moves it to needs human', async () => {
    const store = runningTask({ head: oid(1) });
    const { publisher, log } = harness(store);
    expect(await publisher.publish(identity)).toEqual({ kind: 'no changes' });
    expect(log).toEqual([]);
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
  it('refuses to open when the head moved during the check', async () => {
    const store = runningTask();
    const gate: AlreadyFixedGateway = { async check() {
      store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(3), [{ sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null }]);
      return { outcome: 'clear', baseHead: oid(9) };
    } };
    const opened: string[] = [];
    const publisher = new PullRequestPublisher(store, { checks: gate, pusher: { async push() {} },
      pulls: { async open() { opened.push('open'); throw new Error('unreachable'); }, async findOpened() { return null; }, async refresh() { throw new Error('unreachable'); } } }, config);
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
  it('moves to needs human when the branch head moved before GitHub read it', async () => {
    const store = runningTask();
    const { publisher } = harness(store, { open: async input => ({ number: 5, url: 'https://github.com/owner/repo/pull/5', headSha: oid(77), draft: input.draft }) });
    expect(await publisher.publish(identity)).toMatchObject({ kind: 'opened', status: 'needs human' });
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
  it('binds an opening to the checked head, with no task change since the check', async () => {
    const store = runningTask();
    const check = store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
    const pr = { checkId: check.id, repository: 'owner/repo', base: 'main', headBranch: 'b', headSha: oid(2), draft: false };
    expect(() => store.beginPullRequest(identity, { ...pr, headSha: oid(3) })).toThrow(/head changed/);
    expect(() => store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: 'old', draft: false, result: { outcome: 'clear', baseHead: oid(9) } })).toThrow(/head changed/);
    store.beginPullRequest(identity, pr);
    expect(() => store.beginPullRequest(identity, pr)).toThrow(GuardRefusal);
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
    expect(second.log).toEqual([expect.stringMatching(/^find /), 'check', 'push codeboost/issue-12-task-42 002', 'open ready']);
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
    expect(again.log).toEqual(['check', `find <!-- codeboost:opening=${draft!.openingId} -->`, 'push codeboost/issue-12-task-42 003', 'refresh 100 ready']);
    expect(again.opened[0]!.body).not.toContain('Needs human');
    expect(store.taskPullRequests(identity)).toMatchObject([{ number: 100, draft: false, headSha: oid(3), state: 'opened' }]);
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

describe('the PR description', () => {
  it('fences plan text so closing keywords and mentions in it do nothing, even with backticks in the text', () => {
    const hostile: Plan = { ...plan, items: [{ ...plan.items[0]!, intent: 'Closes #1 @admin ```\n# injected' }] };
    const body = pullRequestBody({ plan: hostile, marker: '<!-- codeboost:opening=00000000-0000-4000-8000-000000000000 -->' });
    expect(body.split('\n').slice(0, 2)).toEqual(['<!-- codeboost:opening=00000000-0000-4000-8000-000000000000 -->', 'Fixes #12']);
    expect(body).toContain('````text\nP1: Guard input\n  Intent: Closes #1 @admin ```\n# injected');
    expect(fenced('a ```` b')).toMatch(/^`````text\n/);
  });
  it('lists only item titles when the full plan is too long, and refuses when even that is too long', () => {
    const long: Plan = { ...plan, items: [{ ...plan.items[0]!, intent: 'x'.repeat(MAX_BODY) }] };
    const body = pullRequestBody({ plan: long, marker: 'm' });
    expect(body).toContain('items only');
    expect(body).not.toContain('Intent:');
    const huge: Plan = { ...plan, items: [{ ...plan.items[0]!, title: 'y'.repeat(MAX_BODY) }] };
    expect(() => pullRequestBody({ plan: huge, marker: 'm' })).toThrow(/too long/);
  });
  it('bounds the open problems it shows', () => {
    const body = pullRequestBody({ plan, marker: 'm', problems: Array.from({ length: 25 }, (_, i) => `problem ${i} ${'z'.repeat(3000)}`) });
    expect(body).toContain('(5 more in codeboost)');
    expect(body).not.toContain('problem 20 ');
    expect(body.length).toBeLessThan(MAX_BODY);
  });
  it('makes a one-line, bounded title', () => {
    expect(pullRequestTitle({ ...plan, summary: 'a\nb\u0007c' })).toBe('a b c (#12)');
    expect(pullRequestTitle({ ...plan, summary: 'w'.repeat(500) })).toHaveLength(200);
  });
});

describe('gh subprocess environment', () => {
  it('passes only the allowlisted variables, and turns prompts off', () => {
    const env = ghEnvironment({ PATH: '/bin', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'y', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 't', HOME: '/h', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' });
    expect(GH_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY' as never);
  });
});

describe('GitHub PR adapter', () => {
  const marker = '<!-- codeboost:opening=11111111-1111-4111-8111-111111111111 -->';
  const response = (over: Record<string, unknown> = {}) => ({ number: 7, html_url: 'https://github.com/owner/repo/pull/7', state: 'open', draft: true, body: `${marker}\nplan`,
    head: { sha: oid(2), ref: 'codeboost/issue-12-task', repo: { full_name: 'Owner/Repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, ...over });
  const input = { base: 'main', headBranch: 'codeboost/issue-12-task', title: 'T', body: `${marker}\nplan`, draft: true, marker };
  it('opens with literal argv and validates the answer', async () => {
    const calls: string[][] = [];
    const gh = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { calls.push([...args]); return JSON.stringify(response()); });
    expect(await gh.open(input)).toEqual({ number: 7, url: 'https://github.com/owner/repo/pull/7', headSha: oid(2), draft: true });
    expect(calls[0]).toEqual(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/owner/repo/pulls',
      '-f', 'title=T', '-f', `body=${marker}\nplan`, '-f', 'head=codeboost/issue-12-task', '-f', 'base=main', '-F', 'draft=true']);
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
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response({ number: 8 }))).refresh(7, { ...input, ready: false })).rejects.toThrow(/different/);
    // Closed between the lookup and the refresh: refused, so the task never moves to in review without an open PR.
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify(response({ state: 'closed' }))).refresh(7, { ...input, ready: false })).rejects.toThrow(/not open/);
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ state: 'closed' })])).findOpened(input)).rejects.toThrow(/not open/);
  });
  it('finds a lost PR only by its marker, and refuses a PR on the branch that codeboost did not open', async () => {
    const calls: string[][] = [];
    const found = new GhPullRequestGateway({ repository: 'owner/repo' }, async args => { calls.push([...args]); return JSON.stringify([response()]); });
    expect(await found.findOpened(input)).toMatchObject({ number: 7 });
    expect(calls[0]!.at(-1)).toBe('repos/owner/repo/pulls?state=open&head=owner%3Acodeboost%2Fissue-12-task&base=main&per_page=100');
    expect(await new GhPullRequestGateway({ repository: 'owner/repo' }, async () => '[]').findOpened(input)).toBeNull();
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response({ body: 'someone else' })])).findOpened(input)).rejects.toThrow(/did not open/);
    await expect(new GhPullRequestGateway({ repository: 'owner/repo' }, async () => JSON.stringify([response(), response()])).findOpened(input)).rejects.toThrow();
  });
});

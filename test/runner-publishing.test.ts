import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit as git } from './fixtures/git.ts';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import { Store } from '../runner/store.ts';
import type { ReviewService } from '../runner/review.ts';
import type { PreparedAttempt, RunnerDeps } from '../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../runner/execution.ts';
import { GitBranchPusher } from '../runner/branch-push.ts';
import { PullRequestPublisher } from '../runner/publish.ts';
import { ensureCommit, openRunnerRepository } from '../runner/runner-repository.ts';
import { baseBranch } from '../runner/production.ts';
import { PullRequestMisplaced, type OpenPullRequestInput, type PullRequestGateway } from '../github/pull-requests.ts';
import type { AlreadyFixedGateway } from '../github/already-fixed.ts';
import type { PlanIdentity } from '../core/identity.ts';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const OWNER = 'c'.repeat(32), REPO = 'acme/app';
type App = Awaited<ReturnType<typeof startServer>>;

interface Pr { number: number; url: string; draft: boolean; open: boolean; base: string; headBranch: string; marker: string; body: string }
/**
 * GitHub, as far as publishing sees it: pull requests in memory, and branches in a real local bare repository, so a PR's
 * head is whatever the push left on its branch. `onOpen` runs after GitHub created the PR and before the reply arrives.
 */
class FakeGitHub {
  prs: Pr[] = [];
  calls: string[] = [];
  onOpen?: (signal?: AbortSignal) => Promise<void>;
  onClose?: (number: number, signal?: AbortSignal) => Promise<void>;
  /** PRs GitHub's list does not show yet (it lags behind them). */
  hidden = new Set<number>();
  readonly remote: string;
  constructor(remote: string) { this.remote = remote; }
  head(branch: string): string | null {
    try { return git(this.remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); } catch { return null; }
  }
  #view(pr: Pr) { return { number: pr.number, url: pr.url, draft: pr.draft, headSha: this.head(pr.headBranch) ?? '' }; }
  checks: AlreadyFixedGateway = { repository: REPO, check: async () => { this.calls.push('check'); return { outcome: 'clear', baseHead: 'b'.repeat(40) }; } };
  pulls: PullRequestGateway = {
    repository: REPO,
    open: async (input: OpenPullRequestInput, signal?: AbortSignal) => {
      this.calls.push(`open ${input.draft ? 'draft' : 'ready'}`);
      if (this.head(input.headBranch) === null) throw new Error('No such branch on GitHub.');
      const pr: Pr = { number: 100 + this.prs.length, url: `https://github.com/${REPO}/pull/${100 + this.prs.length}`, draft: input.draft, open: true,
        base: input.base, headBranch: input.headBranch, marker: input.marker, body: input.body };
      this.prs.push(pr);
      await this.onOpen?.(signal);
      return this.#view(pr);
    },
    findOpened: async input => {
      const open = this.prs.filter(pr => pr.open && !this.hidden.has(pr.number) && pr.headBranch === input.headBranch);
      const own = open.filter(pr => input.markers.includes(pr.marker));
      if (own.length > 1 || (own[0] && own[0].base !== input.base)) throw new PullRequestMisplaced('The task\'s pull requests are not where it publishes.');
      if (open.some(pr => pr.base === input.base && !input.markers.includes(pr.marker))) throw new Error('An open pull request exists that codeboost did not open.');
      return own[0] ? { ...this.#view(own[0]), marker: own[0].marker } : null;
    },
    findOwned: async input => this.prs.filter(pr => pr.open && !this.hidden.has(pr.number) && pr.headBranch === input.headBranch && input.markers.includes(pr.marker))
      .map(pr => ({ ...this.#view(pr), marker: pr.marker, base: pr.base })),
    readPull: async number => { const pr = this.prs.find(candidate => candidate.number === number)!; return { open: pr.open, headBranch: pr.headBranch, base: pr.base, marker: pr.marker }; },
    // Like the adapter: read by number, closed is done, an open PR must still be the task's, then the re-check and close.
    close: async (number, input, signal) => {
      this.calls.push(`close ${number}`);
      const pr = this.prs.find(candidate => candidate.number === number)!;
      if (!pr.open) return { number, url: pr.url };
      if (pr.headBranch !== input.headBranch || pr.marker !== input.marker) throw new PullRequestMisplaced('Not the task\'s pull request.');
      input.beforeClose?.();
      await this.onClose?.(number, signal);
      pr.open = false;
      return { number, url: pr.url };
    },
    markDraft: async number => { const pr = this.prs.find(candidate => candidate.number === number)!; pr.draft = true; return this.#view(pr); },
    refresh: async (number, input) => {
      this.calls.push(`refresh ${input.draft ? 'draft' : 'ready'}`);
      const pr = this.prs.find(candidate => candidate.number === number)!;
      input.beforeReady?.();
      pr.body = input.body; pr.draft = input.draft;
      return this.#view(pr);
    },
  };
}

/** Every plan item completed, changing nothing: the task is running and its plan has run. */
function completeAll(service: ReviewService) {
  const s = service.store, id = service.config.identity, head = s.getSnapshot(id).head;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  for (const item of s.getPlan(id).items) {
    const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: item.id, expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
    s.markRunning(id, attempt.id);
    s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head, unchanged: true, inScope: [], outOfScope: [] } });
  }
  expect(s.getTask(id).status).toBe('running');
}
/**
 * Every plan item completed, but the last changed a file outside its plan item, and its pause for amendment was never
 * recorded (the write failed, or the process stopped): the next run owes that pause.
 */
function completeAllOwingPause(service: ReviewService) {
  const s = service.store, id = service.config.identity, head = s.getSnapshot(id).head, items = s.getPlan(id).items;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  for (const [index, item] of items.entries()) {
    const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: item.id, expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
    s.markRunning(id, attempt.id);
    s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
      result: { head, unchanged: true, inScope: [], outOfScope: index === items.length - 1 ? ['run.sh'] : [] } });
  }
  expect(s.getTask(id).status).toBe('running');
}
/** The first item failed with a 1 ms task budget, which has passed: the task is running, and its next admission is refused. */
function budgetSpent(service: ReviewService) {
  const s = service.store, id = service.config.identity;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  const admit = (budgetMs?: number) => s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
    expectedContext: s.currentContext(id), deadline: Date.now() + 60_000, ...(budgetMs ? { budgetMs } : {}) });
  const attempt = admit(1);
  s.markRunning(id, attempt.id);
  s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 1, valid: false, detail: 'The tests failed in retry.ts.' });
  const until = Date.now() + 5; while (Date.now() < until) { /* let the budget pass */ }
  return admit;
}
/** As production gets there: an admission after the budget passed moves the task to needs human, and is refused. */
function needsHuman(service: ReviewService) {
  const admit = budgetSpent(service);
  expect(() => admit()).toThrow(/time budget/);
  expect(service.store.getTask(service.config.identity).status).toBe('needs human');
}
const BUDGET = 'The task\'s time budget ran out before its plan finished.';
/** Wait until the startup publish (or any in progress) has settled, then return the GitHub calls made so far. */
async function quiet(app: App, w: World, identity: PlanIdentity) { await app.publishing!.settled(identity); return [...w.github.calls]; }

interface World { root: string; demo: ReturnType<typeof createDemo>; remote: string; github: FakeGitHub }
function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-publishing-')); roots.push(root);
  const demo = createDemo(join(root, 'demo')), remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  return { root, demo, remote, github: new FakeGitHub(remote) };
}

/**
 * A server whose runner completes every item it admits without an agent (each changes nothing), and publishes through the
 * real publisher and the real pusher into `w.remote`, with GitHub faked. `before` shapes the Store before the runner
 * exists, as an earlier process would have left it.
 */
async function serve(w: World, options: { before?: (service: ReviewService) => void; onPushSpawn?: (n: number, app: () => App, close: () => Promise<void>) => void; demo?: boolean; startup?: boolean; settleMs?: number; env?: NodeJS.ProcessEnv; hold?: Promise<void> } = {}) {
  let app: App | undefined, spawns = 0, closing: Promise<void> | undefined;
  const close = () => closing ??= app!.close();
  let branchOf: (identity: PlanIdentity) => string = () => '';
  const config = { ...w.demo, demo: options.demo ?? false };
  app = await startServer(config, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
    options.before?.(service);
    const repository = await openRunnerRepository({ runnerRoot: join(w.root, 'runner'), runnerOwner: OWNER, repositoryId: service.config.identity.repositoryId, source: service.config.repository });
    await ensureCommit(repository, service.store.getSnapshot(service.config.identity).head);
    const prepared: PreparedAttempt = { clone: { id: 'clone', taskId: 'task', directory: '/tmp/x', head: 'f'.repeat(40) }, vendor: 'claude', approvedArgv: [] };
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: ['execute'], prepare: async () => prepared, cleanupPreparation: async () => undefined,
      start: input => ({ attemptId: input.attemptId, cancel: () => undefined,
        // `hold`: the attempt keeps running until the test releases it.
        settled: (options.hold ?? Promise.resolve()).then(() => ({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: '', stderr: '' })) }),
      validate: () => ({ head: service.store.getSnapshot(service.config.identity).head, unchanged: true, inScope: [], outOfScope: [] }) };
    const sources: ExecutionSources = { planContext: () => service.planContext(), issue: () => ({ number: 3, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
    const pusher = new GitBranchPusher({ repository, repositoryId: service.config.identity.repositoryId, remote: REPO, url: w.remote,
      ownedCommits: identity => service.store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha),
      onProcessGroup: () => options.onPushSpawn?.(++spawns, () => app!, close) });
    const publisher = (closing: () => boolean) => new PullRequestPublisher(service.store, { checks: w.github.checks, pulls: w.github.pulls, pusher, closing }, { repository: REPO, baseBranch: 'main', ...(options.settleMs ? { settleMs: options.settleMs } : {}) });
    branchOf = identity => publisher(() => false).branch(identity);
    return { deps, sources, findings: new SafetyFindings(service.store), publisher, ...(options.env ? { env: options.env } : {}),
      recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  });
  cleanups.push(close);
  // As the CLI does once it has verified the lock.
  if (options.startup !== false) app.publishOwed();
  const identity = w.demo.identity;
  return { app, close, identity, store: app.service.store, branch: branchOf(identity), head: app.service.store.getSnapshot(identity).head };
}
const view = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
async function act(app: App, action: string, actionId = randomUUID(), expectedStateVersion?: number) {
  const { stateVersion } = await view(app);
  const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, expectedStateVersion: expectedStateVersion ?? stateVersion, actionId }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const publishSettled = (app: App, identity: PlanIdentity) => vi.waitFor(async () => {
  expect(app.publishing!.busy(identity)).toBe(false);
  expect(app.service.store.lastPublish(identity)).not.toBeNull();
}, { timeout: 20_000, interval: 20 });

describe('publishing a finished task (#103)', () => {
  it('opens one ready pull request when a run completes the plan, with the branch at the task head', async () => {
    const w = world();
    const { app, close, identity, store, branch, head } = await serve(w);
    expect((await view(app)).publish).toMatchObject({ available: true, publishable: false, last: null });
    expect((await act(app, 'start')).body.result).toMatchObject({ outcome: 'started' });
    await publishSettled(app, identity);
    expect(w.github.prs).toHaveLength(1);
    expect(w.github.prs[0]).toMatchObject({ draft: false, base: 'main', headBranch: branch, open: true });
    expect(w.github.head(branch)).toBe(head);
    expect(store.getTask(identity).status).toBe('in review');
    expect((await view(app)).publish).toMatchObject({ active: false, publishable: false,
      last: { outcome: 'opened', draft: false, number: 100, url: `https://github.com/${REPO}/pull/100` } });
    // Nothing is owed any more: a restart publishes nothing (no check, no open, no refresh).
    await close();
    const calls = [...w.github.calls], again = await serve(w);
    expect(again.app.publishing!.busy(identity)).toBe(false);
    expect(await quiet(again.app, w, identity)).toEqual(calls);
  });

  it('opens a draft pull request with its problems for a task that needs a person', async () => {
    const w = world();
    const { app, identity, store, branch, head } = await serve(w, { before: needsHuman });
    await publishSettled(app, identity);
    expect(w.github.prs).toHaveLength(1);
    expect(w.github.prs[0]).toMatchObject({ draft: true, headBranch: branch });
    expect(w.github.prs[0]!.body).toContain(BUDGET);
    expect(w.github.head(branch)).toBe(head);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true, number: 100 });
  });

  it('leaves a task whose branch holds someone else\'s commit running, and the publish action retries once a person fixed it', async () => {
    const v = world();
    // A person pushed the base commit (not codeboost's) to the task's branch before the publish.
    const s2 = await serve(v, { before: service => {
      completeAll(service);
      const name = new PullRequestPublisher(service.store, { checks: v.github.checks, pulls: v.github.pulls, pusher: { push: async () => undefined } }, { repository: REPO, baseBranch: 'main' }).branch(service.config.identity);
      git(v.demo.repository, '-c', 'protocol.file.allow=always', 'push', '-q', v.remote, `${service.store.getSnapshot(service.config.identity).base}:refs/heads/${name}`);
    } });
    await publishSettled(s2.app, s2.identity);
    expect(s2.store.lastPublish(s2.identity)).toMatchObject({ outcome: 'refused', draft: false, message: expect.stringMatching(/which codeboost did not make\. Nothing was pushed\./) });
    expect(s2.store.getTask(s2.identity).status).toBe('running');
    expect(v.github.prs).toHaveLength(0);
    expect((await view(s2.app)).publish).toMatchObject({ active: false, publishable: true, last: { outcome: 'refused' } });
    // A person deletes the branch; the publish action runs again.
    git(v.remote, 'update-ref', '-d', `refs/heads/${s2.branch}`);
    const actionId = randomUUID(), version = s2.store.getTask(s2.identity).stateVersion;
    expect(await act(s2.app, 'publish', actionId, version)).toMatchObject({ status: 200, body: { result: { outcome: 'publishing', draft: false } } });
    expect((await view(s2.app)).publish).toMatchObject({ active: true });
    await s2.app.publishing!.settled(s2.identity);
    expect(s2.store.lastPublish(s2.identity)).toMatchObject({ outcome: 'opened', draft: false });
    expect(v.github.head(s2.branch)).toBe(s2.head);
    expect(s2.store.getTask(s2.identity).status).toBe('in review');
    // The same action ID replays the publish's outcome, not "publishing", and publishes nothing again.
    const calls = [...v.github.calls];
    expect((await act(s2.app, 'publish', actionId, version)).body.result).toMatchObject({ outcome: 'opened', draft: false, number: 100 });
    expect(s2.app.publishing!.busy(s2.identity)).toBe(false);
    expect(v.github.calls).toEqual(calls);
  });

  it('refuses the publish action while nothing can be published, and records the refusal', async () => {
    const w = world();
    const { app } = await serve(w);
    const refused = await act(app, 'publish');
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/The task is in review/) } });
    expect(w.github.calls).toEqual([]);
  });

  it('closes the Store only after a publish stopped during its push has settled, and the next start publishes once', async () => {
    const w = world();
    let closedWhileBusy: boolean | undefined;
    const first = await serve(w, { before: completeAll, onPushSpawn: (n, app, close) => {
      // The third Git call is the push (after the commit check and the read of the remote).
      if (n !== 3) return;
      const service = app().service, closeStore = service.close.bind(service);
      service.close = () => { closedWhileBusy = app().publishing!.busy(w.demo.identity); closeStore(); };
      void close();
    } });
    await vi.waitFor(() => expect(closedWhileBusy).toBe(false), { timeout: 20_000 });
    const store = new Store(w.demo.database);
    try { expect(store.lastPublish(first.identity)).toMatchObject({ outcome: 'stopped', draft: false }); } finally { store.close(); }
    expect(w.github.prs).toHaveLength(0);
    const second = await serve(w);
    await publishSettled(second.app, second.identity);
    expect(second.store.lastPublish(second.identity)).toMatchObject({ outcome: 'opened' });
    expect(w.github.prs).toHaveLength(1);
    expect(w.github.head(second.branch)).toBe(second.head);
  });

  it('keeps an opening whose reply was lost to shutdown, and the next start recovers it by its marker', async () => {
    const w = world();
    let closedWhileBusy: boolean | undefined;
    let appRef: App | undefined, closeApp: (() => Promise<void>) | undefined;
    // GitHub created the PR; shutdown aborts the call before its reply arrives.
    w.github.onOpen = signal => new Promise((_, reject) => {
      const service = appRef!.service, closeStore = service.close.bind(service);
      service.close = () => { closedWhileBusy = appRef!.publishing!.busy(w.demo.identity); closeStore(); };
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      void closeApp!();
    });
    const first = await serve(w, { before: completeAll, onPushSpawn: (_, app, close) => { appRef = app(); closeApp = close; } });
    await vi.waitFor(() => expect(closedWhileBusy).toBe(false), { timeout: 20_000 });
    const store = new Store(w.demo.database);
    try {
      expect(store.lastPublish(first.identity)).toMatchObject({ outcome: 'stopped' });
      expect(store.taskPullRequests(first.identity)).toMatchObject([{ state: 'opening' }]);
    } finally { store.close(); }
    expect(w.github.prs).toHaveLength(1);
    w.github.onOpen = undefined;
    const second = await serve(w);
    await publishSettled(second.app, second.identity);
    // Recovered, not opened again.
    expect(w.github.prs).toHaveLength(1);
    expect(second.store.taskPullRequests(second.identity)).toMatchObject([{ state: 'opened', number: 100 }]);
    expect(second.store.getTask(second.identity).status).toBe('in review');
    expect(second.store.lastPublish(second.identity)).toMatchObject({ outcome: 'opened', number: 100 });
  });

  it('names the current attempt\'s safety finding in the draft, even when the budget has also run out', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000, budgetMs: 1 });
      s.markRunning(id, attempt.id);
      s.recordSafetyFinding(id, attempt.id, 'P1 wrote to a path outside its workspace.');
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: false });
      const until = Date.now() + 5; while (Date.now() < until) { /* let the budget pass */ }
    } });
    expect(store.getTask(identity).status).toBe('needs human');
    await publishSettled(app, identity);
    expect(w.github.prs).toHaveLength(1);
    expect(w.github.prs[0]!.body).toContain('P1 wrote to a path outside its workspace.');
    expect(w.github.prs[0]!.body).not.toContain(BUDGET);
  });

  it('publishes a draft when a resume is refused because the budget ran out, which moves the task to needs human', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: service => { budgetSpent(service); } });
    expect(store.getTask(identity).status).toBe('running');
    expect(await act(app, 'resume')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/time budget/) } });
    expect(store.getTask(identity).status).toBe('needs human');
    await publishSettled(app, identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining(BUDGET) })]);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
  });

  it('publishes nothing when resume is refused for a task already in needs human, though its last publish was refused', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { startup: false, before: service => {
      needsHuman(service);
      service.store.recordPublish(service.config.identity, { outcome: 'refused', draft: true, message: 'The branch moved.' });
    } });
    expect(await act(app, 'resume')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/needs human/) } });
    expect(app.publishing!.busy(identity)).toBe(false);
    expect(w.github.calls).toEqual([]);
    // The publish action is how a person retries it.
    expect(await act(app, 'publish')).toMatchObject({ status: 200, body: { result: { outcome: 'publishing', draft: true } } });
    await app.publishing!.settled(identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
  });

  it('refuses start, resume and a second publish while a publish runs, and records the publish refusal', async () => {
    const w = world();
    const opening = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    w.github.onOpen = async () => { opening.resolve(); await release.promise; };
    const { app, identity, store } = await serve(w, { before: completeAll });
    await opening.promise;
    expect((await view(app)).publish).toMatchObject({ active: true, publishable: false });
    for (const action of ['start', 'resume'])
      expect(await act(app, action)).toMatchObject({ status: 409, body: { error: 'A pull request is being published for this task; try again when it has finished.' } });
    const actionId = randomUUID(), version = store.getTask(identity).stateVersion;
    const second = await act(app, 'publish', actionId, version);
    expect(second).toMatchObject({ status: 409, body: { error: 'A pull request is already being published for this task.' } });
    release.resolve();
    await app.publishing!.settled(identity);
    expect(store.getAttempts(identity)).toHaveLength(3);
    // The refusal was recorded: the same action ID replays it, and starts nothing.
    expect(await act(app, 'publish', actionId, version)).toMatchObject({ status: 409, body: second.body });
    expect(w.github.prs).toHaveLength(1);
  });

  it('awaits a publish stopped by shutdown before the write gate closes, so a PR GitHub opened as the abort came is recorded', async () => {
    const w = world();
    let appRef: App | undefined, closeApp: (() => Promise<void>) | undefined;
    // GitHub's reply arrives a moment after shutdown aborted the call: the publisher records the PR it opened.
    w.github.onOpen = signal => new Promise(resolve => {
      signal!.addEventListener('abort', () => setTimeout(resolve, 300), { once: true });
      void closeApp!();
    });
    const first = await serve(w, { before: completeAll, onPushSpawn: (_, app, close) => { appRef = app(); closeApp = close; } });
    await vi.waitFor(() => expect(appRef?.publishing?.busy(first.identity)).toBe(false), { timeout: 20_000 });
    await closeApp!();
    const store = new Store(w.demo.database);
    try { expect(store.taskPullRequests(first.identity)).toMatchObject([{ state: 'opened', number: 100 }]); } finally { store.close(); }
  });

  it('removes the publishing environment\'s token values from a recorded failure', async () => {
    const w = world(), token = 'not-a-github-shaped-secret-4711';
    w.github.onOpen = async () => { throw new Error(`gh failed: Authorization: token ${token}`); };
    const { app, identity, store } = await serve(w, { before: completeAll, env: { GH_ENTERPRISE_TOKEN: token } });
    await publishSettled(app, identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', message: 'gh failed: Authorization: token [token]' });
  });

  describe('a publish\'s in-flight record', () => {
    it('is written before any GitHub call', async () => {
      const w = world();
      let seen: unknown;
      const opening = Promise.withResolvers<void>();
      w.github.checks.check = async () => { opening.resolve(); return { outcome: 'clear', baseHead: 'b'.repeat(40) }; };
      const { app, identity, store } = await serve(w, { before: completeAll, startup: false });
      app.publishOwed();
      seen = store.lastPublish(identity)?.outcome;
      await opening.promise;
      expect(seen).toBe('publishing');
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened' });
    });
    it('left by a process that stopped after the PR opened is settled as interrupted at startup', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: service => {
        completeAll(service);
        const s = service.store, id = service.config.identity;
        // The crashed process recorded its publish as started; its outcome never landed, and nothing is owed now.
        s.recordPublish(id, { outcome: 'publishing', draft: false, message: 'A pull request is being published.' });
        s.cancelTask(id, s.getTask(id).stateVersion, randomUUID());
      } });
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'stopped', message: expect.stringMatching(/interrupted before it recorded an outcome/) });
      expect(app.publishing!.busy(identity)).toBe(false);
      expect(w.github.calls).toEqual([]);
    });
    it('starts no publish when it cannot be written', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: completeAll, startup: false });
      vi.spyOn(store, 'recordPublish').mockImplementationOnce(() => { throw new Error('disk full'); });
      app.publishOwed();
      await app.publishing!.settled(identity);
      expect(w.github.calls).toEqual([]);
      expect(store.lastPublish(identity)).toBeNull();
    });
  });

  describe('a publish action whose process stopped before its outcome was recorded', () => {
    /** As the crashed process left it: the action committed its `publishing` reply, and its publish recorded nothing. */
    const plant = (service: ReviewService, actionId: string) => {
      const s = service.store, id = service.config.identity, expectedStateVersion = s.getTask(id).stateVersion;
      s.userAction(id, { actionId, kind: 'publish', request: { attemptId: undefined, expectedStateVersion } }, () => ({ outcome: 'publishing', draft: false }));
      return expectedStateVersion;
    };
    it('is settled by the startup publish when one is owed, so its replay reports that outcome', async () => {
      const w = world(), actionId = randomUUID();
      let version = -1;
      const { app, identity, store } = await serve(w, { before: service => { completeAll(service); version = plant(service, actionId); } });
      await publishSettled(app, identity);
      expect(store.hasUnsettledPublishAction(identity)).toBe(false);
      expect((await act(app, 'publish', actionId, version)).body.result).toMatchObject({ outcome: 'opened', draft: false, number: 100 });
      expect(w.github.prs).toHaveLength(1);
    });
    it('is settled as interrupted at startup when nothing is owed, instead of replaying `publishing` for ever', async () => {
      const w = world(), actionId = randomUUID();
      let version = -1;
      const { app, identity, store } = await serve(w, { before: service => {
        completeAll(service); version = plant(service, actionId);
        // Meanwhile the task left what a publish serves (a person cancelled it), so nothing is owed at startup.
        service.store.cancelTask(service.config.identity, service.store.getTask(service.config.identity).stateVersion, randomUUID());
      } });
      expect(store.hasUnsettledPublishAction(identity)).toBe(false);
      expect((await act(app, 'publish', actionId, version)).body.result).toMatchObject({ outcome: 'stopped', message: expect.stringMatching(/interrupted before it recorded an outcome/) });
      expect(w.github.calls).toEqual([]);
    });
  });

  it('pays a scope pause an earlier run owes instead of publishing its unreviewed changes as ready, at startup', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: completeAllOwingPause });
    await app.publishing!.settled(identity);
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(w.github.calls).toEqual([]);
    expect(store.lastPublish(identity)).toBeNull();
  });
  it('refuses the publish action while a scope pause is owed, and pays it', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: completeAllOwingPause, startup: false });
    expect((await view(app)).publish).toMatchObject({ publishable: false });
    expect(await act(app, 'publish')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/scope pause that has not been acted on/) } });
    expect(store.getTask(identity).status).toBe('needs amendment');
    await app.publishing!.settled(identity);
    expect(w.github.calls).toEqual([]);
  });

  describe('round 1 of the independent review', () => {
    it('starts nothing when the publish action is refused for a stale view, though a publish is owed', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: service => {
        completeAll(service);
        service.store.recordPublish(service.config.identity, { outcome: 'refused', draft: false, message: 'The branch moved.' });
      }, startup: false });
      const stale = store.getTask(identity).stateVersion - 1;
      expect(await act(app, 'publish', randomUUID(), stale)).toMatchObject({ status: 409, body: { error: 'Stale task state. Reload before writing.' } });
      expect(app.publishing!.busy(identity)).toBe(false);
      expect(w.github.calls).toEqual([]);
    });
    it('keeps a task recorded as not published at the upgrade unpublished at startup, after unrelated changes', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: service => {
        completeAll(service);
        const s = service.store, id = service.config.identity;
        s.recordPublish(id, { outcome: 'not published', draft: false, message: 'Before publishing existed.' });
        // An unrelated change since moves the task's state version.
        s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
      } });
      await app.publishing!.settled(identity);
      expect(w.github.calls).toEqual([]);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'not published' });
    });
    it('still settles a leftover in-flight record at startup when paying owed work fails', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { startup: false, before: service => {
        const s = service.store, id = service.config.identity;
        s.recordPublish(id, { outcome: 'publishing', draft: false, message: 'A pull request is being published.' });
      } });
      vi.spyOn(app.executor!, 'payOwed').mockImplementation(() => { throw new Error('The snapshot of P1\'s commit is missing.'); });
      app.publishOwed();
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'stopped' });
    });
    it('settles only a stuck reply with the outcome on record, leaving that record as it is', async () => {
      const w = world(), actionId = randomUUID();
      const first = await serve(w, { before: completeAll });
      await publishSettled(first.app, first.identity);
      const opened = first.store.lastPublish(first.identity)!;
      expect(opened).toMatchObject({ outcome: 'opened', number: 100 });
      // A publish action committed its reply, and the process stopped before that publish recorded itself as started.
      const version = first.store.getTask(first.identity).stateVersion;
      first.store.userAction(first.identity, { actionId, kind: 'publish', request: { attemptId: undefined, expectedStateVersion: version } }, () => ({ outcome: 'publishing', draft: false }));
      await first.close();
      const second = await serve(w);
      expect(second.store.lastPublish(second.identity)).toEqual(opened);
      expect((await act(second.app, 'publish', actionId, version)).body.result).toMatchObject({ outcome: 'opened', number: 100 });
    });
    it('retries a publish refused while a lost opening settles, at that opening\'s deadline', async () => {
      const w = world();
      // The first publish's opening reply is lost: GitHub created the PR, its list does not show it yet.
      w.github.onOpen = async () => { w.github.hidden.add(w.github.prs.at(-1)!.number); throw new Error('timed out'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 2_500 });
      await publishSettled(app, identity);
      expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opening' }]);
      w.github.onOpen = undefined;
      // Asked again at once: the opening is still settling, so this publish is refused.
      await act(app, 'publish');
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused' }), { timeout: 5_000 });
      w.github.hidden.clear();
      // Retried by itself at the deadline: the lost opening's PR is recovered by its marker, not opened again.
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', number: 100 }), { timeout: 8_000, interval: 50 });
      expect(w.github.prs).toHaveLength(1);
    });
  });

  it('never publishes in a demo, even with a publisher', async () => {
    const w = world();
    const { app } = await serve(w, { demo: true, before: completeAll });
    expect(app.publishing).toBeNull();
    expect((await view(app)).publish).toMatchObject({ available: false });
    expect(await act(app, 'publish')).toMatchObject({ status: 409 });
    expect(w.github.calls).toEqual([]);
  });
});

describe('github.baseBranch', () => {
  it('is required, and refused when Git would refuse it as a branch name', () => {
    expect(baseBranch({ baseBranch: 'main' })).toBe('main');
    expect(baseBranch({ baseBranch: 'release/2.x' })).toBe('release/2.x');
    for (const bad of [undefined, '', '-main', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', 'a/.b', 'a@{b', 'a b', 'a\nb'])
      expect(() => baseBranch({ baseBranch: bad })).toThrow(/github\.baseBranch/);
    expect(() => baseBranch(undefined)).toThrow(/github\.baseBranch/);
  });
});

describe('closing a cancelled task\'s pull requests (#111)', () => {
  const closedRecord = { outcome: 'closed', action: 'close' };
  it('closes a ready PR when a task in review is cancelled, and keeps the branch', async () => {
    const w = world();
    const { app, identity, store, branch, head } = await serve(w, { before: completeAll });
    await publishSettled(app, identity);
    expect(store.getTask(identity).status).toBe('in review');
    expect((await act(app, 'cancel-task')).body.result).toEqual({ outcome: 'closed' });
    await app.publishing!.settled(identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ number: 100, open: false, draft: false })]);
    expect(w.github.head(branch)).toBe(head);
    expect(store.getTask(identity).status).toBe('cancelled');
    expect(store.lastPublish(identity)).toMatchObject({ ...closedRecord, message: 'Pull request #100 closed; the task\'s branch is kept.' });
    // Nothing is owed after a close that closed them.
    expect((await view(app)).publish).toMatchObject({ active: false, closable: false, publishable: false });
    // Nothing is owed any more: a restart closes nothing.
    await app.publishing!.settled(identity);
    const calls = [...w.github.calls];
    const again = await serve(w);
    expect(await quiet(again.app, w, identity)).toEqual(calls);
  });

  it('closes the draft PR of a cancelled needs-human task', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: needsHuman });
    await publishSettled(app, identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, open: true })]);
    await act(app, 'cancel-task');
    await app.publishing!.settled(identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, open: false })]);
    expect(store.lastPublish(identity)).toMatchObject(closedRecord);
  });

  it('cancels at once during a draft opening, stops the publish, and closes the PR GitHub opened meanwhile', async () => {
    const w = world();
    const opening = Promise.withResolvers<void>();
    // GitHub creates the PR; the reply never arrives before the cancel aborts the call.
    w.github.onOpen = signal => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      opening.resolve();
    });
    const { app, identity, store } = await serve(w, { before: needsHuman });
    await opening.promise;
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opening' }]);
    const records = vi.spyOn(store, 'recordPublish');
    // The cancel is not refused and does not wait for GitHub.
    expect(await act(app, 'cancel-task')).toMatchObject({ status: 200, body: { result: { outcome: 'closed' } } });
    expect(store.getTask(identity).status).toBe('cancelled');
    await app.publishing!.settled(identity);
    // The publish was recorded as stopped by the cancel, then the close: in flight, then done.
    expect(records.mock.calls.map(call => [call[1].outcome, call[1].action])).toEqual([['stopped', undefined], ['closing', 'close'], ['closed', 'close']]);
    expect(records.mock.calls[0]![1].message).toBe('The task was cancelled; its pull requests are closed instead.');
    // Recovered by its marker, recorded, and closed.
    expect(w.github.prs).toEqual([expect.objectContaining({ number: 100, open: false })]);
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: 100 }]);
    expect(store.lastPublish(identity)).toMatchObject({ ...closedRecord, message: expect.stringMatching(/^Pull request #100 closed/) });
    expect(store.getTask(identity).status).toBe('cancelled');
  });

  it('records a failed close as owed, and the close-pull-requests action retries it; its replay reports the outcome', async () => {
    const w = world();
    let fail = true;
    w.github.onClose = async () => { if (fail) { fail = false; throw new Error('GitHub is down.'); } };
    const { app, identity, store } = await serve(w, { before: needsHuman });
    await publishSettled(app, identity);
    await act(app, 'cancel-task');
    await app.publishing!.settled(identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', action: 'close', message: 'GitHub is down.' });
    expect(w.github.prs[0]!.open).toBe(true);
    expect((await view(app)).publish).toMatchObject({ closable: true, last: { outcome: 'failed' } });
    const actionId = randomUUID(), version = store.getTask(identity).stateVersion;
    expect(await act(app, 'close-pull-requests', actionId, version)).toMatchObject({ status: 200, body: { result: { outcome: 'closing' } } });
    await app.publishing!.settled(identity);
    expect(w.github.prs[0]!.open).toBe(false);
    expect((await act(app, 'close-pull-requests', actionId, version)).body.result).toMatchObject(closedRecord);
  });

  it('closes the PRs at the next start when shutdown stopped the close', async () => {
    const w = world();
    let closeApp: (() => Promise<void>) | undefined, first = true;
    w.github.onClose = (_, signal) => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise((_, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); void closeApp!(); });
    };
    const s1 = await serve(w, { before: needsHuman });
    await publishSettled(s1.app, s1.identity);
    closeApp = s1.close;
    await act(s1.app, 'cancel-task');
    await vi.waitFor(() => expect(first).toBe(false));
    await closeApp();
    const store = new Store(w.demo.database);
    try { expect(store.lastPublish(s1.identity)).toMatchObject({ outcome: 'stopped', action: 'close' }); } finally { store.close(); }
    expect(w.github.prs[0]!.open).toBe(true);
    const s2 = await serve(w);
    await s2.app.publishing!.settled(s2.identity);
    expect(w.github.prs[0]!.open).toBe(false);
    expect(s2.store.lastPublish(s2.identity)).toMatchObject(closedRecord);
  });

  it('closes a recorded PR that GitHub\'s list does not show yet, by its number', async () => {
    const w = world();
    const { app, identity, store } = await serve(w, { before: needsHuman });
    await publishSettled(app, identity);
    w.github.hidden.add(100);
    await act(app, 'cancel-task');
    await app.publishing!.settled(identity);
    expect(w.github.prs[0]!.open).toBe(false);
    expect(store.lastPublish(identity)).toMatchObject(closedRecord);
  });

  it('starts no close when a cancel is replayed or refused, though a close is owed', async () => {
    const w = world();
    w.github.onClose = async () => { throw new Error('GitHub is down.'); };
    const { app, identity, store } = await serve(w, { before: needsHuman });
    await publishSettled(app, identity);
    const actionId = randomUUID(), version = store.getTask(identity).stateVersion;
    await act(app, 'cancel-task', actionId, version);
    await app.publishing!.settled(identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', action: 'close' });
    const calls = [...w.github.calls];
    expect((await act(app, 'cancel-task', actionId, version)).body.result).toEqual({ outcome: 'closed' });
    expect(await act(app, 'cancel-task')).toMatchObject({ status: 409, body: { error: 'The task is already closed.' } });
    expect(app.publishing!.busy(identity)).toBe(false);
    expect(w.github.calls).toEqual(calls);
  });

  it('retries a close refused while the cancelled opening settles, and closes the PR GitHub showed late', async () => {
    const w = world();
    const opening = Promise.withResolvers<void>();
    let late: Pr | undefined;
    // GitHub creates the PR, but its list does not show it until after the first close was refused.
    w.github.onOpen = signal => new Promise((_, reject) => {
      late = w.github.prs.at(-1); w.github.hidden.add(late!.number);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      opening.resolve();
    });
    const { app, identity, store } = await serve(w, { before: needsHuman, settleMs: 300 });
    await opening.promise;
    await act(app, 'cancel-task');
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', action: 'close' }), { timeout: 10_000 });
    w.github.hidden.delete(late!.number);
    // Retried by itself once the opening has settled (300 ms + 1 s here).
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 10_000, interval: 50 });
    expect(late!.open).toBe(false);
    expect(store.taskPullRequests(identity)).toMatchObject([{ state: 'opened', number: late!.number }]);
  });

  it('retries a refused close at the opening\'s own settle deadline, not a fresh settle time from the cancel', async () => {
    const w = world();
    const opening = Promise.withResolvers<void>();
    let late: Pr | undefined;
    w.github.onOpen = signal => new Promise((_, reject) => {
      late = w.github.prs.at(-1); w.github.hidden.add(late!.number);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      opening.resolve();
    });
    const { app, identity, store } = await serve(w, { before: needsHuman, settleMs: 8_000 });
    await opening.promise;
    // The opening is already about 6.5 s old (of its 8 s) when the task is cancelled.
    await new Promise(resolve => setTimeout(resolve, 6_500));
    await act(app, 'cancel-task');
    const cancelled = Date.now();
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', action: 'close' }), { timeout: 5_000 });
    w.github.hidden.delete(late!.number);
    // About 1.5 s left plus the 1 s margin: closed well before a fresh 8 s window (9 s) would have retried it.
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 6_000, interval: 50 });
    expect(Date.now() - cancelled).toBeLessThan(7_000);
    expect(late!.open).toBe(false);
  });

  it('cancels promptly while an attempt runs, closes nothing until it settles, then closes the PR', async () => {
    const w = world(), hold = Promise.withResolvers<void>();
    const { app, identity, store } = await serve(w, { hold: hold.promise, before: service => {
      // The first item failed and the task went to a person (no budget involved), so a draft PR is published at startup.
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id);
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 1, valid: false, detail: 'The tests failed.' });
      s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
    } });
    await publishSettled(app, identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, open: true })]);
    // A person sends it back to the queue and resumes it; the attempt keeps running.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started' });
    const calls = [...w.github.calls];
    expect((await act(app, 'cancel-task')).body.result).toEqual({ outcome: 'stopping' });
    // Nothing is closed while the attempt runs: the task is not cancelled until it settles.
    expect(store.getTask(identity).status).not.toBe('cancelled');
    expect(app.publishing!.busy(identity)).toBe(false);
    expect(w.github.calls).toEqual(calls);
    expect(w.github.prs[0]!.open).toBe(true);
    hold.resolve();
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 20_000, interval: 50 });
    expect(store.getTask(identity).status).toBe('cancelled');
    expect(w.github.prs[0]!.open).toBe(false);
  });

  it('runs a close asked for after a PR was reopened, when its process stopped before it recorded anything', async () => {
    const w = world(), actionId = randomUUID();
    const first = await serve(w, { before: needsHuman });
    await publishSettled(first.app, first.identity);
    await act(first.app, 'cancel-task');
    await first.app.publishing!.settled(first.identity);
    expect(first.store.lastPublish(first.identity)).toMatchObject(closedRecord);
    await first.close();
    // A person reopens the PR and asks for a close; that process stops right after saving the action.
    w.github.prs[0]!.open = true;
    const crashed = new Store(w.demo.database);
    let version = -1;
    try {
      version = crashed.getTask(first.identity).stateVersion;
      crashed.userAction(first.identity, { actionId, kind: 'close-pull-requests', request: { attemptId: undefined, expectedStateVersion: version } }, () => ({ outcome: 'closing' }));
    } finally { crashed.close(); }
    const second = await serve(w);
    await second.app.publishing!.settled(second.identity);
    expect(w.github.prs[0]!.open).toBe(false);
    expect((await act(second.app, 'close-pull-requests', actionId, version)).body.result).toMatchObject({ outcome: 'closed', action: 'close' });
  });

  it('calls GitHub for nothing when a task without any PR is cancelled, and each action refuses the other\'s status', async () => {
    const w = world();
    const { app, identity, store } = await serve(w);
    expect(await act(app, 'close-pull-requests')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/only a cancelled task's pull requests are closed/) } });
    await act(app, 'cancel-task');
    expect(app.publishing!.busy(identity)).toBe(false);
    expect(w.github.calls).toEqual([]);
    expect(store.lastPublish(identity)).toBeNull();
    expect(await act(app, 'close-pull-requests')).toMatchObject({ status: 409, body: { error: 'The task has no pull request to close.' } });
    expect(await act(app, 'publish')).toMatchObject({ status: 409, body: { error: 'The task is cancelled; its pull requests are closed, not published.' } });
  });
});

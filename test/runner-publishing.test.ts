import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit as git } from './fixtures/git.ts';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import { Store, type PublishRecord } from '../runner/store.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import type { ReviewService } from '../runner/review.ts';
import type { PreparedAttempt, RunnerCoordinator, RunnerDeps } from '../runner/coordinator.ts';
import { SafetyFindings, executionDeps, type ExecutionSources, type TaskWorkspace } from '../runner/execution.ts';
import { GitBranchPusher } from '../runner/branch-push.ts';
import { PullRequestPublisher } from '../runner/publish.ts';
import { ensureCommit, openRunnerRepository } from '../runner/runner-repository.ts';
import { baseBranch } from '../runner/production.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { MergeSubmissionError, type MergeGateway } from '../github/merge.ts';
import { OWED_REFUSAL } from '../runner/publishing.ts';
import { PullRequestMisplaced, openingMarker, type OpenPullRequestInput, type PullRequestGateway } from '../github/pull-requests.ts';
import type { AlreadyFixedGateway } from '../github/already-fixed.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { approveItem } from '../core/approvals.ts';
import { GhIssueGateway, type IssueTrustGateway } from '../github/issues.ts';
import type { PreMergeCoordinator } from '../runner/pre-merge.ts';
import { MergeJobCoordinator, SETTLED_BEFORE_JOB_MERGE, type MergeJobTiming } from '../runner/merge-job.ts';
import type { RemoteMergeState, RequiredCheck } from '../github/merge.ts';
import { RemoteTimeout } from '../github/timeout.ts';
import { CommandFailed } from '../github/run-with-input.ts';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const OWNER = 'c'.repeat(32), REPO = 'acme/app';
type App = Awaited<ReturnType<typeof startServer>>;
type FindingSource = 'audit' | 'preparation' | 'failed-run audit';
const FINDINGS: Record<FindingSource, string> = {
  audit: 'Safety violation: The change inspection refused: "audit inspection failed"',
  preparation: 'Safety violation: A declared link goes through another link, so a write through it would land outside its target: "retry.ts".',
  'failed-run audit': 'Safety violation: The change inspection refused: "failed-run inspection failed"',
};
const FINDING_DIAGNOSTICS: Record<FindingSource, string> = {
  audit: FINDINGS.audit,
  preparation: `Preparation failed: ${JSON.stringify(FINDINGS.preparation)}`,
  'failed-run audit': '"agent crashed"',
};

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
  /** Runs inside a draft change, before it applies; a throw fails the change. */
  onDraft?: () => void;
  /** PRs GitHub's list does not show yet (it lags behind them). */
  hidden = new Set<number>();
  readonly remote: string;
  constructor(remote: string) { this.remote = remote; }
  head(branch: string): string | null {
    try { return git(this.remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); } catch { return null; }
  }
  /** The next answer about a PR shows this head instead of the branch's (GitHub lags behind a push), once. */
  staleHeadOnce?: string;
  #view(pr: Pr) {
    const stale = this.staleHeadOnce; this.staleHeadOnce = undefined;
    return { number: pr.number, url: pr.url, draft: pr.draft, headSha: stale ?? this.head(pr.headBranch) ?? '' };
  }
  checks: AlreadyFixedGateway = { repository: REPO, check: async () => { this.calls.push('check'); return { outcome: 'clear', baseHead: 'b'.repeat(40) }; } };
  pulls: PullRequestGateway = {
    repository: REPO,
    open: async (input: OpenPullRequestInput, signal?: AbortSignal) => {
      const finalize = await input.beforeOpen?.(); finalize?.();
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
    markDraft: async (number, input) => { const finalize = await input.beforeDraft?.(); finalize?.(); this.onDraft?.(); const pr = this.prs.find(candidate => candidate.number === number)!; pr.draft = true; return this.#view(pr); },
    refresh: async (number, input) => {
      const finalizePatch = await input.beforePatch?.(); finalizePatch?.();
      this.calls.push(`refresh ${input.draft ? 'draft' : 'ready'}`);
      const pr = this.prs.find(candidate => candidate.number === number)!;
      const finalizeReady = await input.beforeReady?.(); finalizeReady?.();
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
/** One old-revision checkpoint plus a complete amended suffix, all at the unchanged base head. */
function completeContinuation(service: ReviewService) {
  const s = service.store, id = service.config.identity, initial = s.getSnapshot(id), plan = s.getPlan(id);
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  const first = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: plan.items[0]!.id,
    expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
  s.markRunning(id, first.id);
  s.settleAttempt(id, first.id, { firstReason: null, exitCode: 0, valid: true,
    result: { head: initial.head, unchanged: true, inScope: [], outOfScope: [] } });
  const entries = [...service.planContext().baseEntries, { path: 'extra.ts', kind: 'file' as const }];
  const checkpoint = s.recordCheckpoint(id, { revision: 1, snapshotId: s.getSnapshot(id).id, reviewVersion: s.reviewVersion(id) }, {
    item: plan.items[0]!.id, completedItems: [plan.items[0]!.id], outOfScopePaths: ['extra.ts'], baseEntries: entries,
  });
  const amended = s.getPlan(id);
  amended.items[0]!.files.push({ path: 'extra.ts', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  const context = { ...service.planContext(), baseEntries: entries };
  s.importRevision(JSON.stringify(amended), 'json', service.planContext(), 1);
  const current = s.getPlan(id), snapshot = s.getSnapshot(id);
  s.saveReview(id, { revision: current.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
    current.items.map(item => approveItem(current, [], item.id, id, true)), []);
  s.approveContinuation(id, checkpoint.id, { revision: current.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, context);
  for (const item of current.items.slice(1)) {
    const next = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: item.id,
      expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
    s.markRunning(id, next.id);
    s.settleAttempt(id, next.id, { firstReason: null, exitCode: 0, valid: true,
      result: { head: snapshot.head, unchanged: true, inScope: [], outOfScope: [] } });
  }
  expect(s.getTask(id).status).toBe('running');
}
/** The last item found an out-of-scope file, leaving no suffix after the person amends its declaration. */
function finalItemScopeFinding(service: ReviewService) {
  const s = service.store, id = service.config.identity, items = s.getPlan(id).items, initial = s.getSnapshot(id);
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  for (const [index, item] of items.entries()) {
    const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: item.id,
      expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
    s.markRunning(id, attempt.id);
    const last = index === items.length - 1, head = initial.head;
    s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
      result: { head, unchanged: true, inScope: [], outOfScope: last ? ['extra.ts'] : [] } });
  }
  const baseContext = service.planContext(), entries = [...baseContext.baseEntries, { path: 'extra.ts', kind: 'file' as const }];
  const snapshot = s.getSnapshot(id), checkpoint = s.pauseForAmendment(id,
    { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
      item: items.at(-1)!.id, completedItems: items.map(item => item.id), outOfScopePaths: ['extra.ts'], baseEntries: entries,
    });
  const amended = s.getPlan(id);
  amended.items.at(-1)!.files.push({ path: 'extra.ts', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  s.importRevision(JSON.stringify(amended), 'json', baseContext, 1);
  service.planContextAt = () => ({ ...baseContext, baseEntries: entries });
  return checkpoint;
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
 * A server whose runner normally completes every item it admits without an agent (each changes nothing), and publishes
 * through the real publisher and the real pusher into `w.remote`, with GitHub faked. `findingSource` instead drives one
 * of the three coordinator paths that can raise a finding. `before` shapes the Store before the runner exists, as an
 * earlier process would have left it.
 */
async function serve(w: World, options: { before?: (service: ReviewService) => void | Promise<void>; onPushSpawn?: (n: number, app: () => App, close: () => Promise<void>) => void; demo?: boolean; startup?: boolean; settleMs?: number; env?: NodeJS.ProcessEnv; hold?: Promise<void>; shortRetryMs?: number; findingSource?: FindingSource;
  issueGateway?: IssueTrustGateway; preMerge?: (service: ReviewService, runner: RunnerCoordinator) => PreMergeCoordinator; mergeGateway?: MergeGateway; mergeJobTiming?: MergeJobTiming;
  /** The runner also admits command-check attempts, as pre-merge preparation starts them (held by `hold` too). */
  checks?: boolean;
  /** A runner block and no github.pullRequest: merging targets the PR the runner published, after preparation. */
  runnerPublished?: boolean } = {}) {
  let app: App | undefined, spawns = 0, closing: Promise<void> | undefined;
  const close = () => closing ??= app!.close();
  let branchOf: (identity: PlanIdentity) => string = () => '';
  let findings: SafetyFindings | undefined;
  const config = { ...w.demo, demo: options.demo ?? false, ...(options.issueGateway ? { github: { repository: options.issueGateway.repository, issue: 3,
    ...(options.runnerPublished ? {} : { pullRequest: 1 }), baseBranch: 'main' } } : {}), ...(options.runnerPublished ? { runner: {} } : {}) };
  app = await startServer(config, 0, undefined, options.mergeGateway, 2_000, options.issueGateway, undefined, undefined, async service => {
    const identity = service.config.identity, task = service.store.getTask(identity), plan = service.store.getPlan(identity);
    if (task.status !== 'merged' && task.status !== 'cancelled' && service.store.unapprovedExecutionItems(identity, plan.revision).length) {
      const review = await service.load();
      service.store.saveReview(identity, review.expected,
        review.items.map(item => approveItem(review.plan, review.segments, item.id, identity, item.count === 0)), []);
    }
    await options.before?.(service);
    const repository = await openRunnerRepository({ runnerRoot: join(w.root, 'runner'), runnerOwner: OWNER, repositoryId: service.config.identity.repositoryId, source: service.config.repository });
    await ensureCommit(repository, service.store.getSnapshot(service.config.identity).head);
    const prepared: PreparedAttempt = { clone: { id: 'clone', taskId: 'task', directory: '/tmp/x', head: 'f'.repeat(40) }, vendor: 'claude', approvedArgv: [] };
    const sources: ExecutionSources = { planContext: () => service.planContext(), checkpointContext: () => service.planContext(),
      issue: () => ({ text: { number: 3, title: '', body: '', comments: [] }, validate: () => undefined }), lessons: () => [], vendor: () => 'claude' };
    const pusher = new GitBranchPusher({ repository, repositoryId: service.config.identity.repositoryId, remote: REPO, url: w.remote,
      ownedCommits: identity => service.store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha),
      onProcessGroup: () => options.onPushSpawn?.(++spawns, () => app!, close) });
    const publisher = (closing: () => boolean) => new PullRequestPublisher(service.store, { checks: w.github.checks, pulls: w.github.pulls, pusher, closing }, { repository: REPO, baseBranch: 'main', ...(options.settleMs ? { settleMs: options.settleMs } : {}) });
    branchOf = identity => publisher(() => false).branch(identity);
    findings = new SafetyFindings(service.store);
    if (options.findingSource) vi.spyOn(service.store, 'recordSafetyFinding').mockImplementation(() => { throw new Error('database is locked'); });
    const source = options.findingSource;
    const launch = (input: Parameters<Parameters<typeof executionDeps>[2]>[0]) => ({ attemptId: input.attemptId, cancel: () => undefined,
      settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode: source === 'failed-run audit' ? 1 : 0,
        signal: null, stdout: '', stderr: source === 'failed-run audit' ? 'agent crashed' : '' }) });
    const workspace: TaskWorkspace = {
      async materialize(attempt, head) { return { clone: { id: `clone-${attempt.id}`, taskId: 'task', directory: '/tmp/x', head }, storage: {} }; },
      async snapshotDeclaredLinks() {
        return source === 'preparation'
          ? { links: [{ link: 'retry.ts', status: 'through-link', anchor: { path: 'via', type: 'symlink', mode: '120777', size: 1, ino: 1, ctime: '0', mtime: '0' } }], targets: {} } as never
          : { links: [], targets: {} } as never;
      },
      async checkTree() { return {} as never; },
      async inspectChanges() { throw new Error(source === 'failed-run audit' ? 'failed-run inspection failed' : 'audit inspection failed'); },
      async commit() { throw new Error('A finding must never be committed.'); },
      async release() {},
    };
    const deps: RunnerDeps = source
      ? executionDeps(service.store, workspace, launch, sources, OWNER, findings)
      : { runnerOwner: OWNER, kinds: options.checks ? ['execute', 'check'] : ['execute'], prepare: async () => prepared, cleanupPreparation: async () => undefined,
        start: input => ({ attemptId: input.attemptId, cancel: () => undefined,
          // `hold`: the attempt keeps running until the test releases it.
          settled: (options.hold ?? Promise.resolve()).then(() => ({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: '', stderr: '' })) }),
        validate: () => ({ head: service.store.getSnapshot(service.config.identity).head, unchanged: true, inScope: [], outOfScope: [] }) };
    return { deps, sources, findings, publisher, ...(options.preMerge ? { preMerge: (runner: RunnerCoordinator) => options.preMerge!(service, runner) } : {}),
      ...(options.env ? { env: options.env } : {}), ...(options.shortRetryMs ? { shortRetryMs: options.shortRetryMs } : {}),
      recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  }, options.mergeJobTiming ? { mergeJobTiming: options.mergeJobTiming } : {});
  cleanups.push(close);
  // As the CLI does once it has verified the lock.
  if (options.startup !== false) app.publishOwed(() => undefined);
  const identity = w.demo.identity;
  return { app, close, identity, store: app.service.store, branch: branchOf(identity), head: app.service.store.getSnapshot(identity).head, findings: findings! };
}
const view = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
async function act(app: App, action: string, actionId = randomUUID(), expectedStateVersion?: number, expectedReviewVersion?: number) {
  const current = await view(app), stateVersion = expectedStateVersion ?? current.stateVersion, reviewVersion = expectedReviewVersion ?? current.reviewVersion;
  const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, expectedStateVersion: expectedStateVersion ?? stateVersion,
      ...((action === 'start' || action === 'resume' || action === 'approve-continuation' || action === 'prepare-merge') ? { expectedReviewVersion: reviewVersion } : {}), actionId }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const publishSettled = (app: App, identity: PlanIdentity) => vi.waitFor(async () => {
  expect(app.publishing!.busy(identity)).toBe(false);
  expect(app.service.store.lastPublish(identity)).not.toBeNull();
}, { timeout: 20_000, interval: 20 });

describe('publishing a finished task (#103)', () => {
  it('approves a final-item scope finding and publishes the completed plan ready', async () => {
    const w = world(), { app, identity, store } = await serve(w, { before: service => { finalItemScopeFinding(service); }, startup: false });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(store.continuationProgress(identity)?.next).toBeNull();
    expect((await act(app, 'approve-continuation')).status).toBe(200);
    expect(store.getTask(identity).status).toBe('running');
    await publishSettled(app, identity);
    expect(w.github.calls).toContain('open ready');
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: false });
  });
  it('publishes after approval removes an interrupted final item from an already-running task', async () => {
    const w = world(), { app, identity, store } = await serve(w, { startup: false, before: service => {
      const s = service.store, id = service.config.identity, plan = s.getPlan(id), snapshot = s.getSnapshot(id);
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const first = plan.items[0]!;
      const firstAttempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: first.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, firstAttempt.id);
      s.settleAttempt(id, firstAttempt.id, { firstReason: null, exitCode: 0, valid: true,
        result: { head: snapshot.head, unchanged: true, inScope: [], outOfScope: ['extra.ts'] } });
      const entries = [...service.planContext().baseEntries, { path: 'extra.ts', kind: 'file' as const }];
      const checkpoint = s.recordCheckpoint(id, { revision: plan.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: first.id, completedItems: [first.id], outOfScopePaths: ['extra.ts'], baseEntries: entries,
      });
      const amended = s.getPlan(id);
      amended.items[0]!.files.push({ path: 'extra.ts', kind: 'add', renamed_from: null, change: 'Declare observed output' });
      s.importRevision(JSON.stringify(amended), 'json', service.planContext(), amended.revision);
      let current = s.getPlan(id), currentSnapshot = s.getSnapshot(id);
      s.saveReview(id, { revision: current.revision, snapshotId: currentSnapshot.id, reviewVersion: s.reviewVersion(id) },
        current.items.map(item => approveItem(current, [], item.id, id, true)), []);
      const context = { ...service.planContext(), baseEntries: entries };
      service.planContextAt = () => ({ ...context, baseEntries: entries });
      s.approveContinuation(id, checkpoint.id, { revision: current.revision, snapshotId: currentSnapshot.id, reviewVersion: s.reviewVersion(id) }, context);

      const second = current.items[1]!;
      const secondAttempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: second.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, secondAttempt.id);
      s.settleAttempt(id, secondAttempt.id, { firstReason: null, exitCode: 0, valid: true,
        result: { head: currentSnapshot.head, unchanged: true, inScope: [], outOfScope: [] } });

      const third = current.items[2]!;
      const thirdAttempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: third.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, thirdAttempt.id);
      s.recoverInterrupted(Date.now());
      expect(s.getTask(id)).toMatchObject({ status: 'running', requeuePending: true });

      const checkpointNow = s.latestCheckpoint(id)!, shortened = s.getPlan(id);
      shortened.items = shortened.items.slice(0, 2);
      s.importRevision(JSON.stringify({ ...shortened, revision: shortened.revision + 1 }), 'json', service.planContext(), shortened.revision);
      current = s.getPlan(id); currentSnapshot = s.getSnapshot(id);
      s.saveReview(id, { revision: current.revision, snapshotId: currentSnapshot.id, reviewVersion: s.reviewVersion(id) },
        current.items.map(item => approveItem(current, [], item.id, id, true)), []);
      service.planContextAt = () => ({ ...context, baseEntries: checkpointNow.baseEntries });
    } });

    expect(store.getTask(identity)).toMatchObject({ status: 'running', requeuePending: true });
    expect(store.continuationProgress(identity)?.next).toBeNull();
    expect(store.continuationApproved(identity, store.continuationProgress(identity)!)).toBe(false);
    const beforeApproval = await view(app);
    const approvalActionId = randomUUID();
    expect((await act(app, 'approve-continuation', approvalActionId, beforeApproval.stateVersion, beforeApproval.reviewVersion)).status).toBe(200);
    expect((await act(app, 'approve-continuation', approvalActionId, beforeApproval.stateVersion, beforeApproval.reviewVersion)).status).toBe(200);
    await publishSettled(app, identity);
    const calls = [...w.github.calls];
    expect((await act(app, 'approve-continuation')).status).toBe(409);
    expect(w.github.calls).toEqual(calls);
    expect(w.github.calls).toContain('open ready');
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: false });
  });
  it.each(['automatic', 'explicit'] as const)('publishes a completed continuation through the %s path', async path => {
    const w = world(), { app, identity, store } = await serve(w, { before: completeContinuation, startup: path === 'explicit' ? false : undefined });
    expect(() => store.assertPublishableNow(identity, false)).not.toThrow();
    expect(store.canPublish(identity, false)).toBe(true);
    if (path === 'explicit') {
      expect(app.publishing!.mode(identity)).toMatchObject({ kind: 'publish', draft: false });
      expect((await act(app, 'publish')).status).toBe(200);
    }
    await publishSettled(app, identity);
    expect(w.github.calls).toContain('open ready');
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: false });
  });

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

  it('rechecks issue trust before a publish action crosses its external boundary', async () => {
    const w = world();
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'outside', collaborator: false }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, store, identity } = await serve(w, { before: completeAll, startup: false, issueGateway });
    expect(await act(app, 'publish')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not trusted for its current author/) } });
    expect(w.github.calls).toEqual([]);
    store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    expect(await act(app, 'publish')).toMatchObject({ status: 200, body: { result: { outcome: 'publishing' } } });
    await app.publishing!.settled(identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened' });
  });

  it('records an unavailable issue-access read as a failed publish, not a trust refusal', async () => {
    const w = world();
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess() { throw new Error('GitHub returned HTTP 502'); },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, store, identity } = await serve(w, { before: completeAll, startup: false, issueGateway });
    app.publishOwed(() => undefined);
    await publishSettled(app, identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/could not be verified.*502/) });
    expect(w.github.calls).toEqual([]);
  });

  it('rechecks issue trust before an automatic publish retry and stops after revocation', async () => {
    const w = world();
    let accessReads = 0;
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { accessReads++; return { number, authorLogin: 'outside', collaborator: false }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    w.github.staleHeadOnce = 'a'.repeat(40);
    const { app, store, identity } = await serve(w, { startup: false, shortRetryMs: 100, issueGateway, before: service => {
      completeAll(service);
      service.store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    } });
    app.publishOwed(() => undefined);
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', reconcile: true }), { timeout: 10_000 });
    const calls = [...w.github.calls], readsBeforeRetry = accessReads;
    store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/not trusted/) }),
      { timeout: 10_000, interval: 50 });
    expect(accessReads).toBe(readsBeforeRetry + 1);
    expect(w.github.calls).toEqual(calls);
  });

  it('rechecks the bound trust decision after awaited safety reads and before pushing', async () => {
    const w = world(), checking = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'outside', collaborator: false }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    w.github.checks.check = async () => { w.github.calls.push('check'); checking.resolve(); await release.promise;
      return { outcome: 'clear', baseHead: 'b'.repeat(40) }; };
    const { app, store, identity, branch } = await serve(w, { startup: false, issueGateway, before: service => {
      completeAll(service);
      service.store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    } });
    app.publishOwed(() => undefined);
    await checking.promise;
    store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
    release.resolve();
    await publishSettled(app, identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/not trusted/) });
    expect(w.github.head(branch)).toBeNull();
    expect(w.github.prs).toEqual([]);
  });

  it('re-reads current issue access after awaited safety reads and before pushing', async () => {
    const w = world(), checking = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let access = { authorLogin: 'member', collaborator: true }, accessReads = 0;
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { accessReads++; return { number, ...access }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    w.github.checks.check = async () => { w.github.calls.push('check'); checking.resolve(); await release.promise;
      return { outcome: 'clear', baseHead: 'b'.repeat(40) }; };
    const { app, store, identity, branch } = await serve(w, { startup: false, issueGateway, before: completeAll });
    app.publishOwed(() => undefined);
    await checking.promise;
    access = { authorLogin: 'outside', collaborator: false };
    release.resolve();
    await publishSettled(app, identity);
    expect(accessReads).toBe(2);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/not trusted.*current author/) });
    expect(w.github.head(branch)).toBeNull();
    expect(w.github.prs).toEqual([]);
  });

  it('does not publish when the issue author changes during the final collaborator read', async () => {
    const w = world(), checking = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let author = 'outside', issueReads = 0, holdCollaborators = false;
    const issueGateway = new GhIssueGateway(REPO, async args => {
      if (args.some(argument => argument.endsWith('/collaborators'))) {
        if (holdCollaborators) { holdCollaborators = false; checking.resolve(); await release.promise; }
        return '[]';
      }
      if (args[5] === `repos/${REPO}/issues`) return '[]';
      issueReads++;
      if (issueReads === 3) holdCollaborators = true;
      return JSON.stringify({ number: 3, user: { login: author } });
    });
    const { app, store, identity, branch } = await serve(w, { startup: false, issueGateway, before: service => {
      completeAll(service);
      service.store.setIssueTrust({ repository: REPO, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    } });
    app.publishOwed(() => undefined);
    await checking.promise;
    author = 'replacement';
    release.resolve();
    await publishSettled(app, identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/author changed during access verification/) });
    expect(w.github.head(branch)).toBeNull();
    expect(w.github.prs).toEqual([]);
  });

  it('aborts and settles a publish whose issue authorization is still pending during shutdown', async () => {
    const w = world(), reading = Promise.withResolvers<void>();
    let accessSignal: AbortSignal | undefined;
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      issueAccess(_number, options = {}) {
        accessSignal = options.signal; reading.resolve();
        return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, store, close } = await serve(w, { startup: false, issueGateway, before: completeAll });
    const records = vi.spyOn(store, 'recordPublish');
    app.publishOwed(() => undefined);
    await reading.promise;
    await close();
    expect(accessSignal?.aborted).toBe(true);
    expect(records.mock.calls.some(call => call[1].outcome === 'stopped')).toBe(true);
    expect(w.github.calls).toEqual([]);
  });

  it.each([
    ['timed out', () => new RemoteTimeout('Issue retrieval timed out.'), /could not be verified: Issue retrieval timed out/],
    ['was answered by gh', () => new CommandFailed('gh failed (exit 1): HTTP 404: Not Found', 'HTTP 404: Not Found', ''), /could not be verified: gh failed \(exit 1\): HTTP 404/],
  ] as const)('records a publish whose issue-trust read %s before shutdown as failed with that answer, not stopped (#48)', async (_case, answer, expected) => {
    const w = world(), reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let accessSignal: AbortSignal | undefined;
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      // The read answered (or ran out of time) before shutdown; its answer surfaces only after shutdown aborted it.
      async issueAccess(_number, options = {}) { accessSignal = options.signal; reading.resolve(); await release.promise; throw answer(); },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, store, close } = await serve(w, { startup: false, issueGateway, before: completeAll });
    const records = vi.spyOn(store, 'recordPublish');
    app.publishOwed(() => undefined);
    await reading.promise;
    const closing = close();
    await vi.waitFor(() => expect(accessSignal?.aborted).toBe(true));
    release.resolve();
    await closing;
    expect(records.mock.calls.at(-1)?.[1]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(expected) });
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

  it.each(Object.keys(FINDINGS) as FindingSource[])('names an initially unsaved finding from %s in the draft after the budget runs out', async source => {
    const w = world();
    const { app, identity, store, findings } = await serve(w, { findingSource: source, startup: false,
      before: service => { service.store.transitionTask(service.config.identity, service.store.getTask(service.config.identity).stateVersion, 'queued'); } });
    expect(await app.executor!.runTask(identity)).toMatchObject({ kind: 'needs human', reason: FINDINGS[source] });
    const attempt = store.getAttempts(identity).at(-1)!;
    // Prove which coordinator path produced the attempt; the downstream draft alone would not distinguish the sources.
    expect(attempt).toMatchObject({ state: 'failed', safetyFinding: FINDINGS[source], diagnostic: FINDING_DIAGNOSTICS[source] });
    expect(findings.owedAttempts()).toEqual([]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(store.getTask(identity).budgetDeadline! + 1);
    try {
      app.publishing!.actIfOwed(identity);
      await publishSettled(app, identity);
    } finally { now.mockRestore(); }
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining(FINDINGS[source]) })]);
    expect(w.github.prs[0]!.body).not.toContain(BUDGET);
  });

  it('keeps an unsaved finding for a draft retry after the first publish fails', async () => {
    const w = world(), check = w.github.checks.check;
    w.github.checks.check = async () => { throw new Error('HTTP 502'); };
    const { app, identity, store } = await serve(w, { findingSource: 'preparation', startup: false,
      before: service => { service.store.transitionTask(service.config.identity, service.store.getTask(service.config.identity).stateVersion, 'queued'); } });
    expect(await app.executor!.runTask(identity)).toMatchObject({ kind: 'needs human', reason: FINDINGS.preparation });
    const now = vi.spyOn(Date, 'now').mockReturnValue(store.getTask(identity).budgetDeadline! + 1);
    try {
      app.publishing!.actIfOwed(identity);
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', message: 'HTTP 502' });
      w.github.checks.check = check;
      app.publishing!.actIfOwed(identity);
      await publishSettled(app, identity);
    } finally { now.mockRestore(); }
    expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining(FINDINGS.preparation) })]);
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

  it('publishes the whole task head, the branch\'s own commits too, which review shows as Unplanned and the merge gate blocks (#113)', async () => {
    const w = world();
    const { app, identity, store, branch, head } = await serve(w, { before: completeAll });
    await publishSettled(app, identity);
    // The demo branch's last commit was made by a person, not by codeboost: the ledger does not record it.
    const owned = store.getLedger(identity).filter(entry => entry.origin === 'owned').map(entry => entry.sha);
    expect(owned).not.toContain(head);
    // It is published as it is: the PR's branch is the whole head.
    expect(w.github.head(branch)).toBe(head);
    expect(w.github.prs).toEqual([expect.objectContaining({ open: true, draft: false })]);
    // Review shows its change in the Unplanned row, and the merge gate blocks until a person assigns or accepts it.
    const view = await app.service.load();
    expect(view.segments.filter(segment => segment.row === 'Unplanned').map(segment => segment.path)).toContain('debug.log');
    // The gate inspects the published PR (#121), which GitHub shows as the task's.
    const pr = store.taskPullRequests(identity).find(record => record.state === 'opened')!;
    const targets: unknown[] = [];
    const gateway: MergeGateway = { inspect: async options => { targets.push(options?.target?.pullRequest); return { base: view.snapshot.base, head: view.snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE',
      rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: pr.number!, draft: false,
      published: { headBranch: pr.headBranch, baseBranch: 'main', crossRepository: false, marker: openingMarker(pr.openingId), branchOpen: [{ number: pr.number!, base: 'main' }] } }; },
      merge: async () => { throw new Error('not merged here'); } };
    const status = await new MergeCoordinator(app.service, gateway, undefined, undefined, { repository: REPO, baseBranch: 'main' }).status(view);
    expect(targets).toEqual([pr.number]);
    expect(status).toMatchObject({ ready: false });
    expect(status.blockers).not.toContainEqual(expect.objectContaining({ code: 'pull-request' }));
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'unplanned' }));
  });

  it('removes the publishing environment\'s token values from a recorded failure', async () => {
    const w = world(), token = 'not-a-github-shaped-secret-4711';
    w.github.onOpen = async () => { throw new Error(`gh failed: Authorization: token ${token}`); };
    const { app, identity, store } = await serve(w, { before: completeAll, env: { GH_ENTERPRISE_TOKEN: token } });
    await publishSettled(app, identity);
    expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed', message: 'gh failed: Authorization: token [token]' });
  });

  it('stamps the outcome with the version the publish saw, not one changed during its last GitHub call (#114)', async () => {
    const w = world();
    let seen = -1;
    // GitHub shows another head than the one pushed, so the PR is to be made a draft; that call fails, and someone else
    // changes the task while it runs.
    w.github.onOpen = async () => { const pr = w.github.prs.at(-1)!; git(w.remote, 'update-ref', `refs/heads/${pr.headBranch}`, git(w.demo.repository, 'rev-list', '--max-parents=0', 'HEAD')); };
    const { app, identity, store } = await serve(w, { before: completeAll });
    w.github.onDraft = () => {
      seen = store.getTask(identity).stateVersion;
      store.cancelTask(identity, seen, randomUUID());
      throw new Error('GitHub timed out.');
    };
    const records = vi.spyOn(store, 'recordPublish');
    await publishSettled(app, identity);
    // The cancel then closes the PR (#111), so the publish's own record is read from what was recorded, not the last one.
    const opened = records.mock.results.map(result => result.value as PublishRecord).find(record => record.outcome === 'opened');
    expect(opened).toMatchObject({ stateVersion: seen, message: expect.stringContaining('may still be ready for review') });
    expect(store.getTask(identity).stateVersion).toBeGreaterThan(seen);
  });

  describe('a publish\'s in-flight record', () => {
    it('is written before any GitHub call', async () => {
      const w = world();
      let seen: unknown;
      const opening = Promise.withResolvers<void>();
      w.github.checks.check = async () => { opening.resolve(); return { outcome: 'clear', baseHead: 'b'.repeat(40) }; };
      const { app, identity, store } = await serve(w, { before: completeAll, startup: false });
      app.publishOwed(() => undefined);
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
      app.publishOwed(() => undefined);
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
        // The upgrade comes after those runs (a later millisecond: timestamps are compared).
        const until = Date.now() + 3; while (Date.now() < until) { /* let the clock move */ }
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
        // Running, with P2 and P3 still to run: owed work would be paid, and nothing can be published.
        s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
        const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id, expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
        s.markRunning(id, attempt.id);
        s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head: s.getSnapshot(id).head, unchanged: true, inScope: [], outOfScope: [] } });
        s.recordPublish(id, { outcome: 'publishing', draft: false, message: 'A pull request is being published.' });
      } });
      expect(store.getTask(identity).status).toBe('running');
      const pay = vi.spyOn(app.executor!, 'payOwed').mockImplementation(() => { throw new Error('The snapshot of P1\'s commit is missing.'); });
      app.publishOwed(() => undefined);
      expect(pay).toHaveBeenCalled();
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

  describe('round 2 of the independent review', () => {
    it('retries by itself a publish whose own opening reply was lost', async () => {
      const w = world();
      // GitHub creates the PR, but its list does not show it yet, and the reply is lost.
      w.github.onOpen = async () => { w.github.hidden.add(w.github.prs.at(-1)!.number); w.github.onOpen = undefined; throw new Error('timed out'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 2_000 });
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed' }), { timeout: 5_000 });
      w.github.hidden.clear();
      // No action and no restart: the retry at the opening's deadline recovers it by its marker.
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', number: 100 }), { timeout: 8_000, interval: 50 });
      expect(w.github.prs).toHaveLength(1);
    });
    it('publishes a task recorded as not published at the upgrade once a run has started after it', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: service => {
        service.store.recordPublish(service.config.identity, { outcome: 'not published', draft: false, message: 'Before publishing existed.' });
        // A person resumed it after the upgrade (a later millisecond: timestamps are compared), and that run completed the plan.
        const until = Date.now() + 3; while (Date.now() < until) { /* let the clock move */ }
        completeAll(service);
      } });
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened' });
    });
    it('pays owed work only for its own refusal: a stale or replayed publish action starts nothing', async () => {
      const w = world(), actionId = randomUUID();
      const { app, identity, store } = await serve(w, { before: completeAllOwingPause, startup: false });
      const stale = store.getTask(identity).stateVersion - 1;
      expect(await act(app, 'publish', actionId, stale)).toMatchObject({ status: 409, body: { error: 'Stale task state. Reload before writing.' } });
      expect(store.getTask(identity).status).toBe('running');
      // The replay of that saved refusal applies nothing either.
      expect(await act(app, 'publish', actionId, stale)).toMatchObject({ status: 409 });
      expect(store.getTask(identity).status).toBe('running');
      expect(app.executor!.owes(identity)).toBe(true);
      // Its own refusal for the owed pause pays it.
      expect(await act(app, 'publish')).toMatchObject({ status: 409, body: { error: OWED_REFUSAL } });
      expect(store.getTask(identity).status).toBe('needs amendment');
    });
    it('publishes the draft of a needs-human task although a scope pause is owed', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: service => {
        completeAllOwingPause(service);
        const s = service.store, id = service.config.identity;
        s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
      } });
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: true })]);
    });
    it('keeps an interrupted draft publish recorded as a draft when startup settles it', async () => {
      const w = world();
      const { identity, store } = await serve(w, { before: service => {
        const s = service.store, id = service.config.identity;
        s.recordPublish(id, { outcome: 'publishing', draft: true, message: 'A pull request is being published.' });
        s.cancelTask(id, s.getTask(id).stateVersion, randomUUID());
      } });
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'stopped', draft: true });
    });
  });

  describe('round 3 of the independent review', () => {
    it('does not retry for ever when a lost opening stays stuck past its deadline', async () => {
      const w = world();
      // The opening's reply is lost (GitHub created the PR; its list does not show it yet).
      w.github.onOpen = async () => { w.github.hidden.add(w.github.prs.at(-1)!.number); w.github.onOpen = undefined; throw new Error('timed out'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 1_000, startup: false });
      const starts = vi.spyOn(store, 'recordPublish');
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed' }), { timeout: 5_000 });
      // Someone copied its description onto another PR from the branch: recovery cannot tell which is the task's, so the
      // opening stays, and every publish of it is refused for a reason only a person can fix.
      const pr = w.github.prs[0]!;
      w.github.prs.push({ ...pr, number: 999, url: `https://github.com/${REPO}/pull/999`, base: 'release' });
      w.github.hidden.clear();
      await new Promise(resolve => setTimeout(resolve, 6_000));
      const publishes = starts.mock.calls.filter(call => call[1].outcome === 'publishing').length;
      // The first publish and one retry at the opening's deadline; not one more every second.
      expect(publishes).toBeLessThanOrEqual(2);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused' });
    });
    it('publishes the draft of an upgraded task when a person\'s refused resume moves it to needs human', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { startup: false, before: service => {
        budgetSpent(service);
        service.store.recordPublish(service.config.identity, { outcome: 'not published', draft: false, message: 'Before publishing existed.' });
      } });
      expect(await act(app, 'resume')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/time budget/) } });
      expect(store.getTask(identity).status).toBe('needs human');
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
    });
  });

  describe('round 4 of the independent review', () => {
    it('stops retrying when GitHub keeps failing every open: one retry at the deadline, not one every settle time', async () => {
      const w = world();
      // GitHub fails every open, creating nothing.
      w.github.onOpen = async () => { w.github.prs.pop(); throw new Error('HTTP 502'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 800, startup: false });
      const starts = vi.spyOn(store, 'recordPublish');
      app.publishOwed(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      expect(starts.mock.calls.filter(call => call[1].outcome === 'publishing').length).toBe(2);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed' });
    });
    it('reconciles a ready PR that GitHub showed at another head: still owed, and published again by itself', async () => {
      const w = world();
      w.github.staleHeadOnce = 'a'.repeat(40);
      const { app, identity, store } = await serve(w, { before: completeAll, shortRetryMs: 300, startup: false });
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', reconcile: true }), { timeout: 10_000 });
      expect(store.getTask(identity).status).toBe('running');
      expect(w.github.prs[0]!.draft).toBe(true);
      // The short retry publishes again, and this time GitHub shows the pushed head.
      await vi.waitFor(() => expect(store.getTask(identity).status).toBe('in review'), { timeout: 10_000, interval: 50 });
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened' });
      expect(store.lastPublish(identity)!.reconcile).toBeUndefined();
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: false })]);
    });
    it('retries once, after a short wait, a publish refused because GitHub\'s list lags behind its PR', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: needsHuman, shortRetryMs: 300 });
      await publishSettled(app, identity);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
      // Owed again (an earlier attempt failed), and GitHub's list does not show the PR for now.
      store.recordPublish(identity, { outcome: 'refused', draft: true, message: 'The branch moved.' });
      w.github.hidden.add(100);
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/list does not show it yet/) }), { timeout: 10_000 });
      w.github.hidden.clear();
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true }), { timeout: 10_000, interval: 50 });
    });
  });

  describe('round 5 of the independent review', () => {
    it('gives a persistent list lag one short retry, not one every period', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: needsHuman, shortRetryMs: 200 });
      await publishSettled(app, identity);
      store.recordPublish(identity, { outcome: 'refused', draft: true, message: 'The branch moved.' });
      // GitHub's list keeps leaving the PR out.
      w.github.hidden.add(100);
      const starts = vi.spyOn(store, 'recordPublish');
      app.publishOwed(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      expect(starts.mock.calls.filter(call => call[1].outcome === 'publishing').length).toBe(2);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/list does not show it yet/) });
    });
    it('starts no startup publish unless the lock check passes, which runs first', async () => {
      const w = world();
      const { app, identity } = await serve(w, { before: completeAll, startup: false });
      const order: string[] = [];
      expect(() => app.publishOwed(() => { order.push('verify'); throw new Error('The database path changed while opening. Refusing to start.'); }))
        .toThrow('The database path changed');
      expect(app.publishing!.busy(identity)).toBe(false);
      expect(w.github.calls).toEqual([]);
      app.publishOwed(() => { order.push('verify'); expect(app.publishing!.busy(identity)).toBe(false); });
      expect(order).toEqual(['verify', 'verify']);
      expect(app.publishing!.busy(identity)).toBe(true);
      await publishSettled(app, identity);
    });
    it('starts a new chain with its own retries when a person asks again', async () => {
      const w = world();
      w.github.onOpen = async () => { w.github.prs.pop(); throw new Error('HTTP 502'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 800, startup: false });
      const starts = vi.spyOn(store, 'recordPublish');
      const publishes = () => starts.mock.calls.filter(call => call[1].outcome === 'publishing').length;
      app.publishOwed(() => undefined);
      // The first chain: its publish and one retry at the opening's deadline, then nothing.
      await new Promise(resolve => setTimeout(resolve, 4_000));
      expect(publishes()).toBe(2);
      // A person asks again: a new chain, which gets its own retry at its opening's deadline.
      await act(app, 'publish');
      await new Promise(resolve => setTimeout(resolve, 4_000));
      expect(publishes()).toBe(4);
    });
  });

  describe('round 6 of the independent review', () => {
    it('drops the old chain\'s armed retry when a person asks again', async () => {
      const w = world();
      w.github.onOpen = async () => { w.github.prs.pop(); throw new Error('HTTP 502'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 1_500, startup: false });
      const starts = vi.spyOn(store, 'recordPublish');
      const publishes = () => starts.mock.calls.filter(call => call[1].outcome === 'publishing').length;
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed' }), { timeout: 5_000 });
      // The first chain's retry at its opening's deadline is armed; a person asks again before it fires.
      await act(app, 'publish');
      await new Promise(resolve => setTimeout(resolve, 6_000));
      // The first publish, the person's, and that chain's one retry: the old chain's timer never fires on the new budget.
      expect(publishes()).toBe(3);
    });
    it('records no reconcile for a ready PR whose task can no longer be published, and replays reconcile when it is set', async () => {
      const w = world();
      // The task is cancelled while its PR opens: the PR is recorded, and nothing would ever reconcile it.
      let cancel: (() => void) | undefined;
      w.github.onOpen = async () => { cancel?.(); };
      const first = await serve(w, { before: completeAll, startup: false });
      cancel = () => first.store.cancelTask(first.identity, first.store.getTask(first.identity).stateVersion, randomUUID());
      const records = vi.spyOn(first.store, 'recordPublish');
      first.app.publishOwed(() => undefined);
      await first.app.publishing!.settled(first.identity);
      expect(first.store.getTask(first.identity).status).toBe('cancelled');
      // The publish's own outcome carries no reconcile; then, the task being cancelled, its PR is closed (#111).
      const opened = records.mock.calls.map(call => call[1]).find(record => record.outcome === 'opened');
      expect(opened).toMatchObject({ outcome: 'opened' });
      expect(opened!.reconcile).toBeUndefined();
      expect(first.store.lastPublish(first.identity)).toMatchObject({ outcome: 'closed', action: 'close' });
      // A publish action whose PR GitHub shows at another head: its saved reply, replayed, says reconcile too.
      const v = world();
      v.github.staleHeadOnce = 'a'.repeat(40);
      const second = await serve(v, { before: completeAll, startup: false });
      const actionId = randomUUID(), version = second.store.getTask(second.identity).stateVersion;
      await act(second.app, 'publish', actionId, version);
      await second.app.publishing!.settled(second.identity);
      expect((await act(second.app, 'publish', actionId, version)).body.result).toMatchObject({ outcome: 'opened', reconcile: true });
    });
  });

  describe('round 7 of the independent review', () => {
    /** A safety finding the audit made on the last attempt, whose save failed: the executor holds it, owed, in memory. */
    const owedFinding = (store: Store, findings: SafetyFindings, identity: PlanIdentity) => {
      const attempt = store.getAttempts(identity).at(-1)!;
      vi.spyOn(store, 'recordSafetyFinding').mockImplementationOnce(() => { throw new Error('database is locked'); });
      findings.record(attempt.id, 'The last item wrote outside its workspace.');
      expect(findings.owedAttempts()).toEqual([attempt.id]);
    };
    it('refuses a ready publish while a safety finding is owed, pays it, and publishes the draft instead', async () => {
      const w = world(), actionId = randomUUID();
      const { app, identity, store, findings } = await serve(w, { before: completeAll, startup: false });
      owedFinding(store, findings, identity);
      expect((await view(app)).publish).toMatchObject({ publishable: false });
      const version = store.getTask(identity).stateVersion;
      expect(await act(app, 'publish', actionId, version)).toMatchObject({ status: 409, body: { error: OWED_REFUSAL } });
      // Paid: the task went to a person, and its draft is published with the finding as its problem.
      expect(store.getTask(identity).status).toBe('needs human');
      await publishSettled(app, identity);
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining('The last item wrote outside its workspace.') })]);
      // A replay of that refusal applies nothing: no payment, no publish.
      const pay = vi.spyOn(app.executor!, 'payOwed'), actIfOwed = vi.spyOn(app.publishing!, 'actIfOwed');
      expect(await act(app, 'publish', actionId, version)).toMatchObject({ status: 409, body: { error: OWED_REFUSAL } });
      expect(pay).not.toHaveBeenCalled();
      expect(actIfOwed).not.toHaveBeenCalled();
    });
    it('pays a safety finding owed on a needs-human task before its draft, at startup', async () => {
      const w = world();
      const { app, identity, store, findings } = await serve(w, { before: needsHuman, startup: false });
      owedFinding(store, findings, identity);
      app.publishOwed(() => undefined);
      await publishSettled(app, identity);
      expect(findings.owedAttempts()).toEqual([]);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining('The last item wrote outside its workspace.') })]);
    });
    it('names a later return to needs human by its own reason, not a finding paid before', async () => {
      const w = world();
      const { app, identity, store, findings } = await serve(w, { before: completeAll, startup: false });
      owedFinding(store, findings, identity);
      app.publishOwed(() => undefined);
      await publishSettled(app, identity);
      expect(w.github.prs).toEqual([expect.objectContaining({ body: expect.stringContaining('The last item wrote outside its workspace.') })]);
      // A person dealt with the finding and the task ran again: its new attempt failed, and the next admission came after
      // the task's budget, so it is back in needs human for that reason.
      store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
      const admit = (now?: number) => store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute',
        item: store.getPlan(identity).items[0]!.id, expectedContext: store.currentContext(identity), deadline: (now ?? Date.now()) + 60_000, ...(now ? { now } : {}) });
      const attempt = admit();
      store.markRunning(identity, attempt.id);
      store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false, detail: 'The tests failed in retry.ts.' });
      expect(() => admit(store.getTask(identity).budgetDeadline! + 1)).toThrow(/time budget/);
      expect(store.getTask(identity).status).toBe('needs human');
      app.publishing!.actIfOwed(identity);
      await publishSettled(app, identity);
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining('The tests failed in retry.ts.') })]);
      expect(w.github.prs[0]!.body).not.toContain('The last item wrote outside its workspace.');
    });
    it('keeps one retry timer per task when a run\'s end starts a new chain while one is armed', async () => {
      const w = world();
      w.github.onOpen = async () => { w.github.prs.pop(); throw new Error('HTTP 502'); };
      const { app, identity, store } = await serve(w, { before: completeAll, settleMs: 1_500, startup: false });
      const starts = vi.spyOn(store, 'recordPublish');
      const publishes = () => starts.mock.calls.filter(call => call[1].outcome === 'publishing').length;
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'failed' }), { timeout: 5_000 });
      // A run's end starts a new chain while the first chain's retry is armed.
      app.publishing!.actIfOwed(identity);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      // The first publish, the new chain's, and that chain's one retry; the first chain's timer never fires.
      expect(publishes()).toBe(3);
    });
  });

  describe('round 9 of the independent review', () => {
    it('retries once, after a short wait, a publish refused because the task changed during it', async () => {
      const w = world();
      const { app, identity, store } = await serve(w, { before: completeAll, shortRetryMs: 200, startup: false });
      const check = store.recordAlreadyFixed.bind(store);
      vi.spyOn(store, 'recordAlreadyFixed').mockImplementationOnce(() => { throw new GuardRefusal('The review changed during the check. Reload before writing.'); })
        .mockImplementation(check);
      app.publishOwed(() => undefined);
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/review changed/) }), { timeout: 10_000 });
      // Nothing a person must fix: the short retry publishes the task as it is now.
      await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: false }), { timeout: 10_000, interval: 50 });
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: false })]);
    });
    it('does not classify a safety-looking diagnostic as a finding without an executor escalation', async () => {
      const w = world();
      const finding = 'Safety violation: The item wrote outside its workspace.';
      const before = (service: ReviewService) => {
        const s = service.store, id = service.config.identity;
        s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
        const admit = (now?: number) => s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
          expectedContext: s.currentContext(id), deadline: (now ?? Date.now()) + 60_000, ...(now ? { now } : {}) });
        const attempt = admit();
        s.markRunning(id, attempt.id);
        // Diagnostic text alone does not prove that the runner's audit raised a finding; ItemExecutor owns that signal.
        s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 1, valid: false, detail: finding });
        s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
      };
      const { app, identity, store } = await serve(w, { before, startup: false });
      expect(store.getAttempts(identity).at(-1)).toMatchObject({ safetyFinding: null, diagnostic: expect.stringContaining(finding) });
      vi.spyOn(Date, 'now').mockReturnValue(store.getTask(identity).budgetDeadline! + 1);
      app.publishOwed(() => undefined);
      await publishSettled(app, identity);
      vi.mocked(Date.now).mockRestore();
      expect(w.github.prs).toEqual([expect.objectContaining({ draft: true, body: expect.stringContaining(BUDGET) })]);
      expect(w.github.prs[0]!.body).not.toContain(finding);
    });
    it('pays no scope pause for a needs-human task, so nothing is logged as unsettled', async () => {
      const w = world();
      const before = (service: ReviewService) => {
        completeAllOwingPause(service);
        const s = service.store, id = service.config.identity;
        s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
      };
      const { app, identity, store } = await serve(w, { before, startup: false });
      const errors = vi.spyOn(console, 'error');
      app.publishOwed(() => undefined);
      await publishSettled(app, identity);
      expect(errors.mock.calls.filter(call => String(call[0]).includes('Could not settle what an earlier run owes'))).toEqual([]);
      expect(store.lastPublish(identity)).toMatchObject({ outcome: 'opened', draft: true });
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
  it('settles pre-merge before shutdown closes Store writes', async () => {
    const w = world();
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'member', collaborator: true }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    let writesClosed: boolean | undefined;
    const { close } = await serve(w, { issueGateway, preMerge: service => ({
      get active() { return false; }, get last() { return null; }, assertStartable() {}, settlePendingPush: async () => null,
      start: async () => { throw new Error('not used'); }, cancelTask: () => 'closed' as const,
      close: async () => { writesClosed = service.store.writesClosed; },
    } as unknown as PreMergeCoordinator) });
    await close();
    expect(writesClosed).toBe(false);
  });

  it('closes a ready PR after an asynchronously cancelled pre-merge preparation settles', async () => {
    const w = world(), settle = Promise.withResolvers<void>();
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'member', collaborator: true }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    let active = false, cancelId: string | undefined;
    const { app, identity, store } = await serve(w, { before: completeAll, issueGateway, preMerge: service => ({
      get active() { return active; }, get last() { return null; }, assertStartable() {}, settlePendingPush: async () => null,
      start: () => {
        active = true;
        return settle.promise.then(() => {
          service.store.cancelTask(service.config.identity, service.store.getTask(service.config.identity).stateVersion, cancelId!);
          active = false;
          const snapshot = service.store.getSnapshot(service.config.identity);
          return { state: 'failed' as const, base: snapshot.base, head: snapshot.head, checked: [], reason: 'Task cancelled.' };
        });
      },
      cancelTask: (_version: number, actionId: string) => { cancelId = actionId; settle.resolve(); return 'stopping' as const; },
      close: async () => undefined,
    } as unknown as PreMergeCoordinator) });
    await publishSettled(app, identity);
    expect(w.github.prs).toEqual([expect.objectContaining({ open: true, draft: false })]);
    expect(await act(app, 'prepare-merge')).toMatchObject({ status: 200, body: { result: { outcome: 'preparing' } } });
    expect((await act(app, 'cancel-task')).body.result).toEqual({ outcome: 'stopping' });
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 20_000, interval: 20 });
    expect(store.getTask(identity).status).toBe('cancelled');
    expect(w.github.prs[0]!.open).toBe(false);
  });

  it('settles an interrupted pre-merge push only under the verified lock, and closes the PRs of a task it closed', async () => {
    const w = world(), calls: string[] = [];
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'member', collaborator: true }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, identity, store, branch } = await serve(w, { before: completeAll, issueGateway, preMerge: service => ({
      get active() { return false; }, get last() { return null; }, assertStartable() {},
      // As the real job does: read the branch, then clear the marker it finds.
      settlePendingPush: async () => {
        calls.push('settle');
        const marker = service.store.getTask(service.config.identity).pushInProgress;
        if (!marker) return null;
        service.store.finishPrePush(service.store.getTask(service.config.identity).planKey, marker.attemptId);
        return 'not-pushed' as const;
      },
      start: async () => { throw new Error('not used'); }, cancelTask: () => { throw new Error('not used'); }, close: async () => undefined,
    } as unknown as PreMergeCoordinator) });
    // serve() ran startup as the CLI does, after its (passing) lock check; nothing was pending then.
    expect(calls).toEqual(['settle']);
    await publishSettled(app, identity);
    // The state a crash leaves: a push of the rewritten head whose outcome is unknown, and a cancel requested meanwhile.
    const reviewed = () => ({ revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
    const head = store.getSnapshot(identity).head, rewritten = 'e'.repeat(40);
    store.recordRebase(identity, reviewed(), 'f'.repeat(40), rewritten, [{ oldSha: head, newSha: rewritten }]);
    store.beginPrePush(identity, reviewed(), store.getTask(identity).stateVersion, { branch, from: head, to: rewritten });
    expect(store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
    // A failed lock check starts nothing.
    expect(() => app.publishOwed(() => { throw new Error('The database path changed.'); })).toThrow(/database path changed/);
    expect(calls).toEqual(['settle']);
    app.publishOwed(() => { calls.push('verify'); });
    expect(calls).toEqual(['settle', 'verify', 'settle']);
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 20_000, interval: 20 });
    expect(store.getTask(identity)).toMatchObject({ status: 'cancelled', pushInProgress: null });
    expect(w.github.prs[0]!.open).toBe(false);
  });

  it('settles a leftover pre-merge push when the task is cancelled with no preparation running, retrying on a repeated cancel', async () => {
    const w = world(), settled: string[] = [];
    let readable = false;
    const issueGateway: IssueTrustGateway = {
      repository: REPO,
      async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) { return { number, authorLogin: 'member', collaborator: true }; },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, identity, store, branch } = await serve(w, { before: completeAll, issueGateway, preMerge: service => ({
      get active() { return false; }, get last() { return null; }, assertStartable() {},
      // Startup finds no marker yet; the cancel below must start a settlement of its own.
      settlePendingPush: async () => {
        const marker = service.store.getTask(service.config.identity).pushInProgress;
        if (!marker) return null;
        settled.push(marker.attemptId);
        // As the real job does when GitHub cannot be read: the marker stays.
        if (!readable) return null;
        service.store.finishPrePush(service.store.getTask(service.config.identity).planKey, marker.attemptId);
        return 'not-pushed' as const;
      },
      start: async () => { throw new Error('not used'); }, cancelTask: () => { throw new Error('not routed while inactive'); },
      close: async () => undefined,
    } as unknown as PreMergeCoordinator) });
    await publishSettled(app, identity);
    // An earlier preparation rewrote the head and could not read the branch after its push: the marker stayed.
    const reviewed = () => ({ revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
    const head = store.getSnapshot(identity).head, rewritten = 'e'.repeat(40);
    store.recordRebase(identity, reviewed(), 'f'.repeat(40), rewritten, [{ oldSha: head, newSha: rewritten }]);
    const marker = store.beginPrePush(identity, reviewed(), store.getTask(identity).stateVersion, { branch, from: head, to: rewritten });
    expect((await act(app, 'cancel-task')).body.result).toEqual({ outcome: 'stopping' });
    await vi.waitFor(() => expect(settled).toEqual([marker.attemptId]), { timeout: 20_000, interval: 20 });
    expect(store.getTask(identity)).toMatchObject({ status: 'in review', pushInProgress: marker });
    // GitHub is reachable again: repeating the cancel reads the branch again instead of refusing.
    readable = true;
    expect((await act(app, 'cancel-task')).body.result).toEqual({ outcome: 'stopping' });
    await vi.waitFor(() => expect(store.lastPublish(identity)).toMatchObject(closedRecord), { timeout: 20_000, interval: 20 });
    expect(settled).toEqual([marker.attemptId, marker.attemptId]);
    expect(store.getTask(identity)).toMatchObject({ status: 'cancelled', pushInProgress: null });
    expect(w.github.prs[0]!.open).toBe(false);
  });

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

describe('the one-click merge job (F6b of #22)', () => {
  const issueGateway: IssueTrustGateway = {
    repository: REPO,
    async fetch() { return { repository: REPO, retrievedAt: new Date().toISOString(), issues: [] }; },
    async issueAccess(number) { return { number, authorLogin: 'member', collaborator: true }; },
    async issueText(number) { return { number, title: '', body: '', comments: [] }; },
  };
  /** Preparation as F5/F6a end it: readiness recorded exactly on its own action. */
  const preparation = (service: ReviewService) => ({
    get active() { return false; }, get last() { return null; }, assertStartable() {}, settlePendingPush: async () => null,
    cancelTask: () => 'closed' as const, close: async () => undefined,
    start: async (expected: { actionId: string }) => {
      const identity = service.config.identity, snapshot = service.store.getSnapshot(identity);
      const readiness = { stateVersion: service.store.getTask(identity).stateVersion, reviewVersion: service.store.reviewVersion(identity),
        snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head, commandPolicyDigest: service.commandPolicyDigest() };
      return service.store.settlePreMergeAction(identity, expected.actionId,
        { state: 'ready', base: snapshot.base, head: snapshot.head, checked: [], reason: null }, readiness);
    },
  } as unknown as PreMergeCoordinator);
  /** GitHub showing the task's published PR at the reviewed pair; `checks()` gives its required checks now. */
  const gateway = (store: () => Store, checks: () => RequiredCheck[], hang: () => boolean = () => false):
    MergeGateway & { merged: string[]; inspections: () => number; hung: AbortSignal[] } => {
    const merged: string[] = [], hung: AbortSignal[] = [];
    let inspections = 0;
    return { merged, hung, inspections: () => inspections,
      inspect: async request => {
        inspections++;
        // From this inspection on, GitHub does not answer; only the caller's abort ends the read.
        if (hang() && request?.signal) {
          hung.push(request.signal);
          await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
        }
        const identity = createIdentity(), pr = store().taskPullRequests(identity).find(row => row.number === request?.target?.pullRequest);
        const snapshot = store().getSnapshot(identity);
        return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true,
          mergeQueue: false, requiredChecks: checks(), alreadyFixed: 'clear', pullRequest: request!.target!.pullRequest, draft: false,
          published: { headBranch: request!.target!.headBranch!, baseBranch: 'main', crossRepository: false, marker: openingMarker(pr!.openingId),
            branchOpen: [{ number: request!.target!.pullRequest, base: 'main' }] } } as RemoteMergeState;
      },
      merge: async head => { merged.push(head); return { url: 'https://github.com/acme/app/pull/100' }; } };
  };
  let createIdentity: () => PlanIdentity = () => { throw new Error('not set'); };
  /** A review a person could merge: the demo's out-of-scope mode change undone, its unplanned changes accepted, all approved. */
  const mergeable = (w: World) => {
    chmodSync(join(w.demo.repository, 'run.sh'), 0o644); git(w.demo.repository, 'commit', '-qam', 'Restore declared scope');
  };
  const acceptAndApprove = async (service: ReviewService) => {
    let view = await service.load();
    for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous'))
      view = await service.act({ action: 'accept', key: segment.key, token: view.token });
    for (const item of view.items) if (item.state !== 'approved')
      view = await service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
  };
  const review = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/review`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
  const merge = async (app: App, token: string, actionId = randomUUID()) => {
    const response = await fetch(`${new URL(app.url).origin}/api/action`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'merge', token, actionId }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const mergeState = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/merge`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;

  it('offers Merge PR while only blockers the job resolves remain, then waits for checks and merges, refusing prepare-merge and publish meanwhile', async () => {
    const w = world(); mergeable(w);
    let checks: RequiredCheck[] = [{ context: 'ci', appId: null, state: 'pending' }], storeRef: Store | null = null;
    const gh = gateway(() => storeRef!, () => checks);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh, runnerPublished: true,
      mergeJobTiming: { checkWaitMs: 20_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const before = await review(served.app);
    // Not prepared yet, and a required check pends: both are the job's to resolve.
    expect(before.merge.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(expect.arrayContaining(['preparation', 'check']));
    // Worded as what Merge PR does: the screen has no Prepare control.
    expect(before.merge.blockers.find((blocker: { code: string }) => blocker.code === 'preparation').message)
      .toBe('The merge has not been prepared for the current review; merging prepares it.');
    // A runner server sends the codes a job settles before it merges, which the page drops once a job reached the merge.
    expect(before.merge.settledBeforeJobMerge).toEqual([...SETTLED_BEFORE_JOB_MERGE]);
    expect(before.merge).toMatchObject({ ready: true, action: 'merge', job: null });
    const started = await merge(served.app, before.token);
    expect(started.status).toBe(200);
    expect(started.body.job).toMatchObject({ state: 'running' });
    expect(started.body.merge).toMatchObject({ ready: false, job: { state: 'running' } });
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ step: 'checks', checks: [{ context: 'ci', state: 'pending' }] }), { timeout: 10_000 });
    // A second tab still holds the review read before the click: its click is refused, and the refusal carries the
    // running job so that page follows it. A resend replays the refusal with the task's latest job, still never as a job.
    const secondTab = randomUUID(), refused = await merge(served.app, before.token, secondTab);
    expect(refused).toMatchObject({ status: 409, body: { error: 'A merge is already running for this task.', job: { id: started.body.job.id, state: 'running', step: 'checks' } } });
    expect(await merge(served.app, before.token, secondTab)).toMatchObject({ status: 409, body: { error: refused.body.error, job: { id: started.body.job.id } } });
    expect((await mergeState(served.app)).job).toMatchObject({ id: started.body.job.id });
    expect(await act(served.app, 'prepare-merge')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/merge is running/) } });
    // A publish cannot begin a refresh of the PR the job waits on: publishing refuses a task in review.
    expect(await act(served.app, 'publish')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/The task is in review/) } });
    expect(served.store.taskPullRequests(served.identity).every(pr => pr.refresh === null)).toBe(true);
    checks = [{ context: 'ci', appId: null, state: 'success' }];
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'merged' }), { timeout: 10_000 });
    expect(gh.merged).toEqual([served.store.getSnapshot(served.identity).head]);
    expect(served.store.getTask(served.identity).status).toBe('merged');
   }, 60_000);

  it('refuses start and resume while a merge job waits, even after a new plan revision is imported and approved; the import only ends the job failed', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null;
    const base = gateway(() => storeRef!, () => [{ context: 'ci', appId: null, state: 'pending' }]);
    // The job's fresh inspections after its first are held until the test releases them (or the job's signal stops them),
    // so the job is still waiting for checks at every step below, whatever the machine's speed.
    let fresh = 0, release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const gh: MergeGateway = { merge: base.merge, inspect: async request => {
      if (request?.fresh && ++fresh > 1) await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      });
      return base.inspect(request);
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh, runnerPublished: true,
      mergeJobTiming: { checkWaitMs: 600_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    // The first inspection has answered (its pending check is recorded) and the second is held.
    await vi.waitFor(async () => {
      expect((await mergeState(served.app)).job).toMatchObject({ state: 'running', step: 'checks', checks: [{ context: 'ci', state: 'pending' }] });
      expect(fresh).toBe(2);
    }, { timeout: 10_000 });
    // As a person would: import a new revision of the plan (plan import has no task-status guard), then approve it all.
    const plan = served.store.getPlan(served.identity);
    const imported = await fetch(`${new URL(served.app.url).origin}/api/plan/import`, { method: 'POST', headers: { 'x-codeboost-token': served.app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source: JSON.stringify(plan), format: 'json', expectedRevision: plan.revision, actionId: randomUUID() }) });
    expect(imported.status).toBe(200);
    expect(served.store.getPlan(served.identity).revision).toBe(plan.revision + 1);
    await acceptAndApprove(served.app.service);
    expect(served.store.unapprovedExecutionItems(served.identity, plan.revision + 1)).toEqual([]);
    expect(served.store.getTask(served.identity).status).toBe('in review');
    const calls = [...w.github.calls], branchHead = w.github.head(served.branch), attempts = served.store.recentAttempts(served.identity, 50).length;
    // Neither is offered, and both are refused, while the job runs.
    expect(await view(served.app)).toMatchObject({ startable: false, resumable: false });
    for (const action of ['start', 'resume']) {
      const id = randomUUID(), refused = await act(served.app, action, id);
      expect(refused).toMatchObject({ status: 409, body: { error: 'A merge is running for this task; wait for it to end or cancel the task.' } });
      // Saved like other refusals: the same action ID replays it.
      expect(await act(served.app, action, id)).toMatchObject({ status: 409, body: { error: refused.body.error } });
    }
    expect((await mergeState(served.app)).job).toMatchObject({ state: 'running', step: 'checks' });
    expect(fresh).toBe(2);
    // What the import itself does to the job: the readiness it prepared is for the old review, so its next inspection
    // ends it failed, and nothing is merged, run, pushed or published.
    release();
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'failed',
      reason: 'The merge has not been prepared for the current review; merging prepares it.' }), { timeout: 10_000 });
    expect(served.store.getTask(served.identity).status).toBe('in review');
    expect(served.store.recentAttempts(served.identity, 50)).toHaveLength(attempts);
    expect(served.app.publishing!.busy(served.identity)).toBe(false);
    expect(w.github.calls).toEqual(calls);
    expect(w.github.head(served.branch)).toBe(branchHead);
    expect(base.merged).toEqual([]);
   }, 60_000);

  it('refuses start while a merge job prepares, even after a new plan revision is imported and approved', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, release!: () => void, preparing = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const gh = gateway(() => storeRef!, () => []);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, mergeGateway: gh, runnerPublished: true,
      // A preparation held until the test releases it; it then fails, as a real one does once the review changed under it.
      preMerge: service => ({
        get active() { return preparing; }, get last() { return null; }, assertStartable() {}, settlePendingPush: async () => null,
        cancelTask: () => 'closed' as const, close: async () => undefined,
        start: async (expected: { actionId: string }) => {
          preparing = true;
          await held;
          preparing = false;
          const identity = service.config.identity, snapshot = service.store.getSnapshot(identity);
          return service.store.settlePreMergeAction(identity, expected.actionId,
            { state: 'failed', base: snapshot.base, head: snapshot.head, checked: [], reason: 'The review changed during preparation.' }, null);
        },
      } as unknown as PreMergeCoordinator) });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    await vi.waitFor(async () => { expect(preparing).toBe(true); expect((await mergeState(served.app)).job).toMatchObject({ state: 'running', step: 'preparing' }); }, { timeout: 10_000 });
    const plan = served.store.getPlan(served.identity);
    const imported = await fetch(`${new URL(served.app.url).origin}/api/plan/import`, { method: 'POST', headers: { 'x-codeboost-token': served.app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source: JSON.stringify(plan), format: 'json', expectedRevision: plan.revision, actionId: randomUUID() }) });
    expect(imported.status).toBe(200);
    await acceptAndApprove(served.app.service);
    const calls = [...w.github.calls], attempts = served.store.recentAttempts(served.identity, 50).length;
    expect(await view(served.app)).toMatchObject({ startable: false });
    expect(await act(served.app, 'start')).toMatchObject({ status: 409, body: { error: 'A merge is running for this task; wait for it to end or cancel the task.' } });
    expect(served.store.getTask(served.identity).status).toBe('in review');
    expect(served.store.recentAttempts(served.identity, 50)).toHaveLength(attempts);
    release();
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'failed' }), { timeout: 10_000 });
    expect(w.github.calls).toEqual(calls);
    expect(gh.merged).toEqual([]);
   }, 60_000);

  it('admits issue trust before a merge job starts: an untrusted click is refused and replayed, a failed read saves nothing', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, access: 'untrusted' | 'unreadable' | 'trusted' = 'trusted', reads = 0, prepared = 0;
    const gh = gateway(() => storeRef!, () => []);
    const gate: IssueTrustGateway = { ...issueGateway, async issueAccess(number) {
      reads++;
      if (access === 'unreadable') throw new Error('GitHub returned HTTP 502');
      return access === 'trusted' ? { number, authorLogin: 'member', collaborator: true } : { number, authorLogin: 'outside', collaborator: false };
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway: gate, mergeGateway: gh, runnerPublished: true,
      preMerge: service => { const real = preparation(service); return { ...real, get active() { return false; }, get last() { return null; },
        start: (expected: { actionId: string }) => { prepared++; return (real.start as (value: unknown) => unknown)(expected); } } as unknown as PreMergeCoordinator; } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID();
    // A failed read decides nothing: nothing is saved, so the same click may be sent again.
    access = 'unreadable';
    expect((await merge(served.app, token, id)).status).toBe(502);
    expect(served.store.getMergeJob(served.identity, id)).toBeNull();
    access = 'untrusted';
    expect(await merge(served.app, token, id)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not trusted/) } });
    expect(served.store.getMergeJob(served.identity, id)).toMatchObject({ refused: true });
    // The resend replays the refusal without another read, even once the issue is trusted.
    access = 'trusted'; const before = reads;
    expect(await merge(served.app, token, id)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not trusted/) } });
    expect(reads).toBe(before);
    expect(prepared).toBe(0);
    expect((await mergeState(served.app)).job).toBeNull();
    // A new click on a trusted issue starts the job.
    expect((await merge(served.app, token)).status).toBe(200);
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'merged' }), { timeout: 10_000 });
    expect(prepared).toBe(1);
  }, 60_000);

  it('refuses a merge click while a preparation\'s command check holds the runner, and the resend replays the refusal', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, preparing = false;
    const hold = Promise.withResolvers<void>();
    const gh = gateway(() => storeRef!, () => []);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, mergeGateway: gh,
      runnerPublished: true, checks: true, hold: hold.promise,
      // A preparation started by prepare-merge while the task is in review: it runs a command-check attempt through the
      // real runner (held until the test releases it) and waits for it to settle, as production's does.
      preMerge: (service, runner) => ({
        get active() { return preparing; }, get last() { return null; }, settlePendingPush: async () => null,
        cancelTask: () => 'closed' as const, close: async () => undefined,
        assertStartable() { if (preparing) throw new GuardRefusal('Pre-merge preparation is already running.'); },
        start: async (expected: { actionId: string }) => {
          preparing = true;
          try {
            const identity = service.config.identity;
            runner.start(identity, { expectedStateVersion: service.store.getTask(identity).stateVersion, kind: 'check',
              item: service.store.getPlan(identity).items[0]!.id, deadline: Date.now() + 60_000, expectedContext: service.store.currentContext(identity) });
            await runner.settled(identity);
            const snapshot = service.store.getSnapshot(identity);
            return service.store.settlePreMergeAction(identity, expected.actionId,
              { state: 'failed', base: snapshot.base, head: snapshot.head, checked: [], reason: 'The task or review changed during preparation. Reload first.' }, null);
          } finally { preparing = false; }
        },
      } as unknown as PreMergeCoordinator) });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect(served.store.getTask(served.identity).status).toBe('in review');
    expect(await act(served.app, 'prepare-merge')).toMatchObject({ status: 200 });
    await vi.waitFor(() => expect(served.app.runner!.isActive(served.identity)).toBe(true), { timeout: 10_000 });
    const { token } = await review(served.app), id = randomUUID(), busy = 'The runner or publisher is busy; the merge cannot start yet.';
    expect(await merge(served.app, token, id)).toMatchObject({ status: 409, body: { error: busy, job: null } });
    // No job started: the click's refusal is saved instead.
    expect(served.store.getMergeJob(served.identity, id)).toMatchObject({ refused: true, reason: busy });
    expect((await mergeState(served.app)).job).toBeNull();
    hold.resolve();
    await vi.waitFor(() => { expect(preparing).toBe(false); expect(served.app.runner!.isActive(served.identity)).toBe(false); }, { timeout: 10_000 });
    // The resend replays the saved refusal, though the runner is idle now.
    expect(await merge(served.app, token, id)).toMatchObject({ status: 409, body: { error: busy, job: null } });
    expect((await mergeState(served.app)).job).toBeNull();
    expect(gh.merged).toEqual([]);
  }, 60_000);

  it('answers 503 and saves nothing when shutdown stops a merge click\'s trust read', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, hang = false, reading = false;
    const gh = gateway(() => storeRef!, () => []);
    const gate: IssueTrustGateway = { ...issueGateway, issueAccess(number, options = {}) {
      if (!hang) return Promise.resolve({ number, authorLogin: 'member', collaborator: true });
      reading = true;
      // GitHub does not answer; only the request's own abort (at the end of shutdown's drain) ends the read.
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway: gate, preMerge: preparation, mergeGateway: gh, runnerPublished: true });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID(), database = served.app.service.config.database;
    hang = true;
    const clicked = merge(served.app, token, id);
    await vi.waitFor(() => expect(reading).toBe(true), { timeout: 10_000 });
    const closed = served.close();
    expect(await clicked).toMatchObject({ status: 503 });
    await closed;
    const reopened = new Store(database);
    try { expect(reopened.getMergeJob(served.identity, id)).toBeNull(); } finally { reopened.close(); }
  }, 60_000);

  it('answers a merge click whose trust read fails with the job a resend of the same click saved meanwhile', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, hold = false, fail!: (error: Error) => void, reading!: () => void;
    const held = new Promise<void>(resolve => { reading = resolve; });
    const gh = gateway(() => storeRef!, () => []);
    const gate: IssueTrustGateway = { ...issueGateway, issueAccess(number) {
      // The first click's read is held until it fails; the resend's read (and the publish's before) answers at once.
      if (hold) { hold = false; reading(); return new Promise((_resolve, reject) => { fail = reject; }); }
      return Promise.resolve({ number, authorLogin: 'member', collaborator: true });
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway: gate, preMerge: preparation, mergeGateway: gh, runnerPublished: true });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID();
    hold = true;
    const first = merge(served.app, token, id);
    await held;
    const second = await merge(served.app, token, id);
    expect(second).toMatchObject({ status: 200, body: { job: { id } } });
    expect(served.store.getMergeJob(served.identity, id)).toMatchObject({ id });
    fail(new Error('GitHub returned HTTP 502'));
    expect(await first).toMatchObject({ status: 200, body: { job: { id } } });
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'merged' }), { timeout: 10_000 });
  }, 60_000);

  it.each([
    ['timed out', () => new RemoteTimeout('Issue retrieval timed out.'), 503, 'Issue trust could not be verified: Issue retrieval timed out.'],
    ['gh answered', () => new CommandFailed('gh failed (exit 1): HTTP 404: Not Found', '', ''), 502, 'Issue trust could not be verified: gh failed (exit 1): HTTP 404: Not Found'],
  ] as const)('keeps a merge click\'s trust read failure (%s) when shutdown starts while gh stops, saving nothing', async (_name, failure, status, error) => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, hang = false, fail!: (error: Error) => void, reading!: () => void;
    const held = new Promise<void>(resolve => { reading = resolve; });
    const gh = gateway(() => storeRef!, () => []);
    const gate: IssueTrustGateway = { ...issueGateway, issueAccess(number) {
      if (!hang) return Promise.resolve({ number, authorLogin: 'member', collaborator: true });
      reading();
      return new Promise((_resolve, reject) => { fail = reject; });
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway: gate, preMerge: preparation, mergeGateway: gh, runnerPublished: true });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID(), database = served.app.service.config.database;
    hang = true;
    const clicked = merge(served.app, token, id);
    await held;
    // Shutdown's first step runs at once; the read then ends with its own failure, which happened first.
    const closed = served.close();
    fail(failure());
    expect(await clicked).toMatchObject({ status, body: { error } });
    await closed;
    const reopened = new Store(database);
    try { expect(reopened.getMergeJob(served.identity, id)).toBeNull(); } finally { reopened.close(); }
  }, 60_000);

  it('answers 503 when shutdown stops the reload after a merge job was saved, keeping the saved job for a resend', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, hanging = false;
    // From the click on, GitHub does not answer; only the caller's abort ends each read.
    const gh = gateway(() => storeRef!, () => [], () => hanging);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh, runnerPublished: true });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID(), database = served.app.service.config.database;
    hanging = true;
    const clicked = merge(served.app, token, id);
    await vi.waitFor(() => expect(served.store.getMergeJob(served.identity, id)).not.toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(gh.hung.length).toBeGreaterThan(0), { timeout: 10_000 });
    const closed = served.close();
    expect(await clicked).toMatchObject({ status: 503 });
    await closed;
    // The job was saved under the click's action ID, which a resend replays (merge-job.test.ts covers the replay).
    const reopened = new Store(database);
    try { expect(reopened.getMergeJob(served.identity, id)).toMatchObject({ id }); } finally { reopened.close(); }
  }, 60_000);

  it('answers the started job when its click cannot reload the review, and the resent click returns the job', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null;
    const gh = gateway(() => storeRef!, () => []);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh,
      runnerPublished: true, mergeJobTiming: { checkWaitMs: 20_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID();
    // The click's own reload after its job was saved fails once (as a history worker timing out would). The admission load
    // and the reload share the request's signal; the job's loads carry the job's own signal.
    const service = served.app.service, realLoad = service.load.bind(service), requestSignals = new Set<AbortSignal>();
    let failed = false;
    service.load = async (options?: Parameters<typeof realLoad>[0]) => {
      const signal = options?.signal;
      if (signal && !failed && requestSignals.has(signal)) { failed = true; throw new Error('History worker timed out.'); }
      if (signal) requestSignals.add(signal);
      return realLoad(options);
    };
    const clicked = await merge(served.app, token, id);
    expect(failed).toBe(true);
    const saved = served.store.getMergeJob(served.identity, id);
    expect(saved).not.toBeNull(); // The click's job was saved and started.
    // The job itself, so the page follows it, and a request to refresh the review.
    expect(clicked).toMatchObject({ status: 200, body: { job: { id: saved!.id }, mergeRefreshRequired: true } });
    // The same click, sent again, replays its job.
    const resent = await merge(served.app, token, id);
    expect(resent).toMatchObject({ status: 200, body: { job: { id: served.store.getMergeJob(served.identity, id)!.id } } });
  }, 60_000);

  it('answers a merge click with the job\'s latest record when it ended during the click\'s reload', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, slow = false;
    const base = gateway(() => storeRef!, () => []);
    // The click's reload reads GitHub's display status (not fresh), and that read is held until the job has merged; the
    // job's own fresh inspections answer at once. So the job ends during the click's reload, whatever the machine's speed.
    const gh: MergeGateway = { merge: base.merge, inspect: async request => {
      if (slow && !request?.fresh) await vi.waitFor(() => expect(storeRef!.latestMergeJob(createIdentity())?.state).toBe('merged'), { timeout: 40_000, interval: 50 });
      return base.inspect(request);
    } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh,
      runnerPublished: true, mergeJobTiming: { checkWaitMs: 20_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const { token } = await review(served.app), id = randomUUID();
    slow = true;
    const clicked = await merge(served.app, token, id);
    // The job merged while the click's response was being prepared: the response says so, not "preparing".
    expect(served.store.getMergeJob(served.identity, id)).toMatchObject({ state: 'merged' });
    expect(clicked).toMatchObject({ status: 200, body: { job: { id, state: 'merged' } } });
  }, 60_000);

  it('closes the pull requests of a task whose cancel waited for the merge job\'s preparation to settle', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, release!: () => void, preparing = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    // The stub records a rebase to commits that do not exist, so it starts only once the click has been answered: the
    // click's own review reload (which awaits a history worker, #170) must not read them.
    let answered!: () => void;
    const clickAnswered = new Promise<void>(resolve => { answered = resolve; });
    const gh = gateway(() => storeRef!, () => []);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, mergeGateway: gh, runnerPublished: true,
      // A preparation caught in its push: it holds a real push marker, so a cancel waits ("stopping") until the push
      // settles, and clearing the marker closes the task, as production does.
      preMerge: service => {
        const identity = service.config.identity;
        let marker: { attemptId: string } | null = null;
        return {
          get active() { return preparing; }, get last() { return null; }, assertStartable() {}, settlePendingPush: async () => null, close: async () => undefined,
          cancelTask: (stateVersion: number, actionId: string) => service.store.cancelTask(identity, stateVersion, actionId),
          start: async (expected: { actionId: string }) => {
            preparing = true;
            await clickAnswered;
            const reviewed = () => ({ revision: service.store.getPlan(identity).revision, snapshotId: service.store.getSnapshot(identity).id, reviewVersion: service.store.reviewVersion(identity) });
            const head = service.store.getSnapshot(identity).head, rewritten = 'e'.repeat(40);
            service.store.recordRebase(identity, reviewed(), 'f'.repeat(40), rewritten, [{ oldSha: head, newSha: rewritten }]);
            marker = service.store.beginPrePush(identity, reviewed(), service.store.getTask(identity).stateVersion,
              { branch: service.store.taskPullRequests(identity)[0]!.headBranch, from: head, to: rewritten });
            await held;
            service.store.finishPrePush(service.store.getTask(identity).planKey, marker.attemptId);
            preparing = false;
            const snapshot = service.store.getSnapshot(identity);
            return service.store.settlePreMergeAction(identity, expected.actionId,
              { state: 'failed', base: snapshot.base, head: snapshot.head, checked: [], reason: 'Task cancelled.' }, null);
          },
        } as unknown as PreMergeCoordinator;
      } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    answered();
    await vi.waitFor(() => expect(served.store.getTask(served.identity).pushInProgress).not.toBeNull(), { timeout: 10_000 });
    expect((await act(served.app, 'cancel-task')).body.result).toEqual({ outcome: 'stopping' });
    expect(served.store.getTask(served.identity)).toMatchObject({ status: 'in review', cancelRequested: expect.any(String) });
    expect(w.github.prs[0]!.open).toBe(true);
    release();
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'cancelled' }), { timeout: 10_000 });
    await vi.waitFor(() => expect(w.github.prs[0]!.open).toBe(false), { timeout: 20_000 });
    expect(served.store.getTask(served.identity).status).toBe('cancelled');
  }, 60_000);

  it('stops a waiting merge job promptly on shutdown and leaves it running on disk for the next startup', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, hanging = false;
    const gh = gateway(() => storeRef!, () => [{ context: 'ci', appId: null, state: 'pending' }], () => hanging);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh,
      runnerPublished: true, mergeJobTiming: { checkWaitMs: 600_000, firstDelayMs: 30, maxDelayMs: 30 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ step: 'checks' }), { timeout: 10_000 });
    // GitHub stops answering the job's next inspection; only the job's own abort can end that read.
    hanging = true;
    await vi.waitFor(() => expect(gh.hung).toHaveLength(1), { timeout: 10_000 });
    const database = served.app.service.config.database, closing = Date.now();
    const closed = served.close();
    // Shutdown's first synchronous turn stops the job, before any drain, so it cannot ask GitHub to merge meanwhile.
    expect(gh.hung[0]!.aborted).toBe(true);
    await closed;
    expect(Date.now() - closing).toBeLessThan(10_000);
    const reopened = new Store(database);
    try { expect(reopened.latestMergeJob(served.identity)).toMatchObject({ state: 'running', step: 'checks' }); } finally { reopened.close(); }
  }, 60_000);

  it('closes the merge job before the store, so a job settling after the shutdown abort records its outcome', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, merging: AbortSignal | null = null;
    const base = gateway(() => storeRef!, () => []);
    // GitHub was asked to merge; after the abort it answers, a little later, with a refusal.
    const gh: MergeGateway = { inspect: base.inspect, merge: (_head, options) => new Promise((_resolve, reject) => {
      merging = options!.signal!;
      merging.addEventListener('abort', () => setTimeout(() => reject(new MergeSubmissionError('Base branch was modified.', 'refused')), 300), { once: true });
    }) };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh,
      runnerPublished: true, mergeJobTiming: { checkWaitMs: 20_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    await vi.waitFor(() => expect(merging).not.toBeNull(), { timeout: 10_000 });
    const database = served.app.service.config.database, order: string[] = [];
    const jobClose = MergeJobCoordinator.prototype.close, storeClose = Store.prototype.close;
    const jobs = vi.spyOn(MergeJobCoordinator.prototype, 'close').mockImplementation(async function (this: MergeJobCoordinator) {
      await jobClose.call(this); order.push('job settled');
    });
    const stores = vi.spyOn(Store.prototype, 'close').mockImplementation(function (this: Store) { order.push('store closed'); return storeClose.call(this); });
    try { await served.close(); } finally { jobs.mockRestore(); stores.mockRestore(); }
    // Shutdown closed the job before the store (close awaiting the job is shown in merge-job.test.ts), and the job's last
    // write landed: it ended as its merge attempt records it.
    expect(order[0]).toBe('job settled');
    expect(order).toContain('store closed');
    const reopened = new Store(database);
    try {
      expect(reopened.latestMergeJob(served.identity)).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge/) });
      expect(reopened.getTask(served.identity).status).toBe('approved but merge blocked');
    } finally { reopened.close(); }
  }, 60_000);

  it('stops a waiting merge job when the task is cancelled, and closes the task\'s pull requests', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null;
    const gh = gateway(() => storeRef!, () => [{ context: 'ci', appId: null, state: 'pending' }]);
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh, runnerPublished: true,
      // Waits far longer than this test: only the cancel route's own stop can end the job in time.
      mergeJobTiming: { checkWaitMs: 600_000, firstDelayMs: 60_000, maxDelayMs: 60_000 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ step: 'checks' }), { timeout: 10_000 });
    expect((await act(served.app, 'cancel-task')).body.result).toEqual({ outcome: 'closed' });
    await vi.waitFor(async () => expect((await mergeState(served.app)).job).toMatchObject({ state: 'cancelled' }), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.github.prs[0]!.open).toBe(false), { timeout: 20_000 });
    expect(gh.merged).toEqual([]);
   }, 60_000);

  it('logs, and does not reject, when reading the task fails as the server follows a settled merge job', async () => {
    const w = world(); mergeable(w);
    let storeRef: Store | null = null, release!: () => void;
    const answered = new Promise<void>(resolve => { release = resolve; });
    const base = gateway(() => storeRef!, () => []);
    // GitHub answers the merge only once the click was answered, so the job settles after the click's own review reload.
    const gh: MergeGateway = { inspect: base.inspect, merge: async () => { await answered; return { url: 'https://github.com/acme/app/pull/100' }; } };
    const served = await serve(w, { before: async service => { completeAll(service); await acceptAndApprove(service); }, issueGateway, preMerge: preparation, mergeGateway: gh,
      runnerPublished: true, mergeJobTiming: { checkWaitMs: 20_000, firstDelayMs: 20, maxDelayMs: 50 } });
    storeRef = served.store; createIdentity = () => served.identity;
    await publishSettled(served.app, served.identity);
    const unhandled: unknown[] = [], onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const logged = vi.spyOn(console, 'error');
    // The first task read after the job's ending write fails: that is the server's `.finally` following the job.
    let failNext = false;
    const getTask = served.store.getTask.bind(served.store), finishMergeJob = served.store.finishMergeJob.bind(served.store);
    served.store.finishMergeJob = ((...args: Parameters<Store['finishMergeJob']>) => { const ended = finishMergeJob(...args); failNext = true; return ended; }) as Store['finishMergeJob'];
    served.store.getTask = ((identity: PlanIdentity) => {
      if (failNext) { failNext = false; throw new Error('database is locked'); }
      return getTask(identity);
    }) as Store['getTask'];
    try {
      expect((await merge(served.app, (await review(served.app)).token)).status).toBe(200);
      release();
      await vi.waitFor(() => expect(served.store.latestMergeJob(served.identity)).toMatchObject({ state: 'merged' }), { timeout: 10_000 });
      // The server's callback runs a few microtasks after the ending write; an unhandled rejection is reported after them.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(failNext).toBe(false);
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledWith('Could not close the cancelled task\'s pull requests after its merge job: "database is locked"');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      served.store.getTask = getTask; served.store.finishMergeJob = finishMergeJob; logged.mockRestore();
    }
  }, 60_000);
});

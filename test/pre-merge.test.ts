import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { COMMAND_CHECK_SETTLEMENT_RESERVE_MS, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS, PreMergeCoordinator,
  type PreMergeAuthorization, type PreMergeResult } from '../runner/pre-merge.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { MergeJobCoordinator } from '../runner/merge-job.ts';
import { MergeSubmissionError, type MergeGateway } from '../github/merge.ts';
import { openingMarker } from '../github/pull-requests.ts';
import { ReviewService } from '../runner/review.ts';
import { createDemo } from '../scripts/demo.ts';
import { fixtureGit } from './fixtures/git.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { commandCheckDeps } from '../runner/checks.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import type { InvocationHandle, InvocationResult } from '../agents/contract.ts';
import type { TaskWorkspace, WorkspaceRef } from '../runner/execution.ts';
import { MIN_REBASE_CLEANUP_TIMEOUT_MS, MIN_REBASE_TIMEOUT_MS, RebaseResourcesUnsettled } from '../runner/rebase.ts';
import { BranchPushRefused } from '../runner/branch-push.ts';
import { UpstreamFailure } from '../runner/lifecycle.ts';
import { RemoteTimeout } from '../github/timeout.ts';
import { CommandFailed } from '../github/run-with-input.ts';

// A passthrough, so a test can act while a preparation's worker history read is in flight.
const historyReads = vi.hoisted(() => ({ during: undefined as (() => void) | undefined }));
vi.mock('../runner/history-job.ts', async original => {
  const actual = await original<typeof import('../runner/history-job.ts')>();
  return { ...actual, readHistoryInWorker: vi.fn((...args: Parameters<typeof actual.readHistoryInWorker>) => {
    const reading = actual.readHistoryInWorker(...args); historyReads.during?.(); return reading;
  }) };
});
afterEach(() => { historyReads.during = undefined; });
/** The review state a load would expect, read synchronously so a hook acts at its exact point in the preparation. */
const reviewState = (service: ReviewService) => ({ revision: service.store.getPlan(service.config.identity).revision,
  snapshotId: service.store.getSnapshot(service.config.identity).id, reviewVersion: service.store.reviewVersion(service.config.identity) });

const roots: string[] = [], services: ReviewService[] = [];
const BRANCH = 'codeboost/task-1';
// A remote fake for tests whose path must never push or read the branch.
const unusedPush = { push: async () => { throw new Error('No push expected.'); },
  readBranch: async () => { throw new Error('No branch read expected.'); } };
vi.setConfig({ testTimeout: 15_000 });
afterEach(() => { vi.restoreAllMocks(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The task's PR as the runner publishes it (F6b tests): a clear pre-PR check, then PR 7 from BRANCH into main. */
const publishPullRequest = (service: ReviewService) => {
  const identity = service.config.identity, store = service.store, snapshot = store.getSnapshot(identity);
  const check = store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: snapshot.id,
    reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: snapshot.base } });
  const opening = store.beginPullRequest(identity, { checkId: check.id, repository: 'acme/app', base: 'main', headBranch: BRANCH,
    headSha: snapshot.head, draft: false });
  expect(store.recordPullRequestOpened(identity, opening.openingId, { number: 7, url: 'https://github.com/acme/app/pull/7',
    headSha: snapshot.head, draft: false }, true)).toBe('in review');
};
const markRunnerOwned = (service: ReviewService, published = false) => {
  const identity = service.config.identity;
  service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'queued');
  const attempt = service.store.admitAttempt(identity, { expectedStateVersion: service.store.getTask(identity).stateVersion,
    kind: 'execute', item: 'P1', deadline: Date.now() + 60_000, expectedContext: service.store.currentContext(identity) });
  service.store.markRunning(identity, attempt.id);
  service.store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true,
    result: { unchanged: false, head: service.store.getSnapshot(identity).head } });
  if (published) publishPullRequest(service);
  else service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'in review');
  service.config.runnerRepository = service.config.repository;
};
const markRunnerUnchanged = (service: ReviewService) => {
  const identity = service.config.identity;
  service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'queued');
  const attempt = service.store.admitAttempt(identity, { expectedStateVersion: service.store.getTask(identity).stateVersion,
    kind: 'execute', item: 'P1', deadline: Date.now() + 60_000, expectedContext: service.store.currentContext(identity) });
  service.store.markRunning(identity, attempt.id);
  service.store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true,
    result: { unchanged: true, head: service.store.getSnapshot(identity).head } });
  service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'in review');
};

async function rebaseFixture(rebasedText: string, commandExit?: number, options: {
  duringRebase?: (service: ReviewService, coordinator: PreMergeCoordinator, timeoutMs?: number) => void;
  duringFinalInspect?: (service: ReviewService, coordinator: PreMergeCoordinator, read: number) => void;
  /** Runs on each inspection that still shows the pre-push pull request (the wait for the new head to show). */
  duringVisibilityWait?: (service: ReviewService) => void;
  /** Runs inside each fetch after a push or refusal, while the fetch is in flight. */
  duringFetchAfterPush?: (service: ReviewService) => void;
  duringAuthorize?: (service: ReviewService, call: number) => { base: string; head: string } | void;
  /** Runs while each review load the preparation starts is in flight. */
  duringLoad?: (service: ReviewService) => void;
  closeDuringCommand?: boolean;
  closeAfterCommandAdmission?: boolean;
  commandWaitsForDeadline?: boolean;
  commandWaitsForCancellation?: boolean;
  releaseFails?: boolean;
  unsettledRebase?: boolean;
  rebaseFailure?: Error;
  rebaseCleanupFailure?: Error;
  runnerCommitted?: boolean;
  operationTimeoutMs?: number;
  /** The second argument lets an authorization stop the preparation while its read is settling. */
  authorize?: (signal: AbortSignal, fixture: { coordinator: PreMergeCoordinator }) => Promise<PreMergeAuthorization>;
  reserves?: { processMs?: number; commandMs?: number; pushVisibleMs?: number };
  /** The PR API keeps reporting the pre-push head for this many inspections after a push. */
  pushVisibleAfter?: number;
  /** The base branch moves as the push lands: lagging and later inspections report this base. */
  movedBaseAfterPush?: (service: ReviewService) => string;
  /** The push lands on the branch before it fails. */
  landBeforeFailure?: boolean;
  /** A later rebase's result (the first rebase always yields the fixture's `rebased`); `undefined` keeps the default. */
  rebaseResult?: (service: ReviewService, input: { oldHead: string; onto: string }, run: number) => string | undefined;
  /** Branch reads never answer; only their abort signal ends them. */
  branchReadHangs?: boolean;
  /** The runner published the task's PR 7 (merging then requires preparation, as in production). */
  published?: boolean;
  /** Set up everything but start no preparation; `result` is then null. */
  deferStart?: boolean;
  /** Remote fetches fail once codeboost has pushed. */
  fetchFailsAfterPush?: boolean;
  /** A collaborator pushes this commit to the branch just before codeboost's push, which is then refused. */
  pushedFirst?: (service: ReviewService) => string;
  /** Runs once the push has landed and may move the branch again, as a collaborator push would. */
  afterPush?: (service: ReviewService, pushed: string) => string;
  /** The push lands, but its read-back (as GitBranchPusher's) sees another head and throws. */
  readBackFails?: boolean;
  pushFailure?: (service: ReviewService, input: { from: string; to: string }) => Error;
  branchRead?: (current: string, signal?: AbortSignal) => string | null | Promise<string | null>;
  /** Runs while the push reads the remote, before its final local checks (the pusher's `beforePush`). */
  duringPushRead?: (service: ReviewService, coordinator: PreMergeCoordinator) => void;
  /** Saves the preparation's outcome under this action ID, as the server's prepare-merge action does. */
  actionId?: string;
  /** Runs while a command check runs (when its workspace is materialized). */
  duringCommand?: (service: ReviewService) => void;
  /** Runs after a command check's terminal write, while the runner releases its workspace. */
  duringRelease?: (service: ReviewService) => void;
  /** The exit code of each command check, read when it runs; replaces `commandExit` when given. */
  commandResult?: () => number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-base-')); roots.push(root);
  const repository = join(root, 'repo'); fixtureGit(root, 'init', '-q', '-b', 'main', repository);
  fixtureGit(repository, 'config', 'user.name', 'Test'); fixtureGit(repository, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repository, 'a.txt'), 'base\n'); fixtureGit(repository, 'add', '.'); fixtureGit(repository, 'commit', '-qm', 'base');
  const base = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-qc', 'feature');
  writeFileSync(join(repository, 'a.txt'), 'feature\n'); fixtureGit(repository, 'commit', '-am', 'feature', '-q');
  const head = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-q', '-C', 'main', base);
  writeFileSync(join(repository, 'b.txt'), 'new base\n'); fixtureGit(repository, 'add', '.'); fixtureGit(repository, 'commit', '-qm', 'move base');
  const onto = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-qc', 'rebased');
  writeFileSync(join(repository, 'a.txt'), rebasedText); fixtureGit(repository, 'commit', '-am', 'rebased feature', '-q');
  const rebased = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-q', 'feature');
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const allowedCommands = commandExit === undefined ? [] : [['npm', 'test']];
  const config = { database: join(root, 'review.sqlite'), repository, runnerRepository: repository, identity,
    pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' as const }, allowedCommands };
  const service = new ReviewService(config); services.push(service);
  const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'One change', questions: [], items: [{ id: 'P1',
    title: 'Change a', intent: 'Change a', files: [{ path: 'a.txt', kind: 'edit', renamed_from: null, change: 'Change it' }],
    acceptance: commandExit === undefined ? [{ type: 'check', text: 'a changed' }] : [{ type: 'cmd', text: 'npm test' }], depends_on: [] }] };
  const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.txt', kind: 'file' }], pathKey: path => path, allowedCommands };
  service.store.createPlan(JSON.stringify(plan), 'json', context, base, head);
  let view = await service.load();
  service.store.recordHistory(identity, view.expected, base, head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  if (options.runnerCommitted !== false) markRunnerOwned(service, options.published === true); else markRunnerUnchanged(service);
  view = await service.load(); view = await service.act({ action: 'approve', item: 'P1', token: view.token });
  let coordinator!: PreMergeCoordinator, rebaseRuns = 0;
  let rebaseAborts = 0;
  const rebaseBudgets: Array<number | undefined> = [], abortBudgets: Array<number | undefined> = [];
  const rebaser = { run: async (input: { attemptId: string; signal: AbortSignal; timeoutMs?: number; oldHead: string; onto: string }) => {
    rebaseRuns++;
    rebaseBudgets.push(input.timeoutMs);
    options.duringRebase?.(service, coordinator, input.timeoutMs);
    input.signal.throwIfAborted();
    if (options.unsettledRebase) throw new RebaseResourcesUnsettled('Conflict resources remain owned.');
    if (options.rebaseFailure) throw options.rebaseFailure;
    const planKey = service.store.getTask(identity).planKey;
    const custom = options.rebaseResult?.(service, input, rebaseRuns);
    if (custom) {
      service.store.prepareRebaseResult(planKey, input.attemptId, custom, [custom]);
      service.store.completeRebaseResult(planKey, input.attemptId);
      return { oldHead: input.oldHead, base: input.onto, head: custom, mappings: [{ oldSha: input.oldHead, newSha: custom }], resolvedConflicts: [] };
    }
    service.store.prepareRebaseResult(planKey, input.attemptId, rebased, [rebased]);
    service.store.completeRebaseResult(planKey, input.attemptId);
    return { oldHead: head, base: onto, head: rebased,
      mappings: [{ oldSha: head, newSha: rebased }], resolvedConflicts: [] };
  }, abort: async (_attemptId: string, _head?: string, _state?: string, timeoutMs?: number) => {
    rebaseAborts++; abortBudgets.push(timeoutMs);
    if (options.rebaseCleanupFailure) throw options.rebaseCleanupFailure;
  } } as never;
  const checkedHeads: string[] = [];
  const workspace: TaskWorkspace = {
    async materialize(attempt, checkedHead) {
      checkedHeads.push(checkedHead);
      options.duringCommand?.(service);
      return { clone: { id: attempt.id, taskId: 'task', directory: repository, head: checkedHead }, storage: {} } as WorkspaceRef;
    },
    async snapshotDeclaredLinks() { throw new Error('not used'); }, async checkTree() { throw new Error('not used'); },
    async inspectChanges() { throw new Error('not used'); }, async commit() { throw new Error('not used'); },
    async release() { options.duringRelease?.(service); if (options.releaseFails) throw new Error('cleanup failed'); },
  };
  const cancelReasons: string[] = [];
  const runner = new RunnerCoordinator(service.store, commandCheckDeps(service.store, workspace, input => {
    if (options.closeDuringCommand) {
      let settle!: (result: InvocationResult) => void;
      const settled = new Promise<InvocationResult>(resolve => { settle = resolve; });
      queueMicrotask(() => { void coordinator.close(); });
      return { attemptId: input.attemptId, settled, cancel(reason) {
        cancelReasons.push(reason);
        settle({ attemptId: input.attemptId, context: input.context, exitCode: null,
          signal: 'SIGTERM', stopReason: reason, stdout: '', stderr: '' });
      } } satisfies InvocationHandle;
    }
    if (options.commandWaitsForDeadline) {
      const settled = new Promise<InvocationResult>(resolve => {
        setTimeout(() => resolve({ attemptId: input.attemptId, context: input.context, exitCode: null,
          signal: 'SIGTERM', stopReason: 'timeout', stdout: '', stderr: '' }), Math.max(0, input.deadline - Date.now()));
      });
      return { attemptId: input.attemptId, settled, cancel() {} } satisfies InvocationHandle;
    }
    if (options.commandWaitsForCancellation) {
      let settle!: (result: InvocationResult) => void;
      const settled = new Promise<InvocationResult>(resolve => { settle = resolve; });
      return { attemptId: input.attemptId, settled, cancel(reason) {
        cancelReasons.push(reason);
        settle({ attemptId: input.attemptId, context: input.context, exitCode: null,
          signal: 'SIGTERM', stopReason: reason, stdout: '', stderr: '' });
      } } satisfies InvocationHandle;
    }
    if (options.closeAfterCommandAdmission) {
      let settle!: (result: InvocationResult) => void;
      const settled = new Promise<InvocationResult>(resolve => { settle = resolve; });
      setTimeout(() => settle({ attemptId: input.attemptId, context: input.context, exitCode: 0,
        signal: null, stdout: '', stderr: '' }), 50);
      return { attemptId: input.attemptId, settled, cancel(reason) {
        cancelReasons.push(reason);
        settle({ attemptId: input.attemptId, context: input.context, exitCode: null,
          signal: 'SIGTERM', stopReason: reason, stdout: '', stderr: '' });
      } } satisfies InvocationHandle;
    }
    const exitCode = options.commandResult?.() ?? commandExit ?? 0;
    return { attemptId: input.attemptId,
      settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode,
        signal: null, stdout: '', stderr: exitCode ? 'failed' : '' }), cancel() {} } satisfies InvocationHandle;
  }, context.allowedCommands, 'a'.repeat(32)));
  let remoteReads = 0, remotePair: { base: string; head: string; branch?: string } = { base: onto, head, branch: BRANCH };
  const pushes: { branch: string; from: string; to: string }[] = [];
  let lagging = 0, lagged = remotePair, branchReads = 0, fetchesAfterPush = 0;
  let authorizationChecks = 0;
  const authorize = options.authorize ? (signal: AbortSignal) => options.authorize!(signal, { coordinator }) : (options.duringAuthorize ? async () => ({
    refresh: async () => undefined,
    validate: () => { remotePair = options.duringAuthorize!(service, ++authorizationChecks) ?? remotePair; },
  }) : undefined);
  if (options.duringLoad) {
    const load = service.load.bind(service);
    service.load = (loadOptions?: Parameters<ReviewService['load']>[0]) => {
      const loading = load(loadOptions);
      // A hook that throws fails this load as a worker failure would: asynchronously, once the real load has settled.
      try { options.duringLoad!(service); }
      catch (error) { return loading.then(() => { throw error; }, () => { throw error; }); }
      return loading;
    };
  }
  coordinator = new PreMergeCoordinator(service,
    runner,
    rebaser, { inspect: async () => {
      if (lagging > 0) { lagging--; options.duringVisibilityWait?.(service); return lagged; }
      remoteReads++;
      // Read 2 is the post-push visibility check; hooks keep counting the later inspections as before the push existed.
      if (remoteReads > 2) options.duringFinalInspect?.(service, coordinator, remoteReads - 1);
      return remotePair;
    }, fetch: async () => {
      if (pushes.length) fetchesAfterPush++;
      if (pushes.length) options.duringFetchAfterPush?.(service);
      if (options.fetchFailsAfterPush && pushes.length) throw new Error('fetch failed after the push');
    },
    push: async input => {
      pushes.push({ branch: input.branch, from: input.from, to: input.to });
      options.duringPushRead?.(service, coordinator);
      input.beforePush();
      if (options.landBeforeFailure && remotePair.head === input.from) { lagged = remotePair; remotePair = { ...remotePair, head: input.to }; }
      if (options.pushedFirst) {
        lagged = remotePair; lagging = options.pushVisibleAfter ?? 0;
        remotePair = { ...remotePair, head: options.pushedFirst(service) };
      }
      if (options.pushFailure) throw options.pushFailure(service, input);
      if (remotePair.head !== input.from) throw new BranchPushRefused('moved');
      lagged = remotePair; lagging = options.pushVisibleAfter ?? 0;
      remotePair = { ...remotePair, head: input.to };
      if (options.movedBaseAfterPush) {
        const base = options.movedBaseAfterPush(service);
        lagged = { ...lagged, base }; remotePair = { ...remotePair, base };
      }
      if (options.afterPush) remotePair = { ...remotePair, head: options.afterPush(service, input.to) };
      if (options.readBackFails && remotePair.head !== input.to)
        throw new Error(`After the push, the branch ${input.branch} is at ${remotePair.head}, not ${input.to}.`);
    },
    // A real branch read is aborted by its signal; so is this one, so a cancel that stopped settlement would show.
    readBranch: async (_branch, signal) => {
      branchReads++;
      signal?.throwIfAborted();
      if (options.branchReadHangs) return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return options.branchRead ? options.branchRead(remotePair.head, signal) : remotePair.head;
    },
  }, options.operationTimeoutMs, undefined, authorize, options.reserves);
  if (options.closeAfterCommandAdmission) {
    const start = runner.start.bind(runner);
    runner.start = ((...args: Parameters<RunnerCoordinator['start']>) => {
      const attempt = start(...args);
      void coordinator.close();
      return attempt;
    }) as RunnerCoordinator['start'];
  }
  const task = service.store.getTask(identity);
  const actionRequest = { attemptId: undefined, expectedStateVersion: task.stateVersion, expectedReviewVersion: view.expected.reviewVersion };
  if (options.actionId) service.store.userAction(identity, { actionId: options.actionId, kind: 'prepare-merge', request: actionRequest }, () => ({ outcome: 'preparing' }));
  const result = options.deferStart ? null as unknown as PreMergeResult : await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head,
    ...(options.actionId ? { actionId: options.actionId } : {}) });
  return { service, coordinator, runner, result, rebased, checkedHeads, cancelReasons, actionRequest, pushes, remote: () => remotePair,
    branchReads: () => branchReads, fetchesAfterPush: () => fetchesAfterPush,
    /** The branch moves (as GitHub's Git data shows it); the PR API reports `shown` for the next `reads` inspections. */
    moveRemote: (pair: { base: string; head: string }, shown?: { base: string; head: string }, reads = 0) => {
      remotePair = { ...remotePair, ...pair };
      if (shown) { lagged = { ...remotePair, ...shown }; lagging = reads; } else lagging = 0;
    },
    rebaseRuns: () => rebaseRuns, rebaseAborts: () => rebaseAborts, rebaseBudgets, abortBudgets };
}

it('preserves an approval when a moved base leaves its attributed fingerprint unchanged', async () => {
  const { service, coordinator, runner, result, rebased } = await rebaseFixture('feature\n');
  expect(result).toMatchObject({ state: 'ready', head: rebased, checked: [], reason: null });
  expect((await service.load()).items.find(item => item.id === 'P1')?.state).toBe('approved');
  await coordinator.close(); await runner.close();
});
it('prepares a published original head when every runner item was unchanged', async () => {
  const { coordinator, runner, result, rebased } = await rebaseFixture('feature\n', undefined, { runnerCommitted: false });
  expect(result).toMatchObject({ state: 'ready', head: rebased, checked: [], reason: null });
  await coordinator.close(); await runner.close();
});

it('returns to review when a moved-base rewrite changes an approved fingerprint', async () => {
  const { service, coordinator, runner, result, rebased } = await rebaseFixture('changed by rebase\n');
  expect(result).toMatchObject({ state: 'review-required', head: rebased, checked: [] });
  expect(result.reason).toMatch(/requires refreshed attribution or approval/);
  expect((await service.load()).items.find(item => item.id === 'P1')?.state).toBe('stale');
  await coordinator.close(); await runner.close();
});

it('marks a failed preparation stale when its final remote inspection was invalidated by a review edit', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringFinalInspect(service) {
    const current = { expected: reviewState(service) };
    service.store.addReviewNote(service.config.identity, current.expected, 'P1', 'change', 'Changed during inspection.');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed during preparation/i) });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('leaves an unsettled conflict and its rebase marker for startup recovery', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { unsettledRebase: true });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Conflict resources remain owned.' });
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  expect(fixture.rebaseAborts()).toBe(0);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).not.toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps a failed live cleanup current while its rebase marker awaits recovery', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, {
    rebaseFailure: new Error('rebase failed'), rebaseCleanupFailure: new Error('cleanup failed'),
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'rebase failed' });
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  expect(fixture.rebaseAborts()).toBe(1);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).not.toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps a failed rebase bound to the review that started it when that review changes in flight', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, {
    duringRebase(service) {
      const current = { expected: reviewState(service) };
      service.store.addReviewNote(service.config.identity, current.expected, 'P1', 'change', 'Changed during rebase.');
    },
    rebaseFailure: new Error('rebase failed'), rebaseCleanupFailure: new Error('cleanup failed'),
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'rebase failed' });
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it.each([
  ['timed out', () => new RemoteTimeout('Issue retrieval timed out.')],
  ['was answered by gh', () => new CommandFailed('gh failed (exit 1): HTTP 404: Not Found', 'HTTP 404: Not Found', '')],
] as const)('saves a preparation whose issue-trust read %s before shutdown with that answer, not the shutdown (#48)', async (_case, answer) => {
  const actionId = randomUUID();
  let stoppedFirst = false;
  const cause = answer(), expected = `Issue trust could not be verified: ${cause.message}`;
  const fixture = await rebaseFixture('feature\n', undefined, { actionId, authorize: async (signal, { coordinator }) => {
    // The read answered (or ran out of time) before shutdown, and surfaces while shutdown stops the preparation. This is
    // the error the server's readIssueAccess builds then: its own answer, wrapped, with the answer as the cause.
    void coordinator.close();
    stoppedFirst = signal.aborted;
    throw new UpstreamFailure(expected, { cause });
  } });
  expect(stoppedFirst).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expected });
  expect(fixture.service.store.savedAction(fixture.service.config.identity, { actionId, kind: 'prepare-merge', request: fixture.actionRequest })?.response)
    .toMatchObject({ outcome: 'failed', reason: expected });
  expect(fixture.rebaseRuns()).toBe(0);
  await fixture.runner.close();
});

it('revalidates authorization before starting the delayed local rebase', async () => {
  const calls: string[] = [];
  const fixture = await rebaseFixture('feature\n', undefined, { authorize: async () => {
    calls.push('read'); return { refresh: async () => undefined,
      validate: () => { calls.push('validate'); throw new Error('Issue trust was revoked.'); } };
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Issue trust was revoked.' });
  expect(calls).toEqual(['read', 'validate']);
  expect(fixture.rebaseRuns()).toBe(0);
  // Refused authorization precedes the first durable rebase claim, so there is no cleanup lifecycle to start.
  expect(fixture.rebaseAborts()).toBe(0);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).toBeNull();
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses readiness when local issue trust is revoked during the final remote inspection', async () => {
  let trusted = true;
  const fixture = await rebaseFixture('feature\n', undefined, {
    authorize: async () => ({ refresh: async () => undefined,
      validate: () => { if (!trusted) throw new Error('Issue trust was revoked.'); } }),
    duringFinalInspect: (_service, _coordinator, read) => { if (read === 3) trusted = false; },
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Issue trust was revoked.' });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses a review edit made during the review reload after the push, which awaits a history worker (#170)', async () => {
  let refreshes = 0, edited = false;
  // A passing command check, so a missing guard would run it under the stale approvals.
  const fixture = await rebaseFixture('feature\n', 0, {
    authorize: async () => ({ refresh: async () => { refreshes++; }, validate: () => undefined }),
    // The rebase authorizes first and the push second; the next review load is the reload after the push.
    duringLoad: service => {
      if (refreshes !== 2 || edited) return;
      edited = true;
      service.store.addReviewNote(service.config.identity, reviewState(service), 'P1', 'change', 'Changed during the reload after the push.');
    },
  });
  expect(edited).toBe(true);
  expect(fixture.pushes).toHaveLength(1);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The task or review changed during preparation. Reload first.' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  expect(fixture.checkedHeads).toEqual([]); // No command check ran under the stale approvals.
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses readiness when the task is reassigned during the review reload after a command check (#170)', async () => {
  // A passing command check; the reload that follows it is the first load after the check settled.
  let settledChecks = 0, changed = false;
  const fixture = await rebaseFixture('feature\n', 0, { duringLoad(service) {
    const identity = service.config.identity;
    settledChecks = service.store.getAttempts(identity).filter(attempt => attempt.kind === 'check' && attempt.state === 'completed').length;
    if (settledChecks !== 1 || changed) return;
    changed = true;
    service.store.setAssignment(identity, service.store.getTask(identity).stateVersion, 'someone-else', 'c'.repeat(40));
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The task or review changed during preparation. Reload first.' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reports a failure of the review reload after the rebase itself as current, not stale', async () => {
  let firstHead: string | undefined, failed = false;
  const fixture = await rebaseFixture('feature\n', undefined, { duringLoad(service) {
    const head = service.store.getSnapshot(service.config.identity).head;
    firstHead ??= head;
    if (head === firstHead || failed) return;
    failed = true;
    throw new Error('History worker timed out.'); // The reload fails on its own; nothing else changed.
  } });
  expect(failed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'History worker timed out.' });
  expect(fixture.coordinator.last?.stale).toBe(false);
  expect(fixture.pushes).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reports a command check stopped by a reassignment as stale, not as a current failure', async () => {
  let changed = false;
  const fixture = await rebaseFixture('feature\n', 0, { duringCommand(service) {
    if (changed) return;
    changed = true;
    const identity = service.config.identity;
    service.store.setAssignment(identity, service.store.getTask(identity).stateVersion, 'someone-else', 'c'.repeat(40));
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses, as stale, a reassignment after a command check\'s terminal write, while its workspace is released', async () => {
  let changed = false;
  const fixture = await rebaseFixture('feature\n', 0, { duringRelease(service) {
    if (changed) return;
    changed = true;
    const identity = service.config.identity;
    // The check has already settled as completed; only the task's context changes now.
    expect(service.store.getAttempts(identity).some(attempt => attempt.kind === 'check' && attempt.state === 'completed')).toBe(true);
    service.store.setAssignment(identity, service.store.getTask(identity).stateVersion, 'someone-else', 'c'.repeat(40));
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The task or review changed during preparation. Reload first.' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses, as stale, a change request added while a command check runs, instead of adopting it', async () => {
  let changed = false;
  const fixture = await rebaseFixture('feature\n', 0, { duringCommand(service) {
    if (changed) return;
    changed = true;
    service.store.addReviewNote(service.config.identity, reviewState(service), 'P1', 'change', 'Requested during the check.');
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The task or review changed during preparation. Reload first.' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses readiness when local issue trust is revoked during the final review load', async () => {
  let trusted = true, refreshes = 0, inspected = 0;
  const fixture = await rebaseFixture('feature\n', undefined, {
    authorize: async () => ({ refresh: async () => { refreshes++; },
      validate: () => { if (!trusted) throw new Error('Issue trust was revoked.'); } }),
    duringFinalInspect: (_service, _coordinator, read) => { inspected = read; },
    // The rebase authorizes first and the push (F6a) second; the review load after the third (final) authorization read
    // is the final one.
    duringLoad: () => { if (refreshes === 3) trusted = false; },
  });
  // Refused by the check after the final remote inspection, not earlier.
  expect(inspected).toBe(3);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Issue trust was revoked.' });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('inspects the pull request after its last review load, so no worker await follows the final remote read', async () => {
  const events: string[] = [];
  const fixture = await rebaseFixture('feature\n', undefined, {
    duringLoad: () => { events.push('load'); },
    duringFinalInspect: () => { events.push('inspect'); },
  });
  expect(fixture.result).toMatchObject({ state: 'ready' });
  expect(events.lastIndexOf('inspect')).toBeGreaterThan(events.lastIndexOf('load'));
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses readiness when the task changes during the final review load', async () => {
  let refreshes = 0, inspected = 0, cancelled = false;
  const fixture = await rebaseFixture('feature\n', undefined, {
    authorize: async () => ({ refresh: async () => { refreshes++; }, validate: () => undefined }),
    duringFinalInspect: (_service, _coordinator, read) => { inspected = read; },
    // The rebase authorizes first and the push (F6a) second; the review load after the third (final) authorization read
    // is the final one.
    duringLoad: service => {
      if (refreshes !== 3 || cancelled) return;
      cancelled = true;
      const identity = service.config.identity;
      service.store.cancelTask(identity, service.store.getTask(identity).stateVersion, randomUUID());
    },
  });
  expect(cancelled).toBe(true);
  // Refused by the guard on the final review load itself, before the final remote inspection, and reported as stale.
  expect(inspected).toBe(2);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/task or review changed during preparation/i) });
  expect(fixture.coordinator.last?.stale).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses to rebase when the task changes while the old history is read', async () => {
  let changed = false;
  historyReads.during = () => {
    if (changed) return;
    changed = true;
    // Still mergeable and the same review: only the task's state version moves.
    const service = fixtureService!, identity = service.config.identity;
    service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'in review');
  };
  let fixtureService: ReviewService | undefined;
  const fixture = await rebaseFixture('feature\n', undefined, { duringLoad: service => { fixtureService = service; } });
  expect(changed).toBe(true);
  expect(fixture.rebaseRuns()).toBe(0);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/task or review changed during preparation/i) });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses to record a moved pull request head when the task changes while its history is read', async () => {
  let moved = false, changed = false, reviewing: ReviewService | undefined;
  historyReads.during = () => {
    if (!moved || changed) return;
    changed = true;
    // Still mergeable and the same review: only the task's state version moves.
    const identity = reviewing!.config.identity;
    reviewing!.store.transitionTask(identity, reviewing!.store.getTask(identity).stateVersion, 'in review');
  };
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    reviewing = service;
    if (call !== 2) return;
    moved = true;
    writeFileSync(join(service.config.repository, 'late.txt'), 'late collaborator push\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'late push');
    return { base: service.store.getSnapshot(service.config.identity).base, head: fixtureGit(service.config.repository, 'rev-parse', 'HEAD') };
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/task or review changed during preparation/i) });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not report readiness while a current change request remains open', async () => {
  const fixture = await rebaseFixture('feature\n');
  const current = await fixture.service.load();
  fixture.service.store.addReviewNote(fixture.service.config.identity, current.expected, 'P1', 'change', 'Please revise this.');
  const changed = await fixture.service.load(), task = fixture.service.store.getTask(fixture.service.config.identity);
  const result = await fixture.coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: changed.expected.reviewVersion!, snapshotId: changed.snapshot.id, base: changed.snapshot.base, head: changed.snapshot.head });
  expect(result).toMatchObject({ state: 'review-required', checked: [] });
  expect(result.reason).toMatch(/1 change request remains open/);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('preserves an unpushed rebased head across review and preparation retries', async () => {
  const first = await rebaseFixture('changed by rebase\n');
  let view = await first.service.load();
  view = await first.service.act({ action: 'approve', item: 'P1', token: view.token });
  const task = first.service.store.getTask(first.service.config.identity);
  const result = await first.coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result).toMatchObject({ state: 'ready', head: first.rebased, reason: null });
  expect(first.rebaseRuns()).toBe(1);
  await first.coordinator.close(); await first.runner.close();
});

it('blocks when a command check fails on the rewritten head', async () => {
  const { coordinator, runner, result, rebased, checkedHeads } = await rebaseFixture('feature\n', 1);
  expect(result).toMatchObject({ state: 'failed', head: rebased, checked: [] });
  expect(result.reason).toMatch(/command checks did not pass/);
  expect(checkedHeads).toEqual([rebased]);
  await coordinator.close(); await runner.close();
});

it('preserves completed command-check IDs when a later preparation step fails', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { duringFinalInspect() {
    throw new Error('final remote inspection failed');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', checked: ['P1'], reason: 'final remote inspection failed' });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not report readiness when command-check cleanup is unresolved', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { releaseFails: true });
  expect(fixture.result).toMatchObject({ state: 'failed', checked: [] });
  expect(fixture.result.reason).toMatch(/cleanup could not be confirmed/);
  expect(fixture.runner.status(fixture.service.config.identity).unresolved).not.toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('revalidates task and review versions after the final remote read', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, {
    duringFinalInspect(service) {
      const view = { expected: reviewState(service) };
      service.store.addReviewNote(service.config.identity, view.expected, 'P1', 'change', 'Changed while preparing.');
    },
  });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/task or review changed/);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('revalidates task and review versions after final authorization', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 4) return; // validations: 1 rebase, 2 push read, 3 push boundary, 4 final
    const view = { expected: reviewState(service) };
    service.store.addReviewNote(service.config.identity, view.expected, 'P1', 'change', 'Changed during authorization.');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/task or review changed/);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refreshes a pull request head that moves during final authorization', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 4) return; // validations: 1 rebase, 2 push read, 3 push boundary, 4 final
    writeFileSync(join(service.config.repository, 'late.txt'), 'late collaborator push\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'late push');
    return { base: service.store.getSnapshot(service.config.identity).base, head: fixtureGit(service.config.repository, 'rev-parse', 'HEAD') };
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required' });
  expect(fixture.result.reason).toMatch(/moved during final authorization/);
  expect((await fixture.service.load()).snapshot.head).toBe(fixture.result.head);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('marks historical readiness stale after the review changes', async () => {
  const fixture = await rebaseFixture('feature\n');
  expect(fixture.coordinator.last).toMatchObject({ state: 'ready', stale: false });
  const view = await fixture.service.load();
  fixture.service.store.addReviewNote(fixture.service.config.identity, view.expected, 'P1', 'change', 'Review changed later.');
  expect(fixture.coordinator.last).toMatchObject({ state: 'ready', stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it.each([
  ['review-required', 'changed by rebase\n', undefined],
  ['failed', 'feature\n', 1],
] as const)('marks a historical %s preparation stale after the review changes', async (state, text, exitCode) => {
  const fixture = await rebaseFixture(text, exitCode);
  expect(fixture.result.state).toBe(state);
  expect(fixture.coordinator.last).toMatchObject({ state, stale: false });
  const view = await fixture.service.load();
  fixture.service.store.addReviewNote(fixture.service.config.identity, view.expected, 'P1', 'change', 'Review changed later.');
  expect(fixture.coordinator.last).toMatchObject({ state, stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps a command-check deadline separate from the code-writing task budget', async () => {
  const fixture = await rebaseFixture('feature\n', 0,
    { commandWaitsForDeadline: true, operationTimeoutMs: COMMAND_CHECK_SETTLEMENT_RESERVE_MS + 5_000 });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/Timed out|deadline exceeded/);
  const check = fixture.service.store.getAttempts(fixture.service.config.identity).find(attempt => attempt.kind === 'check');
  expect(check).toMatchObject({ state: 'failed', firstReason: null, stopReason: 'timeout' });
  expect(fixture.service.store.getTask(fixture.service.config.identity).status).toBe('in review');
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps the complete command settlement window inside the overall preparation deadline', async () => {
  const fixture = await rebaseFixture('feature\n', 0,
    { operationTimeoutMs: COMMAND_CHECK_SETTLEMENT_RESERVE_MS + 5_000 });
  const attempt = fixture.service.store.getAttempts(fixture.service.config.identity).find(value => value.kind === 'check');
  expect(attempt).toBeDefined();
  expect(attempt!.deadline - Date.parse(attempt!.createdAt)).toBeLessThanOrEqual(5_000);
  expect(fixture.result).toMatchObject({ state: 'ready' });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('aborts an owned rebase promptly when the task is cancelled', async () => {
  const actionId = randomUUID();
  const fixture = await rebaseFixture('feature\n', undefined, {
    duringRebase(service, coordinator) {
      const task = service.store.getTask(service.config.identity);
      expect(coordinator.cancelTask(task.stateVersion, actionId)).toBe('stopping');
    },
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Task cancelled.' });
  expect(fixture.service.store.getTask(fixture.service.config.identity).status).toBe('cancelled');
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('preserves shutdown as the reason that stops an active command check', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { closeDuringCommand: true });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Server shutdown.' });
  expect(fixture.cancelReasons).toEqual(['shutdown']);
  const check = fixture.service.store.getAttempts(fixture.service.config.identity).find(attempt => attempt.kind === 'check');
  expect(check).toMatchObject({ state: 'cancelled', firstReason: 'shutdown' });
  await fixture.runner.close();
});

it('stops a command check when shutdown races between admission and abort-listener registration', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { closeAfterCommandAdmission: true });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Server shutdown.' });
  const check = fixture.service.store.getAttempts(fixture.service.config.identity).find(attempt => attempt.kind === 'check');
  expect(check).toMatchObject({ state: 'cancelled', firstReason: 'shutdown' });
  await fixture.runner.close();
});

it('stops an active command check when the operation-wide deadline expires', async () => {
  const fixture = await rebaseFixture('feature\n', 0,
    { commandWaitsForCancellation: true,
      operationTimeoutMs: MIN_REBASE_TIMEOUT_MS + MIN_REBASE_CLEANUP_TIMEOUT_MS + PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 3_000,
      reserves: { processMs: MIN_REBASE_TIMEOUT_MS + MIN_REBASE_CLEANUP_TIMEOUT_MS
        + PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 1_000, commandMs: 200 } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Pre-merge preparation deadline exceeded.' });
  const check = fixture.service.store.getAttempts(fixture.service.config.identity).find(attempt => attempt.kind === 'check');
  expect(check).toMatchObject({ state: 'failed', firstReason: null, stopReason: 'timeout', diagnostic: 'Timed out.' });
  expect(fixture.cancelReasons).toEqual(['timeout']);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refuses to record a head moved before preparation when the task changes while its history is read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load();
  const work = join(root, 'collaborator');
  fixtureGit(config.repository, 'branch', 'collaborator-push', view.snapshot.head);
  fixtureGit(config.repository, 'worktree', 'add', '-q', work, 'collaborator-push');
  writeFileSync(join(work, 'README.md'), 'A collaborator changed this before preparation.\n');
  fixtureGit(work, 'add', 'README.md'); fixtureGit(work, 'commit', '-qm', 'collaborator push');
  const moved = { base: view.snapshot.base, head: fixtureGit(work, 'rev-parse', 'HEAD') };
  let changed = false;
  historyReads.during = () => {
    if (changed) return;
    changed = true;
    // Still mergeable and the same review: only the task's state version moves.
    service.store.transitionTask(config.identity, service.store.getTask(config.identity).stateVersion, 'in review');
  };
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => moved, fetch: async () => undefined,
      push: async () => { throw new Error('No push expected.'); }, readBranch: async () => { throw new Error('No branch read expected.'); } });
  const task = service.store.getTask(config.identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(changed).toBe(true);
  expect(result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/task or review changed during preparation/i) });
  expect(service.store.getSnapshot(config.identity).head).toBe(view.snapshot.head);
  await coordinator.close();
});

it('refreshes the moved head against its prior base when the PR base and head advance together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load();
  const initial = { base: view.snapshot.base, head: view.snapshot.head };
  const branch = 'collaborator-refresh', work = join(root, 'collaborator');
  fixtureGit(config.repository, 'branch', branch, initial.head);
  fixtureGit(config.repository, 'worktree', 'add', '-q', work, branch);
  writeFileSync(join(work, 'README.md'), 'A collaborator changed this after checks started.\n');
  fixtureGit(work, 'add', 'README.md'); fixtureGit(work, 'commit', '-qm', 'collaborator push');
  const baseWork = join(root, 'advanced-base');
  fixtureGit(config.repository, 'branch', 'advanced-base', initial.base);
  fixtureGit(config.repository, 'worktree', 'add', '-q', baseWork, 'advanced-base');
  writeFileSync(join(baseWork, 'base-moved.txt'), 'new base\n'); fixtureGit(baseWork, 'add', '.');
  fixtureGit(baseWork, 'commit', '-qm', 'advance base');
  const moved = { base: fixtureGit(baseWork, 'rev-parse', 'HEAD'), head: fixtureGit(work, 'rev-parse', 'HEAD') };
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => moved, fetch: async () => undefined, ...unusedPush });
  const task = service.store.getTask(config.identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result.reason).toMatch(/head moved/);
  expect(result).toMatchObject({ state: 'review-required', base: initial.base, head: moved.head, checked: [] });
  const refreshed = await service.load();
  expect(refreshed.snapshot).toMatchObject({ base: initial.base, head: moved.head });
  expect(refreshed.segments.some(segment => segment.row === 'Unplanned')).toBe(true);
  expect(refreshed.items.some(item => item.state !== 'approved')).toBe(true);
  await coordinator.close();
});

it('traces an unpushed rewrite back to the base of a collaborator head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-lineage-')); roots.push(root);
  const repository = join(root, 'repo'); fixtureGit(root, 'init', '-q', '-b', 'main', repository);
  fixtureGit(repository, 'config', 'user.name', 'Test'); fixtureGit(repository, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repository, 'a.txt'), 'base\n'); fixtureGit(repository, 'add', '.'); fixtureGit(repository, 'commit', '-qm', 'base');
  const oldBase = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-qc', 'feature');
  writeFileSync(join(repository, 'a.txt'), 'feature\n'); fixtureGit(repository, 'commit', '-am', 'feature', '-q');
  const oldHead = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-q', 'main');
  writeFileSync(join(repository, 'base.txt'), 'advanced\n'); fixtureGit(repository, 'add', '.'); fixtureGit(repository, 'commit', '-qm', 'advance base');
  const newBase = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-qc', 'local-rewrite');
  writeFileSync(join(repository, 'a.txt'), 'feature\n'); fixtureGit(repository, 'commit', '-am', 'rebased feature', '-q');
  const rewrittenHead = fixtureGit(repository, 'rev-parse', 'HEAD');
  const collaborator = join(root, 'collaborator'); fixtureGit(repository, 'branch', 'collaborator-lineage', oldHead);
  fixtureGit(repository, 'worktree', 'add', '-q', collaborator, 'collaborator-lineage');
  writeFileSync(join(collaborator, 'late.txt'), 'late\n'); fixtureGit(collaborator, 'add', '.'); fixtureGit(collaborator, 'commit', '-qm', 'late push');
  const collaboratorHead = fixtureGit(collaborator, 'rev-parse', 'HEAD');

  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const config = { database: join(root, 'review.sqlite'), repository, runnerRepository: repository, identity,
    pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' as const } };
  const service = new ReviewService(config); services.push(service);
  const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'One change', questions: [], items: [{ id: 'P1',
    title: 'Change a', intent: 'Change a', files: [{ path: 'a.txt', kind: 'edit', renamed_from: null, change: 'Change it' }],
    acceptance: [{ type: 'check', text: 'a changed' }], depends_on: [] }] };
  const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.txt', kind: 'file' }], pathKey: path => path, allowedCommands: [] };
  service.store.createPlan(JSON.stringify(plan), 'json', context, oldBase, oldHead);
  let view = await service.load();
  service.store.recordHistory(identity, view.expected, oldBase, oldHead,
    [{ sha: oldHead, owner: 'P1', origin: 'owned', sourceSha: null }]);
  markRunnerOwned(service); view = await service.load();
  service.store.recordRebase(identity, view.expected, newBase, rewrittenHead,
    [{ oldSha: oldHead, newSha: rewrittenHead }]);
  view = await service.load(); view = await service.act({ action: 'approve', item: 'P1', token: view.token });
  let reads = 0;
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => ++reads === 1 ? { base: newBase, head: rewrittenHead } : { base: newBase, head: collaboratorHead },
      fetch: async () => undefined, ...unusedPush });
  const task = service.store.getTask(identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result).toMatchObject({ state: 'review-required', base: oldBase, head: collaboratorHead });
  expect(result.reason).toMatch(/moved during preparation/);
  expect((await service.load()).snapshot).toMatchObject({ base: oldBase, head: collaboratorHead });
  await coordinator.close();
});

it('refuses preparation before review or remote work while runner cleanup is unresolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-unresolved-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity);
  for (const kind of ['marker', 'resources'] as const) {
    let inspected = false;
    const load = vi.spyOn(service, 'load');
    const coordinator = new PreMergeCoordinator(service,
      { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
        stop: () => false, isActive: () => false,
        status: () => ({ active: false, stopRequested: null,
          unresolved: kind === 'marker' ? { attemptId: randomUUID(), reason: 'storage-not-removed' } : null }),
        get unreleased() { return kind === 'resources' ? [{ kind: 'container', name: 'agent-x' }] : null; } } as never,
      { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
      { inspect: async () => { inspected = true; return { base: view.snapshot.base, head: view.snapshot.head }; },
        fetch: async () => undefined, ...unusedPush });
    const result = await coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
      snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
    expect(result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/restart|cleanup/i) });
    expect(inspected).toBe(false);
    expect(load).not.toHaveBeenCalled();
    load.mockRestore(); await coordinator.close();
  }
});

it('refuses preparation before review or remote work while a durable rebase marker awaits recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-rebase-marker-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load();
  service.store.beginRebase(config.identity, { revision: view.expected.revision, snapshotId: view.expected.snapshotId,
    reviewVersion: view.expected.reviewVersion! },
    service.store.getTask(config.identity).stateVersion,
    { oldBase: view.snapshot.base, oldHead: view.snapshot.head, oldHistory: [view.snapshot.head], onto: view.snapshot.base });
  const task = service.store.getTask(config.identity);
  let inspected = false;
  const load = vi.spyOn(service, 'load');
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => { inspected = true; return { base: view.snapshot.base, head: view.snapshot.head }; },
      fetch: async () => undefined, ...unusedPush });
  const result = await coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/rebase|recovery|cleanup/i) });
  expect(inspected).toBe(false);
  expect(load).not.toHaveBeenCalled();
  await coordinator.close();
});

it('preserves an already-requested shutdown without loading the review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-pre-aborted-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity);
  const load = vi.spyOn(service, 'load');
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => { throw new Error('No remote inspection expected.'); }, fetch: async () => undefined, ...unusedPush });
  const active = coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  await coordinator.close();
  await expect(active).resolves.toMatchObject({ state: 'failed', reason: 'Server shutdown.' });
  expect(load).not.toHaveBeenCalled();
});

it('settles an admitted action after shutdown aborts its remote refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-shutdown-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
  const request = { attemptId: undefined, expectedStateVersion: task.stateVersion, expectedReviewVersion: view.expected.reviewVersion };
  service.store.userAction(config.identity, { actionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  const capability = service.store.shutdownCapability();
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      fetch: async () => undefined, ...unusedPush }, 60_000, capability);
  const active = coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head, actionId });
  await Promise.resolve();
  service.store.closeWrites(); await coordinator.close();
  await expect(active).resolves.toMatchObject({ state: 'failed', reason: 'Server shutdown.' });
  expect(service.store.savedAction(config.identity, { actionId, kind: 'prepare-merge', request })?.response)
    .toMatchObject({ outcome: 'failed', reason: 'Server shutdown.' });
});

it('applies one operation-wide deadline to remote work and later checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-deadline-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity);
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      fetch: async () => undefined, ...unusedPush }, 20);
  await expect(coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head })).resolves.toMatchObject({ state: 'failed' });
  await coordinator.close();
});

it('aborts remote work early enough to reserve bounded subprocess settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-remote-settlement-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity);
  let abortedAt = -1;
  const processReserve = 1_000, operationTimeout = 2_000;
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
      abortedAt = performance.now();
      setTimeout(() => reject(signal.reason), processReserve);
    }, { once: true })), fetch: async () => undefined, ...unusedPush }, operationTimeout, undefined, undefined,
    { processMs: processReserve });
  const startedAt = performance.now();
  const result = await coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result).toMatchObject({ state: 'failed', reason: 'Pre-merge preparation deadline exceeded.' });
  expect(abortedAt - startedAt).toBeLessThanOrEqual(operationTimeout - processReserve + 500);
  expect(performance.now() - startedAt).toBeLessThanOrEqual(operationTimeout + 500);
  await coordinator.close();
});

it('budgets live rebase work and its follow-up cleanup inside the preparation deadline', async () => {
  const operationTimeoutMs = MIN_REBASE_TIMEOUT_MS + MIN_REBASE_CLEANUP_TIMEOUT_MS
    + PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 10_000;
  const fixture = await rebaseFixture('feature\n', undefined,
    { operationTimeoutMs, rebaseFailure: new Error('rebase failed') });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'rebase failed' });
  expect(fixture.rebaseBudgets).toHaveLength(1);
  expect(fixture.abortBudgets).toHaveLength(1);
  expect(fixture.rebaseBudgets[0]).toBeLessThanOrEqual(operationTimeoutMs - MIN_REBASE_CLEANUP_TIMEOUT_MS
    - PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS);
  for (const budget of [...fixture.rebaseBudgets, ...fixture.abortBudgets]) {
    expect(budget).toBeTypeOf('number');
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(operationTimeoutMs);
  }
});

it('leaves handoff slack before starting follow-up rebase cleanup', async () => {
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const operationTimeoutMs = MIN_REBASE_TIMEOUT_MS + MIN_REBASE_CLEANUP_TIMEOUT_MS
    + PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 10_000;
  const fixture = await rebaseFixture('feature\n', undefined, {
    operationTimeoutMs, rebaseFailure: new Error('rebase failed'),
    duringRebase: (_service, _coordinator, timeoutMs) => { elapsed += timeoutMs! + 1; },
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'rebase failed' });
  expect(fixture.rebaseAborts()).toBe(1);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('makes a preparation action resendable when its terminal storage write fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-settlement-failure-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
  const request = { attemptId: undefined, expectedStateVersion: task.stateVersion, expectedReviewVersion: view.expected.reviewVersion };
  const readiness = { stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head,
    commandPolicyDigest: service.commandPolicyDigest() };
  const priorActionId = randomUUID();
  service.store.userAction(config.identity, { actionId: priorActionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  service.store.settlePreMergeAction(config.identity, priorActionId,
    { state: 'ready', base: view.snapshot.base, head: view.snapshot.head, checked: [], reason: null }, readiness);
  expect(service.store.preMergeReady(config.identity, readiness)).toBe(true);
  service.store.userAction(config.identity, { actionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  const original = service.store.settlePreMergeAction.bind(service.store);
  vi.spyOn(service.store, 'settlePreMergeAction').mockImplementationOnce(() => {
    throw Object.assign(new Error('transient storage failure'), { code: 'ERR_SQLITE_ERROR' });
  }).mockImplementation(original);
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => ({ base: view.snapshot.base, head: view.snapshot.head }), fetch: async () => undefined, ...unusedPush });
  const result = await coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head, actionId });
  expect(result).toMatchObject({ state: 'failed', reason: 'transient storage failure' });
  expect(service.store.preMergeReady(config.identity, readiness)).toBe(false);
  expect(service.store.savedAction(config.identity, { actionId, kind: 'prepare-merge', request })).toBeUndefined();
  const replay = service.store.userAction(config.identity, { actionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  expect(replay).toMatchObject({ replayed: false, response: { outcome: 'preparing' } });
  await coordinator.close();
});

it('settles a failed preparation even when the fallback snapshot read would fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-fallback-read-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = await service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
  const request = { attemptId: undefined, expectedStateVersion: task.stateVersion, expectedReviewVersion: view.expected.reviewVersion };
  service.store.userAction(config.identity, { actionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  const original = service.store.getSnapshot.bind(service.store); let reads = 0;
  vi.spyOn(service.store, 'getSnapshot').mockImplementation((...args) => {
    if (++reads >= 2) throw Object.assign(new Error('transient snapshot read failure'), { code: 'ERR_SQLITE_ERROR' });
    return original(...args);
  });
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => { throw new Error('remote inspection failed'); }, fetch: async () => undefined, ...unusedPush });
  await expect(coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head, actionId }))
    .resolves.toMatchObject({ state: 'failed', reason: 'transient snapshot read failure' });
  expect(service.store.savedAction(config.identity, { actionId, kind: 'prepare-merge', request })?.response)
    .toMatchObject({ outcome: 'failed', reason: 'transient snapshot read failure' });
  await coordinator.close();
});

it('threads the remaining operation budget through every synchronous review reload', async () => {
  const operationTimeoutMs = MIN_REBASE_TIMEOUT_MS + MIN_REBASE_CLEANUP_TIMEOUT_MS
    + PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 10_000, processMs = 10_000;
  const fixture = await rebaseFixture('feature\n', undefined, { operationTimeoutMs, reserves: { processMs, commandMs: 0 } });
  const view = await fixture.service.load(), task = fixture.service.store.getTask(fixture.service.config.identity);
  const original = fixture.service.load.bind(fixture.service); const budgets: number[] = [];
  vi.spyOn(fixture.service, 'load').mockImplementation(options => {
    budgets.push(options?.maxDurationMs ?? -1); return original(options);
  });
  const result = await fixture.coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result.state).toBe('ready');
  expect(budgets.length).toBeGreaterThan(1);
  expect(budgets.every(value => value > 0 && value <= operationTimeoutMs - processMs)).toBe(true);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('rechecks the remote after local preparation and refreshes a head that moved in flight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-race-')); roots.push(root);
  const repository = join(root, 'repo'); fixtureGit(root, 'init', '-q', repository);
  fixtureGit(repository, 'config', 'user.name', 'Test'); fixtureGit(repository, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repository, 'a.txt'), 'base\n'); fixtureGit(repository, 'add', '.'); fixtureGit(repository, 'commit', '-qm', 'base');
  const base = fixtureGit(repository, 'rev-parse', 'HEAD');
  writeFileSync(join(repository, 'a.txt'), 'feature\n'); fixtureGit(repository, 'commit', '-am', 'feature', '-q');
  const head = fixtureGit(repository, 'rev-parse', 'HEAD');
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const config = { database: join(root, 'review.sqlite'), repository, runnerRepository: repository, identity,
    pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' as const } };
  const service = new ReviewService(config); services.push(service);
  const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'One change', questions: [], items: [{ id: 'P1',
    title: 'Change a', intent: 'Change a', files: [{ path: 'a.txt', kind: 'edit', renamed_from: null, change: 'Change it' }],
    acceptance: [{ type: 'check', text: 'a changed' }], depends_on: [] }] };
  const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.txt', kind: 'file' }], pathKey: path => path, allowedCommands: [] };
  service.store.createPlan(JSON.stringify(plan), 'json', context, base, head);
  let view = await service.load();
  service.store.recordHistory(identity, view.expected, base, head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  markRunnerOwned(service); view = await service.load();
  view = await service.act({ action: 'approve', item: 'P1', token: view.token });
  const work = join(root, 'collaborator'); fixtureGit(repository, 'branch', 'collaborator-race', head);
  fixtureGit(repository, 'worktree', 'add', '-q', work, 'collaborator-race');
  writeFileSync(join(work, 'a.txt'), 'collaborator\n'); fixtureGit(work, 'commit', '-am', 'collaborator', '-q');
  const moved = { base, head: fixtureGit(work, 'rev-parse', 'HEAD') };
  let reads = 0;
  const coordinator = new PreMergeCoordinator(service,
    { start() { throw new Error('No command checks expected.'); }, settled: async () => undefined,
      stop: () => false, isActive: () => false, status: () => ({ active: false, stopRequested: null, unresolved: null }),
      get unreleased() { return null; } } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => ++reads === 1 ? { base, head } : moved, fetch: async () => undefined, ...unusedPush });
  const task = service.store.getTask(identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  expect(result).toMatchObject({ state: 'review-required', base, head: moved.head, checked: [] });
  expect(result.reason).toMatch(/moved during preparation/);
  expect((await service.load()).segments.some(segment => segment.row === 'Unplanned')).toBe(true);
  await coordinator.close();
});

// F6a of #22: the reviewed, rewritten head is pushed over exactly the remote head it rewrote, bracketed by a durable marker.
const prepareAgain = async (fixture: Awaited<ReturnType<typeof rebaseFixture>>) => {
  const identity = fixture.service.config.identity, view = await fixture.service.load();
  return fixture.coordinator.start({ stateVersion: fixture.service.store.getTask(identity).stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
};
const pushMarker = (fixture: Awaited<ReturnType<typeof rebaseFixture>>) =>
  fixture.service.store.getTask(fixture.service.config.identity).pushInProgress;

it('pushes the rewritten head over the exact remote head before running command checks', async () => {
  const fixture = await rebaseFixture('feature\n', 0);
  expect(fixture.result).toMatchObject({ state: 'ready', head: fixture.rebased, checked: ['P1'] });
  expect(fixture.pushes).toEqual([{ branch: BRANCH, from: expect.any(String), to: fixture.rebased }]);
  expect(fixture.pushes[0]!.from).not.toBe(fixture.rebased);
  expect(fixture.remote().head).toBe(fixture.rebased);
  expect(fixture.checkedHeads).toEqual([fixture.rebased]);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not push a rewrite whose approval became stale', async () => {
  const fixture = await rebaseFixture('changed by rebase\n');
  expect(fixture.result).toMatchObject({ state: 'review-required', head: fixture.rebased });
  expect(fixture.pushes).toEqual([]);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('returns to review without pushing when the branch moved off the rewritten head', async () => {
  let collaborator = '';
  const fixture = await rebaseFixture('feature\n', undefined, { pushedFirst(service) {
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    collaborator = fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
    return collaborator;
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required', head: collaborator });
  expect(fixture.result.reason).toMatch(/moved before the rewritten head could be pushed/);
  expect(fixture.remote().head).toBe(collaborator);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not record a refused push\'s observation into a review edited during the wait for the new head', async () => {
  let collaborator = '', edited = false;
  const fixture = await rebaseFixture('feature\n', undefined, { pushVisibleAfter: 1, pushedFirst(service) {
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    collaborator = fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
    return collaborator;
  }, duringVisibilityWait(service) {
    // A person edits the review while GitHub still shows the pre-push head.
    if (edited) return; edited = true;
    service.store.addReviewNote(service.config.identity, reviewState(service), 'P1', 'change', 'Changed during the wait.');
  } });
  expect(edited).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed during preparation/i) });
  expect(fixture.coordinator.last?.stale).toBe(true);
  // The collaborator head was not recorded into the edited review.
  expect((await fixture.service.load()).snapshot.head).not.toBe(collaborator);
  // Caught before the collaborator head was even fetched.
  expect(fixture.fetchesAfterPush()).toBe(0);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not record a refused push\'s observation into a review edited while the new head was fetched', async () => {
  let collaborator = '', edited = false;
  const fixture = await rebaseFixture('feature\n', undefined, { pushedFirst(service) {
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    collaborator = fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
    return collaborator;
  }, duringFetchAfterPush(service) {
    // A person edits the review while the collaborator head is being fetched.
    if (edited) return; edited = true;
    service.store.addReviewNote(service.config.identity, reviewState(service), 'P1', 'change', 'Changed during the fetch.');
  } });
  expect(edited).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed during preparation/i) });
  expect(fixture.coordinator.last?.stale).toBe(true);
  expect((await fixture.service.load()).snapshot.head).not.toBe(collaborator);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('waits for GitHub to report the collaborator head that refused the push before reviewing it', async () => {
  let collaborator = '';
  const fixture = await rebaseFixture('feature\n', undefined, { pushVisibleAfter: 2, pushedFirst(service) {
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    collaborator = fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
    return collaborator;
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required', head: collaborator });
  expect((await fixture.service.load()).snapshot.head).toBe(collaborator);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('settles an ambiguous push by reading the branch, then prepares again without pushing twice', async () => {
  let fail = true;
  const fixture = await rebaseFixture('feature\n', undefined, { landBeforeFailure: true,
    pushFailure: () => fail ? new Error('connection reset after the push was sent') : new Error('No second push expected.') });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'connection reset after the push was sent' });
  // The push claim and its settlement advanced task state; the failure is bound to that state, so it reads as current.
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  expect(pushMarker(fixture)).toBeNull();
  expect(fixture.remote().head).toBe(fixture.rebased);
  fail = false;
  await expect(prepareAgain(fixture)).resolves.toMatchObject({ state: 'ready', head: fixture.rebased });
  expect(fixture.pushes).toHaveLength(1);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps the push marker when the branch cannot be read, blocks merging, and settles it on the next preparation', async () => {
  let readable = false;
  const fixture = await rebaseFixture('feature\n', undefined, {
    pushFailure: () => new Error('timed out'),
    branchRead: current => { if (!readable) throw new Error('GitHub unreachable'); return current; },
  });
  const identity = fixture.service.config.identity;
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'timed out' });
  const marker = pushMarker(fixture);
  expect(marker).toMatchObject({ branch: BRANCH, to: fixture.rebased });
  const view = await fixture.service.load();
  expect(() => fixture.service.store.transitionTask(identity, fixture.service.store.getTask(identity).stateVersion, 'queued'))
    .toThrow(/push of the rewritten head is in progress/);
  expect(() => fixture.service.store.beginMergeAttempt(identity, { ...view.expected, reviewVersion: view.expected.reviewVersion! },
    fixture.rebased, null, 'direct', randomUUID(), fixture.service.store.getTask(identity).stateVersion))
    .toThrow(/push of the rewritten head is in progress/);
  await expect(prepareAgain(fixture)).resolves.toMatchObject({ state: 'failed',
    reason: expect.stringMatching(/outcome of an earlier push .* is unknown.*GitHub unreachable/) });
  expect(pushMarker(fixture)).toEqual(marker);
  readable = true;
  await expect(prepareAgain(fixture)).resolves.toMatchObject({ state: 'failed', reason: expect.stringMatching(/was settled/) });
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('pushes nothing when the review changes at the push boundary', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 3) return; // validations: 1 rebase, 2 push read, 3 push boundary
    const view = { expected: reviewState(service) };
    service.store.addReviewNote(service.config.identity, view.expected, 'P1', 'change', 'Changed at the push boundary.');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/changed before the rewritten head was pushed/);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('closes a task cancelled during its push once the push outcome is read', async () => {
  const actionId = randomUUID();
  let coordinatorRef: PreMergeCoordinator | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, { pushFailure(service) {
    const task = service.store.getTask(service.config.identity);
    expect(coordinatorRef!.cancelTask(task.stateVersion, actionId)).toBe('stopping');
    return new Error('Task cancelled.');
  }, duringRebase(_service, coordinator) { coordinatorRef = coordinator; } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Task cancelled.' });
  expect(pushMarker(fixture)).toBeNull();
  expect(fixture.service.store.getTask(fixture.service.config.identity).status).toBe('cancelled');
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('leaves the push marker for startup when shutdown interrupts the push, and startup settles it', async () => {
  let coordinatorRef: PreMergeCoordinator | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, { pushFailure() {
    void coordinatorRef!.close();
    return new Error('Server shutdown.');
  }, duringRebase(_service, coordinator) { coordinatorRef = coordinator; } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Server shutdown.' });
  expect(pushMarker(fixture)).toMatchObject({ to: fixture.rebased });
  // Shutdown starts no new GitHub read: the marker waits for startup.
  expect(fixture.branchReads()).toBe(0);
  const restarted = new PreMergeCoordinator(fixture.service, fixture.runner, {} as never, {
    inspect: async () => { throw new Error('not used'); }, fetch: async () => undefined,
    push: async () => { throw new Error('not used'); }, readBranch: async () => fixture.remote().head });
  await expect(restarted.settlePendingPush()).resolves.toBe('not-pushed');
  expect(pushMarker(fixture)).toBeNull();
  await restarted.close(); await fixture.runner.close();
});

it('waits for GitHub to report the pushed head before the later inspections compare against it', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { pushVisibleAfter: 2 });
  expect(fixture.result).toMatchObject({ state: 'ready', head: fixture.rebased, checked: ['P1'] });
  expect((await fixture.service.load()).snapshot.head).toBe(fixture.rebased);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('fails without refreshing the review when GitHub never reports the pushed head in time', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { pushVisibleAfter: 1_000, reserves: { pushVisibleMs: 600 } });
  expect(fixture.result).toMatchObject({ state: 'failed', checked: [] });
  expect(fixture.result.reason).toMatch(/has not reported the pull request's new head yet/);
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  expect(fixture.checkedHeads).toEqual([]);
  expect((await fixture.service.load()).snapshot.head).toBe(fixture.rebased);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('lets a cancel during the startup push settlement finish the read and close the task', async () => {
  let coordinatorRef: PreMergeCoordinator | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, { pushFailure() {
    void coordinatorRef!.close();
    return new Error('Server shutdown.');
  }, duringRebase(_service, coordinator) { coordinatorRef = coordinator; } });
  const identity = fixture.service.config.identity;
  expect(pushMarker(fixture)).not.toBeNull();
  const read = Promise.withResolvers<string | null>();
  let readSignal: AbortSignal | undefined;
  const restarted = new PreMergeCoordinator(fixture.service, fixture.runner, {} as never, {
    inspect: async () => { throw new Error('not used'); }, fetch: async () => undefined,
    push: async () => { throw new Error('not used'); },
    readBranch: async (_branch, signal) => { readSignal = signal; return read.promise; } });
  const settling = restarted.settlePendingPush();
  expect(restarted.active).toBe(true);
  expect(restarted.cancelTask(fixture.service.store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
  expect(readSignal?.aborted).toBe(false);
  read.resolve(fixture.remote().head);
  await expect(settling).resolves.toBe('not-pushed');
  expect(pushMarker(fixture)).toBeNull();
  expect(fixture.service.store.getTask(identity).status).toBe('cancelled');
  await restarted.close(); await fixture.runner.close();
});

it('reviews a collaborator push that lands on the rewritten head right after it was pushed', async () => {
  let collaborator = '';
  const fixture = await rebaseFixture('feature\n', 0, { afterPush(service, pushed) {
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${pushed}^{tree}`);
    collaborator = fixtureGit(service.config.repository, 'commit-tree', tree, '-p', pushed, '-m', 'collaborator on top');
    return collaborator;
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required', head: collaborator, checked: [] });
  expect(fixture.result.reason).toMatch(/moved after the rewritten head was pushed/);
  expect((await fixture.service.load()).snapshot).toMatchObject({ base: fixture.remote().base, head: collaborator });
  expect(fixture.checkedHeads).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reviews a collaborator push that lands between the push and its read-back', async () => {
  let collaborator = '';
  const fixture = await rebaseFixture('feature\n', 0, { readBackFails: true, afterPush(service, pushed) {
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${pushed}^{tree}`);
    collaborator = fixtureGit(service.config.repository, 'commit-tree', tree, '-p', pushed, '-m', 'collaborator before the read-back');
    return collaborator;
  } });
  // The push's own read-back failed; the settlement read found the collaborator's head, so it is reviewed, not failed.
  expect(fixture.result).toMatchObject({ state: 'review-required', head: collaborator, checked: [] });
  expect(fixture.result.reason).toMatch(/moved while the rewritten head was being pushed/);
  expect(fixture.service.store.getTask(fixture.service.config.identity).pushInProgress).toBeNull();
  expect((await fixture.service.load()).snapshot).toMatchObject({ base: fixture.remote().base, head: collaborator });
  expect(fixture.checkedHeads).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps waiting while GitHub still reports the pre-push head, even if the base moved meanwhile', async () => {
  let movedBase = '';
  const fixture = await rebaseFixture('feature\n', 0, { pushVisibleAfter: 2, movedBaseAfterPush(service) {
    const onto = service.store.getSnapshot(service.config.identity).base;
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${onto}^{tree}`);
    movedBase = fixtureGit(service.config.repository, 'commit-tree', tree, '-p', onto, '-m', 'base moved again');
    return movedBase;
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required', head: fixture.rebased, checked: [] });
  expect(fixture.result.reason).toMatch(/moved after the rewritten head was pushed/);
  // The review stays on the head the branch holds, against the base it descends from: never back on the pre-push head.
  expect((await fixture.service.load()).snapshot.head).toBe(fixture.rebased);
  expect((await fixture.service.load()).segments.filter(segment => segment.row === 'Unplanned')).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('pushes nothing when shutdown begins while the push reads the remote, before this coordinator is closed', async () => {
  let closingAtBoundary: boolean | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, { duringPushRead(_service, coordinator) {
    // Server shutdown step 1 stops runner admission; the coordinator's own close waits for the HTTP drain (step 2).
    coordinator.runner.rejectAdmission();
    closingAtBoundary = coordinator.runner.closing;
    // The coordinator itself is still open: a new preparation would be refused only as already running.
    expect(() => coordinator.assertStartable()).toThrow(/already running/);
  } });
  expect(closingAtBoundary).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The server is shutting down.' });
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  // Shutdown starts no new GitHub read: the marker waits for startup.
  expect(fixture.branchReads()).toBe(0);
  expect(pushMarker(fixture)).toMatchObject({ to: fixture.rebased });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('pushes nothing when a cancel is committed while the push reads the remote, and closes the task once the outcome is read', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringPushRead(service, coordinator) {
    // The production route: the coordinator cancels the task and aborts this preparation after the cancel commits.
    expect(coordinator.cancelTask(service.store.getTask(service.config.identity).stateVersion, randomUUID())).toBe('stopping');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(fixture.service.store.getTask(fixture.service.config.identity)).toMatchObject({ status: 'cancelled', pushInProgress: null });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('pushes nothing when the reviewed snapshot changes at the push boundary', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 3) return; // validations: 1 rebase, 2 push read, 3 push boundary
    const identity = service.config.identity, view = { expected: reviewState(service) }, snapshot = service.store.getSnapshot(identity);
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${snapshot.head}^{tree}`);
    const later = fixtureGit(service.config.repository, 'commit-tree', tree, '-p', snapshot.head, '-m', 'later');
    service.store.recordHistory(identity, view.expected, snapshot.base, later, []);
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/changed before the rewritten head was pushed/);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(fixture.service.store.getTask(fixture.service.config.identity).pushInProgress).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('after a refused push, traces a lagging earlier push of codeboost\'s own rewrite from its own base, not the original one', async () => {
  // 1. The push of R1 lands, but the PR API keeps showing the original head, so preparation fails.
  let r2 = '';
  const fixture = await rebaseFixture('feature\n', undefined, { pushVisibleAfter: 1_000, reserves: { pushVisibleMs: 300 },
    rebaseResult(service, input, run) {
      if (run !== 2) return undefined;
      // 3. The second rebase rewrites R1 onto the moved base as R2.
      const repository = service.config.repository;
      fixtureGit(repository, 'switch', '-qc', 'second-rebase', input.onto);
      writeFileSync(join(repository, 'a.txt'), 'feature\n'); fixtureGit(repository, 'commit', '-qam', 'rebased feature again');
      r2 = fixtureGit(repository, 'rev-parse', 'HEAD');
      fixtureGit(repository, 'switch', '-q', 'feature');
      return r2;
    } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  const identity = fixture.service.config.identity, r1 = fixture.rebased, b1 = fixture.service.store.getSnapshot(identity).base;
  expect(fixture.remote().head).toBe(r1);
  // 2. The base branch moves again; the PR API still shows the original head for two more reads.
  const repository = fixture.service.config.repository;
  fixtureGit(repository, 'switch', '-qc', 'moved-again', b1);
  writeFileSync(join(repository, 'c.txt'), 'later base\n'); fixtureGit(repository, 'add', 'c.txt'); fixtureGit(repository, 'commit', '-qm', 'move base again');
  const b2 = fixtureGit(repository, 'rev-parse', 'HEAD');
  fixtureGit(repository, 'switch', '-q', 'feature');
  const original = fixture.pushes[0]!.from;
  fixture.moveRemote({ base: b2, head: r1 }, { base: b2, head: original }, 2);
  // 4. The retry rebases R1 onto B2 and pushes R2 leased to the original head; the branch holds R1, so it is refused.
  const retried = await prepareAgain(fixture);
  expect(retried).toMatchObject({ state: 'review-required', head: r1 });
  expect(fixture.pushes.at(-1)).toMatchObject({ from: original, to: r2 });
  // R1 is reviewed against B1, the base it was rewritten onto: the upstream base commit is not attributed to the PR.
  expect(fixture.service.store.getSnapshot(identity)).toMatchObject({ base: b1, head: r1 });
  expect((await fixture.service.load()).segments.filter(segment => segment.row === 'Unplanned')).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reports a failure after a successful push as current, not stale', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { fetchFailsAfterPush: true, afterPush(service, pushed) {
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${pushed}^{tree}`);
    return fixtureGit(service.config.repository, 'commit-tree', tree, '-p', pushed, '-m', 'collaborator on top');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'fetch failed after the push' });
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: false });
  await fixture.coordinator.close(); await fixture.runner.close();
});

/** Make the monotonic clock jump so only `leftMs` of a default ten-minute preparation deadline remains. */
const leaveOfDeadline = (startedAt: number, leftMs: number) => {
  const real = performance.now.bind(performance), offset = startedAt + 10 * 60_000 - leftMs - real();
  vi.spyOn(performance, 'now').mockImplementation(() => real() + offset);
};

it('pushes nothing when a plan revision is applied at the push boundary', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 3) return; // validations: 1 rebase, 2 push read, 3 push boundary
    const plan = service.store.getPlan(service.config.identity);
    // A plan revision advances only the task state version: neither the review version nor the snapshot changes.
    service.store.importRevision(JSON.stringify({ ...plan, summary: 'Amended at the push boundary' }), 'json',
      service.planContext(), plan.revision);
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/changed before the rewritten head was pushed/);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(fixture.pushes).toHaveLength(1);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('ends the wait for the pushed head when the preparation deadline, not the visibility limit, runs out', async () => {
  const startedAt = performance.now(), waitStarted: number[] = [];
  const fixture = await rebaseFixture('feature\n', undefined, { pushVisibleAfter: 1_000_000, afterPush(_service, pushed) {
    // The process-settlement reserve plus 1.5 s remain once the push lands; the 30 s visibility limit would outlast it.
    leaveOfDeadline(startedAt, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 1_500);
    waitStarted.push(Date.now());
    return pushed;
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/has not reported the pull request's new head yet/);
  expect(Date.now() - waitStarted[0]!).toBeLessThan(10_000);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('leaves the push marker without a branch read when the preparation deadline ends the push', async () => {
  let startedAt = 0;
  const fixture = await rebaseFixture('feature\n', undefined, { branchReadHangs: true,
    duringRebase() { startedAt = performance.now(); },
    pushFailure() {
      // The preparation's timer aborts its work the settlement reserve before the deadline; so does this push.
      leaveOfDeadline(startedAt, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS - 50);
      return Object.assign(new Error('Pre-merge preparation deadline exceeded.'), { code: 'ETIMEDOUT' });
    } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Pre-merge preparation deadline exceeded.' });
  // Less than Git's settlement reserve is left, so no read starts: the outcome stays unknown and the marker stays.
  expect(fixture.branchReads()).toBe(0);
  expect(pushMarker(fixture)).toMatchObject({ to: fixture.rebased });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('lets shutdown abort a startup push settlement whose branch read does not answer', async () => {
  let coordinatorRef: PreMergeCoordinator | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, { pushFailure() {
    void coordinatorRef!.close();
    return new Error('Server shutdown.');
  }, duringRebase(_service, coordinator) { coordinatorRef = coordinator; } });
  expect(pushMarker(fixture)).not.toBeNull();
  const restarted = new PreMergeCoordinator(fixture.service, fixture.runner, {} as never, {
    inspect: async () => { throw new Error('not used'); }, fetch: async () => undefined,
    push: async () => { throw new Error('not used'); },
    readBranch: async (_branch, signal) => new Promise<never>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const settling = restarted.settlePendingPush(), closedAt = Date.now();
  await restarted.close();
  expect(Date.now() - closedAt).toBeLessThan(5_000);
  await expect(settling).resolves.toBeNull();
  expect(pushMarker(fixture)).not.toBeNull();
  await fixture.runner.close();
});

it('lets a cancel during the next preparation\'s push settlement finish the read and close the task', async () => {
  let readable = false;
  const read = Promise.withResolvers<string | null>();
  const fixture = await rebaseFixture('feature\n', undefined, {
    pushFailure: () => new Error('timed out'),
    branchRead: (current, signal) => {
      if (!readable) throw new Error('GitHub unreachable');
      // A real read is aborted by its signal; a cancel must not be able to abort this one.
      signal?.addEventListener('abort', () => read.reject(signal.reason), { once: true });
      return read.promise;
    },
  });
  const identity = fixture.service.config.identity;
  expect(pushMarker(fixture)).not.toBeNull();
  readable = true;
  const preparing = prepareAgain(fixture);
  await vi.waitFor(() => expect(fixture.branchReads()).toBe(2));
  expect(fixture.coordinator.cancelTask(fixture.service.store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
  read.resolve(fixture.remote().head);
  await expect(preparing).resolves.toMatchObject({ state: 'failed', reason: 'Task cancelled.' });
  expect(fixture.service.store.getTask(identity)).toMatchObject({ status: 'cancelled', pushInProgress: null });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reports a failed push as stale when a plan revision lands while its outcome is read', async () => {
  let serviceRef: ReviewService | null = null, revised = false;
  const fixture = await rebaseFixture('feature\n', undefined, { landBeforeFailure: true,
    duringRebase(service) { serviceRef = service; },
    pushFailure: () => new Error('connection reset'),
    branchRead: (current) => {
      // Another request applies a plan revision while the settlement read is in flight.
      const service = serviceRef!, plan = service.store.getPlan(service.config.identity);
      service.store.importRevision(JSON.stringify({ ...plan, summary: 'Amended during the read' }), 'json',
        service.planContext(), plan.revision);
      revised = true;
      return current;
    } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'connection reset' });
  expect(revised).toBe(true);
  expect(pushMarker(fixture)).toBeNull();
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('reports a failure after a push as stale when a plan revision landed while the push was on the wire', async () => {
  const revise = (service: ReviewService) => {
    const plan = service.store.getPlan(service.config.identity);
    service.store.importRevision(JSON.stringify({ ...plan, summary: 'Amended during the push' }), 'json',
      service.planContext(), plan.revision);
  };
  // A successful push, then a failure while reviewing the head a collaborator pushed on top of it.
  const pushed = await rebaseFixture('feature\n', 0, { fetchFailsAfterPush: true, afterPush(service, head) {
    revise(service);
    const tree = fixtureGit(service.config.repository, 'rev-parse', `${head}^{tree}`);
    return fixtureGit(service.config.repository, 'commit-tree', tree, '-p', head, '-m', 'collaborator on top');
  } });
  // The revision is caught before the collaborator head is fetched and recorded: the failure names the change.
  expect(pushed.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed during preparation/i) });
  expect(pushed.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await pushed.coordinator.close(); await pushed.runner.close();
  // A refused push, then a failure while reviewing the collaborator head that refused it.
  const refused = await rebaseFixture('feature\n', undefined, { fetchFailsAfterPush: true, pushedFirst(service) {
    revise(service);
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    return fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
  } });
  expect(refused.result).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed during preparation/i) });
  expect(refused.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await refused.coordinator.close(); await refused.runner.close();
});

it('runs no command check when a plan revision landed while the push was on the wire', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { afterPush(service, head) {
    const plan = service.store.getPlan(service.config.identity);
    service.store.importRevision(JSON.stringify({ ...plan, summary: 'Amended during the push' }), 'json',
      service.planContext(), plan.revision);
    return head;
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', checked: [] });
  expect(fixture.result.reason).toMatch(/changed during preparation/);
  expect(fixture.checkedHeads).toEqual([]);
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('leaves a running preparation in charge when a push settlement is requested meanwhile', async () => {
  let requested: Promise<unknown> | null = null, stillActive: boolean | null = null;
  const fixture = await rebaseFixture('feature\n', undefined, {
    duringRebase(_service, coordinator) { requested = coordinator.settlePendingPush(); },
    // Later, after several awaits: the settlement request must not have taken the preparation's place.
    duringPushRead(_service, coordinator) { stillActive = coordinator.active; },
  });
  await expect(requested).resolves.toBeNull();
  expect(stillActive).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'ready', head: fixture.rebased });
  expect(fixture.branchReads()).toBe(0);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('pushes nothing when the task is reassigned while the push authorization is read', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 2) return; // validations: 1 rebase, 2 push authorization read
    const identity = service.config.identity;
    service.store.setAssignment(identity, service.store.getTask(identity).stateVersion, 'someone-else', 'c'.repeat(40));
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.pushes).toEqual([]);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it.each([
  ['reassigned', (service: ReviewService) => {
    const identity = service.config.identity;
    service.store.setAssignment(identity, service.store.getTask(identity).stateVersion, 'someone-else', 'c'.repeat(40));
  }],
  ['given a review edit', (service: ReviewService) => {
    service.store.addReviewNote(service.config.identity, reviewState(service), 'P1', 'question', 'Asked during the reload after the rebase.');
  }],
] as const)('pushes nothing when the task is %s during the review reload after the rebase (#170)', async (_case, change) => {
  // The first load sees the original head; the first one that sees another head is the reload after the rebase.
  let firstHead: string | undefined, changed = false;
  const fixture = await rebaseFixture('feature\n', undefined, { duringLoad(service) {
    const head = service.store.getSnapshot(service.config.identity).head;
    firstHead ??= head;
    if (head === firstHead || changed) return;
    changed = true;
    change(service);
  } });
  expect(changed).toBe(true);
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'The task or review changed during preparation. Reload first.' });
  expect(fixture.coordinator.last?.stale).toBe(true);
  expect(fixture.pushes).toEqual([]);
  expect(fixture.remote().head).not.toBe(fixture.rebased);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('keeps the process-settlement reserve inside a settlement read\'s time limit', async () => {
  // Reserve plus 2 s left: the read may run for at most about 2 s, leaving the reserve for Git to settle.
  let startedAt = 0, failedAt = 0, pushedAt = 0;
  const fixture = await rebaseFixture('feature\n', undefined, { branchReadHangs: true,
    // Just after the preparation started, so `leaveOfDeadline` measures from (almost) its own start.
    duringRebase() { startedAt = performance.now(); },
    pushFailure() {
    leaveOfDeadline(startedAt, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS + 2_000);
    pushedAt = Date.now();
    return new Error('connection reset');
  } });
  failedAt = Date.now();
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'connection reset' });
  expect(fixture.branchReads()).toBe(1);
  expect(failedAt - pushedAt).toBeLessThan(8_000);
  expect(pushMarker(fixture)).toMatchObject({ to: fixture.rebased });
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('starts no settlement read when less than the process-settlement reserve is left', async () => {
  let startedAt = 0;
  const fixture = await rebaseFixture('feature\n', undefined, { branchReadHangs: true,
    duringRebase() { startedAt = performance.now(); },
    pushFailure() {
    leaveOfDeadline(startedAt, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS - 1_000);
    return new Error('connection reset');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'connection reset' });
  expect(fixture.branchReads()).toBe(0);
  expect(pushMarker(fixture)).toMatchObject({ to: fixture.rebased });
  await fixture.coordinator.close(); await fixture.runner.close();
});

// F6b of #22: the acceptance cases, run through the one-click merge job with real preparation.
async function mergeJob(rebasedText: string, commandExit?: number, options: Parameters<typeof rebaseFixture>[2] = {}, refuse: () => boolean = () => false) {
  const fixture = await rebaseFixture(rebasedText, commandExit, { ...options, deferStart: true, published: true });
  const merged: string[] = [];
  // As production builds it with a runner: the task's published PR, which requires durable preparation readiness.
  const gateway: MergeGateway = {
    inspect: async request => {
      const pr = fixture.service.store.taskPullRequests(fixture.service.config.identity).find(row => row.number === request?.target?.pullRequest)!;
      return { base: fixture.remote().base, head: fixture.remote().head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE',
        rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false,
        published: { headBranch: request!.target!.headBranch!, baseBranch: 'main', crossRepository: false, marker: openingMarker(pr.openingId),
          branchOpen: [{ number: 7, base: 'main' }] } };
    },
    merge: async head => {
      merged.push(head);
      if (refuse()) throw new MergeSubmissionError('Required status check "ci" is expected.', 'refused');
      return { url: 'https://github.com/acme/app/pull/7' };
    },
  };
  const merges = new MergeCoordinator(fixture.service, gateway, undefined, undefined,
    { repository: 'acme/app', baseBranch: 'main', requiresPreparation: true });
  const jobs = new MergeJobCoordinator(fixture.service, fixture.coordinator, merges, undefined, { checkWaitMs: 2_000, firstDelayMs: 5, maxDelayMs: 20 });
  const start = async () => jobs.start((await fixture.service.load()).token, randomUUID());
  const settled = async () => { await jobs.current; return jobs.latest()!; };
  const close = async () => { await jobs.close(); await fixture.coordinator.close(); await fixture.runner.close(); };
  return { ...fixture, merged, merges, jobs, start, settled, close };
}

it('merges through the job when a moved base leaves approvals valid, pushing and checking the rewritten head', async () => {
  const f = await mergeJob('feature\n', 0);
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'merged' });
  expect(f.pushes).toHaveLength(1);
  expect(f.checkedHeads).toEqual([f.rebased]);
  expect(f.merged).toEqual([f.rebased]);
  await f.close();
});

it('stops the job for review when the rebase makes an approval stale, and merges nothing', async () => {
  const f = await mergeJob('changed by rebase\n');
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'review-required', reason: expect.stringMatching(/requires refreshed attribution or approval/) });
  expect(f.merged).toEqual([]);
  await f.close();
});

it('fails the job when a command check breaks on the rewritten head', async () => {
  const f = await mergeJob('feature\n', 1);
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/command checks did not pass/) });
  expect(f.merged).toEqual([]);
  await f.close();
});

it('stops the job for review when a collaborator pushed to the pull request', async () => {
  const f = await mergeJob('feature\n');
  const repository = f.service.config.repository;
  writeFileSync(join(repository, 'late.txt'), 'collaborator\n'); fixtureGit(repository, 'add', 'late.txt'); fixtureGit(repository, 'commit', '-qm', 'collaborator');
  f.moveRemote({ base: f.remote().base, head: fixtureGit(repository, 'rev-parse', 'HEAD') });
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'review-required', reason: expect.stringMatching(/head moved/) });
  expect(f.pushes).toEqual([]);
  expect(f.merged).toEqual([]);
  await f.close();
});

// T6: a head-only collaborator push is reviewed again, then the next job reruns the `cmd:` checks on that head. The design
// (docs/implementation/merge-handoff.md, Outcomes: `review-required`) reruns them only after the person reviews it.
it.each([[0, 'merged'], [1, 'failed']] as const)('reruns command checks on a collaborator head after review when the base did not move (exit %i)', async (exit, ending) => {
  let commandExit = 0;
  const f = await mergeJob('feature\n', 0, { commandResult: () => commandExit });
  const identity = f.service.config.identity, repository = f.service.config.repository;
  const reviewed = (await f.service.load()).snapshot;
  writeFileSync(join(repository, 'a.txt'), 'feature, changed by a collaborator\n');
  fixtureGit(repository, 'commit', '-qam', 'collaborator');
  const collaborator = fixtureGit(repository, 'rev-parse', 'HEAD');
  // Only the head moved: GitHub reports the base the review was made against.
  f.moveRemote({ base: reviewed.base, head: collaborator });
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'review-required', reason: expect.stringMatching(/head moved/) });
  expect(f.checkedHeads).toEqual([]);
  // The review was recomputed for the new head: the collaborator's lines are Unplanned and P1 is no longer approved.
  let view = await f.service.load();
  expect(view.snapshot).toMatchObject({ base: reviewed.base, head: collaborator });
  const unplanned = view.segments.filter(segment => segment.row === 'Unplanned');
  expect(unplanned.length).toBeGreaterThan(0);
  expect(view.items.find(item => item.id === 'P1')?.state).not.toBe('approved');
  // The person attributes the collaborator's change to P1 and approves it again, then merges again.
  for (const segment of unplanned) view = await f.service.act({ action: 'assign', key: segment.key, item: 'P1', token: view.token });
  view = await f.service.act({ action: 'approve', item: 'P1', token: view.token });
  expect(view.items.find(item => item.id === 'P1')?.state).toBe('approved');
  commandExit = exit;
  await f.start();
  const job = await f.settled();
  expect(job).toMatchObject({ state: ending });
  // The check ran again, on the collaborator head, with no rebase or push in between.
  expect(f.checkedHeads).toEqual([collaborator]);
  expect(f.rebaseRuns()).toBe(0);
  expect(f.pushes).toEqual([]);
  const check = f.service.store.getAttempts(identity).filter(attempt => attempt.kind === 'check');
  expect(check).toHaveLength(1);
  expect(f.service.store.getSnapshot(identity, check[0]!.context.snapshotId).head).toBe(collaborator);
  if (ending === 'merged') expect(f.merged).toEqual([collaborator]);
  else { expect(job.reason).toMatch(/command checks did not pass/); expect(f.merged).toEqual([]); }
  await f.close();
}, 60_000);

it('stops a retry for review when its preparation rebases after GitHub refused the merge', async () => {
  let refuse = true;
  const f = await mergeJob('feature\n', 0, {
    // The retry's rebase replays the already-rebased head onto the moved base, keeping its content.
    rebaseResult: (service, input, run) => run < 2 ? undefined : fixtureGit(service.config.repository, 'commit-tree',
      fixtureGit(service.config.repository, 'rev-parse', `${input.oldHead}^{tree}`), '-p', input.onto, '-m', 'feature, rebased again'),
  }, () => refuse);
  await f.start();
  expect(await f.settled()).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge/) });
  expect(f.service.store.getTask(f.service.config.identity).status).toBe('approved but merge blocked');
  // The base moves again before the person retries: the retry's preparation rebases, making a new snapshot.
  refuse = false;
  const repository = f.service.config.repository, base = f.remote().base;
  const moved = fixtureGit(repository, 'commit-tree', fixtureGit(repository, 'rev-parse', `${base}^{tree}`), '-p', base, '-m', 'base moved after the refusal');
  f.moveRemote({ base: moved, head: f.remote().head });
  await f.start();
  // After a merge attempt, a replacement snapshot needs every item approved again (#24): the retry stops for review.
  expect(await f.settled()).toMatchObject({ state: 'review-required', reason: expect.stringMatching(/requires refreshed attribution or approval/) });
  expect((await f.service.load()).items.every(item => item.state === 'stale')).toBe(true);
  expect((await f.merges.status()).blockers).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'queue-head', message: expect.stringMatching(/Approve every item again for the replacement snapshot/) })]));
  expect(f.merged).toHaveLength(1);
  await f.close();
}, 60_000);

it('ends the job cancelled when the task is cancelled while a command check runs', async () => {
  const f = await mergeJob('feature\n', 0, { commandWaitsForCancellation: true });
  await f.start();
  // The preparation's review loads each await a history worker (#170) before the check starts.
  await vi.waitFor(() => expect(f.runner.isActive(f.service.config.identity)).toBe(true), { timeout: 20_000 });
  const identity = f.service.config.identity;
  // As the cancel route does: the task's cancel commits (it waits on the running check), then the job is told.
  expect(f.coordinator.cancelTask(f.service.store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
  f.jobs.cancel();
  expect(await f.settled()).toMatchObject({ state: 'cancelled' });
  expect(new Set(f.cancelReasons)).toEqual(new Set(['cancelled']));
  expect(f.merged).toEqual([]);
  await vi.waitFor(() => expect(f.service.store.getTask(identity).status).toBe('cancelled'));
  await f.close();
});

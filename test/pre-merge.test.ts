import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { COMMAND_CHECK_SETTLEMENT_RESERVE_MS, PRE_MERGE_PROCESS_SETTLEMENT_RESERVE_MS, PreMergeCoordinator,
  type PreMergeAuthorization } from '../runner/pre-merge.ts';
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

const roots: string[] = [], services: ReviewService[] = [];
const BRANCH = 'codeboost/task-1';
// A remote fake for tests whose path must never push or read the branch.
const unusedPush = { push: async () => { throw new Error('No push expected.'); },
  readBranch: async () => { throw new Error('No branch read expected.'); } };
vi.setConfig({ testTimeout: 15_000 });
afterEach(() => { vi.restoreAllMocks(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const markRunnerOwned = (service: ReviewService) => {
  const identity = service.config.identity;
  service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'queued');
  const attempt = service.store.admitAttempt(identity, { expectedStateVersion: service.store.getTask(identity).stateVersion,
    kind: 'execute', item: 'P1', deadline: Date.now() + 60_000, expectedContext: service.store.currentContext(identity) });
  service.store.markRunning(identity, attempt.id);
  service.store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true,
    result: { unchanged: false, head: service.store.getSnapshot(identity).head } });
  service.store.transitionTask(identity, service.store.getTask(identity).stateVersion, 'in review');
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
  duringAuthorize?: (service: ReviewService, call: number) => { base: string; head: string } | void;
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
  authorize?: (signal: AbortSignal) => Promise<PreMergeAuthorization>;
  reserves?: { processMs?: number; commandMs?: number; pushVisibleMs?: number };
  /** The PR API keeps reporting the pre-push head for this many inspections after a push. */
  pushVisibleAfter?: number;
  /** The push lands on the branch before it fails. */
  landBeforeFailure?: boolean;
  /** Runs once the push has landed and may move the branch again, as a collaborator push would. */
  afterPush?: (service: ReviewService, pushed: string) => string;
  pushFailure?: (service: ReviewService, input: { from: string; to: string }) => Error;
  branchRead?: (current: string) => string | null | Promise<string | null>;
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
  let view = service.load();
  service.store.recordHistory(identity, view.expected, base, head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  if (options.runnerCommitted !== false) markRunnerOwned(service); else markRunnerUnchanged(service);
  view = service.load(); view = service.act({ action: 'approve', item: 'P1', token: view.token });
  let coordinator!: PreMergeCoordinator, rebaseRuns = 0;
  let rebaseAborts = 0;
  const rebaseBudgets: Array<number | undefined> = [], abortBudgets: Array<number | undefined> = [];
  const rebaser = { run: async (input: { attemptId: string; signal: AbortSignal; timeoutMs?: number }) => {
    rebaseRuns++;
    rebaseBudgets.push(input.timeoutMs);
    options.duringRebase?.(service, coordinator, input.timeoutMs);
    input.signal.throwIfAborted();
    if (options.unsettledRebase) throw new RebaseResourcesUnsettled('Conflict resources remain owned.');
    if (options.rebaseFailure) throw options.rebaseFailure;
    const planKey = service.store.getTask(identity).planKey;
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
      return { clone: { id: attempt.id, taskId: 'task', directory: repository, head: checkedHead }, storage: {} } as WorkspaceRef;
    },
    async snapshotDeclaredLinks() { throw new Error('not used'); }, async checkTree() { throw new Error('not used'); },
    async inspectChanges() { throw new Error('not used'); }, async commit() { throw new Error('not used'); },
    async release() { if (options.releaseFails) throw new Error('cleanup failed'); },
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
    return { attemptId: input.attemptId,
      settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode: commandExit ?? 0,
        signal: null, stdout: '', stderr: commandExit ? 'failed' : '' }), cancel() {} } satisfies InvocationHandle;
  }, context.allowedCommands, 'a'.repeat(32)));
  let remoteReads = 0, remotePair: { base: string; head: string; branch?: string } = { base: onto, head, branch: BRANCH };
  const pushes: { branch: string; from: string; to: string }[] = [];
  let lagging = 0, lagged = remotePair;
  let authorizationChecks = 0;
  const authorize = options.authorize ?? (options.duringAuthorize ? async () => ({
    refresh: async () => undefined,
    validate: () => { remotePair = options.duringAuthorize!(service, ++authorizationChecks) ?? remotePair; },
  }) : undefined);
  coordinator = new PreMergeCoordinator(service,
    runner,
    rebaser, { inspect: async () => {
      if (lagging > 0) { lagging--; return lagged; }
      remoteReads++;
      // Read 2 is the post-push visibility check; hooks keep counting the later inspections as before the push existed.
      if (remoteReads > 2) options.duringFinalInspect?.(service, coordinator, remoteReads - 1);
      return remotePair;
    }, fetch: async () => undefined,
    push: async input => {
      pushes.push({ branch: input.branch, from: input.from, to: input.to });
      input.beforePush();
      if (options.landBeforeFailure && remotePair.head === input.from) { lagged = remotePair; remotePair = { ...remotePair, head: input.to }; }
      if (options.pushFailure) throw options.pushFailure(service, input);
      if (remotePair.head !== input.from) throw new BranchPushRefused('moved');
      lagged = remotePair; lagging = options.pushVisibleAfter ?? 0;
      remotePair = { ...remotePair, head: input.to };
      if (options.afterPush) remotePair = { ...remotePair, head: options.afterPush(service, input.to) };
    },
    readBranch: async () => options.branchRead ? options.branchRead(remotePair.head) : remotePair.head,
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
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id, base: view.snapshot.base, head: view.snapshot.head });
  return { service, coordinator, runner, result, rebased, checkedHeads, cancelReasons, pushes, remote: () => remotePair,
    rebaseRuns: () => rebaseRuns, rebaseAborts: () => rebaseAborts, rebaseBudgets, abortBudgets };
}

it('preserves an approval when a moved base leaves its attributed fingerprint unchanged', async () => {
  const { service, coordinator, runner, result, rebased } = await rebaseFixture('feature\n');
  expect(result).toMatchObject({ state: 'ready', head: rebased, checked: [], reason: null });
  expect(service.load().items.find(item => item.id === 'P1')?.state).toBe('approved');
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
  expect(service.load().items.find(item => item.id === 'P1')?.state).toBe('stale');
  await coordinator.close(); await runner.close();
});

it('marks a failed preparation stale when its final remote inspection was invalidated by a review edit', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringFinalInspect(service) {
    const current = service.load();
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
      const current = service.load();
      service.store.addReviewNote(service.config.identity, current.expected, 'P1', 'change', 'Changed during rebase.');
    },
    rebaseFailure: new Error('rebase failed'), rebaseCleanupFailure: new Error('cleanup failed'),
  });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'rebase failed' });
  expect(fixture.coordinator.last).toMatchObject({ state: 'failed', stale: true });
  await fixture.coordinator.close(); await fixture.runner.close();
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

it('does not report readiness while a current change request remains open', async () => {
  const fixture = await rebaseFixture('feature\n');
  const current = fixture.service.load();
  fixture.service.store.addReviewNote(fixture.service.config.identity, current.expected, 'P1', 'change', 'Please revise this.');
  const changed = fixture.service.load(), task = fixture.service.store.getTask(fixture.service.config.identity);
  const result = await fixture.coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: changed.expected.reviewVersion!, snapshotId: changed.snapshot.id, base: changed.snapshot.base, head: changed.snapshot.head });
  expect(result).toMatchObject({ state: 'review-required', checked: [] });
  expect(result.reason).toMatch(/1 change request remains open/);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('preserves an unpushed rebased head across review and preparation retries', async () => {
  const first = await rebaseFixture('changed by rebase\n');
  let view = first.service.load();
  view = first.service.act({ action: 'approve', item: 'P1', token: view.token });
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
      const view = service.load();
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
    const view = service.load();
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
    return { base: service.load().snapshot.base, head: fixtureGit(service.config.repository, 'rev-parse', 'HEAD') };
  } });
  expect(fixture.result).toMatchObject({ state: 'review-required' });
  expect(fixture.result.reason).toMatch(/moved during final authorization/);
  expect(fixture.service.load().snapshot.head).toBe(fixture.result.head);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('marks historical readiness stale after the review changes', async () => {
  const fixture = await rebaseFixture('feature\n');
  expect(fixture.coordinator.last).toMatchObject({ state: 'ready', stale: false });
  const view = fixture.service.load();
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
  const view = fixture.service.load();
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

it('refreshes the moved head against its prior base when the PR base and head advance together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = service.load();
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
  const refreshed = service.load();
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
  let view = service.load();
  service.store.recordHistory(identity, view.expected, oldBase, oldHead,
    [{ sha: oldHead, owner: 'P1', origin: 'owned', sourceSha: null }]);
  markRunnerOwned(service); view = service.load();
  service.store.recordRebase(identity, view.expected, newBase, rewrittenHead,
    [{ oldSha: oldHead, newSha: rewrittenHead }]);
  view = service.load(); view = service.act({ action: 'approve', item: 'P1', token: view.token });
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
  expect(service.load().snapshot).toMatchObject({ base: oldBase, head: collaboratorHead });
  await coordinator.close();
});

it('refuses preparation before review or remote work while runner cleanup is unresolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-pre-merge-unresolved-')); roots.push(root);
  const config = createDemo(join(root, 'demo')), service = new ReviewService(config); services.push(service);
  markRunnerOwned(service);
  const view = service.load(), task = service.store.getTask(config.identity);
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
  const view = service.load();
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
  const view = service.load(), task = service.store.getTask(config.identity);
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
  const view = service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
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
  const view = service.load(), task = service.store.getTask(config.identity);
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
  const view = service.load(), task = service.store.getTask(config.identity);
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
  const view = service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
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
  const view = service.load(), task = service.store.getTask(config.identity), actionId = randomUUID();
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
  const view = fixture.service.load(), task = fixture.service.store.getTask(fixture.service.config.identity);
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
  let view = service.load();
  service.store.recordHistory(identity, view.expected, base, head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  markRunnerOwned(service); view = service.load();
  view = service.act({ action: 'approve', item: 'P1', token: view.token });
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
  expect(service.load().segments.some(segment => segment.row === 'Unplanned')).toBe(true);
  await coordinator.close();
});

// F6a of #22: the reviewed, rewritten head is pushed over exactly the remote head it rewrote, bracketed by a durable marker.
const prepareAgain = (fixture: Awaited<ReturnType<typeof rebaseFixture>>) => {
  const identity = fixture.service.config.identity, view = fixture.service.load();
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
  const fixture = await rebaseFixture('feature\n', undefined, { pushFailure(service) {
    writeFileSync(join(service.config.repository, 'late.txt'), 'collaborator\n');
    fixtureGit(service.config.repository, 'add', 'late.txt'); fixtureGit(service.config.repository, 'commit', '-qm', 'collaborator');
    collaborator = fixtureGit(service.config.repository, 'rev-parse', 'HEAD');
    return new BranchPushRefused('The branch moved.');
  }, branchRead: () => collaborator });
  expect(fixture.result).toMatchObject({ state: 'review-required' });
  expect(fixture.result.reason).toMatch(/moved before the rewritten head could be pushed/);
  expect(pushMarker(fixture)).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('settles an ambiguous push by reading the branch, then prepares again without pushing twice', async () => {
  let fail = true;
  const fixture = await rebaseFixture('feature\n', undefined, { landBeforeFailure: true,
    pushFailure: () => fail ? new Error('connection reset after the push was sent') : new Error('No second push expected.') });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'connection reset after the push was sent' });
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
  const view = fixture.service.load();
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
    const view = service.load();
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
  const restarted = new PreMergeCoordinator(fixture.service, fixture.runner, {} as never, {
    inspect: async () => { throw new Error('not used'); }, fetch: async () => undefined,
    push: async () => { throw new Error('not used'); }, readBranch: async () => fixture.remote().head });
  await expect(restarted.settleAtStartup()).resolves.toBe('not-pushed');
  expect(pushMarker(fixture)).toBeNull();
  await restarted.close(); await fixture.runner.close();
});

it('waits for GitHub to report the pushed head before the later inspections compare against it', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { pushVisibleAfter: 2 });
  expect(fixture.result).toMatchObject({ state: 'ready', head: fixture.rebased, checked: ['P1'] });
  expect(fixture.service.load().snapshot.head).toBe(fixture.rebased);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('fails without refreshing the review when GitHub never reports the pushed head in time', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { pushVisibleAfter: 1_000, reserves: { pushVisibleMs: 600 } });
  expect(fixture.result).toMatchObject({ state: 'failed', checked: [] });
  expect(fixture.result.reason).toMatch(/has not reported the pushed head/);
  expect(fixture.checkedHeads).toEqual([]);
  expect(fixture.service.load().snapshot.head).toBe(fixture.rebased);
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
  const settling = restarted.settleAtStartup();
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
  expect(fixture.service.load().snapshot).toMatchObject({ base: fixture.remote().base, head: collaborator });
  expect(fixture.checkedHeads).toEqual([]);
  await fixture.coordinator.close(); await fixture.runner.close();
});

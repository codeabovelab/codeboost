import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PreMergeCoordinator } from '../runner/pre-merge.ts';
import { ReviewService } from '../runner/review.ts';
import { createDemo } from '../scripts/demo.ts';
import { fixtureGit } from './fixtures/git.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { commandCheckDeps } from '../runner/checks.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import type { InvocationHandle, InvocationResult } from '../agents/contract.ts';
import type { TaskWorkspace, WorkspaceRef } from '../runner/execution.ts';
import { RebaseResourcesUnsettled } from '../runner/rebase.ts';

const roots: string[] = [], services: ReviewService[] = [];
vi.setConfig({ testTimeout: 15_000 });
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

async function rebaseFixture(rebasedText: string, commandExit?: number, options: {
  duringRebase?: (service: ReviewService, coordinator: PreMergeCoordinator) => void;
  duringFinalInspect?: (service: ReviewService, coordinator: PreMergeCoordinator) => void;
  duringAuthorize?: (service: ReviewService, call: number) => { base: string; head: string } | void;
  closeDuringCommand?: boolean;
  commandWaitsForDeadline?: boolean;
  unsettledRebase?: boolean;
  operationTimeoutMs?: number;
  authorize?: (signal: AbortSignal) => Promise<() => void | Promise<void>>;
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
  markRunnerOwned(service); view = service.load(); view = service.act({ action: 'approve', item: 'P1', token: view.token });
  let coordinator!: PreMergeCoordinator, rebaseRuns = 0;
  let rebaseAborts = 0;
  const rebaser = { run: async (input: { attemptId: string; signal: AbortSignal }) => {
    rebaseRuns++;
    options.duringRebase?.(service, coordinator);
    input.signal.throwIfAborted();
    if (options.unsettledRebase) throw new RebaseResourcesUnsettled('Conflict resources remain owned.');
    const planKey = service.store.getTask(identity).planKey;
    service.store.prepareRebaseResult(planKey, input.attemptId, rebased, [rebased]);
    service.store.completeRebaseResult(planKey, input.attemptId);
    return { oldHead: head, base: onto, head: rebased,
      mappings: [{ oldSha: head, newSha: rebased }], resolvedConflicts: [] };
  }, abort: async () => { rebaseAborts++; } } as never;
  const checkedHeads: string[] = [];
  const workspace: TaskWorkspace = {
    async materialize(attempt, checkedHead) {
      checkedHeads.push(checkedHead);
      return { clone: { id: attempt.id, taskId: 'task', directory: repository, head: checkedHead }, storage: {} } as WorkspaceRef;
    },
    async snapshotDeclaredLinks() { throw new Error('not used'); }, async checkTree() { throw new Error('not used'); },
    async inspectChanges() { throw new Error('not used'); }, async commit() { throw new Error('not used'); }, async release() {},
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
    return { attemptId: input.attemptId,
      settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode: commandExit ?? 0,
        signal: null, stdout: '', stderr: commandExit ? 'failed' : '' }), cancel() {} } satisfies InvocationHandle;
  }, () => context, 'a'.repeat(32)));
  let remoteReads = 0, remotePair = { base: onto, head };
  let authorizationChecks = 0;
  const authorize = options.authorize ?? (options.duringAuthorize ? async () => () => {
    remotePair = options.duringAuthorize!(service, ++authorizationChecks) ?? remotePair;
  } : undefined);
  coordinator = new PreMergeCoordinator(service,
    runner,
    rebaser, { inspect: async () => {
      remoteReads++;
      if (remoteReads > 1) options.duringFinalInspect?.(service, coordinator);
      return remotePair;
    }, fetch: async () => undefined }, options.operationTimeoutMs, undefined, authorize);
  const task = service.store.getTask(identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id });
  return { service, coordinator, runner, result, rebased, checkedHeads, cancelReasons,
    rebaseRuns: () => rebaseRuns, rebaseAborts: () => rebaseAborts };
}

it('preserves an approval when a moved base leaves its attributed fingerprint unchanged', async () => {
  const { service, coordinator, runner, result, rebased } = await rebaseFixture('feature\n');
  expect(result).toMatchObject({ state: 'ready', head: rebased, checked: [], reason: null });
  expect(service.load().items.find(item => item.id === 'P1')?.state).toBe('approved');
  await coordinator.close(); await runner.close();
});

it('returns to review when a moved-base rewrite changes an approved fingerprint', async () => {
  const { service, coordinator, runner, result, rebased } = await rebaseFixture('changed by rebase\n');
  expect(result).toMatchObject({ state: 'review-required', head: rebased, checked: [] });
  expect(result.reason).toMatch(/requires refreshed attribution or approval/);
  expect(service.load().items.find(item => item.id === 'P1')?.state).toBe('stale');
  await coordinator.close(); await runner.close();
});

it('leaves an unsettled conflict and its rebase marker for startup recovery', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { unsettledRebase: true });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Conflict resources remain owned.' });
  expect(fixture.rebaseAborts()).toBe(0);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).not.toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('revalidates authorization before starting the delayed local rebase', async () => {
  const calls: string[] = [];
  const fixture = await rebaseFixture('feature\n', undefined, { authorize: async () => {
    calls.push('read'); return () => { calls.push('validate'); throw new Error('Issue trust was revoked.'); };
  } });
  expect(fixture.result).toMatchObject({ state: 'failed', reason: 'Issue trust was revoked.' });
  expect(calls).toEqual(['read', 'validate']);
  expect(fixture.rebaseRuns()).toBe(0);
  expect(fixture.rebaseAborts()).toBe(1);
  expect(fixture.service.store.getTask(fixture.service.config.identity).rebaseInProgress).toBeNull();
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('does not report readiness while a current change request remains open', async () => {
  const fixture = await rebaseFixture('feature\n');
  const current = fixture.service.load();
  fixture.service.store.addReviewNote(fixture.service.config.identity, current.expected, 'P1', 'change', 'Please revise this.');
  const changed = fixture.service.load(), task = fixture.service.store.getTask(fixture.service.config.identity);
  const result = await fixture.coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: changed.expected.reviewVersion!, snapshotId: changed.snapshot.id });
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
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id });
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
    if (call !== 2) return;
    const view = service.load();
    service.store.addReviewNote(service.config.identity, view.expected, 'P1', 'change', 'Changed during authorization.');
  } });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/task or review changed/);
  await fixture.coordinator.close(); await fixture.runner.close();
});

it('refreshes a pull request head that moves during final authorization', async () => {
  const fixture = await rebaseFixture('feature\n', undefined, { duringAuthorize(service, call) {
    if (call !== 2) return;
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

it('keeps a command-check deadline separate from the code-writing task budget', async () => {
  const fixture = await rebaseFixture('feature\n', 0, { commandWaitsForDeadline: true, operationTimeoutMs: 5_000 });
  expect(fixture.result).toMatchObject({ state: 'failed' });
  expect(fixture.result.reason).toMatch(/Timed out|deadline exceeded/);
  const check = fixture.service.store.getAttempts(fixture.service.config.identity).find(attempt => attempt.kind === 'check');
  expect(check).toMatchObject({ state: 'failed', firstReason: null, stopReason: 'timeout' });
  expect(fixture.service.store.getTask(fixture.service.config.identity).status).toBe('in review');
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
      stop: () => false, isActive: () => false } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => moved, fetch: async () => undefined });
  const task = service.store.getTask(config.identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id });
  expect(result.reason).toMatch(/head moved/);
  expect(result).toMatchObject({ state: 'review-required', base: initial.base, head: moved.head, checked: [] });
  const refreshed = service.load();
  expect(refreshed.snapshot).toMatchObject({ base: initial.base, head: moved.head });
  expect(refreshed.segments.some(segment => segment.row === 'Unplanned')).toBe(true);
  expect(refreshed.items.some(item => item.state !== 'approved')).toBe(true);
  await coordinator.close();
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
      stop: () => false, isActive: () => false } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      fetch: async () => undefined }, 60_000, capability);
  const active = coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id, actionId });
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
      stop: () => false, isActive: () => false } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      fetch: async () => undefined }, 20);
  await expect(coordinator.start({ stateVersion: task.stateVersion, reviewVersion: view.expected.reviewVersion!,
    snapshotId: view.snapshot.id })).resolves.toMatchObject({ state: 'failed', reason: 'Pre-merge preparation deadline exceeded.' });
  await coordinator.close();
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
      stop: () => false, isActive: () => false } as never,
    { run: async () => { throw new Error('No rebase expected.'); }, abort: async () => undefined } as never,
    { inspect: async () => ++reads === 1 ? { base, head } : moved, fetch: async () => undefined });
  const task = service.store.getTask(identity);
  const result = await coordinator.start({ stateVersion: task.stateVersion,
    reviewVersion: view.expected.reviewVersion!, snapshotId: view.snapshot.id });
  expect(result).toMatchObject({ state: 'review-required', base, head: moved.head, checked: [] });
  expect(result.reason).toMatch(/moved during preparation/);
  expect(service.load().segments.some(segment => segment.row === 'Unplanned')).toBe(true);
  await coordinator.close();
});

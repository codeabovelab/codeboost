import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SAFETY_VIOLATION, executionDeps, type ExecutionSources, type TaskWorkspace, type WorkspaceRef } from '../runner/execution.ts';
import type { ChangeManifest, ManifestChange } from '../core/run-audit.ts';
import type { InvocationResult } from '../agents/contract.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0');
const RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 1, revision: 1, summary: 'Two items', questions: [], items: [
  { id: 'P1', title: 'First', intent: 'Change a', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'x' }], acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] },
  { id: 'P2', title: 'Second', intent: 'Change b', files: [{ path: 'b.ts', kind: 'edit', renamed_from: null, change: 'y' }], acceptance: [{ type: 'check', text: 'b reads well' }], depends_on: ['P1'] },
] };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.ts', kind: 'file' }, { path: 'b.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [['npm', 'test']] };
const dirs: string[] = [], cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const change = (path: string, over: Partial<ManifestChange> = {}): ManifestChange => ({ path, kind: 'modify', oldType: 'file', newType: 'file', underGit: false, ...over });
const manifest = (changes: ManifestChange[], over: Partial<ChangeManifest> = {}): ChangeManifest & { digest: string } =>
  ({ changes, agentCommits: [], metadataChanged: false, linkTargetChanges: [], nestedGitlinkContent: [], digest: `digest-${changes.length}`, ...over });

function setup(options: { manifests?: Record<string, ChangeManifest & { digest: string }>; exit?: Record<string, Partial<InvocationResult>>;
  commit?: (item: string) => Promise<void>; release?: () => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-exec-')); dirs.push(dir);
  const store = new Store(join(dir, 'state.sqlite'));
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const log: string[] = [], commits: { item: string; baseHead: string; paths: readonly string[]; trailers: Record<string, string>; digest: string; message: string }[] = [];
  let next = 100;
  const itemOf = (ws: WorkspaceRef) => (ws.storage as { item: string }).item;
  const workspace: TaskWorkspace = {
    async materialize(attempt, head) { log.push(`materialize ${attempt.item} @${head.slice(-3)}`); return { clone: { id: `c-${attempt.id}`, taskId: 'task', directory: '/tmp/x', head }, storage: { item: attempt.item, attemptId: attempt.id } }; },
    async snapshotDeclaredLinks(ws, paths) { log.push(`snapshot ${itemOf(ws)} [${paths.join(',')}]`); return { item: itemOf(ws) }; },
    async inspectChanges(ws, input) { log.push(`inspect ${itemOf(ws)} @${input.baseHead.slice(-3)}`); return options.manifests?.[itemOf(ws)] ?? manifest([change(itemOf(ws) === 'P1' ? 'a.ts' : 'b.ts')]); },
    async commit(ws, input) {
      await options.commit?.(itemOf(ws));
      const head = oid(next++); commits.push({ item: itemOf(ws), baseHead: input.baseHead, paths: input.paths, trailers: { ...input.trailers }, digest: input.digest, message: input.message });
      log.push(`commit ${itemOf(ws)} -> ${head.slice(-3)}`); return head;
    },
    async release(ws) {
      const attemptId = (ws.storage as { attemptId: string }).attemptId;
      log.push(`release ${itemOf(ws)} after ${store.getAttempt(identity, attemptId).state}`);
      await options.release?.();
    },
  };
  const sources: ExecutionSources = { planContext: () => context, issue: () => ({ number: 1, title: 'Issue', body: 'Please fix', comments: [] }), lessons: () => [], vendor: () => 'claude' };
  const prompts: string[] = [], argv: (readonly (readonly string[])[])[] = [], owners: string[] = [];
  const deps = executionDeps(store, workspace, (input, prompt, ws) => {
    log.push(`start ${itemOf(ws)}`); prompts.push(prompt); argv.push(input.approvedArgv); owners.push(input.runnerOwner);
    return { attemptId: input.attemptId, settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: 'done', stderr: '', ...options.exit?.[itemOf(ws)] }), cancel: () => undefined };
  }, sources, RUNNER_OWNER);
  const runner = new RunnerCoordinator(store, deps);
  cleanups.push(async () => { await runner.close(); store.close(); });
  return { store, runner, executor: new ItemExecutor(store, runner, sources), log, commits, prompts, argv, owners };
}

describe('item execution', () => {
  it('runs items in order, commits each with trailers, and records owned ledger entries', async () => {
    const { store, executor, log, commits, prompts, argv, owners } = setup();
    expect(await executor.runTask(identity)).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: [] });
    expect(commits.map(c => [c.item, c.baseHead.slice(-3), c.trailers, c.paths, c.message])).toEqual([
      ['P1', '002', { 'Plan-Item': 'P1', 'Plan-Revision': 'r1' }, ['a.ts'], 'P1: First'],
      ['P2', '064', { 'Plan-Item': 'P2', 'Plan-Revision': 'r1' }, ['b.ts'], 'P2: Second']]);
    expect(store.getLedger(identity)).toEqual(expect.arrayContaining([
      { sha: oid(100), owner: 'P1', origin: 'owned', sourceSha: null }, { sha: oid(101), owner: 'P2', origin: 'owned', sourceSha: null }]));
    expect(store.getSnapshot(identity).head).toBe(oid(101));
    expect(log).toEqual([
      'materialize P1 @002', 'snapshot P1 []', 'start P1', 'inspect P1 @002', 'commit P1 -> 064', 'release P1 after completed',
      'materialize P2 @064', 'snapshot P2 []', 'start P2', 'inspect P2 @064', 'commit P2 -> 065', 'release P2 after completed']);
    expect(prompts[0]).toContain('<plan_item_data>');
    expect(argv[0]).toEqual([['npm', 'test']]);
    expect(owners[0]).toBe(RUNNER_OWNER);
    expect(argv[1]).toEqual([]);
  });
  it('reports a planned-but-unchanged item without committing', async () => {
    const { executor, commits } = setup({ manifests: { P1: manifest([]) } });
    expect(await executor.runTask(identity)).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: ['P1'] });
    expect(commits.map(c => c.item)).toEqual(['P2']);
  });
  it('commits out-of-scope files with the item, records a checkpoint, and pauses in needs amendment', async () => {
    const { store, executor, commits, log } = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const outcome = await executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'] });
    expect(commits[0]!.paths).toEqual(['a.ts', 'extra.ts']);
    expect(store.getCheckpoint(identity, (outcome as { checkpointId: string }).checkpointId)).toMatchObject({ item: 'P1', completedItems: ['P1'], outOfScopePaths: ['extra.ts'] });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(log.some(line => line.includes('P2'))).toBe(false);
  });
  it('stops a safety violation before any commit, fails the attempt, and moves the task to needs human', async () => {
    const { store, executor, commits, log } = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) } });
    const outcome = await executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect((outcome as { reason: string }).reason.startsWith(SAFETY_VIOLATION)).toBe(true);
    expect(commits).toEqual([]);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getLedger(identity).some(entry => entry.owner === 'P1')).toBe(false);
    expect(log).toContain('release P1 after failed');
  });
  it('stops on an agent failure without inspecting or committing', async () => {
    const { store, executor, log } = setup({ exit: { P1: { exitCode: 1, stderr: 'agent crashed' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'agent crashed' });
    expect(log.some(line => line.startsWith('inspect'))).toBe(false);
    expect(store.getSnapshot(identity).head).toBe(oid(2));
  });
  it('records no ledger entry when the commit is refused', async () => {
    const { store, executor } = setup({ commit: async () => { throw new Error('work tree changed after the audit'); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'Invalid output: work tree changed after the audit' });
    expect(store.getLedger(identity)).toEqual([]);
  });
  it('discards the commit when a stop lands while the commit runs', async () => {
    let executorRunner!: RunnerCoordinator;
    const { store, runner, executor } = setup({ commit: async () => { executorRunner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled'); } });
    executorRunner = runner;
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(store.getLedger(identity)).toEqual([]);
    expect(store.getSnapshot(identity).head).toBe(oid(2));
  });
  it('holds the slot under a marker when task storage cannot be released', async () => {
    const { runner, executor } = setup({ release: async () => { throw new Error('docker down'); } });
    await expect(executor.runTask(identity)).rejects.toThrow(/Needs restart/);
    expect(runner.status(identity).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SAFETY_VIOLATION, SafetyFindings, executionDeps, type ExecutionSources, type TaskWorkspace, type WorkspaceRef } from '../runner/execution.ts';
import { ShuttingDownError, type ShutdownCapability } from '../runner/lifecycle.ts';
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
  commit?: (item: string) => Promise<void>; release?: () => Promise<void>; startError?: Error;
  inspect?: (item: string, signal: AbortSignal) => Promise<void>; snapshotError?: Error; capability?: (store: Store) => ShutdownCapability; settleError?: boolean;
  plan?: Plan; commitHead?: string; pathKeyError?: Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-exec-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite'), store = new Store(path);
  store.createPlan(JSON.stringify(options.plan ?? plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const log: string[] = [], commits: { item: string; baseHead: string; paths: readonly string[]; trailers: Record<string, string>; digest: string; message: string }[] = [];
  let next = 100;
  const itemOf = (ws: WorkspaceRef) => (ws.storage as { item: string }).item;
  const workspace: TaskWorkspace = {
    async materialize(attempt, head) { log.push(`materialize ${attempt.item} @${head.slice(-3)}`); return { clone: { id: `c-${attempt.id}`, taskId: 'task', directory: '/tmp/x', head }, storage: { item: attempt.item, attemptId: attempt.id } }; },
    async snapshotDeclaredLinks(ws, paths) { log.push(`snapshot ${itemOf(ws)} [${paths.join(',')}]`); if (options.snapshotError) throw options.snapshotError; return { item: itemOf(ws) }; },
    async inspectChanges(ws, input, signal) {
      log.push(`inspect ${itemOf(ws)} @${input.baseHead.slice(-3)}`); await options.inspect?.(itemOf(ws), signal);
      return options.manifests?.[itemOf(ws)] ?? manifest([change(itemOf(ws) === 'P1' ? 'a.ts' : 'b.ts')]);
    },
    async commit(ws, input) {
      await options.commit?.(itemOf(ws));
      const head = options.commitHead ?? oid(next++); commits.push({ item: itemOf(ws), baseHead: input.baseHead, paths: input.paths, trailers: { ...input.trailers }, digest: input.digest, message: input.message });
      log.push(`commit ${itemOf(ws)} -> ${head.slice(-3)}`); return head;
    },
    async release(ws) {
      const attemptId = (ws.storage as { attemptId: string }).attemptId;
      log.push(`release ${itemOf(ws)} after ${store.getAttempt(identity, attemptId).state}`);
      await options.release?.();
    },
  };
  const auditContext: PlanContext = options.pathKeyError ? { ...context, pathKey: () => { throw options.pathKeyError; } } : context;
  const sources: ExecutionSources = { planContext: () => auditContext, issue: () => ({ number: 1, title: 'Issue', body: 'Please fix', comments: [] }), lessons: () => [], vendor: () => 'claude' };
  const prompts: string[] = [], argv: (readonly (readonly string[])[])[] = [], owners: string[] = [];
  const findings = new SafetyFindings(), capability = options.capability?.(store);
  if (options.settleError) store.settleAttempt = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
  const deps = executionDeps(store, workspace, (input, prompt, ws) => {
    if (options.startError) throw options.startError;
    log.push(`start ${itemOf(ws)}`); prompts.push(prompt); argv.push(input.approvedArgv); owners.push(input.runnerOwner);
    return { attemptId: input.attemptId, settled: Promise.resolve({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: 'done', stderr: '', ...options.exit?.[itemOf(ws)] }), cancel: () => undefined };
  }, sources, RUNNER_OWNER, findings);
  const runner = new RunnerCoordinator(store, deps, undefined, capability);
  cleanups.push(async () => { await runner.close(); store.close(); });
  return { store, path, runner, executor: new ItemExecutor(store, runner, sources, findings, { capability }), log, commits, prompts, argv, owners };
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
      'materialize P1 @002', 'snapshot P1 [a.ts]', 'start P1', 'inspect P1 @002', 'commit P1 -> 064', 'release P1 after completed',
      'materialize P2 @064', 'snapshot P2 [b.ts]', 'start P2', 'inspect P2 @064', 'commit P2 -> 065', 'release P2 after completed']);
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
  it('holds the slot under a storage marker when task storage cannot be released, and stops the run with the items done', async () => {
    const { runner, executor } = setup({ release: async () => { throw new Error('docker down'); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started',
      reason: 'Needs restart: the last attempt\'s task storage could not be removed.', completed: ['P1'] });
    expect(runner.status(identity).unresolved).toMatchObject({ reason: 'storage-not-removed' });
  });
  it('never removes task storage when the terminal write fails, and reports the unsaved result', async () => {
    const { runner, executor, log } = setup({ settleError: true });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'running', completed: [] });
    expect(log.some(line => line.startsWith('release'))).toBe(false);
    expect(runner.status(identity).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
  it('releases task storage after the terminal write when D settles with another attempt\'s result', async () => {
    const { store, executor, log } = setup({ exit: { P1: { attemptId: '00000000-0000-4000-8000-000000000000' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed' });
    expect(log.some(line => line.startsWith('inspect'))).toBe(false);
    expect(log).toContain('release P1 after failed');
    expect(store.getSnapshot(identity).head).toBe(oid(2));
  });
  it('releases task storage after the terminal write when D\'s start call throws', async () => {
    const { executor, log } = setup({ startError: new Error('docker refused') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'Launch failed: docker refused' });
    expect(log).toContain('release P1 after failed');
  });
  it('does not take the agent\'s stderr for a safety violation', async () => {
    const { store, executor } = setup({ exit: { P1: { exitCode: 1, stderr: `${SAFETY_VIOLATION} fake` } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed' });
    expect(store.getTask(identity).status).toBe('running');
  });
  it('sends the task to needs human when the change inspection refuses', async () => {
    const { store, executor, commits, log } = setup({ inspect: async () => { throw new Error('manifest digest mismatch'); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: `${SAFETY_VIOLATION} The change inspection refused: manifest digest mismatch` });
    expect(commits).toEqual([]);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(log).toContain('release P1 after failed');
  });
  it('keeps a safety violation when the context goes stale during the audit', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      inspect: async () => { store.setAssignment(identity, store.getTask(identity).stateVersion, 'reassigned', 'hash-2'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('removes task storage after the terminal write when preparation fails after allocating it', async () => {
    const { store, runner, executor, log } = setup({ snapshotError: new Error('declared link goes through a link') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'Preparation failed: declared link goes through a link' });
    expect(log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'release P1 after failed']);
    expect(runner.status(identity).unresolved).toBeNull();
    expect(store.getTask(identity).status).toBe('running');
  });
  it('stops before the next item when the plan gets a new revision during the run', async () => {
    let store!: Store;
    const h = setup({ release: async () => {
      if (store.getPlan(identity).revision !== 1) return;
      const revised = { ...plan, revision: 2, items: plan.items.map(entry => entry.id === 'P2' ? { ...entry, title: 'Second CHANGED' } : entry) };
      store.importRevision(JSON.stringify(revised), 'json', context, 1);
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'] });
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('still pauses for amendment, bound to where the item ran, when the plan changes after its attempt settled', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => {
      if (store.getPlan(identity).revision === 1) store.importRevision(JSON.stringify({ ...plan, revision: 2, summary: 'Revised' }), 'json', context, 1);
    } });
    store = h.store;
    const outcome = await h.executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'], completed: ['P1'] });
    expect(store.getCheckpoint(identity, (outcome as { checkpointId: string }).checkpointId)).toMatchObject({
      revision: 1, snapshotId: store.snapshotWithHead(identity, oid(100)) });
    expect(store.getTask(identity).status).toBe('needs amendment');
    // The finding is not skipped by resuming at the next item.
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started' });
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('returns a stopped outcome, with no checkpoint, when the task closed before it could pause for amendment', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => {
      store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    } });
    store = h.store;
    const outcome = await h.executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'stopped', item: 'P1', completed: ['P1'] });
    expect(store.getTask(identity).status).toBe('cancelled');
    // The refused pause recorded no checkpoint either (one transaction).
    const db = new DatabaseSync(h.path);
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toEqual({ n: 0 }); } finally { db.close(); }
  });
  it('pauses for amendment through the capability after the shutdown write gate closed', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
      capability: s => s.shutdownCapability(), release: async () => { store.closeWrites(); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs amendment', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs amendment');
  });
  it('stages both paths of a rename in the runner commit', async () => {
    const { executor, commits } = setup({ manifests: { P1: manifest([change('a.ts', { kind: 'rename', oldPath: 'old.ts' })]) } });
    await executor.runTask(identity);
    expect(commits[0]!.paths).toEqual(['a.ts', 'old.ts']);
  });
  it('treats an inspection aborted by a stop as that stop, not a finding', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup({ inspect: async (_item, signal) => {
      runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled');
      throw signal.reason;
    } });
    runner = h.runner; store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(store.getTask(identity).status).toBe('running');
    expect(h.commits).toEqual([]);
  });
  it('keeps a real inspection refusal as a finding even when a stop is pending', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup({ inspect: async () => {
      runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled');
      throw new Error('metadata digest changed');
    } });
    runner = h.runner; store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: `${SAFETY_VIOLATION} The change inspection refused: metadata digest changed` });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('makes no commit when a stop lands during an inspection that ignores the abort', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup({ inspect: async () => { runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled'); } });
    runner = h.runner; store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(h.commits).toEqual([]);
  });
  it('sends a malformed change report to needs human', async () => {
    const { store, executor, commits } = setup({ manifests: { P1: manifest([change('a.ts')], { linkTargetChanges: undefined as unknown as string[] }) } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(commits).toEqual([]);
  });
  it('makes no commit when the context changes during the audit', async () => {
    let store!: Store;
    const h = setup({ inspect: async () => { store.setAssignment(identity, store.getTask(identity).stateVersion, 'reassigned', 'hash-2'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'stale' });
    expect(h.commits).toEqual([]);
  });
  it('pauses first on the next run when a scope pause was never recorded, and never runs past it', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const pause = h.store.pauseForAmendment.bind(h.store);
    let fail = true;
    h.store.pauseForAmendment = (...args) => { if (fail) { fail = false; throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } return pause(...args); };
    await expect(h.executor.runTask(identity)).rejects.toThrow(/disk full/);
    expect(h.store.getTask(identity).status).toBe('running');
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'] });
    expect(h.store.getTask(identity).status).toBe('needs amendment');
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('does not take a closed write gate for a refused pause when it has no capability', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => { store.closeWrites(); } });
    store = h.store;
    await expect(h.executor.runTask(identity)).rejects.toBeInstanceOf(ShuttingDownError);
  });
  it('stops before the next item when the assignment changes during the run', async () => {
    let store!: Store;
    const h = setup({ release: async () => {
      if (store.getTask(identity).currentAttemptId && store.getAttempts(identity).length === 1)
        store.setAssignment(identity, store.getTask(identity).stateVersion, 'reassigned', 'hash-2');
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'] });
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('stops before the next item, and binds a pause to the item\'s own commit, when HEAD is observed during the run', async () => {
    let store!: Store;
    const observe = () => { const snapshot = store.getSnapshot(identity); store.recordHistory(identity, { revision: 1, snapshotId: snapshot.id }, snapshot.base, oid(999), []); };
    const clean = setup({ release: async () => { if (store.getAttempts(identity).length === 1) observe(); } });
    store = clean.store;
    expect(await clean.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started' });
    const scoped = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => observe() });
    store = scoped.store;
    const outcome = await scoped.executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P1' });
    const checkpoint = store.getCheckpoint(identity, (outcome as { checkpointId: string }).checkpointId);
    expect(checkpoint.snapshotId).toBe(store.snapshotWithHead(identity, oid(100)));
    expect(checkpoint.snapshotId).not.toBe(store.getSnapshot(identity).id);
  });
  it('fails the attempt, instead of breaking the terminal write, when the workspace returns an invalid commit ID', async () => {
    const { runner, executor, log } = setup({ commitHead: 'HEAD' });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'The workspace returned an invalid commit ID; nothing was published.' });
    expect(runner.status(identity).unresolved).toBeNull();
    expect(log).toContain('release P1 after failed');
  });
  it('keeps a status someone set during release instead of pausing or escalating over it', async () => {
    let store!: Store;
    const toApproval = async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); };
    const scoped = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: toApproval });
    store = scoped.store;
    expect(await scoped.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs approval');
    const unsafe = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, release: toApproval });
    store = unsafe.store;
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs approval');
  });
  it('treats an audit that throws as a safety violation', async () => {
    const { store, executor, commits } = setup({ pathKeyError: new Error('Non-ASCII case-insensitive paths require an adapter.') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: `${SAFETY_VIOLATION} The change report could not be audited: Non-ASCII case-insensitive paths require an adapter.` });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(commits).toEqual([]);
  });
  it('snapshots both sides of a declared rename before launch', async () => {
    const renamed: Plan = { ...plan, items: [{ ...plan.items[0]!, files: [{ path: 'c.ts', kind: 'rename', renamed_from: 'a.ts', change: 'move' }] }, plan.items[1]!] };
    const h = setup({ plan: renamed, manifests: { P1: manifest([change('c.ts', { kind: 'rename', oldPath: 'a.ts' })]) } });
    await h.executor.runTask(identity);
    expect(h.log).toContain('snapshot P1 [c.ts,a.ts]');
  });
  it('pays a pause owed from an earlier run when the task is queued again, instead of getting stuck', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'] });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('holds a recorded pause until a person approves continuing on an amended plan, then runs only the next item', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const paused = await h.executor.runTask(identity);
    expect(paused).toMatchObject({ kind: 'needs amendment', item: 'P1' });
    const store = h.store;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject({ kind: 'stopped', state: 'not started', reason: expect.stringMatching(/approve continuing/) });
    const amended = { ...plan, revision: 2, items: [{ ...plan.items[0]!, files: [...plan.items[0]!.files, { path: 'extra.ts', kind: 'add', renamed_from: null, change: 'z' }] }, plan.items[1]!] };
    store.importRevision(JSON.stringify(amended), 'json', { ...context, baseEntries: context.baseEntries }, 1);
    store.approveContinuation(identity, (paused as { checkpointId: string }).checkpointId, { revision: 2, snapshotId: store.getSnapshot(identity).id });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'not started', reason: expect.stringMatching(/name the next item/) });
    expect(await h.executor.runTask(identity, { fromItem: 'P1' })).toMatchObject({ kind: 'stopped', state: 'not started' });
    // A later snapshot with the same head does not make the approved pause owed again.
    const snapshot = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: 2, snapshotId: snapshot.id }, snapshot.base, snapshot.head, []);
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toEqual({ kind: 'executed', items: ['P2'], unchanged: [] });
    expect(h.commits.map(c => c.item)).toEqual(['P1', 'P2']);
  });
  it('fails the attempt when the workspace makes no new commit for a changed item', async () => {
    const { store, executor } = setup({ commitHead: oid(2) });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'The workspace made no new commit for a changed item; nothing was published.' });
    expect(store.getLedger(identity).some(entry => entry.owner === 'P1')).toBe(false);
  });
  it('names the real cause when the start of an attempt could not be saved', async () => {
    const h = setup();
    h.store.markRunning = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'pending', reason: 'Needs restart: the start of the last attempt could not be saved.' });
  });
  it('stops before the next item when only the referenced code changes during the run', async () => {
    let store!: Store;
    const h = setup({ release: async () => {
      if (store.getAttempts(identity).length !== 1) return;
      store.setAssignment(identity, store.getTask(identity).stateVersion, store.currentContext(identity).assignmentId, 'new-code-hash');
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'] });
  });
  it('treats an AbortError from the inspection as the stop', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup({ inspect: async () => {
      runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled');
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    } });
    runner = h.runner; store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(store.getTask(identity).status).toBe('running');
  });
});

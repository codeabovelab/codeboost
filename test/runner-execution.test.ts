import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SAFETY_VIOLATION, SafetyFindings, executionDeps, type ExecutionSources, type TaskWorkspace, type WorkspaceRef } from '../runner/execution.ts';
import { MAX_REASON, ShuttingDownError, type ShutdownCapability } from '../runner/lifecycle.ts';
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
  plan?: Plan; commitHead?: string; pathKeyError?: Error; materializeError?: Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-exec-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite'), store = new Store(path);
  store.createPlan(JSON.stringify(options.plan ?? plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const log: string[] = [], commits: { item: string; baseHead: string; paths: readonly string[]; trailers: Record<string, string>; digest: string; message: string }[] = [];
  let next = 100;
  const itemOf = (ws: WorkspaceRef) => (ws.storage as { item: string }).item;
  const workspace: TaskWorkspace = {
    async materialize(attempt, head) { log.push(`materialize ${attempt.item} @${head.slice(-3)}`); if (options.materializeError) throw options.materializeError; return { clone: { id: `c-${attempt.id}`, taskId: 'task', directory: '/tmp/x', head }, storage: { item: attempt.item, attemptId: attempt.id } }; },
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
  return { store, path, workspace, findings, runner, executor: new ItemExecutor(store, runner, sources, findings, { capability }), log, commits, prompts, argv, owners };
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
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: '"agent crashed"' });
    expect(log.some(line => line.startsWith('inspect'))).toBe(false);
    expect(store.getSnapshot(identity).head).toBe(oid(2));
  });
  it('records no ledger entry when the commit is refused', async () => {
    const { store, executor } = setup({ commit: async () => { throw new Error('work tree changed after the audit'); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'The runner commit was refused: "work tree changed after the audit"' });
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
      reason: `${SAFETY_VIOLATION} The change inspection refused: "manifest digest mismatch"` });
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
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'Preparation failed: "declared link goes through a link"' });
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
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'], reason: expect.stringMatching(/new revision/) });
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
    expect(h.runner.status(identity).unresolved).toBeNull();
  });
  it('still pauses for amendment, bound to where the item ran, when the plan changes after its attempt settled', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => {
      if (store.getPlan(identity).revision === 1) store.importRevision(JSON.stringify({ ...plan, revision: 2, summary: 'Revised' }), 'json', context, 1);
    } });
    store = h.store;
    const outcome = await h.executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'], completed: ['P1'] });
    // The revision really changed during release (a failed import there would be absorbed as a storage failure).
    expect(store.getPlan(identity).revision).toBe(2);
    expect(h.runner.status(identity).unresolved).toBeNull();
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
      reason: `${SAFETY_VIOLATION} The change inspection refused: "metadata digest changed"` });
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
    expect(h.runner.status(identity).unresolved).toBeNull();
  });
  it('stops before the next item, and binds a pause to the item\'s own commit, when HEAD is observed during the run', async () => {
    let store!: Store;
    const observe = () => { const snapshot = store.getSnapshot(identity); store.recordHistory(identity, { revision: 1, snapshotId: snapshot.id }, snapshot.base, oid(999), []); };
    const clean = setup({ release: async () => { if (store.getAttempts(identity).length === 1) observe(); } });
    store = clean.store;
    expect(await clean.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', reason: expect.stringMatching(/snapshot or assignment changed/) });
    expect(clean.runner.status(identity).unresolved).toBeNull();
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
  it('keeps a human gate set during release, and escalates a safety violation owed from it when the task next runs', async () => {
    let store!: Store;
    const toApproval = async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); };
    const scoped = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: toApproval });
    store = scoped.store;
    expect(await scoped.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs approval');
    const unsafe = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, release: toApproval });
    store = unsafe.store;
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/needs approval; it moves to needs human when it next runs/) });
    expect(store.getTask(identity).status).toBe('needs approval');
    // A person releases the gate; the owed finding goes to needs human before any item runs again.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('treats an audit that throws as a safety violation', async () => {
    const { store, executor, commits } = setup({ pathKeyError: new Error('Non-ASCII case-insensitive paths require an adapter.') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: `${SAFETY_VIOLATION} The change report could not be audited: "Non-ASCII case-insensitive paths require an adapter."` });
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
  it('runs no further items once a task has a scope checkpoint, even after an approved continuation (not supported yet)', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const paused = await h.executor.runTask(identity);
    expect(paused).toMatchObject({ kind: 'needs amendment', item: 'P1' });
    const store = h.store;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const refused = { kind: 'stopped', state: 'not started', reason: expect.stringMatching(/Continuing after a scope pause is not supported yet/) };
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject(refused);
    const amended = { ...plan, revision: 2, items: [{ ...plan.items[0]!, files: [...plan.items[0]!.files, { path: 'extra.ts', kind: 'add', renamed_from: null, change: 'z' }] }, plan.items[1]!] };
    store.importRevision(JSON.stringify(amended), 'json', context, 1);
    store.approveContinuation(identity, (paused as { checkpointId: string }).checkpointId, { revision: 2, snapshotId: store.getSnapshot(identity).id });
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject(refused);
    // A later snapshot with the same head does not make the recorded pause owed again.
    const snapshot = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: 2, snapshotId: snapshot.id }, snapshot.base, snapshot.head, []);
    expect(await h.executor.runTask(identity, { fromItem: 'P2' })).toMatchObject(refused);
    expect(store.getTask(identity).status).toBe('queued');
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
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
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'], reason: expect.stringMatching(/snapshot or assignment changed/) });
    expect(h.runner.status(identity).unresolved).toBeNull();
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
  it('keeps a queued status set during release instead of pausing, but escalates a safety violation so the item is not re-run', async () => {
    let store!: Store;
    const toQueued = async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued'); };
    const scoped = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: toQueued });
    store = scoped.store;
    expect(await scoped.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(store.getTask(identity).status).toBe('queued');
    const unsafe = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, release: toQueued });
    store = unsafe.store;
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'not started' });
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('keeps task storage when a foreign result\'s terminal write fails', async () => {
    const { runner, executor, log } = setup({ settleError: true, exit: { P1: { attemptId: '00000000-0000-4000-8000-000000000000' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'running' });
    expect(log.some(line => line.startsWith('release'))).toBe(false);
    expect(runner.status(identity).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
  it('leaves a safety violation\'s task alone when it was cancelled during release', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID()); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/is cancelled, so it was not moved/) });
    expect(store.getTask(identity).status).toBe('cancelled');
  });
  it('removes task storage after the terminal write when a stop lands during preparation', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup();
    runner = h.runner; store = h.store;
    const snapshot = h.workspace.snapshotDeclaredLinks.bind(h.workspace);
    h.workspace.snapshotDeclaredLinks = async (ws, paths, signal) => { runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled'); return snapshot(ws, paths, signal); };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'release P1 after cancelled']);
  });
  it('removes task storage after the terminal write when the context goes stale before launch', async () => {
    let store!: Store;
    const h = setup();
    store = h.store;
    const snapshot = h.workspace.snapshotDeclaredLinks.bind(h.workspace);
    h.workspace.snapshotDeclaredLinks = async (ws, paths, signal) => {
      store.setAssignment(identity, store.getTask(identity).stateVersion, 'reassigned', 'hash-2'); return snapshot(ws, paths, signal);
    };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'stale' });
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'release P1 after stale']);
  });
  it('refuses a scope pause whose executed prefix does not match the plan at the item\'s revision', () => {
    const { store } = setup();
    const snapshotId = store.getSnapshot(identity).id;
    expect(() => store.pauseForAmendment(identity, { revision: 1, snapshotId }, { item: 'P2', baseEntries: [], completedItems: ['P2'], outOfScopePaths: ['x'] }))
      .toThrow(/executed plan prefix/);
    expect(() => store.pauseForAmendment(identity, { revision: 1, snapshotId }, { item: 'P1', baseEntries: [], completedItems: ['P1', 'P2'], outOfScopePaths: ['x'] }))
      .toThrow(/executed plan prefix/);
  });
  it('bounds a finding whose text comes from the workspace', async () => {
    const { executor } = setup({ inspect: async () => { throw new Error('x'.repeat(10_000)); } });
    const outcome = await executor.runTask(identity) as { kind: string; reason: string };
    expect(outcome.kind).toBe('needs human');
    expect(outcome.reason.length).toBeLessThanOrEqual(MAX_REASON);
  });
  it('removes task storage after the terminal write when a cancel task lands on the row during preparation', async () => {
    let store!: Store;
    const h = setup();
    store = h.store;
    const snapshot = h.workspace.snapshotDeclaredLinks.bind(h.workspace);
    h.workspace.snapshotDeclaredLinks = async (ws, paths, signal) => {
      store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID()); return snapshot(ws, paths, signal);
    };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'release P1 after cancelled']);
    expect(store.getTask(identity).status).toBe('cancelled');
  });
  it('keeps a safety finding owed when moving to needs human fails, and escalates it before the next run launches anything', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) } });
    const transition = h.store.transitionTask.bind(h.store);
    let fail = true;
    h.store.transitionTask = (...args) => { if (fail && args[2] === 'needs human') { fail = false; throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); } return transition(...args); };
    await expect(h.executor.runTask(identity)).rejects.toThrow(/disk full/);
    expect(h.store.getTask(identity).status).toBe('running');
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.store.getAttempts(identity)).toHaveLength(1);
  });
  it('stops before the next item when someone changes the status during release', async () => {
    let store!: Store;
    const h = setup({ release: async () => { if (store.getAttempts(identity).length === 1) store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', reason: expect.stringMatching(/changed to queued/) });
    expect(h.commits.map(c => c.item)).toEqual(['P1']);
  });
  it('refuses an owed pause from a human gate, and validates the prefix against the item\'s own revision', () => {
    const { store } = setup();
    const snapshotId = store.getSnapshot(identity).id;
    // Revision 2 drops P2; the prefix [P1, P2] is still right for revision 1, where the item ran.
    store.importRevision(JSON.stringify({ ...plan, revision: 2, items: [plan.items[0]!] }), 'json', context, 1);
    const evidence = { item: 'P2', baseEntries: [], completedItems: ['P1', 'P2'], outOfScopePaths: ['x'] };
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval');
    expect(() => store.pauseForAmendment(identity, { revision: 1, snapshotId }, evidence, { owed: true })).toThrow(/is needs approval/);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(store.pauseForAmendment(identity, { revision: 1, snapshotId }, evidence, { owed: true })).toMatchObject({ revision: 1, completedItems: ['P1', 'P2'] });
  });
  it('escalates a safety violation over a review status, so the task cannot be merged past it', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('settles a finding whose task is already needs human, so it is not escalated again later', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { if (store.getAttempts(identity).length === 1) store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.findings.get(store.getAttempts(identity)[0]!.id)).toBeUndefined();
  });
  it('keeps a finding owed when a merge in progress refuses the escalation, and escalates it on the next run', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, release: async () => {
      store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review');
      const snapshot = store.getSnapshot(identity);
      store.beginMergeAttempt(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, snapshot.head, null, 'direct');
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/could not be moved to needs human yet: A merge is in progress/) });
    const attemptId = store.getAttempts(identity)[0]!.id;
    expect(h.findings.get(attemptId)).toBeDefined();
    store.finishMergeAttempt(identity, store.getMergeAttempt(identity)!.id, { state: 'failed', reason: 'GitHub refused.' });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.findings.get(attemptId)).toBeUndefined();
  });
  it('escalates through the capability after the shutdown write gate closed', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, capability: s => s.shutdownCapability(),
      release: async () => { store.closeWrites(); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('settles an owed finding when the task was closed before its next run', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    const attemptId = store.getAttempts(identity)[0]!.id;
    expect(h.findings.get(attemptId)).toBeDefined();
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/is cancelled/) });
    expect(h.findings.get(attemptId)).toBeUndefined();
  });
  it('records completed and the ledger entry in one transaction: a failed history write leaves neither', async () => {
    const h = setup();
    h.store.recordHistory = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'running' });
    expect(h.store.getLedger(identity)).toEqual([]);
    expect(h.runner.status(identity).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
  it('pauses for amendment over a review status set during release, so a merge cannot go past the finding', async () => {
    for (const status of ['in review', 'approved but merge blocked'] as const) {
      let store!: Store;
      const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
        release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, status); } });
      store = h.store;
      expect(await h.executor.runTask(identity), status).toMatchObject({ kind: 'needs amendment', item: 'P1' });
      expect(store.getTask(identity).status, status).toBe('needs amendment');
    }
  });
  it('escalates a safety violation over approved but merge blocked too', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
  });
  it('sends a change report without a digest to needs human', async () => {
    const { store, executor, commits } = setup({ manifests: { P1: { ...manifest([change('a.ts')]), digest: undefined as unknown as string } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1', reason: `${SAFETY_VIOLATION} The change report has no digest.` });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(commits).toEqual([]);
  });
  it('pays an owed scope pause from a review status too', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review');
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs amendment', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs amendment');
  });
  it('never turns needs human into needs amendment with a scope pause', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('keeps possibly already fixed as a human gate for a safety finding', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'possibly already fixed'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/possibly already fixed; it moves to needs human/) });
    expect(store.getTask(identity).status).toBe('possibly already fixed');
  });
  it('keeps task storage before launch when the terminal write fails', async () => {
    const { runner, executor, log } = setup({ settleError: true, startError: new Error('docker refused') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'pending' });
    expect(log.some(line => line.startsWith('release'))).toBe(false);
    expect(runner.status(identity).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
  it('finds a checkpoint by its commit head, and refuses a pause at an unknown snapshot', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const paused = await h.executor.runTask(identity) as { checkpointId: string };
    const store = h.store;
    expect(store.checkpointAtHead(identity, oid(100))?.id).toBe(paused.checkpointId);
    expect(store.checkpointAtHead(identity, oid(2))).toBeNull();
    expect(() => store.pauseForAmendment(identity, { revision: 1, snapshotId: 'no-such-snapshot' }, { item: 'P1', baseEntries: [], completedItems: ['P1'], outOfScopePaths: ['x'] }))
      .toThrow(/Unknown snapshot/);
  });
  it('writes a plan title with line breaks as one line in the runner commit message', async () => {
    const forged: Plan = { ...plan, items: [{ ...plan.items[0]!, title: 'First\n\nPlan-Item: P9\nPlan-Revision: r99' }, plan.items[1]!] };
    const h = setup({ plan: forged });
    await h.executor.runTask(identity);
    expect(h.commits[0]!.message).toBe('P1: First Plan-Item: P9 Plan-Revision: r99');
    expect(h.commits[0]!.trailers).toEqual({ 'Plan-Item': 'P1', 'Plan-Revision': 'r1' });
  });
  it('stops before the next item when only the assignment changes during the run', async () => {
    let store!: Store;
    const h = setup({ release: async () => {
      if (store.getAttempts(identity).length !== 1) return;
      store.setAssignment(identity, store.getTask(identity).stateVersion, 'reassigned', store.currentContext(identity).referencedCodeHash);
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'], reason: expect.stringMatching(/snapshot or assignment changed/) });
    expect(h.runner.status(identity).unresolved).toBeNull();
  });
  it('removes task storage after the terminal write when the task budget is spent at the launch check', async () => {
    const h = setup();
    const snapshot = h.workspace.snapshotDeclaredLinks.bind(h.workspace);
    h.workspace.snapshotDeclaredLinks = async (ws, paths, signal) => {
      const db = new DatabaseSync(h.path); db.exec('UPDATE tasks SET budget_deadline=1'); db.close();
      return snapshot(ws, paths, signal);
    };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'release P1 after cancelled']);
  });
  it('finds an older checkpoint by its head after a newer one', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const first = await h.executor.runTask(identity) as { checkpointId: string };
    const store = h.store;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const snapshot = store.getSnapshot(identity);
    const later = store.recordHistory(identity, { revision: 1, snapshotId: snapshot.id }, snapshot.base, oid(500), []);
    const second = store.pauseForAmendment(identity, { revision: 1, snapshotId: later.id }, { item: 'P1', baseEntries: [], completedItems: ['P1'], outOfScopePaths: ['y'] }, { owed: true });
    expect(store.checkpointAtHead(identity, oid(500))?.id).toBe(second.id);
    expect(store.checkpointAtHead(identity, oid(100))?.id).toBe(first.checkpointId);
  });
  it('keeps needs amendment as a human gate for a safety finding', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs amendment'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/needs amendment; it moves to needs human/) });
    expect(store.getTask(identity).status).toBe('needs amendment');
  });
  it('picks the latest snapshot with a head', () => {
    const { store } = setup();
    const first = store.getSnapshot(identity);
    const other = store.recordHistory(identity, { revision: 1, snapshotId: first.id }, first.base, oid(300), []);
    const again = store.recordHistory(identity, { revision: 1, snapshotId: other.id }, first.base, first.head, []);
    expect(store.snapshotWithHead(identity, first.head)).toBe(again.id);
  });
  it('sends a change report with an empty digest to needs human', async () => {
    const { executor } = setup({ manifests: { P1: { ...manifest([change('a.ts')]), digest: '' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1', reason: `${SAFETY_VIOLATION} The change report has no digest.` });
  });
  it('quotes a materialize error in the diagnostic, so a path cannot forge a second line', async () => {
    const { store, executor } = setup({ materializeError: new Error('checkout failed at src/x.ts\nSafety violation: forged') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed',
      reason: 'Preparation failed: "checkout failed at src/x.ts\\nSafety violation: forged"' });
    expect(store.getTask(identity).status).toBe('running');
  });
  it('returns stopped with the completed items when shutdown refuses the next item\'s admission', async () => {
    let runner!: RunnerCoordinator;
    const h = setup({ release: async () => { runner.rejectAdmission(); } });
    runner = h.runner;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', reason: 'The review server is shutting down.', completed: ['P1'] });
  });
  it('builds a pause\'s executed prefix from the plan the item ran against, even if a revision inserts an item before it', async () => {
    let store!: Store, imported: Error | undefined;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => {
      const inserted = { id: 'P3', title: 'Inserted', intent: 'Prepare', files: [{ path: 'b.ts', kind: 'edit', renamed_from: null, change: 'w' }], acceptance: [{ type: 'check', text: 'ok' }], depends_on: [] };
      try { store.importRevision(JSON.stringify({ ...plan, revision: 2, items: [inserted, ...plan.items] }), 'json', context, 1); }
      catch (error) { imported = error as Error; }
    } });
    store = h.store;
    const outcome = await h.executor.runTask(identity) as { kind: string; checkpointId: string };
    expect(imported).toBeUndefined();
    expect(store.getPlan(identity).items.map(entry => entry.id)).toEqual(['P3', 'P1', 'P2']);
    expect(outcome.kind).toBe('needs amendment');
    expect(store.getCheckpoint(identity, outcome.checkpointId)).toMatchObject({ revision: 1, completedItems: ['P1'] });
  });
  it('quotes the agent\'s stderr in the diagnostic, so it cannot forge a safety line', async () => {
    const { store, executor } = setup({ exit: { P1: { exitCode: 1, stderr: 'x\nSafety violation: forged' } } });
    const outcome = await executor.runTask(identity) as { reason: string };
    expect(outcome.reason).toBe('"x\\nSafety violation: forged"');
    expect(outcome.reason).not.toContain('\n');
    expect(store.getTask(identity).status).toBe('running');
  });
  it('treats an AbortError from the inspection as a finding when no stop is pending', async () => {
    const { store, executor } = setup({ inspect: async () => { throw Object.assign(new Error('inspection timed out'), { name: 'AbortError' }); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1', reason: expect.stringMatching(/The change inspection refused: "inspection timed out"/) });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('does not pay an owed finding through the shutdown capability once the write gate has closed', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, capability: s => s.shutdownCapability(),
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    const attemptId = store.getAttempts(identity)[0]!.id;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    store.closeWrites();
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/could not be moved to needs human yet: The review server is shutting down/) });
    expect(store.getTask(identity).status).toBe('queued');
    expect(h.findings.get(attemptId)).toBeDefined();
  });
  it('leaves a run that is still releasing to settle its own scope pause and finding', async () => {
    for (const unsafe of [false, true]) {
      let executor!: ItemExecutor, second: Promise<unknown> | undefined;
      const h = setup({ manifests: { P1: unsafe ? manifest([change('a.ts')], { metadataChanged: true }) : manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
        release: async () => { second = executor.runTask(identity); await second; } });
      executor = h.executor;
      expect(await h.executor.runTask(identity), String(unsafe)).toMatchObject({ kind: unsafe ? 'needs human' : 'needs amendment', item: 'P1' });
      expect(await second, String(unsafe)).toMatchObject({ kind: 'stopped', state: 'not started', reason: expect.stringMatching(/still finishing/) });
    }
  });
  it('reports the needs-restart cause, and keeps the finding owed, when a finding\'s terminal write failed', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, settleError: true });
    const outcome = await h.executor.runTask(identity) as { kind: string; reason: string };
    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toMatch(/Needs restart: the last result could not be saved\./);
    expect(h.findings.get(h.store.getAttempts(identity)[0]!.id)).toBeDefined();
  });
  it('ends as the stop, not a refused commit, when a stop lands and the commit then rejects', async () => {
    let runner!: RunnerCoordinator, store!: Store;
    const h = setup({ commit: async () => {
      runner.stop(identity, store.getTask(identity).currentAttemptId!, 'cancelled');
      throw new Error('commit aborted');
    } });
    runner = h.runner; store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(store.getLedger(identity)).toEqual([]);
  });
});

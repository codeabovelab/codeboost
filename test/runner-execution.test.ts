import { GuardRefusal } from '../runner/lifecycle.ts';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SAFETY_VIOLATION, SafetyFindings, executionDeps, type ExecutionOutcome, type ExecutionSources, type TaskWorkspace, type WorkspaceRef } from '../runner/execution.ts';
import { MAX_REASON, ShuttingDownError, type ShutdownCapability } from '../runner/lifecycle.ts';
import type { ChangeManifest, ManifestChange } from '../core/run-audit.ts';
import type { InvocationResult } from '../agents/contract.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { TaskTreeRefused } from '../agents/container/changes.ts';

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
const change = (path: string, over: Partial<ManifestChange> = {}): ManifestChange => ({ path, kind: 'modify', oldType: 'file', newType: 'file', underGit: false, ignored: false, ...over });
const manifest = (changes: ManifestChange[], over: Partial<ChangeManifest & { digest: string }> = {}): ChangeManifest & { digest: string } =>
  ({ changes, agentCommits: [], metadataChanged: false, linkTargetChanges: [], nestedGitlinkContent: [], digest: `digest-${changes.length}`, ...over });

function setup(options: { manifests?: Record<string, ChangeManifest & { digest: string }>; exit?: Record<string, Partial<InvocationResult>>;
  commit?: (item: string) => Promise<void>; release?: () => Promise<void>; startError?: Error;
  inspect?: (item: string, signal: AbortSignal) => Promise<void>; snapshotError?: Error; checkError?: Error; capability?: (store: Store) => ShutdownCapability; settleError?: boolean;
  plan?: Plan; commitHead?: string; pathKeyError?: Error; materializeError?: Error; vendor?: 'claude' | 'codex';
  /** The durable save of a safety finding fails, so the executor must act on it from memory. */
  findingSaveError?: boolean;
  /** The workspace's partial-output export: bytes, or an error. */
  partial?: Buffer | Error | 'hang'; diagnosticsCap?: number; exportDeadlineMs?: number;
  /** Called by the fake launcher once the agent has started, before its result settles. */
  onLaunch?: (attemptId: string) => void;
  /** The fake agent's result names this attempt instead. */
  foreignResult?: boolean; issue?: ExecutionSources['issue'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-exec-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite'), store = new Store(path);
  store.createPlan(JSON.stringify(options.plan ?? plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const log: string[] = [], commits: { item: string; baseHead: string; linkSnapshot: unknown; trailers: Record<string, string>; digest: string; message: string }[] = [];
  let next = 100;
  const itemOf = (ws: WorkspaceRef) => (ws.storage as { item: string }).item;
  const workspace: TaskWorkspace = {
    async materialize(attempt, head) { log.push(`materialize ${attempt.item} @${head.slice(-3)}`); if (options.materializeError) throw options.materializeError; return { clone: { id: `c-${attempt.id}`, taskId: 'task', directory: '/tmp/x', head }, storage: { item: attempt.item, attemptId: attempt.id } }; },
    async snapshotDeclaredLinks(ws, paths) { log.push(`snapshot ${itemOf(ws)} [${paths.join(',')}]`); if (options.snapshotError) throw options.snapshotError; return { item: itemOf(ws), links: [], targets: {} } as never; },
    async checkTree(ws, input, signal) {
      // Like D's check: a signal already aborted stops it before its container starts.
      signal.throwIfAborted();
      log.push(`check ${itemOf(ws)} @${input.baseHead.slice(-3)} [${input.operations.map(o => `${o.kind} ${o.path}`).join(',')}]`);
      if (options.checkError) throw options.checkError;
      return { item: itemOf(ws), base: input.baseHead, gitlinks: [] } as never;
    },
    async inspectChanges(ws, input, signal) {
      log.push(`inspect ${itemOf(ws)} @${input.baseHead.slice(-3)}`); await options.inspect?.(itemOf(ws), signal);
      return options.manifests?.[itemOf(ws)] ?? manifest([change(itemOf(ws) === 'P1' ? 'a.ts' : 'b.ts')]);
    },
    async commit(ws, input) {
      await options.commit?.(itemOf(ws));
      const head = options.commitHead ?? oid(next++); commits.push({ item: itemOf(ws), baseHead: input.baseHead, linkSnapshot: input.linkSnapshot, trailers: { ...input.trailers }, digest: input.digest, message: input.message });
      log.push(`commit ${itemOf(ws)} -> ${head.slice(-3)}`); return head;
    },
    ...options.partial ? { async exportPartial(ws: WorkspaceRef, _input: unknown, signal: AbortSignal) {
      log.push(`export ${itemOf(ws)}`);
      if (options.partial instanceof Error) throw options.partial;
      // Like D's export: it stops when its signal aborts.
      if (options.partial === 'hang') return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { diff: options.partial!, truncated: false };
    } } : {},
    async release(ws) {
      const attemptId = (ws.storage as { attemptId: string }).attemptId;
      log.push(`release ${itemOf(ws)} after ${store.getAttempt(identity, attemptId).state}`);
      await options.release?.();
    },
  };
  const auditContext: PlanContext = options.pathKeyError ? { ...context, pathKey: () => { throw options.pathKeyError; } } : context;
  const sources: ExecutionSources = { planContext: () => auditContext, issue: options.issue ?? (() => ({ number: 1, title: 'Issue', body: 'Please fix', comments: [] })), lessons: () => [], vendor: () => options.vendor ?? 'claude' };
  const prompts: string[] = [], argv: (readonly (readonly string[])[])[] = [], owners: string[] = [], checks: unknown[] = [];
  const capability = options.capability?.(store), findings = new SafetyFindings(store, capability);
  if (options.settleError) store.settleAttempt = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
  if (options.findingSaveError) store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
  const deps = executionDeps(store, workspace, (input, prompt, ws, treeCheck) => {
    if (options.startError) throw options.startError;
    log.push(`start ${itemOf(ws)}`); checks.push(treeCheck); prompts.push(prompt); argv.push(input.approvedArgv); owners.push(input.runnerOwner);
    const settled = Promise.resolve().then(() => options.onLaunch?.(input.attemptId)).then(() => ({ attemptId: options.foreignResult ? randomUUID() : input.attemptId,
      context: input.context, exitCode: 0, signal: null, stdout: 'done', stderr: '', ...options.exit?.[itemOf(ws)] }));
    return { attemptId: input.attemptId, settled, cancel: () => undefined };
  }, sources, RUNNER_OWNER, findings, { diagnostics: { directory: join(dir, 'diagnostics'), capBytes: options.diagnosticsCap }, exportDeadlineMs: options.exportDeadlineMs });
  const runner = new RunnerCoordinator(store, deps, undefined, capability);
  cleanups.push(async () => { await runner.close(); store.close(); });
  return { store, path, workspace, findings, runner, executor: new ItemExecutor(store, runner, sources, findings, { capability }), log, commits, prompts, argv, owners, checks };
}

describe('item execution', () => {
  it('runs items in order, commits each with trailers, and records owned ledger entries', async () => {
    const { store, executor, log, commits, prompts, argv, owners } = setup();
    expect(await executor.runTask(identity)).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: [] });
    // Each commit gets the link snapshot its own item took before launch.
    expect(commits.map(c => [c.item, c.baseHead.slice(-3), c.trailers, c.linkSnapshot, c.message])).toEqual([
      ['P1', '002', { 'Plan-Item': 'P1', 'Plan-Revision': 'r1' }, { item: 'P1', links: [], targets: {} }, 'P1: First'],
      ['P2', '064', { 'Plan-Item': 'P2', 'Plan-Revision': 'r1' }, { item: 'P2', links: [], targets: {} }, 'P2: Second']]);
    expect(store.getLedger(identity)).toEqual(expect.arrayContaining([
      { sha: oid(100), owner: 'P1', origin: 'owned', sourceSha: null }, { sha: oid(101), owner: 'P2', origin: 'owned', sourceSha: null }]));
    expect(store.getSnapshot(identity).head).toBe(oid(101));
    expect(log).toEqual([
      'materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'start P1', 'inspect P1 @002', 'commit P1 -> 064', 'release P1 after completed',
      'materialize P2 @064', 'snapshot P2 [b.ts]', 'check P2 @064 [edit b.ts]', 'start P2', 'inspect P2 @064', 'commit P2 -> 065', 'release P2 after completed']);
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
    // The commit is the whole audited manifest, the out-of-scope file included.
    expect(commits[0]!.digest).toBe('digest-2');
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
  it('stops on an agent failure: what it left is inspected, never committed', async () => {
    const { store, executor, log, commits } = setup({ exit: { P1: { exitCode: 1, stderr: 'agent crashed' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: '"agent crashed"' });
    expect(log.some(line => line.startsWith('inspect P1'))).toBe(true);
    expect(commits).toEqual([]);
    expect(store.getSnapshot(identity).head).toBe(oid(2));
    expect(store.getTask(identity).status).toBe('running');
  });
  it('sends a failed run that left a safety violation to a person, so it is not retried (#87 item 2)', async () => {
    for (const exit of [{ exitCode: 1, stderr: 'agent crashed' }, { exitCode: null, stopReason: 'timeout' as const }]) {
      const { store, executor, commits } = setup({ exit: { P1: exit }, manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) } });
      expect(await executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1', reason: expect.stringContaining('Git metadata') });
      expect(commits).toEqual([]);
      expect(store.getTask(identity).status).toBe('needs human');
      expect(store.getAttempts(identity)[0]).toMatchObject({ state: 'failed', safetyFinding: expect.stringContaining(SAFETY_VIOLATION) });
    }
    // An inspection that refuses on a failed run is a finding too.
    const refused = setup({ exit: { P1: { exitCode: 1 } }, inspect: async () => { throw new Error('docker run failed (exit 6): could not read x'); } });
    expect(await refused.executor.runTask(identity)).toMatchObject({ kind: 'needs human', reason: expect.stringContaining('The change inspection refused') });
  });
  it('audits a clean run once: a failed finish is not inspected again', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) } });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.log.filter(line => line.startsWith('inspect'))).toHaveLength(1);
    const refused = setup({ commit: async () => { throw new Error('work tree changed after the audit'); } });
    await refused.executor.runTask(identity);
    expect(refused.log.filter(line => line.startsWith('inspect'))).toHaveLength(1);
  });
  it('does not audit a run a person stopped while it ran', async () => {
    let runner!: RunnerCoordinator;
    const h = setup({ exit: { P1: { exitCode: 1 } }, manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      onLaunch: attemptId => runner.stop(identity, attemptId, 'cancelled') });
    runner = h.runner;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'cancelled' });
    expect(h.log.some(line => line.startsWith('start P1'))).toBe(true);
    expect(h.log.some(line => line.startsWith('inspect'))).toBe(false);
    expect(h.store.getTask(identity).status).not.toBe('needs human');
  });
  it('audits and keeps what a run left when its result is not this attempt\'s', async () => {
    const h = setup({ foreignResult: true, manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, partial: Buffer.from('d') });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.store.getAttempts(identity)[0]).toMatchObject({ state: 'failed', diagnosticRef: expect.stringMatching(/\.diff$/) });
  });
  it('gives up on an export at its own deadline and settles with that reason', async () => {
    const h = setup({ exit: { P1: { exitCode: 1, stderr: 'crashed' } }, partial: 'hang', exportDeadlineMs: 50 });
    const began = performance.now();
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'failed' });
    expect(performance.now() - began).toBeLessThan(10_000);
    expect(h.store.getAttempts(identity)[0]!.diagnostic).toBe('"crashed" Partial output could not be exported: "the export did not finish within its deadline"');
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
    const { store, executor, log, commits } = setup({ exit: { P1: { attemptId: '00000000-0000-4000-8000-000000000000' } } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed' });
    // What the run left is audited, but a result that is not this attempt's is never committed.
    expect(log.some(line => line.startsWith('inspect P1'))).toBe(true);
    expect(commits).toEqual([]);
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
  it('keeps the Store open at shutdown until a run\'s pause after its last attempt is written (#91)', async () => {
    let releaseStarted!: () => void, finishRelease!: () => void;
    const started = new Promise<void>(resolve => { releaseStarted = resolve; });
    const gate = new Promise<void>(resolve => { finishRelease = resolve; });
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) },
      capability: s => s.shutdownCapability(), release: async () => { releaseStarted(); await gate; } });
    // The run resumes some time after its job settles; nothing orders that before the coordinator's close returns.
    const settled = h.runner.settled.bind(h.runner);
    h.runner.settled = async target => { await settled(target); await new Promise(resolve => setTimeout(resolve, 30)); };
    const run = h.executor.runTask(identity);
    await started;
    // Shutdown, server order: close the write gate, stop the coordinator, then await the executor.
    h.store.closeWrites();
    let closed = false;
    const closing = h.runner.close().then(() => h.executor.close()).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    finishRelease();
    await closing;
    // The pause landed through the capability before close returned, so closing the Store now loses nothing.
    expect(h.store.getTask(identity).status).toBe('needs amendment');
    await expect(run).resolves.toMatchObject({ kind: 'needs amendment', item: 'P1' });
  });
  it('fetches the issue for each attempt, and fails it before any storage when the fetch fails', async () => {
    const signals: AbortSignal[] = [];
    const h = setup({ issue: (_identity, signal) => { signals.push(signal); return Promise.reject(new Error('Issue retrieval timed out.')); } });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed' });
    expect(signals).toHaveLength(1);
    expect(h.log).toEqual([]);
    expect(h.store.getAttempts(identity)[0]!.diagnostic).toMatch(/Issue retrieval timed out/);
  });
  it('begin admits the first item before it returns, and the rest of the run follows (#91 part 2)', async () => {
    const h = setup();
    const begun = h.executor.begin(identity);
    // Admitted synchronously, inside whatever transaction the caller holds.
    expect(h.store.getAttempts(identity).map(row => [row.id, row.item])).toEqual([[begun.attemptId, 'P1']]);
    expect(await begun.outcome).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: [] });
    expect(h.executor.progress(identity)).toEqual({ started: true, begun: true, earlierCommits: false, completed: ['P1', 'P2'], next: null });
  });
  it('begin throws the admission refusal itself, where runTask reports it as not started', async () => {
    const h = setup();
    h.store.cancelTask(identity, h.store.getTask(identity).stateVersion, randomUUID());
    expect(() => h.executor.begin(identity)).toThrow(GuardRefusal);
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'not started' });
    expect(h.store.getAttempts(identity)).toEqual([]);
  });
  it('keeps a safety finding owed when the user action around begin rolls back after the escalation', () => {
    const h = setup();
    const attempt = h.store.admitAttempt(identity, { expectedStateVersion: h.store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
      expectedContext: h.store.currentContext(identity), deadline: Date.now() + 60_000 });
    h.store.markRunning(identity, attempt.id);
    h.store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false });
    const save = h.store.recordSafetyFinding;
    h.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
    h.findings.record(attempt.id, 'Safety violation: test');
    h.store.recordSafetyFinding = save;
    // The escalation's write rolls back with the action, so the finding must still be owed afterwards.
    expect(() => h.store.userAction(identity, { actionId: randomUUID(), kind: 'resume', request: {} }, () => { h.executor.begin(identity); throw new Error('commit failed'); })).toThrow(/commit failed/);
    expect(h.store.getTask(identity).status).toBe('running');
    expect(h.findings.get(attempt.id)).toBe('Safety violation: test');
  });
  it('begin throws ShuttingDownError once the runner stopped admission', () => {
    const h = setup();
    h.runner.rejectAdmission();
    expect(() => h.executor.begin(identity)).toThrow(ShuttingDownError);
    expect(h.store.getAttempts(identity)).toEqual([]);
  });
  it('begin pays nothing owed once the runner stopped admission, and the finding stays owed', () => {
    const h = setup();
    const attempt = h.store.admitAttempt(identity, { expectedStateVersion: h.store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
      expectedContext: h.store.currentContext(identity), deadline: Date.now() + 60_000 });
    h.store.markRunning(identity, attempt.id);
    h.store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false });
    const save = h.store.recordSafetyFinding;
    h.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
    h.findings.record(attempt.id, 'Safety violation: test');
    h.store.recordSafetyFinding = save;
    h.runner.rejectAdmission();
    expect(() => h.executor.begin(identity)).toThrow(ShuttingDownError);
    expect(h.store.getTask(identity).status).toBe('running');
    expect(h.findings.get(attempt.id)).toBe('Safety violation: test');
  });
  it('begin refuses a second run of a task while the first is still in progress', async () => {
    const h = setup();
    const first = h.executor.begin(identity);
    expect(() => h.executor.begin(identity)).toThrow(/still finishing/);
    await first.outcome;
  });
  it('begin refuses a second run between the first run\'s items, when no attempt is active', async () => {
    const h = setup();
    const settled = h.runner.settled.bind(h.runner);
    let between: unknown = null;
    h.runner.settled = async id => {
      await settled(id);
      // P1's job is gone and P2 is not admitted yet: only the executor knows the run is still going.
      if (between === null) { expect(h.runner.isActive(identity)).toBe(false); try { h.executor.begin(identity); between = 'admitted'; } catch (error) { between = error; } }
    };
    const first = h.executor.begin(identity);
    expect(await first.outcome).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: [] });
    expect(between).toBeInstanceOf(GuardRefusal);
    expect((between as Error).message).toMatch(/still finishing/);
    expect(h.store.getAttempts(identity).map(row => row.item)).toEqual(['P1', 'P2']);
  });
  it('commits a rename as the manifest audited it', async () => {
    const { executor, commits } = setup({ manifests: { P1: manifest([change('a.ts', { kind: 'rename', oldPath: 'old.ts' })], { digest: 'renamed' }) } });
    await executor.runTask(identity);
    expect(commits[0]!.digest).toBe('renamed');
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
    const { store, executor, commits } = setup({ manifests: { P1: manifest([change('a.ts')], { linkTargetChanges: undefined as unknown as [] }) } });
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
    // A finding the executor holds in memory (its save failed) waits at the gate and is escalated once it is left.
    const unsafe = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, release: toApproval, findingSaveError: true });
    store = unsafe.store;
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/needs approval; it moves to needs human when it next runs/) });
    expect(store.getTask(identity).status).toBe('needs approval');
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'not started', reason: expect.stringMatching(/needs approval; it moves to needs human/) });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(await unsafe.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('never launches an item with a declared link that goes through another link, and sends the task to a person', async () => {
    const h = setup();
    h.workspace.snapshotDeclaredLinks = async () => ({ links: [{ link: 'a.ts', status: 'through-link' as const, anchor: { path: 'via', type: 'symlink' as const,
      mode: '120777', size: 1, ino: 1, ctime: '0', mtime: '0' } }], targets: {} });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: expect.stringContaining('A declared link goes through another link, so a write through it would land outside its target: "a.ts"') });
    expect(h.log.some(line => line.startsWith('start '))).toBe(false);
    expect(h.store.getTask(identity).status).toBe('needs human');
    // The storage preparation allocated is still released after the terminal write.
    expect(h.log.some(line => line.startsWith('release P1 after failed'))).toBe(true);
  });
  it('never launches an item on a tree the pre-launch check refused, and sends the task to a person (#81)', async () => {
    const h = setup({ checkError: new TaskTreeRefused(['"a.ts" lies beneath the symlink "via"', 'add destination "n.ts" is occupied by a file']) });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1',
      reason: expect.stringContaining('The pre-launch tree check refused: "a.ts" lies beneath the symlink "via"; add destination "n.ts" is occupied by a file.') });
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'release P1 after failed']);
    expect(h.store.getTask(identity).status).toBe('needs human');
    expect(h.store.getAttempts(identity)[0]!.safetyFinding).toContain(SAFETY_VIOLATION);
  });
  it('fails the attempt without a finding when the pre-launch check itself fails (#81)', async () => {
    const { store, executor, log } = setup({ checkError: new Error('docker run failed') });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed', reason: 'Preparation failed: "docker run failed"' });
    expect(log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'release P1 after failed']);
    expect(store.getAttempts(identity)[0]!.safetyFinding ?? null).toBeNull();
    expect(store.getTask(identity).status).toBe('running');
  });
  it('checks every declared operation, rename sources included, and launches with that item\'s check (#81)', async () => {
    const renaming: Plan = { ...plan, items: [{ ...plan.items[0]!, files: [
      { path: 'n.ts', kind: 'rename', renamed_from: 'a.ts', change: 'move' }, { path: 'c.ts', kind: 'add', renamed_from: null, change: 'new' }] }] };
    const h = setup({ plan: renaming });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'executed', items: ['P1'] });
    expect(h.log.slice(0, 4)).toEqual(['materialize P1 @002', 'snapshot P1 [n.ts,a.ts,c.ts]', 'check P1 @002 [rename n.ts,add c.ts]', 'start P1']);
    expect(h.checks).toEqual([{ item: 'P1', base: oid(2), gitlinks: [] }]);
  });
  it('acts on a saved finding at the terminal write, before release can set a gate (#87)', async () => {
    let store!: Store, atRelease: string | undefined;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) },
      release: async () => { atRelease = store.getTask(identity).status; store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1', reason: expect.stringContaining(SAFETY_VIOLATION) });
    // Already needs human when release ran, and nothing left owed: the gate after it is a person's doing.
    expect(atRelease).toBe('needs human');
    const row = store.getAttempts(identity)[0]!;
    expect(row).toMatchObject({ state: 'failed', safetyFinding: expect.stringContaining('Git metadata') });
    expect(h.executor.escalationReason(identity)).toBeUndefined();
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
    const unsafe = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true, release: toQueued });
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
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
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'release P1 after stale']);
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
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'release P1 after cancelled']);
    expect(store.getTask(identity).status).toBe('cancelled');
  });
  it('keeps a safety finding owed when moving to needs human fails, and escalates it before the next run launches anything', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true });
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
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
    let version = 0;
    const releaseDone = h.workspace.release.bind(h.workspace);
    h.workspace.release = async ws => { await releaseDone(ws); version = store.getTask(identity).stateVersion; };
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect(h.findings.get(store.getAttempts(identity)[0]!.id)).toBeUndefined();
    // Settled without a needs human -> needs human write.
    expect(store.getTask(identity).stateVersion).toBe(version);
  });
  it('keeps a finding owed when a merge in progress refuses the escalation, and escalates it on the next run', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true, release: async () => {
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    const attemptId = store.getAttempts(identity)[0]!.id;
    expect(h.findings.get(attemptId)).toBeDefined();
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'not started', reason: expect.stringMatching(/is cancelled/) });
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
    // Still at the gate: the owed pause is refused and reported as not started.
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'not started', reason: expect.stringMatching(/could not pause for amendment/) });
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
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
    const forged: Plan = { ...plan, items: [{ ...plan.items[0]!, title: 'First\n\nPlan-Item: P9\u2028Plan-Revision: r99 \u001b[31mred\u000b\u007f\u009b2J \u202eevil\u2066x\u200b' }, plan.items[1]!] };
    const h = setup({ plan: forged });
    await h.executor.runTask(identity);
    // A NUL is refused earlier, by the prompt builder (plan data must be valid text); other controls reach here.
    expect(h.commits[0]!.message).toBe('P1: First Plan-Item: P9 Plan-Revision: r99 [31mred 2J evil x');
    expect(h.commits[0]!.trailers).toEqual({ 'Plan-Item': 'P1', 'Plan-Revision': 'r1' });
  });
  it('neutralises issue references and mentions in the runner commit message', async () => {
    const titled: Plan = { ...plan, items: [{ ...plan.items[0]!, title: 'Fixes #12, GH-3 and other/repo#4 for @alice' }, plan.items[1]!] };
    const h = setup({ plan: titled });
    await h.executor.runTask(identity);
    expect(h.commits[0]!.message).toBe('P1: Fixes ＃12, GH‑3 and other/repo＃4 for ＠alice');
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
    expect(h.log).toEqual(['materialize P1 @002', 'snapshot P1 [a.ts]', 'check P1 @002 [edit a.ts]', 'release P1 after cancelled']);
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
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
  it('refuses a Codex task before it fetches the issue or allocates task storage (#93)', async () => {
    const { store, runner, executor, log } = setup({ vendor: 'codex', issue: () => { throw new Error('issue fetched'); } });
    expect(await executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'failed',
      reason: expect.stringContaining('Codex cannot run the execute phase') });
    expect(log).toEqual([]);
    expect(runner.status(identity).unresolved).toBeNull();
    expect(store.getTask(identity).status).toBe('running');
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
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true, capability: s => s.shutdownCapability(),
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    const attemptId = store.getAttempts(identity)[0]!.id;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    store.closeWrites();
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'not started', reason: expect.stringMatching(/could not be moved to needs human yet: The review server is shutting down/) });
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
    // Saved on the still-active attempt: startup recovery acts on it, whatever this process does next.
    expect(h.store.getAttempts(identity)[0]).toMatchObject({ state: 'running', safetyFinding: expect.stringContaining('Git metadata') });
    // The next run reports the held slot for the earlier item, and starts nothing.
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', state: 'not started', reason: expect.stringMatching(/Needs restart/) });
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
  it('does not pay an owed scope pause through the shutdown capability once the write gate has closed', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, capability: s => s.shutdownCapability(),
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    store.closeWrites();
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P1', reason: expect.stringMatching(/could not pause for amendment: The review server is shutting down/) });
    expect(store.getTask(identity).status).toBe('queued');
    expect(store.latestCheckpoint(identity)).toBeNull();
  });
  it('records the snapshot\'s base, not the item\'s base head, in the ledger record', async () => {
    const h = setup();
    await h.executor.runTask(identity);
    const snapshot = h.store.getSnapshot(identity);
    expect(snapshot.head).toBe(oid(101));
    expect(snapshot.base).toBe(oid(1));
  });
  it('quotes D\'s error text in the coordinator\'s log lines', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const h = setup({ release: async () => { throw new Error('rm failed\nRunner job forged: ok'); } });
      await h.executor.runTask(identity);
    } finally { spy.mockRestore(); }
    expect(lines.some(line => line.endsWith('could not remove its task storage: "rm failed\\nRunner job forged: ok"'))).toBe(true);
    expect(lines.every(line => !line.includes('\n'))).toBe(true);
  });
  it('finds an owed scope pause even when a later clean item completed after it', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const store = h.store;
    // Record P1's out-of-scope result as if its pause had been lost, then let a clean P2 complete after it.
    const pause = store.pauseForAmendment.bind(store);
    store.pauseForAmendment = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
    await expect(h.executor.runTask(identity)).rejects.toThrow(/disk full/);
    store.pauseForAmendment = pause;
    const p2 = h.runner.start(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P2',
      expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    await h.runner.settled(identity);
    expect(store.getAttempt(identity, p2.id).state).toBe('completed');
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'] });
    // Paid from the durable result: no item ran again.
    expect(store.getAttempts(identity)).toHaveLength(2);
  });
  it('stops before the next item when only the context generation changes during the run', async () => {
    let store!: Store;
    const h = setup({ release: async () => {
      if (store.getAttempts(identity).length !== 1) return;
      const current = store.currentContext(identity);
      store.setAssignment(identity, store.getTask(identity).stateVersion, current.assignmentId, current.referencedCodeHash);
    } });
    store = h.store;
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', item: 'P2', state: 'not started', completed: ['P1'], reason: expect.stringMatching(/snapshot or assignment changed/) });
    expect(h.runner.status(identity).unresolved).toBeNull();
  });
  it('pays nothing owed once shutdown began', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true,
      release: async () => { store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval'); } });
    store = h.store;
    await h.executor.runTask(identity);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    h.runner.rejectAdmission();
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'not started', reason: 'The review server is shutting down.' });
    expect(store.getTask(identity).status).toBe('queued');
    expect(h.findings.get(store.getAttempts(identity)[0]!.id)).toBeDefined();
  });
  it('never lets a second run pay the first run\'s pause, whatever microtask it starts in', async () => {
    for (let steps = 0; steps <= 24; steps++) {
      let executor!: ItemExecutor, second: Promise<ExecutionOutcome> | undefined;
      const h = setup({ manifests: { P1: manifest([change('a.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) }, release: async () => {
        void (async () => { for (let i = 0; i < steps; i++) await null; second = executor.runTask(identity); })();
      } });
      executor = h.executor;
      expect(await h.executor.runTask(identity), `after ${steps} steps`).toMatchObject({ kind: 'needs amendment', item: 'P1' });
      for (let i = 0; i < 50 && !second; i++) await null;
      expect((await second)?.kind, `after ${steps} steps`).toBe('stopped');
    }
  });
  it('does not start while a job started outside the executor is still releasing its storage', async () => {
    let executor!: ItemExecutor, during: Promise<ExecutionOutcome> | undefined;
    const h = setup({ release: async () => { during = executor.runTask(identity); await during; } });
    executor = h.executor;
    h.runner.start(identity, { expectedStateVersion: h.store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
      expectedContext: h.store.currentContext(identity), deadline: Date.now() + 60_000 });
    await h.runner.settled(identity);
    expect(await during).toMatchObject({ kind: 'stopped', state: 'not started', reason: expect.stringMatching(/still finishing/) });
    expect(h.store.getAttempts(identity)).toHaveLength(1);
  });
  it('pauses at a later item with the whole executed prefix', async () => {
    const h = setup({ manifests: { P2: manifest([change('b.ts'), change('extra.ts', { kind: 'add', oldType: undefined })]) } });
    const outcome = await h.executor.runTask(identity) as { kind: string; item: string; checkpointId: string; completed: string[] };
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P2', completed: ['P1', 'P2'] });
    expect(h.store.getCheckpoint(identity, outcome.checkpointId)).toMatchObject({ item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['extra.ts'] });
  });
  it('acts on a finding of an attempt started outside the executor, and admits nothing after it (#87 item 4)', async () => {
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) } });
    const store = h.store;
    // Started through the coordinator directly, as /api/runner start or retry would.
    h.runner.start(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    await h.runner.settled(identity);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)[0]).toMatchObject({ state: 'failed', safetyFinding: expect.stringContaining(SAFETY_VIOLATION) });
    expect(() => h.runner.start(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P2',
      expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 })).toThrow(/needs human/);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('throws, rather than reporting stopped, when this run\'s own escalation meets a closed write gate without a capability', async () => {
    let store!: Store;
    const h = setup({ manifests: { P1: manifest([change('a.ts')], { metadataChanged: true }) }, findingSaveError: true, release: async () => { store.closeWrites(); } });
    store = h.store;
    await expect(h.executor.runTask(identity)).rejects.toBeInstanceOf(ShuttingDownError);
    expect(h.findings.get(store.getAttempts(identity)[0]!.id)).toBeDefined();
  });
  it('keeps the partial output of an attempt that did not complete, referenced from its row (#87 item 1)', async () => {
    const failed = setup({ exit: { P1: { exitCode: 1, stderr: 'crashed' } }, partial: Buffer.from('diff --git a/a.ts b/a.ts\n') });
    await failed.executor.runTask(identity);
    const row = failed.store.getAttempts(identity)[0]!;
    expect(row.diagnosticRef).toMatch(new RegExp(`diagnostics/${row.id}\\.diff$`));
    expect(readFileSync(row.diagnosticRef!, 'utf8')).toBe('diff --git a/a.ts b/a.ts\n');
    expect((statSync(row.diagnosticRef!).mode & 0o777)).toBe(0o600);
    // Exported before the terminal write and before storage is released.
    expect(failed.log.indexOf('export P1')).toBeLessThan(failed.log.findIndex(line => line.startsWith('release P1')));
    // A completed attempt's work is in its commit: nothing is exported.
    const completed = setup({ partial: Buffer.from('x') });
    await completed.executor.runTask(identity);
    expect(completed.log.some(line => line.startsWith('export'))).toBe(false);
    expect(completed.store.getAttempts(identity).every(attempt => attempt.diagnosticRef === null)).toBe(true);
  });
  it('records why partial output could not be exported, quoting the reason, and still settles', async () => {
    const h = setup({ exit: { P1: { exitCode: 1, stderr: 'crashed' } }, partial: new Error('the metadata changed\nRunner job forged') });
    expect(await h.executor.runTask(identity)).toMatchObject({ kind: 'stopped', state: 'failed' });
    const row = h.store.getAttempts(identity)[0]!;
    expect(row.diagnosticRef).toBeNull();
    expect(row.diagnostic).toBe('"crashed" Partial output could not be exported: "the metadata changed\\nRunner job forged"');
  });
});

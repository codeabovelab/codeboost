import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { processIdentity } from '../agents/process-group.ts';
import { LockHeld, RecoveryBlocked, acquireRunnerLock, hostOpenFiles, hostOpenFilesBounded, hostProcesses, recoverStartup, releasePreparation, type RecoveryDeps, type RunnerLock } from '../runner/recovery.ts';
import type { PlanIdentity } from '../core/identity.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0');
const plan = (summary = 'Example'): Plan => ({ schema_version: 1, revision: 1, issue: 1, summary, questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const ctx = (identity: PlanIdentity): PlanContext => ({ identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] });
const id = (n: number): PlanIdentity => ({ repositoryId: 'repo', taskId: `task-${n}`, planId: 'plan' });
const dirs: string[] = [], locks: RunnerLock[] = [], stores: Store[] = [], children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  // A child holding a lock must never outlive its test, even when an assertion fails first.
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const lock of locks.splice(0)) lock.release();
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function dir() { const d = mkdtempSync(join(tmpdir(), 'codeboost-recovery-')); dirs.push(d); return d; }
function lock(path: string, lockRoot: string) { const l = acquireRunnerLock(path, { lockRoot }); locks.push(l); return l; }

describe('runner lock', () => {
  it('lets one holder at a time in this process, releases, and never deletes the lock file', () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    const first = lock(path, locksDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => acquireRunnerLock(path, { lockRoot: locksDir })).toThrow(LockHeld);
    first.release(); locks.splice(locks.indexOf(first), 1);
    const again = lock(path, locksDir);
    expect(again.file).toEqual(first.file);
    expect(existsSync(join(locksDir, `${first.file.dev}-${first.file.ino}.runner-lock`))).toBe(true);
  });
  it('keeps holding the lock when the caller drops the returned object and garbage collection runs', async () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    const recovery = fileURLToPath(new URL('../runner/recovery.ts', import.meta.url));
    const child = spawn(process.execPath, ['--expose-gc', '-e', `import(${JSON.stringify(recovery)}).then(m => { m.acquireRunnerLock(${JSON.stringify(path)}, { lockRoot: ${JSON.stringify(locksDir)} }); for (let i = 0; i < 5; i++) globalThis.gc(); setTimeout(() => { globalThis.gc(); console.log('held'); }, 50); setInterval(() => {}, 1000); })`], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>(resolve => child.stdout!.on('data', chunk => { if (String(chunk).includes('held')) resolve(); }));
    expect(() => acquireRunnerLock(path, { lockRoot: locksDir })).toThrow(LockHeld);
  });
  it('is released by the OS when the holding process is killed', async () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    const recovery = fileURLToPath(new URL('../runner/recovery.ts', import.meta.url));
    const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(recovery)}).then(m => { m.acquireRunnerLock(${JSON.stringify(path)}, { lockRoot: ${JSON.stringify(locksDir)} }); console.log('held'); setInterval(() => {}, 1000); })`], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>(resolve => child.stdout!.on('data', chunk => { if (String(chunk).includes('held')) resolve(); }));
    expect(() => acquireRunnerLock(path, { lockRoot: locksDir })).toThrow(LockHeld);
    child.kill('SIGKILL'); await once(child, 'exit');
    expect(() => lock(path, locksDir)).not.toThrow();
  });
  it('keys the lock by file identity, so a renamed or moved database meets the same lock', () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    lock(path, locksDir);
    const renamed = join(d, 'renamed.sqlite'); renameSync(path, renamed);
    expect(() => acquireRunnerLock(renamed, { lockRoot: locksDir })).toThrow(LockHeld);
    const other = join(d, 'other'); mkdirSync(other, { mode: 0o700 });
    const moved = join(other, 'moved.sqlite'); renameSync(renamed, moved);
    expect(() => acquireRunnerLock(moved, { lockRoot: locksDir })).toThrow(LockHeld);
  });
  it('treats a copy as a different database with its own lock', () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    const original = lock(path, locksDir);
    const copy = join(d, 'copy.sqlite'); copyFileSync(path, copy);
    const copied = lock(copy, locksDir);
    expect(copied.file.ino).not.toBe(original.file.ino);
  });
  it('refuses hard links, symlinks and an unsafe parent directory before taking the lock', () => {
    const d = dir(), locksDir = join(d, 'locks'), path = join(d, 'db.sqlite');
    writeFileSync(path, ''); chmodSync(path, 0o600);
    linkSync(path, join(d, 'alias.sqlite'));
    expect(() => acquireRunnerLock(path, { lockRoot: locksDir })).toThrow(/no hard links/);
    const d2 = dir(), target = join(d2, 'real.sqlite'); writeFileSync(target, '');
    symlinkSync(target, join(d2, 'link.sqlite'));
    expect(() => acquireRunnerLock(join(d2, 'link.sqlite'), { lockRoot: locksDir })).toThrow(/symlink/);
    const d3 = dir(); chmodSync(d3, 0o777);
    expect(() => acquireRunnerLock(join(d3, 'db.sqlite'), { lockRoot: locksDir })).toThrow(/not writable by group or others/);
    expect(existsSync(join(d3, 'db.sqlite'))).toBe(false);
  });
  it('detects a path swap after opening', () => {
    const d = dir(), path = join(d, 'db.sqlite'), held = lock(path, join(d, 'locks'));
    renameSync(path, join(d, 'moved.sqlite')); writeFileSync(path, '');
    expect(() => held.verify()).toThrow(/path changed/);
  });
});

function fixture(count = 1) {
  const d = dir(), path = join(d, 'state.sqlite'), store = new Store(path); stores.push(store);
  for (let n = 1; n <= count; n++) {
    store.createPlan(JSON.stringify(plan()), 'json', ctx(id(n)), oid(1), oid(2));
    store.transitionTask(id(n), store.getTask(id(n)).stateVersion, 'queued');
  }
  const raw = (sql: string) => { const db = new DatabaseSync(path); db.exec(sql); db.close(); };
  const admit = (identity: PlanIdentity, extra: Record<string, unknown> = {}) => store.admitAttempt(identity, {
    expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000, ...extra,
  });
  /** What F saves at allocation (#91): the allocation ID first, then D's metadata baseline and the seeded commit. */
  const allocate = (identity: PlanIdentity, attemptId: string, handle: unknown, saved: { baseline?: boolean } = {}) => {
    const allocationId = randomUUID();
    store.recordAllocation(identity, attemptId, allocationId);
    if (saved.baseline !== false) store.recordAllocationBaseline(identity, attemptId, allocationId, 'b'.repeat(64), oid(2));
    return { attemptId, allocationId, handle };
  };
  return { d, path, store, raw, admit, allocate };
}

describe('runner owner token', () => {
  it('is stable for one file, new for a copy, and refused when malformed', () => {
    const { store, raw } = fixture();
    const token = store.runnerOwnerToken({ dev: 1n, ino: 2n });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(store.runnerOwnerToken({ dev: 1n, ino: 2n })).toBe(token);
    expect(store.runnerOwnerToken({ dev: 1n, ino: 3n })).not.toBe(token);
    raw(`UPDATE app_settings SET value='{"token":"../x","dev":"1","ino":"3"}' WHERE key='runner_owner'`);
    expect(() => store.runnerOwnerToken({ dev: 1n, ino: 3n })).toThrow(/malformed/);
  });

  it('gives Ask its own token, with the same rules, that never equals the runner token (#65)', () => {
    const { store, raw } = fixture();
    const runner = store.runnerOwnerToken({ dev: 1n, ino: 2n });
    const ask = store.askOwnerToken({ dev: 1n, ino: 2n });
    expect(ask).toMatch(/^[0-9a-f]{32}$/);
    expect(ask).not.toBe(runner);
    expect(store.askOwnerToken({ dev: 1n, ino: 2n })).toBe(ask);
    expect(store.runnerOwnerToken({ dev: 1n, ino: 2n })).toBe(runner);
    expect(store.askOwnerToken({ dev: 1n, ino: 3n })).not.toBe(ask);
    raw(`UPDATE app_settings SET value='{"token":"../x","dev":"1","ino":"3"}' WHERE key='ask_owner'`);
    expect(() => store.askOwnerToken({ dev: 1n, ino: 3n })).toThrow(/Ask is off: the stored Ask owner token is malformed/);
  });
});

describe('finalizing interrupted attempts', () => {
  it('applies the settlement precedence and the requeue rules to leftovers', () => {
    const { store, raw, admit } = fixture(7);
    const now = Date.now();
    const a = [1, 2, 3, 4, 5, 6, 7].map(n => { const attempt = admit(id(n)); store.markRunning(id(n), attempt.id); return attempt; });
    store.recordFirstReason(id(1), a[0]!.id, 'cancelled');
    store.recordFirstReason(id(3), a[2]!.id, 'shutdown'); raw(`UPDATE attempts SET stop_reason='timeout' WHERE id='${a[2]!.id}'`);
    store.recordFirstReason(id(4), a[3]!.id, 'shutdown');
    raw(`UPDATE tasks SET budget_deadline=${now - 1} WHERE plan_key IN ('${store.getTask(id(5)).planKey}','${store.getTask(id(6)).planKey}')`);
    store.setAssignment(id(6), store.getTask(id(6)).stateVersion, 'changed', 'hash');
    raw(`UPDATE attempts SET deadline=${now - 1} WHERE id='${a[6]!.id}'`);
    const report = store.recoverInterrupted(now);
    const by = (n: number) => report.find(r => r.attemptId === a[n - 1]!.id)!;
    expect(by(1)).toMatchObject({ state: 'cancelled', requeued: false });
    expect(by(2)).toMatchObject({ state: 'failed', requeued: true });
    expect(store.getAttempt(id(2), a[1]!.id).diagnostic).toBe('Interrupted: codeboost stopped while this was running');
    expect(by(3)).toMatchObject({ state: 'failed', requeued: false });
    expect(by(4)).toMatchObject({ state: 'cancelled', requeued: true });
    expect(by(5)).toMatchObject({ state: 'cancelled', requeued: false });
    expect(store.getTask(id(5)).status).toBe('needs human');
    expect(by(6)).toMatchObject({ state: 'stale', requeued: false });
    expect(by(7)).toMatchObject({ state: 'failed', requeued: false });
    expect(store.getAttempt(id(7), a[6]!.id).diagnostic).toBe('Timed out.');
    expect(store.getTask(id(2)).requeuePending).toBe(true);
    expect(store.interruptedAttempts()).toHaveLength(0);
  });
  it('lets a pending cancel task win over a time limit after a crash', () => {
    const { store, admit } = fixture();
    const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
    store.recordFirstReason(id(1), attempt.id, 'time-limit');
    const cancelId = randomUUID(); store.cancelTask(id(1), store.getTask(id(1)).stateVersion, cancelId);
    store.recoverInterrupted(Date.now());
    expect(store.getTask(id(1)).status).toBe('cancelled');
    expect(store.feedbackEvents(id(1)).filter(e => e.kind === 'task-closed')).toMatchObject([{ actionId: cancelId }]);
  });
  it('holds the requeue claim until exactly one admission claims it', () => {
    const { store, admit } = fixture();
    const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
    store.recoverInterrupted(Date.now());
    expect(() => admit(id(1), { retryOf: attempt.id })).toThrow(/requeueing/);
    const resumed = admit(id(1), { claimRequeue: true });
    expect(store.getTask(id(1)).requeuePending).toBe(false);
    store.recordFirstReason(id(1), resumed.id, 'cancelled'); store.settleAttempt(id(1), resumed.id, { firstReason: null, exitCode: 0, valid: true });
    expect(() => admit(id(1), { claimRequeue: true })).toThrow(/already claimed/);
  });
  it('repairs a confirmed merge whose task status or event is missing', () => {
    const { store, raw } = fixture();
    // Only a task in review can start a merge.
    raw(`UPDATE tasks SET status='in review'`);
    const state = { revision: 1, snapshotId: store.getSnapshot(id(1)).id, reviewVersion: store.reviewVersion(id(1)) };
    const merge = store.beginMergeAttempt(id(1), state, oid(2), null, 'direct');
    store.finishMergeAttempt(id(1), merge.id, { state: 'merged' });
    raw(`UPDATE tasks SET status='in review'; DELETE FROM feedback_events;`);
    expect(store.reconcileMergedTasks()).toEqual([store.getTask(id(1)).planKey]);
    expect(store.getTask(id(1)).status).toBe('merged');
    expect(store.reconcileMergedTasks()).toEqual([]);
  });
});

describe('startup recovery sequence', () => {
  const token = 'a'.repeat(32);
  function deps(over: Partial<RecoveryDeps> = {}) {
    const calls: string[] = [];
    const d: RecoveryDeps = {
      recoverLeftovers: async () => { calls.push('recover'); return { storage: [], unowned: [] }; },
      exportTaskDiff: async () => { calls.push('export'); return { diff: Buffer.from('diff'), truncated: false }; },
      removeTaskFilesystems: async handle => { calls.push(`remove:${String(handle)}`); },
      processes: { isAlive: () => true, terminate: async pgid => { calls.push(`terminate:${pgid}`); } },
      ...over,
    };
    return { d, calls };
  }
  it('stops preparation first, then D recovery, export, finalization and removal, in that order', async () => {
    const { d: root, store, admit, allocate } = fixture(2);
    const writable = admit(id(1)); const w = allocate(id(1), writable.id, 'w'); store.markRunning(id(1), writable.id);
    const readOnly = admit(id(2), { kind: 'review' });
    const preparationIdentity = 'linux:00000000-0000-0000-0000-000000000000:42';
    store.markPreparationStarting(id(2), readOnly.id, Date.now());
    store.recordPreparationGroup(id(2), readOnly.id, 4242, Date.now(), preparationIdentity);
    const r = allocate(id(2), readOnly.id, 'r');
    const inputs: unknown[] = [], terminate = vi.fn(async (pgid: number) => { calls.push(`terminate:${pgid}`); });
    const { d, calls } = deps({
      recoverLeftovers: async () => { calls.push('recover'); return { storage: [w, r], unowned: [] }; },
      exportTaskDiff: async (_h, input) => { inputs.push(input); calls.push(`export:${store.getAttempt(id(1), writable.id).state}`); return { diff: Buffer.from('partial'), truncated: false }; },
      processes: { isAlive: () => true, terminate },
    });
    const report = await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'runner'), diagnosticsDir: join(root, 'diag'), deps: d });
    expect(calls).toEqual(['terminate:4242', 'recover', 'export:running', 'remove:w', 'remove:r']);
    expect(terminate).toHaveBeenCalledWith(4242, preparationIdentity, 5_000);
    const finalized = store.getAttempt(id(1), writable.id);
    expect(finalized).toMatchObject({ state: 'failed', diagnosticRef: join(root, 'diag', `${writable.id}.diff`) });
    expect(readFileSync(finalized.diagnosticRef!, 'utf8')).toBe('partial');
    // D's export of a recovered handle gets the baseline and seeded commit saved at allocation.
    expect(inputs).toEqual([{ base: oid(2), metadataBaseline: 'b'.repeat(64) }]);
    expect(statSync(finalized.diagnosticRef!).mode & 0o777).toBe(0o600);
    expect(report.requeue).toContain(store.getTask(id(1)).planKey);
  });
  it('stops before finalizing anything when D recovery rejects or reports unowned resources', async () => {
    for (const recoverLeftovers of [async () => { throw new Error('docker down'); }, async () => ({ storage: [], unowned: ['container legacy'] })]) {
      const { d: root, store, admit } = fixture();
      const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
      await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: deps({ recoverLeftovers }).d })).rejects.toThrow(/docker down|cannot identify/);
      expect(store.getAttempt(id(1), attempt.id).state).toBe('running');
    }
  });
  it('aborts each exact interrupted rebase before clearing its durable ownership marker', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head], startedAt: 123 });
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, null, 'spawning');
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, 'spawning',
      { pgid: 5151, startedAt: 456, identity: 'linux:00000000-0000-0000-0000-000000000000:1' });
    const owned = store.getTask(id(1)).rebaseInProgress;
    const cleared = { ...(owned as object), processGroup: null };
    const seen: unknown[] = [];
    const { d, calls } = deps({ abortRebase: async (planKey, value) => {
      calls.push('abort-rebase'); seen.push({ planKey, value, stillOwned: store.getTask(id(1)).rebaseInProgress });
    } });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d });
    expect(seen).toEqual([{ planKey: store.getTask(id(1)).planKey, value: cleared, stillOwned: cleared }]);
    expect(calls).toEqual(['terminate:5151', 'recover', 'abort-rebase']);
    expect(store.getTask(id(1)).rebaseInProgress).toBeNull();
  });
  it('recovers an unsettled pipe-holder marker without signalling a reusable process-group ID', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), planKey = store.getTask(id(1)).planKey;
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    const child = randomUUID(), allocationId = randomUUID(), networkAllocationId = randomUUID();
    store.beginRebaseConflict(planKey, marker.attemptId, { attemptId: child, allocationId, networkAllocationId, source: snapshot.head });
    store.setRebaseProcessGroup(planKey, marker.attemptId, null, 'spawning');
    store.setRebaseProcessGroup(planKey, marker.attemptId, 'spawning', 'unsettled');
    mkdirSync(join(root, 'r', token, 'rebases', marker.attemptId), { recursive: true });
    const calls: string[] = [], isAlive = vi.fn(() => true), terminate = vi.fn(async () => undefined);
    const openFiles = vi.fn(() => [] as string[]), abortRebase = vi.fn(async () => { calls.push('abort-rebase');
      expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ processGroup: null, conflict: { attemptId: child } }); });
    const removeTaskFilesystems = vi.fn(async () => { calls.push('remove-child'); });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), openFiles,
      deps: deps({ abortRebase, removeTaskFilesystems, processes: { isAlive, terminate }, recoverLeftovers: async () => {
        calls.push('recover'); return { storage: [{ attemptId: child, allocationId, handle: 'child' }], unowned: [] };
      } }).d });
    expect(isAlive).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled(); expect(openFiles).toHaveBeenCalledOnce();
    expect(calls).toEqual(['recover', 'abort-rebase', 'remove-child']);
    expect(store.getTask(id(1)).rebaseInProgress).toBeNull();
  });
  it('removes an interrupted conflict child before clearing its parent rebase', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), planKey = store.getTask(id(1)).planKey;
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    const child = randomUUID(), allocationId = randomUUID(), networkAllocationId = randomUUID();
    store.beginRebaseConflict(planKey, marker.attemptId, { attemptId: child, allocationId, networkAllocationId, source: snapshot.head });
    const dockerIdentity = 'linux:00000000-0000-0000-0000-000000000000:3';
    store.setRebaseProcessGroup(planKey, marker.attemptId, null, 'spawning');
    store.setRebaseProcessGroup(planKey, marker.attemptId, 'spawning', { pgid: 6161, startedAt: 789, identity: dockerIdentity });
    const calls: string[] = [], abortRebase = vi.fn(async () => { calls.push('abort-rebase');
      expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ conflict: { attemptId: child } }); });
    const removeTaskFilesystems = vi.fn(async () => { calls.push('remove-child');
      expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ conflict: { attemptId: child } }); });
    const report = await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase, removeTaskFilesystems, recoverLeftovers: async () => {
        calls.push('recover'); return { storage: [{ attemptId: child, allocationId, handle: 'child' }], unowned: [] };
      }, processes: { isAlive: () => true, terminate: async pgid => { calls.push(`terminate:${pgid}`); } } }).d });
    expect(calls).toEqual(['terminate:6161', 'recover', 'abort-rebase', 'remove-child']);
    expect(removeTaskFilesystems).toHaveBeenCalledWith('child');
    expect(report.unmatchedStorage).toEqual([]);
    expect(store.getTask(id(1)).rebaseInProgress).toBeNull();
  });
  it('retains a conflict marker when recovered storage only partially matches its identity', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), planKey = store.getTask(id(1)).planKey;
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    const child = randomUUID(), allocationId = randomUUID(), networkAllocationId = randomUUID();
    store.beginRebaseConflict(planKey, marker.attemptId, { attemptId: child, allocationId, networkAllocationId, source: snapshot.head });
    const abortRebase = vi.fn(async () => undefined), removeTaskFilesystems = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase, removeTaskFilesystems, recoverLeftovers: async () => ({
        storage: [{ attemptId: child, allocationId: randomUUID(), handle: 'wrong' }], unowned: [],
      }) }).d })).rejects.toThrow(/does not match/);
    expect(abortRebase).not.toHaveBeenCalled(); expect(removeTaskFilesystems).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ conflict: { attemptId: child, allocationId } });
  });
  it('passes only the exact durably owned result ref to rebase recovery', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head], startedAt: 123 });
    store.prepareRebaseResult(store.getTask(id(1)).planKey, marker.attemptId, oid(4), [oid(4)]);
    store.completeRebaseResult(store.getTask(id(1)).planKey, marker.attemptId);
    const abortRebase = vi.fn(async () => undefined);
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d });
    expect(abortRebase).toHaveBeenCalledWith(store.getTask(id(1)).planKey,
      expect.objectContaining({ attemptId: marker.attemptId, resultState: 'ready', resultHead: oid(4),
        resultMappings: [{ oldSha: snapshot.head, newSha: oid(4) }], processGroup: null }));
    expect(store.getTask(id(1)).rebaseInProgress).toBeNull();
  });
  it('normalizes a legacy rebase marker without result ownership and preserves its ref during recovery', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
    const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), startedAt: 123, processGroup: null };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
    const abortRebase = vi.fn(async () => undefined);
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d });
    expect(abortRebase).toHaveBeenCalledWith(planKey, { ...marker, oldHistory: null, resultState: 'none',
      resultHead: null, resultMappings: null, resolvedConflicts: [], conflict: null });
    expect(store.getTask(id(1)).rebaseInProgress).toBeNull();
  });
  it('retains a recovery marker whose resolved-conflict provenance is outside its captured history', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
    const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head], startedAt: 123,
      resultState: 'ready', resultHead: oid(4), resultMappings: [{ oldSha: snapshot.head, newSha: oid(4) }],
      resolvedConflicts: [oid(9)], processGroup: null };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
    const abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
  });
  it('rejects explicit null resolved-conflict provenance instead of treating it as a legacy field', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
    const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head], startedAt: 123,
      resultState: 'ready', resultHead: oid(4), resultMappings: [{ oldSha: snapshot.head, newSha: oid(4) }],
      resolvedConflicts: null, processGroup: null };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
    const abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
  });
  it('rejects incomplete and cleanup-only markers that claim retained-result ownership', async () => {
    for (const shape of ['missing-state', 'missing-history'] as const) {
      const { d: root, store, raw } = fixture();
      store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
      const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
      const result = { resultHead: oid(4), resultMappings: [{ oldSha: snapshot.head, newSha: oid(4) }] };
      const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), startedAt: 123,
        ...(shape === 'missing-state' ? { oldHistory: [snapshot.head], ...result } : { resultState: 'ready', ...result }),
        processGroup: null };
      raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
      const abortRebase = vi.fn(async () => undefined);
      await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
        deps: deps({ abortRebase }).d })).rejects.toThrow(/invalid recovery marker/);
      expect(abortRebase).not.toHaveBeenCalled();
      expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
    }
  });
  it('retains a dead-group marker while another process still uses its rebase workspace', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, null, 'spawning');
    const group = { pgid: 5151, startedAt: 456, identity: 'linux:00000000-0000-0000-0000-000000000000:1' };
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, 'spawning', group);
    mkdirSync(join(root, 'r', token, 'rebases', marker.attemptId), { recursive: true });
    const abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase, processes: { isAlive: () => false, terminate: async () => undefined } }).d,
      openFiles: () => ['escaped-child'] })).rejects.toThrow(/still uses/);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ processGroup: group });
  });
  it('retains a terminated-group marker while an escaped descendant still uses its rebase workspace', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, null, 'spawning');
    const group = { pgid: 5151, startedAt: 456, identity: 'linux:00000000-0000-0000-0000-000000000000:1' };
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, 'spawning', group);
    mkdirSync(join(root, 'r', token, 'rebases', marker.attemptId), { recursive: true });
    const terminate = vi.fn(async () => undefined), abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase, processes: { isAlive: () => true, terminate } }).d,
      openFiles: () => ['escaped-child'] })).rejects.toThrow(/still uses/);
    expect(terminate).toHaveBeenCalledWith(group.pgid, group.identity, 5_000);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ processGroup: group });
  });
  it('fails closed and retains an interrupted rebase when no recovery implementation is present', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: deps().d }))
      .rejects.toThrow(/needs F3 to abort/);
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
  });
  it('fails closed without cleanup when a crash left the spawned process identity unknown', async () => {
    const { d: root, store } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1));
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    store.setRebaseProcessGroup(store.getTask(id(1)).planKey, marker.attemptId, null, 'spawning');
    const abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toMatchObject({ processGroup: 'spawning' });
  });
  it('rejects an unknown string process owner before recovery actions', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), planKey = store.getTask(id(1)).planKey;
    const marker = store.beginRebase(id(1), { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(id(1)) },
      store.getTask(id(1)).stateVersion, { oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), oldHistory: [snapshot.head] });
    const malformed = { ...marker, processGroup: 'unknown-owner' };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(malformed)}' WHERE plan_key='${planKey}'`);
    const recoverLeftovers = vi.fn(async () => ({ storage: [], unowned: [] }));
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ recoverLeftovers }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(recoverLeftovers).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(malformed);
  });
  it('rejects process-group ID 1 without sending any recovery signal', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
    const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.head, onto: oid(3), startedAt: 123,
      processGroup: { pgid: 1, startedAt: 456, identity: null } };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
    const terminate = vi.fn(async () => undefined), abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase, processes: { isAlive: () => true, terminate } }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(terminate).not.toHaveBeenCalled();
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
  });
  it('rejects an empty-history result bound to a head other than its target before cleanup', async () => {
    const { d: root, store, raw } = fixture();
    store.transitionTask(id(1), store.getTask(id(1)).stateVersion, 'approved but merge blocked');
    const snapshot = store.getSnapshot(id(1)), attemptId = randomUUID(), planKey = store.getTask(id(1)).planKey;
    const marker = { attemptId, oldBase: snapshot.base, oldHead: snapshot.base, onto: oid(5), oldHistory: [], startedAt: 123,
      resultState: 'ready', resultHead: oid(6), resultMappings: [], processGroup: null };
    raw(`UPDATE tasks SET rebase_in_progress='${JSON.stringify(marker)}' WHERE plan_key='${planKey}'`);
    const abortRebase = vi.fn(async () => undefined);
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ abortRebase }).d })).rejects.toThrow(/invalid recovery marker/);
    expect(abortRebase).not.toHaveBeenCalled();
    expect(store.getTask(id(1)).rebaseInProgress).toEqual(marker);
  });
  it('records an export timeout as a diagnostic and still finalizes and removes the storage', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const h = allocate(id(1), attempt.id, 'h'); store.markRunning(id(1), attempt.id);
    const { d, calls } = deps({
      recoverLeftovers: async () => ({ storage: [h], unowned: [] }),
      // D's export stops a moment after its signal aborts.
      exportTaskDiff: (_h, _i, _m, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => { calls.push('export-stopped'); reject(signal.reason); }, 40), { once: true })),
    });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d, exportDeadlineMs: 30 });
    expect(store.getAttempt(id(1), attempt.id)).toMatchObject({ state: 'failed', diagnosticRef: null });
    expect(store.getAttempt(id(1), attempt.id).diagnostic).toMatch(/Partial output could not be exported: Export timed out/);
    // The storage is removed only after the export stopped using it.
    expect(calls.indexOf('export-stopped')).toBeGreaterThan(-1);
    expect(calls.indexOf('remove:h')).toBeGreaterThan(calls.indexOf('export-stopped'));
  });
  it('stops startup, leaving storage and the attempt untouched, when a timed-out export does not stop', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const h = allocate(id(1), attempt.id, 'h'); store.markRunning(id(1), attempt.id);
    const { d, calls } = deps({
      recoverLeftovers: async () => ({ storage: [h], unowned: [] }),
      exportTaskDiff: () => new Promise(() => undefined),
    });
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d, exportDeadlineMs: 30, graceMs: 30 }))
      .rejects.toThrow(/did not stop/);
    expect(calls.some(c => c.startsWith('remove'))).toBe(false);
    expect(store.getAttempt(id(1), attempt.id).state).toBe('running');
  });
  it('removes nothing when the finalization transaction fails', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const h = allocate(id(1), attempt.id, 'h'); store.markRunning(id(1), attempt.id);
    vi.spyOn(store, 'recoverInterrupted').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    const { d, calls } = deps({ recoverLeftovers: async () => ({ storage: [h], unowned: [] }) });
    await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d })).rejects.toThrow(/disk/);
    expect(calls.some(c => c.startsWith('remove'))).toBe(false);
  });
  it('keeps storage that matches no attempt, sweeps owned attempt directories, and reports unknown entries', async () => {
    const { d: root, store, admit } = fixture();
    const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
    const attempts = join(root, 'r', token, 'attempts'); mkdirSync(join(attempts, attempt.id), { recursive: true });
    mkdirSync(join(attempts, 'stray')); symlinkSync(root, join(attempts, randomUUID()));
    const { d, calls } = deps({ recoverLeftovers: async () => ({ storage: [{ attemptId: randomUUID(), allocationId: randomUUID(), handle: 'orphan' }], unowned: [] }) });
    const report = await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d });
    expect(calls).not.toContain('remove:orphan');
    expect(report.unmatchedStorage).toHaveLength(1);
    expect(existsSync(join(attempts, attempt.id))).toBe(false);
    expect(report.unknownEntries).toHaveLength(2);
    expect(existsSync(root)).toBe(true);
  });
  it('uses a handle only when its allocation ID matches the attempt row, and leaves any other for a person', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const saved = allocate(id(1), attempt.id, 'saved'); store.markRunning(id(1), attempt.id);
    const other = { attemptId: attempt.id, allocationId: randomUUID(), handle: 'other' };
    const { d, calls } = deps({ recoverLeftovers: async () => ({ storage: [other, saved], unowned: [] }) });
    const report = await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d });
    expect(calls).toEqual(['export', 'remove:saved']);
    expect(report.unmatchedStorage).toEqual([attempt.id]);
  });
  it('keeps every diff this recovery saved when retention runs, so no finalized row points at a deleted file', async () => {
    const { d: root, store, admit, allocate } = fixture(2);
    const first = admit(id(1)); const a = allocate(id(1), first.id, 'a'); store.markRunning(id(1), first.id);
    const second = admit(id(2)); const b = allocate(id(2), second.id, 'b'); store.markRunning(id(2), second.id);
    const { d } = deps({ recoverLeftovers: async () => ({ storage: [a, b], unowned: [] }),
      exportTaskDiff: async () => ({ diff: Buffer.alloc(40, 1), truncated: false }) });
    // A cap that holds one diff: retention runs on the second save, before finalization references the first.
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d, diagnosticsCapBytes: 50 });
    for (const [identity, attempt] of [[id(1), first], [id(2), second]] as const) {
      const ref = store.getAttempt(identity, attempt.id).diagnosticRef;
      expect(ref && existsSync(ref)).toBe(true);
    }
  });
  it('marks a diff D cut at its limit, so it is never read as all the agent changed', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const h = allocate(id(1), attempt.id, 'h'); store.markRunning(id(1), attempt.id);
    const { d } = deps({ recoverLeftovers: async () => ({ storage: [h], unowned: [] }),
      exportTaskDiff: async () => ({ diff: Buffer.from('diff --git a/x b/x'), truncated: true }) });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d });
    expect(readFileSync(store.getAttempt(id(1), attempt.id).diagnosticRef!, 'utf8')).toMatch(/^diff --git a\/x b\/x\ncodeboost: the partial output was cut at 18 bytes; later changes are not shown\.\n$/);
  });
  it('lists each unowned object on its own line', async () => {
    const { d: root, store } = fixture();
    const run = recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'),
      deps: deps({ recoverLeftovers: async () => ({ storage: [], unowned: ['docker volume rm a  # no-runner-label', 'docker network rm b  # unknown-kind'] }) }).d });
    await expect(run).rejects.toThrow(/then start again:\ndocker volume rm a {2}# no-runner-label\ndocker network rm b {2}# unknown-kind$/);
  });
  it('records an export failure, without calling D, when the allocation baseline was never saved', async () => {
    const { d: root, store, admit, allocate } = fixture();
    const attempt = admit(id(1)); const h = allocate(id(1), attempt.id, 'h', { baseline: false }); store.markRunning(id(1), attempt.id);
    const { d, calls } = deps({ recoverLeftovers: async () => ({ storage: [h], unowned: [] }) });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d });
    expect(calls).toEqual(['remove:h']);
    expect(store.getAttempt(id(1), attempt.id).diagnostic).toMatch(/Partial output could not be exported: its storage baseline was never saved/);
  });
  it('fails closed on an unrecorded preparation until it is released, and refuses release while a process uses it', async () => {
    const { d: root, store, admit } = fixture();
    const attempt = admit(id(1)); store.markPreparationStarting(id(1), attempt.id, Date.now());
    const runnerRoot = join(root, 'r'), dirPath = join(runnerRoot, token, 'attempts', attempt.id); mkdirSync(dirPath, { recursive: true });
    const run = () => recoverStartup({ store, runnerOwner: token, runnerRoot, diagnosticsDir: join(root, 'd'), deps: deps().d });
    await expect(run()).rejects.toBeInstanceOf(RecoveryBlocked);
    expect(existsSync(dirPath)).toBe(true);
    // A second startup finds the attempt already finalized, and still keeps its directory for the release check.
    await expect(run()).rejects.toBeInstanceOf(RecoveryBlocked);
    expect(existsSync(dirPath)).toBe(true);
    expect(() => releasePreparation({ store, runnerRoot, runnerOwner: token, attemptId: attempt.id, openFiles: () => ['4242'] })).toThrow(/still using/);
    releasePreparation({ store, runnerRoot, runnerOwner: token, attemptId: attempt.id, openFiles: () => [] });
    expect(existsSync(dirPath)).toBe(false);
    await expect(run()).resolves.toMatchObject({ finalized: [] });
  });
});

describe('host process checks', () => {
  it('treats a permission-denied liveness probe as alive instead of releasing ownership', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(hostProcesses.isAlive(4242)).toBe(true);
  });

  it('uses a kernel identity and never runs a PATH-selected ps with runner secrets', async () => {
    const root = dir(), marker = join(root, 'ps-ran'), ps = join(root, 'ps'), path = process.env.PATH;
    writeFileSync(ps, `#!/bin/sh\nprintf '%s' "$CODEBOOST_TEST_SECRET" > '${marker}'\n`, { mode: 0o755 });
    process.env.PATH = `${root}:${path ?? ''}`; process.env.CODEBOOST_TEST_SECRET = 'must-not-leak';
    try {
      vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
      expect(hostProcesses.isAlive(4242)).toBe(true);
      await expect(hostProcesses.terminate(4242, null, 10)).rejects.toThrow(/prove the recorded process group/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      delete process.env.CODEBOOST_TEST_SECRET;
    }
  });

  it('revalidates the exact kernel identity before signalling a process group', async () => {
    const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    const pgid = child.pid!;
    try {
      expect(hostProcesses.isAlive(pgid)).toBe(true);
      const identity = processIdentity(pgid), wrong = identity === null ? 'linux:00000000-0000-0000-0000-000000000000:1'
        : `${identity}0`;
      await expect(hostProcesses.terminate(pgid, wrong, 10)).rejects.toThrow(/identity|recorded process group/);
      expect(() => process.kill(pgid, 0)).not.toThrow();
    } finally {
      try { process.kill(-pgid, 'SIGKILL'); } catch {}
      await once(child, 'exit');
      children.splice(children.indexOf(child), 1);
    }
  });

  it.skipIf(process.platform !== 'linux')('bounds settlement after SIGKILL and retains ownership on failure', async () => {
    const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: 'ignore' });
    children.push(child); await once(child, 'spawn');
    const pgid = child.pid!, identity = processIdentity(pgid)!;
    vi.useFakeTimers();
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => 1_000_000 - performance.now());
    try {
      const pending = hostProcesses.terminate(pgid, identity, 100);
      const rejected = expect(pending).rejects.toThrow(/did not exit after SIGKILL/);
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
    } finally {
      wallClock.mockRestore(); signal.mockRestore(); vi.useRealTimers();
      try { process.kill(-pgid, 'SIGKILL'); } catch {}
      await once(child, 'exit'); children.splice(children.indexOf(child), 1);
    }
  });
  it('finds a process working in the attempt directory when the path goes through a symlink', async () => {
    const root = dir(), real = join(root, 'real'), attempt = join(real, 'attempt');
    mkdirSync(attempt, { recursive: true }); symlinkSync(real, join(root, 'link'));
    const child = spawn('sleep', ['30'], { cwd: attempt, stdio: 'ignore' }); children.push(child);
    await once(child, 'spawn');
    expect(hostOpenFiles(join(root, 'link', 'attempt'))).toContain(String(child.pid));
  });
  it('fails closed when the bounded recovery probe exceeds its overall deadline', async () => {
    const root = dir();
    let at = 0;
    await expect(hostOpenFilesBounded(root, { platform: 'darwin', now: () => at,
      run: async () => { at = 15_000; return { status: 0, stdout: '', stderr: '' }; } }))
      .rejects.toThrow(/timed out/);
  });
  it('runs the Linux proc walk in the owned subprocess whose settlement is inside the deadline', async () => {
    const root = dir(); let at = 0, seen: { input?: Buffer; timeoutMs: number } | undefined;
    await expect(hostOpenFilesBounded(root, { platform: 'linux', now: () => at,
      run: async (file, args, options) => {
        expect(file).toBe(process.execPath); expect(args).toContain('--scan-open-files'); seen = options;
        at = 15_000; return { status: 0, stdout: '123\n', stderr: '' };
      } })).rejects.toThrow(/timed out/);
    expect(seen?.input?.toString()).toBe(root);
    expect(seen?.timeoutMs).toBe(3_000);
  });
  it('does not treat an incomplete lsof scan as proving that the workspace is unused', async () => {
    const root = dir();
    await expect(hostOpenFilesBounded(root, { platform: 'darwin',
      run: async () => ({ status: 1, stdout: '', stderr: 'lsof: WARNING: cannot stat() path' }) }))
      .rejects.toThrow(/Could not check/);
  });
});

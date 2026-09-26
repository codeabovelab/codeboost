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
import { LockHeld, RecoveryBlocked, acquireRunnerLock, recoverStartup, releasePreparation, type RecoveryDeps, type RunnerLock } from '../runner/recovery.ts';
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
  return { d, path, store, raw, admit };
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
      exportTaskDiff: async () => { calls.push('export'); return Buffer.from('diff'); },
      removeTaskFilesystems: async handle => { calls.push(`remove:${String(handle)}`); },
      processes: { isAlive: () => true, terminate: async pgid => { calls.push(`terminate:${pgid}`); } },
      ...over,
    };
    return { d, calls };
  }
  it('stops preparation first, then D recovery, export, finalization and removal, in that order', async () => {
    const { d: root, store, admit } = fixture(2);
    const writable = admit(id(1)); store.markRunning(id(1), writable.id);
    const readOnly = admit(id(2), { kind: 'review' });
    store.markPreparationStarting(id(2), readOnly.id, Date.now()); store.recordPreparationGroup(id(2), readOnly.id, 4242);
    const { d, calls } = deps({
      recoverLeftovers: async () => { calls.push('recover'); return { storage: [{ attemptId: writable.id, allocationId: randomUUID(), handle: 'w' }, { attemptId: readOnly.id, allocationId: randomUUID(), handle: 'r' }], unowned: [] }; },
      exportTaskDiff: async () => { calls.push(`export:${store.getAttempt(id(1), writable.id).state}`); return Buffer.from('partial'); },
    });
    const report = await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'runner'), diagnosticsDir: join(root, 'diag'), deps: d });
    expect(calls).toEqual(['terminate:4242', 'recover', 'export:running', 'remove:w', 'remove:r']);
    const finalized = store.getAttempt(id(1), writable.id);
    expect(finalized).toMatchObject({ state: 'failed', diagnosticRef: join(root, 'diag', `${writable.id}.diff`) });
    expect(readFileSync(finalized.diagnosticRef!, 'utf8')).toBe('partial');
    expect(report.requeue).toContain(store.getTask(id(1)).planKey);
  });
  it('stops before finalizing anything when D recovery rejects or reports unowned resources', async () => {
    for (const recoverLeftovers of [async () => { throw new Error('docker down'); }, async () => ({ storage: [], unowned: ['container legacy'] })]) {
      const { d: root, store, admit } = fixture();
      const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
      await expect(recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: deps({ recoverLeftovers }).d })).rejects.toThrow(/docker down|older build/);
      expect(store.getAttempt(id(1), attempt.id).state).toBe('running');
    }
  });
  it('records an export timeout as a diagnostic and still finalizes and removes the storage', async () => {
    const { d: root, store, admit } = fixture();
    const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
    const { d, calls } = deps({
      recoverLeftovers: async () => ({ storage: [{ attemptId: attempt.id, allocationId: randomUUID(), handle: 'h' }], unowned: [] }),
      exportTaskDiff: () => new Promise(() => undefined),
    });
    await recoverStartup({ store, runnerOwner: token, runnerRoot: join(root, 'r'), diagnosticsDir: join(root, 'd'), deps: d, exportDeadlineMs: 30 });
    expect(store.getAttempt(id(1), attempt.id)).toMatchObject({ state: 'failed', diagnosticRef: null });
    expect(store.getAttempt(id(1), attempt.id).diagnostic).toMatch(/Partial output could not be exported: Export timed out/);
    expect(calls).toContain('remove:h');
  });
  it('removes nothing when the finalization transaction fails', async () => {
    const { d: root, store, admit } = fixture();
    const attempt = admit(id(1)); store.markRunning(id(1), attempt.id);
    vi.spyOn(store, 'recoverInterrupted').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    const { d, calls } = deps({ recoverLeftovers: async () => ({ storage: [{ attemptId: attempt.id, allocationId: randomUUID(), handle: 'h' }], unowned: [] }) });
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
  it('fails closed on an unrecorded preparation until it is released, and refuses release while a process uses it', async () => {
    const { d: root, store, admit } = fixture();
    const attempt = admit(id(1)); store.markPreparationStarting(id(1), attempt.id, Date.now());
    const runnerRoot = join(root, 'r'), dirPath = join(runnerRoot, token, 'attempts', attempt.id); mkdirSync(dirPath, { recursive: true });
    const run = () => recoverStartup({ store, runnerOwner: token, runnerRoot, diagnosticsDir: join(root, 'd'), deps: deps().d });
    await expect(run()).rejects.toBeInstanceOf(RecoveryBlocked);
    expect(existsSync(dirPath)).toBe(true);
    expect(() => releasePreparation({ store, runnerRoot, runnerOwner: token, attemptId: attempt.id, openFiles: () => ['4242'] })).toThrow(/still using/);
    releasePreparation({ store, runnerRoot, runnerOwner: token, attemptId: attempt.id, openFiles: () => [] });
    expect(existsSync(dirPath)).toBe(false);
    await expect(run()).resolves.toMatchObject({ finalized: [] });
  });
});

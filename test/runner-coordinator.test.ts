import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { RunnerCoordinator, type PreparedAttempt, type RunnerDeps, type StartRequest } from '../runner/coordinator.ts';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { PlanIdentity } from '../core/identity.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const oid = (n: number) => n.toString(16).padStart(40, '0');
const RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const plan = (summary = 'Example'): Plan => ({ schema_version: 1, revision: 1, issue: 1, summary, questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const ctx = (identity: PlanIdentity): PlanContext => ({ identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] });
const A = { repositoryId: 'repo', taskId: 'task-a', planId: 'plan' }, B = { repositoryId: 'repo', taskId: 'task-b', planId: 'plan' };
const dirs: string[] = [], stores: Store[] = [], coordinators: RunnerCoordinator[] = [];
afterEach(async () => {
  for (const c of coordinators.splice(0)) await c.close().catch(() => undefined);
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Launch { input: InvocationInput; cancels: StopReason[]; settle(over?: Partial<InvocationResult>): void }
interface Preparation { attemptId: string; signal: AbortSignal; resolve(): void; reject(error: Error): void }
/** A fake D and preparation whose promises the test controls. */
function fakeD(options: { prepareIgnoresAbort?: boolean } = {}) {
  const launches: Launch[] = [], preparations: Preparation[] = [];
  let cleaned = 0, startError: Error | undefined;
  const prepared = (attemptId: string): PreparedAttempt => ({ clone: { id: `clone-${attemptId}`, taskId: 'task', directory: '/tmp/x', head: oid(2) }, vendor: 'claude', approvedArgv: [] });
  const deps: RunnerDeps = {
    runnerOwner: RUNNER_OWNER,
    prepare: (attempt, signal) => new Promise((resolve, reject) => {
      preparations.push({ attemptId: attempt.id, signal, resolve: () => resolve(prepared(attempt.id)), reject });
      if (!options.prepareIgnoresAbort) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    cleanupPreparation: async () => { cleaned++; },
    start: input => {
      if (startError) throw startError;
      let settle!: (r: InvocationResult) => void;
      const settled = new Promise<InvocationResult>(resolve => { settle = resolve; });
      const launch: Launch = { input, cancels: [], settle: over => settle({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: 'done', stderr: '', ...over }) };
      launches.push(launch);
      const handle: InvocationHandle = { attemptId: input.attemptId, settled, cancel: reason => { launch.cancels.push(reason); } };
      return handle;
    },
    validate: (_attempt, result) => { if (result.stdout === 'bad') throw new Error('schema mismatch'); return { text: result.stdout }; },
  };
  return { deps, launches, preparations, cleaned: () => cleaned, failStart: (error: Error) => { startError = error; } };
}
function setup(options: { prepareIgnoresAbort?: boolean; limits?: { writable: number; readOnly: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-coordinator-')); dirs.push(dir);
  const store = new Store(join(dir, 'state.sqlite')); stores.push(store);
  for (const identity of [A, B]) {
    store.createPlan(JSON.stringify(plan()), 'json', ctx(identity), oid(1), oid(2));
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  }
  const d = fakeD(options);
  const runner = new RunnerCoordinator(store, d.deps, options.limits); coordinators.push(runner);
  return { store, runner, ...d };
}
const request = (store: Store, identity: PlanIdentity, extra: Partial<StartRequest> = {}): StartRequest => ({
  expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
  expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000, ...extra,
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('admission and slots', () => {
  it('runs an attempt to completion, removes its preparation files and frees its slot', async () => {
    const { store, runner, launches, preparations, cleaned } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    expect(launches[0]!.input.runnerOwner).toBe(RUNNER_OWNER);
    expect(store.getAttempt(A, attempt.id).state).toBe('running');
    expect(cleaned()).toBe(0);
    launches[0]!.settle();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'completed', result: { text: 'done' } });
    expect(cleaned()).toBe(1);
    expect(runner.isActive(A)).toBe(false);
  });
  it('records the stale cause, not the agent stderr', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    runner.stop(A, attempt.id, 'stale', 'plan revision 2 replaced 1');
    launches[0]!.settle({ exitCode: 1, stopReason: 'cancelled', stderr: 'npm ERR! killed' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', diagnostic: 'plan revision 2 replaced 1' });
  });
  it('uses the default stale text, not stderr, when no cause is given', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    runner.stop(A, attempt.id, 'stale');
    launches[0]!.settle({ exitCode: 1, stopReason: 'cancelled', stderr: 'npm ERR! killed' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', diagnostic: 'The plan, snapshot, assignment or referenced code changed.' });
  });
  it('lets exactly one of two same-tick admissions take the single writable slot', () => {
    const { store, runner } = setup();
    runner.start(A, request(store, A));
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
    expect(store.getAttempts(B)).toHaveLength(0);
  });
  it('releases the reservation when the Store refuses admission', () => {
    const { store, runner } = setup();
    expect(() => runner.start(A, request(store, A, { expectedStateVersion: -1 }))).toThrow(/Stale task state/);
    expect(runner.isActive(A)).toBe(false);
    expect(() => runner.start(B, request(store, B))).not.toThrow();
  });
});

describe('stops and settlement', () => {
  it('keeps the slot after cancel until D settles, and keeps the first reason', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    expect(runner.stop(A, attempt.id, 'cancelled')).toBe(true);
    expect(runner.stop(A, attempt.id, 'stale')).toBe(false);
    expect(launches[0]!.cancels[0]).toBe('cancelled');
    expect(runner.status(A)).toMatchObject({ active: true, stopRequested: { reason: 'cancelled', saved: true } });
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'running', firstReason: 'cancelled' });
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
    launches[0]!.settle({ exitCode: 1, stopReason: 'cancelled' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id).state).toBe('cancelled');
    expect(() => runner.start(B, request(store, B))).not.toThrow();
  });
  it('refuses a retry while the old attempt is unsettled, even after the clock jumps', async () => {
    let clock = Date.now();
    const { store, runner, launches, preparations, deps } = setup();
    deps.now = () => clock;
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    clock += 24 * 60 * 60 * 1000;
    expect(() => runner.retry(A, attempt.id, request(store, A))).toThrow(/already active/);
    launches[0]!.settle({ exitCode: null, stopReason: 'timeout' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', diagnostic: 'Timed out.' });
    clock = Date.now();
    expect(runner.retry(A, attempt.id, request(store, A)).state).toBe('pending');
  });
  it('ends stale without calling D when the context changes during preparation', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    store.setAssignment(A, store.getTask(A).stateVersion, 'reassigned', 'hash');
    preparations[0]!.resolve();
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id).state).toBe('stale');
  });
  it('does not launch when a stop lands while preparation finishes', async () => {
    const { store, runner, launches, preparations, cleaned } = setup({ prepareIgnoresAbort: true });
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    runner.stop(A, attempt.id, 'cancelled');
    preparations[0]!.resolve();
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(cleaned()).toBe(1);
    expect(store.getAttempt(A, attempt.id).state).toBe('cancelled');
  });
  it('fails with the preparation error and removes preparation files when preparation fails', async () => {
    const { store, runner, launches, preparations, cleaned } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    preparations[0]!.reject(new Error('clone failed'));
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(cleaned()).toBe(1);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Preparation failed: clone failed' });
    expect(() => runner.start(B, request(store, B))).not.toThrow();
  });
  it('fails with the launch error when D start throws and no stop is recorded', async () => {
    const { store, runner, preparations, failStart } = setup();
    failStart(new Error('docker unavailable'));
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', diagnostic: 'Launch failed: docker unavailable' });
  });
  it('fails an invalid clean result with its validation reason', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle({ stdout: 'bad' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', diagnostic: 'Invalid output: schema mismatch' });
  });
});

describe('storage failures', () => {
  it('uses the in-memory first reason when its write failed, and shows it as unsaved', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'recordFirstReason').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    runner.stop(A, attempt.id, 'cancelled');
    expect(runner.status(A).stopRequested).toEqual({ attemptId: attempt.id, reason: 'cancelled', saved: false });
    launches[0]!.settle();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'cancelled', firstReason: 'cancelled' });
  });
  it('holds the slot under an unresolved marker, and keeps preparation files, when the terminal write fails', async () => {
    const { store, runner, launches, preparations, cleaned } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'settleAttempt').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    launches[0]!.settle();
    await runner.settled(A);
    expect(runner.status(A).unresolved).toEqual({ attemptId: attempt.id, reason: 'result-not-saved' });
    expect(cleaned()).toBe(0);
    expect(() => runner.start(A, request(store, A))).toThrow(/Needs restart/);
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
  });
  it('cancels and settles the handle, then holds a marker, when pending -> running cannot be saved', async () => {
    const { store, runner, launches, preparations } = setup();
    vi.spyOn(store, 'markRunning').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    expect(launches[0]!.cancels).toEqual(['capture-failure']);
    expect(runner.isActive(A)).toBe(true);
    launches[0]!.settle({ exitCode: null, stopReason: 'capture-failure' });
    await until(() => !runner.isActive(A), 'settlement');
    expect(runner.status(A).unresolved).toEqual({ attemptId: attempt.id, reason: 'start-not-saved' });
    expect(store.getAttempt(A, attempt.id).state).toBe('pending');
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
  });
  it('still cancels and awaits the handle when reading the refused attempt fails', async () => {
    const { store, runner, launches, preparations } = setup();
    vi.spyOn(store, 'markRunning').mockImplementation(() => {
      vi.spyOn(store, 'getAttempt').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
      return false;
    });
    runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    expect(launches[0]!.cancels).toEqual(['cancelled']);
    for (let i = 0; i < 20; i++) await tick();
    expect(runner.isActive(A)).toBe(true);
    vi.mocked(store.getAttempt).mockRestore();
    launches[0]!.settle({ exitCode: null, stopReason: 'cancelled' });
    await runner.settled(A);
    expect(runner.isActive(A)).toBe(false);
  });
  it('ends the attempt instead of stranding it when the task budget cannot be read at admission', async () => {
    const { store, runner, launches, preparations } = setup();
    const req = request(store, A);
    vi.spyOn(store, 'getTask').mockImplementationOnce(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    const attempt = runner.start(A, req);
    await runner.settled(A);
    expect(preparations).toHaveLength(0);
    expect(launches).toHaveLength(0);
    expect(runner.isActive(A)).toBe(false);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', diagnostic: 'Could not arm the task time limit: disk' });
  });
  it('refuses all new work after D settles with unreleased resources', async () => {
    const { store, runner, launches, preparations } = setup({ limits: { writable: 1, readOnly: 1 } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle({ exitCode: null, stopReason: 'capture-failure', unreleased: [{ kind: 'container', name: 'agent-x' }] });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id).state).toBe('failed');
    expect(runner.unreleased).toEqual([{ kind: 'container', name: 'agent-x' }]);
    expect(() => runner.start(B, request(store, B))).toThrow(/Needs restart/);
    expect(() => runner.start(B, request(store, B, { kind: 'planning', item: null }))).toThrow(/Needs restart/);
  });
});

describe('review regressions', () => {
  it('does not launch an already admitted attempt once D has reported unreleased resources', async () => {
    const { store, runner, launches, preparations } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runner.start(A, request(store, A));
    const b = runner.start(B, request(store, B, { kind: 'planning', item: null }));
    await until(() => preparations.length === 2, 'preparations');
    preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle({ exitCode: null, stopReason: 'capture-failure', unreleased: [] });
    await runner.settled(A);
    preparations[1]!.resolve();
    await runner.settled(B);
    expect(launches).toHaveLength(1);
    expect(store.getAttempt(B, b.id)).toMatchObject({ state: 'failed', firstReason: null });
    expect(store.getAttempt(B, b.id).diagnostic).toMatch(/cleanup could not be confirmed/);
  });
  it('keeps a preparation timeout when shutdown arrives while preparation is still stopping', async () => {
    const { store, runner, preparations } = setup({ prepareIgnoresAbort: true });
    const attempt = runner.start(A, request(store, A, { deadline: Date.now() + 30 }));
    await until(() => preparations.length === 1, 'preparation');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(preparations[0]!.signal.aborted).toBe(true);
    const closing = runner.close();
    expect(runner.status(A).stopRequested).toBeNull();
    preparations[0]!.resolve();
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Timed out while preparing.' });
  });
  it('ends stale, not time-limit, when the context changed and the budget is also spent at the launch check', async () => {
    let clock = Date.now();
    const { store, runner, launches, preparations, deps } = setup();
    deps.now = () => clock;
    const attempt = runner.start(A, request(store, A, { budgetMs: 60_000, deadline: clock + 600_000 }));
    await until(() => preparations.length === 1, 'preparation');
    store.setAssignment(A, store.getTask(A).stateVersion, 'reassigned', 'hash');
    clock += 120_000;
    preparations[0]!.resolve();
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale' });
    expect(store.getTask(A).status).not.toBe('needs human');
  });
  it('shows the cancel task stop after a preparation timeout, and closes the task', async () => {
    const { store, runner, preparations } = setup({ prepareIgnoresAbort: true });
    const attempt = runner.start(A, request(store, A, { deadline: Date.now() + 30 }));
    await until(() => preparations.length === 1, 'preparation');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
    expect(runner.status(A).stopRequested).toEqual({ attemptId: attempt.id, reason: 'cancelled', saved: true });
    preparations[0]!.resolve();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'cancelled', firstReason: 'cancelled' });
    expect(store.getTask(A).status).toBe('cancelled');
  });
  it('keeps stale when shutdown lands during cleanup after the launch check saw a context change', async () => {
    const { store, runner, launches, preparations, deps } = setup();
    let finish!: () => void, cleanupStarted = false;
    deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    store.setAssignment(A, store.getTask(A).stateVersion, 'reassigned', 'hash');
    preparations[0]!.resolve();
    await until(() => cleanupStarted, 'cleanup');
    const closing = runner.close();
    finish();
    await closing;
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale' });
  });
  it('keeps the launch failure when shutdown lands during cleanup', async () => {
    const { store, runner, preparations, deps, failStart } = setup();
    let finish!: () => void, cleanupStarted = false;
    deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
    failStart(new Error('untrusted image'));
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => cleanupStarted, 'cleanup');
    const closing = runner.close();
    expect(runner.status(A).stopRequested).toBeNull();
    finish();
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Launch failed: untrusted image' });
  });
  it('saves an earlier unsaved reason before cancel task, so the Store does not replace it', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'recordFirstReason').mockImplementationOnce(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    runner.stop(A, attempt.id, 'stale', 'plan revision 2 replaced 1');
    expect(runner.status(A).stopRequested).toMatchObject({ reason: 'stale', saved: false });
    expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
    expect(runner.status(A).stopRequested).toMatchObject({ reason: 'stale', saved: true });
    launches[0]!.settle({ exitCode: 1, stopReason: 'cancelled' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale', diagnostic: 'plan revision 2 replaced 1' });
    expect(store.getTask(A).status).toBe('cancelled');
  });
  it('starts no preparation and gives back the slot when the caller\'s transaction rolls back admission', async () => {
    const { store, runner, preparations } = setup();
    const req = request(store, A);
    expect(() => store.userAction(A, { actionId: randomUUID(), kind: 'retry', request: {} }, () => {
      runner.start(A, req);
      throw new Error('commit failed');
    })).toThrow(/commit failed/);
    await runner.settled(A);
    expect(preparations).toHaveLength(0);
    expect(runner.isActive(A)).toBe(false);
    expect(store.getAttempts(A)).toHaveLength(0);
    expect(() => runner.start(B, request(store, B))).not.toThrow();
  });
  it('shows a reason as unsaved when its write rolled back with the caller\'s transaction, and saves it on the next cancel', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'recordFirstReason').mockImplementationOnce(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    runner.stop(A, attempt.id, 'stale', 'plan revision 2 replaced 1');
    expect(() => store.userAction(A, { actionId: randomUUID(), kind: 'cancel-task', request: {} }, () => {
      runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID());
      throw new Error('commit failed');
    })).toThrow(/commit failed/);
    await tick();
    expect(store.getAttempt(A, attempt.id).firstReason).toBeNull();
    expect(runner.status(A).stopRequested).toMatchObject({ reason: 'stale', saved: false });
    expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
    launches[0]!.settle({ exitCode: 1, stopReason: 'cancelled' });
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale' });
  });
  it('never leaves the slot free between an unexpected failure and its marker', async () => {
    const { store, runner, preparations } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    vi.spyOn(store, 'getAttempt').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    preparations[0]!.resolve();
    // Check after every microtask, so a turn with neither the job nor its marker would be seen.
    let firstInactive: unknown = 'never inactive';
    for (let i = 0; i < 1000; i++) {
      await Promise.resolve();
      if (!runner.isActive(A)) { firstInactive = runner.status(A).unresolved; break; }
    }
    expect(firstInactive).toEqual({ attemptId: attempt.id, reason: 'result-not-saved' });
  });
  it('drops the adopted cancel when the cancel task rolls back, keeping the launch failure', async () => {
    const { store, runner, preparations, deps, failStart } = setup();
    let finish!: () => void, cleanupStarted = false;
    deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
    failStart(new Error('untrusted image'));
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => cleanupStarted, 'cleanup');
    expect(() => store.userAction(A, { actionId: randomUUID(), kind: 'cancel-task', request: {} }, () => {
      expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
      throw new Error('commit failed');
    })).toThrow(/commit failed/);
    await tick();
    expect(runner.status(A).stopRequested).toBeNull();
    finish();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Launch failed: untrusted image' });
    expect(store.getTask(A).status).toBe('running');
  });
  it('keeps the launch failure when a rolled-back cancel task lands just before the terminal write', async () => {
    for (let k = 0; k <= 5; k++) {
      const { store, runner, preparations, deps, failStart } = setup();
      let finish!: () => void, cleanupStarted = false;
      deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
      failStart(new Error('untrusted image'));
      const attempt = runner.start(A, request(store, A));
      await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
      await until(() => cleanupStarted, 'cleanup');
      finish();
      for (let i = 0; i < k; i++) await Promise.resolve();
      if (runner.isActive(A)) {
        expect(() => store.userAction(A, { actionId: randomUUID(), kind: 'cancel-task', request: {} }, () => {
          runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID());
          throw new Error('commit failed');
        })).toThrow(/commit failed/);
      }
      await runner.settled(A);
      expect(store.getAttempt(A, attempt.id), `after ${k} microtasks`).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Launch failed: untrusted image' });
    }
  });
  it('still closes the task with a committed cancel task after a launch failure', async () => {
    const { store, runner, preparations, deps, failStart } = setup();
    let finish!: () => void, cleanupStarted = false;
    deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
    failStart(new Error('untrusted image'));
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => cleanupStarted, 'cleanup');
    expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
    expect(runner.status(A).stopRequested).toEqual({ attemptId: attempt.id, reason: 'cancelled', saved: true });
    finish();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'cancelled', firstReason: 'cancelled' });
    expect(store.getTask(A).status).toBe('cancelled');
  });
  it('refuses a stop once the terminal write is done and only cleanup remains', async () => {
    const { store, runner, launches, preparations, deps } = setup();
    let finish!: () => void, cleanupStarted = false;
    deps.cleanupPreparation = () => { cleanupStarted = true; return new Promise<void>(resolve => { finish = resolve; }); };
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle();
    await until(() => cleanupStarted, 'cleanup');
    expect(store.getAttempt(A, attempt.id).state).toBe('completed');
    expect(runner.stop(A, attempt.id, 'cancelled')).toBe(false);
    expect(runner.status(A)).toMatchObject({ active: true, stopRequested: null });
    finish();
    await runner.settled(A);
    expect(runner.isActive(A)).toBe(false);
  });
});

describe('copilot review', () => {
  it.each([
    ['another attempt', (input: InvocationInput) => ({ attemptId: randomUUID() })],
    ['another context', (input: InvocationInput) => ({ context: { ...input.context, stateVersion: input.context.stateVersion + 1 } })],
  ] as const)('never validates or saves a result for %s, and still removes its preparation files', async (_label, foreign) => {
    const { store, runner, launches, preparations, deps, cleaned } = setup();
    const validate = vi.spyOn(deps, 'validate');
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle(foreign(launches[0]!.input));
    await runner.settled(A);
    expect(validate).not.toHaveBeenCalled();
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', result: null,
      diagnostic: 'The agent returned a result for a different attempt; it was not saved.' });
    expect(cleaned()).toBe(1);
    expect(() => runner.start(B, request(store, B))).not.toThrow();
  });
  it('keeps preparation files for startup recovery when a foreign result\'s terminal write fails', async () => {
    const { store, runner, launches, preparations, cleaned } = setup();
    vi.spyOn(store, 'settleAttempt').mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); });
    runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle({ attemptId: randomUUID() });
    await runner.settled(A);
    expect(cleaned()).toBe(0);
    expect(runner.status(A).unresolved).toMatchObject({ reason: 'result-not-saved' });
  });
  it('holds the slot when preparation files cannot be removed after D settles', async () => {
    const { store, runner, launches, preparations, deps } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    deps.cleanupPreparation = async () => { throw new Error('EBUSY'); };
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    launches[0]!.settle();
    await runner.settled(A);
    expect(store.getAttempt(A, attempt.id).state).toBe('completed');
    expect(runner.status(A)).toMatchObject({ active: false, unresolved: { attemptId: attempt.id, reason: 'preparation-not-removed' } });
    expect(() => runner.start(A, request(store, A))).toThrow(/preparation files could not be removed/);
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
  });
  it('holds the slot when preparation files cannot be removed before launch', async () => {
    const { store, runner, launches, preparations, deps } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    deps.cleanupPreparation = async () => { throw new Error('EBUSY'); };
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation');
    preparations[0]!.reject(new Error('clone failed'));
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', diagnostic: 'Preparation failed: clone failed' });
    expect(runner.status(A).unresolved).toEqual({ attemptId: attempt.id, reason: 'preparation-not-removed' });
    expect(() => runner.start(B, request(store, B))).toThrow(/No free runner slot/);
  });
  it('keeps the result-not-saved marker when both the terminal write and the removal fail', async () => {
    const { store, runner, launches, preparations, deps } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let cleanups = 0;
    deps.cleanupPreparation = async () => { cleanups++; throw new Error('EBUSY'); };
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'settleAttempt').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    launches[0]!.settle();
    await runner.settled(A);
    // A failed terminal write leaves the files for startup recovery, so there is nothing to remove yet.
    expect(cleanups).toBe(0);
    expect(runner.status(A).unresolved).toEqual({ attemptId: attempt.id, reason: 'result-not-saved' });
  });
});

describe('cancel task, limits and shutdown', () => {
  it('stops the running attempt on cancel task and closes the task when it settles, even with a valid result', async () => {
    const { store, runner, launches, preparations } = setup();
    runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    expect(runner.cancelTask(A, store.getTask(A).stateVersion, randomUUID())).toBe('stopping');
    expect(launches[0]!.cancels).toEqual(['cancelled']);
    launches[0]!.settle();
    await runner.settled(A);
    expect(store.getTask(A).status).toBe('cancelled');
  });
  it('stops preparation at the task budget and moves the task to needs human without calling D', async () => {
    const { store, runner, launches } = setup();
    const attempt = runner.start(A, request(store, A, { budgetMs: 30 }));
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'cancelled', firstReason: 'time-limit' });
    expect(store.getTask(A).status).toBe('needs human');
  });
  it('fails preparation at the attempt deadline without a first reason', async () => {
    const { store, runner, launches } = setup();
    const attempt = runner.start(A, request(store, A, { deadline: Date.now() + 30 }));
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Timed out while preparing.' });
    expect(store.getTask(A).status).toBe('running');
  });
  it('fails without calling D when the launch check sees an expired attempt deadline', async () => {
    let clock = Date.now();
    const { store, runner, launches, preparations, deps } = setup();
    deps.now = () => clock;
    const attempt = runner.start(A, request(store, A, { deadline: clock + 60_000 }));
    await until(() => preparations.length === 1, 'preparation');
    clock += 61_000;
    preparations[0]!.resolve();
    await runner.settled(A);
    expect(launches).toHaveLength(0);
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: null, diagnostic: 'Timed out while preparing.' });
  });
  it('rejects new work once shutdown starts and waits for D to settle', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    let closed = false;
    const closing = runner.close().then(() => { closed = true; });
    expect(() => runner.start(B, request(store, B))).toThrow(/shutting down/);
    expect(launches[0]!.cancels).toEqual(['shutdown']);
    for (let i = 0; i < 20; i++) await tick();
    expect(closed).toBe(false);
    launches[0]!.settle({ exitCode: null, stopReason: 'shutdown' });
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'cancelled', diagnostic: 'Stopped by shutdown' });
  });
  it('lets a D timeout that came before shutdown win', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    const closing = runner.close();
    launches[0]!.settle({ exitCode: null, stopReason: 'timeout' });
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'failed', firstReason: 'shutdown', diagnostic: 'Timed out.' });
  });
  it('keeps an unsaved stop reason when shutdown arrives', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    vi.spyOn(store, 'recordFirstReason').mockImplementation(() => { throw Object.assign(new Error('disk'), { code: 'ERR_SQLITE_ERROR' }); });
    runner.stop(A, attempt.id, 'stale');
    const closing = runner.close();
    expect(launches[0]!.cancels).toEqual(['cancelled', 'cancelled']);
    expect(runner.status(A).stopRequested).toEqual({ attemptId: attempt.id, reason: 'stale', saved: false });
    launches[0]!.settle({ exitCode: null, stopReason: 'cancelled' });
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale' });
  });
  it('keeps an existing stop reason when shutdown arrives', async () => {
    const { store, runner, launches, preparations } = setup();
    const attempt = runner.start(A, request(store, A));
    await until(() => preparations.length === 1, 'preparation'); preparations[0]!.resolve();
    await until(() => launches.length === 1, 'launch');
    runner.stop(A, attempt.id, 'stale');
    const closing = runner.close();
    expect(launches[0]!.cancels).toEqual(['cancelled', 'cancelled']);
    expect(runner.status(A).stopRequested).toMatchObject({ reason: 'stale' });
    launches[0]!.settle();
    await closing;
    expect(store.getAttempt(A, attempt.id)).toMatchObject({ state: 'stale', firstReason: 'stale' });
  });
});

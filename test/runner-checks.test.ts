import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { InvocationHandle, InvocationInput, InvocationResult } from '../agents/contract.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { commandCheckDeps, commandDigest } from '../runner/checks.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import type { TaskWorkspace, WorkspaceRef } from '../runner/execution.ts';
import { Store } from '../runner/store.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const oid = (n: number) => n.toString(16).padStart(40, '0');
const commands = [['npm', 'test']] as const;
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: path => path,
  allowedCommands: commands };
const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'Check', questions: [], items: [{ id: 'P1',
  title: 'Change', intent: 'Change a', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }],
  acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] }] };
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('refuses to hash command arguments that a process spawn would normalize', () => {
  expect(() => commandDigest([['node', '\ud800']])).toThrow(/well-formed Unicode/);
});

function fixture(result: (input: InvocationInput) => Promise<InvocationResult>) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-checks-')); roots.push(root);
  const store = new Store(join(root, 'state.sqlite')); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  const released: string[] = [];
  const workspace: TaskWorkspace = {
    async materialize(attempt, head) { return { clone: { id: attempt.id, taskId: 'task', directory: root, head }, storage: {} } as WorkspaceRef; },
    async snapshotDeclaredLinks() { throw new Error('not used'); }, async checkTree() { throw new Error('not used'); },
    async inspectChanges() { throw new Error('not used'); }, async commit() { throw new Error('not used'); },
    async release(value) { released.push(value.clone.head); },
  };
  const deps = commandCheckDeps(store, workspace, (input, encoded) => {
    expect(encoded).toBe(JSON.stringify(commands));
    const handle: InvocationHandle = { attemptId: input.attemptId, settled: result(input), cancel() {} };
    return handle;
  }, () => context, 'a'.repeat(32));
  return { store, runner: new RunnerCoordinator(store, deps), released };
}

it('records passing evidence only for the exact checked head and command digest', async () => {
  const f = fixture(async input => ({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null,
    stdout: '', stderr: '' }));
  const attempt = f.runner.start(identity, { expectedStateVersion: f.store.getTask(identity).stateVersion, kind: 'check', item: 'P1',
    deadline: Date.now() + 60_000, expectedContext: f.store.currentContext(identity) });
  await f.runner.settled(identity);
  const settled = f.store.getAttempt(identity, attempt.id);
  expect({ state: settled.state, diagnostic: settled.diagnostic }).toEqual({ state: 'completed', diagnostic: null });
  expect(f.store.commandChecksPassed(identity, 'P1', oid(2), commandDigest(commands))).toBe(true);
  const snapshot = f.store.getSnapshot(identity);
  f.store.recordHistory(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: f.store.reviewVersion(identity) }, oid(1), oid(3), []);
  expect(f.store.commandChecksPassed(identity, 'P1', oid(3), commandDigest(commands))).toBe(false);
  expect(f.released).toEqual([oid(2)]);
  await f.runner.close();
});

it('does not turn a nonzero or stopped command into passing evidence', async () => {
  for (const outcome of [{ exitCode: 1, stopReason: undefined }, { exitCode: 0, stopReason: 'cancelled' as const }]) {
    const f = fixture(async input => ({ attemptId: input.attemptId, context: input.context, exitCode: outcome.exitCode,
      signal: null, ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}), stdout: '', stderr: 'failed' }));
    const attempt = f.runner.start(identity, { expectedStateVersion: f.store.getTask(identity).stateVersion, kind: 'check', item: 'P1',
      deadline: Date.now() + 60_000, expectedContext: f.store.currentContext(identity) });
    await f.runner.settled(identity);
    expect(f.store.getAttempt(identity, attempt.id).state).toBe('failed');
    expect(f.store.commandChecksPassed(identity, 'P1', oid(2), commandDigest(commands))).toBe(false);
    await f.runner.close();
  }
});

it('invalidates an older pass when the latest check on the same head fails', async () => {
  let exitCode = 0;
  const f = fixture(async input => ({ attemptId: input.attemptId, context: input.context, exitCode, signal: null,
    stdout: '', stderr: exitCode ? 'failed' : '' }));
  for (const expected of [true, false]) {
    const attempt = f.runner.start(identity, { expectedStateVersion: f.store.getTask(identity).stateVersion, kind: 'check', item: 'P1',
      deadline: Date.now() + 60_000, expectedContext: f.store.currentContext(identity) });
    await f.runner.settled(identity);
    expect(f.store.getAttempt(identity, attempt.id).state).toBe(expected ? 'completed' : 'failed');
    expect(f.store.commandChecksPassed(identity, 'P1', oid(2), commandDigest(commands))).toBe(expected);
    exitCode = 1;
  }
  await f.runner.close();
});

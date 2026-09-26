import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../runner/store.ts';
import { ActionIdReused, GuardRefusal, classifySettlement, requestHash } from '../runner/lifecycle.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan = (summary = 'Example'): Plan => ({ schema_version: 1, revision: 1, issue: 1, summary, questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const oid = (n: number) => n.toString(16).padStart(40, '0');
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function open(path: string) { const store = new Store(path); stores.push(store); return store; }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-lifecycle-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite'), store = open(path);
  store.createPlan(JSON.stringify(plan()), 'json', context, oid(1), oid(2));
  return { path, store };
}
/** A task ready for work: moved from review to queued. */
function queued() { const f = fixture(); f.store.transitionTask(identity, f.store.getTask(identity).stateVersion, 'queued'); return f; }
const later = () => Date.now() + 60_000;
function admit(store: Store, extra: Partial<Parameters<Store['admitAttempt']>[1]> = {}) {
  return store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
    expectedContext: store.currentContext(identity), deadline: later(), ...extra });
}
const ok = { firstReason: null, exitCode: 0, valid: true } as const;
const settle = (store: Store, id: string, s: Partial<Parameters<Store['settleAttempt']>[2]> = {}) => store.settleAttempt(identity, id, { ...ok, ...s });

describe('settlement precedence', () => {
  it('orders first reason, context currency, D stop reason and exit status', () => {
    const base = { contextCurrent: true, exitCode: 0, valid: true };
    expect(classifySettlement({ ...base, firstReason: 'cancelled', exitCode: 1 }).state).toBe('cancelled');
    expect(classifySettlement({ ...base, firstReason: 'stale' }).state).toBe('stale');
    expect(classifySettlement({ ...base, firstReason: 'time-limit' })).toMatchObject({ state: 'cancelled', reason: 'Task time limit reached', timeLimit: true });
    // A D stop that came before shutdown wins; otherwise shutdown cancels.
    expect(classifySettlement({ ...base, firstReason: 'shutdown', stopReason: 'timeout' })).toMatchObject({ state: 'failed', reason: 'Timed out.' });
    expect(classifySettlement({ ...base, firstReason: 'shutdown', stopReason: 'shutdown' })).toMatchObject({ state: 'cancelled', reason: 'Stopped by shutdown' });
    // No reason and a changed context is stale, even when D timed out.
    expect(classifySettlement({ ...base, firstReason: null, contextCurrent: false, stopReason: 'timeout' }).state).toBe('stale');
    expect(classifySettlement({ ...base, firstReason: null, stopReason: 'output-limit', detail: 'too big' })).toMatchObject({ state: 'failed', reason: 'too big' });
    expect(classifySettlement({ ...base, firstReason: null }).state).toBe('completed');
    expect(classifySettlement({ ...base, firstReason: null, valid: false }).state).toBe('failed');
  });
  it('fingerprints requests independently of key order', () => {
    expect(requestHash('note', { a: 1, b: [2, { c: 3, d: 4 }] })).toBe(requestHash('note', { b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(requestHash('note', { a: 1 })).not.toBe(requestHash('reject', { a: 1 }));
  });
});

describe('schema v6', () => {
  it('backfills one task per v5 plan, closes merged plans once, and never treats a null budget as expired', () => {
    const { store, path } = fixture();
    const other = { ...identity, planId: 'merged' };
    store.createPlan(JSON.stringify(plan()), 'json', { ...context, identity: other }, oid(1), oid(3));
    const state = { revision: 1, snapshotId: store.getSnapshot(other).id, reviewVersion: store.reviewVersion(other) };
    const merge = store.beginMergeAttempt(other, state, oid(3), null, 'direct');
    store.finishMergeAttempt(other, merge.id, { state: 'merged' });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE feedback_events; DROP TABLE user_actions; DROP TABLE tasks; DROP TABLE attempts; PRAGMA user_version=5;');
    legacy.close();
    const migrated = open(path);
    const open1 = migrated.getTask(identity), closed = migrated.getTask(other);
    expect(open1).toMatchObject({ status: 'in review', stateVersion: 0, contextGeneration: 0, assignmentId: 'unassigned', referencedCodeHash: oid(2),
      currentAttemptId: null, requeuePending: false, cancelRequested: null, rebaseInProgress: null, budgetDeadline: null });
    expect(closed.status).toBe('merged');
    const events = migrated.feedbackEvents(other);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'task-closed', actionId: merge.id, sourceRef: closed.planKey });
    expect(() => migrated.feedbackEvents(identity)).toThrow(/after the task closes/);
    // Reopening a migrated v6 store changes nothing.
    expect(open(path).getTask(other).stateVersion).toBe(closed.stateVersion);
  });
});

describe('state version and context generation', () => {
  it('increase both on context changes, and only the state version on lifecycle changes', () => {
    const { store } = queued();
    const start = store.getTask(identity);
    store.importRevision(JSON.stringify(plan('Next')), 'json', context, 1);
    let now = store.getTask(identity);
    expect(now.contextGeneration).toBe(start.contextGeneration + 1); expect(now.stateVersion).toBeGreaterThan(start.stateVersion);
    store.recordHistory(identity, { revision: 2, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(4), []);
    expect(store.getTask(identity).contextGeneration).toBe(now.contextGeneration + 1);
    now = store.getTask(identity);
    store.setAssignment(identity, now.stateVersion, 'assignment-2', 'hash-2');
    const assigned = store.getTask(identity);
    expect(assigned.contextGeneration).toBe(now.contextGeneration + 1);
    const attempt = admit(store);
    const admitted = store.getTask(identity);
    expect(admitted.contextGeneration).toBe(assigned.contextGeneration);
    expect(admitted.stateVersion).toBe(assigned.stateVersion + 1);
    expect(attempt.context).toEqual({ snapshotId: store.getSnapshot(identity).id, planId: 'plan', planRevision: 2, assignmentId: 'assignment-2', referencedCodeHash: 'hash-2', stateVersion: assigned.contextGeneration });
  });
});

describe('admission', () => {
  it('requires an active task, the current state version, a current context and no active attempt', () => {
    const { store } = fixture();
    expect(() => admit(store)).toThrow(/in review/);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(() => admit(store, { expectedStateVersion: 0 })).toThrow(/Stale task state/);
    const staleContext = store.currentContext(identity);
    store.setAssignment(identity, store.getTask(identity).stateVersion, 'other', 'hash');
    expect(() => admit(store, { expectedContext: staleContext })).toThrow(GuardRefusal);
    expect(() => admit(store, { deadline: Date.now() - 1 })).toThrow(/future deadline/);
    const first = admit(store);
    expect(first).toMatchObject({ state: 'pending', kind: 'execute', phase: 'execute', item: 'P1', firstReason: null });
    const task = store.getTask(identity);
    expect(task).toMatchObject({ status: 'running', currentAttemptId: first.id });
    expect(task.budgetDeadline).toBeGreaterThan(Date.now());
    expect(() => admit(store)).toThrow(/already active/);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('lets exactly one of two processes admit work at the same moment', () => {
    const { store, path } = queued(); const other = open(path);
    const version = store.getTask(identity).stateVersion, ctx = store.currentContext(identity);
    const input = { expectedStateVersion: version, kind: 'execute' as const, expectedContext: ctx, deadline: later() };
    store.admitAttempt(identity, input);
    expect(() => other.admitAttempt(identity, input)).toThrow(GuardRefusal);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('refuses admission while recovery holds the requeue claim or a cancel is pending', () => {
    const { store, path } = queued();
    const db = new DatabaseSync(path); db.exec('UPDATE tasks SET requeue_pending=1'); db.close();
    expect(() => admit(store)).toThrow(/requeueing/);
  });
  it('starts the task budget at the first admission and keeps it across later attempts', () => {
    const { store } = queued();
    const first = admit(store, { budgetMs: 1000, now: 1_000_000, deadline: later() });
    const budget = store.getTask(identity).budgetDeadline;
    expect(budget).toBe(1_001_000);
    settle(store, first.id, { exitCode: 1 });
    admit(store, { retryOf: first.id });
    expect(store.getTask(identity).budgetDeadline).toBe(budget);
  });
});

describe('attempt transitions', () => {
  it('records the first reason once and refuses pending -> running after it', () => {
    const { store } = queued(); const attempt = admit(store);
    const before = store.getTask(identity).stateVersion;
    expect(store.recordFirstReason(identity, attempt.id, 'cancelled')).toBe(true);
    expect(store.recordFirstReason(identity, attempt.id, 'shutdown')).toBe(false);
    expect(store.getTask(identity).stateVersion).toBe(before + 1);
    expect(store.getAttempt(identity, attempt.id)).toMatchObject({ state: 'pending', firstReason: 'cancelled' });
    expect(store.markRunning(identity, attempt.id)).toBe(false);
    expect(settle(store, attempt.id, { exitCode: 0 }).state).toBe('cancelled');
  });
  it('keeps the first reason when a later provider error arrives', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    store.recordFirstReason(identity, attempt.id, 'cancelled');
    expect(settle(store, attempt.id, { exitCode: 1, valid: false }).state).toBe('cancelled');
    expect(store.getAttempt(identity, attempt.id)).toMatchObject({ state: 'cancelled', firstReason: 'cancelled', exitCode: 1 });
  });
  it('uses the in-memory first reason when its earlier write failed', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    expect(settle(store, attempt.id, { firstReason: 'shutdown', stopReason: 'shutdown' }).state).toBe('cancelled');
    expect(store.getAttempt(identity, attempt.id).firstReason).toBe('shutdown');
  });
  it('ends stale, not failed, when the context changed before a provider error or a D timeout', () => {
    for (const s of [{ exitCode: 1, valid: false }, { exitCode: null, stopReason: 'timeout' as const }]) {
      const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
      store.importRevision(JSON.stringify(plan('Moved')), 'json', context, 1);
      expect(settle(store, attempt.id, s).state).toBe('stale');
    }
  });
  it('publishes only a running attempt with a current context, and stores a bounded result', () => {
    const { store } = queued(); const attempt = admit(store);
    expect(() => settle(store, attempt.id, { result: { ok: 1 } })).toThrow(/running attempt can complete/);
    store.markRunning(identity, attempt.id);
    expect(settle(store, attempt.id, { result: { ok: 1 } }).state).toBe('completed');
    expect(store.getAttempt(identity, attempt.id)).toMatchObject({ state: 'completed', result: { ok: 1 } });
    const next = admit(store); store.markRunning(identity, next.id);
    expect(settle(store, next.id, { result: 'x'.repeat(1024 * 1024 + 1) })).toMatchObject({ state: 'failed', reason: 'The result exceeds 1 MiB.' });
  });
  it('freezes the task status while an attempt is active, and never completes into a non-running task', () => {
    const { store, path } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    expect(() => store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs amendment')).toThrow(/still active/);
    const db = new DatabaseSync(path); db.exec(`UPDATE tasks SET status='needs amendment'`); db.close();
    expect(settle(store, attempt.id, { result: 'late' })).toMatchObject({ state: 'cancelled', reason: 'The task left the running state before the result was saved.' });
    expect(store.getTask(identity).status).toBe('needs amendment');
  });
  it('refuses a late settlement from an old attempt after a retry, without touching the retry', () => {
    const { store } = queued(); const old = admit(store);
    store.recordFirstReason(identity, old.id, 'cancelled'); settle(store, old.id);
    const retry = admit(store, { retryOf: old.id }); store.markRunning(identity, retry.id);
    expect(() => settle(store, old.id)).toThrow(/not the active attempt/);
    expect(store.getAttempt(identity, retry.id).state).toBe('running');
    expect(store.getTask(identity).currentAttemptId).toBe(retry.id);
  });
  it('allows retry only of the latest failed or cancelled attempt with a current context', () => {
    const { store } = queued(); const first = admit(store); store.markRunning(identity, first.id);
    settle(store, first.id, { exitCode: 1, valid: false });
    store.setAssignment(identity, store.getTask(identity).stateVersion, 'other', 'hash');
    expect(() => admit(store, { retryOf: first.id })).toThrow(/out of date/);
    const second = admit(store); store.markRunning(identity, second.id); settle(store, second.id);
    expect(() => admit(store, { retryOf: second.id })).toThrow(/failed or cancelled/);
    expect(() => admit(store, { retryOf: first.id })).toThrow(/failed or cancelled/);
  });
});

describe('task closure', () => {
  it('closes a task with no active attempt at once, with one task-closed event', () => {
    const { store } = queued(); const actionId = randomUUID();
    expect(store.cancelTask(identity, store.getTask(identity).stateVersion, actionId)).toBe('closed');
    expect(store.getTask(identity).status).toBe('cancelled');
    expect(store.feedbackEvents(identity)).toMatchObject([{ kind: 'task-closed', actionId }]);
    expect(() => store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued')).toThrow(/never changes/);
    expect(() => admit(store)).toThrow(/cancelled/);
  });
  it('stops an active attempt first, then closes the task when it settles, even if it would have completed', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    const actionId = randomUUID();
    expect(store.cancelTask(identity, store.getTask(identity).stateVersion, actionId)).toBe('stopping');
    expect(store.getTask(identity)).toMatchObject({ status: 'running', cancelRequested: actionId });
    expect(settle(store, attempt.id, { result: 'late' }).state).toBe('cancelled');
    expect(store.getTask(identity)).toMatchObject({ status: 'cancelled', cancelRequested: null });
    expect(store.feedbackEvents(identity).filter(event => event.kind === 'task-closed')).toHaveLength(1);
  });
  it('lets a pending cancel task win over the time limit', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    store.recordFirstReason(identity, attempt.id, 'time-limit');
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    settle(store, attempt.id);
    expect(store.getTask(identity).status).toBe('cancelled');
  });
  it('moves a timed-out task to needs human, where retry is refused', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    store.recordFirstReason(identity, attempt.id, 'time-limit');
    expect(settle(store, attempt.id).state).toBe('cancelled');
    expect(store.getTask(identity).status).toBe('needs human');
    expect(() => admit(store, { retryOf: attempt.id })).toThrow(/needs human/);
  });
  it('refuses cancel task during a merge, and closes the task as merged when the merge is confirmed', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const merge = store.beginMergeAttempt(identity, state, oid(2), null, 'direct');
    expect(() => store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID())).toThrow(/merge is in progress/);
    store.finishMergeAttempt(identity, merge.id, { state: 'merged' });
    expect(store.getTask(identity).status).toBe('merged');
    expect(store.feedbackEvents(identity)).toMatchObject([{ kind: 'task-closed', actionId: merge.id }]);
  });
});

describe('user actions', () => {
  it('replays the saved response without applying the action again', () => {
    const { store } = queued(); const actionId = randomUUID(); let applied = 0;
    const run = () => store.userAction(identity, { actionId, kind: 'note', request: { text: 'hi' } }, () => ++applied);
    expect(run()).toEqual({ response: 1, replayed: false });
    expect(run()).toEqual({ response: 1, replayed: true });
    expect(applied).toBe(1);
    expect(() => store.userAction(identity, { actionId, kind: 'reject', request: { text: 'hi' } }, () => 0)).toThrow(ActionIdReused);
  });
  it('records a refusal and returns the same refusal after the state changes', () => {
    const { store } = queued(); const first = admit(store); store.markRunning(identity, first.id);
    const actionId = randomUUID();
    const retry = () => store.userAction(identity, { actionId, kind: 'retry', request: { attemptId: first.id } },
      () => admit(store, { retryOf: first.id }).id);
    expect(retry).toThrow(/already active/);
    settle(store, first.id, { exitCode: 1, valid: false });
    expect(retry).toThrow(/already active/);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('rejects malformed action IDs before storing anything, and does not record storage errors', () => {
    const { store } = queued();
    for (const actionId of ['x'.repeat(10_000), 'not-a-uuid', randomUUID().toUpperCase()])
      expect(() => store.userAction(identity, { actionId, kind: 'note', request: {} }, () => 1)).toThrow(/UUID v4/);
    const actionId = randomUUID();
    const storage = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
    expect(() => store.userAction(identity, { actionId, kind: 'note', request: {} }, () => { throw storage; })).toThrow(/disk/);
    expect(store.userAction(identity, { actionId, kind: 'note', request: {} }, () => 7)).toEqual({ response: 7, replayed: false });
  });
  it('writes feedback events only inside their action, and supersedes by source', () => {
    const { store } = queued();
    expect(() => store.recordFeedback(identity, randomUUID(), { kind: 'segment-assign', sourceRef: 'choice-1' })).toThrow(/inside their user action/);
    const firstId = randomUUID();
    const first = store.userAction(identity, { actionId: firstId, kind: 'assign', request: { item: 'P1' } },
      () => store.recordFeedback(identity, firstId, { kind: 'segment-assign', item: 'P1', sourceRef: 'choice-1' })).response;
    const secondId = randomUUID();
    store.userAction(identity, { actionId: secondId, kind: 'assign', request: { item: 'P2' } },
      () => store.recordFeedback(identity, secondId, { kind: 'segment-assign', item: 'P1', sourceRef: 'choice-1', supersedes: first.id }));
    const badId = randomUUID();
    expect(() => store.userAction(identity, { actionId: badId, kind: 'assign', request: {} },
      () => store.recordFeedback(identity, badId, { kind: 'segment-assign', sourceRef: 'choice-2', supersedes: first.id }))).toThrow(/same source/);
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    expect(store.feedbackEvents(identity).map(event => [event.kind, event.supersedes])).toEqual([['segment-assign', null], ['segment-assign', first.id], ['task-closed', null]]);
  });
  it('rolls back the action and its event together', () => {
    const { store } = queued(); const actionId = randomUUID();
    expect(() => store.userAction(identity, { actionId, kind: 'note', request: {} }, () => {
      store.recordFeedback(identity, actionId, { kind: 'change-request', item: 'P1', text: 'Fix', sourceRef: 'note-1' });
      throw new GuardRefusal('Refused after the event.');
    })).toThrow(/Refused after/);
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    expect(store.feedbackEvents(identity).map(event => event.kind)).toEqual(['task-closed']);
  });
});

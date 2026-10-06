import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, mergeActionResponse } from '../runner/store.ts';
import { SafetyFindings } from '../runner/execution.ts';
import { ActionIdReused, GuardRefusal, classifySettlement, requestHash } from '../runner/lifecycle.ts';
import type { Plan, PlanContext } from '../core/plan.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan = (summary = 'Example'): Plan => ({ schema_version: 1, revision: 1, issue: 1, summary, questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const oid = (n: number) => n.toString(16).padStart(40, '0');
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    // Without a first reason, any D stop reason is not a normal finish, even with exit 0 and valid output.
    for (const stopReason of ['cancelled', 'shutdown'] as const)
      expect(classifySettlement({ ...base, firstReason: null, stopReason })).toMatchObject({ state: 'failed', reason: `Agent stopped: ${stopReason}.` });
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

describe('schema v12 review ordering', () => {
  it('gives legacy choices a finite boundary so a later approval can authorize execution', () => {
    const { store, path } = fixture();
    const snapshot = store.getSnapshot(identity);
    store.saveReview(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) },
      [{ item: 'P1', fingerprint: 'legacy-approval' }],
      [{ key: 'legacy-choice', action: 'assign', item: 'P1' }]);
    store.close(); stores.splice(stores.indexOf(store), 1);
    const legacy = new DatabaseSync(path);
    legacy.exec(`UPDATE choices SET data=json_remove(data,'$.reviewVersion');
      UPDATE approvals SET data=json_remove(data,'$.reviewVersion');
      PRAGMA user_version=11;`);
    legacy.close();

    const migrated = open(path), migratedVersion = migrated.reviewVersion(identity);
    expect(migrated.getReview(identity).choices[0]!.reviewVersion).toBe(migratedVersion - 1);
    // Execution already treats an unversioned approval as invalid. Remove it too, so the review UI renders the item
    // unreviewed and leaves its approval control available instead of showing an unusable approved state.
    expect(migrated.getReview(identity).approvals).toEqual([]);
    expect(migrated.unapprovedExecutionItems(identity, 1)).toEqual(['P1']);
    migrated.saveReview(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: migratedVersion },
      [{ item: 'P1', fingerprint: 'approved-after-upgrade' }], []);
    expect(migrated.unapprovedExecutionItems(identity, 1)).toEqual([]);
    expect(new DatabaseSync(path).prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  });
});

describe('schema v6 backfill context', () => {
  it('attributes a backfilled closure to the snapshot that merged, not to a later HEAD observation', () => {
    const { store, path } = fixture();
    const merged = store.getSnapshot(identity).id;
    const state = { revision: 1, snapshotId: merged, reviewVersion: store.reviewVersion(identity) };
    const merge = store.beginMergeAttempt(identity, state, oid(2), null, 'direct');
    store.finishMergeAttempt(identity, merge.id, { state: 'merged' });
    store.recordHistory(identity, { revision: 1, snapshotId: merged }, oid(1), oid(6), []);
    expect(store.getSnapshot(identity).id).not.toBe(merged);
    store.close(); stores.splice(stores.indexOf(store), 1);
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE feedback_events; DROP TABLE user_actions; DROP TABLE tasks; DROP TABLE attempts; PRAGMA user_version=5;');
    legacy.close();
    expect(open(path).feedbackEvents(identity)).toMatchObject([{ kind: 'task-closed', actionId: merge.id, planRevision: 1, snapshotId: merged }]);
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
    // Inside the budget; an expired budget refuses admission (see "refuses admission once the whole-task budget...").
    admit(store, { retryOf: first.id, now: 1_000_500 });
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
  it('refuses approvals and choices during a merge, but still takes notes', () => {
    const { store } = fixture();
    const state = () => ({ revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
    store.beginMergeAttempt(identity, state(), oid(2), null, 'direct');
    expect(() => store.saveReview(identity, state(), [], [])).toThrow(/merge is in progress/);
    // Notes (questions and change requests) change no reviewed code; a queued merge may take a while.
    expect(store.addReviewNote(identity, state(), 'P1', 'question', 'Why this?').kind).toBe('question');
    expect(store.addReviewNote(identity, state(), 'P1', 'change', 'Change it.').kind).toBe('change');
  });
  it('refuses a feedback event after the task has closed', () => {
    const { store } = fixture();
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    const actionId = randomUUID();
    expect(() => store.userAction(identity, { actionId, kind: 'assign', request: { item: 'P1' } },
      () => store.recordFeedback(identity, actionId, { kind: 'segment-assign', item: 'P1', sourceRef: 'choice-late' }))).toThrow(/closed task never changes/);
    expect(store.feedbackEvents(identity).map(event => event.kind)).toEqual(['task-closed']);
  });
  it('refuses review approvals, choices and notes on a closed task', () => {
    const { store } = fixture();
    const state = () => ({ revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    const version = store.reviewVersion(identity);
    expect(() => store.saveReview(identity, state(), [], [])).toThrow(/closed task never changes/);
    expect(() => store.addReviewNote(identity, state(), 'P1', 'change', 'Too late.')).toThrow(/closed task never changes/);
    expect(store.reviewVersion(identity)).toBe(version);
  });
  it('refuses rebase and ledger writes during a merge and after closing, but still observes HEAD', () => {
    const { store } = fixture();
    const reviewed = () => ({ revision: 1, snapshotId: store.getSnapshot(identity).id });
    const merge = store.beginMergeAttempt(identity, { ...reviewed(), reviewVersion: store.reviewVersion(identity) }, oid(2), null, 'direct');
    const entry = { sha: oid(7), owner: 'P1', origin: 'owned' as const, sourceSha: null };
    expect(() => store.recordRebase(identity, reviewed(), oid(1), oid(7), [{ oldSha: oid(2), newSha: oid(7) }])).toThrow(/merge is in progress/);
    expect(() => store.recordHistory(identity, reviewed(), oid(1), oid(7), [entry])).toThrow(/merge is in progress/);
    expect(store.getLedger(identity).map(e => e.sha)).not.toContain(oid(7));
    store.recordHistory(identity, reviewed(), oid(1), oid(8), []);
    expect(store.getSnapshot(identity).head).toBe(oid(8));
    store.finishMergeAttempt(identity, merge.id, { state: 'merged' });
    expect(() => store.recordRebase(identity, reviewed(), oid(1), oid(9), [{ oldSha: oid(8), newSha: oid(9) }])).toThrow(/closed task never changes/);
  });
  it('refuses plan edits on a closed task and keeps its counters while HEAD is still observed', () => {
    const { store } = fixture();
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    const closed = store.getTask(identity);
    expect(() => store.importRevision(JSON.stringify(plan('After close')), 'json', context, 1)).toThrow(/closed task never changes/);
    expect(store.getPlan(identity).revision).toBe(1);
    store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(5), []);
    expect(store.getSnapshot(identity).head).toBe(oid(5));
    expect(store.getTask(identity)).toMatchObject({ status: 'cancelled', stateVersion: closed.stateVersion, contextGeneration: closed.contextGeneration });
  });
  it('refuses plan edits during a merge and closes the task in the context it merged', () => {
    const { store } = fixture();
    const reviewed = store.getSnapshot(identity).id;
    const state = { revision: 1, snapshotId: reviewed, reviewVersion: store.reviewVersion(identity) };
    const merge = store.beginMergeAttempt(identity, state, oid(2), null, 'direct');
    expect(() => store.importRevision(JSON.stringify(plan('Late edit')), 'json', context, 1)).toThrow(/merge is in progress/);
    // HEAD observation still works during the merge; the merge stays pinned to the reviewed head.
    store.recordHistory(identity, { revision: 1, snapshotId: reviewed }, oid(1), oid(4), []);
    expect(store.getSnapshot(identity).id).not.toBe(reviewed);
    store.finishMergeAttempt(identity, merge.id, { state: 'merged' });
    expect(store.feedbackEvents(identity)).toMatchObject([{ kind: 'task-closed', planRevision: 1, snapshotId: reviewed }]);
  });
  it('refuses reassignment while a merge is in flight and counts merge changes in the state version', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const before = store.getTask(identity);
    const merge = store.beginMergeAttempt(identity, state, oid(2), 'cursor', 'queue');
    const begun = store.getTask(identity);
    expect(begun.stateVersion).toBe(before.stateVersion + 1);
    expect(begun.contextGeneration).toBe(before.contextGeneration);
    expect(() => store.setAssignment(identity, begun.stateVersion, 'other', 'other-hash')).toThrow(/merge is in progress/);
    store.queueMergeAttempt(identity, merge.id, 'https://github.com/o/r/pull/1');
    expect(store.getTask(identity).stateVersion).toBe(begun.stateVersion + 1);
    store.finishMergeAttempt(identity, merge.id, { state: 'removed', reason: 'Removed from the queue.' });
    const finished = store.getTask(identity);
    expect(finished.stateVersion).toBe(begun.stateVersion + 2);
    expect(finished.contextGeneration).toBe(before.contextGeneration);
    store.setAssignment(identity, finished.stateVersion, 'other', 'other-hash');
  });
  it('refuses to reassign work on a closed task', () => {
    const { store } = fixture();
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    const closed = store.getTask(identity);
    expect(() => store.setAssignment(identity, closed.stateVersion, 'late', 'late-hash')).toThrow(/closed task never changes/);
    expect(store.getTask(identity)).toMatchObject({ assignmentId: closed.assignmentId, referencedCodeHash: closed.referencedCodeHash, stateVersion: closed.stateVersion });
  });
  it('keeps the budget handoff when the refused admission runs inside a user action', () => {
    const { store } = queued(); const start = Date.now(), actionId = randomUUID();
    const first = admit(store, { budgetMs: 1_000, now: start });
    settle(store, first.id, { exitCode: 1 });
    const retry = () => store.userAction(identity, { actionId, kind: 'retry', request: { attemptId: first.id } },
      () => admit(store, { retryOf: first.id, now: start + 1_000 }).id);
    expect(retry).toThrow(/budget has run out/);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toHaveLength(1);
    expect(retry).toThrow(/budget has run out/);
  });
  it('refuses admission once the whole-task budget has run out, and hands the task to a person', () => {
    const { store } = queued(); const start = Date.now();
    const first = admit(store, { budgetMs: 1_000, now: start });
    settle(store, first.id, { exitCode: 1 });
    expect(store.getTask(identity).status).toBe('running');
    expect(() => admit(store, { retryOf: first.id, now: start + 1_000 })).toThrow(/budget has run out/);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toHaveLength(1);
    expect(() => admit(store, { now: start + 1_000 })).toThrow(/needs human/);
  });
  it('refuses a stale merge after the task was cancelled, so a closed task never closes twice', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const loaded = store.getTask(identity).stateVersion;
    expect(store.cancelTask(identity, loaded, randomUUID())).toBe('closed');
    expect(() => store.beginMergeAttempt(identity, state, oid(2), null, 'direct')).toThrow(/cancelled; it cannot be merged/);
    expect(store.getMergeAttempt(identity)).toBeNull();
    expect(store.getTask(identity).status).toBe('cancelled');
    expect(store.feedbackEvents(identity).filter(event => event.kind === 'task-closed')).toHaveLength(1);
  });
  it('refuses runner status changes while a merge is submitting or queued', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const merge = store.beginMergeAttempt(identity, state, oid(2), 'cursor', 'queue');
    expect(() => store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued')).toThrow(/merge is in progress/);
    store.queueMergeAttempt(identity, merge.id, 'https://github.com/o/r/pull/1');
    expect(() => store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued')).toThrow(/merge is in progress/);
    store.finishMergeAttempt(identity, merge.id, { state: 'removed', reason: 'Removed from the queue.' });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect(store.getTask(identity).status).toBe('queued');
  });
  it('refuses a merge while an attempt runs or the task is not in review', () => {
    const { store } = queued();
    const state = () => ({ revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
    expect(() => store.beginMergeAttempt(identity, state(), oid(2), null, 'direct')).toThrow(/queued; merge it from review/);
    admit(store);
    expect(() => store.beginMergeAttempt(identity, state(), oid(2), null, 'direct')).toThrow(/cannot be merged|merge it from review/);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });
  it('refuses a feedback event whose action ID is not the enclosing user action', () => {
    const { store } = fixture(); const actionId = randomUUID(), other = randomUUID();
    expect(() => store.userAction(identity, { actionId, kind: 'assign', request: { item: 'P1' } },
      () => store.recordFeedback(identity, other, { kind: 'segment-assign', item: 'P1', sourceRef: 'choice-1' }))).toThrow(/with its action ID/);
    store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    expect(store.feedbackEvents(identity).map(event => event.kind)).toEqual(['task-closed']);
  });
  it('refuses a merge whose expected task state version has moved on', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const loaded = store.getTask(identity).stateVersion;
    store.transitionTask(identity, loaded, 'approved but merge blocked');
    expect(() => store.beginMergeAttempt(identity, state, oid(2), null, 'direct', null, loaded)).toThrow(/Stale task state/);
    expect(store.getMergeAttempt(identity)).toBeNull();
    expect(store.beginMergeAttempt(identity, state, oid(2), null, 'direct', null, store.getTask(identity).stateVersion).state).toBe('submitting');
  });
  it('replays a lost merge click as the attempt\'s current outcome, not the saved "in progress"', () => {
    const { store } = fixture();
    const state = { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
    const actionId = randomUUID(), otherId = randomUUID();
    store.userAction(identity, { actionId: otherId, kind: 'note', request: { text: 'unrelated' } }, () => 'kept');
    let starts = 0;
    const click = () => store.userAction(identity, { actionId, kind: 'merge', request: { head: oid(2) } },
      () => { starts += 1; return mergeActionResponse(store.beginMergeAttempt(identity, state, oid(2), 'cursor', 'queue', actionId)); });
    const first = click().response;
    expect(first).toMatchObject({ state: 'submitting', reason: null, url: null });
    store.queueMergeAttempt(identity, first.attemptId, 'https://github.com/o/r/pull/1');
    expect(click()).toEqual({ replayed: true, response: { attemptId: first.attemptId, state: 'queued', reason: null, url: 'https://github.com/o/r/pull/1' } });
    store.finishMergeAttempt(identity, first.attemptId, { state: 'merged' });
    expect(click()).toEqual({ replayed: true, response: { attemptId: first.attemptId, state: 'merged', reason: null, url: 'https://github.com/o/r/pull/1' } });
    expect(starts).toBe(1);
    expect(store.userAction(identity, { actionId: otherId, kind: 'note', request: { text: 'unrelated' } }, () => 'changed'))
      .toEqual({ response: 'kept', replayed: true });
    expect(() => store.beginMergeAttempt(identity, state, oid(2), null, 'direct', 'not-a-uuid')).toThrow(/UUID v4/);
  });
  it('does not save a busy or locked database as a refusal, so the same action may be resent', () => {
    const { path, store } = fixture(); const actionId = randomUUID();
    // A second connection writing while this Store holds its transaction gets SQLite's real "database is locked".
    const other = new DatabaseSync(path, { timeout: 0 });
    try {
      expect(() => store.userAction(identity, { actionId, kind: 'note', request: { text: 'hi' } },
        () => other.exec("INSERT INTO app_settings VALUES ('probe','1')"))).toThrow(/database is locked/);
    } finally { other.close(); }
    expect(store.savedAction(identity, { actionId, kind: 'note', request: { text: 'hi' } })).toBeUndefined();
    expect(store.userAction(identity, { actionId, kind: 'note', request: { text: 'hi' } }, () => 'applied')).toEqual({ response: 'applied', replayed: false });
  });
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

describe('pre-merge rebase ownership', () => {
  const reviewed = (store: Store) => ({ revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });

  it('claims one exact attempt and blocks merge and runner admission until it settles', () => {
    const { store } = fixture(), expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    store.transitionTask(identity, taskVersion, 'approved but merge blocked');
    const readyVersion = store.getTask(identity).stateVersion;
    expect(() => store.beginRebase(identity, { revision: expected.revision, snapshotId: expected.snapshotId } as typeof expected,
      readyVersion, { oldBase: oid(1), oldHead: oid(2), onto: oid(3) })).toThrow(/current review version/);
    const marker = store.beginRebase(identity, expected, readyVersion, { oldBase: oid(1), oldHead: oid(2), onto: oid(3), startedAt: 123 });
    expect(store.getTask(identity).rebaseInProgress).toEqual({ attemptId: marker.attemptId, oldBase: oid(1), oldHead: oid(2), onto: oid(3), startedAt: 123,
      processGroup: null });
    const group = { pgid: 4242, startedAt: 456 };
    expect(() => store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, null,
      { pgid: 1, startedAt: 456 })).toThrow(/Invalid rebase process group/);
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, null, 'spawning');
    expect(() => store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, null, group)).toThrow(/Another Git process/);
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, 'spawning', group);
    expect(store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: { pgid: 4242, startedAt: 456 } });
    expect(() => store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, null,
      { pgid: 5252, startedAt: 567 })).toThrow(/Another Git process/);
    expect(() => store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId,
      { pgid: 3131, startedAt: 345 }, null)).toThrow(/Another Git process/);
    expect(store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: group });
    expect(() => store.setRebaseProcessGroup(store.getTask(identity).planKey, randomUUID(), null, null)).toThrow(/no longer owns/);
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, group, null);
    expect(() => store.beginRebase(identity, expected, store.getTask(identity).stateVersion,
      { oldBase: oid(1), oldHead: oid(2), onto: oid(3) })).toThrow(/already in progress/);
    expect(() => store.beginMergeAttempt(identity, expected, oid(2), null, 'direct')).toThrow(/rebase is in progress/);
    expect(() => store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued')).toThrow(/rebase is in progress/);
    expect(() => store.setAssignment(identity, store.getTask(identity).stateVersion, 'other', 'other-head')).toThrow(/rebase is in progress/);
  });

  it('publishes only a current attempt and preserves owned and foreign ledger provenance', () => {
    const { store } = fixture();
    store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(4), [
      { sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null },
      { sha: oid(4), owner: null, origin: 'foreign', sourceSha: null },
    ]);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
    const expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    const marker = store.beginRebase(identity, expected, taskVersion, { oldBase: oid(1), oldHead: oid(4), onto: oid(5) });
    expect(() => store.finishRebase(identity, { revision: expected.revision, snapshotId: expected.snapshotId } as typeof expected,
      taskVersion, marker.attemptId, oid(5), oid(7), [
        { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(7) },
      ])).toThrow(/current review version/);
    expect(() => store.finishRebase(identity, expected, taskVersion, randomUUID(), oid(5), oid(7), [
      { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(7) },
    ])).toThrow(/no longer owns/);
    expect(() => store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(5), oid(7), [
      { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(8) },
    ])).toThrow(/does not end/);
    const group = { pgid: 4242, startedAt: 456 };
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, null, 'spawning');
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, 'spawning', group);
    expect(() => store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(5), oid(7), [
      { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(7) },
    ])).toThrow(/has not settled/);
    store.setRebaseProcessGroup(store.getTask(identity).planKey, marker.attemptId, group, null);
    const snapshot = store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(5), oid(7), [
      { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(7) },
    ]);
    expect(snapshot).toMatchObject({ base: oid(5), head: oid(7) });
    expect(store.getTask(identity).rebaseInProgress).toBeNull();
    expect(store.getLedger(identity)).toEqual(expect.arrayContaining([
      { sha: oid(6), owner: 'P1', origin: 'owned', sourceSha: oid(3) },
      { sha: oid(7), owner: null, origin: 'foreign', sourceSha: oid(4) },
    ]));
    expect(store.getRewrites(identity, snapshot.id)).toEqual([
      { oldSha: oid(3), newSha: oid(6) }, { oldSha: oid(4), newSha: oid(7) },
    ]);
  });

  it('fails closed when review state changes, and clears only by the exact recovery handle', () => {
    const { store } = fixture();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
    const expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    const marker = store.beginRebase(identity, expected, taskVersion, { oldBase: oid(1), oldHead: oid(2), onto: oid(3) });
    store.addReviewNote(identity, expected, 'P1', 'change', 'Review changed while Git was running.');
    expect(() => store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(3), oid(4), [
      { oldSha: oid(2), newSha: oid(4) },
    ])).toThrow(/Stale review state/);
    expect(store.abortRebase(store.getTask(identity).planKey, randomUUID())).toBe(false);
    expect(store.getTask(identity).rebaseInProgress).not.toBeNull();
    expect(store.abortRebase(store.getTask(identity).planKey, marker.attemptId)).toBe(true);
    expect(store.abortRebase(store.getTask(identity).planKey, marker.attemptId)).toBe(false);
    expect(store.getTask(identity).rebaseInProgress).toBeNull();
  });

  it('accepts an empty mapping only when the captured history and rewritten result are both empty', () => {
    const { store } = fixture();
    const current = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: 1, snapshotId: current.id }, oid(1), oid(1), []);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
    const expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    const marker = store.beginRebase(identity, expected, taskVersion, { oldBase: oid(1), oldHead: oid(1), onto: oid(5) });
    expect(() => store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(5), oid(6), []))
      .toThrow(/does not end/);
    expect(store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(5), oid(5), []))
      .toMatchObject({ base: oid(5), head: oid(5) });
  });

  it('rejects a result after another durable task change without erasing its recovery marker', () => {
    const { store } = fixture();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
    const expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    const marker = store.beginRebase(identity, expected, taskVersion, { oldBase: oid(1), oldHead: oid(2), onto: oid(3) });
    expect(store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
    expect(() => store.finishRebase(identity, expected, taskVersion, marker.attemptId, oid(3), oid(4), [
      { oldSha: oid(2), newSha: oid(4) },
    ])).toThrow(/task changed during the rebase/);
    expect(store.getTask(identity).rebaseInProgress).toMatchObject({ attemptId: marker.attemptId });
    expect(store.abortRebase(store.getTask(identity).planKey, marker.attemptId)).toBe(true);
    expect(store.getTask(identity)).toMatchObject({ status: 'cancelled', rebaseInProgress: null });
  });

  it('binds a claim to both ends of the reviewed snapshot and blocks the legacy rewrite path', () => {
    const { store } = fixture();
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
    const expected = reviewed(store), taskVersion = store.getTask(identity).stateVersion;
    expect(() => store.beginRebase(identity, expected, taskVersion,
      { oldBase: oid(9), oldHead: oid(2), onto: oid(3) })).toThrow(/base or head changed/);
    const marker = store.beginRebase(identity, expected, taskVersion,
      { oldBase: oid(1), oldHead: oid(2), onto: oid(3) });
    expect(() => store.recordRebase(identity, expected, oid(3), oid(4), [
      { oldSha: oid(2), newSha: oid(4) },
    ])).toThrow(/claimed rebase is in progress/);
    expect(store.abortRebase(store.getTask(identity).planKey, marker.attemptId)).toBe(true);
  });
});

describe('runner commits and preparation groups (#87)', () => {
  it('knows a task has a runner commit only from a completed writable attempt whose result made one', () => {
    const { store } = queued();
    expect(store.hasRunnerCommit(identity)).toBe(false);
    const unchanged = admit(store); store.markRunning(identity, unchanged.id);
    settle(store, unchanged.id, { result: { head: oid(2), unchanged: true, inScope: [], outOfScope: [] } });
    expect(store.hasRunnerCommit(identity)).toBe(false);
    const failed = admit(store); store.markRunning(identity, failed.id);
    settle(store, failed.id, { exitCode: 1, valid: false });
    expect(store.hasRunnerCommit(identity)).toBe(false);
    const committed = admit(store); store.markRunning(identity, committed.id);
    settle(store, committed.id, { result: { head: oid(3), unchanged: false, inScope: ['a'], outOfScope: [] },
      history: { base: oid(1), head: oid(3), entries: [{ sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null }] } });
    expect(store.hasRunnerCommit(identity)).toBe(true);
  });

  it('keeps each recorded preparation group paired with its own start time', () => {
    const { store } = queued(); const attempt = admit(store);
    store.markPreparationStarting(identity, attempt.id, 1_000);
    store.recordPreparationGroup(identity, attempt.id, 4242, 41_000);
    expect(store.interruptedAttempts()[0]).toMatchObject({ preparationPgid: 4242, preparationStartedAt: 41_000 });
    // Without a time, the marker's own stays.
    store.recordPreparationGroup(identity, attempt.id, 4343);
    expect(store.interruptedAttempts()[0]).toMatchObject({ preparationPgid: 4343, preparationStartedAt: 41_000 });
    expect(() => store.recordPreparationGroup(identity, attempt.id, 4444, 1.5)).toThrow('start time');
  });
});

describe('after commit (#79)', () => {
  it('runs at once outside a transaction, after the outermost commit inside one, and drops the callback on rollback', () => {
    const { store } = queued();
    const calls: string[] = [];
    store.afterCommit(() => calls.push('outside'));
    expect(calls).toEqual(['outside']);
    store.userAction(identity, { actionId: randomUUID(), kind: 'note', request: {} }, () => {
      store.afterCommit(() => calls.push('first'), () => calls.push('first rolled back'));
      store.afterCommit(() => calls.push('second'));
      expect(calls).toEqual(['outside']);
    });
    expect(calls).toEqual(['outside', 'first', 'second']);
    expect(() => store.userAction(identity, { actionId: randomUUID(), kind: 'note', request: {} }, () => {
      store.afterCommit(() => calls.push('dropped'), () => calls.push('rolled back'));
      throw new Error('commit failed');
    })).toThrow(/commit failed/);
    expect(calls).toEqual(['outside', 'first', 'second', 'rolled back']);
  });
  it('keeps a committed action committed when a callback throws, and still runs the later callbacks', () => {
    const { store } = queued();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let ran = false;
    const actionId = randomUUID();
    const outcome = store.userAction(identity, { actionId, kind: 'note', request: {} }, () => {
      store.afterCommit(() => { throw new Error('callback failed'); });
      store.afterCommit(() => { ran = true; });
      return 'done';
    });
    expect(outcome).toEqual({ response: 'done', replayed: false });
    expect(ran).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(store.savedAction(identity, { actionId, kind: 'note', request: {} })).toEqual({ response: 'done', replayed: true });
  });
  it('drops the callback and runs the rollback one when COMMIT itself fails', () => {
    const { store } = queued();
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
      return exec.call(this, sql);
    });
    const calls: string[] = [], actionId = randomUUID();
    expect(() => store.userAction(identity, { actionId, kind: 'note', request: {} }, () => {
      store.afterCommit(() => calls.push('committed'), () => calls.push('rolled back'));
    })).toThrow(/disk I\/O error/);
    expect(calls).toEqual(['rolled back']);
    expect(store.savedAction(identity, { actionId, kind: 'note', request: {} })).toBeUndefined();
  });
  it('reports the COMMIT error, not a failed ROLLBACK, when SQLite already rolled back', () => {
    const { store } = queued();
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql !== 'COMMIT') return exec.call(this, sql);
      exec.call(this, 'ROLLBACK');
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
    });
    expect(() => store.userAction(identity, { actionId: randomUUID(), kind: 'note', request: {} }, () => 'done')).toThrow(/disk is full/);
  });
  it('refuses later writes once SQLite rolled back the transaction on its own, so nothing autocommits', () => {
    const { store } = queued(); const attempt = admit(store);
    const prepare = DatabaseSync.prototype.prepare;
    let failed = false;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (failed || !sql.startsWith('UPDATE attempts SET first_reason')) return prepare.call(this, sql);
      failed = true;
      return { run: () => { this.exec('ROLLBACK'); throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' }); } } as unknown as ReturnType<typeof prepare>;
    });
    const actionId = randomUUID(), committed: string[] = [];
    expect(() => store.userAction(identity, { actionId, kind: 'cancel-task', request: {} }, () => {
      try { store.recordFirstReason(identity, attempt.id, 'cancelled'); } catch { /* the caller carries on, as the coordinator does */ }
      store.afterCommit(() => committed.push('stop'));
      return store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID());
    })).toThrow(/rolled back the transaction/);
    expect(committed).toEqual([]);
    expect(store.savedAction(identity, { actionId, kind: 'cancel-task', request: {} })).toBeUndefined();
    expect(store.getAttempt(identity, attempt.id).firstReason).toBeNull();
    expect(store.getTask(identity).cancelRequested).toBeNull();
  });
  it('lets a throw outside a transaction reach the caller, and runs a callback registered by a commit callback', () => {
    const { store } = queued();
    expect(() => store.afterCommit(() => { throw new Error('cancel failed'); })).toThrow(/cancel failed/);
    const calls: string[] = [];
    store.userAction(identity, { actionId: randomUUID(), kind: 'note', request: {} }, () => {
      store.afterCommit(() => { calls.push('outer'); store.afterCommit(() => calls.push('inner')); });
    });
    expect(calls).toEqual(['outer', 'inner']);
  });
});

describe('durable safety findings (#87 item 3)', () => {
  it('keeps the first finding of an active attempt, and acts on it in the terminal write, whatever the outcome', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    expect(store.recordSafetyFinding(identity, attempt.id, 'Safety violation: .git changed')).toBe(true);
    expect(store.recordSafetyFinding(identity, attempt.id, 'a later one')).toBe(false);
    // A stop wins the outcome; the finding still sends the task to a person, and its text stays on the row.
    store.recordFirstReason(identity, attempt.id, 'cancelled');
    expect(settle(store, attempt.id, { exitCode: null, valid: false }).state).toBe('cancelled');
    expect(store.getAttempt(identity, attempt.id)).toMatchObject({ state: 'cancelled', safetyFinding: 'Safety violation: .git changed' });
    expect(store.getTask(identity).status).toBe('needs human');
    // Nothing more can be recorded once settled, and nothing new is admitted from needs human.
    expect(store.recordSafetyFinding(identity, attempt.id, 'too late')).toBe(false);
    expect(() => admit(store)).toThrow(/needs human/);
  });

  it('lets a pending cancel close the task, and leaves an attempt without a finding alone', () => {
    const cancelled = queued(); const one = admit(cancelled.store); cancelled.store.markRunning(identity, one.id);
    cancelled.store.recordSafetyFinding(identity, one.id, 'Safety violation: x');
    cancelled.store.cancelTask(identity, cancelled.store.getTask(identity).stateVersion, randomUUID());
    settle(cancelled.store, one.id, { exitCode: 1, valid: false });
    expect(cancelled.store.getTask(identity).status).toBe('cancelled');
    const clean = queued(); const two = admit(clean.store); clean.store.markRunning(identity, two.id);
    settle(clean.store, two.id, { exitCode: 1, valid: false });
    expect(clean.store.getTask(identity).status).toBe('running');
    expect(clean.store.getAttempt(identity, two.id).safetyFinding).toBeNull();
  });

  it('acts on a finding a crash left unsettled, and does not requeue its task', () => {
    const { store } = queued(); const attempt = admit(store); store.markRunning(identity, attempt.id);
    store.recordSafetyFinding(identity, attempt.id, 'Safety violation: link target changed');
    expect(store.recoverInterrupted(Date.now())).toEqual([expect.objectContaining({ attemptId: attempt.id, requeued: false })]);
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempt(identity, attempt.id).safetyFinding).toBe('Safety violation: link target changed');
  });

  it('adds the finding column to a version 7 database', () => {
    const { path, store } = queued(); const attempt = admit(store);
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE attempts DROP COLUMN safety_finding; PRAGMA user_version=7;'); db.close();
    const reopened = open(path);
    expect(reopened.getAttempt(identity, attempt.id).safetyFinding).toBeNull();
    expect(new DatabaseSync(path).prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  });

  it('adds the durable owed marker to a version 12 database', () => {
    const { path, store } = queued();
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE attempts DROP COLUMN safety_owed; PRAGMA user_version=12;'); db.close();
    const reopened = open(path);
    expect(reopened.owedSafetyFindings()).toEqual([]);
    expect(new DatabaseSync(path).prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  });

  it('restores and clears an escalation owed behind a human gate across real store reopens', () => {
    const { path, store } = queued(), attempt = admit(store); store.markRunning(identity, attempt.id);
    settle(store, attempt.id, { exitCode: 1, valid: false });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs approval');
    expect(store.recordOwedSafetyFinding(identity, attempt.id, 'Safety violation: durable restart')).toBe(false);
    store.close(); stores.splice(stores.indexOf(store), 1);

    const reopened = open(path), findings = new SafetyFindings(reopened);
    expect(findings.get(attempt.id)).toBe('Safety violation: durable restart');
    reopened.transitionTask(identity, reopened.getTask(identity).stateVersion, 'queued');
    expect(findings.persist(attempt.id)).toBe(true);
    expect(reopened.getTask(identity).status).toBe('needs human');
    reopened.close(); stores.splice(stores.indexOf(reopened), 1);
    expect(new SafetyFindings(open(path)).get(attempt.id)).toBeUndefined();
  });
});

describe('allocation baseline (#91)', () => {
  it('saves the baseline once, for the pending attempt\'s own allocation, and hands it to recovery', () => {
    const { store } = queued(); const attempt = admit(store), allocationId = randomUUID();
    expect(() => store.recordAllocationBaseline(identity, attempt.id, allocationId, 'b'.repeat(64), oid(2))).toThrow(GuardRefusal);
    store.recordAllocation(identity, attempt.id, allocationId);
    expect(() => store.recordAllocationBaseline(identity, attempt.id, randomUUID(), 'b'.repeat(64), oid(2))).toThrow(GuardRefusal);
    expect(() => store.recordAllocationBaseline(identity, attempt.id, allocationId, 'short', oid(2))).toThrow(/baseline/);
    expect(() => store.recordAllocationBaseline(identity, attempt.id, allocationId, 'b'.repeat(64), 'HEAD')).toThrow(/base commit/);
    store.recordAllocationBaseline(identity, attempt.id, allocationId, 'b'.repeat(64), oid(2));
    expect(() => store.recordAllocationBaseline(identity, attempt.id, allocationId, 'c'.repeat(64), oid(2))).toThrow(GuardRefusal);
    expect(store.attemptAllocation(attempt.id)).toBe(allocationId);
    expect(store.interruptedAttempts()).toEqual([expect.objectContaining({ id: attempt.id, allocationId, metadataBaseline: 'b'.repeat(64), storageBase: oid(2) })]);
  });
  it('adds the baseline columns to a version 8 database', () => {
    const { path, store } = queued(); const attempt = admit(store);
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE attempts DROP COLUMN metadata_baseline; ALTER TABLE attempts DROP COLUMN storage_base; PRAGMA user_version=8;'); db.close();
    const reopened = open(path);
    expect(reopened.interruptedAttempts()).toEqual([expect.objectContaining({ id: attempt.id, metadataBaseline: null, storageBase: null })]);
    expect(new DatabaseSync(path).prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  });
});
describe('publish outcomes (#103)', () => {
  it('adds the outcome table to a version 9 database, and records an outcome without moving the task', () => {
    const { path, store } = queued();
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE publish_outcomes; PRAGMA user_version=9;'); db.close();
    const reopened = open(path), before = reopened.getTask(identity);
    expect(reopened.lastPublish(identity)).toBeNull();
    expect(reopened.recordPublish(identity, { outcome: 'refused', draft: false, message: 'x'.repeat(3000) }))
      .toMatchObject({ outcome: 'refused', stateVersion: before.stateVersion, message: 'x'.repeat(2000) });
    reopened.recordPublish(identity, { outcome: 'opened', draft: false, message: 'Pull request #1 is open.', number: 1, url: 'https://github.com/o/r/pull/1' });
    expect(reopened.lastPublish(identity)).toMatchObject({ outcome: 'opened', number: 1 });
    expect(reopened.getTask(identity)).toEqual(before);
    expect(new DatabaseSync(path).prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  });
  it('stamps an outcome with the version the publish saw, and refuses one it cannot have seen (#114)', () => {
    const { store } = queued(), version = store.getTask(identity).stateVersion;
    expect(store.recordPublish(identity, { outcome: 'opened', draft: false, message: 'x' }, undefined, version)).toMatchObject({ stateVersion: version });
    expect(() => store.recordPublish(identity, { outcome: 'opened', draft: false, message: 'x' }, undefined, store.getTask(identity).stateVersion + 1)).toThrow('Invalid seen state version.');
    expect(store.lastPublish(identity)).toMatchObject({ stateVersion: version });
  });
  it('records a task already running at the upgrade as not published, so the first start publishes nothing for it', () => {
    const { path, store } = queued(); admit(store);
    expect(store.getTask(identity).status).toBe('running');
    const version = store.getTask(identity).stateVersion;
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE publish_outcomes; PRAGMA user_version=9;'); db.close();
    expect(open(path).lastPublish(identity)).toMatchObject({ outcome: 'not published', draft: false, stateVersion: version,
      message: expect.stringMatching(/Use the publish action/) });
  });
});

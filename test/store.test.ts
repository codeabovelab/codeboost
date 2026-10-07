import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fixtureGit } from './fixtures/git.ts';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { Store, requireSupportedNode } from '../runner/store.ts';
import type { Plan, PlanContext, EditReply } from '../core/plan.ts';
import { approveItem, approvalStates, choiceKeys, applyChoices, stable } from '../core/approvals.ts';
import { linkHistory, type Segment } from '../core/linking.ts';
import { readHistory } from '../git/history.ts';
import { identityKey } from '../core/identity.ts';
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan = (): Plan => ({ schema_version: 1, revision: 99, issue: 1, summary: 'Example', questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const oid = (n: number) => n.toString(16).padStart(40, '0');
const reply = (revision = 1): EditReply => ({ schema_version: 1, base_revision: revision, reply: 'Suggestion', edits: [{ op: 'set_field', item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Updated', file: null, check: null, check_index: null, depends_on: null, new_item: null }] });
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'codeboost-store-')); dirs.push(dir); return dir; }
function open(path: string, pathKey: (path: string) => string = p => p) { const store = new Store(path, pathKey); stores.push(store); return store; }
function close(store: Store) { store.close(); stores.splice(stores.indexOf(store), 1); }
function fixture(two = false) { const path = join(directory(), 'state.sqlite'); const store = open(path);
  const initial = plan();
  if (two) initial.items.push({ ...structuredClone(initial.items[0]!), id: 'P2', depends_on: ['P1'] });
  store.createPlan(JSON.stringify(initial), 'json', context, oid(1), oid(2)); return { path, store }; }
const state = (store: Store) => ({ revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id });
function ready(store: Store) { const id = store.beginSuggestions(identity, state(store), 'suggest'); store.completeSuggestions(identity, id, reply()); return id; }
it('settles prepare-merge replays through shutdown and fails interrupted preparations at startup recovery', () => {
  const { store } = fixture(), request = { expectedStateVersion: 0, expectedReviewVersion: 0 };
  const completed = randomUUID(), interrupted = randomUUID();
  store.userAction(identity, { actionId: completed, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  store.userAction(identity, { actionId: interrupted, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  store.settleInterruptedPreMergeActions(identity);
  expect(store.savedAction(identity, { actionId: completed, kind: 'prepare-merge', request })?.response)
    .toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/restarted/) });
  const active = randomUUID();
  store.userAction(identity, { actionId: active, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  const snapshot = store.getSnapshot(identity);
  const readiness = { stateVersion: store.getTask(identity).stateVersion, reviewVersion: store.reviewVersion(identity),
    snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head };
  const capability = store.shutdownCapability(); store.closeWrites();
  capability.run(() => store.settlePreMergeAction(identity, active,
    { state: 'ready', base: oid(1), head: oid(2), checked: ['P1'], reason: null }, readiness));
  expect(store.savedAction(identity, { actionId: active, kind: 'prepare-merge', request })?.response)
    .toEqual({ outcome: 'ready', base: oid(1), head: oid(2), checked: ['P1'], reason: null });
  expect(store.preMergeReady(identity, readiness)).toBe(true);
});
it('recovers an interrupted review check without applying the expired code-writing budget', () => {
  const { store } = fixture();
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const now = Date.now();
  const execute = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion,
    kind: 'execute', item: 'P1', deadline: now + 60_000, budgetMs: 10,
    expectedContext: store.currentContext(identity), now });
  store.markRunning(identity, execute.id);
  store.settleAttempt(identity, execute.id, { firstReason: null, exitCode: 0, valid: true });
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review');
  const check = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion,
    kind: 'check', item: 'P1', deadline: now + 60_000,
    expectedContext: store.currentContext(identity), now: now + 1_000 });
  const [recovered] = store.recoverInterrupted(now + 2_000);
  expect(recovered).toMatchObject({ attemptId: check.id, state: 'failed', requeued: false });
  expect(store.getAttempt(identity, check.id)).toMatchObject({ state: 'failed', firstReason: null });
  expect(store.getTask(identity).status).toBe('in review');
});
it('allocates revisions in SQLite, survives reopen, and keeps old revisions and snapshots immutable', () => {
  const { store, path } = fixture(); const first = store.getSnapshot(identity);
  expect(store.getPlan(identity).revision).toBe(1);
  const next = store.importRevision(JSON.stringify({ ...plan(), summary: 'Next' }), 'json', context, 1);
  expect(next.revision).toBe(2); expect(store.getPlan(identity, 1).summary).toBe('Example');
  expect(() => store.importRevision(JSON.stringify(plan()), 'json', context, 1)).toThrow(/Stale/);
  store.recordHistory(identity, state(store), oid(3), oid(4), []);
  const recovered = open(path);
  expect(recovered.getPlan(identity)).toEqual(next); expect(recovered.getSnapshot(identity, first.id)).toEqual(first);
  expect(recovered.getSnapshot(identity).head).toBe(oid(4));
});
it('scopes issue trust to repository and current author, supports revoke, and migrates schema v16', () => {
  const { store, path } = fixture();
  expect(store.issueTrust('owner/a', 5)).toBeNull();
  const trusted = store.setIssueTrust({ repository: 'Owner/A', issue: 5, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
  expect(trusted).toMatchObject({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trustedBy: 'local user', revokedAt: null });
  expect(store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: true, trustedBy: 'local user' })).toEqual(trusted);
  expect(store.issueTrust('owner/b', 5)).toBeNull();
  const revoked = store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
  expect(revoked.revokedAt).toBeTypeOf('string');
  expect(store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: false, trustedBy: 'local user' })).toEqual(revoked);
  expect(() => store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'changed', trusted: false, trustedBy: 'local user' })).toThrow(/not trusted for its current author/);
  close(store);
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE issue_trust; ALTER TABLE attempts DROP COLUMN prompt_comments; PRAGMA user_version=16;'); legacy.close();
  const migrated = open(path), db = new DatabaseSync(path);
  try {
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_trust'").get()).toEqual({ name: 'issue_trust' });
    expect(db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'prompt_comments')).toBe(true);
    expect(migrated.issueTrust('owner/a', 5)).toBeNull();
  } finally { db.close(); }
});
it('strictly orders same-author trust decisions when the wall clock does not advance', () => {
  const { store } = fixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const trusted = store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    const revoked = store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
    const retrusted = store.setIssueTrust({ repository: 'owner/a', issue: 5, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    expect(Date.parse(revoked.revokedAt!)).toBeGreaterThan(Date.parse(trusted.trustedAt));
    expect(Date.parse(retrusted.trustedAt)).toBeGreaterThan(Date.parse(revoked.revokedAt!));
  } finally { clock.mockRestore(); }
});
it('binds suggestion requests before the reply and rejects cross-plan, cancelled, delayed, replayed, and sibling applications', () => {
  const { store } = fixture(); const id = ready(store), sibling = ready(store);
  const other = { ...identity, planId: 'other' }; store.createPlan(JSON.stringify(plan()), 'json', { ...context, identity: other }, oid(1), oid(2));
  expect(() => store.applySuggestion(other, id, 0, { ...context, identity: other })).toThrow(/unavailable/);
  const cancelled = store.beginSuggestions(identity, state(store), 'suggest'); store.cancelSuggestions(identity, cancelled);
  expect(store.getSuggestions(identity, cancelled)).toMatchObject({ state: 'cancelled', reason: 'Suggestion cancelled.' });
  expect(() => store.completeSuggestions(identity, cancelled, reply())).toThrow(/stale|cancelled/);
  const delayed = store.beginSuggestions(identity, state(store), 'suggest');
  expect(store.applySuggestion(identity, id, 0, context).revision).toBe(2);
  expect(() => store.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
  expect(() => store.applySuggestion(identity, sibling, 0, context)).toThrow(/unavailable/);
  expect(store.getSuggestions(identity, sibling)).toMatchObject({ state: 'invalidated', reason: 'Plan revision changed.', reply: reply() });
  expect(() => store.completeSuggestions(identity, delayed, reply())).toThrow(/stale/);
});
it('preserves a completed request when stale pending cleanup loses the race', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const id = store.beginSuggestions(identity, expected, 'suggest');
  other.completeSuggestions(identity, id, reply());
  expect(store.settleSuggestion(identity, id, expected, { state: 'failed', reason: 'Provider failed.' })).toBe(false);
  expect(store.getSuggestions(identity, id)).toMatchObject({ state: 'ready', snapshotId: expected.snapshotId, reason: null, reply: reply() });
  expect(store.applySuggestion(identity, id, 0, context).revision).toBe(2);
});
it('persists the winning terminal reason and prevents a late completion from reviving it', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const id = store.beginSuggestions(identity, expected, 'suggest');
  expect(store.settleSuggestion(identity, id, expected, { state: 'failed', reason: 'Provider exited.' })).toBe(true);
  expect(() => other.completeSuggestions(identity, id, reply())).toThrow(/stale|cancelled|complete/);
  const recovered = open(path);
  expect(recovered.getSuggestions(identity, id)).toMatchObject({ state: 'failed', snapshotId: expected.snapshotId, reason: 'Provider exited.', reply: null });
  expect(() => recovered.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
});
it('retains cancellation reasons across restart and never revives cancelled work', () => {
  const { store, path } = fixture(), expected = state(store);
  const id = store.beginSuggestions(identity, expected, 'suggest');
  expect(store.settleSuggestion(identity, id, expected, { state: 'cancelled', reason: 'Runner shut down.' })).toBe(true);
  close(store);
  const recovered = open(path);
  expect(recovered.getSuggestions(identity, id)).toMatchObject({ state: 'cancelled', reason: 'Runner shut down.', snapshotId: expected.snapshotId });
  expect(() => recovered.completeSuggestions(identity, id, reply())).toThrow(/stale|cancelled|complete/);
});
it('persists the merge-queue lifecycle and terminal reason across restart', () => {
  const { store, path } = fixture();
  const expected = { ...state(store), reviewVersion: store.reviewVersion(identity) };
  const attempt = store.beginMergeAttempt(identity, expected, oid(2), 'MQEV_before');
  expect(store.recordMergeAttemptDiagnostic(identity, attempt.id, 'Submission timed out after GitHub may have accepted it.')).toBe(true);
  expect(store.getMergeAttempt(identity)).toMatchObject({ state: 'submitting', reason: 'Submission timed out after GitHub may have accepted it.' });
  expect(store.queueMergeAttempt(identity, attempt.id, 'https://github.example/pr/1')).toBe(true);
  expect(store.getMergeAttempt(identity)).toMatchObject({ state: 'queued', reason: null });
  expect(store.observeQueuedMerge(identity, attempt.id, { entryId: 'MQE_1', phase: 'AWAITING_CHECKS', position: 2 })).toBe(true);
  expect(store.finishMergeAttempt(identity, attempt.id, { state: 'removed', reason: 'Checks failed.', occurredAt: '2026-09-24T08:05:00Z' })).toBe(true);
  close(store);
  expect(open(path).getMergeAttempt(identity)).toMatchObject({
    id: attempt.id, state: 'removed', reviewedHead: oid(2), queueWatermark: 'MQEV_before', reason: 'Checks failed.', entryId: 'MQE_1', phase: 'AWAITING_CHECKS', position: 2,
  });
});
it('prevents a stale queue observation from overwriting a retry attempt', () => {
  const { store } = fixture();
  const expected = { ...state(store), reviewVersion: store.reviewVersion(identity) };
  const first = store.beginMergeAttempt(identity, expected, oid(2));
  store.queueMergeAttempt(identity, first.id, 'https://github.example/pr/1');
  store.finishMergeAttempt(identity, first.id, { state: 'failed', reason: 'Queue failed.' });
  const retry = store.beginMergeAttempt(identity, expected, oid(2));
  store.queueMergeAttempt(identity, retry.id, 'https://github.example/pr/1');
  expect(store.finishMergeAttempt(identity, first.id, { state: 'merged', occurredAt: '2026-09-24T08:10:00Z' })).toBe(false);
  expect(store.getMergeAttempt(identity)).toMatchObject({ id: retry.id, state: 'queued', reviewedHead: oid(2) });
});
it('migrates unbound active requests to terminal history instead of reviving them', () => {
  const { store, path } = fixture(); const id = ready(store);
  close(store);
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE merge_attempts; ALTER TABLE requests DROP COLUMN reason; ALTER TABLE requests DROP COLUMN snapshot_id; ALTER TABLE requests DROP COLUMN mode; PRAGMA user_version=3;');
  legacy.close();
  const recovered = open(path);
  // Requests from before #124 carry no mode: every one of them is a suggestion.
  expect(recovered.getSuggestions(identity, id)).toEqual({ mode: 'suggest', state: 'invalidated', revision: 1, snapshotId: null, reply: reply(), reason: 'Request predates snapshot binding.' });
  expect(() => recovered.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
});
it('invalidates pending and ready requests when another connection advances the snapshot', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const pending = store.beginSuggestions(identity, expected, 'suggest'), completed = store.beginSuggestions(identity, expected, 'suggest');
  store.completeSuggestions(identity, completed, reply());
  other.recordHistory(identity, expected, oid(1), oid(3), []);
  expect(store.getSuggestions(identity, pending)).toMatchObject({ state: 'invalidated', snapshotId: expected.snapshotId, reason: 'Repository snapshot changed.', reply: null });
  expect(store.getSuggestions(identity, completed)).toMatchObject({ state: 'invalidated', snapshotId: expected.snapshotId, reason: 'Repository snapshot changed.', reply: reply() });
  expect(() => store.completeSuggestions(identity, pending, reply())).toThrow(/stale|cancelled|complete/);
  expect(() => store.applySuggestion(identity, completed, 0, context)).toThrow(/unavailable/);
});
it('rolls back invalid edits without consuming the request or allocating a revision', () => {
  const { store } = fixture(); const id = ready(store);
  expect(() => store.applySuggestion(identity, id, 3, context)).toThrow(/index/);
  expect(store.getPlan(identity).revision).toBe(1);
  expect(store.applySuggestion(identity, id, 0, context).items[0]!.title).toBe('Updated');
});
it('serializes competing Apply operations across independent processes', async () => {
  const { store, path } = fixture(); const ids = [ready(store), ready(store)];
  const source = `import { Store } from ${JSON.stringify(resolve('runner/store.ts'))};
    const store = new Store(process.argv[1]);
    process.send('ready');
    process.once('message', () => { try { store.applySuggestion(${JSON.stringify(identity)}, process.argv[2], 0, {...${JSON.stringify(context)}, pathKey: p => p}); process.send('applied'); }
    catch { process.send('rejected'); } finally { store.close(); process.disconnect(); } });`;
  const children = ids.map(id => spawn(process.execPath, ['--input-type=module', '-e', source, path, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  try {
    await Promise.all(children.map(child => once(child, 'message')));
    const outcomes = children.map(child => once(child, 'message'));
    const exits = children.map(child => once(child, 'exit'));
    children.forEach(child => child.send('apply'));
    expect((await Promise.all(outcomes)).map(([result]) => result).sort()).toEqual(['applied', 'rejected']);
    await Promise.all(exits);
    expect(store.getPlan(identity).revision).toBe(2);
    expect(() => store.getPlan(identity, 3)).toThrow(/Unknown/);
  } finally { children.forEach(child => child.kill()); }
}, 15000);
it('rolls back the entire ledger batch and snapshot after a late ownership collision', () => {
  const { store } = fixture(); store.recordHistory(identity, state(store), oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
  const before = store.getSnapshot(identity);
  expect(() => store.recordHistory(identity, state(store), oid(1), oid(4), [
    { sha: oid(3), owner: 'P1', origin: 'owned', sourceSha: null }, { sha: oid(2), owner: null, origin: 'foreign', sourceSha: null },
  ])).toThrow(/immutable/);
  expect(store.getSnapshot(identity)).toEqual(before); expect(store.getLedger(identity)).toHaveLength(1);
  expect(() => store.recordRebase(identity, state(store), oid(5), oid(6), [{ oldSha: oid(2), newSha: oid(6) }, { oldSha: oid(3), newSha: oid(6) }])).toThrow(/one-to-one/);
  expect(store.getSnapshot(identity)).toEqual(before); expect(store.getLedger(identity)).toHaveLength(1);
});
it('preserves owned, foreign, and conflict-resolution provenance through repeated rebase mappings and restart', () => {
  const { store, path } = fixture(); store.recordHistory(identity, state(store), oid(1), oid(3), [
    { sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null },
    { sha: oid(3), owner: null, origin: 'foreign', sourceSha: null, conflictResolved: true },
  ]);
  const snapshot = store.recordRebase(identity, state(store), oid(10), oid(14), [2,3,4].map(n => ({ oldSha: oid(n), newSha: oid(n + 10) })));
  store.recordRebase(identity, state(store), oid(20), oid(24), [12,13,14].map(n => ({ oldSha: oid(n), newSha: oid(n + 10) })));
  const recovered = open(path); expect(recovered.ownership(identity).get(oid(22))).toBe('P1');
  expect(recovered.ownership(identity).get(oid(23))).toBeNull(); expect(recovered.ownership(identity).get(oid(24))).toBeNull();
  expect(recovered.getLedger(identity).find(e => e.sha === oid(23))).toEqual({ sha: oid(23), owner: null, origin: 'foreign', sourceSha: oid(13), conflictResolved: true });
  expect(recovered.getLedger(identity).find(e => e.sha === oid(24))).toEqual({ sha: oid(24), owner: null, origin: 'foreign', sourceSha: oid(14) });
  expect(recovered.getRewrites(identity, snapshot.id)).toHaveLength(3);
});
it('feeds persisted remapped ownership into the linking engine on real Git history', () => {
  const dir = directory(); const git = (...args: string[]) => fixtureGit(dir, ...args);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const commit = () => { git('add', 'a'); git('commit', '-m', 'Change'); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(dir, 'a'), 'before\n'); const base = commit(); writeFileSync(join(dir, 'a'), 'after\n'); const head = commit();
  const store = open(join(directory(), 'state.sqlite')); store.createPlan(JSON.stringify(plan()), 'json', context, base, base);
  store.recordHistory(identity, state(store), base, base, [{ sha: oid(9), owner: 'P1', origin: 'owned', sourceSha: null }]);
  store.recordRebase(identity, state(store), base, head, [{ oldSha: oid(9), newSha: head }]);
  const segments = linkHistory(store.getPlan(identity), readHistory(dir, base, head), store.ownership(identity), p => p);
  expect(segments.length).toBeGreaterThan(0); expect(segments.every(s => s.row === 'P1')).toBe(true);
  const amended = plan(); amended.items[0]!.id = 'P2'; store.importRevision(JSON.stringify(amended), 'json', context, 1);
  const afterRemoval = linkHistory(store.getPlan(identity), readHistory(dir, base, head), store.ownership(identity), p => p);
  expect(afterRemoval.every(s => s.row === 'Unplanned')).toBe(true);
});
it('retains typed file-card approvals/choices while fingerprints detect later metadata and plan changes', () => {
  const { store, path } = fixture(); const current = store.getPlan(identity);
  const segment: Segment = { path: 'a', oldPath: 'a', kind: 'file', operation: null, content: JSON.stringify({ kind: 'binary', oldObject: { type: 'blob', oid: oid(1) }, newObject: { type: 'blob', oid: oid(2) } }), context: '', owners: ['P1'], row: 'P1', scope: 'in-scope', oldLine: null, newLine: null, hunk: 0, sharesHunkWith: [] };
  const approval = approveItem(current, [segment], 'P1', identity);
  const choice = { key: choiceKeys([segment], identity)[0]!, action: 'accept' as const, item: null };
  const legacyContent = stable({ path: segment.path, oldPath: segment.oldPath, kind: segment.kind,
    operation: segment.operation, content: segment.content });
  expect(choice.key).toBe(stable([identityKey(identity), legacyContent, 1, 1]));
  expect(approval.fingerprint).toBe(stable({ identity: identityKey(identity), item: current.items[0], segments: [{
    path: segment.path, oldPath: segment.oldPath, kind: segment.kind, operation: segment.operation,
    content: segment.content, context: segment.context, owners: ['P1'],
  }] }));
  store.saveReview(identity, state(store), [approval], [choice]);
  const recovered = open(path).getReview(identity);
  expect(recovered.approvals[0]!.fingerprint).toBe(approval.fingerprint); expect(recovered.choices[0]!.key).toBe(choice.key);
  expect(approvalStates(current, [segment], recovered.approvals, identity).P1).toBe('approved');
  const resolved = { ...segment, conflictResolved: true as const };
  expect(choiceKeys([resolved], identity)[0]).not.toBe(choice.key);
  expect(applyChoices(current, [{ ...resolved, row: 'Unplanned', owners: [null], scope: 'unplanned' }], recovered.choices, identity)[0]!.row).toBe('Unplanned');
  expect(approvalStates(current, [resolved], recovered.approvals, identity).P1).toBe('stale');
  expect(approvalStates(current, [{ ...segment, content: segment.content.replace(oid(2), oid(3)) }], recovered.approvals, identity).P1).toBe('stale');
  const old = state(store); store.importRevision(JSON.stringify({ ...plan(), items: [{ ...plan().items[0]!, title: 'Changed' }] }), 'json', context, 1);
  expect(() => store.saveReview(identity, old, [approval], [])).toThrow(/Stale/);
  expect(approvalStates(store.getPlan(identity), [segment], store.getReview(identity).approvals, identity).P1).toBe('stale');
});
it('retains checkpoint scope evidence after amended continuation and rejects a moved head', () => {
  const { store, path } = fixture(true); store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const entries = [...context.baseEntries, { path: 'outside', kind: 'file' as const }];
  const checkpoint = store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: entries });
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store), { ...context, baseEntries: entries })).toThrow(/amended/);
  const amended = store.getPlan(identity);
  amended.items[0]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'scope amendment' });
  store.importRevision(JSON.stringify(amended), 'json', context, 1);
  store.approveContinuation(identity, checkpoint.id, state(store), { ...context, baseEntries: entries });
  const recovered = open(path); expect(recovered.getCheckpoint(identity, checkpoint.id)).toEqual(checkpoint); expect(recovered.continuationRevision(identity, checkpoint.id)).toBe(2);
  store.recordHistory(identity, state(store), oid(1), oid(3), []);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store), { ...context, baseEntries: entries })).toThrow(/head|checkpoint/);
});
it('rejects unsupported Node versions and opens SQLite without warnings', () => {
  expect(() => requireSupportedNode('24.0.0')).toThrow(/Upgrade Node/); expect(() => requireSupportedNode('26.6.0')).toThrow();
  expect(() => requireSupportedNode('26.7.0')).not.toThrow();
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import { Store } from './runner/store.ts'; process.on('warning', () => { process.exitCode = 1; }); new Store(':memory:').close();`], { encoding: 'utf8' });
  expect(result).toBe('');
});
it('recovers a committed suggestion after abrupt process exit and discards an interrupted transaction', () => {
  const path = join(directory(), 'crash.sqlite');
  const source = `import { Store } from './runner/store.ts';
    const store = new Store(process.argv[1]);
    const context = {...${JSON.stringify(context)}, pathKey: p => p};
    store.createPlan(${JSON.stringify(JSON.stringify(plan()))}, 'json', context, '${oid(1)}', '${oid(2)}');
    const id = store.beginSuggestions(context.identity, {revision: 1, snapshotId: store.getSnapshot(context.identity).id}, 'suggest');
    store.completeSuggestions(context.identity, id, ${JSON.stringify(reply())});
    process.stdout.write(id); process.exit(0);`;
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', source, path], { encoding: 'utf8' });
  // Simulate a writer dying between the pointer update and revision insert.
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE; UPDATE plans SET revision=2;'); process.exit(0);`, path]);
  const recovered = open(path);
  expect(recovered.getPlan(identity).revision).toBe(1);
  expect(recovered.getSuggestions(identity, id).state).toBe('ready');
  expect(recovered.applySuggestion(identity, id, 0, context).revision).toBe(2);
  expect(recovered.getSuggestions(identity, id).state).toBe('consumed');
});
it('rolls back an entire review write and refuses approvals tied to an older head', () => {
  const { store } = fixture(); const expected = state(store);
  const approval = approveItem(store.getPlan(identity), [], 'P1', identity, true);
  expect(() => store.saveReview(identity, expected, [approval], [{ key: 'bad', action: 'assign', item: 'P99' }])).toThrow(/choice/);
  expect(store.getReview(identity)).toEqual({ approvals: [], choices: [] });
  store.recordHistory(identity, expected, oid(1), oid(5), []);
  expect(() => store.saveReview(identity, expected, [approval], [])).toThrow(/Stale/);
});
it('keeps identical commit SHAs and local item IDs isolated across plan identities', () => {
  const { store } = fixture();
  store.recordHistory(identity, state(store), oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
  const other = { ...identity, repositoryId: 'other' };
  store.createPlan(JSON.stringify(plan()), 'json', { ...context, identity: other }, oid(1), oid(2));
  expect(store.ownership(other).has(oid(2))).toBe(false);
  expect(() => store.getSnapshot(other, store.getSnapshot(identity).id)).toThrow(/Unknown/);
});
it('accepts idempotent ledger retries regardless of object property order', () => {
  const { store } = fixture();
  store.recordHistory(identity, state(store), oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
  expect(() => store.recordHistory(identity, state(store), oid(1), oid(2), [{ sourceSha: null, origin: 'owned', owner: 'P1', sha: oid(2) }])).not.toThrow();
  expect(store.getLedger(identity)).toHaveLength(1);
});
it('requires the checkpoint item to be the last item in the completed prefix', () => {
  const { store } = fixture(); const next = plan(); next.items.push({ ...structuredClone(next.items[0]!), id: 'P2' });
  store.importRevision(JSON.stringify(next), 'json', context, 1);
  expect(() => store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries })).toThrow(/prefix/);
  expect(store.recordCheckpoint(identity, state(store), { item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries }).item).toBe('P2');
});
it('allows historical ledger retries after the owning item is removed, but rejects new entries for it', () => {
  const { store } = fixture(); const entry = { sha: oid(2), owner: 'P1', origin: 'owned' as const, sourceSha: null };
  store.recordHistory(identity, state(store), oid(1), oid(2), [entry]);
  const next = plan(); next.items[0]!.id = 'P2'; store.importRevision(JSON.stringify(next), 'json', context, 1);
  expect(() => store.recordHistory(identity, state(store), oid(1), oid(2), [entry])).not.toThrow();
  expect(() => store.recordHistory(identity, state(store), oid(1), oid(3), [{ ...entry, sha: oid(3) }])).toThrow(/Unknown ledger owner/);
  store.recordRebase(identity, state(store), oid(4), oid(5), [{ oldSha: oid(2), newSha: oid(5) }]);
  expect(store.getLedger(identity).find(entry => entry.sha === oid(5))!.owner).toBe('P1');
});
it('allows a later amended revision to receive a fresh continuation approval', () => {
  const { store } = fixture(true); store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const checkpoint = store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries });
  const amended = store.getPlan(identity);
  amended.items[0]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'scope amendment' });
  store.importRevision(JSON.stringify(amended), 'json', context, 1); store.approveContinuation(identity, checkpoint.id, state(store), context);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store), context)).not.toThrow();
  store.importRevision(JSON.stringify(store.getPlan(identity)), 'json', context, 2);
  expect(store.continuationRevision(identity, checkpoint.id)).toBe(2);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store), context)).not.toThrow();
  expect(store.continuationRevision(identity, checkpoint.id)).toBe(3);
});
it('refuses a suffix that is invalid against the audited tree despite a valid base-tree plan', () => {
  const { store } = fixture(true);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const checkpoint = store.recordCheckpoint(identity, state(store), {
    item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: [],
  });
  const amended = store.getPlan(identity);
  amended.items[0]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'scope amendment' });
  store.importRevision(JSON.stringify(amended), 'json', context, 1);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store), { ...context, baseEntries: [] }))
    .toThrow(/remaining plan is invalid.*Missing source: a/);
  expect(store.continuationRevision(identity, checkpoint.id)).toBeNull();
});
it('re-reads the actual checkpoint tree for legacy checkpoint rows', () => {
  const { store, path } = fixture(true); store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const checkpoint = store.recordCheckpoint(identity, state(store), {
    item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries,
  });
  close(store);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE checkpoints SET data=? WHERE key=? AND id=?').run(
    JSON.stringify({ ...checkpoint, treeHead: undefined }), JSON.stringify([identity.repositoryId, identity.taskId, identity.planId]), checkpoint.id);
  db.close();
  const reopened = open(path), amended = reopened.getPlan(identity);
  amended.items[0]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'scope amendment' });
  reopened.importRevision(JSON.stringify(amended), 'json', context, 1);
  expect(() => reopened.approveContinuation(identity, checkpoint.id, state(reopened), {
    ...context, baseEntries: [...context.baseEntries, { path: 'outside', kind: 'file' }],
  })).not.toThrow();
});
it('refuses edits to completed items before the checkpoint owner', () => {
  const { store } = fixture(true);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  store.recordCheckpoint(identity, state(store), {
    item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries,
  });
  const amended = store.getPlan(identity);
  amended.items[0]!.intent += ' revised after completion';
  amended.items[1]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  expect(() => store.importRevision(JSON.stringify(amended), 'json', context, 1)).toThrow(/Completed item P1 changed before the audited checkpoint/);
  expect(store.getPlan(identity).revision).toBe(1);
});
it('refuses checkpoint-owner edits beyond declaring the observed scope finding', () => {
  const { store } = fixture(true);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  store.recordCheckpoint(identity, state(store), {
    item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries,
  });
  const amended = store.getPlan(identity);
  amended.items[1]!.intent += ' changed after it completed';
  amended.items[1]!.files.push({ path: 'outside', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  expect(() => store.importRevision(JSON.stringify(amended), 'json', context, 1)).toThrow(/changed beyond its scope declaration/);
  expect(store.getPlan(identity).revision).toBe(1);
});
it('refuses a scope declaration whose rename source was not observed', () => {
  const path = join(directory(), 'state.sqlite'), store = open(path), contextWithSource = {
    ...context, baseEntries: [...context.baseEntries, { path: 'b', kind: 'file' as const }],
  };
  const initial = plan(); initial.items.push({ ...structuredClone(initial.items[0]!), id: 'P2', depends_on: ['P1'] });
  store.createPlan(JSON.stringify(initial), 'json', contextWithSource, oid(1), oid(2));
  store.recordCheckpoint(identity, state(store), {
    item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: contextWithSource.baseEntries,
  });
  const amended = store.getPlan(identity);
  amended.items[1]!.files.push({ path: 'outside', kind: 'rename', renamed_from: 'b', change: 'Rename the observed path' });
  expect(() => store.importRevision(JSON.stringify(amended), 'json', contextWithSource, 1)).toThrow(/changed beyond its scope declaration/);
  expect(store.getPlan(identity).revision).toBe(1);
});
it.each([
  {
    name: 'duplicate operations', outOfScopePaths: ['outside'],
    files: [
      { path: 'outside', kind: 'add' as const, renamed_from: null, change: 'Declare the observed add' },
      { path: 'outside', kind: 'delete' as const, renamed_from: null, change: 'Declare the observed delete' },
    ],
  },
  {
    name: 'parent and child paths', outOfScopePaths: ['outside', 'outside/child'],
    files: [
      { path: 'outside', kind: 'add' as const, renamed_from: null, change: 'Declare the observed parent' },
      { path: 'outside/child', kind: 'add' as const, renamed_from: null, change: 'Declare the observed child' },
    ],
  },
  {
    name: 'a duplicated rename source', outOfScopePaths: ['outside', 'moved'],
    files: [
      { path: 'outside', kind: 'add' as const, renamed_from: null, change: 'Declare the observed add' },
      { path: 'moved', kind: 'rename' as const, renamed_from: 'outside', change: 'Declare the observed rename' },
    ],
  },
  {
    name: 'a rename source on a non-rename operation', outOfScopePaths: ['outside', 'source'],
    files: [
      { path: 'outside', kind: 'add' as const, renamed_from: 'source', change: 'Declare the observed add' },
    ],
  },
  {
    name: 'an unsafe canonical path', outOfScopePaths: ['bad:name'],
    files: [
      { path: 'bad:name', kind: 'add' as const, renamed_from: null, change: 'Declare the observed path' },
    ],
  },
])('refuses checkpoint scope declarations with $name', ({ outOfScopePaths, files }) => {
  const { store } = fixture(true);
  store.recordCheckpoint(identity, state(store), {
    item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths, baseEntries: context.baseEntries,
  });
  const amended = store.getPlan(identity);
  amended.items[1]!.files.push(...files);
  expect(() => store.importRevision(JSON.stringify(amended), 'json', context, 1)).toThrow(/file declarations/);
  expect(store.getPlan(identity).revision).toBe(1);
});
it('uses configured path identity when matching checkpoint scope declarations', () => {
  const path = join(directory(), 'state.sqlite'), pathKey = (value: string) => value.toLowerCase();
  const store = open(path, pathKey), normalizedContext = { ...context, pathKey };
  store.createPlan(JSON.stringify({ ...plan(), items: [...plan().items, { ...structuredClone(plan().items[0]!), id: 'P2', depends_on: ['P1'] }] }),
    'json', normalizedContext, oid(1), oid(2));
  store.recordCheckpoint(identity, state(store), {
    item: 'P2', completedItems: ['P1', 'P2'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries,
  });
  const amended = store.getPlan(identity);
  amended.items[1]!.files.push({ path: 'OUTSIDE', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  expect(store.importRevision(JSON.stringify(amended), 'json', normalizedContext, 1).revision).toBe(2);
  expect(store.continuationProgress(identity)?.next).toBeNull();
  const identityCollision = store.getPlan(identity);
  identityCollision.items[1]!.files.push({ path: 'outside', kind: 'delete', renamed_from: null, change: 'Duplicate the observed path' });
  expect(() => store.importRevision(JSON.stringify(identityCollision), 'json', normalizedContext, 2))
    .toThrow(/file declarations/);
  expect(store.getPlan(identity).revision).toBe(2);
  const identityDrift = store.getPlan(identity);
  identityDrift.issue = 2;
  expect(() => store.importRevision(JSON.stringify(identityDrift), 'json', normalizedContext, 2)).toThrow(/Plan issue does not match/);
  expect(store.getPlan(identity).revision).toBe(2);
});
it('can restore an executed definition after a transient pre-checkpoint amendment', () => {
  const { store } = fixture(true), id = identity;
  store.transitionTask(id, store.getTask(id).stateVersion, 'queued');
  const start = store.getSnapshot(id), attempt = store.admitAttempt(id, { expectedStateVersion: store.getTask(id).stateVersion,
    kind: 'execute', item: 'P1', expectedContext: store.currentContext(id), deadline: Date.now() + 60_000 });
  store.markRunning(id, attempt.id);
  const head = oid(7);
  store.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
    result: { head, unchanged: false, inScope: [], outOfScope: ['outside'] },
    history: { base: start.base, head, entries: [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }] } });
  const transient = store.getPlan(id); transient.items[0]!.intent += ' transient edit';
  store.importRevision(JSON.stringify(transient), 'json', context, 1);
  store.pauseForAmendment(id, { revision: 1, snapshotId: store.getSnapshot(id).id }, {
    item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'],
    baseEntries: [...context.baseEntries, { path: 'outside', kind: 'file' }],
  }, { owed: true });
  const restore = store.getPlan(id); restore.items[0]!.intent = plan().items[0]!.intent;
  restore.items[0]!.files.push({ path: 'outside', kind: 'edit', renamed_from: null, change: 'Declare observed file' });
  expect(() => store.importRevision(JSON.stringify(restore), 'json', {
    ...context, baseEntries: [...context.baseEntries, { path: 'outside', kind: 'file' }],
  }, 2)).not.toThrow();
  expect(store.continuationProgress(id)).toMatchObject({ completed: ['P1'], next: 'P2', head });
});
it('refuses a suffix ID collision with the completed checkpoint prefix without saving it', () => {
  const { store } = fixture(true);
  store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries });
  const amended = store.getPlan(identity); amended.items[1]!.id = 'P1';
  expect(() => store.importRevision(JSON.stringify(amended), 'json', context, 1)).toThrow(/Duplicate item ID P1/);
  expect(store.getPlan(identity).revision).toBe(1);
});
it('validates saved amendments against the checkpoint tree and completed suffix', () => {
  const path = join(directory(), 'state.sqlite'), store = open(path);
  const initial: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'Example', questions: [], items: [
    { id: 'P1', title: 'Create output', intent: 'Create done.ts', files: [{ path: 'done.ts', kind: 'add', renamed_from: null, change: 'Create output' }], acceptance: [{ type: 'check', text: 'Done' }], depends_on: [] },
    { id: 'P2', title: 'Continue', intent: 'Create later.ts', files: [{ path: 'later.ts', kind: 'add', renamed_from: null, change: 'Create later output' }], acceptance: [{ type: 'check', text: 'Done' }], depends_on: ['P1'] },
  ] };
  store.createPlan(JSON.stringify(initial), 'json', { ...context, baseEntries: [] }, oid(1), oid(2));
  store.recordCheckpoint(identity, state(store), {
    item: 'P1', completedItems: ['P1'], outOfScopePaths: ['extra.ts'],
    baseEntries: [{ path: 'done.ts', kind: 'file' }, { path: 'extra.ts', kind: 'file' }],
  });
  const amended = store.getPlan(identity);
  amended.items[0]!.files.push({ path: 'extra.ts', kind: 'add', renamed_from: null, change: 'Declare the observed path' });
  expect(store.importRevision(JSON.stringify(amended), 'json', {
    ...context, baseEntries: [{ path: 'done.ts', kind: 'file' }, { path: 'extra.ts', kind: 'file' }],
  }, 1).revision).toBe(2);
  expect(store.continuationProgress(identity)).toMatchObject({ completed: ['P1'], next: 'P2' });
});
it('rejects duplicate source SHA mappings and rolls back every resulting ledger/snapshot write', () => {
  const { store } = fixture(); const before = store.getSnapshot(identity);
  expect(() => store.recordRebase(identity, state(store), oid(3), oid(5), [{ oldSha: oid(2), newSha: oid(4) }, { oldSha: oid(2), newSha: oid(5) }])).toThrow();
  expect(store.getSnapshot(identity)).toEqual(before); expect(store.getLedger(identity)).toEqual([]);
  expect(store.getRewrites(identity, before.id)).toEqual([]);
});
it('expires assignments to removed plan items atomically with the amendment', () => {
  const { store } = fixture();
  const segment: Segment = { path: 'a', oldPath: 'a', kind: 'text', operation: '+', content: 'after\n', context: '', owners: [null], row: 'Unplanned', scope: 'unplanned', oldLine: null, newLine: 1, hunk: 0, sharesHunkWith: [] };
  store.saveReview(identity, state(store), [], [{ key: choiceKeys([segment], identity)[0]!, action: 'assign', item: 'P1' }]);
  const next = plan(); next.items[0]!.id = 'P2'; store.importRevision(JSON.stringify(next), 'json', context, 1);
  expect(() => applyChoices(store.getPlan(identity), [segment], store.getReview(identity).choices, identity)).not.toThrow();
  expect(store.getReview(identity).choices).toEqual([]);
  store.importRevision(JSON.stringify(plan()), 'json', context, 2);
  expect(store.getReview(identity).choices).toEqual([]);
});
it('does not revive an old approval when a removed item ID is reintroduced', () => {
  const { store } = fixture(); store.saveReview(identity, state(store), [approveItem(store.getPlan(identity), [], 'P1', identity, true)], []);
  const next = plan(); next.items[0]!.id = 'P2'; store.importRevision(JSON.stringify(next), 'json', context, 1);
  store.importRevision(JSON.stringify(plan()), 'json', context, 2);
  expect(approvalStates(store.getPlan(identity), [], store.getReview(identity).approvals, identity).P1).toBe('unreviewed');
});
it('persists foreign ownership for an unknown SHA mapped to itself', () => {
  const { store } = fixture(); store.recordRebase(identity, state(store), oid(1), oid(2), [{ oldSha: oid(2), newSha: oid(2) }]);
  expect(store.getLedger(identity)).toEqual([{ sha: oid(2), owner: null, origin: 'foreign', sourceSha: null }]);
  expect(() => store.recordHistory(identity, state(store), oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }])).toThrow(/immutable/);
});

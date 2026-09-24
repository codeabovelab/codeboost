import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Store, requireSupportedNode } from '../runner/store.ts';
import type { Plan, PlanContext, EditReply } from '../core/plan.ts';
import { approveItem, approvalStates, choiceKeys, applyChoices } from '../core/approvals.ts';
import { linkHistory, type Segment } from '../core/linking.ts';
import { readHistory } from '../git/history.ts';
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan = (): Plan => ({ schema_version: 1, revision: 99, issue: 1, summary: 'Example', questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const oid = (n: number) => n.toString(16).padStart(40, '0');
const reply = (revision = 1): EditReply => ({ schema_version: 1, base_revision: revision, reply: 'Suggestion', edits: [{ op: 'set_field', item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Updated', file: null, check: null, check_index: null, depends_on: null, new_item: null }] });
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'codeboost-store-')); dirs.push(dir); return dir; }
function open(path: string) { const store = new Store(path); stores.push(store); return store; }
function close(store: Store) { store.close(); stores.splice(stores.indexOf(store), 1); }
function fixture() { const path = join(directory(), 'state.sqlite'); const store = open(path); store.createPlan(JSON.stringify(plan()), 'json', context, oid(1), oid(2)); return { path, store }; }
const state = (store: Store) => ({ revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id });
function ready(store: Store) { const id = store.beginSuggestions(identity, state(store)); store.completeSuggestions(identity, id, reply()); return id; }
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
it('binds suggestion requests before the reply and rejects cross-plan, cancelled, delayed, replayed, and sibling applications', () => {
  const { store } = fixture(); const id = ready(store), sibling = ready(store);
  const other = { ...identity, planId: 'other' }; store.createPlan(JSON.stringify(plan()), 'json', { ...context, identity: other }, oid(1), oid(2));
  expect(() => store.applySuggestion(other, id, 0, { ...context, identity: other })).toThrow(/unavailable/);
  const cancelled = store.beginSuggestions(identity, state(store)); store.cancelSuggestions(identity, cancelled);
  expect(store.getSuggestions(identity, cancelled)).toMatchObject({ state: 'cancelled', reason: 'Suggestion cancelled.' });
  expect(() => store.completeSuggestions(identity, cancelled, reply())).toThrow(/stale|cancelled/);
  const delayed = store.beginSuggestions(identity, state(store));
  expect(store.applySuggestion(identity, id, 0, context).revision).toBe(2);
  expect(() => store.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
  expect(() => store.applySuggestion(identity, sibling, 0, context)).toThrow(/unavailable/);
  expect(store.getSuggestions(identity, sibling)).toMatchObject({ state: 'invalidated', reason: 'Plan revision changed.', reply: reply() });
  expect(() => store.completeSuggestions(identity, delayed, reply())).toThrow(/stale/);
});
it('preserves a completed request when stale pending cleanup loses the race', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const id = store.beginSuggestions(identity, expected);
  other.completeSuggestions(identity, id, reply());
  expect(store.settleSuggestion(identity, id, expected, { state: 'failed', reason: 'Provider failed.' })).toBe(false);
  expect(store.getSuggestions(identity, id)).toMatchObject({ state: 'ready', snapshotId: expected.snapshotId, reason: null, reply: reply() });
  expect(store.applySuggestion(identity, id, 0, context).revision).toBe(2);
});
it('persists the winning terminal reason and prevents a late completion from reviving it', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const id = store.beginSuggestions(identity, expected);
  expect(store.settleSuggestion(identity, id, expected, { state: 'failed', reason: 'Provider exited.' })).toBe(true);
  expect(() => other.completeSuggestions(identity, id, reply())).toThrow(/stale|cancelled|complete/);
  const recovered = open(path);
  expect(recovered.getSuggestions(identity, id)).toMatchObject({ state: 'failed', snapshotId: expected.snapshotId, reason: 'Provider exited.', reply: null });
  expect(() => recovered.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
});
it('retains cancellation reasons across restart and never revives cancelled work', () => {
  const { store, path } = fixture(), expected = state(store);
  const id = store.beginSuggestions(identity, expected);
  expect(store.settleSuggestion(identity, id, expected, { state: 'cancelled', reason: 'Runner shut down.' })).toBe(true);
  close(store);
  const recovered = open(path);
  expect(recovered.getSuggestions(identity, id)).toMatchObject({ state: 'cancelled', reason: 'Runner shut down.', snapshotId: expected.snapshotId });
  expect(() => recovered.completeSuggestions(identity, id, reply())).toThrow(/stale|cancelled|complete/);
});
it('migrates unbound active requests to terminal history instead of reviving them', () => {
  const { store, path } = fixture(); const id = ready(store);
  close(store);
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE requests DROP COLUMN reason; ALTER TABLE requests DROP COLUMN snapshot_id; PRAGMA user_version=3;');
  legacy.close();
  const recovered = open(path);
  expect(recovered.getSuggestions(identity, id)).toEqual({ state: 'invalidated', revision: 1, snapshotId: null, reply: reply(), reason: 'Request predates snapshot binding.' });
  expect(() => recovered.applySuggestion(identity, id, 0, context)).toThrow(/unavailable/);
});
it('invalidates pending and ready requests when another connection advances the snapshot', () => {
  const { store, path } = fixture(); const other = open(path), expected = state(store);
  const pending = store.beginSuggestions(identity, expected), completed = store.beginSuggestions(identity, expected);
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
it('preserves owned and missing/null foreign provenance through repeated rebase mappings and restart', () => {
  const { store, path } = fixture(); store.recordHistory(identity, state(store), oid(1), oid(3), [
    { sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }, { sha: oid(3), owner: null, origin: 'foreign', sourceSha: null },
  ]);
  const snapshot = store.recordRebase(identity, state(store), oid(10), oid(14), [2,3,4].map(n => ({ oldSha: oid(n), newSha: oid(n + 10) })));
  store.recordRebase(identity, state(store), oid(20), oid(24), [12,13,14].map(n => ({ oldSha: oid(n), newSha: oid(n + 10) })));
  const recovered = open(path); expect(recovered.ownership(identity).get(oid(22))).toBe('P1');
  expect(recovered.ownership(identity).get(oid(23))).toBeNull(); expect(recovered.ownership(identity).get(oid(24))).toBeNull();
  expect(recovered.getLedger(identity).find(e => e.sha === oid(24))).toEqual({ sha: oid(24), owner: null, origin: 'foreign', sourceSha: oid(14) });
  expect(recovered.getRewrites(identity, snapshot.id)).toHaveLength(3);
});
it('feeds persisted remapped ownership into the linking engine on real Git history', () => {
  const dir = directory(); const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  store.saveReview(identity, state(store), [approval], [choice]);
  const recovered = open(path).getReview(identity);
  expect(recovered.approvals[0]!.fingerprint).toBe(approval.fingerprint); expect(recovered.choices[0]!.key).toBe(choice.key);
  expect(approvalStates(current, [segment], recovered.approvals, identity).P1).toBe('approved');
  expect(approvalStates(current, [{ ...segment, content: segment.content.replace(oid(2), oid(3)) }], recovered.approvals, identity).P1).toBe('stale');
  const old = state(store); store.importRevision(JSON.stringify({ ...plan(), items: [{ ...plan().items[0]!, title: 'Changed' }] }), 'json', context, 1);
  expect(() => store.saveReview(identity, old, [approval], [])).toThrow(/Stale/);
  expect(approvalStates(store.getPlan(identity), [segment], store.getReview(identity).approvals, identity).P1).toBe('stale');
});
it('retains checkpoint scope evidence after amended continuation and rejects a moved head', () => {
  const { store, path } = fixture(); const checkpoint = store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: [...context.baseEntries, { path: 'outside', kind: 'file' }] });
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store))).toThrow(/amended/);
  store.importRevision(JSON.stringify(plan()), 'json', context, 1);
  store.approveContinuation(identity, checkpoint.id, state(store));
  const recovered = open(path); expect(recovered.getCheckpoint(identity, checkpoint.id)).toEqual(checkpoint); expect(recovered.continuationRevision(identity, checkpoint.id)).toBe(2);
  store.recordHistory(identity, state(store), oid(1), oid(3), []);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store))).toThrow(/checkpoint/);
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
    const id = store.beginSuggestions(context.identity, {revision: 1, snapshotId: store.getSnapshot(context.identity).id});
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
  const { store } = fixture(); const checkpoint = store.recordCheckpoint(identity, state(store), { item: 'P1', completedItems: ['P1'], outOfScopePaths: ['outside'], baseEntries: context.baseEntries });
  store.importRevision(JSON.stringify(plan()), 'json', context, 1); store.approveContinuation(identity, checkpoint.id, state(store));
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store))).not.toThrow();
  store.importRevision(JSON.stringify(plan()), 'json', context, 2);
  expect(store.continuationRevision(identity, checkpoint.id)).toBe(2);
  expect(() => store.approveContinuation(identity, checkpoint.id, state(store))).not.toThrow();
  expect(store.continuationRevision(identity, checkpoint.id)).toBe(3);
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

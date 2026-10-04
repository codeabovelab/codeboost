import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { EditReply, Plan, PlanContext } from '../core/plan.ts';
import type { AuthorRequest } from '../core/planning-author.ts';
import { SuggestionCoordinator, type SuggestionInput } from '../core/planning-suggestions.ts';
import { Store } from '../runner/store.ts';

// Plan drafts (#124): a whole next revision of the current plan, kept as a durable request until it is applied.
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }, { path: 'b', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan = (revision = 1, summary = 'Example'): Plan => ({ schema_version: 1, revision, issue: 1, summary, questions: [],
  items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }],
    acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const redraft = (revision = 2): Plan => ({ ...plan(revision, 'Redrafted'), items: [
  ...plan().items, { id: 'P2', title: 'Second', intent: 'Also', files: [{ path: 'b', kind: 'edit', renamed_from: null, change: 'Change b' }],
    acceptance: [{ type: 'check', text: 'Works too' }], depends_on: ['P1'] }] });
const cards = (revision = 1): EditReply => ({ schema_version: 1, base_revision: revision, reply: 'Suggestion', edits: [{ op: 'set_field',
  item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Updated', file: null, check: null, check_index: null, depends_on: null, new_item: null }] });
const oid = (n: number) => n.toString(16).padStart(40, '0');

const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-drafts-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite'), open = () => { const store = new Store(path); stores.push(store); return store; };
  const store = open();
  store.createPlan(JSON.stringify(plan()), 'json', context, oid(1), oid(2));
  return { store, open, path };
}
const state = (store: Store) => ({ revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id });
function readyDraft(store: Store, reply: unknown = redraft()) {
  const id = store.beginSuggestions(identity, state(store), 'draft');
  store.completeSuggestions(identity, id, reply);
  return id;
}

it('applies a ready draft as the next revision once, and keeps the earlier revision', () => {
  const { store, open } = fixture(), id = readyDraft(store);
  expect(store.getDraft(identity, id)).toEqual({ state: 'ready', revision: 1, snapshotId: store.getSnapshot(identity).id, plan: redraft(), reason: null });
  const reopened = open();
  const applied = reopened.applyDraft(identity, id, context);
  expect(applied).toEqual(redraft());
  expect(store.getPlan(identity)).toEqual(redraft());
  expect(store.getPlan(identity, 1)).toEqual(plan());
  expect(store.getDraft(identity, id).state).toBe('consumed');
  expect(() => store.applyDraft(identity, id, context)).toThrow('Draft is unavailable.');
});

it('keeps drafts and suggestions apart: neither ID works on the other\'s path', () => {
  const { store } = fixture(), draft = readyDraft(store);
  const suggestion = store.beginSuggestions(identity, state(store));
  store.completeSuggestions(identity, suggestion, cards());
  expect(() => store.applySuggestion(identity, draft, 0, context)).toThrow('Suggestion is unavailable.');
  expect(() => store.applyDraft(identity, suggestion, context)).toThrow('Draft is unavailable.');
  expect(() => store.getDraft(identity, suggestion)).toThrow('Unknown draft request.');
  // The shared read names the mode and never decodes a draft as cards.
  expect(store.getSuggestions(identity, draft)).toMatchObject({ mode: 'draft', state: 'ready', reply: null });
  expect(store.getSuggestions(identity, suggestion)).toMatchObject({ mode: 'suggest', reply: cards() });
});

it.each([
  ['cards for a draft', cards(), /must have required property 'issue'/, 'draft'],
  ['a draft of the current revision', redraft(1), /Draft request is stale/, 'draft'],
  ['a draft for another issue', { ...redraft(), issue: 2 }, /Draft request is stale/, 'draft'],
  ['a plan for a suggestion', redraft(), /edit-schema|must have required property/, 'suggest'],
] as const)('refuses %s at publication, leaving the request pending', (_, reply, message, mode) => {
  const { store } = fixture(), id = store.beginSuggestions(identity, state(store), mode);
  expect(() => store.completeSuggestions(identity, id, reply)).toThrow(message);
  expect(store.getSuggestions(identity, id).state).toBe('pending');
});

it('refuses a draft made stale by a new revision or snapshot', () => {
  const { store } = fixture(), byRevision = readyDraft(store);
  store.importRevision(JSON.stringify(plan(1, 'Imported')), 'json', context, 1);
  expect(store.getDraft(identity, byRevision)).toMatchObject({ state: 'invalidated', reason: 'Plan revision changed.' });
  expect(() => store.applyDraft(identity, byRevision, context)).toThrow('Draft is unavailable.');
  const bySnapshot = readyDraft(store, redraft(3));
  store.recordHistory(identity, state(store), oid(3), oid(4), []);
  expect(() => store.applyDraft(identity, bySnapshot, context)).toThrow('Draft is unavailable.');
  expect(store.getPlan(identity).revision).toBe(2);
});

it('checks a draft like an import when it is applied', () => {
  const { store } = fixture();
  // Schema-valid, so it is published, but it names a file the base does not have.
  const id = readyDraft(store, { ...redraft(), items: [{ ...redraft().items[0]!, files: [{ path: 'missing', kind: 'edit', renamed_from: null, change: 'x' }] }] });
  expect(() => store.applyDraft(identity, id, context)).toThrow();
  expect(store.getPlan(identity).revision).toBe(1);
  expect(store.getDraft(identity, id).state).toBe('ready');
});

it.each([9, 10])('migrates a v%i database to v11, reading its existing requests as suggestions', version => {
  const { store, path, open } = fixture(), id = store.beginSuggestions(identity, state(store));
  store.close(); stores.splice(stores.indexOf(store), 1);
  const legacy = new DatabaseSync(path);
  legacy.exec(`ALTER TABLE requests DROP COLUMN mode; PRAGMA user_version=${version};`);
  legacy.close();
  const migrated = open();
  expect(migrated.getSuggestions(identity, id)).toMatchObject({ mode: 'suggest', state: 'pending' });
  const db = new DatabaseSync(path);
  try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 }); } finally { db.close(); }
});

/** E3 in draft mode, with a provider that answers from `source`. */
function coordinate(store: Store, source: (request: AuthorRequest) => string) {
  const requests: AuthorRequest[] = [];
  const coordinator = new SuggestionCoordinator(store, { async invoke(request) { requests.push(request); return source(request); } });
  const input: SuggestionInput = { context, revision: 1, snapshotId: store.getSnapshot(identity).id, feedback: 'Split the work.',
    repo: { name: 'repo', baseRef: 'main', baseSha: oid(1), paths: ['a', 'b'] },
    issue: { number: 1, title: 'Issue', body: 'Body', comments: [] }, approvedLessons: [] };
  return { coordinator, input, requests };
}

it('drafts the next revision through E3, bound to the current one', async () => {
  const { store } = fixture(), { coordinator, input, requests } = coordinate(store, () => JSON.stringify(redraft()));
  try {
    const handle = coordinator.start(input, 'draft');
    expect(await handle.result).toMatchObject({ state: 'completed', id: handle.id });
    expect(requests[0]).toMatchObject({ mode: 'draft', phase: 'planning', access: 'read-only', revision: 2, requestId: handle.id });
    expect(store.getDraft(identity, handle.id)).toMatchObject({ state: 'ready', revision: 1, plan: redraft() });
    expect(store.applyDraft(identity, handle.id, context).revision).toBe(2);
  } finally { await coordinator.close(); }
});

it('records a draft that is not the next revision as failed, without a new revision', async () => {
  const { store } = fixture(), { coordinator, input } = coordinate(store, () => JSON.stringify(redraft(5)));
  try {
    const handle = coordinator.start(input, 'draft');
    expect(await handle.result).toMatchObject({ state: 'failed' });
    expect(store.getDraft(identity, handle.id)).toMatchObject({ state: 'failed', plan: null });
    expect(store.getPlan(identity).revision).toBe(1);
  } finally { await coordinator.close(); }
});

it('marks a draft stale when the plan changes while Claude writes it', async () => {
  const { store } = fixture();
  const { coordinator, input } = coordinate(store, () => {
    store.importRevision(JSON.stringify(plan(1, 'Imported meanwhile')), 'json', context, 1);
    return JSON.stringify(redraft());
  });
  try {
    const handle = coordinator.start(input, 'draft');
    expect(await handle.result).toMatchObject({ state: 'stale' });
    expect(store.getDraft(identity, handle.id).state).toBe('invalidated');
    expect(store.getPlan(identity).summary).toBe('Imported meanwhile');
  } finally { await coordinator.close(); }
});

it('runs one planning invocation per plan, shared by drafts and suggestions', async () => {
  const { store } = fixture();
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const { coordinator, input } = coordinate(store, () => JSON.stringify(redraft()));
  const slow = new SuggestionCoordinator(store, { async invoke() { await held; return JSON.stringify(redraft()); } });
  try {
    const draft = slow.start(input, 'draft');
    expect(() => slow.start(input)).toThrow('A suggestion invocation is still active for this plan.');
    release();
    await draft.result;
  } finally { await slow.close(); await coordinator.close(); }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { choiceKeys } from '../core/approvals.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { startServer, type PlanningDeps } from '../web/server.ts';
import { Store } from '../runner/store.ts';
import type { AuthorProvider } from '../core/planning-author.ts';
import type { EditReply } from '../core/plan.ts';

// Integration tests against the real server and git: each review load reads git history, so allow more than vitest's 5 s default.
vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type App = Awaited<ReturnType<typeof startServer>>;
async function serve(options: { planning?: PlanningDeps; questionAgent?: () => Promise<string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-f1e-')); roots.push(root);
  const config = createDemo(join(root, 'demo'));
  const app = await startServer(config, 0, options.questionAgent ?? (async () => 'answer'), undefined, 2_000, undefined, options.planning);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closers.push(close);
  return { app, config, close };
}
async function api(app: App, method: string, path: string, body?: unknown) {
  const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const review = async (app: App) => (await api(app, 'GET', '/api/review')).body;
/** Close the task so lane J's read path opens, then read the events from a fresh Store. */
async function eventsAfterClose(app: App, config: { database: string; identity: { repositoryId: string; taskId: string; planId: string } }, close: () => Promise<void>) {
  const version = (await api(app, 'GET', '/api/runner')).body.stateVersion;
  await api(app, 'POST', '/api/runner', { action: 'cancel-task', expectedStateVersion: version, actionId: randomUUID() });
  await close();
  const store = new Store(config.database);
  try { return store.feedbackEvents(config.identity); } finally { store.close(); }
}

describe('feedback from review actions', () => {
  it('records a change note and its feedback event together, and replays by action ID', async () => {
    const { app, config, close } = await serve();
    const actionId = randomUUID(), note = { action: 'note', kind: 'change', item: 'P1', text: 'Handle the 5xx path', token: (await review(app)).token, actionId };
    expect((await api(app, 'POST', '/api/action', note)).status).toBe(200);
    expect((await api(app, 'POST', '/api/action', note)).status).toBe(200);
    const saved = (await review(app)).notes.filter((n: { text: string }) => n.text === 'Handle the 5xx path');
    expect(saved).toHaveLength(1);
    const events = await eventsAfterClose(app, config, close);
    expect(events.map(e => [e.kind, e.item, e.text, e.sourceRef, e.actionId])).toEqual([
      ['change-request', 'P1', 'Handle the 5xx path', saved[0].id, actionId], ['task-closed', null, null, events[1]!.planKey, events[1]!.actionId]]);
  });
  it('refuses a feedback-producing action without an action ID and writes nothing', async () => {
    const { app } = await serve();
    const response = await api(app, 'POST', '/api/action', { action: 'note', kind: 'change', item: 'P1', text: 'no id', token: (await review(app)).token });
    expect(response).toMatchObject({ status: 400, body: { error: 'actionId is required for this action.' } });
    expect((await review(app)).notes.some((n: { text: string }) => n.text === 'no id')).toBe(false);
  });
  it('records a segment choice with a fixed-size source, and links a later choice for the same source', async () => {
    const { app, config, close } = await serve();
    const loaded = app.service.load(), index = loaded.segments.findIndex(s => s.row === 'Unplanned');
    const sourceRef = `choice:${createHash('sha256').update(choiceKeys(loaded.segments, config.identity)[index]!).digest('hex')}`;
    const accepted = await api(app, 'POST', '/api/action', { action: 'accept', key: loaded.segments[index]!.key, token: loaded.token, actionId: randomUUID() });
    expect(accepted.status).toBe(200);
    // The review actions cannot reassign an accepted segment yet, so the later choice goes through the Store directly.
    const store = app.service.store, later = randomUUID();
    store.userAction(config.identity, { actionId: later, kind: 'assign', request: {} },
      () => store.recordFeedback(config.identity, later, { kind: 'segment-assign', item: 'P1', sourceRef, supersedeLatest: true }));
    const [first, second] = await eventsAfterClose(app, config, close);
    expect(first).toMatchObject({ kind: 'segment-accept', sourceRef, supersedes: null });
    expect(sourceRef).toMatch(/^choice:[0-9a-f]{64}$/);
    expect(second).toMatchObject({ kind: 'segment-assign', item: 'P1', sourceRef, supersedes: first!.id });
  });
  it('records no feedback for a question, and does not start its agent again on replay', async () => {
    let calls = 0;
    const { app, config, close } = await serve({ questionAgent: async () => { calls++; return 'answer'; } });
    const question = { action: 'note', kind: 'question', item: 'P1', text: 'Why?', token: (await review(app)).token, actionId: randomUUID() };
    await api(app, 'POST', '/api/action', question);
    await api(app, 'POST', '/api/action', question);
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect((await eventsAfterClose(app, config, close)).map(e => e.kind)).toEqual(['task-closed']);
  });
  it('replays a refused review action as the same refusal', async () => {
    const { app } = await serve();
    const stale = { action: 'note', kind: 'change', item: 'P1', text: 'late', token: 'stale-token', actionId: randomUUID() };
    const first = await api(app, 'POST', '/api/action', stale);
    expect(first.status).toBe(409);
    expect(await api(app, 'POST', '/api/action', stale)).toEqual(first);
  });
});

describe('planning API for lane G', () => {
  const reply = (revision: number): EditReply => ({ schema_version: 1, base_revision: revision, reply: 'Suggestion', edits: [{ op: 'set_field',
    item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Clearer title', file: null, check: null, check_index: null, depends_on: null, new_item: null }] });
  function planning() {
    const calls: { signal: AbortSignal; resolve: (reply: string) => void }[] = [];
    const provider: AuthorProvider = { invoke: (_request, signal) => new Promise((resolve, reject) => {
      calls.push({ signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
    const deps: PlanningDeps = { provider, describe: () => ({ repo: { name: 'retry-service', baseRef: 'main' }, issue: { number: 3, title: 'Retries', body: '', comments: [] }, approvedLessons: [] }) };
    return { deps, calls };
  }
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); };

  it('refuses to start suggestions until a planning provider exists', async () => {
    const { app } = await serve();
    const view = await review(app);
    const response = await api(app, 'POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() });
    expect(response).toMatchObject({ status: 409, body: { error: 'Planning agent not available yet.' } });
  });
  it('imports a revision once per action ID and refuses a stale expected revision', async () => {
    const { app } = await serve();
    const view = await review(app);
    const source = JSON.stringify({ ...view.plan, summary: 'Imported summary' });
    const request = { source, format: 'json', expectedRevision: view.plan.revision, actionId: randomUUID() };
    const first = await api(app, 'POST', '/api/plan/import', request);
    expect(first.body.result).toEqual({ revision: view.plan.revision + 1 });
    expect((await api(app, 'POST', '/api/plan/import', request)).body.result).toEqual(first.body.result);
    expect((await review(app)).plan.revision).toBe(view.plan.revision + 1);
    expect((await api(app, 'POST', '/api/plan/import', { ...request, actionId: randomUUID() })).status).toBe(409);
  });
  it('starts, reads, and applies a suggestion exactly once', async () => {
    const { deps, calls } = planning();
    const { app } = await serve({ planning: deps });
    const view = await review(app);
    const started = await api(app, 'POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: 'Clearer titles', actionId: randomUUID() });
    const id = started.body.result.requestId;
    expect((await api(app, 'GET', `/api/plan/suggestions/${id}`)).body.state).toBe('pending');
    await until(() => calls.length === 1);
    calls[0]!.resolve(JSON.stringify(reply(view.plan.revision)));
    let status = (await api(app, 'GET', `/api/plan/suggestions/${id}`)).body;
    for (let i = 0; i < 50 && status.state === 'pending'; i++) { await new Promise(r => setTimeout(r, 20)); status = (await api(app, 'GET', `/api/plan/suggestions/${id}`)).body; }
    expect(status.state).toBe('ready');
    const apply = { index: 0, actionId: randomUUID() };
    const applied = await api(app, 'POST', `/api/plan/suggestions/${id}/apply`, apply);
    expect(applied.body.result).toEqual({ revision: view.plan.revision + 1 });
    expect((await api(app, 'POST', `/api/plan/suggestions/${id}/apply`, apply)).body.result).toEqual(applied.body.result);
    expect((await review(app)).plan.revision).toBe(view.plan.revision + 1);
  });
  it('cancels a pending suggestion through its handle and a ready one through the Store', async () => {
    const { deps, calls } = planning();
    const { app } = await serve({ planning: deps });
    let view = await review(app);
    const pending = (await api(app, 'POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() })).body.result.requestId;
    await until(() => calls.length === 1);
    expect((await api(app, 'POST', `/api/plan/suggestions/${pending}/cancel`, { actionId: randomUUID() })).body.result).toEqual({ state: 'cancelling' });
    expect(calls[0]!.signal.aborted).toBe(true);
    let state = (await api(app, 'GET', `/api/plan/suggestions/${pending}`)).body.state;
    for (let i = 0; i < 50 && state === 'pending'; i++) { await new Promise(r => setTimeout(r, 20)); state = (await api(app, 'GET', `/api/plan/suggestions/${pending}`)).body.state; }
    expect(state).toBe('cancelled');
    view = await review(app);
    const ready = (await api(app, 'POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() })).body.result.requestId;
    await until(() => calls.length === 2);
    calls[1]!.resolve(JSON.stringify(reply(view.plan.revision)));
    for (let i = 0; i < 50 && (await api(app, 'GET', `/api/plan/suggestions/${ready}`)).body.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
    expect((await api(app, 'POST', `/api/plan/suggestions/${ready}/cancel`, { actionId: randomUUID() })).body.result).toEqual({ state: 'cancelled' });
  });
  it('settles a pending suggestion at shutdown instead of leaving it pending', async () => {
    const { deps, calls } = planning();
    const { app, config, close } = await serve({ planning: deps });
    const view = await review(app);
    const id = (await api(app, 'POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() })).body.result.requestId;
    await until(() => calls.length === 1);
    await close();
    const store = new Store(config.database);
    try { expect(store.getSuggestions(config.identity, id).state).not.toBe('pending'); } finally { store.close(); }
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import type { EditReply } from '../core/plan.ts';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { startServer, type PlanningDeps } from '../web/server.ts';
import { Store } from '../runner/store.ts';

// The draft API (#124) on the real server and Store, with a stand-in provider.
vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
type Answer = (request: AuthorRequest, signal: AbortSignal) => Promise<string>;
type View = { plan: Record<string, any>; snapshot: { id: string } };
/** `answer` is made from the review as it was when the server started. */
async function serve(answer: (view: View) => Answer, options: { describe?: PlanningDeps['describe']; prepare?: (config: ReturnType<typeof createDemo>) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-drafts-api-')); roots.push(root);
  const config = createDemo(join(root, 'demo'));
  options.prepare?.(config);
  const requests: AuthorRequest[] = [];
  let answering!: Answer;
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request); return answering(request, signal); } };
  let issue = 0;
  const planning: PlanningDeps = { provider, describe: options.describe ?? (() => ({ issue: { number: issue, title: 'Retries', body: '', comments: [] },
    approvedLessons: [], repo: { name: 'retry-service', baseRef: 'main' }, validate: () => undefined })) };
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, planning);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closers.push(close);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token,
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const view = (await api('GET', '/api/review')).body as View;
  issue = view.plan.issue; answering = answer(view);
  const start = (kind: 'drafts' | 'suggestions') => api('POST', `/api/plan/${kind}`, { expectedRevision: view.plan.revision,
    snapshotId: view.snapshot.id, feedback: 'Make it two items.', actionId: randomUUID() });
  const settled = async (kind: 'drafts' | 'suggestions', id: string) => {
    await vi.waitFor(async () => expect((await api('GET', `/api/plan/${kind}/${id}`)).body.state).not.toBe('pending'));
    return (await api('GET', `/api/plan/${kind}/${id}`)).body;
  };
  return { api, view, requests, start, settled, config, close };
}
/** The review's plan, redrafted as the next revision with a new summary. */
const redraft = (view: View): Answer => async request => JSON.stringify({ ...view.plan, revision: request.revision, summary: 'Redrafted by Claude' });
const cards = (revision: number): EditReply => ({ schema_version: 1, base_revision: revision, reply: 'Rename', edits: [{ op: 'set_field',
  item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Clearer title', file: null, check: null, check_index: null, depends_on: null, new_item: null }] });

it('drafts the next revision, keeps it until applied, then applies it exactly once', async () => {
  const served = await serve(redraft);
  const started = await served.start('drafts');
  expect(started).toMatchObject({ status: 200, body: { result: { requestId: expect.any(String) } } });
  const id = started.body.result.requestId as string;
  expect(served.requests[0]).toMatchObject({ mode: 'draft', revision: served.view.plan.revision + 1, requestId: id });
  const draft = await served.settled('drafts', id);
  expect(draft).toMatchObject({ state: 'ready', revision: served.view.plan.revision, plan: { summary: 'Redrafted by Claude' } });
  // Still the old revision until the user applies the draft.
  expect((await served.api('GET', '/api/review')).body.plan.revision).toBe(served.view.plan.revision);
  const apply = { actionId: randomUUID() };
  const applied = await served.api('POST', `/api/plan/drafts/${id}/apply`, apply);
  expect(applied).toEqual({ status: 200, body: { result: { revision: served.view.plan.revision + 1 } } });
  expect(await served.api('POST', `/api/plan/drafts/${id}/apply`, apply)).toEqual(applied);
  expect(await served.api('POST', `/api/plan/drafts/${id}/apply`, { actionId: randomUUID() }))
    .toMatchObject({ status: 409, body: { error: 'Draft is unavailable.' } });
  expect((await served.api('GET', '/api/review')).body.plan).toMatchObject({ revision: served.view.plan.revision + 1, summary: 'Redrafted by Claude' });
});

it('prepares a follow-up planning request from the checkpoint tree and applies the suffix safely', async () => {
  const served = await serve(view => async request => request.mode === 'draft'
    ? JSON.stringify({ ...view.plan, revision: request.revision, summary: 'Continue from checkpoint' })
    : JSON.stringify({ schema_version: 1, base_revision: request.revision, reply: 'Rename suffix', edits: [{
      op: 'set_field', item: 'P2', summary: 'Rename suffix', reason: 'Clearer', field: 'title', value: 'Updated suffix title',
      file: null, check: null, check_index: null, depends_on: null, new_item: null,
    }] }), { prepare: config => {
      const service = new ReviewService(config);
      try {
        const current = service.store.getPlan(config.identity), base = service.planContext();
        current.items[0]!.files = [{ path: 'planned.ts', kind: 'add', renamed_from: null, change: 'Original planned output' }];
        service.store.importRevision(JSON.stringify(current), 'json', base, current.revision);
        const audited = service.planContextAt(service.store.getSnapshot(config.identity).head);
        const completed = service.store.getPlan(config.identity), snapshot = service.store.getSnapshot(config.identity);
        service.store.recordCheckpoint(config.identity, { revision: completed.revision, snapshotId: snapshot.id,
          reviewVersion: service.store.reviewVersion(config.identity) }, {
          item: 'P1', completedItems: ['P1'], outOfScopePaths: ['debug.log'], baseEntries: audited.baseEntries,
        });
        completed.items[0]!.files.push({ path: 'debug.log', kind: 'edit', renamed_from: null, change: 'Declare observed output' });
        completed.items[1]!.files = [{ path: 'planned.ts', kind: 'add', renamed_from: null, change: 'Create output not present at checkpoint' }];
        service.store.importRevision(JSON.stringify(completed), 'json', service.planContextForAmendment(), completed.revision);
      } finally { service.close(); }
    } });
  const { api, view, requests } = served;
  const start = (kind: 'drafts' | 'suggestions') => api('POST', `/api/plan/${kind}`, {
    expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID(),
  });
  const started = await start('suggestions');
  expect(started).toMatchObject({ status: 200, body: { result: { requestId: expect.any(String) } } });
  const id = started.body.result.requestId as string;
  await served.settled('suggestions', id);
  expect(requests[0]!.mode).toBe('suggest');
  expect(await api('POST', `/api/plan/suggestions/${id}/apply`, { index: 0, actionId: randomUUID() }))
    .toMatchObject({ status: 200, body: { result: { revision: view.plan.revision + 1 } } });
  expect((await api('GET', '/api/review')).body.plan.items[1].title).toBe('Updated suffix title');
  const refreshed = (await api('GET', '/api/review')).body as View;
  const draftStart = await api('POST', '/api/plan/drafts', { expectedRevision: refreshed.plan.revision,
    snapshotId: refreshed.snapshot.id, feedback: '', actionId: randomUUID() });
  expect(draftStart.status).toBe(200);
  const draftId = draftStart.body.result.requestId as string;
  await served.settled('drafts', draftId);
  expect((await api('POST', `/api/plan/drafts/${draftId}/apply`, { actionId: randomUUID() })).status).toBe(200);
});

it.each(['drafts', 'suggestions'] as const)('API %s apply commits invalidation when checkpoint lineage changes after the reply is ready', async kind => {
  const served = await serve(view => async request => request.mode === 'draft'
    ? JSON.stringify({ ...view.plan, revision: request.revision }) : JSON.stringify(cards(view.plan.revision)));
  const id = (await served.start(kind)).body.result.requestId as string;
  await served.settled(kind, id);
  const service = new ReviewService(served.config);
  try {
    const store = service.store, identity = served.config.identity, plan = store.getPlan(identity), snapshot = store.getSnapshot(identity);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute',
      item: plan.items[0]!.id, expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    store.markRunning(identity, attempt.id);
    store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true,
      result: { head: snapshot.head, unchanged: true, inScope: [], outOfScope: [] } });
    store.recordCheckpoint(identity, { revision: plan.revision, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, {
      item: plan.items[0]!.id, completedItems: [plan.items[0]!.id], outOfScopePaths: ['debug.log'], baseEntries: service.planContext().baseEntries,
    });
  } finally { service.close(); }
  const action = { actionId: randomUUID(), ...(kind === 'suggestions' ? { index: 0 } : {}) };
  expect(await served.api('POST', `/api/plan/${kind}/${id}/apply`, action)).toMatchObject({ status: 409,
    body: { error: kind === 'drafts' ? 'Draft is unavailable.' : 'Suggestion is unavailable.' } });
  expect((await served.api('GET', `/api/plan/${kind}/${id}`)).body.state).toBe('invalidated');
});

it('keeps draft and suggestion IDs on their own routes', async () => {
  const served = await serve(view => async (request, signal) => request.mode === 'draft' ? redraft(view)(request, signal)
    : JSON.stringify(cards(view.plan.revision)));
  const draft = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', draft);
  const suggestion = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', suggestion);
  expect(await served.api('GET', `/api/plan/suggestions/${draft}`)).toMatchObject({ status: 409, body: { error: 'Unknown suggestion request.' } });
  expect(await served.api('GET', `/api/plan/drafts/${suggestion}`)).toMatchObject({ status: 409, body: { error: 'Unknown draft request.' } });
  expect(await served.api('POST', `/api/plan/suggestions/${draft}/apply`, { index: 0, actionId: randomUUID() }))
    .toMatchObject({ status: 409, body: { error: 'Unknown suggestion request.' } });
  expect(await served.api('POST', `/api/plan/drafts/${suggestion}/cancel`, { actionId: randomUUID() }))
    .toMatchObject({ status: 409, body: { error: 'Unknown draft request.' } });
  // Both are still ready: nothing above changed them.
  expect((await served.api('GET', `/api/plan/drafts/${draft}`)).body.state).toBe('ready');
  expect((await served.api('GET', `/api/plan/suggestions/${suggestion}`)).body).toMatchObject({ mode: 'suggest', state: 'ready' });
});

it('cancels a draft while Claude is still writing it', async () => {
  const served = await serve(() => (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const id = (await served.start('drafts')).body.result.requestId as string;
  expect(await served.api('POST', `/api/plan/drafts/${id}/cancel`, { actionId: randomUUID() })).toEqual({ status: 200, body: { result: { state: 'cancelling' } } });
  expect(await served.settled('drafts', id)).toMatchObject({ state: 'cancelled', plan: null, reason: 'Cancelled by the user.' });
});

it('refuses an action ID reused across kinds, or across two drafts', async () => {
  const served = await serve(redraft);
  const actionId = randomUUID(), body = { expectedRevision: served.view.plan.revision, snapshotId: served.view.snapshot.id, feedback: '', actionId };
  const first = (await served.api('POST', '/api/plan/drafts', body)).body.result.requestId as string;
  expect(await served.api('POST', '/api/plan/suggestions', body)).toMatchObject({ status: 409, body: { error: 'Action ID already used for a different request.' } });
  await served.settled('drafts', first);
  // A second ready draft against the same revision; one apply action ID must not act on both.
  const second = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', second);
  const apply = { actionId: randomUUID() };
  expect(await served.api('POST', `/api/plan/drafts/${first}/cancel`, apply)).toMatchObject({ status: 200 });
  expect(await served.api('POST', `/api/plan/drafts/${second}/cancel`, apply)).toMatchObject({ status: 409, body: { error: 'Action ID already used for a different request.' } });
  expect((await served.api('GET', `/api/plan/drafts/${second}`)).body.state).toBe('ready');
});

it('names an unknown ID by the route\'s kind', async () => {
  const served = await serve(redraft), unknown = randomUUID();
  expect(await served.api('POST', `/api/plan/drafts/${unknown}/apply`, { actionId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'Unknown draft request.' } });
  expect(await served.api('POST', `/api/plan/suggestions/${unknown}/cancel`, { actionId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'Unknown suggestion request.' } });
});

it('reports a GitHub failure before a draft as 502, recording nothing', async () => {
  const served = await serve(redraft, { describe: async () => { throw new Error('GitHub is unreachable.'); } });
  expect(await served.start('drafts')).toMatchObject({ status: 502, body: { error: 'The issue could not be read from GitHub: GitHub is unreachable.' } });
  expect(served.requests).toHaveLength(0);
});

it('refuses a draft with 503 when shutdown begins while the issue is read', async () => {
  let resolve!: () => void;
  const served = await serve(redraft, { describe: () => new Promise(done => { resolve = () => done({ issue: { number: 0, title: '', body: '', comments: [] }, approvedLessons: [], repo: { name: 'r', baseRef: 'main' }, validate: () => undefined }); }) });
  const started = served.start('drafts');
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const closing = served.close();
  resolve();
  expect(await started).toMatchObject({ status: 503 });
  await closing;
});

it('refuses one cancel action ID on two suggestions', async () => {
  const served = await serve(view => async () => JSON.stringify(cards(view.plan.revision)));
  const first = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', first);
  const second = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', second);
  const cancel = { actionId: randomUUID() };
  expect(await served.api('POST', `/api/plan/suggestions/${first}/cancel`, cancel)).toMatchObject({ status: 200 });
  expect(await served.api('POST', `/api/plan/suggestions/${second}/cancel`, cancel)).toMatchObject({ status: 409, body: { error: 'Action ID already used for a different request.' } });
  expect((await served.api('GET', `/api/plan/suggestions/${second}`)).body.state).toBe('ready');
});

it('replays a suggestion cancel recorded before #124, whose hash had no request ID', async () => {
  const served = await serve(redraft), actionId = randomUUID(), id = randomUUID();
  // What an earlier build recorded for this cancel: the body alone.
  const store = new Store(served.config.database);
  try { store.userAction(served.config.identity, { actionId, kind: 'suggestion-cancel', request: {} }, () => ({ state: 'cancelled' })); }
  finally { store.close(); }
  expect(await served.api('POST', `/api/plan/suggestions/${id}/cancel`, { actionId })).toEqual({ status: 200, body: { result: { state: 'cancelled' } } });
  // A draft route has no such history: the same action ID is a different request there.
  expect(await served.api('POST', `/api/plan/drafts/${id}/cancel`, { actionId })).toMatchObject({ status: 409 });
});

it('refuses a cancel or apply body that carries its own request ID', async () => {
  const served = await serve(redraft), id = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', id);
  expect(await served.api('POST', `/api/plan/drafts/${id}/apply`, { actionId: randomUUID(), requestId: randomUUID() }))
    .toMatchObject({ status: 400, body: { error: 'The request ID comes from the path, not the body.' } });
  expect((await served.api('GET', `/api/plan/drafts/${id}`)).body.state).toBe('ready');
});

it('replays a suggestion refusal recorded before #124 as the same refusal', async () => {
  const served = await serve(redraft), actionId = randomUUID();
  const store = new Store(served.config.database);
  try {
    expect(() => store.userAction(served.config.identity, { actionId, kind: 'suggestion-apply', request: { index: 0 } },
      () => { throw new Error('Suggestion is unavailable.'); })).toThrow();
  } finally { store.close(); }
  expect(await served.api('POST', `/api/plan/suggestions/${randomUUID()}/apply`, { index: 0, actionId }))
    .toMatchObject({ status: 409, body: { error: 'Suggestion is unavailable.' } });
});

it('does not record a storage error on a cancel as a refusal, so the same action ID can retry', async () => {
  const served = await serve(redraft), id = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', id);
  const failing = vi.spyOn(Store.prototype, 'requestMode').mockImplementationOnce(() => {
    throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' }); });
  const cancel = { actionId: randomUUID() };
  expect(await served.api('POST', `/api/plan/drafts/${id}/cancel`, cancel))
    .toEqual({ status: 503, body: { error: 'disk I/O error', outcomeUnknown: true } });
  failing.mockRestore();
  expect(await served.api('POST', `/api/plan/drafts/${id}/cancel`, cancel)).toEqual({ status: 200, body: { result: { state: 'cancelled' } } });
});

it('reports an unrecorded Apply storage error as retryable and replays the same action ID', async () => {
  const served = await serve(redraft), id = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', id);
  const failing = vi.spyOn(Store.prototype, 'applyDraft').mockImplementationOnce(() => {
    throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }); });
  const apply = { actionId: randomUUID() };
  expect(await served.api('POST', `/api/plan/drafts/${id}/apply`, apply))
    .toEqual({ status: 503, body: { error: 'database is locked', outcomeUnknown: true } });
  failing.mockRestore();
  expect(await served.api('POST', `/api/plan/drafts/${id}/apply`, apply))
    .toEqual({ status: 200, body: { result: { revision: served.view.plan.revision + 1 } } });
});

it('dismisses a ready draft, and cancels a pending one when the server shuts down', async () => {
  const dismissed = await serve(redraft), ready = (await dismissed.start('drafts')).body.result.requestId as string;
  await dismissed.settled('drafts', ready);
  expect(await dismissed.api('POST', `/api/plan/drafts/${ready}/cancel`, { actionId: randomUUID() })).toEqual({ status: 200, body: { result: { state: 'cancelled' } } });
  const held = await serve(() => (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const pending = (await held.start('drafts')).body.result.requestId as string;
  await held.close();
  const store = new Store(held.config.database);
  try { expect(store.getDraft(held.config.identity, pending)).toMatchObject({ state: 'cancelled', reason: 'Planning coordinator is closing.' }); }
  finally { store.close(); }
});

it('replays a recorded cancel before refusing a body request ID, and refuses one on suggestion routes too', async () => {
  const served = await serve(view => async () => JSON.stringify(cards(view.plan.revision)));
  const id = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', id);
  const actionId = randomUUID(), first = await served.api('POST', `/api/plan/suggestions/${id}/cancel`, { actionId });
  expect(first).toEqual({ status: 200, body: { result: { state: 'cancelled' } } });
  // A resend that also names the request in its body still replays: replay comes before every other check.
  expect(await served.api('POST', `/api/plan/suggestions/${id}/cancel`, { actionId, requestId: id })).toEqual(first);
  expect(await served.api('POST', `/api/plan/suggestions/${id}/apply`, { index: 0, actionId: randomUUID(), requestId: id }))
    .toMatchObject({ status: 400, body: { error: 'The request ID comes from the path, not the body.' } });
});

it('replays a suggestion apply recorded before #124 with its saved revision', async () => {
  const served = await serve(redraft), actionId = randomUUID();
  const store = new Store(served.config.database);
  try { store.userAction(served.config.identity, { actionId, kind: 'suggestion-apply', request: { index: 0 } }, () => ({ revision: 7 })); }
  finally { store.close(); }
  expect(await served.api('POST', `/api/plan/suggestions/${randomUUID()}/apply`, { index: 0, actionId })).toEqual({ status: 200, body: { result: { revision: 7 } } });
  // The body differs from the recorded one, so it is a different request.
  expect(await served.api('POST', `/api/plan/suggestions/${randomUUID()}/apply`, { index: 1, actionId })).toMatchObject({ status: 409 });
});

it('never replays a record of this build through another request\'s path by naming it in the body', async () => {
  const served = await serve(view => async () => JSON.stringify(cards(view.plan.revision)));
  const recorded = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', recorded);
  const other = (await served.start('suggestions')).body.result.requestId as string;
  await served.settled('suggestions', other);
  const actionId = randomUUID();
  expect((await served.api('POST', `/api/plan/suggestions/${recorded}/cancel`, { actionId })).status).toBe(200);
  // The body names the recorded request: its hash would match that record if the old-hash fallback took this body.
  expect(await served.api('POST', `/api/plan/suggestions/${other}/cancel`, { actionId, requestId: recorded }))
    .toMatchObject({ status: 409, body: { error: 'Action ID already used for a different request.' } });
  expect((await served.api('GET', `/api/plan/suggestions/${other}`)).body.state).toBe('ready');
});

it('refuses a draft against a stale revision or snapshot, starting nothing', async () => {
  const served = await serve(redraft);
  for (const stale of [{ expectedRevision: served.view.plan.revision + 1, snapshotId: served.view.snapshot.id },
    { expectedRevision: served.view.plan.revision, snapshotId: randomUUID() }])
    expect(await served.api('POST', '/api/plan/drafts', { ...stale, feedback: '', actionId: randomUUID() }))
      .toMatchObject({ status: 409, body: { error: 'Stale plan revision or snapshot. Reload before asking for a draft.' } });
  expect(served.requests).toHaveLength(0);
});

it('replays a draft start without reading GitHub again', async () => {
  let reads = 0, issue = 0;
  const served = await serve(redraft, { describe: () => { reads++; return { issue: { number: issue, title: 'Retries', body: '', comments: [] },
    approvedLessons: [], repo: { name: 'retry-service', baseRef: 'main' }, validate: () => undefined }; } });
  issue = served.view.plan.issue;
  const body = { expectedRevision: served.view.plan.revision, snapshotId: served.view.snapshot.id, feedback: '', actionId: randomUUID() };
  const first = await served.api('POST', '/api/plan/drafts', body);
  expect(first.status).toBe(200);
  expect(await served.api('POST', '/api/plan/drafts', body)).toEqual(first);
  expect(reads).toBe(1);
});

it('refuses one apply action ID on two drafts', async () => {
  const served = await serve(redraft);
  const first = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', first);
  const second = (await served.start('drafts')).body.result.requestId as string;
  await served.settled('drafts', second);
  const apply = { actionId: randomUUID() };
  expect((await served.api('POST', `/api/plan/drafts/${first}/apply`, apply)).status).toBe(200);
  expect(await served.api('POST', `/api/plan/drafts/${second}/apply`, apply)).toMatchObject({ status: 409, body: { error: 'Action ID already used for a different request.' } });
});

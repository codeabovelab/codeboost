import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import type { EditReply } from '../core/plan.ts';
import { createDemo } from '../scripts/demo.ts';
import { startServer, type PlanningDeps } from '../web/server.ts';

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
async function serve(answer: (view: View) => Answer) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-drafts-api-')); roots.push(root);
  const requests: AuthorRequest[] = [];
  let answering!: Answer;
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request); return answering(request, signal); } };
  let issue = 0;
  const planning: PlanningDeps = { provider, describe: () => ({ issue: { number: issue, title: 'Retries', body: '', comments: [] },
    approvedLessons: [], repo: { name: 'retry-service', baseRef: 'main' } }) };
  const app = await startServer(createDemo(join(root, 'demo')), 0, async () => 'answer', undefined, 2_000, undefined, undefined, planning);
  closers.push(() => app.close());
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
  return { api, view, requests, start, settled };
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

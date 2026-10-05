import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import type { IssueText } from '../github/issues.ts';
import { createDemo } from '../scripts/demo.ts';
import type { PlanningAgent } from '../runner/planning.ts';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { ISSUE_READ_TIMEOUT_MS, productionPlanning } from '../web/planning.ts';
import { DatabaseSync } from 'node:sqlite';
import { PLANNING_BUDGET_MS } from '../runner/planning-provider.ts';
import { PLANNING_SHUTDOWN_GRACE_MS, startServer, type PlanningDeps } from '../web/server.ts';

// Production planning wiring (#117): when it is on, what each request is told, and how the server awaits the issue.
vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function demo(): ReviewConfig {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-planning-prod-')); roots.push(root);
  return createDemo(join(root, 'demo'));
}
/** The demo as a production review of a GitHub issue; the server never contacts GitHub in these tests. */
function production(config = demo()): ReviewConfig {
  const service = new ReviewService(config), issue = service.store.getPlan(config.identity).issue; service.close();
  return { ...config, demo: false, github: { repository: 'acme/retry-service', pullRequest: 7, issue } };
}
const text = (number: number): IssueText => ({ number, title: 'Retries ignore the cap', body: 'Body with <tags>.', comments: ['Collaborator note.'] });
const closable = (close = vi.fn(async () => undefined)) => ({ close, invoke: vi.fn() }) as unknown as PlanningAgent;
const verified = { verifyLock: () => undefined };

it('is off in a demo and without a github block, so neither plans', () => {
  const config = demo();
  expect(productionPlanning(config, verified)).toBeUndefined();
  expect(productionPlanning({ ...config, demo: false }, verified)).toBeUndefined();
  expect(productionPlanning(production(config), verified)).toBeTypeOf('function');
});

it('tells each request the GitHub issue, the repository and the base commit, read with a bound', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const issueText = vi.fn(async (number: number) => text(number)), signal = new AbortController().signal;
  const deps = productionPlanning(config, { ...verified, issues: { issueText }, agent: () => closable() })!(service);
  expect(await deps.describe(signal)).toEqual({ issue: text(config.github!.issue), approvedLessons: [],
    repo: { name: 'acme/retry-service', baseRef: service.store.getSnapshot(config.identity).base } });
  expect(issueText).toHaveBeenCalledWith(config.github!.issue, { signal, timeoutMs: ISSUE_READ_TIMEOUT_MS });
});

it.each([['release', 'release'], ['', null]] as const)('names the configured base branch %j, or else the base commit, in the prompt', async (baseBranch, expected) => {
  const base = production(), config = { ...base, github: { ...base.github!, baseBranch } };
  const requests: AuthorRequest[] = [];
  const agent = () => ({ close: async () => undefined, invoke: async (request: AuthorRequest, signal: AbortSignal) => {
    requests.push(request); return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }) as unknown as PlanningAgent;
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined,
    productionPlanning(config, { ...verified, issues: { issueText: async number => text(number) }, agent })!);
  closers.push(() => app.close());
  const call = async (method: string, path: string, body?: unknown) => (await fetch(`${new URL(app.url).origin}${path}`, { method,
    headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<Record<string, any>>;
  const view = await call('GET', '/api/review');
  await call('POST', '/api/plan/drafts', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id, feedback: '', actionId: randomUUID() });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.prompt).toContain(`"base_ref":${JSON.stringify(expected ?? view.snapshot.base)}`);
});

it('fails requests an earlier process left pending, only after the lock is verified', () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const store = service.store, expected = { revision: store.getPlan(config.identity).revision, snapshotId: store.getSnapshot(config.identity).id };
  const pending = store.beginSuggestions(config.identity, expected, 'draft');
  // A lock that no longer names this database: nothing is settled, and startup stops.
  const refused = productionPlanning(config, { verifyLock: () => { throw new Error('The database path changed.'); }, agent: () => closable() })!;
  expect(() => refused(service)).toThrow('The database path changed.');
  expect(store.getDraft(config.identity, pending).state).toBe('pending');
  const order: string[] = [], settle = vi.spyOn(store, 'settleInterruptedRequests');
  productionPlanning(config, { verifyLock: () => { order.push('verified'); expect(settle).not.toHaveBeenCalled(); }, agent: () => closable() })!(service);
  expect(order).toEqual(['verified']);
  expect(store.getDraft(config.identity, pending)).toMatchObject({ state: 'failed', reason: 'The server stopped before this request finished. Ask again.' });
});

it('closes the Store and starts nothing when the planning setup refuses', async () => {
  const config = production(), close = vi.spyOn(ReviewService.prototype, 'close');
  const setup = productionPlanning(config, { verifyLock: () => { throw new Error('The database path changed.'); }, agent: () => closable() })!;
  await expect(startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup)).rejects.toThrow('The database path changed.');
  expect(close).toHaveBeenCalledTimes(1);
  close.mockRestore();
});

it('closes the planning agent when the server closes', async () => {
  const config = production(), close = vi.fn(async () => undefined);
  const setup = productionPlanning(config, { ...verified, issues: { issueText: async number => text(number) }, agent: () => closable(close) })!;
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup);
  await app.close();
  expect(close).toHaveBeenCalledTimes(1);
});

async function serve(planning: PlanningDeps) {
  const config = demo();
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, () => planning);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closers.push(close);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token,
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const view = (await api('GET', '/api/review')).body;
  const start = (actionId = randomUUID()) => api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision,
    snapshotId: view.snapshot.id, feedback: '', actionId });
  /** Suggestion requests the Store recorded, read from the database itself. */
  const recorded = () => {
    const db = new DatabaseSync(config.database);
    try { return (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n; } finally { db.close(); }
  };
  return { api, start, view, close, recorded };
}
/** A provider that holds each request until it is aborted, as a running container would. */
function holding() {
  const requests: AuthorRequest[] = [];
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request);
    return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  return { provider, requests };
}
const issueOf = (number: number) => ({ issue: text(number), approvedLessons: [], repo: { name: 'acme/retry-service', baseRef: 'abc' } });

it('awaits the issue before starting a suggestion, and sends it to the provider', async () => {
  const requests: AuthorRequest[] = [];
  // Holds each request open until shutdown aborts it, as a running container would.
  const provider: AuthorProvider = { invoke: (request, signal) => { requests.push(request);
    return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  let resolve!: (value: Awaited<ReturnType<PlanningDeps['describe']>>) => void;
  const described = new Promise<Awaited<ReturnType<PlanningDeps['describe']>>>(done => { resolve = done; });
  const { start, view } = await serve({ provider, describe: () => described });
  const started = start();
  await new Promise(done => setTimeout(done, 50));
  expect(requests).toHaveLength(0);
  resolve({ issue: text(view.plan.issue), approvedLessons: [], repo: { name: 'acme/retry-service', baseRef: 'abc' } });
  const response = await started;
  expect(response).toMatchObject({ status: 200, body: { result: { requestId: expect.any(String) } } });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.prompt).toContain('Retries ignore the cap');
  expect(requests[0]!.prompt).toContain('acme/retry-service');
});

it('starts no suggestion when the issue cannot be read, and reports GitHub\'s failure as 502', async () => {
  const invoke = vi.fn();
  const { start, recorded } = await serve({ provider: { invoke }, describe: async () => { throw new Error('GitHub is unreachable.'); } });
  const response = await start();
  expect(response).toMatchObject({ status: 502, body: { error: 'The issue could not be read from GitHub: GitHub is unreachable.' } });
  expect(invoke).not.toHaveBeenCalled();
  expect(recorded()).toBe(0);
});

it('replays a recorded start without reading GitHub again', async () => {
  const { provider } = holding(), describe = vi.fn();
  const { start, view } = await serve({ provider, describe });
  describe.mockResolvedValueOnce(issueOf(view.plan.issue));
  const actionId = randomUUID(), first = await start(actionId);
  expect(first.status).toBe(200);
  describe.mockRejectedValue(new Error('GitHub is unreachable.'));
  expect(await start(actionId)).toEqual(first);
  expect(describe).toHaveBeenCalledTimes(1);
});

it('reads nothing from GitHub for a start against a stale revision', async () => {
  const describe = vi.fn();
  const { api, view } = await serve({ provider: holding().provider, describe });
  const response = await api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision + 1, snapshotId: view.snapshot.id,
    feedback: '', actionId: randomUUID() });
  expect(response).toMatchObject({ status: 409, body: { error: 'Stale plan revision or snapshot. Reload before asking for suggestions.' } });
  expect(describe).not.toHaveBeenCalled();
});

it('refuses a start with 503, recording nothing, when shutdown begins while the issue is read', async () => {
  let resolve!: (value: ReturnType<typeof issueOf>) => void;
  const { start, view, close, recorded } = await serve({ provider: holding().provider,
    describe: () => new Promise(done => { resolve = done; }) });
  const started = start();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const closing = close();
  resolve(issueOf(view.plan.issue));
  expect(await started).toMatchObject({ status: 503 });
  await closing;
  expect(recorded()).toBe(0);
});

it('gives E3 the whole planning budget, not its 120-second default', async () => {
  const { provider } = holding();
  const { start, view } = await serve({ provider, describe: async () => issueOf(view.plan.issue) });
  const delays: (number | undefined)[] = [], real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms); return real(fn, ms, ...rest); }) as typeof setTimeout);
  try { expect((await start()).status).toBe(200); } finally { spy.mockRestore(); }
  expect(delays).toContain(PLANNING_BUDGET_MS);
  expect(delays).not.toContain(120_000);
});

it('ends a planning request that does not settle after shutdown aborts it by closing its worker', async () => {
  // A request stuck in lane D's synchronous setup ignores its abort until its worker is abandoned.
  let reject!: (error: Error) => void, issue = 0;
  const order: string[] = [];
  const served = await serve({ provider: { invoke: () => new Promise((_, fail) => { reject = fail; }) },
    describe: async () => issueOf(issue), close: async () => { order.push('planning closed'); reject(new Error('worker abandoned')); } });
  issue = served.view.plan.issue;
  expect((await served.start()).status).toBe(200);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const closing = served.close().then(() => order.push('server closed'));
    await vi.advanceTimersByTimeAsync(PLANNING_SHUTDOWN_GRACE_MS - 1);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await closing;
    expect(order).toEqual(['planning closed', 'server closed']);
  } finally { vi.useRealTimers(); }
});

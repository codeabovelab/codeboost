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
import { startServer, type PlanningDeps } from '../web/server.ts';

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

it('is off in a demo and without a github block, so neither plans', () => {
  const config = demo();
  expect(productionPlanning(config)).toBeUndefined();
  expect(productionPlanning({ ...config, demo: false })).toBeUndefined();
  expect(productionPlanning(production(config))).toBeTypeOf('function');
});

it('tells each request the GitHub issue, the repository and the base commit, read with a bound', async () => {
  const config = production(), service = new ReviewService(config); closers.push(() => service.close());
  const issueText = vi.fn(async (number: number) => text(number)), signal = new AbortController().signal;
  const deps = productionPlanning(config, { issues: { issueText }, agent: () => closable() })!(service);
  expect(await deps.describe(signal)).toEqual({ issue: text(config.github!.issue), approvedLessons: [],
    repo: { name: 'acme/retry-service', baseRef: service.store.getSnapshot(config.identity).base } });
  expect(issueText).toHaveBeenCalledWith(config.github!.issue, { signal, timeoutMs: ISSUE_READ_TIMEOUT_MS });
});

it('closes the planning agent when the server closes', async () => {
  const config = production(), close = vi.fn(async () => undefined);
  const setup = productionPlanning(config, { issues: { issueText: async number => text(number) }, agent: () => closable(close) })!;
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, setup);
  await app.close();
  expect(close).toHaveBeenCalledTimes(1);
});

async function serve(planning: PlanningDeps) {
  const config = demo();
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, undefined, undefined, () => planning);
  closers.push(() => app.close());
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${new URL(app.url).origin}${path}`, { method, headers: { 'x-codeboost-token': app.token,
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const view = (await api('GET', '/api/review')).body;
  const start = () => api('POST', '/api/plan/suggestions', { expectedRevision: view.plan.revision, snapshotId: view.snapshot.id,
    feedback: '', actionId: randomUUID() });
  return { api, start, view };
}

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

it('starts no suggestion when the issue cannot be read', async () => {
  const invoke = vi.fn();
  const { start, api } = await serve({ provider: { invoke }, describe: async () => { throw new Error('GitHub is unreachable.'); } });
  const response = await start();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.body.error).toContain('GitHub is unreachable.');
  expect(invoke).not.toHaveBeenCalled();
  // No suggestion request was recorded, so the plan has no pending one.
  expect((await api('GET', '/api/review')).status).toBe(200);
});

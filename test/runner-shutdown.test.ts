import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import { Store } from '../runner/store.ts';
import { ReviewService } from '../runner/review.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { ShuttingDownError } from '../runner/lifecycle.ts';
import type { RunnerDeps } from '../runner/coordinator.ts';
import type { InvocationResult } from '../agents/contract.ts';
import type { MergeGateway, MergeQueueGateway, RemoteMergeState } from '../github/merge.ts';

const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const oid = (n: number) => n.toString(16).padStart(40, '0');
function demo() { const root = mkdtempSync(join(tmpdir(), 'codeboost-shutdown-')); roots.push(root); return createDemo(join(root, 'demo')); }
type App = Awaited<ReturnType<typeof startServer>>;
async function serve(deps?: RunnerDeps) {
  const config = demo();
  const app = await startServer(config, 0, async () => 'answer', undefined, 2_000, deps);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  cleanups.push(close);
  return { app, config, close };
}
const origin = (app: App) => new URL(app.url).origin;
async function api(app: App, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin(app)}${path}`, { method, headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
/** Sends half a JSON body, lets the test start shutdown, then sends the rest. */
function partialPost(app: App, path: string, body: unknown) {
  const text = JSON.stringify(body), url = new URL(`${origin(app)}${path}`);
  let finish!: () => void;
  const response = new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(text.slice(0, 5));
    finish = () => req.end(text.slice(5));
  });
  return { response, finish: () => finish() };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('Store write gate', () => {
  it('refuses writes after closeWrites unless the capability runs them, and issues the capability once', () => {
    const config = demo(), store = new Store(config.database); cleanups.push(() => store.close());
    const capability = store.shutdownCapability();
    expect(() => store.shutdownCapability()).toThrow(/already issued/);
    store.closeWrites();
    expect(() => store.setQuestionProvider('claude')).toThrow(ShuttingDownError);
    expect(() => store.transitionTask(config.identity, store.getTask(config.identity).stateVersion, 'queued')).toThrow(ShuttingDownError);
    expect(store.getTask(config.identity).status).toBe('in review');
    capability.run(() => store.setQuestionProvider('claude'));
    expect(store.questionProvider()).toBe('claude');
  });
  it('does not record a user action refused by the gate, so the UI may resend it', () => {
    const config = demo(), store = new Store(config.database); cleanups.push(() => store.close());
    const actionId = randomUUID();
    store.closeWrites();
    expect(() => store.userAction(config.identity, { actionId, kind: 'note', request: {} }, () => 1)).toThrow(ShuttingDownError);
    store.close(); cleanups.pop();
    const reopened = new Store(config.database); cleanups.push(() => reopened.close());
    expect(reopened.userAction(config.identity, { actionId, kind: 'note', request: {} }, () => 2)).toEqual({ response: 2, replayed: false });
  });
});

describe('merge coordinator after the gate closes', () => {
  function harness(remote: Partial<RemoteMergeState>) {
    const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
    const store = new Store(':memory:'); cleanups.push(() => store.close());
    const plan = { schema_version: 1 as const, revision: 1, issue: 1, summary: 'M', questions: [], items: [{ id: 'P1', title: 'M', intent: 'M', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'M' }], acceptance: [{ type: 'check' as const, text: 'M' }], depends_on: [] }] };
    store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] }, oid(1), oid(2));
    const view = { items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [], checks: {} }], plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: store.getSnapshot(identity).id, base: oid(1), head: oid(2) }, token: 't', expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } } as unknown as ReturnType<ReviewService['load']>;
    const service = { store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService;
    const state: RemoteMergeState = { base: oid(1), head: oid(2), pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', ...remote };
    const gateway: MergeGateway & MergeQueueGateway = {
      inspect: vi.fn(async () => state), merge: vi.fn(async () => ({ url: 'https://github.example/pr/1' })),
      queueWatermark: vi.fn(async () => 'c'), inspectQueue: vi.fn(async () => ({ state: 'merged', reviewedHead: oid(2), mergedAt: '2026-09-26T00:00:00Z' }) as never),
    };
    return { store, identity, view, service, gateway };
  }
  it('rethrows ShuttingDownError from direct-merge reconciliation in displayStatus instead of returning a blocker', async () => {
    const h = harness({ pullRequestState: 'MERGED' });
    h.store.beginMergeAttempt(h.identity, h.view.expected as never, oid(2), null, 'direct');
    const coordinator = new MergeCoordinator(h.service, h.gateway);
    h.store.closeWrites();
    await expect(coordinator.displayStatus(h.view)).rejects.toBeInstanceOf(ShuttingDownError);
    expect(h.store.getMergeAttempt(h.identity)!.state).toBe('submitting');
  });
  it('rethrows ShuttingDownError from queue polling instead of reporting a queue status', async () => {
    const h = harness({ mergeQueue: true });
    const attempt = h.store.beginMergeAttempt(h.identity, h.view.expected as never, oid(2), 'c', 'queue');
    h.store.queueMergeAttempt(h.identity, attempt.id, 'https://github.example/pr/1');
    const coordinator = new MergeCoordinator(h.service, h.gateway);
    h.store.closeWrites();
    await expect(coordinator.pollQueue()).rejects.toBeInstanceOf(ShuttingDownError);
    expect(h.store.getMergeAttempt(h.identity)!.state).toBe('queued');
  });
  it('still records a merge that GitHub completed after the gate closed, through the capability', async () => {
    const h = harness({});
    const capability = h.store.shutdownCapability();
    (h.gateway.merge as ReturnType<typeof vi.fn>).mockImplementation(async () => { h.store.closeWrites(); return { url: 'https://github.example/pr/1' }; });
    await new MergeCoordinator(h.service, h.gateway, 14_000, capability).merge('t');
    expect(h.store.getMergeAttempt(h.identity)!.state).toBe('merged');
    expect(h.store.getTask(h.identity).status).toBe('merged');
  });
});

describe('server shutdown', () => {
  it('lets an admitted request finish during the drain (AGENTS.md: drain admitted requests)', async () => {
    const { app, config, close } = await serve();
    const view = (await api(app, 'GET', '/api/review')).body;
    const sent = partialPost(app, '/api/action', { action: 'note', kind: 'change', item: 'P1', text: 'admitted note', token: view.token });
    await tick();
    const closing = close();
    await tick();
    sent.finish();
    expect((await sent.response).status).toBe(200);
    await closing;
    const store = new Store(config.database); cleanups.push(() => store.close());
    expect(store.getReviewNotes(config.identity).filter(note => note.text === 'admitted note')).toHaveLength(1);
  });
  it('destroys a request still reading its body after the drain limit, and writes nothing', async () => {
    const { app, config, close } = await serve();
    const view = (await api(app, 'GET', '/api/review')).body;
    const sent = partialPost(app, '/api/action', { action: 'note', kind: 'change', item: 'P1', text: 'never finished', token: view.token });
    sent.response.catch(() => undefined);
    await tick();
    await close();
    await expect(sent.response).rejects.toThrow();
    const store = new Store(config.database); cleanups.push(() => store.close());
    expect(store.getReviewNotes(config.identity).filter(note => note.text === 'never finished')).toHaveLength(0);
  });
  it('answers 503 to a request that arrives after shutdown began', async () => {
    const { app, close } = await serve();
    const view = (await api(app, 'GET', '/api/review')).body;
    const closing = close();
    const late = await fetch(`${origin(app)}/api/action`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'note', kind: 'change', item: 'P1', text: 'late', token: view.token }) }).then(r => r.status, () => 'refused');
    expect([503, 'refused']).toContain(late);
    await closing;
  });
  it('rejects runner admission at step 1 and closes the write gate after the drain', async () => {
    const { deps } = { deps: { prepare: async () => { throw new Error('unused'); }, cleanupPreparation: async () => undefined, start: () => { throw new Error('unused'); }, validate: () => null } as RunnerDeps };
    const { app, close } = await serve(deps);
    const closing = close();
    // Step 1 is synchronous; the Store gate closes only after the drain (step 3).
    expect(app.runner!.closing).toBe(true);
    expect(app.service.store.writesClosed).toBe(false);
    await closing;
    expect(app.service.store.writesClosed).toBe(true);
  });
  it('answers 503, not 409, when a review load hits the write gate', async () => {
    const { app, config } = await serve();
    writeFileSync(join(config.repository, 'moved.txt'), 'x');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '-A'], { cwd: config.repository });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'move head'], { cwd: config.repository });
    app.service.store.closeWrites();
    const response = await api(app, 'GET', '/api/review');
    expect(response).toEqual({ status: 503, body: { error: 'The review server is shutting down.' } });
  });
});

describe('/api/runner', () => {
  function fakeRunner() {
    const settles: ((over?: Partial<InvocationResult>) => void)[] = [];
    const deps: RunnerDeps = {
      prepare: async attempt => ({ clone: { id: `c-${attempt.id}`, taskId: 't', directory: '/tmp/x', head: oid(2) }, vendor: 'claude', approvedArgv: [] }),
      cleanupPreparation: async () => undefined,
      start: input => {
        let settle!: (r: InvocationResult) => void;
        const settled = new Promise<InvocationResult>(resolve => { settle = resolve; });
        settles.push(over => settle({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: 'ok', stderr: '', ...over }));
        return { attemptId: input.attemptId, settled, cancel: () => undefined };
      },
      validate: (_a, r) => r.stdout,
    };
    return { deps, settles };
  }
  it('reports the task without a runner and refuses runner-only actions', async () => {
    const { app } = await serve();
    const view = (await api(app, 'GET', '/api/runner')).body;
    expect(view).toMatchObject({ available: false, retryable: false, stopRequested: null, unresolved: null, task: { status: 'in review' } });
    const refused = await api(app, 'POST', '/api/runner', { action: 'retry', attemptId: randomUUID(), expectedStateVersion: view.stateVersion, actionId: randomUUID() });
    expect(refused).toMatchObject({ status: 409, body: { error: 'The runner is not available yet.' } });
  });
  it('replays cancel task by action ID, refuses a reused ID, and answers 400 for a malformed ID', async () => {
    const { app } = await serve();
    const version = (await api(app, 'GET', '/api/runner')).body.stateVersion;
    const actionId = randomUUID(), cancel = { action: 'cancel-task', expectedStateVersion: version, actionId };
    const first = await api(app, 'POST', '/api/runner', cancel);
    expect(first).toMatchObject({ status: 200, body: { result: { outcome: 'closed' }, runner: { task: { status: 'cancelled' } } } });
    expect((await api(app, 'POST', '/api/runner', cancel)).body.result).toEqual(first.body.result);
    expect((await api(app, 'POST', '/api/runner', { ...cancel, action: 'retry' })).status).toBe(409);
    expect((await api(app, 'POST', '/api/runner', { ...cancel, actionId: 'not-a-uuid' })).status).toBe(400);
  });
  it('cancels a running attempt, then retries it, and shutdown waits for the running retry', async () => {
    const { deps, settles } = fakeRunner();
    const { app, config, close } = await serve(deps);
    const store = app.service.store, identity = config.identity;
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const attempt = app.runner!.start(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'review', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    for (let i = 0; i < 50 && settles.length === 0; i++) await tick();
    let view = (await api(app, 'GET', '/api/runner')).body;
    expect(view).toMatchObject({ available: true, retryable: false, attempts: [{ id: attempt.id, state: 'running' }] });
    const cancel = await api(app, 'POST', '/api/runner', { action: 'cancel-attempt', attemptId: attempt.id, expectedStateVersion: view.stateVersion, actionId: randomUUID() });
    expect(cancel.body.result).toEqual({ outcome: 'stopping' });
    expect((await api(app, 'GET', '/api/runner')).body.stopRequested).toEqual({ attemptId: attempt.id, reason: 'cancelled', saved: true });
    settles[0]!({ exitCode: null, stopReason: 'cancelled' });
    await app.runner!.settled(identity);
    view = (await api(app, 'GET', '/api/runner')).body;
    expect(view).toMatchObject({ retryable: true, attempts: [{ state: 'cancelled' }] });
    const retryId = randomUUID(), retry = { action: 'retry', attemptId: attempt.id, expectedStateVersion: view.stateVersion, actionId: retryId };
    const started = await api(app, 'POST', '/api/runner', retry);
    expect(started.body.result).toMatchObject({ outcome: 'started' });
    expect((await api(app, 'POST', '/api/runner', retry)).body.result).toEqual(started.body.result);
    for (let i = 0; i < 50 && settles.length < 2; i++) await tick();
    let closed = false;
    const closing = close().then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false);
    settles[1]!({ exitCode: null, stopReason: 'shutdown' });
    await closing;
    const reopened = new Store(config.database); cleanups.push(() => reopened.close());
    expect(reopened.getAttempt(identity, started.body.result.attemptId)).toMatchObject({ state: 'cancelled', diagnostic: 'Stopped by shutdown' });
  });
});

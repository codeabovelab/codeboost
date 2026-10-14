import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../scripts/demo.ts';
import { fixtureGit } from './fixtures/git.ts';
import { writeFileSync } from 'node:fs';
import { LOAD_ATTEMPTS, ReviewService } from '../runner/review.ts';
import { readHistory } from '../git/history.ts';
import { linkHistory } from '../core/linking.ts';
import { HISTORY_CANCEL_GRACE_MS, HISTORY_DEADLINE_GRACE_MS, HISTORY_START_GRACE_MS, MAX_HISTORY_WORKERS, runHistoryJob, type HistoryJob } from '../runner/history-job.ts';
import { Worker } from 'node:worker_threads';
import { runHistoryWork } from '../runner/history-work.ts';
import { startServer } from '../web/server.ts';
import { Store } from '../runner/store.ts';
import { alive, gatedGit } from './fixtures/gated-git.ts';

// Passthroughs, so a test can read the budget each stage was given.
vi.mock('../git/history.ts', async original => {
  const actual = await original<typeof import('../git/history.ts')>(); return { ...actual, readHistory: vi.fn(actual.readHistory) };
});
vi.mock('../core/linking.ts', async original => {
  const actual = await original<typeof import('../core/linking.ts')>(); return { ...actual, linkHistory: vi.fn(actual.linkHistory) };
});
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [], services: ReviewService[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  services.splice(0).forEach(service => service.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-history-job-')); roots.push(root);
  const config = createDemo(join(root, 'demo'));
  return { root, config };
}
/** A review service whose history reads hold at their first Git call until the test opens it. */
function held() {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  const service = new ReviewService(config); services.push(service);
  return { root, config, git, service };
}
const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

it('kills the running Git process when a history read is aborted, and settles only after it has exited', async () => {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  const service = new ReviewService(config); services.push(service);
  const { base, head } = service.store.getSnapshot(config.identity);
  const controller = new AbortController(), reason = new Error('Stopped by the test.');
  const read = readHistory(config.repository, base, head, {}, controller.signal);
  const pid = await git.held();
  expect(alive(pid)).toBe(true);
  controller.abort(reason);
  await expect(read).rejects.toBe(reason);
  expect(alive(pid)).toBe(false);
  expect(git.opened()).toBe(false);
});

it('loads the review in a worker while this thread keeps running, then applies it', async () => {
  const { git, service } = held();
  let settled = false;
  const loading = service.load().finally(() => { settled = true; });
  await git.held();
  // A synchronous load would hold this thread until Git returned, and Git waits for this thread to open the gate.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  git.open();
  const view = await loading;
  expect(view.segments.length).toBeGreaterThan(0);
  expect(view.items.length).toBeGreaterThan(0);
});

it('stops a review load on abort with the abort reason, after its Git process has exited', async () => {
  const { git, service } = held();
  const controller = new AbortController(), reason = new Error('Request cancelled during shutdown.');
  const loading = service.load({ signal: controller.signal });
  const pid = await git.held();
  controller.abort(reason);
  await expect(loading).rejects.toBe(reason);
  expect(alive(pid)).toBe(false);
});

it('enforces the review deadline in the worker, ending its Git process', async () => {
  const { git, service } = held();
  const started = performance.now();
  const loading = service.load({ maxDurationMs: 3_000 });
  const pid = await git.held();
  // The worker's own budget ends the read (the parent's backstop would say "History work exceeded…").
  await expect(loading).rejects.toThrow('History read exceeded its overall deadline.');
  expect(performance.now() - started).toBeGreaterThanOrEqual(3_000 - 50);
  expect(alive(pid)).toBe(false);
});

it('reads the history again when the review changes while the worker runs, and returns the current review', async () => {
  const { config, git, service } = held();
  const { store } = service, identity = config.identity;
  const loading = service.load();
  await git.held(1);
  const expected = { revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) };
  store.saveReview(identity, expected, [], []);
  git.open(1);
  // The first worker linked a review that is no longer current: the load reads the history a second time.
  await git.held(2); git.open(2);
  expect((await loading).expected.reviewVersion).toBe(expected.reviewVersion + 1);
  expect(git.pids()).toHaveLength(2);
});

it(`refuses a review as stale when it changes during each of the load's ${LOAD_ATTEMPTS} history reads`, async () => {
  const { config, git, service } = held();
  const { store } = service, identity = config.identity;
  const loading = service.load();
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    await git.held(attempt);
    store.saveReview(identity, { revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) }, [], []);
    git.open(attempt);
  }
  await expect(loading).rejects.toThrow('Stale review state. Reload before writing.');
  expect(git.pids()).toHaveLength(LOAD_ATTEMPTS);
});

it('lets two overlapping loads both observe a moved HEAD', async () => {
  const { config, git, service } = held();
  writeFileSync(join(config.repository, 'late.txt'), 'moved\n');
  fixtureGit(config.repository, 'add', 'late.txt'); fixtureGit(config.repository, 'commit', '-qm', 'Move HEAD');
  const head = fixtureGit(config.repository, 'rev-parse', 'HEAD');
  const first = service.load(), second = service.load();
  await git.held(1); await git.held(2);
  // Whichever worker answers first records the new snapshot; the other load finds the Store moved, reads again and agrees.
  git.open(1); git.open(2);
  await git.held(3); git.open(3);
  const [one, two] = await Promise.all([first, second]);
  expect(one.snapshot.head).toBe(head);
  expect(two.snapshot).toEqual(one.snapshot);
});

it('gives linking what the history read left of one overall deadline', async () => {
  const { config } = fixture();
  const service = new ReviewService(config); services.push(service);
  const plan = service.store.getPlan(config.identity), { base, head } = service.store.getSnapshot(config.identity);
  const link = { plan, ownership: [...service.store.ownership(config.identity)], pathIdentity: config.pathIdentity, resolvedConflicts: [] };
  vi.mocked(readHistory).mockClear(); vi.mocked(linkHistory).mockClear();
  // The budget starts when the work does (the first reading), then each stage reads the clock once.
  const clock = [0, 0, 5_000];
  const done = await runHistoryWork({ repository: config.repository, base, head, budgetMs: 10_000, link }, new AbortController().signal, () => clock.shift()!);
  expect(done.segments!.length).toBeGreaterThan(0);
  expect(vi.mocked(readHistory).mock.calls[0]![3]).toMatchObject({ maxDurationMs: 10_000 });
  expect(vi.mocked(linkHistory).mock.calls[0]![4]).toMatchObject({ maxDurationMs: 5_000 });
  // A read that uses the whole deadline leaves linking none: it never starts.
  vi.mocked(linkHistory).mockClear();
  const spent = [0, 0, 10_000];
  await expect(runHistoryWork({ repository: config.repository, base, head, budgetMs: 10_000, link }, new AbortController().signal, () => spent.shift()!))
    .rejects.toThrow('Review load exceeded its overall deadline.');
  expect(linkHistory).not.toHaveBeenCalled();
});

it('terminates a worker that cannot read the cancel, and rejects with the abort reason only once its thread has stopped', async () => {
  const controller = new AbortController(), reason = new Error('Stopped by the test.');
  const heartbeat = new SharedArrayBuffer(4), beats = new Int32Array(heartbeat);
  const job = runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 30_000, heartbeat } as HistoryJob, controller.signal,
    fixtureUrl('history-worker-busy.ts'));
  await vi.waitFor(() => expect(Atomics.load(beats, 0)).toBeGreaterThan(0));
  const aborted = performance.now();
  controller.abort(reason);
  await expect(job).rejects.toBe(reason);
  // It waited out the cancel grace, then terminate() ended the thread mid-loop instead of after its 60 s.
  expect(performance.now() - aborted).toBeGreaterThanOrEqual(HISTORY_CANCEL_GRACE_MS - 50);
  expect(performance.now() - aborted).toBeLessThan(HISTORY_CANCEL_GRACE_MS + 10_000);
  const stopped = Atomics.load(beats, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(Atomics.load(beats, 0)).toBe(stopped);
});

it('counts a job\'s budget from its worker\'s start, so a slow thread start does not cut into it', async () => {
  const started = performance.now(), startMs = 1_500;
  const job = runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 200, startMs } as HistoryJob, undefined,
    fixtureUrl('history-worker-slow-start.ts'));
  await expect(job).rejects.toThrow('History work exceeded its overall deadline.');
  expect(performance.now() - started).toBeGreaterThanOrEqual(startMs + 200 + HISTORY_DEADLINE_GRACE_MS + HISTORY_CANCEL_GRACE_MS - 50);
});

it('stops a started worker that never replies once its budget and grace have passed', async () => {
  const started = performance.now();
  const job = runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 200, startMs: 0 } as HistoryJob, undefined, fixtureUrl('history-worker-slow-start.ts'));
  await expect(job).rejects.toThrow('History work exceeded its overall deadline.');
  expect(performance.now() - started).toBeGreaterThanOrEqual(200 + HISTORY_DEADLINE_GRACE_MS + HISTORY_CANCEL_GRACE_MS - 50);
  expect(performance.now() - started).toBeLessThan(HISTORY_START_GRACE_MS);
});

it('stops a worker that never starts once the start grace, its budget and grace have passed', async () => {
  const started = performance.now();
  const job = runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 200 }, undefined, fixtureUrl('history-worker-silent.ts'));
  await expect(job).rejects.toThrow('History work exceeded its overall deadline.');
  expect(performance.now() - started).toBeGreaterThanOrEqual(HISTORY_START_GRACE_MS + 200 + HISTORY_DEADLINE_GRACE_MS + HISTORY_CANCEL_GRACE_MS - 50);
});

it('reports a history read failure from the worker with its own message', async () => {
  const { config } = fixture();
  const job = runHistoryJob({ repository: config.repository, base: 'HEAD', head: 'HEAD~1', budgetMs: 30_000 });
  await expect(job).rejects.toThrow('The base must be an ancestor of the head.');
});

it('serves other requests while a review load runs, and shutdown ends that load and its Git process', async () => {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  const app = await startServer(config, 0, undefined, undefined, 1);
  const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { 'x-codeboost-token': app.token } });
  const review = get('/api/review');
  const pid = await git.held();
  const settings = await get('/api/settings');
  expect(settings.status).toBe(200);
  const closing = app.close();
  const answer = await review;
  // As for any admitted request the drain outlasts: a refusal naming the shutdown.
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: 'Request cancelled during shutdown.' });
  await closing;
  expect(alive(pid)).toBe(false);
});

it('reports an unknown outcome when shutdown stops the reload after a review command was applied', async () => {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  const app = await startServer(config, 0, undefined, undefined, 1);
  const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const call = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const reading = call('/api/review'); await git.held(1); git.open(1);
  const view = await (await reading).json() as { token: string };
  // Load 2 is the review the command applies to; load 3, after the write, is held while the server shuts down.
  const notes = () => app.service.store.getReviewNotes(config.identity).length, before = notes();
  const command = call('/api/action', { action: 'note', item: 'P1', kind: 'question', text: 'Why cap the retry delay?', token: view.token });
  await git.held(2); git.open(2);
  await git.held(3);
  expect(notes()).toBe(before + 1);
  const closing = app.close();
  const answer = await command;
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: 'Request cancelled during shutdown.', outcomeUnknown: true });
  await closing;
});

it.each([[3, 'the reload that would start its agent'], [4, 'the response\'s final reload']])(
  'gives a question admitted before shutdown its retryable answer when shutdown stops load %i, %s', async (stoppedLoad) => {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  // A drain long enough for loads 2 and 3 on a loaded machine; the held load then waits out the rest of it.
  const app = await startServer(config, 0, async () => 'answer', undefined, 8_000);
  const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const call = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const reading = call('/api/review'); await git.held(1); git.open(1);
  const view = await (await reading).json() as { token: string };
  const asked = call('/api/action', { action: 'note', item: 'P1', kind: 'question', text: 'Why cap the retry delay?', token: view.token });
  await git.held(2);
  // Shutdown begins after the request was admitted: no Ask agent may start for its question.
  const closing = app.close();
  // Load 2 is the review the question is saved against. The stopped load is held until the drain ends and shutdown
  // aborts it.
  for (let load = 2; load < stoppedLoad; load++) { if (load > 2) await git.held(load); git.open(load); }
  await git.held(stoppedLoad);
  const answer = await asked;
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: 'Request cancelled during shutdown.', outcomeUnknown: true });
  await closing;
  const store = new Store(config.database);
  try {
    const note = store.getReviewNotes(config.identity).find(value => value.text === 'Why cap the retry delay?');
    expect(note?.answer).toMatchObject({ status: 'failed', error: 'Server stopped. Retry the question.' });
  } finally { store.close(); }
});

it('does not record a review load failure under the command\'s action ID, so the same ID can be resent', async () => {
  const { config } = fixture();
  const app = await startServer(config, 0);
  try {
    const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const call = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const view = await (await call('/api/review')).json() as { token: string };
    const command = { action: 'note', item: 'P1', kind: 'change', text: 'Keep the signature.', token: view.token, actionId: crypto.randomUUID() };
    const loads = vi.spyOn(app.service, 'load').mockRejectedValueOnce(new Error('History read failed.'));
    const failed = await call('/api/action', command);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: 'History read failed.' });
    expect(app.service.store.savedAction(config.identity, { actionId: command.actionId, kind: 'review-note', request: (({ actionId: _omit, ...rest }) => rest)(command) })).toBeUndefined();
    loads.mockClear();
    const resent = await call('/api/action', command);
    expect(resent.status).toBe(200);
    const applying = loads.mock.calls.length;
    expect(app.service.store.getReviewNotes(config.identity).filter(note => note.text === 'Keep the signature.')).toHaveLength(1);
    // A replay of the recorded command loads only the review it answers with: one load fewer than applying it.
    loads.mockClear();
    expect((await call('/api/action', command)).status).toBe(200);
    expect(loads.mock.calls.length).toBe(applying - 1);
    expect(app.service.store.getReviewNotes(config.identity).filter(note => note.text === 'Keep the signature.')).toHaveLength(1);
    loads.mockRestore();
  } finally { await app.close(); }
});

it('reports an unknown outcome when shutdown stops the reload after a question retry started an answer', async () => {
  const { root, config } = fixture(), git = gatedGit(root, '--git-common-dir');
  vi.stubEnv('PATH', git.path);
  let asks = 0;
  // The first answer fails, so the question can be retried; the retry's answer waits for its abort.
  const app = await startServer(config, 0, (_prompt, signal) => ++asks === 1 ? Promise.reject(new Error('Agent failed.'))
    : new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), undefined, 1);
  const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const call = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  // Setup loads run freely: every held call is let through until the retry.
  let setup = true;
  void (async () => { while (setup) { git.pids().forEach((_pid, index) => { if (!git.opened(index + 1)) git.open(index + 1); }); await new Promise(resolve => setTimeout(resolve, 10)); } })();
  const view = await (await call('/api/review')).json() as { token: string };
  const asked = await (await call('/api/action', { action: 'note', item: 'P1', kind: 'question', text: 'Why cap the retry delay?', token: view.token })).json() as { token: string; notes: { id: string }[] };
  const id = asked.notes.at(-1)!.id;
  await vi.waitFor(() => expect(app.service.store.getReviewNotes(config.identity).find(note => note.id === id)?.answer?.status).toBe('failed'));
  const current = await (await call('/api/review')).json() as { token: string };
  setup = false; await new Promise(resolve => setTimeout(resolve, 20));
  const loads = git.pids().length;
  const retry = call('/api/action', { action: 'retry-question', id, token: current.token });
  // The retry's review is loaded and its answer started; the response's reload is held while the server shuts down.
  await git.held(loads + 1); git.open(loads + 1);
  await git.held(loads + 2);
  expect(asks).toBe(2);
  const closing = app.close();
  const answer = await retry;
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: 'Request cancelled during shutdown.', outcomeUnknown: true });
  await closing;
});

it('reports an unknown outcome when the reload after an applied review command fails', async () => {
  const { config } = fixture();
  const app = await startServer(config, 0);
  try {
    const address = app.server.address(), origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const call = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-codeboost-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const view = await (await call('/api/review')).json() as { token: string };
    const original = app.service.load.bind(app.service);
    // The review the command applies to loads; the reload after it does not.
    const loads = vi.spyOn(app.service, 'load').mockImplementationOnce(original)
      .mockImplementationOnce(async () => { throw new Error('Stale review state. Reload before writing.'); });
    const answer = await call('/api/action', { action: 'note', item: 'P1', kind: 'question', text: 'Saved before the reload failed?', token: view.token });
    loads.mockRestore();
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: 'Stale review state. Reload before writing.', outcomeUnknown: true });
    expect(app.service.store.getReviewNotes(config.identity).filter(note => note.text === 'Saved before the reload failed?')).toHaveLength(1);
  } finally { await app.close(); }
});

it('reports the deadline, not staleness, when a load runs out of time on its last read while the review keeps changing', async () => {
  const { config, git, service } = held();
  const { store } = service, identity = config.identity;
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const loading = service.load({ maxDurationMs: 30_000 });
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
      await git.held(attempt);
      store.saveReview(identity, { revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) }, [], []);
      // Time runs out during the last read, where the read limit is reached too: the deadline is what ended the load.
      if (attempt === LOAD_ATTEMPTS) now = 30_000;
      git.open(attempt);
    }
    await expect(loading).rejects.toThrow('Review load exceeded its overall deadline.');
    expect(git.pids()).toHaveLength(LOAD_ATTEMPTS);
  } finally { clock.mockRestore(); }
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it(`runs at most ${MAX_HISTORY_WORKERS} history workers at once, starting a waiting load when a slot frees`, async () => {
  const { git, service } = held();
  const loads = Array.from({ length: MAX_HISTORY_WORKERS + 1 }, () => service.load());
  for (let n = 1; n <= MAX_HISTORY_WORKERS; n++) await git.held(n);
  await pause(500);
  // The extra load waits for a slot: no worker, so no Git process.
  expect(git.pids()).toHaveLength(MAX_HISTORY_WORKERS);
  git.open(1);
  await git.held(MAX_HISTORY_WORKERS + 1);
  for (let n = 2; n <= MAX_HISTORY_WORKERS + 1; n++) git.open(n);
  const views = await Promise.all(loads);
  expect(new Set(views.map(view => view.snapshot.id)).size).toBe(1);
});

it('never starts a load that is aborted while it waits for a worker slot', async () => {
  const { git, service } = held();
  const running = Array.from({ length: MAX_HISTORY_WORKERS }, () => service.load());
  for (let n = 1; n <= MAX_HISTORY_WORKERS; n++) await git.held(n);
  const controller = new AbortController(), reason = new Error('Stopped while waiting.');
  const waiting = service.load({ signal: controller.signal });
  // Long enough for a started worker to reach Git: none did, because this load is waiting for a slot.
  await pause(500);
  expect(git.pids()).toHaveLength(MAX_HISTORY_WORKERS);
  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);
  for (let n = 1; n <= MAX_HISTORY_WORKERS; n++) git.open(n);
  await Promise.all(running);
  await pause(300);
  expect(git.pids()).toHaveLength(MAX_HISTORY_WORKERS);
});

it('counts the wait for a worker slot against the budget, never starting a load whose time ran out', async () => {
  const { git, service } = held();
  const running = Array.from({ length: MAX_HISTORY_WORKERS }, () => service.load());
  for (let n = 1; n <= MAX_HISTORY_WORKERS; n++) await git.held(n);
  await expect(service.load({ maxDurationMs: 300 })).rejects.toThrow('History work exceeded its overall deadline.');
  for (let n = 1; n <= MAX_HISTORY_WORKERS; n++) git.open(n);
  await Promise.all(running);
  await pause(300);
  expect(git.pids()).toHaveLength(MAX_HISTORY_WORKERS);
});

it('keeps a worker slot until the worker thread has ended, not merely until its job was cancelled', async () => {
  const { git, service } = held();
  const controller = new AbortController(), reason = new Error('Stopped by the test.');
  const heartbeat = new SharedArrayBuffer(4), beats = new Int32Array(heartbeat);
  // Workers stuck in synchronous work hold every slot; they end only when terminated after the cancel grace.
  const busy = Array.from({ length: MAX_HISTORY_WORKERS }, () => runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 30_000, heartbeat } as HistoryJob,
    controller.signal, fixtureUrl('history-worker-busy.ts')));
  busy.forEach(job => job.catch(() => undefined));
  await vi.waitFor(() => expect(Atomics.load(beats, 0)).toBeGreaterThan(0));
  const waiting = service.load();
  controller.abort(reason);
  await pause(HISTORY_CANCEL_GRACE_MS / 2);
  expect(git.pids()).toHaveLength(0);
  for (const job of busy) await expect(job).rejects.toBe(reason);
  await git.held(1); git.open(1);
  await expect(waiting).resolves.toBeDefined();
});

it('keeps waiting for the worker thread to exit when terminating it fails', async () => {
  let worker: Worker | undefined;
  const terminate = vi.spyOn(Worker.prototype, 'terminate').mockImplementationOnce(function (this: Worker) {
    worker = this; return Promise.reject(new Error('Terminate failed.'));
  });
  try {
    let settled = false;
    const job = runHistoryJob({ repository: '.', base: 'HEAD', head: 'HEAD', budgetMs: 200, startMs: 0 } as HistoryJob, undefined,
      fixtureUrl('history-worker-slow-start.ts')).finally(() => { settled = true; });
    job.catch(() => undefined);
    // The budget, deadline grace and cancel grace pass; the failed terminate leaves the thread running.
    await vi.waitFor(() => expect(worker).toBeDefined(), { timeout: 10_000 });
    await pause(500);
    expect(settled).toBe(false);
    await worker!.terminate();
    await expect(job).rejects.toThrow('History work exceeded its overall deadline.');
  } finally { terminate.mockRestore(); }
});

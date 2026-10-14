// Issue #48: the original timeout/cancellation reason must survive gateway, coordinator, durable attempt and response.
// Interleavings are ordered by deferred gates or observed process state. The two real-process tests also need the
// command to start and exit well inside their timers (1.5 s and a 3 s pipe grace); under heavy load they can fail, not pass.
// The parallelStages() tests use real 1 s inspection deadlines; the deadline test checks the order it relies on and fails,
// not passes, if heavy load delays its stage failure past the deadline.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewService } from '../runner/review.ts';
import { MergeCoordinator, MergeNotApplied } from '../runner/merge.ts';
import { GhMergeGateway, MergeSubmissionError } from '../github/merge.ts';
import { CommandFailed, runWithInput } from '../github/run-with-input.ts';
import { GhIssueGateway, ISSUE_READ_ACTIVE_MS, withIssueReadDeadline } from '../github/issues.ts';
import { RemoteTimeout } from '../github/timeout.ts';
import type { AlreadyFixedGateway } from '../github/already-fixed.ts';
import { Store } from '../runner/store.ts';

type ReviewView = Awaited<ReturnType<ReviewService['load']>>;
type Run = ConstructorParameters<typeof GhMergeGateway>[1];
const sha = (digit: string) => digit.repeat(40);
const config = { repository: 'owner/repo', pullRequest: 7, issue: 24 };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** A gh call that runs until its signal aborts, then settles (with that signal's reason) only when `release` opens. */
function stoppingRun() {
  const started = deferred(), stopped = deferred(), release = deferred();
  const run: Run = (_args, options) => new Promise<string>((_, reject) => {
    started.resolve();
    options?.signal?.addEventListener('abort', () => { stopped.resolve(); void release.promise.then(() => reject(options.signal!.reason)); }, { once: true });
  });
  return { run, started: started.promise, stopped: stopped.promise, release: () => release.resolve() };
}
function readyView(extra: Record<string, unknown> = {}): ReviewView {
  return {
    items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
    plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: 'snapshot', base: sha('a'), head: sha('b') }, token: 'review-token', ...extra,
  } as unknown as ReviewView;
}

afterEach(() => { vi.useRealTimers(); });

it('gateway queue watermark keeps its own earlier timeout when the caller aborts during the gh stop wait', async () => {
  const gh = stoppingRun(), caller = new AbortController();
  const gateway = new GhMergeGateway(config, gh.run);
  const watermark = gateway.queueWatermark(sha('b'), { signal: caller.signal, timeoutMs: 1 }).catch((error: unknown) => error);
  await gh.stopped; // The watermark's own 1 ms deadline fired first and is stopping gh.
  caller.abort(new Error('Merge cancelled during shutdown.'));
  gh.release();
  expect(((await watermark) as Error).message).toBe('GitHub merge-queue watermark timed out.');
});

it('gateway queue inspection keeps its own earlier timeout when the caller aborts during the gh stop wait', async () => {
  const gh = stoppingRun(), caller = new AbortController();
  const gateway = new GhMergeGateway(config, gh.run);
  const inspection = gateway.inspectQueue(sha('b'), { signal: caller.signal, timeoutMs: 1, afterCursor: null }).catch((error: unknown) => error);
  await gh.stopped;
  caller.abort(new Error('Merge-queue inspection cancelled during shutdown.'));
  gh.release();
  expect(((await inspection) as Error).message).toBe('GitHub merge-queue inspection timed out.');
});

it('an issue read keeps its own earlier timeout when the caller aborts during the gh stop wait', async () => {
  const gh = stoppingRun(), caller = new AbortController();
  const reading = new GhIssueGateway('owner/repo', gh.run).issueAccess(24, { signal: caller.signal, timeoutMs: 1 }).catch((error: unknown) => error);
  await gh.stopped;
  caller.abort(new Error('Merge cancelled during shutdown.'));
  gh.release();
  const error = await reading;
  expect(error).toBeInstanceOf(RemoteTimeout);
  expect((error as Error).message).toBe('Issue retrieval timed out.');
});

it('gateway merge never reports its own abort as GitHub\'s refusal, even when the abort reason reads like one', async () => {
  const gh = stoppingRun(), caller = new AbortController();
  const merging = new GhMergeGateway(config, gh.run).merge(sha('b'), { signal: caller.signal }).catch((error: unknown) => error);
  await gh.started;
  caller.abort(new Error('GraphQL: Head branch was modified. Review and try the merge again.'));
  gh.release();
  const error = await merging as MergeSubmissionError;
  expect(error).toBeInstanceOf(MergeSubmissionError);
  expect(error.outcome).toBe('unknown');
});

/** A gh call whose answer (gh's own failure) is delivered only after its signal aborted: it answered before the abort. */
function lateAnswerRun(answer: Error) {
  const started = deferred(), stopped = deferred(), release = deferred();
  const run: Run = (_args, options) => new Promise<string>((_, reject) => {
    started.resolve();
    options?.signal?.addEventListener('abort', () => { stopped.resolve(); void release.promise.then(() => reject(answer)); }, { once: true });
  });
  return { run, started: started.promise, stopped: stopped.promise, release: () => release.resolve() };
}
it.each([
  ['queue watermark', (run: Run, signal: AbortSignal) => new GhMergeGateway(config, run).queueWatermark(sha('b'), { signal, timeoutMs: 1 })],
  ['queue inspection', (run: Run, signal: AbortSignal) => new GhMergeGateway(config, run).inspectQueue(sha('b'), { signal, timeoutMs: 1, afterCursor: null })],
  ['merge-state inspection', (run: Run, signal: AbortSignal) => new GhMergeGateway(config, run).inspect({ fresh: true, signal, timeoutMs: 1 })],
  ['issue read', (run: Run, signal: AbortSignal) => new GhIssueGateway('owner/repo', run).issueAccess(24, { signal, timeoutMs: 1 })],
] as const)('%s reports gh\'s own answer when its deadline fires after gh answered', async (_read, read) => {
  // gh exited with this answer before the deadline fired; runWithInput reports it as a CommandFailed.
  const answer = new CommandFailed('gh failed (exit 1): GraphQL: Could not resolve to a PullRequest with the number of 7.', '', '');
  const gh = lateAnswerRun(answer);
  const reading = read(gh.run, new AbortController().signal).catch((error: unknown) => error);
  await gh.stopped; // The read's own 1 ms deadline fired; gh's answer is already on its way.
  gh.release();
  expect(await reading).toBe(answer);
});

it('coordinator keeps gh\'s answer before admission when shutdown comes after it and writes are already closed', async () => {
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Merge', questions: [], items: [{ id: 'P1', title: 'Merge', intent: 'Merge safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] }, sha('a'), sha('b'));
  const view = readyView({ expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } });
  // gh exited with this answer; its delivery is held until after the coordinator's own shutdown abort.
  const answer = new CommandFailed('gh failed (exit 1): GraphQL: Could not resolve to a PullRequest with the number of 7.', '', '');
  const gh = lateAnswerRun(answer);
  const coordinator = new MergeCoordinator({ store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService, new GhMergeGateway(config, gh.run));
  const actionId = randomUUID();
  try {
    const merging = coordinator.merge(view.token, actionId).catch((error: unknown) => error);
    await gh.started; // Shutdown finds the click's gh call running.
    // The server's shutdown order: the Store's write gate closes, then the merge coordinator is aborted.
    store.closeWrites();
    const closing = coordinator.close();
    await gh.stopped;
    gh.release();
    const error = await merging as Error;
    await closing;
    // Not saved (writes are closed), so resendable; but gh's answer is the reason given, not the shutdown.
    expect(error).toBeInstanceOf(MergeNotApplied);
    expect(error.message).toMatch(/Could not resolve to a PullRequest/);
    expect(error.message).not.toMatch(/shutdown/);
    expect(store.savedAction(identity, { actionId, kind: 'merge', request: { token: view.token } })).toBeUndefined();
  } finally { store.close(); }
});

it('keeps a refusal\'s text when a storage error stops it from being saved', async () => {
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Merge', questions: [], items: [{ id: 'P1', title: 'Merge', intent: 'Merge safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] }, sha('a'), sha('b'));
  const view = readyView({ expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } });
  const answer = new CommandFailed('gh failed (exit 1): GraphQL: Could not resolve to a PullRequest with the number of 7.', '', '');
  const run: Run = async () => { throw answer; };
  const coordinator = new MergeCoordinator({ store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService, new GhMergeGateway(config, run));
  vi.spyOn(store, 'userAction').mockImplementation(() => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }); });
  try {
    const error = await coordinator.merge(view.token, randomUUID()).catch((error: unknown) => error) as Error;
    expect(error).toBeInstanceOf(MergeNotApplied);
    expect(error.message).toMatch(/could not be saved.*Could not resolve to a PullRequest/);
  } finally { vi.restoreAllMocks(); await coordinator.close(); store.close(); }
});

it('coordinator reports the inspection timeout that stopped validation, not a shutdown that arrived while gh was stopping', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const gh = stoppingRun();
  const view = readyView();
  const coordinator = new MergeCoordinator({ load: vi.fn(() => view) } as unknown as ReviewService, new GhMergeGateway(config, gh.run));
  const merging = coordinator.merge(view.token).catch((error: unknown) => error);
  await gh.started;
  await vi.advanceTimersByTimeAsync(6_000); // The fresh inspection's 6 s deadline fires; the 14 s merge deadline has not.
  await gh.stopped;
  const closing = coordinator.close(); // Shutdown aborts the merge while the timed-out gh call is still stopping.
  gh.release();
  const error = await merging as Error;
  await closing;
  expect(error).toBeInstanceOf(MergeNotApplied);
  expect(error.message).toBe('GitHub merge-state inspection timed out.');
});

it.each([false, true])('a gateway inspection timeout before admission is resendable, not saved as the click\'s definite refusal (saved meanwhile by another coordinator: %s)', async savedMeanwhile => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Merge', questions: [], items: [{ id: 'P1', title: 'Merge', intent: 'Merge safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] }, sha('a'), sha('b'));
  const view = readyView({ expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } });
  const gh = stoppingRun();
  const coordinator = new MergeCoordinator({ store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService, new GhMergeGateway(config, gh.run));
  const actionId = randomUUID();
  try {
    const merging = coordinator.merge(view.token, actionId).catch((error: unknown) => error);
    await gh.started;
    // Another coordinator on this database settles the same click with a refusal while this one's read runs.
    if (savedMeanwhile) store.userAction(identity, { actionId, kind: 'merge', request: { token: view.token } },
      () => ({ attemptId: 'other', state: 'failed', reason: 'Required review is missing.', url: null }));
    await vi.advanceTimersByTimeAsync(6_000);
    gh.release();
    const error = await merging as Error;
    // The saved outcome is the answer; without one, the timeout is.
    if (savedMeanwhile) { expect(error).not.toBeInstanceOf(MergeNotApplied); expect(error.message).toBe('Required review is missing.'); return; }
    expect(error.message).toBe('GitHub merge-state inspection timed out.');
    // A timeout applied nothing: the click must stay resendable (503), with nothing saved under its key.
    expect(error).toBeInstanceOf(MergeNotApplied);
    // Nothing is saved under the click's key: a saved refusal would be thrown here instead.
    expect(store.savedAction(identity, { actionId, kind: 'merge', request: { token: view.token } })).toBeUndefined();
  } finally { await coordinator.close(); store.close(); }
});

it('answers an outcome another coordinator saved meanwhile, even when a timeout is followed by this click\'s own abort', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Merge', questions: [], items: [{ id: 'P1', title: 'Merge', intent: 'Merge safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] }, sha('a'), sha('b'));
  const view = readyView({ expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } });
  const gh = stoppingRun();
  const coordinator = new MergeCoordinator({ store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService, new GhMergeGateway(config, gh.run));
  const actionId = randomUUID();
  try {
    const merging = coordinator.merge(view.token, actionId).catch((error: unknown) => error);
    await gh.started;
    store.userAction(identity, { actionId, kind: 'merge', request: { token: view.token } },
      () => ({ attemptId: 'other', state: 'failed', reason: 'Required review is missing.', url: null }));
    await vi.advanceTimersByTimeAsync(6_000);
    await gh.stopped; // Before close(), only the inspection's own timeout can have stopped gh.
    const closing = coordinator.close(); // Then this coordinator's shutdown aborts the click, before gh settles.
    gh.release();
    const error = await merging as Error;
    await closing;
    // The durable outcome, not a resendable 503 for the timeout.
    expect(error).not.toBeInstanceOf(MergeNotApplied);
    expect(error.message).toBe('Required review is missing.');
  } finally { store.close(); }
});

it('answers a success saved meanwhile after the click\'s own abort without loading the review or reading GitHub again', async () => {
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Merge', questions: [], items: [{ id: 'P1', title: 'Merge', intent: 'Merge safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  store.createPlan(JSON.stringify(plan), 'json', { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] }, sha('a'), sha('b'));
  const view = readyView({ expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } });
  const gh = stoppingRun();
  let laterCalls = 0, first = true;
  // The click's first gh call is held until shutdown stops it; any later call (a replay's GitHub read) is counted.
  const run: Run = (args, options) => {
    if (first) { first = false; return gh.run(args, options); }
    laterCalls++;
    return Promise.reject(options?.signal?.reason ?? new Error('Unexpected gh call.'));
  };
  const load = vi.fn(() => view);
  const coordinator = new MergeCoordinator({ store, config: { identity }, load } as unknown as ReviewService, new GhMergeGateway(config, run));
  const actionId = randomUUID();
  try {
    const merging = coordinator.merge(view.token, actionId);
    await gh.started;
    // Another coordinator on this database merged the same click meanwhile.
    store.userAction(identity, { actionId, kind: 'merge', request: { token: view.token } },
      () => ({ attemptId: 'other', state: 'merged', reason: null, url: 'https://github.com/owner/repo/pull/7' }));
    const loadsBefore = load.mock.calls.length;
    const closing = coordinator.close(); // Shutdown aborts the click while its gh call runs.
    await gh.stopped;
    gh.release();
    const answer = await merging;
    await closing;
    expect(answer.result).toEqual({ url: 'https://github.com/owner/repo/pull/7' });
    expect(answer.status.blockers).toEqual([expect.objectContaining({ code: 'refresh' })]); // It asks for a refresh instead.
    expect(load.mock.calls.length).toBe(loadsBefore);
    expect(laterCalls).toBe(0);
  } finally { store.close(); }
});

it('fails a command whose output passes its limit while its pipes drain after it exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-stop-buffer-'));
  const script = join(dir, 'gh.cjs');
  // The command exits 0 at once; a grandchild that inherited its stdout writes past the limit 0.3 s later.
  writeFileSync(script, `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => { process.stdout.write("x".repeat(4096)); }, 300)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
  `);
  try {
    const started = Date.now();
    const error = await runWithInput(process.execPath, [script], { maxBuffer: 1024, killGraceMs: 100, pipeGraceMs: 3_000 }).then(() => null, (failure: unknown) => failure);
    expect((error as Error | null)?.message).toMatch(/exceeded its limit/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250); // The output came during the drain, after the exit.
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

it.each([
  ['refusal', 1], ['success', 0],
] as const)('gateway merge keeps GitHub\'s %s when the deadline fires after gh exited but before its pipes closed', async (answer, exitCode) => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-48-reason-'));
  const script = join(dir, 'gh.cjs');
  // gh exits with its answer (1 after printing a refusal, or 0); a grandchild that inherited stdout/stderr keeps the
  // pipes open, as runWithInput allows. Only the exit status decides: a success ignores the refusal text on stderr.
  writeFileSync(script, `
    const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
    const dir = process.argv[2];
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    fs.writeFileSync(path.join(dir, 'grandchild'), String(g.pid)); g.unref();
    process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\\n');
    fs.writeFileSync(path.join(dir, 'child'), String(process.pid));
    process.exitCode = ${exitCode};
  `);
  const run: Run = (_args, options) => runWithInput(process.execPath, [script, dir], { signal: options?.signal, killGraceMs: 250, pipeGraceMs: 3_000 });
  const abort = new AbortController();
  try {
    let settled = false;
    const merging = new GhMergeGateway(config, run).merge(sha('b'), { signal: abort.signal }).catch((error: unknown) => error)
      .finally(() => { settled = true; });
    // Wait until gh has been reaped: Node has then emitted its 'exit' and runWithInput is in its pipe grace period.
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    for (let i = 0; i < 1_000 && !(existsSync(join(dir, 'child')) && readFileSync(join(dir, 'child'), 'utf8') && gone(Number(readFileSync(join(dir, 'child'), 'utf8')))); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(gone(Number(readFileSync(join(dir, 'child'), 'utf8')))).toBe(true);
    // Still draining the pipes: the abort below lands after exit and before the answer, the window under test.
    expect(settled).toBe(false);
    abort.abort(new Error('Merge request deadline exceeded.'));
    const outcome = await merging;
    if (answer === 'success') expect(outcome).toEqual({ url: 'https://github.com/owner/repo/pull/7' });
    else {
      expect(outcome).toBeInstanceOf(MergeSubmissionError);
      expect((outcome as MergeSubmissionError).message).toMatch(/Head branch was modified/);
      expect((outcome as MergeSubmissionError).outcome).toBe('refused');
    }
  } finally {
    try { process.kill(Number(readFileSync(join(dir, 'grandchild'), 'utf8'))); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

it('an issue read that runs out of time reports a RemoteTimeout', async () => {
  // A consistency check, not a behaviour guard: execution and planning issue reads share this deadline, and nothing on
  // those paths reads the class yet. (The merge path's trust read is tested through the server in merge-queue-poll.)
  vi.useFakeTimers();
  try {
    const read = withIssueReadDeadline(new AbortController().signal, signal => new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const outcome = read.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ISSUE_READ_ACTIVE_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(RemoteTimeout);
    expect((error as Error).message).toBe('Issue retrieval timed out.');
  } finally { vi.useRealTimers(); }
});

it('keeps a command\'s exit status when its own timeout fires after it exited, while its pipes drain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-stop-timeout-'));
  const script = join(dir, 'gh.cjs');
  // Exits at once with its answer; a grandchild keeps the pipes open past the command's 1.5 s timeout.
  writeFileSync(script, `
    const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    fs.writeFileSync(path.join(process.argv[2], 'grandchild'), String(g.pid)); g.unref();
    process.stdout.write('answered');
  `);
  try {
    expect(await runWithInput(process.execPath, [script, dir], { timeout: 1_500, killGraceMs: 250, pipeGraceMs: 3_000 })).toBe('answered');
  } finally {
    try { process.kill(Number(readFileSync(join(dir, 'grandchild'), 'utf8'))); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// Parallel inspection stages (#48): the branch's PR list fails with gh's own exit, which stops the other stages still
// running (the rule read in flight, and the already-fixed check unless its own timer stopped it first). The inspection
// settles only after every stage has settled, and it reports gh's exit. In production the check is stopped 0.65 s before
// the inspection's deadline (0.35 s into the 1 s used here), and a stopped gh call settles within the runner's 0.4 s.
function parallelStages(listFailsAt: 'once-running' | number) {
  const answer = new CommandFailed('gh failed (exit 1): HTTP 502: Bad Gateway', 'HTTP 502: Bad Gateway', '');
  const bothRunning = deferred(), bothStopped = deferred(), releaseRule = deferred(), releaseCheck = deferred();
  let running = 0, stopped = 0;
  const observed: { listFailedAfterMs?: number; ruleStopReason?: unknown; checkStopReason?: unknown } = {};
  // A stage that runs until its signal aborts, then settles with that signal's reason when the test releases it.
  const held = <T>(release: Promise<void>, signal?: AbortSignal, onStop?: () => void) => new Promise<T>((_, reject) => {
    if (++running === 2) bothRunning.resolve();
    signal?.addEventListener('abort', () => {
      onStop?.();
      if (++stopped === 2) bothStopped.resolve();
      void release.then(() => reject(signal.reason));
    }, { once: true });
  });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let started = 0; // Set once inspect() has armed its deadline timer, so that timer is due at or before started + 1 s.
  const run: Run = async (args, options) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ number: 7, isDraft: false, baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'task',
      headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], body: '', isCrossRepository: false });
    if (joined.includes('/pulls?')) {
      // The already-fixed check starts only within the first 0.35 s (before its own stop); under extreme load it may not.
      // Checked at 0.5 s, before the 1 s deadline, so the inspection reports this error rather than the deadline.
      let premise: NodeJS.Timeout | undefined;
      await Promise.race([bothRunning.promise, new Promise((_, reject) => {
        premise = setTimeout(() => {
          releaseRule.resolve(); releaseCheck.resolve(); // Let the stopped stages settle so the inspection reports this.
          reject(new Error('Test premise failed: the rule read and the check did not both start.'));
        }, 500);
      })]).finally(() => clearTimeout(premise));
      if (listFailsAt !== 'once-running') await pause(listFailsAt - (Date.now() - started));
      observed.listFailedAfterMs = Date.now() - started;
      throw answer;
    }
    // #rules reads one at a time; only the first starts.
    return held<string>(releaseRule.promise, options?.signal, () => { observed.ruleStopReason = options?.signal?.reason; });
  };
  const checks: AlreadyFixedGateway = { repository: 'owner/repo', check: (_input, signal) => held(releaseCheck.promise, signal, () => { observed.checkStopReason = signal?.reason; }) };
  const state = { settled: false };
  const inspection = new GhMergeGateway(config, run, checks).inspect({ fresh: true, timeoutMs: 1_000, target: { pullRequest: 7, headBranch: 'task' } })
    .then(() => null, (error: unknown) => error).finally(() => { state.settled = true; });
  started = Date.now();
  // Both stages stopped; an inspection that settles first (for example with the premise error above) fails the test with it.
  const whenStopped = () => Promise.race([bothStopped.promise, inspection.then(error => {
    throw error instanceof Error ? error : new Error('The inspection settled before both stages stopped.');
  })]);
  return { answer, whenStopped, releaseRule: () => releaseRule.resolve(), releaseCheck: () => releaseCheck.resolve(),
    state, inspection, pause, started, observed };
}

it('merge-state inspection waits for a stopped already-fixed check before reporting a stage\'s gh exit', async () => {
  const stages = parallelStages('once-running');
  await stages.whenStopped();
  expect(stages.observed.checkStopReason).toBe(stages.answer); // The list's exit, not the check's own timer, stopped it.
  stages.releaseRule();
  await stages.pause(50);
  expect(stages.state.settled).toBe(false); // The already-fixed check is still settling.
  stages.releaseCheck();
  expect(await stages.inspection).toBe(stages.answer);
});

it('merge-state inspection handles a stopped already-fixed check that settles before the other stages', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    const stages = parallelStages('once-running');
    await stages.whenStopped();
    expect(stages.observed.checkStopReason).toBe(stages.answer); // The list's exit, not the check's own timer, stopped it.
    stages.releaseCheck(); // The check rejects with the list's exit while the rule read is still stopping.
    await stages.pause(50);
    expect(stages.state.settled).toBe(false);
    stages.releaseRule();
    expect(await stages.inspection).toBe(stages.answer);
    await stages.pause(0);
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', record); }
});

it('merge-state inspection reports a stage\'s gh exit, not its deadline, when a stopped rule read settles after the deadline', async () => {
  // The list fails 0.75 s in: after the check's own timer stopped it (0.35 s), within 0.4 s of the 1 s deadline.
  const stages = parallelStages(750);
  stages.releaseCheck();
  await stages.whenStopped();
  await stages.pause(1_050 - (Date.now() - stages.started));
  // The order this test claims: the list failed before the deadline and stopped the rule read; then the deadline fired.
  // (Under heavy load the list can fail late; these checks then fail rather than pass on a different interleaving.)
  expect(stages.observed.listFailedAfterMs).toBeLessThan(1_000);
  expect(stages.observed.ruleStopReason).toBe(stages.answer);
  expect((stages.observed.checkStopReason as Error).message).toBe('The already-fixed check did not finish in time.'); // Its own timer.
  expect(Date.now() - stages.started).toBeGreaterThanOrEqual(1_000); // The deadline has fired.
  expect(stages.state.settled).toBe(false); // The rule read, stopped 0.3 s ago, is still settling.
  stages.releaseRule();
  expect(await stages.inspection).toBe(stages.answer);
}, 10_000);

it('merge-state inspection answers a caller abort, not the already-fixed check\'s own earlier gh failure', async () => {
  // The check's gh call failed before the caller aborted; the failure surfaces only after the abort, while gh stops.
  const own = new CommandFailed('gh failed (exit 1): HTTP 502: Bad Gateway', 'HTTP 502: Bad Gateway', '');
  const caller = new AbortController(), reason = new Error('Merge cancelled during shutdown.');
  const bothRunning = deferred();
  let running = 0;
  const afterAbort = <T>(signal: AbortSignal | undefined, settle: (reject: (error: unknown) => void) => void) => new Promise<T>((_, reject) => {
    if (++running === 2) bothRunning.resolve();
    signal?.addEventListener('abort', () => settle(reject), { once: true });
  });
  const run: Run = async (args, options) => {
    if (args.join(' ').startsWith('pr view')) return JSON.stringify({ number: 7, isDraft: false, baseRefName: 'main', baseRefOid: sha('a'),
      headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    return afterAbort<string>(options?.signal, reject => reject(options!.signal!.reason)); // The rule read in flight.
  };
  let checkStopReason: unknown;
  const checks: AlreadyFixedGateway = { repository: 'owner/repo', check: (_input, signal) => afterAbort(signal, reject => { checkStopReason = signal!.reason; reject(own); }) };
  // The default 12 s inspection: the check's own stop timer (0.65 s before that) cannot fire first.
  const inspection = new GhMergeGateway(config, run, checks).inspect({ fresh: true, signal: caller.signal })
    .then(() => null, (error: unknown) => error);
  await bothRunning.promise;
  caller.abort(reason);
  expect(checkStopReason).toBe(reason); // The caller's abort, not the check's own stop timer, stopped the check.
  // Not the check's gh text: a blocker result that arrives after the abort is discarded, so the click may be resent.
  expect(await inspection).toBe(reason);
});

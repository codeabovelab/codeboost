import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAskRoot, LeftoverLedger } from '../runner/question-leftovers.ts';
import { RetainedStorage } from '../runner/question-container.ts';
import { QuestionWorker } from '../runner/question-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ledgerPath = () => { const root = mkdtempSync(join(tmpdir(), 'ask-leftovers-')); roots.push(root); return join(root, 'review.sqlite.ask-leftovers.json'); };
const leftover = (n: number) => ({ keeper: `codeboost-keeper-${n}`, workVolume: `codeboost-work-${n}`, metadataVolume: `codeboost-meta-${n}` });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
// The stub worker recovers this owner at once; d×32, e×32 and f×32 behave differently (see the stub).
const OWNER = 'a'.repeat(32);

it('refuses a record from a build before #65 that lists Docker storage, until the user deletes it', () => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ leftovers: [leftover(1)], untracked: 2, roots: [] }));
  const ledger = new LeftoverLedger(path);
  const error = (() => { try { ledger.assertClear(); } catch (caught) { return caught as Error; } })();
  expect(error?.message).toContain('earlier codeboost build');
  expect(error?.message).toContain(`delete ${path}`);
  expect(error?.message.split('\n').slice(1)).toEqual(['docker rm -f codeboost-keeper-1', 'docker volume rm codeboost-work-1 codeboost-meta-1']);
  // Recording a new root keeps the legacy evidence.
  const root = mkdtempSync(join(tmpdir(), 'codeboost-ask-')); roots.push(root);
  ledger.recordRoot(root);
  expect(read(path)).toEqual({ roots: [root], leftovers: [leftover(1)], untracked: 2 });
  rmSync(path);
  expect(() => ledger.assertClear()).not.toThrow();
});

it('deletes earlier Ask roots before refusing on a record from a build before #65', () => {
  const path = ledgerPath();
  const stale = mkdtempSync(join(tmpdir(), 'codeboost-ask-')); roots.push(stale);
  writeFileSync(join(stale, 'auth.json'), 'secret');
  writeFileSync(path, JSON.stringify({ leftovers: [], untracked: 1, roots: [stale] }));
  expect(() => new LeftoverLedger(path).assertClear()).toThrow('earlier codeboost build');
  // The host copy is gone and no longer recorded, so deleting the record as told loses nothing.
  expect(existsSync(stale)).toBe(false);
  expect(read(path)).toEqual({ roots: [], untracked: 1 });
});

it('fails closed on an unreadable or tampered record', () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path);
  writeFileSync(path, '{not json');
  expect(() => ledger.assertClear()).toThrow('unreadable');
  writeFileSync(path, JSON.stringify({ leftovers: [{ keeper: 'x; rm -rf /', workVolume: 'a', metadataVolume: 'b' }], untracked: 0, roots: [] }));
  expect(() => ledger.assertClear()).toThrow('unreadable');
  writeFileSync(path, JSON.stringify({ untracked: -1, roots: [] }));
  expect(() => ledger.assertClear()).toThrow('unreadable');
  writeFileSync(path, JSON.stringify({ leftovers: [] }));
  expect(() => ledger.assertClear()).toThrow('unreadable');
  expect(existsSync(path)).toBe(true);
});

const stubWorker = (ledger: LeftoverLedger, options: { abandonAfterDeadlineMs?: number; terminateWaitMs?: number; releaseTimeoutMs?: number; env?: Record<string, string>; owner?: string } = {}) =>
  new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url), ledger,
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' }, runnerOwner: () => options.owner ?? OWNER, ...options });
/** The owners the stub worker recovered so far, and the owner its questions carry. */
const recoveries = async (worker: QuestionWorker, n: number) =>
  JSON.parse(await worker.agent('claude')('recoveries', new AbortController().signal, scope(n), 60_000)) as { recovered: string[]; owner: string };
const scope = (n: number) => ({ repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n',
  attemptId: `leftover-attempt-${n}`, contextId: 'c'.repeat(64) });

it('leaves storage it could not remove to the next session of the review, which recovers it by owner', async () => {
  const path = ledgerPath();
  const first = stubWorker(new LeftoverLedger(path));
  await expect(first.agent('claude')('leak', new AbortController().signal, scope(1), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  // Nothing about Docker is recorded: the owner label is the durable evidence.
  expect(existsSync(path)).toBe(false);
  const second = stubWorker(new LeftoverLedger(path));
  try { expect(await recoveries(second, 2)).toEqual({ recovered: [OWNER], owner: OWNER }); }
  finally { await second.close(); }
});

it('writes no record when nothing was left behind', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  expect(await worker.agent('claude')('answer', new AbortController().signal, scope(4), 60_000)).toBe('claude:answer:n');
  await worker.close();
  expect(existsSync(path)).toBe(false);
});

it('recovers its own owner once per process, before the first question, even without a record', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  try {
    expect(await recoveries(worker, 7)).toEqual({ recovered: [OWNER], owner: OWNER });
    // Later questions do not recover again, so a running question's own storage is never taken for a leftover.
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(8), 60_000)).toBe('claude:answer:n');
    expect((await recoveries(worker, 9)).recovered).toEqual([OWNER]);
  } finally { await worker.close(); }
});

// Wiring only: each review's own owner reaches its recovery and its questions. The real-Docker test in
// agent-question.test.ts proves that recovery then touches only that owner's objects.
it('gives each of two reviews on one daemon its own owner, for recovery and for questions', async () => {
  const other = 'b'.repeat(32);
  const first = stubWorker(new LeftoverLedger(ledgerPath()));
  const second = stubWorker(new LeftoverLedger(ledgerPath()), { owner: other });
  try {
    // The first review's worker is live while the second starts: it neither blocks the second nor is recovered by it.
    expect(await recoveries(first, 10)).toEqual({ recovered: [OWNER], owner: OWNER });
    expect(await recoveries(second, 11)).toEqual({ recovered: [other], owner: other });
    expect(await first.agent('claude')('answer', new AbortController().signal, scope(12), 60_000)).toBe('claude:answer:n');
  } finally { await first.close(); await second.close(); }
});

it('abandons a question that does not settle after its deadline, and admits no more questions', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path), { abandonAfterDeadlineMs: 50 });
  try {
    // Deadline is at least one second; the stub never replies.
    await expect(worker.agent('claude')('hang', new AbortController().signal, scope(11), 1_000)).rejects.toThrow('did not settle');
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(12), 60_000)).rejects.toThrow('Ask is off until codeboost restarts');
  } finally { await worker.close(); }
});

it('does not wait on unsettled questions at shutdown', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  const hanging = worker.agent('claude')('hang', new AbortController().signal, scope(13), 60_000).catch((error: Error) => error);
  await expect.poll(async () => (worker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  const started = Date.now();
  await worker.close();
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(((await hanging) as Error).message).toContain('stopped at shutdown');
  // The stopped thread's root is deleted, so nothing is left in the record.
  expect(existsSync(path)).toBe(false);
});

const staging = () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-question-'));
  mkdirSync(join(root, 'input'), { mode: 0o555 });
  return root;
};

it('keeps a staging directory it could not delete, and deletes it on the next attempt', () => {
  const retained = new RetainedStorage();
  // Not a staging path, so removal refuses; this stands in for a directory the OS will not delete.
  retained.retainPath('/definitely/not-a-staging-dir');
  expect(() => retained.release(() => {})).toThrow('could not be deleted');
  const root = staging();
  const recovered = new RetainedStorage();
  recovered.retainPath(root);
  expect(() => recovered.release(() => {})).not.toThrow();
  expect(existsSync(root)).toBe(false);
  expect(recovered.paths()).toEqual([]);
});

it('keeps every host copy inside a recorded Ask root and deletes the root when the worker stops', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  const copy = await worker.agent('claude')('leave-copy', new AbortController().signal, scope(14), 60_000);
  const root = dirname(copy);
  // The worker's TMPDIR is the Ask root, and it was recorded before the worker ran anything.
  expect(root).toMatch(/codeboost-ask-[A-Za-z0-9]{6}$/);
  expect(dirname(root)).toBe(tmpdir());
  expect(read(path)).toEqual({ roots: [root] });
  // The live root survives the check before the next question.
  expect(await worker.agent('claude')('answer', new AbortController().signal, scope(18), 60_000)).toBe('claude:answer:n');
  expect(existsSync(copy)).toBe(true);
  await worker.close();
  expect(existsSync(root)).toBe(false);
  expect(existsSync(path)).toBe(false);
});

it('deletes a recorded root from a killed session, including read-only directories, before the next question', async () => {
  const path = ledgerPath();
  const stale = mkdtempSync(join(tmpdir(), 'codeboost-ask-'));
  mkdirSync(join(stale, 'input'));
  writeFileSync(join(stale, 'input', 'auth.json'), 'secret');
  chmodSync(join(stale, 'input'), 0o555);
  new LeftoverLedger(path).recordRoot(stale);
  const worker = stubWorker(new LeftoverLedger(path));
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(15), 60_000)).toBe('claude:answer:n');
    expect(existsSync(stale)).toBe(false);
  } finally { await worker.close(); }
  expect(existsSync(path)).toBe(false);
});

it.each([
  ['a lookalike name outside the temp directory', join(homedir(), 'important-codeboost-ask-ABC123')],
  ['a nested lookalike', join(tmpdir(), 'x', 'codeboost-ask-ABC123')],
  ['a plain home directory', homedir()],
])('refuses a record naming %s, and deletes nothing', (_label, target) => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ roots: [target] }));
  expect(() => new LeftoverLedger(path).assertClear()).toThrow('unreadable');
  expect(existsSync(path)).toBe(true);
});

it('reports a missing sign-in before recovery or any other Docker work', async () => {
  const worker = stubWorker(new LeftoverLedger(ledgerPath()), { env: {} });
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(16), 60_000)).rejects.toThrow('CLAUDE_CODE_OAUTH_TOKEN');
    // No worker was started, so nothing was recovered.
    expect((worker as unknown as { worker?: unknown }).worker).toBeUndefined();
  } finally { await worker.close(); }
});

it('keeps an abandoned question pending until its worker thread has stopped', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  let settledAt = 0;
  const blocked = worker.agent('claude')('block', new AbortController().signal, scope(17), 60_000)
    .catch((error: Error) => { settledAt = Date.now(); return error; });
  await expect.poll(async () => (worker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  // Give the stub time to enter its one-second native call before shutdown abandons it.
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now();
  await worker.close();
  expect(((await blocked) as Error).message).toContain('stopped at shutdown');
  // The thread could not stop before the native call returned, and the question stayed pending until then.
  expect(settledAt - started).toBeGreaterThanOrEqual(500);
  expect(existsSync(path)).toBe(false);
});

it('keeps the root of a thread that outlives the wait recorded, and deletes it once the thread stops', async () => {
  const path = ledgerPath();
  // The stub blocks for one second in a native call; give up waiting after 100 ms.
  const worker = stubWorker(new LeftoverLedger(path), { terminateWaitMs: 100 });
  const blocked = worker.agent('claude')('block', new AbortController().signal, scope(19), 60_000).catch((error: Error) => error);
  await expect.poll(async () => (worker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 200));
  await worker.close();
  expect(((await blocked) as Error).message).toContain('stopped at shutdown');
  // Released before the thread stopped: the root is still recorded.
  const [root] = read(path).roots;
  expect(read(path).roots).toEqual([root]);
  expect(existsSync(root)).toBe(true);
  // Once the native call returns and the thread stops, the root is deleted and dropped from the record.
  await expect.poll(() => existsSync(root), { timeout: 5_000 }).toBe(false);
  expect(existsSync(path)).toBe(false);
  // No new question is admitted meanwhile.
  await expect(worker.agent('claude')('answer', new AbortController().signal, scope(20), 60_000)).rejects.toThrow('Ask is off');
});

/** Whether another holder could take the Ask lock right now. */
const lockFree = (path: string) => {
  const probe = new LeftoverLedger(path);
  try { probe.acquire(); probe.release(); return true; } catch { return false; }
};

it('lets only one holder run Ask for a review, and the OS frees the lock when its process exits', async () => {
  const path = ledgerPath();
  const first = stubWorker(new LeftoverLedger(path));
  const second = stubWorker(new LeftoverLedger(path));
  try {
    expect(await first.agent('claude')('answer', new AbortController().signal, scope(21), 60_000)).toBe('claude:answer:n');
    const [liveRoot] = read(path).roots;
    await expect(second.agent('claude')('answer', new AbortController().signal, scope(22), 60_000)).rejects.toThrow('another codeboost process');
    // The refused holder never reaches cleanup, so the live worker's root and its record survive.
    expect(existsSync(liveRoot)).toBe(true);
    expect(read(path).roots).toEqual([liveRoot]);
  } finally { await first.close(); await second.close(); }
  expect(lockFree(path)).toBe(true);
  // A process that takes the lock and exits without releasing it leaves nothing to take over: the OS freed it.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const lock = new DatabaseSync(${JSON.stringify(new LeftoverLedger(path).lockPath)});
    lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    process.stdout.write('held');
    process.exit(0);`], { encoding: 'utf8' });
  expect(child.stdout).toBe('held');
  expect(lockFree(path)).toBe(true);
});

it('keys the lock and record by the canonical database path, and refuses a hard-linked database', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-db-')); roots.push(root);
  const database = join(root, 'review.sqlite');
  writeFileSync(database, '');
  symlinkSync(database, join(root, 'alias.sqlite'));
  const direct = LeftoverLedger.forDatabase(database);
  expect(LeftoverLedger.forDatabase(join(root, 'alias.sqlite')).path).toBe(direct.path);
  expect(LeftoverLedger.forDatabase(join(root, '.', 'review.sqlite')).path).toBe(direct.path);
  direct.acquire();
  try { expect(() => LeftoverLedger.forDatabase(join(root, 'alias.sqlite')).acquire()).toThrow('another codeboost process'); }
  finally { direct.release(); }
  linkSync(database, join(root, 'hard.sqlite'));
  expect(() => LeftoverLedger.forDatabase(database).acquire()).toThrow('hard links');
});

it('bounds shutdown when the worker does not report, keeping its root recorded until the thread stops', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path), { releaseTimeoutMs: 100, terminateWaitMs: 100 });
  expect(await worker.agent('claude')('stick-on-release', new AbortController().signal, scope(24), 60_000)).toBe('ok');
  const started = Date.now();
  await worker.close();
  expect(Date.now() - started).toBeLessThan(900);
  const [root] = read(path).roots;
  expect(read(path).roots).toEqual([root]);
  expect(existsSync(root)).toBe(true);
  // The root goes once the thread stops. The lock stays for the life of this process: Docker children the abandoned
  // thread started cannot be seen or awaited, so only process exit releases it.
  expect(lockFree(path)).toBe(false);
  await expect.poll(() => existsSync(root), { timeout: 5_000 }).toBe(false);
  expect(lockFree(path)).toBe(false);
});

it('cleans up its root and releases the lock when the worker cannot be constructed', async () => {
  const path = ledgerPath();
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-ask-')));
  // A worker URL that is not a file makes the Worker constructor throw synchronously.
  const worker = new QuestionWorker(new URL('https://example.invalid/worker.js'), new LeftoverLedger(path),
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });
  await expect(worker.agent('claude')('answer', new AbortController().signal, scope(25), 60_000)).rejects.toThrow();
  const after = readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-ask-') && !before.has(name));
  expect(after).toEqual([]);
  expect(existsSync(path)).toBe(false);
  await worker.close();
  expect(lockFree(path)).toBe(true);
});

it('serializes abandonment, so a second trigger cannot release questions before the thread stops', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path), { abandonAfterDeadlineMs: 50 });
  const started = Date.now();
  const settle = (prompt: string, n: number) => worker.agent('claude')(prompt, new AbortController().signal, scope(n), 1_000)
    .then(() => Date.now(), () => Date.now());
  // Both watchdogs fire about one second in, while the thread is inside a three-second native call.
  const [first, second] = await Promise.all([settle('block-long', 26), settle('hang', 27)]);
  expect(first - started).toBeGreaterThanOrEqual(2_500);
  expect(second - started).toBeGreaterThanOrEqual(2_500);
  await worker.close();
}, 20_000);

it('never drops a recorded Ask root; adding one past the cap is refused instead', () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path);
  const made = Array.from({ length: 100 }, () => mkdtempSync(join(tmpdir(), 'codeboost-ask-')));
  try {
    for (const root of made) ledger.recordRoot(root);
    const extra = mkdtempSync(join(tmpdir(), 'codeboost-ask-'));
    made.push(extra);
    expect(() => ledger.recordRoot(extra)).toThrow('could not be deleted');
    expect(read(path)).toEqual({ roots: made.slice(0, 100) });
  } finally { for (const root of made) rmSync(root, { recursive: true, force: true }); }
});

it('runs one recovery for concurrent first questions, so neither sees the other as a leftover', async () => {
  // A slow recovery: both first questions arrive while it runs.
  const owner = 'e'.repeat(32);
  const worker = stubWorker(new LeftoverLedger(ledgerPath()), { owner });
  try {
    const first = worker.agent('claude')('answer', new AbortController().signal, scope(28), 60_000);
    const second = worker.agent('claude')('answer', new AbortController().signal, scope(29), 60_000);
    expect(await Promise.all([first, second])).toEqual(['claude:answer:n', 'claude:answer:n']);
    expect((await recoveries(worker, 30)).recovered).toEqual([owner]);
  } finally { await worker.close(); }
});

it('keeps Ask off when recovery fails, and retries it on the next question', async () => {
  const owner = 'f'.repeat(32);
  const worker = stubWorker(new LeftoverLedger(ledgerPath()), { owner });
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(31), 60_000)).rejects.toThrow('could not remove what an earlier session');
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(32), 60_000)).toBe('claude:answer:n');
    expect((await recoveries(worker, 33)).recovered).toEqual([owner, owner]);
  } finally { await worker.close(); }
});

it('waits for an abandonment already in progress when shutdown starts', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path), { abandonAfterDeadlineMs: 50 });
  const started = Date.now();
  // The watchdog abandons about one second in, while the thread is inside a three-second native call.
  const question = worker.agent('claude')('block-long', new AbortController().signal, scope(32), 1_000).catch((error: Error) => error);
  await new Promise(resolve => setTimeout(resolve, 1_400));
  await worker.close();
  // close() returned only after the thread stopped; the root is gone, and the lock stays until the process exits.
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
  expect(((await question) as Error).message).toContain('did not settle');
  expect(existsSync(path)).toBe(false);
  expect(lockFree(path)).toBe(false);
}, 20_000);

it('keeps one lock for a review database across a rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-db-')); roots.push(root);
  const database = join(root, 'review.sqlite');
  writeFileSync(database, '');
  const before = LeftoverLedger.forDatabase(database);
  before.acquire();
  try {
    renameSync(database, join(root, 'renamed.sqlite'));
    const after = LeftoverLedger.forDatabase(join(root, 'renamed.sqlite'));
    expect(after.lockPath).toBe(before.lockPath);
    expect(() => after.acquire()).toThrow('another codeboost process');
  } finally { before.release(); }
});

it('stops a recovery still in flight at shutdown, and keeps the lock until the process exits', async () => {
  const path = ledgerPath();
  // A recovery that never answers, like lane D stuck on an unreachable daemon.
  const worker = stubWorker(new LeftoverLedger(path), { owner: 'd'.repeat(32) });
  const controller = new AbortController();
  const question = worker.agent('claude')('answer', controller.signal, scope(34), 60_000).catch((error: Error) => error);
  await expect.poll(() => (worker as unknown as { recoveries: Map<string, unknown> }).recoveries.size).toBe(1);
  controller.abort(new Error('Server stopped. Retry the question.'));
  expect(((await question) as Error).message).toBe('Server stopped. Retry the question.');
  // The caller has gone, but the recovery still runs under the lock until shutdown stops its thread.
  expect(lockFree(path)).toBe(false);
  await worker.close();
  expect(existsSync(path)).toBe(false);
  // Docker clients the stopped recovery started may still run, so no other process may recover yet.
  expect(lockFree(path)).toBe(false);
});

it('retries a startup check that failed before reaching Docker, once its cause is fixed', async () => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ untracked: 1, roots: [] }));
  const worker = stubWorker(new LeftoverLedger(path));
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(35), 60_000)).rejects.toThrow('earlier codeboost build');
    rmSync(path);
    expect(await recoveries(worker, 36)).toEqual({ recovered: [OWNER], owner: OWNER });
  } finally { await worker.close(); }
});

it('finds a host root recorded under the old name after the database was renamed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-db-')); roots.push(dir);
  const database = join(dir, 'review.sqlite');
  writeFileSync(database, '');
  const before = LeftoverLedger.forDatabase(database);
  // A killed session left a stamped root, recorded only beside the old name.
  const root = createAskRoot(before.lockPath);
  writeFileSync(join(root, 'auth.json'), 'secret');
  before.recordRoot(root);
  expect(readFileSync(join(root, '.owner'), 'utf8').trim()).toBe(before.lockPath);
  renameSync(database, join(dir, 'renamed.sqlite'));
  const worker = stubWorker(LeftoverLedger.forDatabase(join(dir, 'renamed.sqlite')));
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(34), 60_000)).toBe('claude:answer:n');
    expect(existsSync(root)).toBe(false);
  } finally { await worker.close(); }
});

it('leaves an unrecorded root alone while its owner holds its lock, and reclaims it once the owner is gone', async () => {
  const owner = new LeftoverLedger(ledgerPath());
  owner.acquire();
  const root = createAskRoot(owner.lockPath);
  try {
    const first = stubWorker(new LeftoverLedger(ledgerPath()));
    try { expect(await first.agent('claude')('answer', new AbortController().signal, scope(35), 60_000)).toBe('claude:answer:n'); }
    finally { await first.close(); }
    expect(existsSync(root)).toBe(true);
  } finally { owner.release(); }
  const second = stubWorker(new LeftoverLedger(ledgerPath()));
  try { expect(await second.agent('claude')('answer', new AbortController().signal, scope(36), 60_000)).toBe('claude:answer:n'); }
  finally { await second.close(); }
  expect(existsSync(root)).toBe(false);
});

it('never probes an owner stamp that is not a codeboost lock in the temp directory', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'ask-outside-')), 'victim.sqlite'); roots.push(dirname(outside));
  writeFileSync(outside, 'not a lock');
  const lookalike = mkdtempSync(join(tmpdir(), 'codeboost-askprep-'));
  const root = join(tmpdir(), `codeboost-ask-${basename(lookalike).slice(-6)}`);
  renameSync(lookalike, root);
  writeFileSync(join(root, '.owner'), `${outside}\n`);
  const worker = stubWorker(new LeftoverLedger(ledgerPath()));
  try { expect(await worker.agent('claude')('answer', new AbortController().signal, scope(37), 60_000)).toBe('claude:answer:n'); }
  finally { await worker.close(); }
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
  // The stamp was not trusted: the named file was never opened, and the unauthenticated folder was left in place.
  expect(readFileSync(outside, 'utf8')).toBe('not a lock');
  expect(existsSync(root)).toBe(true);
  } finally { cleanup(); }
});

it('still recovers Docker leftovers at startup after deleting a recorded root', async () => {
  const path = ledgerPath();
  const stale = mkdtempSync(join(tmpdir(), 'codeboost-ask-'));
  new LeftoverLedger(path).recordRoot(stale);
  const worker = stubWorker(new LeftoverLedger(path));
  try {
    expect((await recoveries(worker, 38)).recovered).toEqual([OWNER]);
    expect(existsSync(stale)).toBe(false);
  } finally { await worker.close(); }
});

it('never follows a link planted at a temporary name when writing the record', () => {
  const path = ledgerPath();
  const victim = join(dirname(path), 'victim.txt');
  writeFileSync(victim, 'original');
  // The name the previous implementation used.
  symlinkSync(victim, `${path}.${process.pid}.tmp`);
  const root = mkdtempSync(join(tmpdir(), 'codeboost-ask-')); roots.push(root);
  new LeftoverLedger(path).recordRoot(root);
  expect(readFileSync(victim, 'utf8')).toBe('original');
  expect(read(path)).toEqual({ roots: [root] });
  expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp') && !name.includes(String(process.pid)))).toEqual([]);
});

it('keeps the root recorded and the lock held when terminating an abandoned worker fails', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path));
  const hanging = worker.agent('claude')('hang', new AbortController().signal, scope(40), 60_000).catch((error: Error) => error);
  const internals = worker as unknown as { pending: Map<string, unknown>; worker: import('node:worker_threads').Worker };
  await expect.poll(() => internals.pending.size).toBe(1);
  const thread = internals.worker;
  const terminate = thread.terminate.bind(thread);
  thread.terminate = () => Promise.reject(new Error('terminate failed'));
  await worker.close();
  expect(((await hanging) as Error).message).toContain('stopped at shutdown');
  const [root] = read(path).roots;
  expect(existsSync(root)).toBe(true);
  expect(lockFree(path)).toBe(false);
  await terminate();
  rmSync(root, { recursive: true, force: true });
});

it('refuses a lock path that is a symlink instead of opening what it points to', () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path);
  ledger.acquire(); ledger.release();
  const victim = join(dirname(path), 'victim.sqlite');
  writeFileSync(victim, 'not a database');
  rmSync(ledger.lockPath, { force: true });
  symlinkSync(victim, ledger.lockPath);
  try {
    expect(() => new LeftoverLedger(path).acquire()).toThrow('not a plain lock file');
    expect(readFileSync(victim, 'utf8')).toBe('not a database');
  } finally { rmSync(ledger.lockPath, { force: true }); }
});

it('keeps lock files in a private directory owned by this user', () => {
  const ledger = new LeftoverLedger(ledgerPath());
  ledger.acquire(); ledger.release();
  const directory = dirname(ledger.lockPath);
  expect(dirname(directory)).toBe(tmpdir());
  const stat = lstatSync(directory);
  expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
  expect(stat.mode & 0o077).toBe(0);
  if (process.getuid) expect(stat.uid).toBe(process.getuid());
});

it('leaves an unstamped lookalike Ask folder in place', async () => {
  const lookalike = mkdtempSync(join(tmpdir(), 'codeboost-askprep-'));
  const root = join(tmpdir(), `codeboost-ask-${basename(lookalike).slice(-6)}`);
  renameSync(lookalike, root);
  writeFileSync(join(root, 'someone-elses-file'), 'keep me');
  const worker = stubWorker(new LeftoverLedger(ledgerPath()));
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(41), 60_000)).toBe('claude:answer:n');
    expect(readFileSync(join(root, 'someone-elses-file'), 'utf8')).toBe('keep me');
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
});

it('treats a record path that is a link as unreadable, and never acts on the record it points to', async () => {
  const path = ledgerPath();
  const other = ledgerPath();
  const othersRoot = createAskRoot(new LeftoverLedger(other).lockPath);
  new LeftoverLedger(other).recordRoot(othersRoot);
  symlinkSync(other, path);
  try {
    expect(() => new LeftoverLedger(path).assertClear()).toThrow('unreadable');
    expect(existsSync(othersRoot)).toBe(true);
  } finally { rmSync(othersRoot, { recursive: true, force: true }); }
});

it('leaves a folder alone when its owner stamp is a link', async () => {
  const gone = new LeftoverLedger(ledgerPath());
  gone.acquire(); gone.release();
  const root = createAskRoot(gone.lockPath);
  // The stamp is replaced by a link to a file that names a free lock, which would otherwise authorize deletion.
  const decoy = join(dirname(ledgerPath()), 'stamp');
  writeFileSync(decoy, `${gone.lockPath}\n`);
  rmSync(join(root, '.owner'));
  symlinkSync(decoy, join(root, '.owner'));
  const worker = stubWorker(new LeftoverLedger(ledgerPath()));
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(42), 60_000)).toBe('claude:answer:n');
    expect(existsSync(root)).toBe(true);
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
});

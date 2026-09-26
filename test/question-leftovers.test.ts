import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAskRoot, LeftoverLedger, type ListTaskStorage } from '../runner/question-leftovers.ts';
import { RetainedStorage } from '../runner/question-container.ts';
import { QuestionWorker } from '../runner/question-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ledgerPath = () => { const root = mkdtempSync(join(tmpdir(), 'ask-leftovers-')); roots.push(root); return join(root, 'review.sqlite.ask-leftovers.json'); };
const leftover = (n: number) => ({ keeper: `codeboost-keeper-${n}`, workVolume: `codeboost-work-${n}`, metadataVolume: `codeboost-meta-${n}` });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** Fake label query over a mutable set of names; containers are the names that start with codeboost-keeper-. */
const docker = (names: Set<string>): ListTaskStorage => async () => ({
  containers: new Set([...names].filter(name => name.startsWith('codeboost-keeper-'))),
  volumes: new Set([...names].filter(name => !name.startsWith('codeboost-keeper-'))),
});

it('keeps Ask off with commands for exactly what remains, and clears the record once it is gone', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-keeper-1', 'codeboost-work-1', 'codeboost-meta-1', 'codeboost-work-2']);
  const ledger = new LeftoverLedger(path, docker(names));
  ledger.record([leftover(1), leftover(2)]);
  ledger.record([leftover(1)]);
  expect(read(path).leftovers).toHaveLength(2);
  const error = await ledger.assertClear().catch((value: Error) => value);
  expect(error).toBeInstanceOf(Error);
  // Entry 2's keeper is already gone, so its command removes only the volume that is left.
  expect((error as Error).message.split('\n').slice(1)).toEqual([
    'docker rm -f codeboost-keeper-1', 'docker volume rm codeboost-work-1 codeboost-meta-1', 'docker volume rm codeboost-work-2']);
  names.delete('codeboost-keeper-1'); names.delete('codeboost-work-1'); names.delete('codeboost-meta-1');
  await expect(ledger.assertClear()).rejects.toThrow('docker volume rm codeboost-work-2');
  expect(read(path)).toEqual({ leftovers: [leftover(2)], untracked: 0, roots: [] });
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

it('fails closed on an unreadable or tampered record', async () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path, docker(new Set()));
  writeFileSync(path, '{not json');
  await expect(ledger.assertClear()).rejects.toThrow('unreadable');
  writeFileSync(path, JSON.stringify({ leftovers: [{ keeper: 'x; rm -rf /', workVolume: 'a', metadataVolume: 'b' }], untracked: 0 }));
  await expect(ledger.assertClear()).rejects.toThrow('unreadable');
  writeFileSync(path, JSON.stringify({ leftovers: [], untracked: -1 }));
  await expect(ledger.assertClear()).rejects.toThrow('unreadable');
  expect(existsSync(path)).toBe(true);
});

it('keeps Ask off, and the record intact, when Docker cannot be checked or the check is cancelled', async () => {
  const path = ledgerPath();
  const failing = new LeftoverLedger(path, async () => { throw new Error('Cannot connect to the Docker daemon'); });
  failing.record([leftover(1)]);
  await expect(failing.assertClear()).rejects.toThrow('could not check Docker');
  const hanging = new LeftoverLedger(path, signal => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const controller = new AbortController();
  const check = hanging.assertClear(controller.signal);
  controller.abort(new Error('Agent timed out. Try again.'));
  await expect(check).rejects.toThrow('Agent timed out. Try again.');
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0, roots: [] });
});

it('never drops entries beyond the cap; they count as unidentified leftovers', async () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path, docker(new Set()));
  ledger.record(Array.from({ length: 105 }, (_, index) => leftover(index)));
  expect(read(path).leftovers).toHaveLength(100);
  expect(read(path).untracked).toBe(5);
});

it('keeps Ask off after an unidentifiable leftover until no labelled task storage remains', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-work-unrelated']);
  const ledger = new LeftoverLedger(path, docker(names));
  ledger.record([], 1);
  await expect(ledger.assertClear()).rejects.toThrow('label=io.codeboost.allocation');
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

const stubWorker = (ledger: LeftoverLedger, options: { abandonAfterDeadlineMs?: number; terminateWaitMs?: number; releaseTimeoutMs?: number; env?: Record<string, string> } = {}) =>
  new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url), ledger,
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' }, ...options });
const scope = (n: number) => ({ repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n',
  attemptId: `leftover-attempt-${n}`, contextId: 'c'.repeat(64) });

it('records storage the worker still owns at shutdown, and the next session refuses Ask until it is removed', async () => {
  const path = ledgerPath();
  const names = new Set<string>();
  const first = stubWorker(new LeftoverLedger(path, docker(names)));
  await expect(first.agent('claude')('leak', new AbortController().signal, scope(1), 60_000)).rejects.toThrow('cleanup did not settle');
  for (const name of Object.values(leftover(1))) names.add(name);
  await first.close();
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0, roots: [] });

  const second = stubWorker(new LeftoverLedger(path, docker(names)));
  try {
    await expect(second.agent('claude')('answer', new AbortController().signal, scope(2), 60_000)).rejects.toThrow('Ask is off');
    names.clear();
    expect(await second.agent('claude')('answer', new AbortController().signal, scope(3), 60_000)).toBe('claude:answer:n');
    // Only the live worker's own root remains recorded.
    expect(read(path)).toMatchObject({ leftovers: [], untracked: 0 });
    expect(read(path).roots).toHaveLength(1);
  } finally { await second.close(); }
});

it('carries an untracked setup failure from the worker into the record at shutdown', async () => {
  const path = ledgerPath();
  const first = stubWorker(new LeftoverLedger(path, docker(new Set())));
  await expect(first.agent('claude')('lose-setup', new AbortController().signal, scope(5), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
});

it('records unknown leftovers as soon as the worker crashes', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  try {
    await expect(worker.agent('claude')('crash', new AbortController().signal, scope(6), 60_000)).rejects.toThrow('worker stopped');
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
  } finally { await worker.close(); }
  // Closing after the crash must not turn the unknown state into a clean release.
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
});

it('writes no record when nothing was left behind', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  expect(await worker.agent('claude')('answer', new AbortController().signal, scope(4), 60_000)).toBe('claude:answer:n');
  await worker.close();
  expect(existsSync(path)).toBe(false);
});

it('scans for labelled leftovers on the first question even without a record, including networks', async () => {
  const path = ledgerPath();
  let storage = { containers: new Set<string>(), volumes: new Set<string>(), networks: new Set(['codeboost-egress-1']) };
  const worker = stubWorker(new LeftoverLedger(path, async () => storage));
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(7), 60_000)).rejects.toThrow('1 labelled resource found');
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
    storage = { containers: new Set(), volumes: new Set(), networks: new Set() };
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(8), 60_000)).toBe('claude:answer:n');
    expect(read(path)).toMatchObject({ leftovers: [], untracked: 0 });
  } finally { await worker.close(); }
});

it('scans only once per process, so its own later storage does not block Ask', async () => {
  const path = ledgerPath();
  let scans = 0;
  const worker = stubWorker(new LeftoverLedger(path, async () => { scans++; return { containers: new Set(), volumes: new Set() }; }));
  try {
    await worker.agent('claude')('answer', new AbortController().signal, scope(9), 60_000);
    await worker.agent('claude')('answer', new AbortController().signal, scope(10), 60_000);
    expect(scans).toBe(1);
  } finally { await worker.close(); }
});

it('abandons a question that does not settle after its deadline, recording unknown leftovers', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())), { abandonAfterDeadlineMs: 50 });
  try {
    // Deadline is at least one second; the stub never replies.
    await expect(worker.agent('claude')('hang', new AbortController().signal, scope(11), 1_000)).rejects.toThrow('did not settle');
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(12), 60_000)).rejects.toThrow('Ask is off until codeboost restarts');
  } finally { await worker.close(); }
});

it('does not wait on unsettled questions at shutdown', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  const hanging = worker.agent('claude')('hang', new AbortController().signal, scope(13), 60_000).catch((error: Error) => error);
  await expect.poll(async () => (worker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  const started = Date.now();
  await worker.close();
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(((await hanging) as Error).message).toContain('stopped at shutdown');
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
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
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  const copy = await worker.agent('claude')('leave-copy', new AbortController().signal, scope(14), 60_000);
  const root = dirname(copy);
  // The worker's TMPDIR is the Ask root, and it was recorded before the worker ran anything.
  expect(root).toMatch(/codeboost-ask-[A-Za-z0-9]{6}$/);
  expect(dirname(root)).toBe(tmpdir());
  expect(read(path)).toEqual({ leftovers: [], untracked: 0, roots: [root] });
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
  new LeftoverLedger(path, docker(new Set())).record([], 0, [stale]);
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
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
])('refuses a record naming %s, and deletes nothing', async (_label, target) => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ leftovers: [], untracked: 0, roots: [target] }));
  await expect(new LeftoverLedger(path, docker(new Set())).assertClear()).rejects.toThrow('unreadable');
  expect(existsSync(path)).toBe(true);
});

it('reports a missing sign-in before any Docker query', async () => {
  let scans = 0;
  const worker = stubWorker(new LeftoverLedger(ledgerPath(), async () => { scans++; throw new Error('Docker is down'); }), { env: {} });
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(16), 60_000)).rejects.toThrow('CLAUDE_CODE_OAUTH_TOKEN');
    expect(scans).toBe(0);
  } finally { await worker.close(); }
});

it('keeps an abandoned question pending until its worker thread has stopped', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
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
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
});

it('hands a thread that outlives the wait to the durable record, and deletes its root once it stops', async () => {
  const path = ledgerPath();
  // The stub blocks for one second in a native call; give up waiting after 100 ms.
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())), { terminateWaitMs: 100 });
  const blocked = worker.agent('claude')('block', new AbortController().signal, scope(19), 60_000).catch((error: Error) => error);
  await expect.poll(async () => (worker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 200));
  await worker.close();
  expect(((await blocked) as Error).message).toContain('stopped at shutdown');
  // Released before the thread stopped: the ownership is durable, and the root is still recorded.
  const record = read(path);
  expect(record).toMatchObject({ leftovers: [], untracked: 1 });
  expect(record.roots).toHaveLength(1);
  const [root] = record.roots;
  expect(existsSync(root)).toBe(true);
  // Once the native call returns and the thread stops, the root is deleted and dropped from the record.
  await expect.poll(() => existsSync(root), { timeout: 5_000 }).toBe(false);
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
  // No new question is admitted meanwhile.
  await expect(worker.agent('claude')('answer', new AbortController().signal, scope(20), 60_000)).rejects.toThrow('Ask is off');
});

/** Whether another holder could take the Ask lock right now. */
const lockFree = (path: string) => {
  const probe = new LeftoverLedger(path, docker(new Set()));
  try { probe.acquire(); probe.release(); return true; } catch { return false; }
};

it('lets only one holder run Ask for a review, and the OS frees the lock when its process exits', async () => {
  const path = ledgerPath();
  const first = stubWorker(new LeftoverLedger(path, docker(new Set())));
  const second = stubWorker(new LeftoverLedger(path, docker(new Set())));
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
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())), { releaseTimeoutMs: 100, terminateWaitMs: 100 });
  expect(await worker.agent('claude')('stick-on-release', new AbortController().signal, scope(24), 60_000)).toBe('ok');
  const started = Date.now();
  await worker.close();
  expect(Date.now() - started).toBeLessThan(900);
  const record = read(path);
  expect(record).toMatchObject({ leftovers: [], untracked: 1 });
  const [root] = record.roots;
  expect(existsSync(root)).toBe(true);
  // The lock stays while the thread may still write; both go once it stops.
  expect(lockFree(path)).toBe(false);
  await expect.poll(() => existsSync(root), { timeout: 5_000 }).toBe(false);
  expect(lockFree(path)).toBe(true);
});

it('cleans up its root and releases the lock when the worker cannot be constructed', async () => {
  const path = ledgerPath();
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-ask-')));
  // A worker URL that is not a file makes the Worker constructor throw synchronously.
  const worker = new QuestionWorker(new URL('https://example.invalid/worker.js'), new LeftoverLedger(path, docker(new Set())),
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
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())), { abandonAfterDeadlineMs: 50 });
  const started = Date.now();
  const settle = (prompt: string, n: number) => worker.agent('claude')(prompt, new AbortController().signal, scope(n), 1_000)
    .then(() => Date.now(), () => Date.now());
  // Both watchdogs fire about one second in, while the thread is inside a three-second native call.
  const [first, second] = await Promise.all([settle('block-long', 26), settle('hang', 27)]);
  expect(first - started).toBeGreaterThanOrEqual(2_500);
  expect(second - started).toBeGreaterThanOrEqual(2_500);
  await worker.close();
}, 20_000);

it('keeps an unidentified marker for labelled resources left after the named leftovers are gone', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-keeper-1', 'codeboost-seeder-1']);
  const ledger = new LeftoverLedger(path, docker(names));
  ledger.record([leftover(1)]);
  await expect(ledger.assertClear()).rejects.toThrow('docker rm -f codeboost-keeper-1');
  // The recorded keeper is removed, but a seeder the record never named is still there.
  names.delete('codeboost-keeper-1');
  await expect(ledger.assertClear()).rejects.toThrow('cannot be identified');
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, roots: [] });
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

it('never drops a recorded Ask root; adding one past the cap is refused instead', () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path, docker(new Set()));
  const made = Array.from({ length: 100 }, () => mkdtempSync(join(tmpdir(), 'codeboost-ask-')));
  try {
    ledger.record([], 0, made);
    const extra = mkdtempSync(join(tmpdir(), 'codeboost-ask-'));
    made.push(extra);
    expect(() => ledger.record([], 0, [extra])).toThrow('could not be deleted');
    expect(read(path).roots).toEqual(made.slice(0, 100));
    expect(read(path).untracked).toBe(0);
  } finally { for (const root of made) rmSync(root, { recursive: true, force: true }); }
});

it('runs one startup scan for concurrent first questions, so neither sees the other as a leftover', async () => {
  const path = ledgerPath();
  let scans = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = stubWorker(new LeftoverLedger(path, async () => {
    scans++;
    await gate;
    return { containers: new Set(), volumes: new Set() };
  }));
  try {
    const first = worker.agent('claude')('answer', new AbortController().signal, scope(28), 60_000);
    const second = worker.agent('claude')('answer', new AbortController().signal, scope(29), 60_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    expect(await Promise.all([first, second])).toEqual(['claude:answer:n', 'claude:answer:n']);
    expect(scans).toBe(1);
    expect(read(path)).toMatchObject({ leftovers: [], untracked: 0 });
  } finally { await worker.close(); }
});

it('retries the startup scan after it fails', async () => {
  const path = ledgerPath();
  let scans = 0;
  const worker = stubWorker(new LeftoverLedger(path, async () => {
    if (++scans === 1) throw new Error('Docker is starting');
    return { containers: new Set(), volumes: new Set() };
  }));
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(30), 60_000)).rejects.toThrow('could not check Docker');
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(31), 60_000)).toBe('claude:answer:n');
    expect(scans).toBe(2);
  } finally { await worker.close(); }
});

it('waits for an abandonment already in progress when shutdown starts', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())), { abandonAfterDeadlineMs: 50 });
  const started = Date.now();
  // The watchdog abandons about one second in, while the thread is inside a three-second native call.
  const question = worker.agent('claude')('block-long', new AbortController().signal, scope(32), 1_000).catch((error: Error) => error);
  await new Promise(resolve => setTimeout(resolve, 1_400));
  await worker.close();
  // close() returned only after the thread stopped, and then the root is gone and the lock free.
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
  expect(((await question) as Error).message).toContain('did not settle');
  expect(read(path).roots).toEqual([]);
  expect(lockFree(path)).toBe(true);
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

it('keeps the lock until a startup scan still in flight has finished', async () => {
  const path = ledgerPath();
  let release!: () => void, scanning = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = stubWorker(new LeftoverLedger(path, async () => { scanning = true; await gate; return { containers: new Set(), volumes: new Set() }; }));
  const controller = new AbortController();
  const question = worker.agent('claude')('answer', controller.signal, scope(33), 60_000).catch((error: Error) => error);
  await expect.poll(() => scanning).toBe(true);
  controller.abort(new Error('Server stopped. Retry the question.'));
  expect(((await question) as Error).message).toBe('Server stopped. Retry the question.');
  let closed = false;
  const closing = worker.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  // The caller has gone, but the scan still runs under the lock.
  expect(closed).toBe(false);
  expect(lockFree(path)).toBe(false);
  release();
  await closing;
  expect(lockFree(path)).toBe(true);
});

it('finds a host root recorded under the old name after the database was renamed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-db-')); roots.push(dir);
  const database = join(dir, 'review.sqlite');
  writeFileSync(database, '');
  const before = LeftoverLedger.forDatabase(database, docker(new Set()));
  // A killed session left a stamped root, recorded only beside the old name.
  const root = createAskRoot(before.lockPath);
  writeFileSync(join(root, 'auth.json'), 'secret');
  before.record([], 0, [root]);
  expect(readFileSync(join(root, '.owner'), 'utf8').trim()).toBe(before.lockPath);
  renameSync(database, join(dir, 'renamed.sqlite'));
  const worker = stubWorker(LeftoverLedger.forDatabase(join(dir, 'renamed.sqlite'), docker(new Set())));
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(34), 60_000)).toBe('claude:answer:n');
    expect(existsSync(root)).toBe(false);
  } finally { await worker.close(); }
});

it('leaves an unrecorded root alone while its owner holds its lock, and reclaims it once the owner is gone', async () => {
  const owner = new LeftoverLedger(ledgerPath(), docker(new Set()));
  owner.acquire();
  const root = createAskRoot(owner.lockPath);
  try {
    const first = stubWorker(new LeftoverLedger(ledgerPath(), docker(new Set())));
    try { expect(await first.agent('claude')('answer', new AbortController().signal, scope(35), 60_000)).toBe('claude:answer:n'); }
    finally { await first.close(); }
    expect(existsSync(root)).toBe(true);
  } finally { owner.release(); }
  const second = stubWorker(new LeftoverLedger(ledgerPath(), docker(new Set())));
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
  const worker = stubWorker(new LeftoverLedger(ledgerPath(), docker(new Set())));
  try { expect(await worker.agent('claude')('answer', new AbortController().signal, scope(37), 60_000)).toBe('claude:answer:n'); }
  finally { await worker.close(); }
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
  // The stamp was not trusted: the named file was never opened, and the root was treated as ownerless.
  expect(readFileSync(outside, 'utf8')).toBe('not a lock');
  expect(existsSync(root)).toBe(false);
  } finally { cleanup(); }
});

it('still scans Docker at startup after deleting a recorded root', async () => {
  const path = ledgerPath();
  const stale = mkdtempSync(join(tmpdir(), 'codeboost-ask-'));
  new LeftoverLedger(path, docker(new Set())).record([], 0, [stale]);
  // An unrecorded labelled container remains from the earlier session.
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set(['codeboost-keeper-orphan']))));
  try {
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(38), 60_000)).rejects.toThrow('cannot be identified');
    expect(existsSync(stale)).toBe(false);
    expect(read(path)).toMatchObject({ leftovers: [], untracked: 1 });
  } finally { await worker.close(); }
});

it('never follows a link planted at a temporary name when writing the record', () => {
  const path = ledgerPath();
  const victim = join(dirname(path), 'victim.txt');
  writeFileSync(victim, 'original');
  // The name the previous implementation used.
  symlinkSync(victim, `${path}.${process.pid}.tmp`);
  new LeftoverLedger(path, docker(new Set())).record([leftover(1)]);
  expect(readFileSync(victim, 'utf8')).toBe('original');
  expect(read(path).leftovers).toEqual([leftover(1)]);
  expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp') && !name.includes(String(process.pid)))).toEqual([]);
});

it('keeps the root recorded when the final release report cannot be saved', async () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path, docker(new Set()));
  const worker = stubWorker(ledger);
  expect(await worker.agent('claude')('leak', new AbortController().signal, scope(39), 60_000).catch(() => 'failed')).toBe('failed');
  const [root] = read(path).roots;
  const original = ledger.record.bind(ledger);
  ledger.record = () => { throw new Error('disk full'); };
  await expect(worker.close()).rejects.toThrow('disk full');
  ledger.record = original;
  // Nothing was lost: the root stays on disk and in the record for the next session to reclaim.
  expect(existsSync(root)).toBe(true);
  expect(read(path).roots).toEqual([root]);
  // And the review is not left locked for the rest of the process.
  expect(lockFree(path)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

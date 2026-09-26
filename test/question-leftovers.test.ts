import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LeftoverLedger, type ListTaskStorage } from '../runner/question-leftovers.ts';
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
  expect(read(path)).toEqual({ leftovers: [leftover(2)], untracked: 0, paths: [] });
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
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0, paths: [] });
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
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

const stubWorker = (ledger: LeftoverLedger, options: { abandonAfterDeadlineMs?: number; env?: Record<string, string> } = {}) =>
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
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0, paths: [] });

  const second = stubWorker(new LeftoverLedger(path, docker(names)));
  try {
    await expect(second.agent('claude')('answer', new AbortController().signal, scope(2), 60_000)).rejects.toThrow('Ask is off');
    names.clear();
    expect(await second.agent('claude')('answer', new AbortController().signal, scope(3), 60_000)).toBe('claude:answer:n');
    expect(existsSync(path)).toBe(false);
  } finally { await second.close(); }
});

it('carries an untracked setup failure from the worker into the record at shutdown', async () => {
  const path = ledgerPath();
  const first = stubWorker(new LeftoverLedger(path, docker(new Set())));
  await expect(first.agent('claude')('lose-setup', new AbortController().signal, scope(5), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
});

it('records unknown leftovers as soon as the worker crashes', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  try {
    await expect(worker.agent('claude')('crash', new AbortController().signal, scope(6), 60_000)).rejects.toThrow('worker stopped');
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
  } finally { await worker.close(); }
  // Closing after the crash must not turn the unknown state into a clean release.
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
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
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
    storage = { containers: new Set(), volumes: new Set(), networks: new Set() };
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(8), 60_000)).toBe('claude:answer:n');
    expect(existsSync(path)).toBe(false);
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
    expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
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
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
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

it('records staging directories left at shutdown and deletes them before the next question', async () => {
  const path = ledgerPath();
  const root = staging();
  const first = stubWorker(new LeftoverLedger(path, docker(new Set())));
  await expect(first.agent('claude')(`stuck-path:${root}`, new AbortController().signal, scope(14), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(read(path)).toEqual({ leftovers: [], untracked: 0, paths: [root] });
  expect(existsSync(root)).toBe(true);
  const second = stubWorker(new LeftoverLedger(path, docker(new Set())));
  try {
    expect(await second.agent('claude')('answer', new AbortController().signal, scope(15), 60_000)).toBe('claude:answer:n');
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path)).toBe(false);
  } finally { await second.close(); }
});

it('refuses a record that names a path outside Ask staging', async () => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ leftovers: [], untracked: 0, paths: ['/home/user'] }));
  await expect(new LeftoverLedger(path, docker(new Set())).assertClear()).rejects.toThrow('unreadable');
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
  expect(read(path)).toEqual({ leftovers: [], untracked: 1, paths: [] });
});

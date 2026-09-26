import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LeftoverLedger, type ListTaskStorage } from '../runner/question-leftovers.ts';
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
  expect(read(path)).toEqual({ leftovers: [leftover(2)], untracked: 0 });
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
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0 });
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
  await expect(ledger.assertClear()).rejects.toThrow('label=io.codeboost.task-storage');
  expect(read(path)).toEqual({ leftovers: [], untracked: 1 });
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

const stubWorker = (ledger: LeftoverLedger) => new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url), ledger);
const scope = (n: number) => ({ repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n',
  attemptId: `leftover-attempt-${n}`, contextId: 'c'.repeat(64) });

it('records storage the worker still owns at shutdown, and the next session refuses Ask until it is removed', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-keeper-1', 'codeboost-work-1', 'codeboost-meta-1']);
  const first = stubWorker(new LeftoverLedger(path, docker(names)));
  await expect(first.agent('claude')('leak', new AbortController().signal, scope(1), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(read(path)).toEqual({ leftovers: [leftover(1)], untracked: 0 });

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
  const first = stubWorker(new LeftoverLedger(path, docker(new Set(['codeboost-work-x']))));
  await expect(first.agent('claude')('lose-setup', new AbortController().signal, scope(5), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(read(path)).toEqual({ leftovers: [], untracked: 1 });
});

it('records unknown leftovers as soon as the worker crashes', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set(['codeboost-work-x']))));
  try {
    await expect(worker.agent('claude')('crash', new AbortController().signal, scope(6), 60_000)).rejects.toThrow('worker stopped');
    expect(read(path)).toEqual({ leftovers: [], untracked: 1 });
  } finally { await worker.close(); }
  // Closing after the crash must not turn the unknown state into a clean release.
  expect(read(path)).toEqual({ leftovers: [], untracked: 1 });
});

it('writes no record when nothing was left behind', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, docker(new Set())));
  expect(await worker.agent('claude')('answer', new AbortController().signal, scope(4), 60_000)).toBe('claude:answer:n');
  await worker.close();
  expect(existsSync(path)).toBe(false);
});

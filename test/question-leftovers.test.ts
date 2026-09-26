import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LeftoverLedger, type ResourceExists } from '../runner/question-leftovers.ts';
import { QuestionWorker } from '../runner/question-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ledgerPath = () => { const root = mkdtempSync(join(tmpdir(), 'ask-leftovers-')); roots.push(root); return join(root, 'review.sqlite.ask-leftovers.json'); };
const leftover = (n: number) => ({ keeper: `codeboost-keeper-${n}`, workVolume: `codeboost-work-${n}`, metadataVolume: `codeboost-meta-${n}` });
const present = (names: Set<string>): ResourceExists => async (_kind, name) => names.has(name);

it('keeps Ask off with removal commands while recorded storage exists, and clears the record once it is gone', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-keeper-1', 'codeboost-work-1', 'codeboost-meta-1', 'codeboost-work-2']);
  const ledger = new LeftoverLedger(path, present(names));
  ledger.record([leftover(1), leftover(2)]);
  ledger.record([leftover(1)]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2);
  await expect(ledger.assertClear()).rejects.toThrow('docker rm -f codeboost-keeper-1 && docker volume rm codeboost-work-1 codeboost-meta-1');
  names.delete('codeboost-keeper-1'); names.delete('codeboost-work-1'); names.delete('codeboost-meta-1');
  // Entry 2 still has one volume, so it stays recorded and Ask stays off.
  await expect(ledger.assertClear()).rejects.toThrow('codeboost-keeper-2');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([leftover(2)]);
  names.clear();
  await expect(ledger.assertClear()).resolves.toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

it('fails closed on an unreadable or tampered record', async () => {
  const path = ledgerPath();
  const ledger = new LeftoverLedger(path, present(new Set()));
  writeFileSync(path, '{not json');
  await expect(ledger.assertClear()).rejects.toThrow('unreadable');
  writeFileSync(path, JSON.stringify([{ keeper: 'x; rm -rf /', workVolume: 'a', metadataVolume: 'b' }]));
  await expect(ledger.assertClear()).rejects.toThrow('unreadable');
  expect(existsSync(path)).toBe(true);
});

const stubWorker = (ledger: LeftoverLedger) => new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url), ledger);
const scope = (n: number) => ({ repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n',
  attemptId: `leftover-attempt-${n}`, contextId: 'c'.repeat(64) });

it('records storage the worker still owns at shutdown, and the next session refuses Ask until it is removed', async () => {
  const path = ledgerPath();
  const names = new Set(['codeboost-keeper-1', 'codeboost-work-1', 'codeboost-meta-1']);
  const first = stubWorker(new LeftoverLedger(path, present(names)));
  await expect(first.agent('claude')('leak', new AbortController().signal, scope(1), 60_000)).rejects.toThrow('cleanup did not settle');
  await first.close();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([leftover(1)]);

  const second = stubWorker(new LeftoverLedger(path, present(names)));
  try {
    await expect(second.agent('claude')('answer', new AbortController().signal, scope(2), 60_000)).rejects.toThrow('Ask is off');
    names.clear();
    expect(await second.agent('claude')('answer', new AbortController().signal, scope(3), 60_000)).toBe('claude:answer:n');
    expect(existsSync(path)).toBe(false);
  } finally { await second.close(); }
});

it('writes no record when nothing was left behind', async () => {
  const path = ledgerPath();
  const worker = stubWorker(new LeftoverLedger(path, present(new Set())));
  expect(await worker.agent('claude')('answer', new AbortController().signal, scope(4), 60_000)).toBe('claude:answer:n');
  await worker.close();
  expect(existsSync(path)).toBe(false);
});

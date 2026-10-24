import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import { reviewDiffs } from '../runner/review-diffs.ts';
import { fixtureGit } from './fixtures/git.ts';

// The review prompt's diffs (#201), from real Git: every changed file in path order, with the text the prompt carries,
// or null where the prompt cannot carry it.
const dirs: string[] = [], signal = () => AbortSignal.timeout(30_000);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'review-diffs-')); dirs.push(dir);
  fixtureGit(dir, 'init', '--quiet', '--initial-branch=main');
  fixtureGit(dir, 'config', 'user.name', 't'); fixtureGit(dir, 'config', 'user.email', 't@t.invalid');
  const commit = (files: Record<string, string | Buffer | null>) => {
    for (const [path, content] of Object.entries(files)) content === null ? unlinkSync(join(dir, path)) : writeFileSync(join(dir, path), content);
    fixtureGit(dir, 'add', '--all'); fixtureGit(dir, 'commit', '--quiet', '--allow-empty', '-m', 'c');
    return fixtureGit(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

it('lists every changed file in path order, with its diff, and null for what the prompt cannot carry', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'edited.ts': 'one\n', 'removed.ts': 'gone\n', 'binary.bin': Buffer.from([1, 0, 2]), 'latin1.txt': 'a\n', 'big.txt': 'x\n', 'huge.txt': 'x\n', 'fits.txt': 'x\n', 'same.ts': 's\n' });
  const head = commit({ 'edited.ts': 'two\n', 'removed.ts': null, 'added.ts': 'new\n', 'binary.bin': Buffer.from([3, 0, 4]),
    'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'big.txt': `${'y'.repeat(MAX_PROMPT_BYTES)}\n`, 'huge.txt': `${'z'.repeat(4 * MAX_PROMPT_BYTES)}\n`,
    // Its diff is a few bytes under 32 KiB: shown, even with Git's hints on stderr.
    'fits.txt': `${'y'.repeat(MAX_PROMPT_BYTES - 200)}\n`,
    // A name with pathspec magic is matched literally, not as a glob.
    '*.ts': 'star\n' });
  const diffs = await reviewDiffs(dir, base, head, signal());
  expect(diffs.map(entry => entry.path)).toEqual(['*.ts', 'added.ts', 'big.txt', 'binary.bin', 'edited.ts', 'fits.txt', 'huge.txt', 'latin1.txt', 'removed.ts']);
  const by = Object.fromEntries(diffs.map(entry => [entry.path, entry.diff]));
  expect(by['edited.ts']).toContain('-one\n+two\n');
  expect(by['added.ts']).toContain('+new\n');
  expect(by['removed.ts']).toContain('-gone\n');
  expect(by['*.ts']).toContain('+star\n');
  expect(by['*.ts']).not.toContain('edited.ts');
  // Git's own note for a binary file is text the prompt can carry.
  expect(by['binary.bin']).toContain('Binary files');
  // Not UTF-8, or longer than a data block's 32 KiB string: the agent reads the file instead.
  expect([by['latin1.txt'], by['big.txt'], by['huge.txt']]).toEqual([null, null, null]);
  expect(Buffer.byteLength(by['fits.txt']!)).toBeGreaterThan(MAX_PROMPT_BYTES - 200);
  expect(await reviewDiffs(dir, head, head, signal())).toEqual([]);
});

it('shows a diff of exactly 32 KiB, and not one byte longer', async () => {
  const { dir, commit } = repository();
  // Two names of one length have headers of one length: measure it on a one-line change, then size each file to it.
  const base = commit({ 'at.txt': 'x\n', 'ov.txt': 'x\n' });
  const probe = commit({ 'at.txt': 'y\n' });
  const header = Buffer.byteLength((await reviewDiffs(dir, base, probe, signal()))[0]!.diff!) - 'y\n'.length;
  const line = (bytes: number) => `${'z'.repeat(bytes - header - 1)}\n`;
  const head = commit({ 'at.txt': line(MAX_PROMPT_BYTES), 'ov.txt': line(MAX_PROMPT_BYTES + 1) });
  const [at, over] = await reviewDiffs(dir, base, head, signal());
  expect(Buffer.byteLength(at!.diff!)).toBe(MAX_PROMPT_BYTES);
  expect(over).toEqual({ path: 'ov.txt', diff: null });
});

it('refuses a commit that is not a full commit ID and a Git failure, and stops when its signal does', async () => {
  const { dir, commit } = repository();
  const head = commit({ 'a.ts': 'a\n' });
  await expect(reviewDiffs(dir, 'HEAD', head, signal())).rejects.toThrow('full commit IDs');
  await expect(reviewDiffs(dir, '0'.repeat(40), head, signal())).rejects.toThrow('Git could not list the files the plan changed.');
  await expect(reviewDiffs(dir, head, head, AbortSignal.abort())).rejects.toThrow();
});

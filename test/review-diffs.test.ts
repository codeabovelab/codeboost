import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import { reviewDiffs } from '../runner/review-diffs.ts';
import { fixtureGit } from './fixtures/git.ts';

// The review prompt's diffs (#201), from real Git: every changed file in path order, with the text the prompt carries,
// or null where the prompt cannot carry it.
const dirs: string[] = [];
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

it('lists every changed file in path order, with its diff, and null for what the prompt cannot carry', () => {
  const { dir, commit } = repository();
  const base = commit({ 'edited.ts': 'one\n', 'removed.ts': 'gone\n', 'binary.bin': Buffer.from([1, 0, 2]), 'latin1.txt': 'a\n', 'big.txt': 'x\n', 'huge.txt': 'x\n', 'fits.txt': 'x\n', 'same.ts': 's\n' });
  const head = commit({ 'edited.ts': 'two\n', 'removed.ts': null, 'added.ts': 'new\n', 'binary.bin': Buffer.from([3, 0, 4]),
    'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'big.txt': `${'y'.repeat(MAX_PROMPT_BYTES)}\n`, 'huge.txt': `${'z'.repeat(4 * MAX_PROMPT_BYTES)}\n`,
    // Its diff is a few bytes under 32 KiB: shown, even with Git's hints on stderr.
    'fits.txt': `${'y'.repeat(MAX_PROMPT_BYTES - 200)}\n`,
    // A name with pathspec magic is matched literally, not as a glob.
    '*.ts': 'star\n' });
  const diffs = reviewDiffs(dir, base, head);
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
  expect(reviewDiffs(dir, head, head)).toEqual([]);
});

it('refuses a commit that is not a full commit ID, and a Git failure', () => {
  const { dir, commit } = repository();
  const head = commit({ 'a.ts': 'a\n' });
  expect(() => reviewDiffs(dir, 'HEAD', head)).toThrow('full commit IDs');
  expect(() => reviewDiffs(dir, '0'.repeat(40), head)).toThrow('Git could not list the files the plan changed.');
});

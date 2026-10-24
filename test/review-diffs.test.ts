import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
  // Binary content, not UTF-8, or longer than a data block's 32 KiB string: the agent reads the file instead.
  expect([by['binary.bin'], by['latin1.txt'], by['big.txt'], by['huge.txt']]).toEqual([null, null, null, null]);
  expect(Buffer.byteLength(by['fits.txt']!)).toBeGreaterThan(MAX_PROMPT_BYTES - 200);
  expect(await reviewDiffs(dir, head, head, signal())).toEqual([]);
});

it('shows a file\'s diff even when an in-tree attribute marks it binary', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'a.ts': 'safe\n' });
  // The agent being reviewed could write this file along with its edit.
  const head = commit({ '.gitattributes': '* -diff binary\n', 'a.ts': 'unsafe\n' });
  const by = Object.fromEntries((await reviewDiffs(dir, base, head, signal())).map(entry => [entry.path, entry.diff]));
  expect(by['a.ts']).toContain('-safe\n+unsafe\n');
  expect(by['.gitattributes']).toContain('+* -diff binary\n');
});

it('gives a file replaced by a directory only its own diff', async () => {
  const { dir, commit } = repository();
  const base = commit({ cfg: 'old\n' });
  rmSync(join(dir, 'cfg')); mkdirSync(join(dir, 'cfg'));
  const head = commit({ 'cfg/inner': `${'n'.repeat(MAX_PROMPT_BYTES)}\n` });
  const diffs = await reviewDiffs(dir, base, head, signal());
  expect(diffs.map(entry => entry.path)).toEqual(['cfg', 'cfg/inner']);
  expect(diffs[0]!.diff).toContain('-old\n');
  expect(diffs[0]!.diff).not.toContain('cfg/inner');
  expect(diffs[1]!.diff).toBeNull();
});

it('shows both sides of a file whose type changed', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'a.ts': 'secret check\n', 'b.ts': 'b\n' });
  rmSync(join(dir, 'a.ts')); symlinkSync('b.ts', join(dir, 'a.ts'));
  const head = commit({});
  const [entry] = await reviewDiffs(dir, base, head, signal());
  expect(entry!.path).toBe('a.ts');
  expect(entry!.diff).toContain('deleted file mode 100644');
  expect(entry!.diff).toContain('new file mode 120000');
  expect(entry!.diff).toContain('+b.ts');
});

it('shows a renamed file as its rename and its edits, under its new path', async () => {
  const { dir, commit } = repository();
  const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}`);
  const base = commit({ 'old.ts': `${lines.join('\n')}\n` });
  rmSync(join(dir, 'old.ts'));
  const head = commit({ 'new.ts': `${lines.map((line, index) => index === 1500 ? 'changed' : line).join('\n')}\n` });
  const diffs = await reviewDiffs(dir, base, head, signal());
  expect(diffs.map(entry => entry.path)).toEqual(['new.ts']);
  expect(diffs[0]!.diff).toContain('rename from old.ts\nrename to new.ts');
  expect(diffs[0]!.diff).toContain('-line 1500\n+changed\n');
  expect(Buffer.byteLength(diffs[0]!.diff!)).toBeLessThan(1000);
});

it('rejects a stop only after Git has exited', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'a.ts': 'a\n' }), head = commit({ 'a.ts': 'b\n' });
  // A stand-in Git that ignores SIGTERM and writes its PID, so only a kill ends it.
  const bin = mkdtempSync(join(tmpdir(), 'review-diffs-git-')); dirs.push(bin);
  const fake = join(bin, 'git'), pidFile = join(bin, 'pid');
  writeFileSync(fake, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`); chmodSync(fake, 0o755);
  const controller = new AbortController();
  const running = reviewDiffs(dir, base, head, controller.signal, fake);
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  controller.abort(new Error('stopped'));
  await expect(running).rejects.toThrow('stopped');
  expect(() => process.kill(pid, 0)).toThrow();
});

it('stops reading diffs once they fill a whole prompt, and lists the rest with no diff', async () => {
  const { dir, commit } = repository();
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}.txt`, 'x\n']));
  const base = commit(files);
  const head = commit(Object.fromEntries(Object.keys(files).map(path => [path, `${'w'.repeat(20_000)}\n`])));
  const diffs = await reviewDiffs(dir, base, head, signal());
  expect(diffs.map(entry => entry.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
  // About 20 KB each: three are under a whole prompt, the fourth passes it, and no diff after that is read.
  expect(diffs.map(entry => entry.diff !== null)).toEqual([true, true, true, true, false]);
});

it('leaves out a submodule (gitlink) change: Git stays out of submodules', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'a.ts': 'a\n' });
  fixtureGit(dir, 'update-index', '--add', '--cacheinfo', `160000,${base},sub`);
  // Staged by name: `add --all` would drop the gitlink, which has no directory here.
  writeFileSync(join(dir, 'a.ts'), 'b\n'); fixtureGit(dir, 'add', 'a.ts');
  fixtureGit(dir, 'commit', '--quiet', '-m', 'gitlink');
  const head = fixtureGit(dir, 'rev-parse', 'HEAD');
  expect(fixtureGit(dir, 'ls-tree', head, 'sub')).toContain('160000 commit');
  expect((await reviewDiffs(dir, base, head, signal())).map(entry => entry.path)).toEqual(['a.ts']);
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

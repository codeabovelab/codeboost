import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { HARDENED_GIT_OPTIONS, hardenedGitEnvironment } from '../scripts/git-environment.ts';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import { MAX_REVIEW_PROMPT_BYTES } from '../core/review-prompt.ts';
import { reviewDiffs, ReviewDiffsRefused } from '../runner/review-diffs.ts';
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

it('says how each file changed, and a rename\'s old path, even where the diff is null', async () => {
  const { dir, commit } = repository();
  const lines = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
  const base = commit({ 'secure.ts': `${lines.join('\n')}\n`, 'big.bin': `${'b'.repeat(40_000)}\n`, 'kept.ts': 'k\n' });
  rmSync(join(dir, 'secure.ts')); rmSync(join(dir, 'big.bin'));
  const head = commit({ 'declared.ts': `${lines.map((line, index) => index % 3 ? line : `${line} edited`).join('\n')}\n`, 'kept.ts': 'k2\n', 'new.ts': 'n\n' });
  const diffs = await reviewDiffs(dir, base, head, signal());
  expect(diffs.map(({ path, change, from, diff }) => ({ path, change, from, shown: diff !== null }))).toEqual([
    { path: 'big.bin', change: 'deleted', from: null, shown: false },
    { path: 'declared.ts', change: 'renamed', from: 'secure.ts', shown: false },
    { path: 'kept.ts', change: 'modified', from: null, shown: true },
    { path: 'new.ts', change: 'added', from: null, shown: true },
  ]);
});

it('shows both sides of a file whose type changed', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'a.ts': 'secret check\n', 'b.ts': 'b\n' });
  rmSync(join(dir, 'a.ts')); symlinkSync('b.ts', join(dir, 'a.ts'));
  const head = commit({});
  const [entry] = await reviewDiffs(dir, base, head, signal());
  expect([entry!.path, entry!.change]).toEqual(['a.ts', 'type changed']);
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
  // A stand-in for a Git process that is still running: it ignores SIGTERM and writes its PID, so only a kill ends it.
  // The code reads none of a Git's output before the stop, so the stand-in gives none, and models no Git version.
  const bin = mkdtempSync(join(tmpdir(), 'review-diffs-git-')); dirs.push(bin);
  const fake = join(bin, 'git'), pidFile = join(bin, 'pid');
  writeFileSync(fake, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`); chmodSync(fake, 0o755);
  const controller = new AbortController();
  const running = reviewDiffs(dir, base, head, controller.signal, { executable: fake });
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 30_000 });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  controller.abort(new Error('stopped'));
  await expect(running).rejects.toThrow('stopped');
  expect(() => process.kill(pid, 0)).toThrow();
});

it('gives no diff for a rename into a directory of its own name whose other changes\' names pass 64 KiB', async () => {
  const { dir, commit } = repository();
  const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
  const base = commit({ a: `${text}\n` });
  rmSync(join(dir, 'a')); mkdirSync(join(dir, 'a'));
  // 300 names of 250 characters: about 80 KB of excludes, though fewer than a thousand of them.
  const others = Array.from({ length: 300 }, (_, index) => `a/${'x'.repeat(245)}${String(index).padStart(3, '0')}`);
  const head = commit({ 'a/b': `${text}\nmore\n`, ...Object.fromEntries(others.map(path => [path, 'x\n'])) });
  const diffs = await reviewDiffs(dir, base, head, AbortSignal.timeout(120_000));
  expect(diffs.find(entry => entry.path === 'a/b')).toEqual({ path: 'a/b', diff: null, change: 'renamed', from: 'a' });
  expect(diffs.find(entry => entry.path === others[0])!.diff).toContain('+x');
}, 120_000);

it('shows a decomposed (NFD) name\'s own diff, next to its composed twin', async () => {
  const { dir, commit } = repository();
  // Built with mktree, so the names stay exactly as written whatever the host's file system does with them. On macOS,
  // `git init` sets core.precomposeunicode, which this checks is turned off; elsewhere it is off anyway.
  const blob = (text: string) => execFileSync('git', [...HARDENED_GIT_OPTIONS, 'hash-object', '-w', '--stdin'], { cwd: dir, input: text, env: hardenedGitEnvironment() }).toString().trim();
  const tree = (nfd: string, nfc: string) => execFileSync('git', [...HARDENED_GIT_OPTIONS, 'mktree'], { cwd: dir, env: hardenedGitEnvironment(),
    input: `100644 blob ${blob(nfd)}\tcafe\u0301.ts\n100644 blob ${blob(nfc)}\tcaf\u00e9.ts\n` }).toString().trim();
  const first = commit({ 'seed.ts': 's\n' });
  const base = fixtureGit(dir, 'commit-tree', tree('1\n', '2\n'), '-p', first, '-m', 'base');
  const head = fixtureGit(dir, 'commit-tree', tree('1x\n', '2x\n'), '-p', base, '-m', 'head');
  const by = Object.fromEntries((await reviewDiffs(dir, base, head, signal())).map(entry => [entry.path, entry.diff]));
  expect(by['cafe\u0301.ts']).toContain('-1\n+1x\n');
  expect(by['caf\u00e9.ts']).toContain('-2\n+2x\n');
});

it('refuses when Git skips rename detection, rather than hide a renamed file\'s edits', async () => {
  const { dir, commit } = repository();
  const big = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const base = commit({ 'big.ts': `${big.join('\n')}\n`, ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`d${index}.txt`, `d${index} content here\n`])) });
  for (let index = 0; index < 4; index++) rmSync(join(dir, `d${index}.txt`));
  rmSync(join(dir, 'big.ts'));
  const head = commit({ 'big2.ts': `${big.map((line, index) => index === 100 ? 'PLANTED' : line).join('\n')}\n`,
    ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`e${index}.txt`, `e${index} other ${index}\n`])) });
  // A limit of 2 stands in for Git's 1,000, so a few files are past it.
  await expect(reviewDiffs(dir, base, head, signal(), { renameLimit: 2 })).rejects.toThrow(ReviewDiffsRefused);
  // Found however many other messages come first, and when it arrives split: a stand-in Git that prints 20,000 hints,
  // then Git 2.54.0's warning (as Apple Git-157 printed it above) in two writes, and exits 0 with no output, as Git
  // does; the code reads nothing else of a listing that warns.
  const bin = mkdtempSync(join(tmpdir(), 'review-diffs-git-')); dirs.push(bin);
  const fake = join(bin, 'git');
  writeFileSync(fake, `#!/bin/sh\ni=0\nwhile [ $i -lt 20000 ]; do echo 'hint: harmless' >&2; i=$((i+1)); done\nprintf 'warning: exhaustive rename detec' >&2\nsleep 0.2\nprintf 'tion was skipped due to too many files.\\n' >&2\nexit 0\n`);
  chmodSync(fake, 0o755);
  await expect(reviewDiffs(dir, base, head, signal(), { executable: fake })).rejects.toThrow(ReviewDiffsRefused);
  // Within the limit, the rename and its edit are shown.
  const diffs = await reviewDiffs(dir, base, head, signal(), { renameLimit: 100 });
  expect(diffs.find(entry => entry.path === 'big2.ts')!.diff).toContain('+PLANTED');
});

it('keeps a byte-order mark at the start of a name', async () => {
  const { dir, commit } = repository();
  const base = commit({ 'evil.sh': 'x\n' });
  const head = commit({ '\uFEFFevil.sh': 'secret\n', 'evil.sh': 'y\n' });
  const by = Object.fromEntries((await reviewDiffs(dir, base, head, signal())).map(entry => [entry.path, entry.diff]));
  expect(Object.keys(by).sort()).toEqual(['evil.sh', '\uFEFFevil.sh'].sort());
  expect(by['\uFEFFevil.sh']).toContain('+secret');
  expect(by['evil.sh']).toContain('+y');
});

it('stops reading diffs once the listed paths alone fill a whole prompt, and lists the rest with no diff', async () => {
  const { dir, commit } = repository();
  // Long names, so a few hundred files' paths alone pass a prompt.
  const names = Array.from({ length: 260 }, (_, index) => `${'p'.repeat(240)}${String(index).padStart(3, '0')}.txt`);
  const base = commit(Object.fromEntries(names.map(name => [name, 'x\n'])));
  const head = commit(Object.fromEntries(names.map(name => [name, 'y\n'])));
  const diffs = await reviewDiffs(dir, base, head, AbortSignal.timeout(120_000));
  expect(diffs.map(entry => entry.path)).toEqual(names);
  let listable = 0;
  const readable = names.filter(path => (listable += Buffer.byteLength(JSON.stringify({ path, diff: null, change: 'modified', from: null }))) <= MAX_REVIEW_PROMPT_BYTES).length;
  expect(readable).toBeLessThan(names.length);
  expect(diffs.map(entry => entry.diff !== null)).toEqual(names.map((_, index) => index < readable));
}, 120_000);

it('shows a file renamed into a directory of its own name, and back', async () => {
  const { dir, commit } = repository();
  const text = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const base = commit({ a: `${text.join('\n')}\n` });
  rmSync(join(dir, 'a')); mkdirSync(join(dir, 'a'));
  // Another changed file in that directory, too large for a diff, must not join the rename's diff.
  const moved = commit({ 'a/b': `${text.map((line, index) => index === 20 ? 'PLANTED' : line).join('\n')}\n`, 'a/c': `${'c'.repeat(MAX_PROMPT_BYTES)}\n` });
  const into = await reviewDiffs(dir, base, moved, signal());
  expect(into.map(entry => entry.path)).toEqual(['a/b', 'a/c']);
  expect(into[0]!.diff).toContain('rename from a\nrename to a/b');
  expect(into[0]!.diff).toContain('+PLANTED');
  expect(into[0]!.diff).not.toContain('a/c');
  expect(into[1]!.diff).toBeNull();
  const back = await reviewDiffs(dir, moved, base, signal());
  expect(back.map(entry => entry.path)).toEqual(['a', 'a/c']);
  expect(back[0]!.diff).toContain('rename from a/b\nrename to a');
  expect(back[0]!.diff).not.toContain('a/c');
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
  expect(over).toEqual({ path: 'ov.txt', diff: null, change: 'modified', from: null });
});

it('refuses a commit that is not a full commit ID and a Git failure, and stops when its signal does', async () => {
  const { dir, commit } = repository();
  const head = commit({ 'a.ts': 'a\n' });
  await expect(reviewDiffs(dir, 'HEAD', head, signal())).rejects.toThrow('full commit IDs');
  await expect(reviewDiffs(dir, '0'.repeat(40), head, signal())).rejects.toThrow('Git could not list the files the plan changed.');
  await expect(reviewDiffs(dir, head, head, AbortSignal.abort())).rejects.toThrow();
});

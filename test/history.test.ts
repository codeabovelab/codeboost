import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { readHistory } from '../git/history.ts';
import { linkHistory } from '../core/linking.ts';
import { approveItem, approvalStates, applyChoices, choiceKeys } from '../core/approvals.ts';
import type { Plan } from '../core/plan.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(initial: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'codeboost-history-')); dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const write = (path: string, text: string | Buffer) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const ledger = new Map<string, string>();
  const commit = (owner?: string, message = 'Change') => { git('add', '-A'); git('commit', '-m', message); const sha = git('rev-parse', 'HEAD'); if (owner) ledger.set(sha, owner); return sha; };
  for (const [path, text] of Object.entries(initial)) write(path, text);
  const base = commit();
  const plan: Plan = { schema_version: 1, issue: 1, revision: 1, summary: 'Test', questions: [], items: ['P1', 'P2'].map(id => ({
    id, title: id, intent: 'Change', files: [{ path: 'a.txt', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [],
  })) };
  const segments = () => linkHistory(plan, readHistory(dir, base), ledger);
  return { dir, git, write, commit, base, ledger, plan, segments };
}
it('splits a shared hunk by ledger owner; detects out-of-scope and forged trailers', () => {
  const f = fixture(); f.write('a.txt', 'ONE\ntwo\nthree\n'); f.commit('P1');
  f.write('a.txt', 'ONE\ntwo\nTHREE\n'); f.write('outside.txt', 'outside\n'); f.commit('P2');
  f.write('foreign.txt', 'foreign\n'); f.commit(undefined, 'Forged\n\nPlan-Item: P1');
  const parts = f.segments();
  expect(parts.find(s => s.content === 'ONE\n')?.row).toBe('P1');
  expect(parts.find(s => s.content === 'THREE\n')?.row).toBe('P2');
  expect(parts.find(s => s.content === 'ONE\n')?.sharesHunkWith).toContain('P2');
  expect(parts.filter(s => s.path === 'outside.txt').every(s => s.scope === 'out-of-scope')).toBe(true);
  expect(parts.filter(s => s.path === 'foreign.txt').every(s => s.row === 'Unplanned')).toBe(true);
});
it('attributes pure deletions and marks repeated edits as ambiguous', () => {
  const f = fixture(); f.write('a.txt', 'one\nthree\n'); f.commit('P1');
  expect(f.segments().find(s => s.content === 'two\n')?.row).toBe('P1');
  f.write('a.txt', 'ONE\nthree\n'); f.commit('P1'); f.write('a.txt', 'FIRST\nthree\n'); f.commit('P2');
  const changed = f.segments().find(s => s.content === 'FIRST\n');
  expect(changed?.row).toBe('Ambiguous'); expect(changed?.owners).toEqual(['P1', 'P2']);
});
it('omits changes reverted back to the base', () => {
  const f = fixture(); f.write('a.txt', 'changed\n'); f.commit('P1'); f.write('a.txt', 'one\ntwo\nthree\n'); f.commit('P2');
  expect(f.segments()).toEqual([]);
});
it('represents binary, executable, empty, rename, symlink and submodule changes', () => {
  const f = fixture({ 'a.txt': 'one\ntwo\nthree\n', 'rename.txt': 'rename\n' });
  chmodSync(join(f.dir, 'a.txt'), 0o755); f.write('binary.dat', Buffer.from([0, 1, 2])); f.write('empty', '');
  renameSync(join(f.dir, 'rename.txt'), join(f.dir, 'renamed.txt')); symlinkSync('a.txt', join(f.dir, 'link'));
  f.git('add', '-A'); f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},submodule`);
  f.git('commit', '-m', 'File changes'); f.ledger.set(f.git('rev-parse', 'HEAD'), 'P1');
  f.git('config', 'diff.ignoreSubmodules', 'all');
  const cards = f.segments().filter(s => s.kind === 'file');
  expect(cards.map(s => s.path).sort()).toEqual(['a.txt', 'binary.dat', 'empty', 'link', 'renamed.txt', 'submodule']);
  expect(cards.every(s => s.row === 'P1')).toBe(true);
  expect(cards.find(s => s.path === 'renamed.txt')?.oldPath).toBe('rename.txt');
});
it('handles filenames with spaces and pathspec characters literally', () => {
  const f = fixture({ 'a [1].txt': 'old\n' }); f.write('a [1].txt', 'new\n'); f.commit('P1');
  expect(f.segments().every(s => s.path === 'a [1].txt')).toBe(true);
});
it('rejects a merge history rather than inventing attribution', () => {
  const f = fixture(); f.git('switch', '-c', 'side'); f.write('side', 'side'); f.commit('P1'); f.git('switch', 'main');
  f.write('main', 'main'); f.commit('P2'); f.git('merge', '--no-ff', 'side', '-m', 'merge');
  expect(() => f.segments()).toThrow(/linear/);
});
it('keeps approvals after a clean rebase and remapped ledger, but stales changed checks and dependents', () => {
  const f = fixture(); f.git('switch', '-c', 'feature'); f.write('a.txt', 'one\nTWO\nthree\n'); const oldSha = f.commit('P1');
  const parts = f.segments(); const approvals = [approveItem(f.plan, parts, 'P1'), approveItem(f.plan, parts, 'P2', true)];
  f.git('switch', 'main'); f.write('unrelated', 'base update'); const newBase = f.commit(); f.git('switch', 'feature'); f.git('rebase', 'main');
  const newSha = f.git('rev-parse', 'HEAD'); f.ledger.delete(oldSha); f.ledger.set(newSha, 'P1');
  const rebased = linkHistory(f.plan, readHistory(f.dir, newBase), f.ledger);
  expect(approvalStates(f.plan, rebased, approvals)).toEqual({ P1: 'approved', P2: 'approved' });
  f.plan.items[1]!.depends_on = ['P1']; const p2 = approveItem(f.plan, rebased, 'P2', true);
  f.plan.items[0]!.acceptance[0]!.text = 'Different check';
  expect(approvalStates(f.plan, rebased, [approvals[0]!, p2])).toEqual({ P1: 'stale', P2: 'stale' });
});
it('stales whitespace and function-context changes, but not line numbers', () => {
  const f = fixture(); f.write('a.txt', 'one\nTWO\nthree\n'); f.commit('P1');
  const parts = f.segments(); const approval = approveItem(f.plan, parts, 'P1');
  const shifted = parts.map(s => ({ ...s, oldLine: s.oldLine === null ? null : s.oldLine + 20, newLine: s.newLine === null ? null : s.newLine + 20 }));
  expect(approvalStates(f.plan, shifted, [approval]).P1).toBe('approved');
  expect(approvalStates(f.plan, parts.map(s => ({ ...s, content: s.content + ' ' })), [approval]).P1).toBe('stale');
  expect(approvalStates(f.plan, parts.map(s => ({ ...s, context: 'other function' })), [approval]).P1).toBe('stale');
});
it('assignments stale the target and duplicate-copy count changes invalidate choices', () => {
  const f = fixture(); f.write('a.txt', 'one\nTWO\nthree\n'); f.commit(); const parts = f.segments();
  const approval = approveItem(f.plan, parts, 'P1', true);
  const choice = { key: choiceKeys(parts)[0]!, action: 'assign' as const, item: 'P1' };
  expect(approvalStates(f.plan, applyChoices(f.plan, parts, [choice]), [approval]).P1).toBe('stale');
  const copies = [parts[0]!, { ...parts[0]!, oldLine: 20 }];
  const accepted = { key: choiceKeys(copies)[0]!, action: 'accept' as const, item: null };
  expect(applyChoices(f.plan, copies, [accepted])[0]!.row).toBe('Accepted');
  expect(applyChoices(f.plan, [copies[1]!], [accepted])[0]!.row).toBe('Unplanned');
  const shifted = parts.map(s => ({ ...s, newLine: 50 }));
  expect(applyChoices(f.plan, shifted, [choice])[0]!.row).toBe('P1');
});
it('retains line ancestry through a rename and subsequent edit', () => {
  const f = fixture(); f.write('a.txt', 'ONE\ntwo\nthree\n'); f.commit('P1');
  renameSync(join(f.dir, 'a.txt'), join(f.dir, 'b.txt')); f.commit('P1');
  f.write('b.txt', 'FIRST\ntwo\nthree\n'); f.commit('P2');
  const parts = f.segments();
  expect(parts.find(s => s.content === 'FIRST\n')?.owners).toEqual(['P1', 'P2']);
  expect(parts.some(s => s.kind === 'file')).toBe(true);
});
it('keeps separated changes as separate segments and preserves EOF changes', () => {
  const f = fixture(); f.write('a.txt', 'ONE\ntwo\nTHREE'); f.commit('P1');
  const additions = f.segments().filter(s => s.operation === '+');
  expect(additions.map(s => s.content)).toEqual(['ONE\n', 'THREE']);
  expect(additions.map(s => s.newLine)).toEqual([1, 3]);
});
it('reads real function context from Git hunk headers', () => {
  const f = fixture({ 'a.py': 'def first():\n    return 1\n\ndef second():\n    return 2\n' });
  f.write('a.py', 'def first():\n    return 3\n\ndef second():\n    return 2\n'); f.commit('P1');
  expect(f.segments().find(s => s.operation === '+')?.context).toBe('def first():');
});
it('attributes unchanged moved lines when final rename detection is lost', () => {
  const f = fixture({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' });
  renameSync(join(f.dir, 'a.txt'), join(f.dir, 'b.txt')); f.commit('P1');
  f.write('b.txt', 'one\nnew2\nnew3\nnew4\nnew5\n'); f.commit('P2');
  const parts = f.segments();
  expect(parts.filter(s => s.kind === 'text').every(s => s.row !== 'Unplanned')).toBe(true);
});
it('does not hide a UTF-8 byte-order-mark-only change', () => {
  const f = fixture(); f.write('a.txt', '\uFEFFone\ntwo\nthree\n'); f.commit('P1');
  expect(f.segments().some(s => s.operation === '+' && s.content.startsWith('\uFEFF'))).toBe(true);
});
it('reads the whole repository even when called from a subdirectory with relative diffs configured', () => {
  const f = fixture({ 'a.txt': 'before\n', 'sub/b.txt': 'before\n' });
  f.write('a.txt', 'after\n'); f.write('sub/b.txt', 'after\n'); f.commit('P1');
  f.git('config', 'diff.relative', 'true');
  const parts = linkHistory(f.plan, readHistory(join(f.dir, 'sub'), f.base), f.ledger);
  expect(new Set(parts.map(s => s.path))).toEqual(new Set(['a.txt', 'sub/b.txt']));
});
it('checks scope at each owning commit, not against both ends of a final rename', () => {
  const f = fixture();
  f.plan.items[0]!.files = [{ path: 'b.txt', kind: 'rename', renamed_from: 'a.txt', change: 'Move' }];
  f.plan.items[1]!.files = [{ path: 'b.txt', kind: 'edit', renamed_from: null, change: 'Edit new name' }];
  renameSync(join(f.dir, 'a.txt'), join(f.dir, 'b.txt')); f.commit('P1');
  f.write('b.txt', 'ONE\ntwo\nthree\n'); f.commit('P2');
  expect(f.segments().some(s => s.row === 'P2')).toBe(true);
  expect(f.segments().filter(s => s.row === 'P2').every(s => s.scope === 'in-scope')).toBe(true);
  // Declaring only the old name must not authorize edits to the new one.
  f.plan.items[1]!.files[0]!.path = 'a.txt';
  expect(f.segments().filter(s => s.row === 'P2').every(s => s.scope === 'out-of-scope')).toBe(true);
});
it('checks scope of deletion after a rename using the deleted current path', () => {
  const f = fixture(); f.plan.items[0]!.files = [{ path: 'b.txt', kind: 'rename', renamed_from: 'a.txt', change: 'Move' }];
  f.plan.items[1]!.files = [{ path: 'b.txt', kind: 'delete', renamed_from: null, change: 'Delete' }];
  renameSync(join(f.dir, 'a.txt'), join(f.dir, 'b.txt')); f.commit('P1');
  rmSync(join(f.dir, 'b.txt')); f.commit('P2');
  expect(f.segments().some(s => s.row === 'P2')).toBe(true);
  expect(f.segments().filter(s => s.row === 'P2').every(s => s.scope === 'in-scope')).toBe(true);
});

it('Git built-ins cannot be overridden by repository shell aliases', () => {
  const f = fixture(); f.write('a.txt', 'changed\n'); f.commit('P1');
  for (const name of ['rev-parse', 'rev-list', 'diff', 'cat-file']) f.git('config', `alias.${name}`, '!touch alias-executed');
  expect(f.segments().length).toBeGreaterThan(0);
  expect(existsSync(join(f.dir, 'alias-executed'))).toBe(false);
});
it('isolates repository selection from inherited Git environment variables', () => {
  const expected = fixture(); expected.write('a.txt', 'expected repo\n'); expected.commit('P1');
  const foreign = fixture(); foreign.write('a.txt', 'foreign repo\n'); foreign.commit();
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(foreign.dir, '.git');
    const history = readHistory(expected.dir, 'HEAD~1');
    expect(history.final[0]!.after!.text).toBe('expected repo\n');
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
  }
});

it('rejects repository-local object alternates before reading borrowed history', () => {
  const source = fixture(); source.write('a.txt', 'borrowed content\n'); source.commit();
  const borrower = fixture();
  writeFileSync(join(borrower.dir, '.git/objects/info/alternates'), join(source.dir, '.git/objects') + '\n');
  expect(() => readHistory(borrower.dir, source.base, source.git('rev-parse', 'HEAD'))).toThrow(/alternates/i);
});
it('keeps a foreign rename on its file card while attributing later text edits', () => {
  const f = fixture();
  renameSync(join(f.dir, 'a.txt'), join(f.dir, 'b.txt')); f.commit();
  f.plan.items[1]!.files[0]!.path = 'b.txt';
  f.write('b.txt', 'ONE\ntwo\nthree\n'); f.commit('P2');
  const parts = f.segments();
  expect(parts.find(s => s.kind === 'file')?.row).toBe('Unplanned');
  const text = parts.filter(s => s.kind === 'text');
  expect(text.length).toBeGreaterThan(0);
  expect(text.every(s => s.row === 'P2' && s.scope === 'in-scope')).toBe(true);
});

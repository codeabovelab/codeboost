import { describe, expect, it } from 'vitest';
import { auditRun, type ChangeManifest, type ManifestChange } from '../core/run-audit.ts';
import type { PlanItem } from '../core/plan.ts';

const item: PlanItem = { id: 'P1', title: 'T', intent: 'I', depends_on: [], acceptance: [], files: [
  { path: 'src/retry.ts', kind: 'edit', renamed_from: null, change: 'x' },
  { path: 'docs/New.md', kind: 'rename', renamed_from: 'docs/old.md', change: 'x' },
  { path: 'link', kind: 'edit', renamed_from: null, change: 'retarget the link' },
] };
const manifest = (changes: ManifestChange[], over: Partial<ChangeManifest> = {}): ChangeManifest =>
  ({ changes, agentCommits: [], metadataChanged: false, linkTargetChanges: [], nestedGitlinkContent: [], ...over });
const file = (path: string, over: Partial<ManifestChange> = {}): ManifestChange => ({ path, kind: 'modify', oldType: 'file', newType: 'file', underGit: false, ...over });
const exact = (p: string) => p, folded = (p: string) => p.toLowerCase();

describe('post-run audit', () => {
  it('commits declared changes and treats undeclared regular files as out of scope that needs amendment', () => {
    expect(auditRun(item, manifest([file('src/retry.ts'), file('docs/New.md', { kind: 'rename', oldPath: 'docs/old.md' })]), exact))
      .toEqual({ kind: 'commit', inScope: ['src/retry.ts', 'docs/New.md'], outOfScope: [], unchanged: false, needsAmendment: false });
    expect(auditRun(item, manifest([file('src/retry.ts'), file('src/extra.ts', { kind: 'add', oldType: undefined })]), exact))
      .toMatchObject({ kind: 'commit', outOfScope: ['src/extra.ts'], needsAmendment: true });
    // Both sides of a rename are findings when neither is declared.
    expect(auditRun(item, manifest([file('x.ts', { kind: 'rename', oldPath: 'y.ts' })]), exact)).toMatchObject({ kind: 'commit', outOfScope: ['x.ts', 'y.ts'] });
    // The undeclared source is the finding, not the declared destination.
    expect(auditRun(item, manifest([file('docs/New.md', { kind: 'rename', oldPath: 'docs/unlisted.md' })]), exact))
      .toMatchObject({ kind: 'commit', inScope: [], outOfScope: ['docs/unlisted.md'] });
  });
  it('reports planned-but-unchanged, and uses the trusted path identity', () => {
    expect(auditRun(item, manifest([]), exact)).toMatchObject({ kind: 'commit', unchanged: true });
    expect(auditRun(item, manifest([file('SRC/Retry.ts')]), folded)).toMatchObject({ inScope: ['SRC/Retry.ts'] });
    expect(auditRun(item, manifest([file('SRC/Retry.ts')]), exact)).toMatchObject({ outOfScope: ['SRC/Retry.ts'] });
  });
  it('treats any agent commit as a safety violation, even with no file changes (#66: never undone)', () => {
    expect(auditRun(item, manifest([], { agentCommits: ['abc'] }), exact)).toEqual({ kind: 'violation', violations: ['The agent made its own commits: "abc".'] });
    for (const field of ['agentCommits', 'linkTargetChanges', 'nestedGitlinkContent'] as const)
      expect(auditRun(item, manifest([file('src/retry.ts')], { [field]: undefined as unknown as string[] }), exact)).toEqual({ kind: 'violation', violations: [`The change report has no ${field} list.`] });
  });
  it('fails closed on a partial record: every field the audit reads must be present and well-formed', () => {
    const cases: [string, ChangeManifest, RegExp][] = [
      ['no metadata flag', manifest([file('src/retry.ts')], { metadataChanged: undefined as unknown as boolean }), /whether Git metadata changed/],
      ['no underGit', manifest([{ path: 'src/retry.ts', kind: 'modify', oldType: 'file', newType: 'file' } as ManifestChange]), /under \.git/],
      ['add without a new type', manifest([{ path: 'src/new.ts', kind: 'add', underGit: false } as ManifestChange]), /invalid new entry type/],
      ['modify without an old type', manifest([file('src/retry.ts', { oldType: undefined })]), /invalid old entry type/],
      ['unknown kind', manifest([file('src/retry.ts', { kind: 'chmod' as ManifestChange['kind'] })]), /unknown kind/],
      ['rename without an old path', manifest([file('docs/New.md', { kind: 'rename' })]), /invalid old path/],
      ['old path on a modify', manifest([file('src/retry.ts', { oldPath: 'src/other.ts' })]), /invalid old path/],
      ['non-string old path', manifest([file('docs/New.md', { kind: 'rename', oldPath: 7 as unknown as string })]), /invalid old path/],
      ['delete with a new type', manifest([file('src/retry.ts', { kind: 'delete' })]), /invalid new entry type/],
      ['add with an old type', manifest([file('src/new.ts', { kind: 'add' })]), /invalid old entry type/],
      ['non-boolean traversal flag', manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: 'x', linkTargetTraversesLink: 'no' as unknown as boolean })]), /traversal flag/],
      ['non-string list entry', manifest([file('src/retry.ts')], { nestedGitlinkContent: [{ path: 'm' }] as unknown as string[] }), /no nestedGitlinkContent list/],
      ['link without a target', manifest([file('link', { oldType: 'symlink', newType: 'symlink' })]), /has no target/],
      ['too many path bytes', manifest(Array.from({ length: 600 }, (_, i) => file(`${'x'.repeat(1000)}${i}`))), /too large/],
    ];
    for (const [label, report, reason] of cases) {
      const outcome = auditRun(item, report, exact);
      expect(outcome.kind, label).toBe('violation');
      expect((outcome as { violations: string[] }).violations.join(' '), label).toMatch(reason);
    }
  });
  it('refuses a report that lists one path twice', () => {
    expect(auditRun(item, manifest([file('src/retry.ts'), file('src/retry.ts', { kind: 'delete', newType: undefined })]), exact))
      .toEqual({ kind: 'violation', violations: ['The change report lists "src/retry.ts" more than once.'] });
    expect(auditRun(item, manifest([file('docs/New.md', { kind: 'rename', oldPath: 'docs/old.md' }), file('docs/old.md')]), exact)).toMatchObject({ kind: 'violation' });
  });
  it('refuses a declared link retargeted into .git in any case or at any depth', () => {
    for (const target of ['.GIT/config', '.Git', 'vendor/.git/hooks', 'sub/.GiT'])
      expect(auditRun(item, manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: target, linkTargetTraversesLink: false })]), exact), target)
        .toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": target enters .git.'] });
  });
  it('refuses removing, replacing or renaming a pre-existing symlink from an undeclared path, and allows it at a declared one', () => {
    for (const change of [file('lnk', { kind: 'delete', oldType: 'symlink', newType: undefined }), file('lnk', { oldType: 'symlink', newType: 'file' })])
      expect(auditRun(item, manifest([change]), exact)).toEqual({ kind: 'violation', violations: ['A pre-existing symlink was changed at an undeclared path: "lnk".'] });
    expect(auditRun(item, manifest([file('link', { kind: 'rename', oldPath: 'lnk', oldType: 'symlink', newType: 'symlink', newLinkTarget: 'src/retry.ts', linkTargetTraversesLink: false })]), exact))
      .toEqual({ kind: 'violation', violations: ['A pre-existing symlink was changed at an undeclared path: "lnk".'] });
    expect(auditRun(item, manifest([file('link', { kind: 'delete', oldType: 'symlink', newType: undefined })]), exact)).toMatchObject({ kind: 'commit', inScope: ['link'] });
  });
  it('refuses every spelling Git treats as .git, in paths and link targets', () => {
    for (const path of ['.git /config', '.git./hooks', 'GIT~1/config', 'sub/.g\u200cit/hooks/post-checkout', '.GIT\ufeff'])
      expect(auditRun(item, manifest([file(path)]), exact), path).toMatchObject({ kind: 'violation' });
    for (const target of ['.git.', 'GIT~1', '.g\u200dit/config'])
      expect(auditRun(item, manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: target, linkTargetTraversesLink: false })]), exact), target)
        .toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": target enters .git.'] });
    expect(auditRun(item, manifest([file('src/.github-notes.md', { kind: 'add', oldType: undefined })]), exact)).toMatchObject({ kind: 'commit' });
  });
  it('ends a name where NTFS does (a stream separator or a backslash) before comparing it with .git', () => {
    for (const path of ['.git:x', '.git::$INDEX_ALLOCATION/config', 'git~1:s', '.git\\config', 'GIT~1\\hooks', 'a/.g\u200eit', 'a/.g\u202ait', 'a/.g\u206bit', 'a/.gi\u200ft'])
      expect(auditRun(item, manifest([file(path, { kind: 'add', oldType: undefined })]), exact), path).toMatchObject({ kind: 'violation' });
  });
  it('reads a backslash as a directory separator when looking for .git', () => {
    for (const path of ['x\\.git\\hooks\\post-checkout', 'a/b\\.GIT'])
      expect(auditRun(item, manifest([file(path, { kind: 'add', oldType: undefined })]), exact), path).toMatchObject({ kind: 'violation' });
  });
  it('refuses bad link targets: a Windows path form, .git cancelled by .., empty, or with a NUL', () => {
    const link = (target: string) => manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: target, linkTargetTraversesLink: false })]);
    for (const target of ['sub\\.git\\config', '..\\..\\outside', 'C:\\Windows', 'c:outside'])
      expect(auditRun(item, link(target), exact), target).toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": target uses a Windows path form.'] });
    expect(auditRun(item, link('.git/../src/retry.ts'), exact)).toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": target enters .git.'] });
    for (const target of ['', 'src/re\0try.ts'])
      expect(auditRun(item, link(target), exact), JSON.stringify(target)).toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": empty or invalid target.'] });
  });
  it('refuses a NUL in a path, and a directory, other or gitlink old entry', () => {
    expect(auditRun(item, manifest([file('src/re\0try.ts')]), exact)).toMatchObject({ kind: 'violation' });
    expect(auditRun(item, manifest([file('build', { kind: 'delete', oldType: 'directory', newType: undefined })]), exact))
      .toEqual({ kind: 'violation', violations: ['Unexpected directory entry: "build".'] });
    expect(auditRun(item, manifest([file('fifo', { kind: 'delete', oldType: 'other', newType: undefined })]), exact))
      .toEqual({ kind: 'violation', violations: ['Unexpected other entry: "fifo".'] });
    expect(auditRun(item, manifest([file('vendor/lib', { kind: 'delete', oldType: 'gitlink', newType: undefined })]), exact))
      .toEqual({ kind: 'violation', violations: ['Plan items cannot change gitlinks: "vendor/lib".'] });
  });
  it('covers the whole HFS ignorable ranges, and cuts a quoted path at 300 characters', () => {
    for (const mark of ['\u200c', '\u200f', '\u202a', '\u202e', '\u206a', '\u206f', '\ufeff'])
      expect(auditRun(item, manifest([file(`a/.gi${mark}t`, { kind: 'add', oldType: undefined })]), exact), JSON.stringify(mark)).toMatchObject({ kind: 'violation' });
    const long = `${'x'.repeat(400)}/.git`;
    const outcome = auditRun(item, manifest([file(long, { kind: 'add', oldType: undefined })]), exact) as { violations: string[] };
    expect(outcome.violations[0]).toBe(`The agent changed ${JSON.stringify(`${long.slice(0, 300)}…`)} under .git.`);
  });
  it('trusts D\'s underGit flag on its own', () => {
    expect(auditRun(item, manifest([file('src/retry.ts', { underGit: true })]), exact)).toEqual({ kind: 'violation', violations: ['The agent changed "src/retry.ts" under .git.'] });
  });
  it('refuses a declared link retargeted to the repository root', () => {
    for (const target of ['.', './', 'a/..'])
      expect(auditRun(item, manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: target, linkTargetTraversesLink: false })]), exact), target)
        .toEqual({ kind: 'violation', violations: ['Unsafe symlink target at "link": target is the repository root.'] });
  });
  it('refuses a declared link renamed to an undeclared path, a directory entry, and an absolute path', () => {
    expect(auditRun(item, manifest([file('lnk2', { kind: 'rename', oldPath: 'link', oldType: 'symlink', newType: 'symlink', newLinkTarget: 'src/retry.ts', linkTargetTraversesLink: false })]), exact))
      .toEqual({ kind: 'violation', violations: ['A pre-existing symlink changed at an undeclared path: "lnk2".'] });
    expect(auditRun(item, manifest([file('build', { kind: 'add', oldType: undefined, newType: 'directory' })]), exact))
      .toEqual({ kind: 'violation', violations: ['Unexpected directory entry: "build".'] });
    expect(auditRun(item, manifest([file('/etc/passwd', { kind: 'add', oldType: undefined })]), exact))
      .toEqual({ kind: 'violation', violations: ['Invalid path in the change report: "/etc/passwd".'] });
  });
  it('counts a case-only rename once under a case-folding identity, whether reported as a rename or as a delete and an add', () => {
    const renamed: PlanItem = { ...item, files: [{ path: 'README.md', kind: 'rename', renamed_from: 'Readme.md', change: 'x' }] };
    expect(auditRun(renamed, manifest([file('README.md', { kind: 'rename', oldPath: 'Readme.md' })]), folded)).toMatchObject({ kind: 'commit', inScope: ['README.md'] });
    const split = manifest([file('Readme.md', { kind: 'delete', newType: undefined }), file('README.md', { kind: 'add', oldType: undefined })]);
    expect(auditRun(renamed, split, folded)).toMatchObject({ kind: 'commit', inScope: ['Readme.md', 'README.md'], outOfScope: [] });
    // Undeclared, the same pair is a scope finding, not a safety violation; two adds of one folded path are still refused.
    expect(auditRun(item, manifest([file('notes', { kind: 'delete', newType: undefined }), file('NOTES', { kind: 'add', oldType: undefined })]), folded)).toMatchObject({ kind: 'commit', outOfScope: ['notes', 'NOTES'] });
    expect(auditRun(item, manifest([file('notes', { kind: 'add', oldType: undefined }), file('NOTES', { kind: 'add', oldType: undefined })]), folded)).toMatchObject({ kind: 'violation' });
    // Only one delete and one add, with different spellings and no rename entry, make a split rename.
    const add = (path: string) => file(path, { kind: 'add', oldType: undefined }), del = (path: string) => file(path, { kind: 'delete', newType: undefined });
    for (const [label, changes] of [
      ['add, delete, add', [add('src/aB.ts'), del('src/Ab.ts'), add('src/ab.ts')]],
      ['delete, add, delete, add', [del('src/Ab.ts'), add('src/aB.ts'), del('src/AB.ts'), add('src/ab.ts')]],
      ['delete and add of one spelling', [del('src/ab.ts'), add('src/ab.ts')]],
      ['a rename and an add', [file('src/ab.ts', { kind: 'rename', oldPath: 'src/x.ts' }), add('src/AB.ts')]],
    ] as [string, ManifestChange[]][])
      expect(auditRun(item, manifest(changes), folded), label).toMatchObject({ kind: 'violation' });
  });
  it('counts two spellings of one path under a case-folding identity as a duplicate', () => {
    expect(auditRun(item, manifest([file('SRC/Retry.ts'), file('src/retry.ts')]), folded)).toMatchObject({ kind: 'violation' });
    expect(auditRun(item, manifest([file('SRC/Retry.ts'), file('src/retry.ts')]), exact)).toMatchObject({ kind: 'commit' });
  });
  it('quotes agent-controlled paths in findings and cuts long lists short', () => {
    const outcome = auditRun(item, manifest([file('src/retry.ts')], { nestedGitlinkContent: ['a', 'b', 'c', 'd', 'e', 'f', 'g"; rm -rf /'] }), exact);
    expect(outcome).toEqual({ kind: 'violation', violations: ['Content appeared under a gitlink: "a", "b", "c", "d", "e" and 2 more.'] });
  });
  it('refuses a change path of . or .., any non-canonical spelling, and .git in any case at any depth', () => {
    for (const path of ['..', '.', 'a/../..', 'x/../.git/hooks/pre-commit', './.git/config', './a.ts', 'a//b', 'dir/', 'sub/.git/config', '.GIT/config', 'src/.Git'])
      expect(auditRun(item, manifest([file(path)]), exact), path).toMatchObject({ kind: 'violation' });
    expect(auditRun(item, manifest([file('docs/New.md', { kind: 'rename', oldPath: 'x/../.git/config' })]), exact)).toMatchObject({ kind: 'violation' });
  });
  it('limits the saved paths as JSON, a rename\'s old path included (an undeclared one is saved as the finding)', () => {
    // 100 paths of 4,000 control characters are under the raw byte cap but about 2.4 MB as JSON.
    expect(auditRun(item, manifest(Array.from({ length: 100 }, (_, i) => file(`${'\u0001'.repeat(4000)}${i}`, { kind: 'add', oldType: undefined }))), exact))
      .toEqual({ kind: 'violation', violations: ['The change report is too large to audit.'] });
    expect(auditRun(item, manifest([file('docs/New.md', { kind: 'rename', oldPath: `docs/${'o'.repeat(600_000)}.md` })]), exact))
      .toEqual({ kind: 'violation', violations: ['The change report is too large to audit.'] });
  });
  it('stops on every safety violation before any scope decision', () => {
    const cases: [string, ChangeManifest][] = [
      ['metadata', manifest([file('src/retry.ts')], { metadataChanged: true })],
      ['under .git', manifest([file('.git/hooks/pre-commit', { underGit: true })])],
      ['link target changed', manifest([], { linkTargetChanges: ['target/file'] })],
      ['gitlink content', manifest([], { nestedGitlinkContent: ['vendor/lib/x'] })],
      ['new gitlink', manifest([file('vendor/lib', { kind: 'add', oldType: undefined, newType: 'gitlink' })])],
      ['new symlink', manifest([file('src/retry.ts', { newType: 'symlink', newLinkTarget: 'other.ts', linkTargetTraversesLink: false })])],
      ['added symlink', manifest([file('new-link', { kind: 'add', oldType: undefined, newType: 'symlink', newLinkTarget: 'x', linkTargetTraversesLink: false })])],
      ['undeclared link change', manifest([file('other-link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: 'x', linkTargetTraversesLink: false })])],
      ['absolute target', manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: '/etc/passwd', linkTargetTraversesLink: false })])],
      ['escaping target', manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: '../../outside', linkTargetTraversesLink: false })])],
      ['target into .git', manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: '.git/config', linkTargetTraversesLink: false })])],
      ['traversal unknown', manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: 'src/retry.ts' })])],
      ['fifo', manifest([file('src/pipe', { kind: 'add', oldType: undefined, newType: 'other' })])],
      ['bad path', manifest([file('../escape.ts')])],
      ['too many changes', manifest(Array.from({ length: 10_001 }, (_, i) => file(`f${i}`)))],
    ];
    for (const [name, value] of cases) expect(auditRun(item, value, exact).kind, name).toBe('violation');
  });
  it('lets a declared pre-existing link change to a safe target', () => {
    expect(auditRun(item, manifest([file('link', { oldType: 'symlink', newType: 'symlink', newLinkTarget: 'src/retry.ts', linkTargetTraversesLink: false })]), exact))
      .toMatchObject({ kind: 'commit', inScope: ['link'] });
  });
  it('never lets an unsafe change slip into the out-of-scope commit path', () => {
    const outcome = auditRun(item, manifest([file('src/extra.ts', { kind: 'add', oldType: undefined }), file('x', { kind: 'add', oldType: undefined, newType: 'symlink', newLinkTarget: 'y', linkTargetTraversesLink: false })]), exact);
    expect(outcome.kind).toBe('violation');
  });
});

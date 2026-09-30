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
    expect(auditRun(item, manifest([file('docs/New.md', { kind: 'rename', oldPath: 'docs/unlisted.md' })]), exact))
      .toMatchObject({ kind: 'commit', outOfScope: ['docs/New.md'] });
  });
  it('reports planned-but-unchanged, and uses the trusted path identity', () => {
    expect(auditRun(item, manifest([]), exact)).toMatchObject({ kind: 'commit', unchanged: true });
    expect(auditRun(item, manifest([file('SRC/Retry.ts')]), folded)).toMatchObject({ inScope: ['SRC/Retry.ts'] });
    expect(auditRun(item, manifest([file('SRC/Retry.ts')]), exact)).toMatchObject({ outOfScope: ['SRC/Retry.ts'] });
  });
  it('treats any agent commit as a safety violation, even with no file changes (#66: never undone)', () => {
    expect(auditRun(item, manifest([], { agentCommits: ['abc'] }), exact)).toEqual({ kind: 'violation', violations: ['The agent made its own commits: abc.'] });
    expect(auditRun(item, manifest([file('src/retry.ts')], { agentCommits: undefined as unknown as string[] }), exact)).toMatchObject({ kind: 'violation' });
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

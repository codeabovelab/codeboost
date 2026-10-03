import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureGit as git } from './fixtures/git.ts';
import { attemptRef, dropAttemptRef, ensureCommit, fetchTaskCommit, openRunnerRepository } from '../runner/runner-repository.ts';

const OWNER = '0123456789abcdef0123456789abcdef';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'runner-repo-')); roots.push(root);
  const source = join(root, 'source'), runnerRoot = join(root, 'runner');
  git(root, 'init', '-q', source); git(source, 'config', 'user.name', 'T'); git(source, 'config', 'user.email', 't@e');
  writeFileSync(join(source, 'a.txt'), 'a\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  return { root, source, runnerRoot, base };
}
/** What `commitTaskChanges` returns: a bundle of one commit on `base`, its one ref `refs/heads/codeboost`. */
function bundleOf(s: ReturnType<typeof setup>, commits = 1, ref = 'refs/heads/codeboost') {
  const work = join(s.root, `work-${randomUUID()}`);
  git(s.root, '-c', 'protocol.file.allow=always', 'clone', '-q', s.source, work);
  git(work, 'config', 'user.name', 'R'); git(work, 'config', 'user.email', 'r@e');
  for (let i = 0; i < commits; i += 1) { writeFileSync(join(work, `n${i}.txt`), `${i}\n`); git(work, 'add', '.'); git(work, 'commit', '-qm', `c${i}`); }
  git(work, 'update-ref', ref, 'HEAD');
  const file = join(work, 'out.bundle');
  git(work, 'bundle', 'create', '-q', file, ref, `^${s.base}`);
  return { bundle: readFileSync(file), head: git(work, 'rev-parse', 'HEAD') };
}
const open = (s: ReturnType<typeof setup>) => openRunnerRepository({ runnerRoot: s.runnerRoot, runnerOwner: OWNER, repositoryId: 'repo-1', source: s.source });

describe('runner-owned repository', () => {
  it('is a bare repository of the runner\'s own, created once, and never writes the user\'s repository', async () => {
    const s = setup(), refsBefore = git(s.source, 'for-each-ref');
    const repo = await open(s);
    expect(repo.path.startsWith(join(s.runnerRoot, OWNER, 'repositories'))).toBe(true);
    expect(git(repo.path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect((await open(s)).path).toBe(repo.path);
    await ensureCommit(repo, s.base);
    expect(git(repo.path, 'cat-file', '-t', s.base)).toBe('commit');
    // Only the commit came over: no refs, tags or FETCH_HEAD.
    expect(git(repo.path, 'for-each-ref')).toBe('');
    expect(git(s.source, 'for-each-ref')).toBe(refsBefore);
    await expect(ensureCommit(repo, 'f'.repeat(40))).rejects.toThrow();
    await expect(ensureCommit(repo, 'HEAD')).rejects.toThrow('full commit ID');
  });

  it('refuses a repositories directory others can write', async () => {
    const s = setup();
    await open(s);
    // Each level, from the runner root down.
    for (const path of [s.runnerRoot, join(s.runnerRoot, OWNER), join(s.runnerRoot, OWNER, 'repositories')]) {
      chmodSync(path, 0o777);
      await expect(open(s)).rejects.toThrow(`${path} must be a directory owned by you`);
      chmodSync(path, 0o700);
    }
    expect((await open(s)).path).toContain(join(s.runnerRoot, OWNER, 'repositories'));
  });

  it('takes in exactly the runner commit, under the attempt\'s ref, and drops it when asked', async () => {
    const s = setup(), repo = await open(s), attemptId = randomUUID();
    await ensureCommit(repo, s.base);
    const { bundle, head } = bundleOf(s);
    await fetchTaskCommit(repo, { bundle, base: s.base, head, attemptId });
    expect(git(repo.path, 'rev-parse', attemptRef(attemptId))).toBe(head);
    // No bundle file is left beside the repository.
    expect(git(repo.path, 'for-each-ref', '--format=%(refname)')).toBe(attemptRef(attemptId));
    await dropAttemptRef(repo, attemptId);
    expect(git(repo.path, 'for-each-ref')).toBe('');
  });

  it('refuses a bundle that is not the runner commit: another head, more than one commit, another ref', async () => {
    const s = setup(), repo = await open(s);
    await ensureCommit(repo, s.base);
    const one = bundleOf(s), two = bundleOf(s, 2), named = bundleOf(s, 1, 'refs/heads/other');
    await expect(fetchTaskCommit(repo, { bundle: one.bundle, base: s.base, head: two.head, attemptId: randomUUID() }))
      .rejects.toThrow('does not hold exactly the runner commit');
    await expect(fetchTaskCommit(repo, { bundle: two.bundle, base: s.base, head: two.head, attemptId: randomUUID() }))
      .rejects.toThrow('not a single commit on top of its base');
    expect(git(repo.path, 'for-each-ref')).toBe('');
    await expect(fetchTaskCommit(repo, { bundle: named.bundle, base: s.base, head: named.head, attemptId: randomUUID() }))
      .rejects.toThrow('does not hold exactly the runner commit');
    await expect(fetchTaskCommit(repo, { bundle: Buffer.from('not a bundle'), base: s.base, head: one.head, attemptId: randomUUID() }))
      .rejects.toThrow('bundle');
    await expect(fetchTaskCommit(repo, { ...one, base: s.base, attemptId: 'not-a-uuid' })).rejects.toThrow('UUID');
  });
});

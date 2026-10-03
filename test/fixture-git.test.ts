import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureGit } from './fixtures/git.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-fixture-git-')); roots.push(root);
  const inside = join(root, 'inside'), outside = join(root, 'outside');
  for (const path of [inside, outside]) { fixtureGit(root, 'init', '-q', '-b', 'main', path); fixtureGit(path, 'config', 'user.name', 'Fixture'); fixtureGit(path, 'config', 'user.email', 'fixture@example.invalid'); }
  return { inside, outside };
}
it('ignores inherited Git variables and user or system config, so a commit stays in the fixture', () => {
  const { inside, outside } = repository();
  // An alias is set nowhere else, so running it succeeds only if the inherited config file was read.
  const inherited = join(inside, '..', 'inherited.gitconfig'); writeFileSync(inherited, '[alias]\n\tinherited = rev-parse --git-dir\n');
  vi.stubEnv('GIT_DIR', join(outside, '.git')); vi.stubEnv('GIT_WORK_TREE', outside); vi.stubEnv('GIT_AUTHOR_NAME', 'Inherited');
  vi.stubEnv('GIT_CONFIG_GLOBAL', inherited); vi.stubEnv('GIT_CONFIG_SYSTEM', inherited); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  writeFileSync(join(inside, 'file.txt'), 'x\n'); fixtureGit(inside, 'add', 'file.txt'); fixtureGit(inside, 'commit', '-q', '-m', 'Inside');
  expect(fixtureGit(inside, 'log', '-1', '--format=%an %s')).toBe('Fixture Inside');
  expect(() => fixtureGit(inside, 'inherited')).toThrow(/not a git command/);
  vi.unstubAllEnvs();
  expect(() => fixtureGit(outside, 'rev-parse', '--verify', 'HEAD')).toThrow();
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitEnvironment } from '../scripts/git-environment.ts';
import { createDemo } from '../scripts/demo.ts';
import { fixtureGit } from './fixtures/git.ts';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function root() { const path = mkdtempSync(join(tmpdir(), 'codeboost-demo-')); roots.push(path); return path; }
it('rejects existing demo configs redirected outside their fixture', () => {
  const base = root(), directory = join(base, 'demo'), config = createDemo(directory);
  expect(createDemo(directory)).toEqual(config);
  for (const key of ['repository', 'database'] as const) {
    writeFileSync(join(directory, 'review.json'), JSON.stringify({ ...config, [key]: join(base, 'outside') }));
    expect(() => createDemo(directory)).toThrow(/fixture/i);
  }
});
it('rejects symlinked demo roots, configs, repositories and databases', () => {
  const base = root(), directory = join(base, 'demo'); createDemo(directory);
  symlinkSync(directory, join(base, 'alias'));
  expect(() => createDemo(join(base, 'alias'))).toThrow(/fixture/i);
  for (const name of ['review.json', 'retry-service', 'review.sqlite']) {
    const path = join(directory, name), backup = join(base, name);
    // Move each object out of the fixture and replace it with a symlink.
    renameSync(path, backup); symlinkSync(backup, path);
    expect(() => createDemo(directory)).toThrow(/fixture/i);
    rmSync(path); renameSync(backup, path);
  }
});
it('ignores inherited Git repository and config environment in demo commands', () => {
  const base = root();
  vi.stubEnv('GIT_DIR', join(base, 'outside.git'));
  vi.stubEnv('GIT_WORK_TREE', join(base, 'outside'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'init.defaultBranch');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'inherited');
  const config = createDemo(join(base, 'demo'));
  expect(readFileSync(join(config.repository, 'retry.ts'), 'utf8')).toContain('Math.min');
});

it('passes only allowlisted variables to demo Git, whatever the inherited names', () => {
  vi.stubEnv('git_dir', '/outside'); vi.stubEnv('Git_Work_Tree', '/outside'); vi.stubEnv('HOME', '/outside'); vi.stubEnv('XDG_CONFIG_HOME', '/outside');
  expect(Object.keys(hardenedGitEnvironment()).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT', 'PATH']);
});
it('ignores inherited user Git ignore files outside the GIT_ namespace in demo commands', () => {
  const base = root(), home = join(base, 'home'); mkdirSync(join(home, 'git'), { recursive: true });
  writeFileSync(join(home, 'git', 'ignore'), '*.ts\n*.log\n');
  vi.stubEnv('XDG_CONFIG_HOME', home); vi.stubEnv('HOME', base);
  const config = createDemo(join(base, 'demo'));
  expect(fixtureGit(config.repository, 'ls-tree', '--name-only', 'HEAD').split('\n')).toEqual(expect.arrayContaining(['retry.ts', 'debug.log']));
});
it('rejects symlinked ancestors before creating a demo', () => {
  const base = root(); symlinkSync(base, join(base, 'alias'));
  expect(() => createDemo(join(base, 'alias', 'nested', 'demo'))).toThrow(/fixture/i);
});
it('rejects dangling SQLite sidecar symlinks', () => {
 const base=root(),directory=join(base,'demo');const config=createDemo(directory);
 for(const suffix of ['-wal','-shm']) {
   const path=config.database+suffix;rmSync(path,{force:true});symlinkSync(join(base,'missing'+suffix),path);
   expect(()=>createDemo(directory)).toThrow(/fixture/i);rmSync(path);
 }
});

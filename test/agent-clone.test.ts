import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, lstatSync, symlinkSync, writeFileSync, renameSync, opendirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskClone } from '../git/clone.ts';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), opendirSync: vi.fn(actual.opendirSync) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clone-test-')); roots.push(root);
  const source = join(root, 'source'), parent = join(root, 'tasks');
  mkdirSync(source); mkdirSync(parent);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  return { source, parent, head: git(source, 'rev-parse', 'HEAD'), taskId: 'task-1' };
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('isolated staging clone', () => {
  it('copies objects, ignores dirty source changes, and has no origin or shared metadata', () => {
    const input = fixture();
    writeFileSync(join(input.source, 'file.txt'), 'uncommitted');
    const clone = createTaskClone(input);
    expect(readFileSync(join(clone.directory, 'file.txt'), 'utf8')).toBe('trusted\n');
    expect(lstatSync(join(clone.directory, '.git')).isDirectory()).toBe(true);
    expect(git(clone.directory, 'status', '--porcelain')).toBe('');
    expect(git(clone.directory, 'remote')).toBe('');
    const hash = git(input.source, 'rev-parse', 'HEAD:file.txt');
    const path = join('objects', hash.slice(0, 2), hash.slice(2));
    const sourceObject = join(input.source, '.git', path), cloneObject = join(clone.directory, '.git', path);
    const before = readFileSync(sourceObject);
    expect(lstatSync(cloneObject).nlink).toBe(1);
    expect(lstatSync(cloneObject).ino).not.toBe(lstatSync(sourceObject).ino);
    writeFileSync(cloneObject, 'corrupted disposable task object');
    expect(readFileSync(sourceObject)).toEqual(before);
    expect(git(input.source, 'cat-file', '-p', hash)).toBe('trusted');
  });
  it('supports linked-worktree sources but produces standalone metadata', () => {
    const input = fixture(), linked = join(input.parent, 'linked');
    git(input.source, 'worktree', 'add', '--detach', linked, input.head);
    const clone = createTaskClone({ ...input, source: linked });
    expect(lstatSync(join(clone.directory, '.git')).isDirectory()).toBe(true);
    expect(git(clone.directory, 'rev-parse', 'HEAD')).toBe(input.head);
  });
  it.each(['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'shallow'])('rejects %s before allocating a clone', name => {
    const input = fixture();
    writeFileSync(join(input.source, '.git', name), '');
    expect(() => createTaskClone(input)).toThrow('Unsupported Git storage');
    expect(readdirSync(input.parent)).toEqual([]);
  });
  it('rejects object symlinks and replacements', () => {
    const input = fixture();
    symlinkSync('/tmp', join(input.source, '.git/objects/linked'));
    expect(() => createTaskClone(input)).toThrow('object entry');
    rmSync(join(input.source, '.git/objects/linked'));
    git(input.source, 'update-ref', `refs/replace/${input.head}`, input.head);
    expect(() => createTaskClone(input)).toThrow('Replacement');
  });
  it('rejects nested storage, including paths through symlinks', () => {
    const input = fixture(), nested = join(input.source, 'tasks'), alias = join(input.parent, 'alias');
    mkdirSync(nested); symlinkSync(nested, alias);
    expect(() => createTaskClone({ ...input, parent: alias })).toThrow('outside');
  });
  it('requires a full existing commit and finite time budget', () => {
    const input = fixture();
    expect(() => createTaskClone({ ...input, head: 'HEAD' })).toThrow('full committed');
    expect(() => createTaskClone({ ...input, head: 'f'.repeat(40) })).toThrow();
    expect(() => createTaskClone({ ...input, timeoutMs: Infinity })).toThrow('deadline');
    expect(readdirSync(input.parent)).toEqual([]);
  });
  it('canonicalizes symlinked common metadata before checking storage containment', () => {
    const input = fixture(), metadata = join(input.parent, 'metadata');
    renameSync(join(input.source, '.git'), metadata);
    symlinkSync(metadata, join(input.source, '.git'));
    const parent = join(metadata, 'tasks'); mkdirSync(parent);
    // Disputed intermediate state: Git reports a lexical path through the link.
    expect(git(input.source, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(lstatSync(join(input.source, '.git')).isSymbolicLink()).toBe(true);
    expect(() => createTaskClone({ ...input, parent })).toThrow('outside source metadata');
    expect(readdirSync(parent)).toEqual([]);
  });
  it('never materializes an entire object directory before checking its entry budget', () => {
    const input = fixture();
    // A bulk enumeration is forbidden even for a small fixture; this asserts
    // the disputed intermediate representation, not only a later limit error.
    vi.mocked(readdirSync).mockClear();
    createTaskClone(input);
    expect(readdirSync).not.toHaveBeenCalled();
    expect(opendirSync).toHaveBeenCalled();
  });
  it('rejects a successful final Git call that returns after the overall deadline', async () => {
    const input = fixture();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let elapsed = 0, lateResult = false;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], options: object) => {
      const result = actual.execFileSync(file, args, options);
      if (args.at(-2) === 'rev-parse' && args.at(-1) === 'HEAD') {
        elapsed = 1001; lateResult = true;
      }
      return result;
    }) as typeof execFileSync);
    expect(() => createTaskClone({ ...input, timeoutMs: 1000 })).toThrow('deadline');
    expect(lateResult).toBe(true);
    expect(readdirSync(input.parent)).toEqual([]);
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
  });
  it('does not inherit Git directory, index, configuration or object overrides', () => {
    const input = fixture();
    const keys = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
    const old = keys.map(key => process.env[key]);
    try {
      Object.assign(process.env, { GIT_DIR: '/missing', GIT_INDEX_FILE: '/missing', GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
      const clone = createTaskClone(input);
      expect(readFileSync(join(clone.directory, 'file.txt'), 'utf8')).toBe('trusted\n');
    } finally {
      keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
    }
  });
});

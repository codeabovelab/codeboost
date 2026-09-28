import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessGroup } from '../agents/process-group.ts';

// The asynchronous storage allocation (#51 item 5), against a fake Docker CLI that keeps its objects as files, so the
// abort path runs without a daemon. The real-Docker suite covers the same path against Docker itself.
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
const { prepareTaskFilesystemsAsync, removeTaskFilesystems } = await import('../agents/container/storage.ts');
const { createTaskClone } = await import('../git/clone.ts');

const RUNNER = '0123456789abcdef0123456789abcdef';
const IMAGE = `sha256:${'a'.repeat(64)}`;
const LIMITS = { workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512 };
let root = '', state = '', path: string | undefined;
// Objects are files named by name, holding { id, labels }. `docker start` hangs ignoring SIGTERM when told to.
const FAKE_DOCKER = String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const state = __STATE__, args = process.argv.slice(2);
const objects = () => fs.readdirSync(state).filter(name => name.endsWith('.json'))
  .map(file => ({ name: file.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(state, file), 'utf8')) }));
const find = ref => objects().find(object => object.name === ref || object.id === ref);
const labels = () => Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const save = (name, object) => fs.writeFileSync(path.join(state, name + '.json'), JSON.stringify(object));
const [a, b] = args;
if ((a === 'ps' || b === 'ls') && fs.existsSync(path.join(state, 'hang-ls'))) {
  fs.writeFileSync(path.join(state, 'ls-began'), '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (a === 'ps' || b === 'ls') process.exit(0);
if (a === 'volume' && b === 'create') { save(args.at(-1), { kind: 'volume', labels: labels() }); console.log(args.at(-1)); process.exit(0); }
if (a === 'create') {
  const id = crypto.randomBytes(32).toString('hex');
  save(args[args.indexOf('--name') + 1], { kind: 'container', id, labels: labels() }); console.log(id); process.exit(0);
}
if (a === 'start' && fs.existsSync(path.join(state, 'hang-start'))) {
  fs.writeFileSync(path.join(state, 'start-began'), String(process.pid));
  process.on('SIGTERM', () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (a === 'start') process.exit(0);
if (a === 'run') process.exit(0);
if (b === 'inspect') {
  const object = find(args[2]);
  if (!object) { console.error('Error: No such object: ' + args[2]); process.exit(1); }
  console.log(JSON.stringify([object.kind === 'container'
    ? { Id: object.id, Name: '/' + object.name, Config: { Labels: object.labels } }
    : { Name: object.name, Labels: object.labels }]));
  process.exit(0);
}
if (a === 'rm' || (a === 'volume' && b === 'rm')) {
  const object = find(args.at(-1));
  if (object) fs.rmSync(path.join(state, object.name + '.json'));
  process.exit(0);
}
console.error('fake docker: unsupported ' + args.join(' ')); process.exit(2);
`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const clone = () => {
  const source = join(root, `source-${randomUUID()}`), parent = join(root, `staging-${randomUUID()}`);
  mkdirSync(source); mkdirSync(parent);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  return createTaskClone({ source, parent, taskId: 'task-1', head: git(source, 'rev-parse', 'HEAD') });
};
const owner = () => ({ runnerOwner: RUNNER, attemptId: `attempt-${randomUUID()}`, allocationId: randomUUID() });
const stored = () => readdirSync(state).filter(name => name.endsWith('.json'));
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-async-')); state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  // Storage passes Docker only an allowlisted environment, so the fake's state path is written into the script.
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER.replace('__STATE__', JSON.stringify(state)), { mode: 0o755 });
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(root, { recursive: true, force: true });
});

describe('asynchronous task storage allocation', () => {
  it('allocates the same storage as the synchronous helper, reporting every Docker process group', async () => {
    const groups: ProcessGroup[] = [];
    const filesystems = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(),
      { onProcessGroup: group => { groups.push(group); } });
    expect(stored().sort()).toEqual([`${filesystems.keeper}.json`, `${filesystems.metadataVolume}.json`,
      `${filesystems.workVolume}.json`].sort());
    expect(groups.length).toBeGreaterThanOrEqual(8);
    for (const group of groups) expect(groupAlive(group.pgid)).toBe(false);
    removeTaskFilesystems(filesystems);
    expect(stored()).toEqual([]);
  });

  it('on abort, kills a Docker call that ignores SIGTERM, then removes everything it created before settling', async () => {
    writeFileSync(join(state, 'hang-start'), '');
    const groups: ProcessGroup[] = [], controller = new AbortController();
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    const waitForStart = setInterval(() => { if (existsSync(join(state, 'start-began'))) controller.abort(); }, 20);
    const began = performance.now();
    try {
      const error = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(),
        { signal: controller.signal, onProcessGroup: group => { groups.push(group); } }).then(() => undefined, caught => caught);
      expect((error as Error).message).toContain('cancelled');
    } finally { clearInterval(ticker); clearInterval(waitForStart); }
    // SIGTERM was ignored, so the call was killed only after the 5 s grace period.
    expect(performance.now() - began).toBeGreaterThanOrEqual(5_000);
    expect(ticks).toBeGreaterThan(50);
    // The volumes and the keeper it created are gone, and no group it started is still running.
    expect(stored()).toEqual([]);
    for (const group of groups) expect(groupAlive(group.pgid)).toBe(false);
  }, 30_000);

  it('reports an abort during the allocation ID check as cancelled, having created nothing', async () => {
    writeFileSync(join(state, 'hang-ls'), '');
    const controller = new AbortController();
    const waitForList = setInterval(() => { if (existsSync(join(state, 'ls-began'))) controller.abort(); }, 20);
    try {
      await expect(prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(), { signal: controller.signal }))
        .rejects.toThrow('cancelled');
    } finally { clearInterval(waitForList); }
    expect(stored()).toEqual([]);
  }, 30_000);

  it('creates nothing when the signal is already aborted', async () => {
    const groups: ProcessGroup[] = [];
    await expect(prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(),
      { signal: AbortSignal.abort(), onProcessGroup: group => { groups.push(group); } })).rejects.toThrow('cancelled');
    expect(groups).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

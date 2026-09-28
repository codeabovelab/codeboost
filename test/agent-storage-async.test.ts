import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessGroup } from '../agents/process-group.ts';

// The asynchronous storage allocation (#51 item 5), against a fake Docker CLI that keeps its objects as files, so the
// abort path runs without a daemon. The real-Docker suite covers the same path against Docker itself.
// spawn passes through unless a test makes it throw, as it does synchronously for errors such as ENOMEM.
const spawnFault = vi.hoisted(() => ({ on: undefined as undefined | ((args: readonly string[]) => boolean) }));
// Every Docker call passes through; a test can act after one call settles and before the next is requested.
const calls = vi.hoisted(() => ({ made: [] as string[][], afterCall: undefined as undefined | ((args: readonly string[]) => void) }));
vi.mock('../agents/process-group.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/process-group.ts')>();
  return { ...actual, runInProcessGroup: async (...call: Parameters<typeof actual.runInProcessGroup>) => {
    calls.made.push([...call[1]]);
    const outcome = await actual.runInProcessGroup(...call);
    calls.afterCall?.(call[1]);
    return outcome;
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: ((file: string, args: readonly string[], options: object) => {
    if (spawnFault.on?.(args)) throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM', syscall: 'spawn' });
    return actual.spawn(file, args, options);
  }) as typeof actual.spawn };
});
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
const { adoptRecoveredTaskStorage, exportTaskDiff, hasLiveTaskStorage, prepareTaskFilesystemsAsync,
  removeTaskFilesystems } = await import('../agents/container/storage.ts');
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
if (a === 'run' && args.includes('io.codeboost.task-storage=export')) {
  const name = args[args.indexOf('--name') + 1];
  save(name, { kind: 'container', id: crypto.randomBytes(32).toString('hex'), labels: labels() });
  if (fs.existsSync(path.join(state, 'hang-export'))) {
    fs.writeFileSync(path.join(state, 'export-began'), '');
    process.on('SIGTERM', () => {});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  // Like the export script: the diff, cut to the limit it is given, base64-encoded; then --rm removes the container.
  const diff = fs.readFileSync(path.join(state, 'export-diff')).subarray(0, Number(args.at(-1)));
  fs.rmSync(path.join(state, name + '.json'));
  process.stdout.write(diff.toString('base64'));
  process.exit(0);
}
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
  spawnFault.on = undefined; calls.afterCall = undefined; calls.made = [];
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

  it('removes what it created and releases the allocation when a later Docker call cannot be spawned', async () => {
    // Both volumes are created; spawning the keeper's `docker create` then fails synchronously.
    spawnFault.on = args => args[0] === 'create';
    await expect(prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner())).rejects.toThrow('ENOMEM');
    expect(stored()).toEqual([]);
    expect(hasLiveTaskStorage(RUNNER)).toBe(false);
  });

  it('reports an abort that lands between two Docker calls as a cancel, and removes what it created', async () => {
    const controller = new AbortController(), groups: ProcessGroup[] = [];
    // Aborted after the work volume's create settles and before the next call (the reuse check) is requested.
    calls.afterCall = args => { if (args[0] === 'volume' && args[1] === 'create') controller.abort(); };
    const error = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(),
      { signal: controller.signal, onProcessGroup: group => { groups.push(group); } }).then(() => undefined, caught => caught);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    // Exactly one call was refused before it started (the reuse check); every other call ran and reported its group.
    expect(calls.made.length - groups.length).toBe(1);
    expect(stored()).toEqual([]);
    expect(hasLiveTaskStorage(RUNNER)).toBe(false);
  });

  it('refuses a deadline longer than a Node timer can wait, before any Docker call', async () => {
    await expect(prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(), { timeoutMs: 2 ** 31 }))
      .rejects.toThrow('at most');
    expect(calls.made).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('creates nothing when the signal is already aborted', async () => {
    const groups: ProcessGroup[] = [];
    await expect(prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner(),
      { signal: AbortSignal.abort(), onProcessGroup: group => { groups.push(group); } })).rejects.toThrow('cancelled');
    expect(groups).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

describe('task diff export', () => {
  const BASE = 'b'.repeat(40);
  const exports = () => stored().filter(file => file.startsWith('codeboost-export-'));

  it('returns the diff bytes, and cuts a longer diff at maxBytes', async () => {
    const filesystems = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner());
    const diff = Buffer.concat([Buffer.from('diff --git a/file.txt b/file.txt\n'), Buffer.from([0xff, 0x00, 0xfe])]);
    writeFileSync(join(state, 'export-diff'), diff);
    expect(await exportTaskDiff(filesystems, { base: BASE, imageId: IMAGE })).toEqual({ diff, truncated: false });
    expect(await exportTaskDiff(filesystems, { base: BASE, imageId: IMAGE, maxBytes: 10 }))
      .toEqual({ diff: diff.subarray(0, 10), truncated: true });
    // The export container is transient: none is left behind.
    expect(exports()).toEqual([]);
    removeTaskFilesystems(filesystems);
  });

  it('exports through a recovery handle, after a restart lost the allocator value', async () => {
    const owned = owner(), labels = (kind: string) => ({ 'io.codeboost.runner': owned.runnerOwner,
      'io.codeboost.attempt': owned.attemptId, 'io.codeboost.allocation': owned.allocationId, 'io.codeboost.task-storage': kind });
    const work = `codeboost-work-${randomUUID()}`, metadata = `codeboost-metadata-${randomUUID()}`;
    writeFileSync(join(state, `${work}.json`), JSON.stringify({ kind: 'volume', labels: labels('work') }));
    writeFileSync(join(state, `${metadata}.json`), JSON.stringify({ kind: 'volume', labels: labels('metadata') }));
    writeFileSync(join(state, 'export-diff'), 'partial output\n');
    const handle = await adoptRecoveredTaskStorage(owned, { workVolume: work, metadataVolume: metadata });
    expect((await exportTaskDiff(handle, { base: BASE, imageId: IMAGE })).diff.toString()).toBe('partial output\n');
  });

  it('refuses a volume that no longer carries the storage labels, before running anything', async () => {
    const filesystems = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner());
    const file = join(state, `${filesystems.workVolume}.json`), object = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...object, labels: { ...object.labels, 'io.codeboost.runner': 'f'.repeat(32) } }));
    writeFileSync(join(state, 'export-diff'), 'x');
    await expect(exportTaskDiff(filesystems, { base: BASE, imageId: IMAGE })).rejects.toThrow("storage's labels");
    expect(exports()).toEqual([]);
  });

  it('on abort, kills a docker run that ignores SIGTERM and removes the export container before settling', async () => {
    const filesystems = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner());
    writeFileSync(join(state, 'hang-export'), '');
    const controller = new AbortController();
    const waitForRun = setInterval(() => { if (existsSync(join(state, 'export-began'))) controller.abort(); }, 20);
    const began = performance.now();
    try {
      const error = await exportTaskDiff(filesystems, { base: BASE, imageId: IMAGE, signal: controller.signal })
        .then(() => undefined, caught => caught);
      expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    } finally { clearInterval(waitForRun); }
    expect(performance.now() - began).toBeGreaterThanOrEqual(5_000);
    expect(exports()).toEqual([]);
    rmSync(join(state, 'hang-export'));
    removeTaskFilesystems(filesystems);
  }, 60_000);

  it('rejects an invalid base, limit or image before any Docker call', async () => {
    const filesystems = await prepareTaskFilesystemsAsync(clone(), LIMITS, IMAGE, owner());
    calls.made = [];
    await expect(exportTaskDiff(filesystems, { base: 'HEAD', imageId: IMAGE })).rejects.toThrow('full commit ID');
    await expect(exportTaskDiff(filesystems, { base: BASE, imageId: IMAGE, maxBytes: 1024 * 1024 + 1 }))
      .rejects.toThrow('at most');
    await expect(exportTaskDiff(filesystems, { base: BASE, imageId: 'latest' })).rejects.toThrow('immutable');
    expect(calls.made).toEqual([]);
    removeTaskFilesystems(filesystems);
  });
});

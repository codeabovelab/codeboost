import { fixtureGit } from './fixtures/git.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The asynchronous clone pauses every 1,000 entries it walks, including entries read from one huge directory, so the
// event loop (and an abort) is never held for a whole directory (#51 item 5). Storage allocation walks nothing on the
// host: its link check runs in the seeder (#66).
const trace = vi.hoisted(() => ({ run: 0, longest: 0, total: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, opendirSync: ((...args: Parameters<typeof actual.opendirSync>) => {
    const directory = actual.opendirSync(...args), read = directory.readSync.bind(directory);
    directory.readSync = () => {
      const entry = read();
      if (entry) { trace.run += 1; trace.total += 1; trace.longest = Math.max(trace.longest, trace.run); }
      return entry;
    };
    return directory;
  }) as typeof actual.opendirSync };
});
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
const { createTaskClone, createTaskCloneAsync } = await import('../git/clone.ts');
const { prepareTaskFilesystemsAsync } = await import('../agents/container/storage.ts');

const ENTRIES = 2_500;
let root = '';
const realSetImmediate = globalThis.setImmediate;
const git = fixtureGit;
const repository = () => {
  const source = join(root, 'source'), parent = join(root, 'staging');
  mkdirSync(source); mkdirSync(parent);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  return { source, parent, head: git(source, 'rev-parse', 'HEAD'), taskId: 'task-1' };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'walk-pauses-'));
  trace.run = 0; trace.longest = 0; trace.total = 0;
  // Every pause of the asynchronous drivers goes through setImmediate: the run of entries read restarts there.
  vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    trace.run = 0;
    return realSetImmediate(callback, ...args);
  }) as typeof setImmediate);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('pauses while walking one large directory', () => {
  it('in the asynchronous clone, reading object storage', async () => {
    const input = repository();
    // One object-storage directory with far more entries than one pause interval.
    const info = join(input.source, '.git', 'objects', 'info');
    for (let index = 0; index < ENTRIES; index++) writeFileSync(join(info, `entry-${index}`), '');
    // Each Git call is awaited, which yields the event loop too; the object checks before and after the clone call are
    // separate walks, so a run only counts entries read without any yield in between.
    await createTaskCloneAsync({ ...input, onProcessGroup: () => { trace.run = 0; } });
    expect(trace.total).toBeGreaterThanOrEqual(ENTRIES);
    expect(trace.longest).toBeLessThanOrEqual(1_000);
  }, 60_000);

  it('in the asynchronous storage allocation, by not walking the checkout on the host at all', async () => {
    const input = repository();
    const clone = createTaskClone(input);
    const wide = join(clone.directory, 'wide');
    mkdirSync(wide);
    for (let index = 0; index < ENTRIES; index++) writeFileSync(join(wide, `entry-${index}`), '');
    trace.run = 0; trace.longest = 0; trace.total = 0;
    // No Docker on PATH: the allocation fails at its first Docker call. The link check runs in the seeder, in the
    // container, so nothing before that call reads the checkout's directories on the host.
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(prepareTaskFilesystemsAsync(clone, { workBytes: 1 << 24, workInodes: 512, metadataBytes: 1 << 24,
        metadataInodes: 512 }, `sha256:${'a'.repeat(64)}`, { runnerOwner: '0'.repeat(32), attemptId: 'walk',
        allocationId: randomUUID() })).rejects.toThrow();
    } finally { process.env.PATH = path; }
    expect(trace.total).toBe(0);
  }, 60_000);
});

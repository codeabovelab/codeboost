import { execFileSync } from 'node:child_process';
import { fixtureGit } from './fixtures/git.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every Git call passes through; a test can act after one call settles and before the next is requested.
const calls = vi.hoisted(() => ({ made: [] as string[][], afterCall: undefined as undefined | ((args: readonly string[]) => void),
  trackedFailure: undefined as undefined | 'EGROUPALIVE' | 'ESTDIOHELD' }));
vi.mock('../agents/process-group.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/process-group.ts')>();
  return { ...actual, runInProcessGroup: async (...call: Parameters<typeof actual.runInProcessGroup>) => {
    calls.made.push([...call[1]]);
    const outcome = await actual.runInProcessGroup(...call);
    calls.afterCall?.(call[1]);
    return outcome;
  } };
});
vi.mock('../agents/tracked-docker.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/tracked-docker.ts')>();
  return { ...actual, runTrackedProcess: async (...call: Parameters<typeof actual.runTrackedProcess>) => {
    const outcome = await actual.runTrackedProcess(...call);
    if (calls.trackedFailure && call[0] === 'git' && call[1].includes('clone') && outcome.status === 0)
      return { ...outcome, status: null, error: Object.assign(new Error('injected unsettled clone'), { code: calls.trackedFailure }) };
    return outcome;
  } };
});
const { assertTaskClone, cloneFailureRetainsDirectory, createTaskCloneAsync } = await import('../git/clone.ts');
import type { ProcessGroup } from '../agents/process-group.ts';

// The asynchronous clone (#51 item 5): every Git call runs in its own process group, and an abort settles only after
// that group has exited and the partial clone is gone.
const roots: string[] = [];
const git = fixtureGit;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clone-async-')); roots.push(root);
  const source = join(root, 'source'), parent = join(root, 'tasks');
  mkdirSync(source); mkdirSync(parent);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  return { root, source, parent, head: git(source, 'rev-parse', 'HEAD'), taskId: 'task-1' };
}
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};
/** Put a `git` first on PATH whose `clone` ignores SIGTERM, starts a background child, and never finishes. */
const withStubbornClone = async <T>(root: string, started: string, run: () => Promise<T>) => {
  const shim = join(root, 'bin'); mkdirSync(shim);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'git'), ['#!/bin/sh',
    'for arg in "$@"; do if [ "$arg" = clone ]; then',
    `  trap '' TERM; sleep 60 & touch '${started}'; while :; do sleep 1; done`,
    'fi; done',
    `exec '${realGit}' "$@"`].join('\n'), { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path}`;
  try { return await run(); } finally { process.env.PATH = path; }
};
afterEach(() => {
  calls.afterCall = undefined; calls.trackedFailure = undefined; calls.made = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('asynchronous task clone', () => {
  it('retains a partial clone only for outcomes that prove process or pipe ownership is unsettled', () => {
    expect(cloneFailureRetainsDirectory(Object.assign(new Error('alive'), { code: 'EGROUPALIVE' }))).toBe(true);
    expect(cloneFailureRetainsDirectory(Object.assign(new Error('pipe'), { code: 'ESTDIOHELD' }))).toBe(true);
    expect(cloneFailureRetainsDirectory(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }))).toBe(false);
  });

  it.each(['EGROUPALIVE', 'ESTDIOHELD'] as const)(
    'retains the actual partial clone after a tracked %s outcome', async code => {
      const input = fixture(); calls.trackedFailure = code;
      const lifecycle = { starting: () => {}, started: () => {}, settled: () => {}, unsettled: () => {} };
      await expect(createTaskCloneAsync({ ...input, processLifecycle: lifecycle })).rejects.toMatchObject({ code });
      const retained = readdirSync(input.parent);
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatch(/^codeboost-task-/);
      expect(existsSync(join(input.parent, retained[0]!))).toBe(true);
    });

  it('clones like the synchronous helper and reports each Git process group, all gone once it settles', async () => {
    const input = fixture(), groups: ProcessGroup[] = [];
    const clone = await createTaskCloneAsync({ ...input, onProcessGroup: group => { groups.push(group); } });
    expect(assertTaskClone(clone)).toBe(clone.directory);
    expect(readFileSync(join(clone.directory, 'file.txt'), 'utf8')).toBe('trusted\n');
    expect(git(clone.directory, 'rev-parse', 'HEAD')).toBe(input.head);
    expect(groups.length).toBeGreaterThanOrEqual(5);
    for (const group of groups) {
      expect(group.pgid).toBeGreaterThan(1);
      expect(groupAlive(group.pgid)).toBe(false);
    }
  });

  it('on abort, kills a clone that ignores SIGTERM, waits for its group, and removes the partial clone', async () => {
    const input = fixture(), started = join(input.root, 'clone-started'), groups: ProcessGroup[] = [];
    const controller = new AbortController();
    // The event loop stays free while Git runs: this keeps ticking until the clone settles.
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    const waitForClone = setInterval(() => { if (existsSync(started)) controller.abort(); }, 20);
    const began = performance.now();
    try {
      const error = await withStubbornClone(input.root, started, () =>
        createTaskCloneAsync({ ...input, timeoutMs: 60_000, signal: controller.signal,
          onProcessGroup: group => { groups.push(group); } }).then(() => undefined, caught => caught));
      expect((error as Error).message).toContain('cancelled');
    } finally { clearInterval(ticker); clearInterval(waitForClone); }
    // SIGTERM was ignored, so settlement waited for the SIGKILL after the 5 s grace period.
    expect(performance.now() - began).toBeGreaterThanOrEqual(5_000);
    expect(ticks).toBeGreaterThan(50);
    for (const group of groups) expect(groupAlive(group.pgid)).toBe(false);
    expect(readdirSync(input.parent)).toEqual([]);
  }, 30_000);

  it('reports an abort that lands between two Git calls as a cancel, and removes the partial clone', async () => {
    const input = fixture(), controller = new AbortController(), groups: ProcessGroup[] = [];
    // Aborted after `git clone` settles and before the next Git call is requested: that call never starts.
    calls.afterCall = args => { if (args.includes('clone')) controller.abort(); };
    const error = await createTaskCloneAsync({ ...input, signal: controller.signal,
      onProcessGroup: group => { groups.push(group); } }).then(() => undefined, caught => caught);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(calls.made.length - groups.length).toBe(1);
    expect(readdirSync(input.parent)).toEqual([]);
  });

  it('spawns nothing and creates nothing when the signal is already aborted', async () => {
    const input = fixture(), groups: ProcessGroup[] = [];
    await expect(createTaskCloneAsync({ ...input, signal: AbortSignal.abort(),
      onProcessGroup: group => { groups.push(group); } })).rejects.toThrow('cancelled');
    expect(groups).toEqual([]);
    expect(readdirSync(input.parent)).toEqual([]);
  });
});

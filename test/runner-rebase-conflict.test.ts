import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvocationHandle, InvocationResult, TaskClone } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskChangeManifest, TaskTreeCheck } from '../agents/container/changes.ts';
import type { ExportedTaskPath, TaskFilesystems } from '../agents/container/storage.ts';
import type { ProcessGroupLifecycle } from '../agents/tracked-docker.ts';
import { DEFAULT_PROCESS_SETTLEMENT_MS } from '../agents/process-group.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import type { AsyncCloneOptions } from '../git/clone.ts';
import { CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS, copyConflictPaths, createForeignConflictResolver,
  MAX_CONFLICT_PATH_BYTES } from '../runner/rebase-conflict.ts';
import { RebaseResourcesUnsettled, type RebaseConflictInput } from '../runner/rebase.ts';
import type { RunnerRepository } from '../runner/runner-repository.ts';
import { Store } from '../runner/store.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 22, baseEntries: [{ path: 'conflict.txt', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan: Plan = { schema_version: 1, revision: 1, issue: 22, summary: 'Resolve', questions: [], items: [{ id: 'P1', title: 'Resolve', intent: 'Resolve',
  files: [{ path: 'conflict.txt', kind: 'edit', renamed_from: null, change: 'Resolve' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
const oid = (n: number) => n.toString(16).padStart(40, '0');
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-conflict-resolver-')); roots.push(root);
  const store = new Store(join(root, 'state.sqlite')); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'approved but merge blocked');
  const snapshot = store.getSnapshot(identity), expected = { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) };
  const marker = store.beginRebase(identity, expected, store.getTask(identity).stateVersion,
    { oldBase: oid(1), oldHead: oid(2), onto: oid(3), oldHistory: [oid(2)] });
  const repository = join(root, 'rebase'); mkdirSync(repository); writeFileSync(join(repository, 'conflict.txt'), 'conflicted\n');
  return { root, store, marker, planKey: store.getTask(identity).planKey, repository };
}

const manifest = (changes: TaskChangeManifest['changes'] = [{ path: 'conflict.txt', kind: 'modify', oldType: 'file', newType: 'file', underGit: false, ignored: false }]) => ({
  base: oid(2), changes, agentCommits: [], metadataChanged: false, linkTargetChanges: [], nestedGitlinkContent: [], digest: 'd'.repeat(64),
}) satisfies TaskChangeManifest;
type ProcessOptions = { processLifecycle?: ProcessGroupLifecycle; timeoutMs?: number };

function deps(f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) {
  const events: string[] = [];
  let request: AgentAdapterRequest | undefined;
  let schemaInput: string | undefined;
  let storageAllocationId: string | undefined;
  let imported: readonly ExportedTaskPath[] | undefined;
  const storage = { keeper: 'keeper' } as TaskFilesystems;
  const d = {
    clone: async (options: AsyncCloneOptions) => {
      events.push('clone');
      for (const group of [{ pgid: 4242, startedAt: 1, identity: null }, { pgid: 4343, startedAt: 2, identity: null }]) {
        options.processLifecycle?.starting();
        expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) }, processGroup: 'spawning' });
        options.processLifecycle?.started(group);
        expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: group });
        options.processLifecycle?.settled(group);
        expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: null });
      }
      const directory = join(options.parent, 'clone'); mkdirSync(directory); mkdirSync(join(directory, '.git')); writeFileSync(join(directory, 'conflict.txt'), 'base\n');
      return { id: randomUUID(), taskId: f.planKey, directory, head: oid(2) } as TaskClone;
    },
    allocate: async (_clone: TaskClone, _limits: unknown, _image: string, owner: { allocationId: string }, options: ProcessOptions) => {
      events.push(`allocate:${readFileSync((_clone as TaskClone).directory + '/conflict.txt', 'utf8').trim()}`);
      storageAllocationId = owner.allocationId;
      const group = { pgid: 5252, startedAt: 2, identity: null };
      options.processLifecycle?.starting(); options.processLifecycle?.started(group); options.processLifecycle?.settled(group);
      return storage;
    },
    importPaths: async (_storage: TaskFilesystems, entries: readonly ExportedTaskPath[]) => {
      imported = entries;
      events.push(`import:${entries[0]?.content?.toString().trim() ?? entries[0]?.type}`);
    },
    snapshotLinks: async () => ({ links: [], recorded: {}, linkArgs: [] }) as never,
    checkTree: async (_filesystems: TaskFilesystems, options: ProcessOptions) => {
      const group = { pgid: 6262, startedAt: 3, identity: null };
      options.processLifecycle?.starting(); options.processLifecycle?.started(group);
      expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: { pgid: 6262 } });
      options.processLifecycle?.settled(group);
      return { base: oid(2), gitlinks: [] } as TaskTreeCheck;
    },
    start: (value: typeof request) => {
      request = value; events.push('start');
      schemaInput = readFileSync(join(value!.inputDirectory, 'schema.json'), 'utf8').trim();
      return { attemptId: value!.invocation.attemptId, cancel: vi.fn(), settled: Promise.resolve({
        attemptId: value!.invocation.attemptId, context: value!.invocation.context, exitCode: 0, signal: null, stdout: '', stderr: '',
      } satisfies InvocationResult) } satisfies InvocationHandle;
    },
    inspect: async () => manifest(),
    exportPaths: async () => [{ path: 'conflict.txt', type: 'file', executable: false, content: Buffer.from('resolved\n') }] as readonly ExportedTaskPath[],
    remove: async () => { events.push('remove'); expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: expect.any(Object) }); },
    removeStaging: async (path: string) => { rmSync(path, { recursive: true }); },
    ...over,
  };
  return { d, events, storage, get request() { return request; }, get storageAllocationId() { return storageAllocationId; },
    get imported() { return imported; }, get schemaInput() { return schemaInput; } };
}

const input = (f: ReturnType<typeof fixture>, signal?: AbortSignal): RebaseConflictInput => ({ attemptId: f.marker.attemptId,
  commit: oid(2), owner: null, baseHead: oid(2), files: ['conflict.txt'], repository: f.repository, deadline: Date.now() + 60_000, signal });

describe('production rebase conflict resolver', () => {
  it('reserves the complete default tracked-process settlement budget plus its durable-write margin', () => {
    expect(CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS).toBe(DEFAULT_PROCESS_SETTLEMENT_MS + 1_000);
    expect(DEFAULT_PROCESS_SETTLEMENT_MS).toBe(16_000);
  });

  it.each([-60_000, 60_000])('keeps every stage and child invocation on one monotonic deadline when wall time moves by %i ms', async wallStep => {
    vi.useFakeTimers();
    try {
      const f = fixture(), x = deps(f), budgets: number[] = [];
      const clone = x.d.clone, allocate = x.d.allocate;
      x.d.clone = async (options: AsyncCloneOptions) => {
        budgets.push(options.timeoutMs!);
        const result = await clone(options);
        vi.setSystemTime(Date.now() + wallStep);
        return result;
      };
      x.d.allocate = async (...args: Parameters<typeof allocate>) => {
        budgets.push(args[4].timeoutMs!);
        return allocate(...args);
      };
      const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
        repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
        image: () => 'sha256:' + 'b'.repeat(64), token: 'secret',
        limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
      await resolve({ ...input(f), deadline: Date.now() + CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS + 5_000 });
      expect(budgets).toHaveLength(2);
      expect(budgets[1]).toBeLessThanOrEqual(budgets[0]!);
      expect(x.request!.invocation.deadline - Date.now()).toBeGreaterThan(0);
      expect(x.request!.invocation.deadline - Date.now()).toBeLessThanOrEqual(budgets[0]!);
    } finally { vi.useRealTimers(); }
  });

  it('carries the resolver monotonic budget into adapter setup across a later wall-clock step', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), x = deps(f), start = x.d.start;
      x.d.start = ((value: AgentAdapterRequest, _token: string,
        options?: { invocationBudget?: () => number }) => {
        vi.setSystemTime(Date.now() + 60_000);
        expect(options?.invocationBudget?.()).toBeGreaterThan(0);
        return start(value);
      }) as typeof x.d.start;
      const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
        repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
        image: () => 'sha256:' + 'b'.repeat(64), token: 'secret',
        limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });

      await resolve({ ...input(f), deadline: Date.now() + CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS + 5_000 });
    } finally { vi.useRealTimers(); }
  });

  it('does not claim a conflict child for an already-aborted request', async () => {
    const f = fixture(), x = deps(f), reason = new Error('cancelled before conflict admission');
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: vi.fn(() => 'sha256:' + 'b'.repeat(64)), token: 'secret',
      limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f, AbortSignal.abort(reason)))).rejects.toBe(reason);
    expect(x.events).toEqual([]);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null, processGroup: null });
  });

  it('bounds the complete host snapshot before changing the destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-conflict-copy-')); roots.push(root);
    const source = join(root, 'source'), destination = join(root, 'destination');
    mkdirSync(source); mkdirSync(destination);
    writeFileSync(join(source, 'a'), '12345'); writeFileSync(join(source, 'b'), '67890');
    writeFileSync(join(destination, 'a'), 'old-a'); writeFileSync(join(destination, 'b'), 'old-b');
    expect(() => copyConflictPaths(source, destination, ['a', 'b'], 8)).toThrow(/byte limit/);
    expect(readFileSync(join(destination, 'a'), 'utf8')).toBe('old-a');
    expect(readFileSync(join(destination, 'b'), 'utf8')).toBe('old-b');
  });

  it('never follows a conflict path through a host symlink ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-conflict-link-')); roots.push(root);
    const source = join(root, 'source'), destination = join(root, 'destination'), outside = join(root, 'outside');
    mkdirSync(source); mkdirSync(destination); mkdirSync(outside); writeFileSync(join(outside, 'file'), 'outside');
    symlinkSync(outside, join(source, 'link')); mkdirSync(join(destination, 'link'));
    expect(() => copyConflictPaths(source, destination, ['link/file'])).toThrow(/ancestor/);
  });

  it('recreates missing plain destination ancestors for a nested modify/delete conflict', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-conflict-nested-')); roots.push(root);
    const source = join(root, 'source'), destination = join(root, 'destination');
    mkdirSync(source); mkdirSync(destination); mkdirSync(join(source, 'dir'));
    writeFileSync(join(source, 'dir', 'file'), 'modified side\n');
    copyConflictPaths(source, destination, ['dir/file']);
    expect(readFileSync(join(destination, 'dir', 'file'), 'utf8')).toBe('modified side\n');
  });

  it('does not recreate missing ancestors when copying an absent nested conflict path', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-conflict-delete-')); roots.push(root);
    const source = join(root, 'source'), destination = join(root, 'destination');
    mkdirSync(source); mkdirSync(destination); mkdirSync(join(source, 'dir'));
    copyConflictPaths(source, destination, ['dir/missing']);
    expect(readdirSync(destination)).toEqual([]);
  });

  it('rejects an invalid conflict set before claiming ownership or preparing resources', async () => {
    const f = fixture(), image = vi.fn(() => 'sha256:' + 'b'.repeat(64)), x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32), image,
      token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve({ ...input(f), files: ['.git/config'] })).rejects.toThrow(/invalid/);
    expect(image).not.toHaveBeenCalled(); expect(x.events).toEqual([]);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null });
  });

  it('rejects a conflict path set that cannot fit safely in one provider argument before claiming ownership', async () => {
    const f = fixture(), image = vi.fn(() => 'sha256:' + 'b'.repeat(64)), x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32), image,
      token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    const files = Array.from({ length: Math.ceil(MAX_CONFLICT_PATH_BYTES / 1000) + 1 }, (_, index) =>
      `${String(index).padStart(3, '0')}-${'x'.repeat(995)}`);
    await expect(resolve({ ...input(f), files })).rejects.toThrow(/command-input limit/);
    expect(image).not.toHaveBeenCalled(); expect(x.events).toEqual([]);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null });
  });

  it('rejects an unknown owned item before claiming child resources', async () => {
    const f = fixture(), x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret',
      limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve({ ...input(f), owner: 'P2' })).rejects.toThrow(/current plan item/);
    expect(x.events).toEqual([]);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null, processGroup: null });
  });

  it('does not claim resources when owned-item serialization consumes the deadline', async () => {
    const f = fixture(), x = deps(f), realNow = performance.now.bind(performance);
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++reads === 1 ? realNow() : Number.MAX_SAFE_INTEGER);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret',
      limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve({ ...input(f), owner: 'P1' })).rejects.toThrow(/deadline has passed/);
    expect(x.events).toEqual([]);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null, processGroup: null });
  });

  it('allocates from the clean clone before importing the conflict snapshot, then copies back only the audited path', async () => {
    const f = fixture(), x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await resolve(input(f));
    expect(x.events).toEqual(['clone', 'allocate:base', 'import:conflicted', 'start', 'remove']);
    expect(x.imported).toEqual([{ path: 'conflict.txt', type: 'file', executable: false, content: Buffer.from('conflicted\n') }]);
    expect(x.request).toMatchObject({ invocation: { phase: 'fix', approvedArgv: [], runnerOwner: 'a'.repeat(32) },
      prompt: expect.stringContaining('["conflict.txt"]'), cleanupRoot: expect.stringContaining('.codeboost-conflict-') });
    expect(x.request!.networkAllocationId).not.toBe(x.storageAllocationId);
    expect(readFileSync(join(f.repository, 'conflict.txt'), 'utf8')).toBe('resolved\n');
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null, processGroup: null });
  });

  it('gives an owned conflict child the exact plan item and rebase commit identities', async () => {
    const f = fixture(), x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret',
      limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await resolve({ ...input(f), owner: 'P1', baseHead: oid(9) });
    expect(JSON.parse(x.schemaInput!).planItem).toEqual(plan.items[0]);
    expect(x.request?.prompt).toContain('/run/codeboost-input/schema.json');
    expect(x.request?.prompt).toContain(oid(2));
    expect(x.request?.prompt).toContain(oid(9));
  });

  it('canonicalizes a cleanup root whose configured spelling traverses a symlink', async () => {
    const f = fixture(), aliasParent = join(f.root, 'root-alias'), alias = join(aliasParent, 'rebase');
    symlinkSync(f.root, aliasParent);
    const x = deps(f);
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await resolve({ ...input(f), repository: alias });
    const canonicalRepository = realpathSync(f.repository);
    expect(x.request!.cleanupRoot).toMatch(new RegExp(`^${canonicalRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.codeboost-conflict-`));
    expect(x.request!.cleanupRoot).not.toContain('root-alias');
  });

  it('reserves process settlement time and retains ownership when the adapter cannot settle by the work deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), cancel = vi.fn(), pending = Promise.withResolvers<InvocationResult>();
      let request: AgentAdapterRequest | undefined;
      const x = deps(f, { start: (value: AgentAdapterRequest) => {
        request = value;
        return { attemptId: value.invocation.attemptId, cancel, settled: pending.promise } satisfies InvocationHandle;
      } });
      const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
        repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
        image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
          metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
      const settlementDeadline = Date.now() + CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS + 1_000;
      const running = resolve({ ...input(f), deadline: settlementDeadline });
      const rejected = expect(running).rejects.toThrow(/retained resources/);
      for (let turn = 0; turn < 20 && !request; turn++) await Promise.resolve();
      expect(request?.invocation.deadline).toBe(settlementDeadline - CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS);
      await vi.advanceTimersByTimeAsync(CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS + 1_000);
      await rejected;
      expect(cancel).toHaveBeenCalledWith('timeout');
      expect(x.events).not.toContain('remove');
      expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) } });
      pending.resolve({ attemptId: request!.invocation.attemptId, context: request!.invocation.context,
        exitCode: null, signal: null, stopReason: 'timeout', stdout: '', stderr: '' });
      await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });

  it('rejects an outside change without copying it back and releases a settled child', async () => {
    const f = fixture(), x = deps(f, { inspect: async () => manifest([{ path: 'outside.txt', kind: 'add', newType: 'file', underGit: false, ignored: false }]) });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/unapproved path/);
    expect(readFileSync(join(f.repository, 'conflict.txt'), 'utf8')).toBe('conflicted\n');
    expect(x.events).toContain('remove');
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null });
  });

  it('retains the marker and staging tree when final storage cleanup does not settle', async () => {
    const f = fixture(), x = deps(f, { remove: async () => { throw new Error('storage cleanup failed'); } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/retained resources/);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) } });
    expect(readdirSync(f.repository).some(name => name.startsWith('.codeboost-conflict-'))).toBe(true);
  });

  it('preserves both the primary failure and cleanup failure when retaining ownership', async () => {
    const f = fixture(), primary = new Error('manifest inspection failed'), cleanup = new Error('storage cleanup failed');
    const x = deps(f, { inspect: async () => { throw primary; }, remove: async () => { throw cleanup; } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    const failure = await resolve(input(f)).then(() => undefined, error => error as Error);
    expect(failure).toBeInstanceOf(RebaseResourcesUnsettled);
    expect(failure?.cause).toBeInstanceOf(AggregateError);
    expect((failure?.cause as AggregateError).errors).toEqual([primary, cleanup]);
    expect((failure?.cause as AggregateError).cause).toBe(primary);
  });

  it.each([[[]], [[{ kind: 'container' as const, name: 'left' }]]])(
    'retains durable ownership when the invocation reports an unreleased inventory %#', async unreleased => {
    const f = fixture(), remove = vi.fn(async () => undefined);
    const x = deps(f, { remove, start: (value: AgentAdapterRequest) => ({ attemptId: value.invocation.attemptId, cancel: vi.fn(),
      settled: Promise.resolve({ attemptId: value.invocation.attemptId, context: value.invocation.context, exitCode: null, signal: null,
        stopReason: 'capture-failure', stdout: '', stderr: '', unreleased }) }) });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/could not confirm removal/);
    expect(remove).not.toHaveBeenCalled();
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) } });
  });

  it('retains the allocation identity when failed allocation cleanup does not settle', async () => {
    const f = fixture(), x = deps(f, { allocate: async (_clone: TaskClone, _limits: unknown, _image: string,
      _owner: unknown, options: ProcessOptions) => {
      const group = { pgid: 7373, startedAt: 4, identity: null };
      options.processLifecycle?.starting(); options.processLifecycle?.started(group); options.processLifecycle?.settled(group);
      throw new AggregateError([new Error('volume cleanup failed')], 'allocation cleanup did not settle');
    } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/startup recovery/);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) }, processGroup: null });
  });

  it('retains storage when conflict import cleanup does not settle', async () => {
    const f = fixture(), remove = vi.fn(async () => undefined), x = deps(f, {
      remove,
      importPaths: async () => { throw new AggregateError([new Error('import container remains')], 'import cleanup did not settle'); },
    });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/startup recovery/);
    expect(remove).not.toHaveBeenCalled();
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: { source: oid(2) } });
  });

  it('retains an exact process group and staging tree when a helper remains alive', async () => {
    const f = fixture(), x = deps(f, { clone: async (options: AsyncCloneOptions) => {
      const group = { pgid: 8383, startedAt: 5, identity: null };
      options.processLifecycle?.starting(); options.processLifecycle?.started(group);
      options.processLifecycle?.unsettled(group, 'group-alive');
      throw Object.assign(new Error('group remains alive'), { code: 'EGROUPALIVE' });
    } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/startup recovery/);
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({
      conflict: { source: oid(2) }, processGroup: { pgid: 8383 } });
    expect(readdirSync(f.repository).some(name => name.startsWith('.codeboost-conflict-'))).toBe(true);
  });

  it('durably owns an adapter Docker client until that exact process group settles', async () => {
    const f = fixture(), child = Promise.withResolvers<InvocationResult>();
    let request: AgentAdapterRequest | undefined;
    const group = { pgid: 8484, startedAt: 6, identity: 'linux:00000000-0000-0000-0000-000000000000:2' };
    const x = deps(f, { start: (value: AgentAdapterRequest) => {
      request = value;
      value.processLifecycle!.starting();
      value.processLifecycle!.started(group);
      return { attemptId: value.invocation.attemptId, cancel: vi.fn(), settled: child.promise };
    } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    const running = resolve(input(f));
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: group,
      conflict: { attemptId: request!.invocation.attemptId } });
    request!.processLifecycle!.settled(group);
    child.resolve({ attemptId: request!.invocation.attemptId, context: request!.invocation.context,
      exitCode: 0, signal: null, stdout: '', stderr: '' });
    await running;
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: null, conflict: null });
  });

  it('does not start cleanup after an adapter Docker client remains unsettled', async () => {
    const f = fixture(), remove = vi.fn(async () => undefined);
    const group = { pgid: 8585, startedAt: 7, identity: 'linux:00000000-0000-0000-0000-000000000000:4' };
    const x = deps(f, { remove, start: (value: AgentAdapterRequest) => {
      value.processLifecycle!.starting(); value.processLifecycle!.started(group);
      value.processLifecycle!.unsettled(group, 'group-alive');
      return { attemptId: value.invocation.attemptId, cancel: vi.fn(), settled: Promise.resolve({
        attemptId: value.invocation.attemptId, context: value.invocation.context, exitCode: null, signal: null,
        stopReason: 'capture-failure', stdout: '', stderr: '',
      }) };
    } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1,
        metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve(input(f))).rejects.toThrow(/startup recovery/);
    expect(remove).not.toHaveBeenCalled();
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ processGroup: group,
      conflict: { source: oid(2) } });
  });

  it('refuses a symlink-valued .gitmodules result before host copyback', async () => {
    const f = fixture(); symlinkSync('original', join(f.repository, '.gitmodules'));
    const x = deps(f, {
      inspect: async () => manifest([{ path: '.gitmodules', kind: 'modify', oldType: 'symlink', newType: 'symlink', underGit: false, ignored: false }]),
      exportPaths: async () => [{ path: '.gitmodules', type: 'symlink', content: Buffer.from('replacement') }],
    });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    await expect(resolve({ ...input(f), files: ['.gitmodules'] })).rejects.toThrow(/symlink named .gitmodules/);
    expect(readlinkSync(join(f.repository, '.gitmodules'))).toBe('original');
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null });
  });

  it('cancels and awaits the child before releasing storage and durable ownership', async () => {
    const f = fixture(), controller = new AbortController(), settled = Promise.withResolvers<InvocationResult>();
    const cancel = vi.fn((reason: InvocationResult['stopReason']) => settled.resolve({ attemptId: request!.invocation.attemptId,
      context: request!.invocation.context, exitCode: null, signal: 'SIGTERM', stopReason: reason, stdout: '', stderr: '' }));
    let request: AgentAdapterRequest | undefined;
    const x = deps(f, { start: (value: AgentAdapterRequest) => {
      request = value; return { attemptId: value.invocation.attemptId, cancel, settled: settled.promise };
    } });
    const resolve = createForeignConflictResolver({ store: f.store, identity, planKey: f.planKey,
      repository: { path: join(f.root, 'bare.git') } as RunnerRepository, runnerOwner: 'a'.repeat(32),
      image: () => 'sha256:' + 'b'.repeat(64), token: 'secret', limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, deps: x.d as never });
    const running = resolve(input(f, controller.signal));
    await vi.waitFor(() => expect(request).toBeDefined());
    controller.abort(Object.assign(new Error('cancel'), { code: 'ABORT_ERR' }));
    await expect(running).rejects.toThrow(/failed/);
    expect(cancel).toHaveBeenCalledWith('cancelled');
    expect(x.events.at(-1)).toBe('remove');
    expect(f.store.getTask(identity).rebaseInProgress).toMatchObject({ conflict: null });
  });
});

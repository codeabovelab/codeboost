import { randomUUID } from 'node:crypto';
import { chmodSync, constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, readlinkSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import { captureInvocation, type InvocationHandle, type TaskClone } from '../agents/contract.ts';
import { checkConflictTree, inspectTaskChanges, MAXIMUM_DECLARED_LINKS, MAXIMUM_NAME_BYTES, snapshotDeclaredLinks,
  type TaskChangeManifest, type TaskTreeCheck } from '../agents/container/changes.ts';
import { exportTaskPaths, prepareTaskFilesystemsAsync, removeTaskFilesystemsAsync,
  type ExportedTaskPath, type PreparationOptions, type TaskFilesystems, type TaskStorageLimits } from '../agents/container/storage.ts';
import { DEFAULT_PROCESS_SETTLEMENT_MS, type ProcessGroup } from '../agents/process-group.ts';
import { runTrackedProcess, type ProcessGroupLifecycle } from '../agents/tracked-docker.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { createTaskCloneAsync } from '../git/clone.ts';
import { sameContext } from './lifecycle.ts';
import { RebaseResourcesUnsettled, type RebaseConflictInput } from './rebase.ts';
import type { RunnerRepository } from './runner-repository.ts';
import type { Store } from './store.ts';

export const MAX_CONFLICT_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_CONFLICT_PATH_BYTES = 32 * 1024;
// Reserve the tracked process's complete default stop/drain/pipe budget, plus one second for durable settlement writes.
export const CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS = DEFAULT_PROCESS_SETTLEMENT_MS + 1_000;
const SCHEMA = '{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"codeboost conflict resolution summary","type":"string"}\n';

interface ResolverDeps {
  clone(options: Parameters<typeof createTaskCloneAsync>[0]): Promise<TaskClone>;
  allocate: typeof prepareTaskFilesystemsAsync;
  snapshotLinks: typeof snapshotDeclaredLinks;
  checkTree: typeof checkConflictTree;
  start(request: AgentAdapterRequest, token: string): InvocationHandle;
  inspect: typeof inspectTaskChanges;
  exportPaths: typeof exportTaskPaths;
  remove(filesystems: TaskFilesystems, options?: PreparationOptions): Promise<void>;
  removeStaging(path: string, timeoutMs: number, lifecycle: ProcessGroupLifecycle): Promise<void>;
}
const REMOVE_STAGING_SCRIPT = "const fs=require('node:fs');fs.rmSync(fs.readFileSync(0,'utf8'),{recursive:true,force:true})";
const defaults: ResolverDeps = {
  clone: createTaskCloneAsync, allocate: prepareTaskFilesystemsAsync, snapshotLinks: snapshotDeclaredLinks,
  checkTree: checkConflictTree, start: startClaudeInvocation, inspect: inspectTaskChanges,
  exportPaths: exportTaskPaths, remove: removeTaskFilesystemsAsync,
  removeStaging: async (path, timeoutMs, lifecycle) => {
    const outcome = await runTrackedProcess(process.execPath, ['-e', REMOVE_STAGING_SCRIPT], {
      cwd: dirname(path), env: {}, input: Buffer.from(path), timeoutMs, lifecycle,
    });
    if (outcome.status !== 0) throw new Error('Conflict staging cleanup did not settle.',
      { cause: outcome.error ?? new Error(outcome.stderr.trim() || `node exited with status ${outcome.status}.`) });
  },
};

export interface ForeignConflictResolverOptions {
  readonly store: Store;
  readonly identity: PlanIdentity;
  readonly planKey: string;
  readonly repository: RunnerRepository;
  readonly runnerOwner: string;
  /** Lazy so startup recovery can construct the rebaser without building an image merely to abort it. */
  readonly image: () => string;
  readonly token: string;
  readonly limits: TaskStorageLimits;
  readonly deps?: Partial<ResolverDeps>;
}

const assertRelativePath = (path: string): string[] => {
  if (!path || path.startsWith('/') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/u.test(path)
      || Buffer.byteLength(path) > MAXIMUM_NAME_BYTES || path.split('/')[0] === '.git'
      || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Conflict path ${JSON.stringify(path)} is invalid.`);
  return path.split('/');
};

function assertConflictPathSet(paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAXIMUM_DECLARED_LINKS)
    throw new Error(`Conflict paths must contain between 1 and ${MAXIMUM_DECLARED_LINKS} entries.`);
  let pathBytes = 0;
  for (const path of paths) {
    assertRelativePath(path);
    pathBytes += Buffer.byteLength(path);
    if (pathBytes > MAX_CONFLICT_PATH_BYTES)
      throw new Error(`Conflict paths exceed the ${MAX_CONFLICT_PATH_BYTES}-byte command-input limit.`);
  }
  if (new Set(paths).size !== paths.length) throw new Error('Conflict paths must not repeat.');
}

function assertAncestors(root: string, parts: readonly string[]): void {
  let current = root;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Conflict snapshot root is not a plain directory.');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Conflict path ancestor ${JSON.stringify(part)} is not a plain directory.`);
  }
}

function prepareDestinationAncestors(root: string, parts: readonly string[], createMissing: boolean): boolean {
  let current = root;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Conflict snapshot root is not a plain directory.');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (!createMissing) return false;
      mkdirSync(current, { mode: 0o755 });
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Conflict path ancestor ${JSON.stringify(part)} is not a plain directory.`);
  }
  return true;
}

function readEntry(root: string, path: string, remaining: number): ExportedTaskPath {
  const parts = assertRelativePath(path);
  assertAncestors(root, parts);
  const target = join(root, ...parts), stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return Object.freeze({ path, type: 'absent' });
  let content: Buffer;
  if (stat.isSymbolicLink()) content = Buffer.from(readlinkSync(target, { encoding: 'buffer' }));
  else if (stat.isFile()) {
    if (stat.size > remaining) throw new Error('Conflict snapshot exceeds its byte limit.');
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error('Conflict snapshot entry changed while it was read.');
      content = readFileSync(fd);
    } finally { closeSync(fd); }
  } else throw new Error(`Conflict path ${JSON.stringify(path)} is not a file, symlink or absence.`);
  if (content.length > remaining) throw new Error('Conflict snapshot exceeds its byte limit.');
  return Object.freeze({ path, type: stat.isSymbolicLink() ? 'symlink' : 'file',
    ...(stat.isFile() ? { executable: (stat.mode & 0o111) !== 0 } : {}), content });
}

function writeEntry(root: string, entry: ExportedTaskPath): void {
  const parts = assertRelativePath(entry.path);
  if (!prepareDestinationAncestors(root, parts, entry.type !== 'absent')) return;
  const target = join(root, ...parts), current = lstatSync(target, { throwIfNoEntry: false });
  if (current) {
    if (!current.isFile() && !current.isSymbolicLink()) throw new Error(`Conflict path ${JSON.stringify(entry.path)} became a non-file.`);
    unlinkSync(target);
  }
  if (entry.type === 'absent') return;
  if (!entry.content) throw new Error('Conflict snapshot entry has no content.');
  if (entry.type === 'symlink') symlinkSync(entry.content, target);
  else {
    writeFileSync(target, entry.content, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
    chmodSync(target, entry.executable ? 0o755 : 0o644);
  }
}

/** Copy only exact leaf entries; no ancestor symlink is followed and the complete snapshot is bounded before writes. */
export function copyConflictPaths(source: string, destination: string, paths: readonly string[],
  maxBytes = MAX_CONFLICT_SNAPSHOT_BYTES): void {
  assertConflictPathSet(paths);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFLICT_SNAPSHOT_BYTES)
    throw new Error('Invalid conflict snapshot limit.');
  const entries: ExportedTaskPath[] = [];
  let used = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path);
    if (used + pathBytes > maxBytes) throw new Error('Conflict snapshot exceeds its byte limit.');
    const entry = readEntry(source, path, maxBytes - used - pathBytes);
    used += pathBytes + (entry.content?.length ?? 0); entries.push(entry);
  }
  for (const entry of entries) writeEntry(destination, entry);
}

function assertResolvedManifest(manifest: TaskChangeManifest, files: readonly string[]): void {
  if (manifest.metadataChanged || manifest.agentCommits.length || manifest.nestedGitlinkContent.length)
    throw new Error('The conflict resolver changed protected repository state.');
  const allowed = new Set(files);
  for (const change of manifest.changes) {
    if (!allowed.has(change.path) || (change.oldPath !== undefined && !allowed.has(change.oldPath)) || change.underGit
      || [change.oldType, change.newType].some(type => type === 'gitlink' || type === 'directory' || type === 'other'))
      throw new Error(`The conflict resolver changed an unapproved path or type: ${JSON.stringify(change.path)}.`);
  }
  for (const change of manifest.linkTargetChanges)
    if (!allowed.has(change.link) || change.change !== 'retargeted')
      throw new Error(`The conflict resolver wrote through a symbolic link: ${JSON.stringify(change.link)}.`);
}

const stopReason = (signal: AbortSignal) =>
  (signal.reason as { code?: unknown } | undefined)?.code === 'ETIMEDOUT' ? 'timeout' as const : 'cancelled' as const;

export function createForeignConflictResolver(options: ForeignConflictResolverOptions): (input: RebaseConflictInput) => Promise<void> {
  const deps = { ...defaults, ...options.deps };
  return async input => {
    assertConflictPathSet(input.files);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseHead)) throw new Error('Conflict base must be a full commit ID.');
    const wallRemaining = input.deadline - Date.now();
    if (!Number.isSafeInteger(input.deadline) || !Number.isSafeInteger(wallRemaining) || wallRemaining < 1)
      throw new Error('Conflict deadline has passed.');
    // Convert the caller's wall-clock transport value once. Every later stage shares this monotonic boundary even if
    // the system clock moves; wall time is reconstructed only for the child invocation contract.
    const deadline = performance.now() + wallRemaining;
    // A pre-cancelled request owns nothing: check immediately before the first durable child claim.
    input.signal?.throwIfAborted();
    const childAttemptId = randomUUID(), allocationId = randomUUID(), networkAllocationId = randomUUID();
    options.store.beginRebaseConflict(options.planKey, input.attemptId,
      { attemptId: childAttemptId, allocationId, networkAllocationId, source: input.commit });
    const staging = join(input.repository, `.codeboost-conflict-${childAttemptId}`);
    let filesystems: TaskFilesystems | undefined, primary: unknown, handle: InvocationHandle | undefined, retainOwnership = false;
    let imageId = '';
    let processGroup: ProcessGroup | 'spawning' | 'unsettled' | null = null;
    const processLifecycle: ProcessGroupLifecycle = {
      starting: () => {
        if (retainOwnership || processGroup !== null)
          throw new Error('A prior conflict subprocess has not settled; no later subprocess may start.');
        options.store.setRebaseProcessGroup(options.planKey, input.attemptId, processGroup, 'spawning');
        processGroup = 'spawning';
      },
      started: group => {
        options.store.setRebaseProcessGroup(options.planKey, input.attemptId, processGroup, group);
        processGroup = group;
      },
      settled: owner => {
        options.store.setRebaseProcessGroup(options.planKey, input.attemptId, owner, null);
        processGroup = null;
      },
      unsettled: (owner, reason) => {
        retainOwnership = true;
        if (reason === 'stdio-held' && owner !== 'spawning') {
          options.store.setRebaseProcessGroup(options.planKey, input.attemptId, owner, 'unsettled');
          processGroup = 'unsettled';
        }
      },
    };
    const deadlineError = () => Object.assign(new Error('Conflict child settlement exceeded the rebase work deadline.'),
      { code: 'ETIMEDOUT' });
    const operationBudget = () => {
      const remaining = Math.floor(deadline - performance.now() - CONFLICT_PROCESS_SETTLEMENT_RESERVE_MS);
      if (remaining < 1) throw deadlineError();
      return remaining;
    };
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) {
        retainOwnership = true;
        void operation.catch(() => { /* durable recovery owns any late result */ });
        throw new RebaseResourcesUnsettled('Conflict child settlement exceeded the rebase work deadline.');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          retainOwnership = true;
          handle?.cancel('timeout');
          reject(new RebaseResourcesUnsettled('Conflict child settlement exceeded the rebase work deadline.'));
        }, remaining);
      });
      try { return await Promise.race([operation, expired]); }
      finally {
        if (timer) clearTimeout(timer);
        if (retainOwnership) void operation.catch(() => { /* durable recovery owns any late result */ });
      }
    };
    try {
      imageId = options.image();
      input.signal?.throwIfAborted();
      mkdirSync(staging, { mode: 0o700 });
      const clone = await bounded(deps.clone({ source: options.repository.path, parent: staging,
        taskId: options.planKey, head: input.baseHead, timeoutMs: operationBudget(), signal: input.signal, processLifecycle }));
      copyConflictPaths(input.repository, clone.directory, input.files);
      try {
        filesystems = await bounded(deps.allocate(clone, options.limits, imageId,
          { runnerOwner: options.runnerOwner, attemptId: childAttemptId, allocationId },
          { signal: input.signal, processLifecycle, timeoutMs: operationBudget() }));
      } catch (error) {
        if (error instanceof AggregateError) retainOwnership = true;
        throw error;
      }
      const links = await bounded(deps.snapshotLinks(filesystems!, input.files,
        { imageId, signal: input.signal, processLifecycle, timeoutMs: operationBudget() }));
      const treeCheck: TaskTreeCheck = await bounded(deps.checkTree(filesystems!,
        { base: input.baseHead, paths: input.files, imageId, signal: input.signal, processLifecycle,
          timeoutMs: operationBudget() }));
      const inputDirectory = join(staging, 'input');
      mkdirSync(inputDirectory, { mode: 0o755 });
      writeFileSync(join(inputDirectory, 'schema.json'), SCHEMA, { mode: 0o444, flag: 'wx' });
      chmodSync(join(inputDirectory, 'schema.json'), 0o444);
      const context = options.store.currentContext(options.identity);
      const invocation = captureInvocation({ clone, phase: 'fix', vendor: 'claude', approvedArgv: [],
        deadline: Date.now() + operationBudget(),
        attemptId: childAttemptId, runnerOwner: options.runnerOwner, context });
      const prompt = `Resolve the in-progress rebase conflict in exactly these paths: ${JSON.stringify(input.files)}. `
        + 'Edit only those paths. Do not create commits or change repository metadata. Preserve the intent of both sides and leave each path in its final resolved form.';
      handle = deps.start({ invocation, filesystems, inputDirectory, imageId, prompt,
        networkAllocationId, treeCheck, cleanupRoot: staging, processLifecycle }, options.token);
      const cancel = () => handle!.cancel(stopReason(input.signal!));
      if (input.signal?.aborted) cancel(); else input.signal?.addEventListener('abort', cancel, { once: true });
      const result = await bounded(handle.settled).finally(() => input.signal?.removeEventListener('abort', cancel));
      if (processGroup !== null) {
        retainOwnership = true;
        throw new Error('The conflict resolver could not confirm settlement of its Docker client.');
      }
      if (result.unreleased !== undefined) {
        retainOwnership = true;
        throw new Error('The conflict resolver could not confirm removal of its container resources.');
      }
      if (result.attemptId !== childAttemptId || !sameContext(result.context, context))
        throw new Error('The conflict resolver returned a result for another invocation.');
      if (result.exitCode !== 0 || result.stopReason) throw new Error(`The conflict resolver failed${result.stderr ? `: ${JSON.stringify(result.stderr.slice(0, 2048))}` : '.'}`);
      input.signal?.throwIfAborted();
      const manifest = await bounded(deps.inspect(filesystems!, { base: input.baseHead, linkSnapshot: links,
        imageId, signal: input.signal, processLifecycle, timeoutMs: operationBudget() }));
      assertResolvedManifest(manifest, input.files);
      const entries = await bounded(deps.exportPaths(filesystems!, input.files, MAX_CONFLICT_SNAPSHOT_BYTES,
        { imageId, signal: input.signal, processLifecycle, timeoutMs: operationBudget() }));
      input.signal?.throwIfAborted();
      if (entries.length !== input.files.length || entries.some((entry, index) => entry.path !== input.files[index]))
        throw new Error('The conflict export did not return the exact approved path set.');
      let exportedBytes = 0;
      for (const entry of entries) {
        if (!['absent', 'file', 'symlink'].includes(entry.type)
          || (entry.type === 'absent' ? entry.content !== undefined || entry.executable !== undefined
            : !Buffer.isBuffer(entry.content) || (entry.type === 'file' ? typeof entry.executable !== 'boolean' : entry.executable !== undefined)))
          throw new Error('The conflict export returned a malformed entry.');
        if (entry.path === '.gitmodules' && entry.type === 'symlink')
          throw new Error('The conflict resolver cannot produce a symlink named .gitmodules.');
        exportedBytes += Buffer.byteLength(entry.path) + (entry.content?.length ?? 0);
        if (exportedBytes > MAX_CONFLICT_SNAPSHOT_BYTES) throw new Error('The conflict export exceeded its byte limit.');
      }
      for (const entry of entries) {
        if (performance.now() >= deadline) throw deadlineError();
        writeEntry(input.repository, entry);
      }
      if (performance.now() >= deadline) throw deadlineError();
    } catch (error) { primary = error; }
    const cleanup: unknown[] = [];
    if (handle && input.signal?.aborted) handle.cancel(stopReason(input.signal));
    if (filesystems && !retainOwnership) try {
      await bounded(deps.remove(filesystems!, { processLifecycle, timeoutMs: operationBudget() }));
    } catch (error) { cleanup.push(error); retainOwnership = true; }
    if (!retainOwnership) try {
      await bounded(deps.removeStaging(staging, operationBudget(), processLifecycle));
    } catch (error) { cleanup.push(error); retainOwnership = true; }
    if (!cleanup.length && !retainOwnership) {
      try { options.store.clearRebaseConflict(options.planKey, input.attemptId, childAttemptId); }
      catch (error) { cleanup.push(error); }
    }
    if (retainOwnership) throw new RebaseResourcesUnsettled(
      `Conflict resolution retained resources for startup recovery${primary instanceof Error ? `: ${primary.message}` : '.'}`,
      primary === undefined && !cleanup.length ? undefined : { cause: primary ?? cleanup[0] });
    if (primary && cleanup.length) throw new AggregateError([primary, ...cleanup], 'Conflict resolution and cleanup failed.', { cause: primary });
    if (primary) throw primary;
    if (cleanup.length > 1) throw new AggregateError(cleanup, 'Conflict resolver cleanup failed.');
    if (cleanup.length) throw cleanup[0];
  };
}

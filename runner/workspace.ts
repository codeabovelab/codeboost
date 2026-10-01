import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commitTaskChanges, inspectTaskChanges, snapshotDeclaredLinks } from '../agents/container/changes.ts';
import { prepareTaskFilesystemsAsync, removeTaskFilesystemsAsync, type TaskFilesystems, type TaskStorageLimits } from '../agents/container/storage.ts';
import type { ProcessGroup } from '../agents/process-group.ts';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { createTaskCloneAsync } from '../git/clone.ts';
import { findIdentity, type TaskWorkspace, type WorkspaceRef } from './execution.ts';
import { isUuidV4 } from './lifecycle.ts';
import { dropAttemptRef, ensureCommit, fetchTaskCommit, ownerOnlyDirectory, type RunnerRepository } from './runner-repository.ts';
import type { AttemptRecord, Store } from './store.ts';

export interface WorkspaceOptions {
  readonly store: Store;
  /** The directory startup recovery cleans: attempt directories live in `<runnerRoot>/<runnerOwner>/attempts`. */
  readonly runnerRoot: string;
  /** The database's runner token; task storage is allocated under it. */
  readonly runnerOwner: string;
  readonly repository: RunnerRepository;
  /** The immutable ID of the built agent image. */
  readonly imageId: string;
  readonly limits: TaskStorageLimits;
  /** Who runner commits are by; the date is the commit step's own time, in UTC. */
  readonly committer: { readonly name: string; readonly email: string };
  readonly now?: () => number;
}
/** What `materialize` keeps for the later steps, behind `WorkspaceRef.storage`. */
interface Held { readonly filesystems: TaskFilesystems; readonly attemptId: string; readonly identity: PlanIdentity }
const held = (workspace: WorkspaceRef) => workspace.storage as Held;

/**
 * The real task workspace over lane D (#87): a fresh clone of the runner-owned repository at the recorded head, copied
 * into bounded task storage; D's link snapshot, change inspection and runner commit; and the commit taken into the
 * runner-owned repository under the attempt's ref. The user's repository is only ever read, for base commits.
 */
export function createTaskWorkspace(options: WorkspaceOptions): TaskWorkspace {
  const { store, repository, imageId } = options;
  if (!/^[0-9a-f]{32}$/.test(options.runnerOwner)) throw new Error('Invalid runner owner token.');
  const attemptDirectory = (attemptId: string) => {
    if (!isUuidV4(attemptId)) throw new Error('Attempt ID must be a UUID v4.');
    return join(options.runnerRoot, options.runnerOwner, 'attempts', attemptId);
  };
  return {
    async materialize(attempt, head, signal) {
      const identity = findIdentity(store, attempt), directory = attemptDirectory(attempt.id);
      // Every preparation subprocess is recorded, with its own start time, so startup recovery can stop one a crash left
      // running.
      store.markPreparationStarting(identity, attempt.id, Date.now());
      let recorded = false;
      const record = (group: ProcessGroup) => { store.recordPreparationGroup(identity, attempt.id, group.pgid, group.startedAt); recorded = true; };
      try {
        await ensureCommit(repository, head, { signal, onProcessGroup: record });
        ownerOnlyDirectory(options.runnerRoot, options.runnerOwner, 'attempts');
        mkdirSync(directory, { mode: 0o700 });
        const clone = await createTaskCloneAsync({ source: repository.path, parent: directory, taskId: identityKey(identity), head,
          timeoutMs: 120_000, signal, onProcessGroup: record });
        // Saved before the allocation starts, so a crash during it still leaves a row that matches what D made.
        const allocationId = randomUUID();
        store.recordAllocation(identity, attempt.id, allocationId);
        const filesystems = await prepareTaskFilesystemsAsync(clone, options.limits, imageId,
          { runnerOwner: options.runnerOwner, attemptId: attempt.id, allocationId }, { signal, onProcessGroup: record, timeoutMs: 120_000 });
        return { clone, storage: { filesystems, attemptId: attempt.id, identity } satisfies Held };
      } catch (error) {
        // No subprocess ever started (its spawn failed at once): the "starting" marker must not block the next startup.
        if (!recorded) { try { store.cancelPreparationStart(identity, attempt.id); } catch { /* the marker stays; recovery asks a person */ } }
        throw error;
      }
    },
    async snapshotDeclaredLinks(workspace, paths, signal) {
      return snapshotDeclaredLinks(held(workspace).filesystems, paths, { imageId, signal });
    },
    async inspectChanges(workspace, input, signal) {
      return inspectTaskChanges(held(workspace).filesystems, { base: input.baseHead, linkSnapshot: input.linkSnapshot, imageId, signal });
    },
    async commit(workspace, input, signal) {
      const { filesystems, attemptId } = held(workspace);
      const date = `${Math.floor((options.now?.() ?? Date.now()) / 1000)} +0000`;
      const who = { name: options.committer.name, email: options.committer.email, date };
      const made = await commitTaskChanges(filesystems, { base: input.baseHead, linkSnapshot: input.linkSnapshot, digest: input.digest,
        message: input.message, trailers: input.trailers, author: who, committer: who, imageId, signal });
      // Nothing to commit: the caller treats an unchanged head as no commit.
      if (made.unchanged) return input.baseHead;
      await fetchTaskCommit(repository, { bundle: made.bundle, base: input.baseHead, head: made.head, attemptId }, { signal });
      return made.head;
    },
    async release(workspace) {
      const { filesystems, attemptId, identity } = held(workspace);
      // Storage first: a failure here holds the slot under a marker, and nothing below may stop the removal.
      await removeTaskFilesystemsAsync(filesystems);
      // Only a completed attempt's commit is published (its ledger entry is saved with `completed`); any other is dropped.
      // An unreadable row, or a drop that fails, keeps the ref: an unpublished commit in the runner's own repository is
      // never read, since nothing in the Store points at it.
      let completed = true;
      try { completed = store.getAttempt(identity, attemptId).state === 'completed'; } catch { /* keep it */ }
      if (!completed) await dropAttemptRef(repository, attemptId)
        .catch(error => console.error(`Runner job ${attemptId} could not drop its unpublished commit: ${JSON.stringify((error as Error).message)}`));
    },
    async cleanupPreparation(attempt: AttemptRecord) {
      const directory = attemptDirectory(attempt.id), stat = lstatSync(directory, { throwIfNoEntry: false });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The attempt path is not a plain directory.');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskClone } from '../contract.ts';
import { assertTaskClone } from '../../git/clone.ts';
import { assertBuiltAgentImage } from './image.ts';
import { createOutcomeUnknown, DOCKER_ID } from '../client-outcome.ts';
import { DockerError, pause, runDocker, type DockerOutcome } from '../docker.ts';
import { MAXIMUM_TIMER_MS, runInProcessGroup, type ProcessGroup } from '../process-group.ts';
import { TREE_SCRIPT } from './tree-script.ts';
import { ALLOCATION_IN_USE, allocationListCommands, assertResourceOwner, claimAllocationId, hasOwnerLabels,
  ownerLabelArgs, releaseAllocationId, type ResourceOwner, UUID_V4 } from '../labels.ts';

export interface TaskFilesystems {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
  readonly workBytes: number;
  readonly workInodes: number;
  readonly metadataBytes: number;
  readonly metadataInodes: number;
  /**
   * SHA-256 over every entry of the metadata volume (path, inode, mode, owner, size, ctime, mtime, link target, and a
   * file's content), taken by the seeder as its last step. F records it: `inspectTaskChanges` compares it to report any change under `.git`,
   * and needs it back for a recovery handle.
   */
  readonly metadataBaseline: string;
}
/**
 * A repository the agent cannot run on: a link that can lead out of the checkout, or any link in its Git metadata. The
 * seeder finds it; nothing was kept. Report it to the user and do not retry.
 */
export class UnusableRepositoryError extends Error {}
// The seeder's refusal (exit 11) as an UnusableRepositoryError with its reason; any other failure as it came.
function* refusedRepository<T>(steps: Steps<T>): Steps<T> {
  try { return yield* steps; }
  catch (error) {
    // Docker can print its own warnings on stderr first (a host without swap accounting, say): the reason is the
    // script's line, which starts "Repository".
    if (error instanceof DockerError && error.status === 11) {
      const reason = error.stderr.split('\n').find(line => line.startsWith('Repository ')) ?? error.stderr.trim();
      throw new UnusableRepositoryError(reason.slice(0, 2048), { cause: error });
    }
    throw error;
  }
}
export interface TaskStorageLimits {
  readonly workBytes: number;
  readonly workInodes: number;
  readonly metadataBytes: number;
  readonly metadataInodes: number;
}

interface AllocationIdentity {
  /** The runner, attempt and allocation written on every volume and container of this allocation. */
  readonly owner: ResourceOwner;
  readonly clone: Readonly<TaskClone>;
  /** The builder-registered clone object, whose staging directory identity is re-verified. */
  readonly trustedClone: TaskClone;
  readonly limits: Readonly<TaskStorageLimits>;
}
const allocations = new WeakMap<TaskFilesystems, AllocationIdentity>();
// Storage this process is allocating or has allocated, and has not confirmed removed (including a failed allocation
// whose cleanup did not settle), as allocation ID to runner token. Recovery never runs for a
// runner that has any, and never issues a handle for one: a running agent may mount it.
const liveAllocations = new Map<string, string>();
/** Whether this process holds task storage of this runner that it allocated and has not removed. */
export const hasLiveTaskStorage = (runnerOwner: string): boolean =>
  [...liveAllocations.values()].includes(runnerOwner);
const dockerEnvironment = () => ({ PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST });
const validLimit = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
};
const createDeadline = (timeoutMs: number) => {
  validLimit(timeoutMs, 'timeoutMs');
  // Both variants share these steps, and the asynchronous one arms Node timers, which cannot wait longer than this.
  if (timeoutMs > MAXIMUM_TIMER_MS) throw new Error(`timeoutMs must be at most ${MAXIMUM_TIMER_MS}.`);
  const deadline = performance.now() + timeoutMs;
  return () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error('Docker operation exceeded its overall deadline.');
    return value;
  };
};
/** One Docker call a storage step needs run, a wait, or a point where a long walk lets other work (and an abort) in. */
type StorageStep = { readonly args: readonly string[]; readonly timeoutMs: number; readonly cancellable: boolean;
  readonly maxBuffer?: number }
  | { readonly sleepMs: number } | typeof PAUSE;
type Steps<T> = Generator<StorageStep, T, DockerOutcome | undefined>;
const PAUSE = Symbol('pause');
/** Ask the driver to run one Docker call. Allocation calls are cancellable; cleanup calls never are. */
function* run(args: readonly string[], timeoutMs: number, cancellable: boolean,
  maxBuffer?: number): Steps<DockerOutcome> {
  return (yield { args, timeoutMs, cancellable, maxBuffer })!;
}
/** Run one Docker call that must succeed; its failure throws a `DockerError` that `createOutcomeUnknown` reads. */
function* must(args: readonly string[], timeoutMs: number): Steps<string> {
  const outcome = yield* run(args, timeoutMs, true);
  if (outcome.status !== 0) throw new DockerError(args, outcome);
  return outcome.stdout.trim();
}

// The blocking driver, for the synchronous API.
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function runSteps<T>(steps: Steps<T>): T {
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step === PAUSE) next = steps.next();
    else if ('sleepMs' in step) { sleep(step.sleepMs); next = steps.next(); }
    else {
      const result = spawnSync('docker', [...step.args], { encoding: 'utf8', timeout: step.timeoutMs, killSignal: 'SIGKILL',
        env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: step.maxBuffer ?? 16 * 1024 * 1024 });
      const error = result.error ?? (result.status === null
        ? new Error(`docker ${step.args[0] ?? ''} was killed by ${result.signal}.`) : undefined);
      next = steps.next({ status: error ? null : result.status, stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''), ...(error ? { error } : {}) });
    }
  }
  return next.value;
}

/** How the asynchronous variant runs its Docker calls. */
export interface PreparationOptions {
  /** Aborting stops the running allocation call's process group; cleanup of anything created still runs, uncancelled. */
  readonly signal?: AbortSignal;
  /** Called in the same turn as each Docker spawn with its process group, so the caller can record it durably. */
  readonly onProcessGroup?: (group: ProcessGroup) => void;
}
// The non-blocking driver: every Docker call runs in its own process group, and the promise settles only after it has
// exited. An abort reaches the generator as an error at its next cancellable call or pause, so its own cleanup runs.
async function runStepsAsync<T>(steps: Steps<T>, options: PreparationOptions): Promise<T> {
  const aborted = () => Object.assign(new Error('Task storage allocation was cancelled.'),
    { name: 'AbortError', code: 'ABORT_ERR' });
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step === PAUSE) {
      await new Promise(resolve => setImmediate(resolve));
      next = options.signal?.aborted ? steps.throw(aborted()) : steps.next();
    } else if ('sleepMs' in step) {
      await pause(step.sleepMs);
      next = steps.next();
    } else {
      next = steps.next(await runInProcessGroup('docker', step.args, { env: dockerEnvironment(),
        timeoutMs: step.timeoutMs, signal: step.cancellable ? options.signal : undefined,
        onProcessGroup: options.onProcessGroup, maxBuffer: step.maxBuffer }));
    }
  }
  return next.value;
}

const absent = (result: DockerOutcome) => result.status !== 0 && result.status !== null && !result.error
  && /No such (?:object|container|volume)/i.test(`${result.stdout}\n${result.stderr}`);
/** How long an object whose create client was killed may still materialize in the daemon. */
const CREATE_SETTLE_MS = 10_000;
// Remove one storage object found by the name this allocation gave it, once it carries all three owner labels. A
// container is then removed and confirmed by the ID just inspected, so a same-named replacement created after the
// inspect is never touched. A volume's name is its only identity and Docker has no conditional remove, so a volume
// replaced between the inspect and the remove could still be deleted; that needs someone to have deleted ours first.
// Cleanup is never cancelled: it runs to its own deadline so nothing is dropped.
function* remove(object: 'container' | 'volume', name: string, remaining: () => number, kind: string,
  owner: ResourceOwner, settleBy = 0): Steps<void> {
  let before: DockerOutcome;
  for (;;) {
    before = yield* run([object, 'inspect', name], remaining(), false);
    if (before.status === 0) break;
    if (!absent(before)) throw new Error(`Failed to establish ownership of ${kind}.`);
    // A killed create may still land; only absence after the settle window counts.
    if (performance.now() >= settleBy) return;
    yield { sleepMs: 250 };
  }
  const inspected = JSON.parse(before.stdout || '[]')[0] as
    { Id?: string; Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } } | undefined;
  const labels = inspected?.Labels ?? inspected?.Config?.Labels;
  // All three owner labels must match: the allocation ID alone is caller-chosen and could be reused elsewhere.
  if (!hasOwnerLabels(labels, owner)) throw new Error(`Refused to remove unowned ${kind}.`);
  let target = name;
  if (object === 'container') {
    if (!inspected?.Id || !DOCKER_ID.test(inspected.Id)) throw new Error(`Failed to establish the identity of ${kind}.`);
    target = inspected.Id;
  }
  const result = yield* run(object === 'container' ? ['rm', '--force', target] : ['volume', 'rm', '--force', target],
    remaining(), false);
  if (result.status === 0) return;
  if (!absent(yield* run([object, 'inspect', target], remaining(), false)))
    throw new Error(`Failed to confirm removal of ${kind}.`);
}
function* cleanup(containers: readonly string[], volumes: readonly string[], owner: ResourceOwner,
  unsettled: ReadonlySet<string> = new Set(), timeoutMs = 30_000): Steps<void> {
  const remaining = createDeadline(timeoutMs + (unsettled.size ? CREATE_SETTLE_MS : 0)), failures: unknown[] = [];
  const settleBy = (name: string) => unsettled.has(name) ? performance.now() + CREATE_SETTLE_MS : 0;
  for (const container of containers) {
    try { yield* remove('container', container, remaining, 'task container', owner, settleBy(container)); }
    catch (error) { failures.push(error); }
  }
  for (const volume of volumes) {
    try { yield* remove('volume', volume, remaining, 'task volume', owner, settleBy(volume)); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Task filesystem cleanup did not settle.');
}

export function assertTaskFilesystems(filesystems: TaskFilesystems, clone?: TaskClone): void {
  const identity = allocations.get(filesystems);
  if (!identity) throw new Error('Task filesystems were not created by the trusted allocator.');
  const { limits } = identity;
  if (filesystems.workBytes !== limits.workBytes || filesystems.workInodes !== limits.workInodes
    || filesystems.metadataBytes !== limits.metadataBytes || filesystems.metadataInodes !== limits.metadataInodes)
    throw new Error('Task filesystem limits changed after allocation.');
  if (clone && (clone.id !== identity.clone.id || clone.taskId !== identity.clone.taskId
    || clone.directory !== identity.trustedClone.directory
    || assertTaskClone(identity.trustedClone) !== identity.clone.directory || clone.head !== identity.clone.head))
    throw new Error('Task filesystems do not belong to the invocation clone.');
}

/** The metadata baseline of storage this process allocated; undefined for a recovery handle, whose F records it. */
export function taskMetadataBaseline(storage: TaskFilesystems | RecoveredTaskStorage): string | undefined {
  if (recoveredStorage.has(storage as RecoveredTaskStorage)) return undefined;
  assertTaskFilesystems(storage as TaskFilesystems);
  return (storage as TaskFilesystems).metadataBaseline;
}
/**
 * The baseline to check the metadata against: D's own for storage this process allocated (a given one must match it),
 * or the one F recorded, which a recovery handle needs. Nothing but a runner commit (#66 part 2) may change the
 * metadata after seeding, and that commit is the last step on a storage: no check runs after it.
 */
export function resolveMetadataBaseline(storage: TaskFilesystems | RecoveredTaskStorage, given: string | undefined): string {
  const known = taskMetadataBaseline(storage);
  if (given !== undefined && !/^[0-9a-f]{64}$/.test(given)) throw new Error('metadataBaseline must be the SHA-256 the storage value carried.');
  if (known && given !== undefined && given !== known)
    throw new Error('metadataBaseline does not match the one recorded when this storage was seeded.');
  const baseline = known ?? given;
  if (!baseline) throw new Error('A recovered storage handle needs the metadataBaseline F recorded at allocation.');
  return baseline;
}

/** The owner labels this task storage carries. */
export function taskFilesystemOwner(filesystems: TaskFilesystems): ResourceOwner {
  assertTaskFilesystems(filesystems);
  return allocations.get(filesystems)!.owner;
}


// Fails closed: an unanswered list cannot prove the ID is unused. Throws when more than `expected` objects carry it.
function* allocationObjects(allocationId: string, expected: number, remaining: () => number): Steps<void> {
  let found = 0;
  for (const command of allocationListCommands(allocationId)) {
    const result = yield* run(command, remaining(), true);
    // A client that was stopped (an abort or its deadline) or never started says why; a daemon answer does not.
    if (result.status === null) throw new DockerError(command, result);
    if (result.status !== 0) throw new Error('Could not confirm that allocationId is unused.');
    found += result.stdout.split('\n').filter(line => line.trim()).length;
    if (found > expected) throw new Error(ALLOCATION_IN_USE);
  }
}

/** The allocation, as a sequence of Docker calls. Both variants run these same steps; only how each call runs differs. */
function* allocation(clone: TaskClone, limits: TaskStorageLimits, imageId: string, owner: ResourceOwner,
  timeoutMs: number): Steps<TaskFilesystems> {
  owner = assertResourceOwner(owner);
  const labels = ownerLabelArgs(owner);
  for (const [name, value] of Object.entries(limits)) validLimit(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('Task filesystems require the immutable built image ID.');
  assertBuiltAgentImage(imageId);
  const staging = assertTaskClone(clone), remaining = createDeadline(timeoutMs);
  if (/[\n,]/.test(staging)) throw new Error('Staging path cannot be represented as a Docker mount.');
  if (!lstatSync(`${staging}/.git`).isDirectory()) throw new Error('Staging clone must contain standalone Git metadata.');
  const allocationId = claimAllocationId(owner.allocationId);
  // Nothing created yet: a reused ID (still labelling objects from any earlier process) is refused here.
  try { yield* allocationObjects(allocationId, 0, remaining); }
  catch (error) { releaseAllocationId(allocationId); throw error; }
  // Live from before the first create: a failed allocation whose cleanup does not settle still owns what it made.
  liveAllocations.set(allocationId, owner.runnerOwner);
  const workVolume = `codeboost-work-${randomUUID()}`, metadataVolume = `codeboost-metadata-${randomUUID()}`;
  const keeper = `codeboost-keeper-${randomUUID()}`, seeder = `codeboost-seeder-${randomUUID()}`;
  // Names whose create succeeded, or whose client was killed so the object may exist. Cleanup touches only these: a
  // create the daemon refused made nothing, and its name may belong to someone else.
  const made = new Set<string>(), unsettled = new Set<string>();
  const mine = (names: readonly string[]) => names.filter(name => made.has(name) || unsettled.has(name));
  // Run one allocation step; a client killed by its deadline or an abort leaves the daemon outcome for `name` unknown.
  // A pure create the daemon refused made nothing. A `docker run` is different: the daemon can create the container
  // and then fail to start it, so after any failure of a run whose client started, `name` may exist and cleanup
  // checks it.
  function* allocate(name: string, args: readonly string[]): Steps<string> {
    try {
      const output = yield* must(args, remaining());
      made.add(name);
      return output;
    } catch (error) {
      if (createOutcomeUnknown(error)) unsettled.add(name);
      else if (args[0] === 'run' && typeof (error as { status?: unknown }).status === 'number') made.add(name);
      throw error;
    }
  }
  try {
    for (const [kind, name, bytes, inodes] of [['work', workVolume, limits.workBytes, limits.workInodes],
      ['metadata', metadataVolume, limits.metadataBytes, limits.metadataInodes]] as const) {
      yield* allocate(name, ['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=${bytes},nr_inodes=${inodes},uid=10001,gid=10001,mode=0755,nosuid,nodev`,
        '--label', `io.codeboost.task-storage=${kind}`, ...labels, name]);
      // The check above and this create are not atomic across processes. Once our first object exists, it must be
      // the only one carrying the ID: of two racing allocations, the later check sees both and backs out.
      if (kind === 'work') yield* allocationObjects(allocationId, 1, remaining);
    }
    // Copy metadata straight to its own volume so the work allocation never holds both at once.
    const seed = ['set -eu',
      'find /run/codeboost-staging -mindepth 1 -maxdepth 1 ! -name .git'
        + ' -exec cp -a --no-preserve=ownership,timestamps -t /work/ {} +',
      'cp -a --no-preserve=ownership,timestamps /run/codeboost-staging/.git/. /metadata/', 'mkdir -p /work/.git',
      'chown -R 10001:10001 /work /metadata',
      // Refuse, before anything uses it, a repository with a link that can lead out of the checkout (or any link in its
      // metadata). Checked here, in the container, as its kernel resolves links: exact names and raw bytes, as a host
      // that folds case or decodes names would not see them.
      'perl -e "$1" links /work /metadata',
      // The copy gave every file new timestamps and inodes, so the copied index sees every tracked file as changed.
      // Refresh it once, after the chown (which changes ctimes) and a second after the copy, so no entry is racily
      // clean. The volumes stay mounted behind the keeper, so these stat values hold for later containers.
      'sleep 1',
      'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git --git-dir=/metadata --work-tree=/work -c safe.directory=*'
        + ' -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.bigFileThreshold=8m update-index -q --refresh'
        + ' >/dev/null',
      'chown 10001:10001 /metadata/index',
      // The baseline of the metadata as it now stands; from here only codeboost may change it.
      // Assigned first, so a failing digest stops the seeder with Perl's own error.
      'baseline=$(perl -e "$1" digest /metadata)', 'printf "codeboost-metadata-baseline %s\\n" "$baseline"'].join('; ');
    // Create and start separately: once the create returns, the keeper is ours by ID even if its start fails.
    const keeperId = yield* allocate(keeper, ['create', '--name', keeper, '--read-only', '--user', '10001:10001', '--network=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32', '--memory=128m', '--cpus=.25',
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--label', 'io.codeboost.task-storage=keeper', ...labels,
      '--entrypoint', 'sleep', imageId, 'infinity']);
    if (!DOCKER_ID.test(keeperId)) throw new Error('Docker did not return the created keeper ID.');
    yield* must(['start', keeperId], remaining());
    const seeded = yield* refusedRepository(allocate(seeder, ['run', '--rm', '--name', seeder, '--label', 'io.codeboost.task-storage=seeder', ...labels,
      '--read-only', '--user', '0:0', '--network=none', '--cap-drop=ALL', '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32',
      '--memory=128m', '--cpus=.25', '--mount', `type=bind,source=${staging},target=/run/codeboost-staging,readonly`,
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--entrypoint', 'sh', imageId, '-c', seed, 'seed', TREE_SCRIPT]));
    // Reject a staging directory swapped while the seeder was reading it.
    assertTaskClone(clone);
    remaining();
    const metadataBaseline = /^codeboost-metadata-baseline ([0-9a-f]{64})$/m.exec(seeded)?.[1];
    if (!metadataBaseline) throw new Error('The seeder did not report the metadata baseline.');
    const filesystems = Object.freeze({ keeper, workVolume, metadataVolume, ...limits, metadataBaseline });
    allocations.set(filesystems, Object.freeze({ owner, trustedClone: clone,
      clone: Object.freeze({ ...clone, directory: staging }), limits: Object.freeze({ ...limits }) }));
    releaseAllocationId(allocationId);
    return filesystems;
  } catch (error) {
    try { yield* cleanup(mine([seeder, keeper]), mine([metadataVolume, workVolume]), owner, unsettled); }
    // Still live: this process owns whatever cleanup could not remove, and reports it through the error.
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Task allocation failed and cleanup did not settle.'); }
    liveAllocations.delete(allocationId);
    releaseAllocationId(allocationId);
    throw error;
  }
}

/**
 * Copy a staging clone into bounded, engine-owned task storage and keep it mounted. `owner` is recorded by the caller
 * before this call: every volume and container is labelled with its runner, attempt and allocation, so recovery after
 * a crash finds exactly this storage. An allocation ID is used once; a reused ID is refused before anything is created.
 * Blocks the event loop while it runs; the runner uses `prepareTaskFilesystemsAsync`.
 */
export function prepareTaskFilesystems(clone: TaskClone, limits: TaskStorageLimits,
  imageId: string, owner: ResourceOwner, timeoutMs = 60_000): TaskFilesystems {
  return runSteps(allocation(clone, limits, imageId, owner, timeoutMs));
}

/**
 * `prepareTaskFilesystems` without blocking the event loop. Each Docker call runs in its own process group, reported
 * through `onProcessGroup`. An abort stops the running call's group (SIGTERM, then SIGKILL after 5 s); the allocation
 * then removes what it created, uncancelled and within its own cleanup deadline, and the promise rejects only after
 * every group has exited. A create cut short by the abort counts as possibly created, as for a killed client.
 */
export async function prepareTaskFilesystemsAsync(clone: TaskClone, limits: TaskStorageLimits, imageId: string,
  owner: ResourceOwner, options: PreparationOptions & { readonly timeoutMs?: number } = {}): Promise<TaskFilesystems> {
  if (options.signal?.aborted)
    throw Object.assign(new Error('Task storage allocation was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  try { return await runStepsAsync(allocation(clone, limits, imageId, owner, options.timeoutMs ?? 60_000), options); }
  catch (error) {
    // However the abort surfaced, it is a cancel. A cleanup that did not settle stays an AggregateError: the caller
    // must still learn what may be left.
    if (options.signal?.aborted && !(error instanceof AggregateError) && (error as Error | undefined)?.name !== 'AbortError')
      throw Object.assign(new Error('Task storage allocation was cancelled.', { cause: error }),
        { name: 'AbortError', code: 'ABORT_ERR' });
    throw error;
  }
}

/**
 * Task storage that `recoverLeftovers` found after a restart, when the `TaskFilesystems` value that allocated it is
 * gone. A crash during allocation can leave any subset of the parts, so each is optional. D issues a handle only after
 * checking that every part carries this runner, attempt and allocation, and only a handle D issued is accepted.
 */
export interface RecoveredTaskStorage {
  readonly runnerOwner: string;
  readonly attemptId: string;
  readonly allocationId: string;
  readonly workVolume?: string;
  readonly metadataVolume?: string;
  readonly keeper?: string;
}
export type TaskStorageParts = Pick<RecoveredTaskStorage, 'workVolume' | 'metadataVolume' | 'keeper'>;
// Each issued handle's owner, and the keeper's ID from the inspect that checked it: cleanup removes that keeper by ID,
// so a same-named replacement created later is never touched.
const recoveredStorage = new WeakMap<RecoveredTaskStorage, { owner: ResourceOwner; keeperId?: string }>();
/** The daemon answered, and the storage is not what D creates for this owner; unlike a failed inspect, retrying won't help. */
export class RecoveredStorageRejected extends Error {}
const STORAGE_PARTS = Object.freeze([
  // Exactly the names `prepareTaskFilesystems` generates: a fixed prefix and a UUID v4.
  ['workVolume', 'volume', 'work', new RegExp(`^codeboost-work-${UUID_V4}$`)],
  ['metadataVolume', 'volume', 'metadata', new RegExp(`^codeboost-metadata-${UUID_V4}$`)],
  ['keeper', 'container', 'keeper', new RegExp(`^codeboost-keeper-${UUID_V4}$`)],
] as const);

/**
 * Issue a recovery handle for task storage left by an earlier process. Each named part is inspected now and must be
 * the task-storage object of its kind carrying all three owner labels; otherwise nothing is issued. Storage this
 * process allocated and has not removed is refused, since a running agent may still mount it.
 */
export async function adoptRecoveredTaskStorage(owner: ResourceOwner, parts: TaskStorageParts,
  timeoutMs = 30_000, keeperId?: string): Promise<RecoveredTaskStorage> {
  try { owner = assertResourceOwner(owner); }
  catch (error) { throw new RecoveredStorageRejected((error as Error).message); }
  if (liveAllocations.has(owner.allocationId))
    throw new Error('Task storage is still live in this process; only leftovers of an earlier process are recovered.');
  if (keeperId !== undefined && (!DOCKER_ID.test(keeperId) || parts.keeper === undefined))
    throw new RecoveredStorageRejected('A keeper ID needs the keeper it names, as a full ID.');
  const remaining = createDeadline(timeoutMs), found: Record<string, string> = {};
  // Only an ID the keeper inspection below confirms is kept for cleanup.
  let confirmedKeeperId: string | undefined;
  for (const [field, object, kind, pattern] of STORAGE_PARTS) {
    const name = parts[field];
    if (name === undefined) continue;
    if (typeof name !== 'string' || !pattern.test(name))
      throw new RecoveredStorageRejected(`Recovered task ${kind} has an unexpected name.`);
    // A keeper the caller already identified is looked up by that ID, never by its reusable name: a keeper removed and
    // recreated under the same name since then is a different object, and is refused.
    const target = object === 'container' && keeperId ? keeperId : name;
    const inspect = await runDocker([object, 'inspect', target], { timeoutMs: remaining() });
    if (inspect.status !== 0) {
      if (absent(inspect))
        throw new RecoveredStorageRejected(`Recovered task ${kind} is gone.`);
      throw new Error(`Recovered task ${kind} could not be inspected.`);
    }
    const inspected = JSON.parse(inspect.stdout || '[]')[0] as { Id?: string; Name?: string;
      Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } } | undefined;
    if (object === 'container' && inspected?.Name?.replace(/^\//, '') !== name)
      throw new RecoveredStorageRejected(`Recovered task ${kind} no longer has its name.`);
    const labels = inspected?.Labels ?? inspected?.Config?.Labels;
    if (labels?.['io.codeboost.task-storage'] !== kind || !hasOwnerLabels(labels, owner))
      throw new RecoveredStorageRejected(`Recovered task ${kind} does not carry this owner's task-storage labels.`);
    if (object === 'container') {
      if (!inspected?.Id || !DOCKER_ID.test(inspected.Id) || (keeperId && inspected.Id !== keeperId))
        throw new RecoveredStorageRejected(`Recovered task ${kind} has no full ID, or changed.`);
      confirmedKeeperId = inspected.Id;
    }
    found[field] = name;
  }
  if (!Object.keys(found).length) throw new RecoveredStorageRejected('Recovered task storage names no parts.');
  const handle: RecoveredTaskStorage = Object.freeze({ runnerOwner: owner.runnerOwner, attemptId: owner.attemptId,
    allocationId: owner.allocationId, ...found });
  recoveredStorage.set(handle, { owner, keeperId: confirmedKeeperId });
  return handle;
}

/** Whether a value is a recovery handle D issued and has not yet released. */
export const isRecoveredTaskStorage = (value: unknown): value is RecoveredTaskStorage =>
  typeof value === 'object' && value !== null && recoveredStorage.has(value as RecoveredTaskStorage);

/**
 * Remove task storage: the value `prepareTaskFilesystems` returned, or a recovery handle from `recoverLeftovers`.
 * Every part must still carry its owner labels; the handle stays valid until removal is confirmed.
 */
export function removeTaskFilesystems(filesystems: TaskFilesystems | RecoveredTaskStorage): void {
  const recovered = recoveredStorage.get(filesystems as RecoveredTaskStorage);
  if (recovered) {
    const handle = filesystems as RecoveredTaskStorage;
    runSteps(cleanup(recovered.keeperId ? [recovered.keeperId] : [],
      [handle.metadataVolume, handle.workVolume].filter((name): name is string => name !== undefined), recovered.owner));
    recoveredStorage.delete(handle);
    return;
  }
  const allocated = filesystems as TaskFilesystems;
  assertTaskFilesystems(allocated);
  const owner = taskFilesystemOwner(allocated);
  runSteps(cleanup([allocated.keeper], [allocated.metadataVolume, allocated.workVolume], owner));
  allocations.delete(allocated);
  liveAllocations.delete(owner.allocationId);
}

/** At most this much diff is returned; the caller saves it as a stopped attempt's partial output. */
export const MAXIMUM_EXPORT_BYTES = 1024 * 1024;
export interface TaskDiff {
  /** The diff's raw bytes, at most `maxBytes`. It is not necessarily valid UTF-8. */
  readonly diff: Buffer;
  /** Whether the diff was longer than `maxBytes` and was cut. */
  readonly truncated: boolean;
}
export interface ExportOptions extends PreparationOptions {
  /** The commit the storage was seeded from (the clone's head): a full commit ID. */
  readonly base: string;
  /** The immutable ID of the built agent image, whose Git runs the export. */
  readonly imageId: string;
  /** Default and maximum `MAXIMUM_EXPORT_BYTES`. */
  readonly maxBytes?: number;
  /** Overall deadline for the Docker work, cleanup excluded. Default 60 s. */
  readonly timeoutMs?: number;
  /** The storage's `metadataBaseline`, which F recorded at allocation. Required for a recovery handle. */
  readonly metadataBaseline?: string;
}
// Runs as the task-storage user with both volumes read-only. It writes nothing to either volume. It first checks the
// metadata against the seeder's baseline: agents cannot write it, so an agent's work is edits and new files, never
// commits or staging, and a change means a protection failed and no Git command may run. `git diff --binary` compares
// `base` with the working tree without refreshing the real index (GIT_OPTIONAL_LOCKS=0), and new untracked files are
// diffed through a
// separate intent-to-add index in /tmp. An untracked nested repository, which Git cannot diff, is named in a
// notice line instead, quoted so an agent-chosen name cannot forge diff lines. Output stops at
// `limit` bytes inside the container, so the Docker work is bounded too, and is base64-encoded so any bytes survive.
// Every stage's status is checked: a Git failure fails the export instead of passing off partial output as the diff;
// only SIGPIPE (141) from the producer is expected, when `head` stops reading at the limit. A Git warning that it could
// not read a directory or path also fails it, since Git then diffs that path as absent; other warnings do not.
// Repository config is trusted: only codeboost writes the metadata volume, which every agent container mounts
// read-only. Worktree attributes are the agent's. A filter or diff driver needs config to run anything; external diff
// programs and text conversion are off, and the worktree and attributes file are pinned. Two built-in attributes still
// change what the diff shows without config (`ident` collapses `$Id: ... $`, `working-tree-encoding` re-encodes), so a
// changed or new file with either set is named in a notice. Line-ending attributes change only line endings, and
// overriding them would make every file a repository checks out with CRLF look changed, so they are left alone. A populated submodule's
// own config is the agent's, so Git never looks inside one: every diff passes --ignore-submodules on the command line,
// which, unlike the config default, overrides the worktree's .gitmodules and applies to plumbing diff-index too. A
// submodule's pointer change is still exported, but no `git status` runs inside it, and so none of its filters. core.safecrlf is off
// so ordinary line-ending attributes (`text=auto`, `eol=crlf`) do not warn on stderr and fail a correct export.
// Exported only so tests can run it with failing stand-ins for the tools it uses; `exportTaskDiff` is the entry point.
export const EXPORT_SCRIPT = [
  'set -eu',
  'base=$1 limit=$2 baseline=$3 tree=$4',
  '# Before any Git command, the metadata must be as the seeder left it: Git reads its config, and config the agent',
  '# could have changed must never run.',
  'digest=$(perl -e "$tree" digest /work/.git)',
  'if [ "$digest" != "$baseline" ]; then echo "the metadata changed since the storage was seeded; the diff was not exported" >&2; exit 10; fi',
  'export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1',
  'cd /work',
  'g() { git --no-pager --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.worktree=/work \\',
  '  -c core.attributesFile=/dev/null -c core.safecrlf=false -c core.bigFileThreshold=8m -c core.ignorecase=false "$@"; }',
  'g cat-file -e "$base^{commit}" 2>/dev/null || { echo "base $base is not a commit in this task storage" >&2; exit 3; }',
  'produce() {',
  '  set -eo pipefail',
  '  # A tracked file inside a directory Git cannot search looks deleted, and Git says nothing when that directory is',
  '  # ignored. For every tracked file that looks deleted, a directory above it that exists but cannot be read or',
  '  # searched means the file was not read, not deleted. One perl pass reads the list at C speed and tests each',
  '  # directory once, from the top down: at a symlink or a missing directory it stops, since what is behind is not part',
  '  # of the worktree and Git correctly reports it as deleted (lstat follows a symlink in the middle of a path, so',
  '  # testing from the bottom up would reach behind one). Its message takes the form of Git\'s own read failures, the',
  '  # path escaped onto one line, so the stderr filter keeps it. Git\'s own lstat errors here go through that filter.',
  '  g ls-files -z --deleted | perl -0 -ne \'chomp; my @parts = split m{/}; pop @parts; my $p = "";',
  '    for my $part (@parts) { $p = $p eq "" ? $part : "$p/$part";',
  '      my $s = $state{$p} //= (-l $p ? "link" : !-d _ ? "gone" : (!-r _ || !-x _) ? "unreadable" : "ok");',
  '      last if $s eq "link" || $s eq "gone";',
  '      if ($s eq "unreadable") { (my $q = $p) =~ s/([^\\w.\\/ -])/sprintf("\\\\x%02x", ord $1)/ge;',
  '        print STDERR "warning: could not open directory \\x27$q\\x27: Permission denied\\n"; exit 6 } }\'',
  '  # Git reads, and for --binary compresses, a whole file before it writes any of its diff, so the output limit does',
  '  # not bound a large file: it can exhaust memory or the deadline. A changed file whose base or worktree version is',
  '  # over 8 MiB, far past the 1 MiB the export returns, is named in a notice instead and excluded from the diff. Its',
  '  # base size comes from one ls-tree pass, its worktree size from lstat; a symlink is never followed. The candidates',
  '  # come from plumbing diff-index, which lists a file whose stat changed without reading it to compare (porcelain',
  '  # git diff would read both versions of a touched, same-size file in full), so the list may include a large file',
  '  # that did not really change.',
  '  g diff-index --ignore-submodules=all --name-only -z --no-renames "$base" -- > /tmp/export-changed',
  '  : > /tmp/export-large',
  '  g ls-tree -r -l -z "$base" | perl -0 -e \'open(my $c, "<", "/tmp/export-changed") or die; my %base;',
  '    my @changed = map { chomp; $_ } <$c>; my %wanted = map { $_ => 1 } @changed;',
  '    while (<STDIN>) { chomp; my ($meta, $path) = split /\\t/, $_, 2;',
  '      my $size = (split / +/, $meta)[3]; $base{$path} = $size if $wanted{$path} && $size =~ /^\\d+$/ }',
  '    open(my $large, ">", "/tmp/export-large") or die;',
  '    for my $path (@changed) { my $here = (!-l $path && -f _) ? -s _ : 0;',
  '      print $large "$path\\0" if ($base{$path} // 0) > 8388608 || $here > 8388608 }',
  '    close($large) or die\'',
  '  # Tracked changes: the real index, read only, without the large files.',
  '  excluded=()',
  '  while IFS= read -r -d "" path; do excluded+=(":(exclude,literal)$path"); done < /tmp/export-large',
  '  if [ "${#excluded[@]}" -gt 1000 ]; then exit 7; fi',
  '  g diff --ignore-submodules=dirty --binary --no-color --no-ext-diff --no-textconv "$base" -- . \\',
  '    ${excluded[@]+"${excluded[@]}"}',
  '  # One perl pass splits the untracked list at C speed, reading all of it so Git never writes to a closed pipe:',
  '  # nested repositories (the only entries ending in /) and the first 20,000 other paths. Each of those adds at least',
  '  # about 60 bytes of diff, so past the cap the output already exceeds 1 MiB and is marked truncated.',
  '  g ls-files -z --others --exclude-standard | perl -0 -ne \'BEGIN { open(N, ">", "/tmp/export-nested") or die;',
  '    open(A, ">", "/tmp/export-new") or die; open(L, ">>", "/tmp/export-large") or die;',
  '    open(R, ">", "/tmp/export-reserved") or die }',
  '    if (m{/\\0\\z}) { print N $_ } else { (my $path = $_) =~ s/\\0\\z//;',
  '      my @part = split m{/}, $path;',
  '      if ((grep { lc eq ".git" } @part) || (-l $path && lc $part[-1] eq ".gitmodules")) { print R $_ }',
  '      elsif (!-l $path && -f _ && -s _ > 8388608) { print L $_ } elsif ($n++ < 20000) { print A $_ } }',
  '    END { close(N) or die; close(A) or die; close(L) or die; close(R) or die }\'',
  '  # Git refuses to index a path with a part named .git, or a symlink named .gitmodules, in any case; such a path is',
  '  # named in a notice.',
  '  while IFS= read -r -d "" path; do',
  '    printf "codeboost: untracked %q is a name Git will not add; it is not exported\\n" "$path"',
  '  done < /tmp/export-reserved',
  '  # Git silently skips more than the nested repositories above. It never lists an entry named .git anywhere, or',
  '  # anything inside one, and it never looks for new files in a directory that holds a repository, even a tracked',
  '  # directory. It skips fifos and sockets. And it skips ignored paths, under ignore files the agent controls. So one',
  '  # find pass (bounded by the work volume\'s inode limit) names every .git entry, fifo and socket, except inside an',
  '  # ignored path, an untracked nested repository or a submodule, each of which is named or exported as a whole.',
  '  # Ignored untracked paths come from Git; a directory that ignores itself is listed with its contents, so an entry',
  '  # under another listed directory is dropped. find\'s own errors are about unreadable directories: one Git searches',
  '  # fails the export through Git\'s warnings, and one it does not search is inside a path already named.',
  '  g ls-files -z --others --ignored --exclude-standard --directory | perl -0 -ne \'chomp; push @all, $_;',
  '    END { my %dir = map { $_ => 1 } grep { m{/\\z} } @all; open(my $out, ">", "/tmp/export-ignored") or die;',
  '      PATH: for my $path (@all) { my @part = split m{/}, $path; pop @part; my $p = "";',
  '        for my $part (@part) { $p .= "$part/"; next PATH if $dir{$p} } print $out "$path\\0" }',
  '      close($out) or die }\'',
  '  g ls-files -z --stage > /tmp/export-stage',
  '  # The task clone is not recursive, so a submodule is an empty directory. Git never lists files under it, and',
  '  # --ignore-submodules keeps it from looking inside, so anything the agent put there (files, or a repository with',
  '  # commits) would vanish. A submodule directory that is not empty, or cannot be read, is named in a notice.',
  '  perl -0 -ne \'chomp; next unless /^160000 \\S+ \\d+\\t(.*)\\z/s; my $p = $1; next if -l $p || !-d _;',
  '    my $d; my $full = !opendir($d, $p) || grep { $_ ne "." && $_ ne ".." } readdir $d;',
  '    print "$p\\0" if $full\' /tmp/export-stage > /tmp/export-gitlink',
  '  { find . -path ./.git -prune -o -name .git -print0 -prune -o \\( -type p -o -type s \\) -print0 2>/dev/null || true; } \\',
  '    | perl -0 -e \'my %skip; for my $f ("/tmp/export-ignored", "/tmp/export-nested") { open(my $h, "<", $f) or die;',
  '      while (<$h>) { chomp; $skip{$_} = 1 } }',
  '      open(my $h, "<", "/tmp/export-stage") or die; while (<$h>) { chomp; $skip{"$1/"} = 1 if /^160000 \\S+ \\d+\\t(.*)\\z/s }',
  '      open(my $out, ">", "/tmp/export-special") or die;',
  '      PATH: while (<STDIN>) { chomp; s{^\\./}{}; my $p = "";',
  '        for my $part (split m{/}) { $p .= $part; next PATH if $skip{$p} || $skip{"$p/"}; $p .= "/" }',
  '        print $out "$_\\0" } close($out) or die\'',
  '  while IFS= read -r -d "" path; do',
  '    if [ "${path##*/}" = .git ]; then',
  '      printf "codeboost: %q is a .git entry, which Git skips; nothing in it, and if it holds a repository no new file beside it, is exported\\n" "$path"',
  '    else printf "codeboost: %q is a fifo or socket; it is not exported\\n" "$path"; fi',
  '  done < /tmp/export-special',
  '  ignored=0',
  '  while IFS= read -r -d "" path; do',
  '    ignored=$((ignored + 1))',
  '    if [ "$ignored" -le 100 ]; then printf "codeboost: untracked %q is ignored; it is not exported\\n" "$path"; fi',
  '  done < /tmp/export-ignored',
  '  if [ "$ignored" -gt 100 ]; then printf "codeboost: %d more ignored untracked paths are not exported\\n" "$((ignored - 100))"; fi',
  '  # A large file, tracked or new, is named with its notice; %q keeps its agent-chosen name on one line.',
  '  while IFS= read -r -d "" path; do',
  '    printf "codeboost: %q is over 8 MiB; if it changed, its content is not exported\\n" "$path"',
  '  done < /tmp/export-large',
  '  while IFS= read -r -d "" path; do',
  '    printf "codeboost: submodule directory %q has content in the task worktree; it is not exported\\n" "$path"',
  '  done < /tmp/export-gitlink',
  '  # A changed or new file whose attributes make Git show something other than its bytes (see above).',
  '  cat /tmp/export-changed /tmp/export-new | g check-attr -z --stdin ident working-tree-encoding \\',
  '    | perl -0 -ne \'chomp; push @f, $_; if (@f == 3) { my ($path, $attr, $value) = @f; @f = ();',
  '      print "$path\\0$attr\\0" if $value ne "unspecified" && $value ne "unset" && !$seen{$path}++ }\' > /tmp/export-attrs',
  '  while IFS= read -r -d "" path && IFS= read -r -d "" attr; do',
  '    printf "codeboost: %q has the %s attribute, so its diff may not show its real bytes\\n" "$path" "$attr"',
  '  done < /tmp/export-attrs',
  '  # An untracked nested repository cannot be diffed and is named in a notice; %q keeps its name on one line.',
  '  while IFS= read -r -d "" path; do',
  '    printf "codeboost: untracked directory %q is a nested repository; its contents are not exported\\n" "$path"',
  '  done < /tmp/export-nested',
  '  # New files go, as intent-to-add entries, into a separate index in /tmp that starts empty, and a second diff compares',
  '  # the worktree with it: one Git process however many there are, and an index that grows with them, not with the',
  '  # repository. Paths are literal pathspecs, so "-" or "*" is just a name; anything Git writes goes to /tmp.',
  '  if [ -s /tmp/export-new ]; then',
  '    mkdir -p /tmp/export-objects',
  '    export GIT_INDEX_FILE=/tmp/export-index GIT_OBJECT_DIRECTORY=/tmp/export-objects',
  '    export GIT_ALTERNATE_OBJECT_DIRECTORIES=/work/.git/objects GIT_LITERAL_PATHSPECS=1',
  '    # This index is never checked out, so the Windows-only name checks guard nothing here and would refuse names',
  '    # such as GIT~1 that are ordinary files on Linux.',
  '    g -c core.protectNTFS=false add --intent-to-add --pathspec-from-file=/tmp/export-new --pathspec-file-nul',
  '    g diff --ignore-submodules=dirty --binary --no-color --no-ext-diff --no-textconv --',
  '  fi',
  '}',
  'set +e',
  '# Git only warns about a directory or path it cannot read, then diffs it as absent: untracked files vanish and tracked',
  '# ones show as deleted. Those warnings fail the export; they are matched by their whole form, anchored, never by',
  '# words a path could contain. Other messages about the agent\'s own .gitattributes or',
  '# .gitignore (a negated pattern, an encoding it cannot apply) do not: Git still reads everything. A Git error that',
  '# stops it is caught by its exit status.',
  '# stderr is filtered as it arrives, keeping at most 101 such lines, so no amount of other warnings can fill /tmp and',
  '# push a read failure out; the filter reads everything, so Git never writes to a closed stderr. Only produce\'s',
  '# stderr goes through the pipe (its stdout goes on through fd 3), and the pipeline waits for the filter to finish.',
  'filtered() {',
  '  { produce 2>&1 1>&3 3>&- | awk \'(/^warning: could not open directory \\047/ || /^error: open\\(".*"\\): / \\',
  '      || /^warning: unable to access \\047.*\\047: (Permission denied|Input\\/output error)$/ \\',
  '      || /^(error|fatal): .*Input\\/output error$/) && n < 101 { print; n++; next }',
  '    /^(error|fatal): / { before = last; last = $0 }',
  '    END { if (before != "") print before > "/tmp/export-errors"; if (last != "") print last > "/tmp/export-errors" }\' \\',
  '    > /tmp/export-failure 3>&-',
  '    # The filter writes its file when it exits; if it failed (for example /tmp full), a read failure may be missing.',
  '    local s=("${PIPESTATUS[@]}"); if [ "${s[1]}" -ne 0 ]; then return 98; fi; return "${s[0]}"; } 3>&1',
  '}',
  ': > /tmp/export-errors',
  '# tee keeps what head passed on, so SIGPIPE can be accepted only when head really stopped at the limit.',
  'filtered | head -c "$limit" | tee /tmp/export-out | base64 -w0',
  'statuses=("${PIPESTATUS[@]}")',
  'set -e',
  'if [ "${statuses[0]}" -eq 98 ]; then echo "the export could not check Git\'s warnings" >&2; exit 5; fi',
  '# Git also looks up attribute and ignore files through a symlink that replaced a tracked directory. What is behind it',
  '# is not part of the worktree (the diff shows the directory becoming a link), so a failure there is not one. Past 100',
  '# lines the rest were not kept, so that fails too.',
  'failure=""',
  'if [ "$(wc -l < /tmp/export-failure)" -gt 100 ]; then failure="more than 100 paths could not be read"; fi',
  'while [ -z "$failure" ] && IFS= read -r line; do',
  '  if [[ $line =~ ^warning:\\ unable\\ to\\ access\\ \\\'(.*)\\\':\\ (Permission\\ denied|Input/output\\ error)$ ]]; then',
  '    path=${BASH_REMATCH[1]} through_link=""',
  '    while [[ $path == */* ]]; do path=${path%/*}; if [ -L "$path" ]; then through_link=1; break; fi; done',
  '    [ -n "$through_link" ] && continue',
  '  fi',
  '  failure=$line',
  'done < /tmp/export-failure',
  'if [ -n "$failure" ]; then',
  '  echo "git could not read part of the task worktree: $(printf %s "$failure" | head -c 300 | tr -d "\\000-\\010\\013-\\037")" >&2',
  '  exit 6',
  'fi',
  'if [ "${statuses[0]}" -eq 7 ]; then echo "more than 1,000 changed files are over 8 MiB; the diff cannot be exported" >&2; exit 7; fi',
  'if [ "${statuses[0]}" -eq 141 ] && [ "$(stat -c %s /tmp/export-out)" -ne "$limit" ]; then',
  '  echo "git stopped on SIGPIPE before the output reached its limit" >&2; exit 5',
  'fi',
  'if [ "${statuses[0]}" -ne 0 ] && [ "${statuses[0]}" -ne 141 ]; then',
  '  # Git\'s last two errors say why it stopped (earlier ones can be about paths behind a symlink, which do not fail it).',
  '  # They can quote agent-chosen names, so they are cut short and kept to printable text.',
  '  detail=$(awk \'NR > 1 { printf "; " } { printf "%s", $0 }\' /tmp/export-errors | head -c 400 | tr -d "\\000-\\010\\013-\\037")',
  '  echo "git failed while exporting the diff (status ${statuses[0]})${detail:+: $detail}" >&2; exit 4',
  'fi',
  'if [ "${statuses[1]}" -ne 0 ] || [ "${statuses[2]}" -ne 0 ] || [ "${statuses[3]}" -ne 0 ]; then echo "the export pipeline failed" >&2; exit 5; fi',
].join('\n');

/** A container run over both volumes of task storage, read-only, as the storage user, with no network. */
interface StorageScript {
  /** The `io.codeboost.task-storage` kind the container carries; recovery removes a leftover one. */
  readonly kind: 'export' | 'inspect';
  /** Names the operation in messages, for example "Task diff export". */
  readonly operation: string;
  /** Ends "Task work volume is missing; ..." when a volume is gone. */
  readonly consequence: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  /** Bytes of standard output kept; more fails the run (ENOBUFS). Default 16 MiB. */
  readonly maxOutputBytes?: number;
  /** The container's memory limit. Default 256m. */
  readonly memory?: '256m' | '1g';
  /** The size of its /tmp. Default 64m. */
  readonly tmpBytes?: '64m' | '512m';
}
export interface StorageScriptOptions extends PreparationOptions {
  /** The immutable ID of the built agent image, whose tools run the script. */
  readonly imageId: string;
  /** Overall deadline for the Docker work, cleanup excluded. */
  readonly timeoutMs?: number;
}

function* storageScriptSteps(workVolume: string, metadataVolume: string, owner: ResourceOwner, script: StorageScript,
  imageId: string, timeoutMs: number): Steps<string> {
  const remaining = createDeadline(timeoutMs);
  // Mount nothing that is not this storage: each volume must still carry its kind and all three owner labels.
  for (const [name, kind] of [[workVolume, 'work'], [metadataVolume, 'metadata']] as const) {
    const inspect = yield* run(['volume', 'inspect', name], remaining(), true);
    if (inspect.status === null) throw new DockerError(['volume', 'inspect', name], inspect);
    if (inspect.status !== 0) throw new Error(`Task ${kind} volume is missing; ${script.consequence}.`);
    const labels = (JSON.parse(inspect.stdout || '[]')[0] as { Labels?: Record<string, string> } | undefined)?.Labels;
    if (labels?.['io.codeboost.task-storage'] !== kind || !hasOwnerLabels(labels, owner))
      throw new Error(`Task ${kind} volume does not carry this storage's labels.`);
  }
  const name = `codeboost-${script.kind}-${randomUUID()}`;
  let unsettled = false;
  try {
    const args = ['run', '--rm', '--name', name, '--label', `io.codeboost.task-storage=${script.kind}`, ...ownerLabelArgs(owner),
      '--read-only', '--user', '10001:10001', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=64', `--memory=${script.memory ?? '256m'}`, '--cpus=.5',
      '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${script.tmpBytes ?? '64m'}`,
      '--mount', `type=volume,source=${workVolume},target=/work,readonly`,
      '--mount', `type=volume,source=${metadataVolume},target=/work/.git,readonly`,
      '--entrypoint', script.entrypoint, imageId, ...script.args];
    const outcome = yield* run(args, remaining(), true, script.maxOutputBytes);
    if (outcome.status !== 0) {
      const error = new DockerError(args, outcome);
      // A client stopped before the daemon answered may still have started the container.
      unsettled = createOutcomeUnknown(error);
      throw error;
    }
    return outcome.stdout;
  } catch (error) {
    // `--rm` removes a container that ran to completion; one whose client was killed is still running, so remove it
    // by name once its labels are confirmed, uncancelled, before the operation settles.
    try { yield* cleanup([name], [], owner, unsettled ? new Set([name]) : new Set()); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${script.operation} failed and its container cleanup did not settle.`);
    }
    throw error;
  }
}

/**
 * Run a script over task storage (the value `prepareTaskFilesystems` returned, or a recovery handle) in a read-only
 * container with no network, and return its standard output. For D's own storage operations; not part of the contract.
 * On abort or at the deadline the client is stopped and the container, which outlives a killed client, is removed; the
 * promise settles only after both. An abort rejects with an `AbortError`, unless that container's cleanup did not
 * settle, which rejects with an `AggregateError`.
 */
export async function runStorageScript(storage: TaskFilesystems | RecoveredTaskStorage, script: StorageScript,
  options: StorageScriptOptions): Promise<string> {
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId)) throw new Error(`${script.operation} requires the immutable built image ID.`);
  assertBuiltAgentImage(options.imageId);
  let owner: ResourceOwner, workVolume: string | undefined, metadataVolume: string | undefined;
  const recovered = recoveredStorage.get(storage as RecoveredTaskStorage);
  if (recovered) {
    owner = recovered.owner;
    ({ workVolume, metadataVolume } = storage as RecoveredTaskStorage);
  } else {
    const allocated = storage as TaskFilesystems;
    owner = taskFilesystemOwner(allocated);
    ({ workVolume, metadataVolume } = allocated);
  }
  if (!workVolume || !metadataVolume) throw new Error(`Task storage has no work or metadata volume; ${script.consequence}.`);
  const cancelled = (cause?: unknown) => Object.assign(new Error(`${script.operation} was cancelled.`, { cause }),
    { name: 'AbortError', code: 'ABORT_ERR' });
  if (options.signal?.aborted) throw cancelled();
  try {
    return await runStepsAsync(storageScriptSteps(workVolume, metadataVolume, owner, script, options.imageId,
      options.timeoutMs ?? 60_000), options);
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof AggregateError) && (error as Error | undefined)?.name !== 'AbortError')
      throw cancelled(error);
    throw error;
  }
}

/**
 * Export the diff of task storage against `base`, the commit it was seeded from, for a stopped attempt's partial
 * output (#51 item 6). It accepts the value `prepareTaskFilesystems` returned or a recovery handle, runs Git in a
 * read-only container that has no network, and returns at most `maxBytes` (1 MiB at most) with `truncated` set when
 * the diff was longer. `maxBytes` bounds the returned data; `timeoutMs` and `signal` bound the Docker work. On abort or
 * at the deadline the `docker run` client is stopped and the export container, which outlives a killed client, is
 * removed; the promise settles only after both. An abort rejects with an `AbortError`, unless that container's
 * cleanup did not settle, which rejects with an `AggregateError`.
 */
export async function exportTaskDiff(storage: TaskFilesystems | RecoveredTaskStorage,
  options: ExportOptions): Promise<TaskDiff> {
  const maxBytes = options.maxBytes ?? MAXIMUM_EXPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAXIMUM_EXPORT_BYTES)
    throw new Error(`maxBytes must be a positive integer of at most ${MAXIMUM_EXPORT_BYTES}.`);
  if (typeof options.base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.base))
    throw new Error('base must be a full commit ID.');
  const baseline = resolveMetadataBaseline(storage, options.metadataBaseline);
  const stdout = await runStorageScript(storage, { kind: 'export', operation: 'Task diff export',
    consequence: 'the diff cannot be exported', entrypoint: 'bash',
    args: ['-c', EXPORT_SCRIPT, 'export', options.base, String(maxBytes + 1), baseline, TREE_SCRIPT] }, options);
  const bytes = Buffer.from(stdout.trim(), 'base64');
  return Object.freeze({ diff: bytes.subarray(0, maxBytes), truncated: bytes.length > maxBytes });
}

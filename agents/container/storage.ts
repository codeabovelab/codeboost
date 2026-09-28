import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, opendirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { TaskClone } from '../contract.ts';
import { assertTaskClone } from '../../git/clone.ts';
import { assertBuiltAgentImage } from './image.ts';
import { createOutcomeUnknown, DOCKER_ID } from '../client-outcome.ts';
import { DockerError, pause, runDocker, type DockerOutcome } from '../docker.ts';
import { runInProcessGroup, type ProcessGroup } from '../process-group.ts';
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
  const deadline = performance.now() + timeoutMs;
  return () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error('Docker operation exceeded its overall deadline.');
    return value;
  };
};
/** One Docker call a storage step needs run, a wait, or a point where a long walk lets other work (and an abort) in. */
type StorageStep = { readonly args: readonly string[]; readonly timeoutMs: number; readonly cancellable: boolean }
  | { readonly sleepMs: number } | typeof PAUSE;
type Steps<T> = Generator<StorageStep, T, DockerOutcome | undefined>;
const PAUSE = Symbol('pause');
// Entries walked between pauses, so the asynchronous variant never holds the event loop for a whole checkout.
const PAUSE_EVERY = 1_000;
/** Ask the driver to run one Docker call. Allocation calls are cancellable; cleanup calls never are. */
function* run(args: readonly string[], timeoutMs: number, cancellable: boolean): Steps<DockerOutcome> {
  return (yield { args, timeoutMs, cancellable })!;
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
        env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
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
        onProcessGroup: options.onProcessGroup }));
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

/** The owner labels this task storage carries. */
export function taskFilesystemOwner(filesystems: TaskFilesystems): ResourceOwner {
  assertTaskFilesystems(filesystems);
  return allocations.get(filesystems)!.owner;
}

const within = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const LINK_INSPECTION_LIMIT = 200_000;
// The Linux kernel gives up after 40 link hops (ELOOP); a cycle never resolves, so it cannot reach anything.
const MAXIMUM_LINK_HOPS = 40;
/**
 * Resolve a link as the container kernel will, with the checkout standing for /work. Each existing link along the way
 * is followed, `..` is applied to the resolved path, and the path must stay inside the checkout after every step.
 * Components that do not exist here are applied textually: /work mirrors the checkout, so they are missing there too,
 * and a target the host lacks (such as a container mount under /run) cannot hide an escape.
 */
const linkStaysInside = (staging: string, link: string) => {
  let current = dirname(link), hops = 0, exists = true;
  const components = readlinkSync(link).split('/');
  if (components[0] === '') return false;
  while (components.length) {
    const component = components.shift()!;
    if (component === '' || component === '.') continue;
    current = component === '..' ? dirname(current) : join(current, component);
    if (!within(staging, current)) return false;
    if (!exists || component === '..') continue;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) { exists = false; continue; }
    if (!stat.isSymbolicLink()) continue;
    if (++hops > MAXIMUM_LINK_HOPS) return true;
    const target = readlinkSync(current);
    if (target.startsWith('/')) return false;
    components.unshift(...target.split('/'));
    current = dirname(current);
  }
  return true;
};
/**
 * Refuse a checkout whose symbolic links leave it, or whose Git metadata contains any link. The seeder copies links as
 * links, so an absolute or escaping link would let a path-restricted agent tool read container files outside the
 * checkout (for example process environments that hold vendor credentials). Worktree links that stay inside, including
 * loops and not-yet-existing targets, are allowed.
 */
function* containedLinks(staging: string, remaining: () => number): Steps<void> {
  const metadata = join(staging, '.git'), pending = [staging];
  // `walked` counts every entry touched, including each one read from a directory, so one huge directory pauses too.
  let count = 0, walked = 0;
  while (pending.length) {
    remaining();
    count++;
    if (++walked % PAUSE_EVERY === 0) yield PAUSE;
    const path = pending.pop()!, stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const name = JSON.stringify(relative(staging, path));
      // Git never needs links in its own metadata, which is mounted at /work/.git; refuse any, wherever it points.
      if (within(metadata, path)) throw new Error(`Repository Git metadata contains a link ${name}.`);
      if (!linkStaysInside(staging, path)) throw new Error(`Repository link ${name} leaves the checkout.`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const directory = opendirSync(path, { bufferSize: 1 });
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        // Bound time and memory per entry, so one huge directory cannot defer the deadline or the entry limit.
        remaining();
        if (count + pending.length >= LINK_INSPECTION_LIMIT)
          throw new Error('Repository checkout exceeds the link inspection limit.');
        pending.push(join(path, entry.name));
        if (++walked % PAUSE_EVERY === 0) yield PAUSE;
      }
    } finally { directory.closeSync(); }
  }
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
  yield* containedLinks(staging, remaining);
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
      'chown -R 10001:10001 /work /metadata'].join('; ');
    // Create and start separately: once the create returns, the keeper is ours by ID even if its start fails.
    const keeperId = yield* allocate(keeper, ['create', '--name', keeper, '--read-only', '--user', '10001:10001', '--network=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32', '--memory=128m', '--cpus=.25',
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--label', 'io.codeboost.task-storage=keeper', ...labels,
      '--entrypoint', 'sleep', imageId, 'infinity']);
    if (!DOCKER_ID.test(keeperId)) throw new Error('Docker did not return the created keeper ID.');
    yield* must(['start', keeperId], remaining());
    yield* allocate(seeder, ['run', '--rm', '--name', seeder, '--label', 'io.codeboost.task-storage=seeder', ...labels,
      '--read-only', '--user', '0:0', '--network=none', '--cap-drop=ALL', '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32',
      '--memory=128m', '--cpus=.25', '--mount', `type=bind,source=${staging},target=/run/codeboost-staging,readonly`,
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--entrypoint', 'sh', imageId, '-c', seed]);
    // Reject a staging directory swapped while the seeder was reading it.
    assertTaskClone(clone);
    remaining();
    const filesystems = Object.freeze({ keeper, workVolume, metadataVolume, ...limits });
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
  return runStepsAsync(allocation(clone, limits, imageId, owner, options.timeoutMs ?? 60_000), options);
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

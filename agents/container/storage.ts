import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, opendirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { TaskClone } from '../contract.ts';
import { assertTaskClone } from '../../git/clone.ts';
import { assertBuiltAgentImage } from './image.ts';

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
  readonly allocationId: string;
  readonly clone: Readonly<TaskClone>;
  /** The builder-registered clone object, whose staging directory identity is re-verified. */
  readonly trustedClone: TaskClone;
  readonly limits: Readonly<TaskStorageLimits>;
}
const allocations = new WeakMap<TaskFilesystems, AllocationIdentity>();
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
const docker = (args: readonly string[], timeoutMs: number) => execFileSync('docker', [...args], {
  encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: dockerEnvironment(),
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const absent = (result: ReturnType<typeof spawnSync>) => result.status !== 0 && !result.error
  && /No such (?:object|container|volume)/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
/** How long an object whose create client was killed may still materialize in the daemon. */
const CREATE_SETTLE_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const remove = (args: readonly string[], inspectArgs: readonly string[], remaining: () => number, kind: string,
  allocationId: string, settleBy = 0) => {
  let before: ReturnType<typeof spawnSync>;
  for (;;) {
    before = spawnSync('docker', [...inspectArgs], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
      env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (before.status === 0) break;
    if (!absent(before)) throw new Error(`Failed to establish ownership of ${kind}.`);
    // A killed create may still land; only absence after the settle window counts.
    if (performance.now() >= settleBy) return;
    sleep(250);
  }
  const inspected = JSON.parse(String(before.stdout || '[]'))[0] as
    { Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } } | undefined;
  const labels = inspected?.Labels ?? inspected?.Config?.Labels;
  if (labels?.['io.codeboost.allocation'] !== allocationId) throw new Error(`Refused to remove unowned ${kind}.`);
  const result = spawnSync('docker', [...args], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return;
  const inspect = spawnSync('docker', [...inspectArgs], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (!absent(inspect)) throw new Error(`Failed to confirm removal of ${kind}.`);
};
const cleanup = (containers: readonly string[], volumes: readonly string[], allocationId: string,
  unsettled: ReadonlySet<string> = new Set(), timeoutMs = 30_000) => {
  const remaining = createDeadline(timeoutMs + (unsettled.size ? CREATE_SETTLE_MS : 0)), failures: unknown[] = [];
  const settleBy = (name: string) => unsettled.has(name) ? performance.now() + CREATE_SETTLE_MS : 0;
  for (const container of containers) {
    try { remove(['rm', '--force', container], ['container', 'inspect', container], remaining,
      'task container', allocationId, settleBy(container)); }
    catch (error) { failures.push(error); }
  }
  for (const volume of volumes) {
    try { remove(['volume', 'rm', '--force', volume], ['volume', 'inspect', volume], remaining, 'task volume', allocationId,
      settleBy(volume)); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Task filesystem cleanup did not settle.');
};

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

export function taskFilesystemAllocationId(filesystems: TaskFilesystems): string {
  assertTaskFilesystems(filesystems);
  return allocations.get(filesystems)!.allocationId;
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
const assertContainedLinks = (staging: string, remaining: () => number) => {
  const metadata = join(staging, '.git'), pending = [staging];
  let count = 0;
  while (pending.length) {
    remaining();
    count++;
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
      }
    } finally { directory.closeSync(); }
  }
};

/** Allocate bounded, engine-owned task filesystems and keep them mounted. */
export function prepareTaskFilesystems(clone: TaskClone, limits: TaskStorageLimits,
  imageId: string, timeoutMs = 60_000): TaskFilesystems {
  for (const [name, value] of Object.entries(limits)) validLimit(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('Task filesystems require the immutable built image ID.');
  assertBuiltAgentImage(imageId);
  const staging = assertTaskClone(clone), remaining = createDeadline(timeoutMs);
  if (/[\n,]/.test(staging)) throw new Error('Staging path cannot be represented as a Docker mount.');
  if (!lstatSync(`${staging}/.git`).isDirectory()) throw new Error('Staging clone must contain standalone Git metadata.');
  assertContainedLinks(staging, remaining);
  const allocationId = randomUUID();
  const workVolume = `codeboost-work-${randomUUID()}`, metadataVolume = `codeboost-metadata-${randomUUID()}`;
  const keeper = `codeboost-keeper-${randomUUID()}`, seeder = `codeboost-seeder-${randomUUID()}`;
  const createdVolumes: string[] = [], unsettled = new Set<string>();
  // Run one allocation step; a client killed by its deadline leaves the daemon outcome for `name` unknown.
  const allocate = (name: string, args: readonly string[]) => {
    const timeout = remaining();
    try { docker(args, timeout); }
    catch (error) {
      if (typeof (error as { status?: unknown }).status !== 'number') unsettled.add(name);
      throw error;
    }
  };
  try {
    for (const [kind, name, bytes, inodes] of [['work', workVolume, limits.workBytes, limits.workInodes],
      ['metadata', metadataVolume, limits.metadataBytes, limits.metadataInodes]] as const) {
      createdVolumes.push(name);
      allocate(name, ['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=${bytes},nr_inodes=${inodes},uid=10001,gid=10001,mode=0755,nosuid,nodev`,
        '--label', `io.codeboost.task-storage=${kind}`, '--label', `io.codeboost.allocation=${allocationId}`, name]);
    }
    // Copy metadata straight to its own volume so the work allocation never holds both at once.
    const seed = ['set -eu',
      'find /run/codeboost-staging -mindepth 1 -maxdepth 1 ! -name .git'
        + ' -exec cp -a --no-preserve=ownership,timestamps -t /work/ {} +',
      'cp -a --no-preserve=ownership,timestamps /run/codeboost-staging/.git/. /metadata/', 'mkdir -p /work/.git',
      'chown -R 10001:10001 /work /metadata'].join('; ');
    allocate(keeper, ['run', '--detach', '--name', keeper, '--read-only', '--user', '10001:10001', '--network=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32', '--memory=128m', '--cpus=.25',
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--label', 'io.codeboost.task-storage=keeper', '--label', `io.codeboost.allocation=${allocationId}`,
      '--entrypoint', 'sleep', imageId, 'infinity']);
    allocate(seeder, ['run', '--rm', '--name', seeder, '--label', `io.codeboost.allocation=${allocationId}`,
      '--read-only', '--user', '0:0', '--network=none', '--cap-drop=ALL', '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=32',
      '--memory=128m', '--cpus=.25', '--mount', `type=bind,source=${staging},target=/run/codeboost-staging,readonly`,
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--entrypoint', 'sh', imageId, '-c', seed]);
    // Reject a staging directory swapped while the seeder was reading it.
    assertTaskClone(clone);
    remaining();
    const filesystems = Object.freeze({ keeper, workVolume, metadataVolume, ...limits });
    allocations.set(filesystems, Object.freeze({ allocationId, trustedClone: clone,
      clone: Object.freeze({ ...clone, directory: staging }), limits: Object.freeze({ ...limits }) }));
    return filesystems;
  } catch (error) {
    try { cleanup([seeder, keeper], createdVolumes.reverse(), allocationId, unsettled); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Task allocation failed and cleanup did not settle.'); }
    throw error;
  }
}

export function removeTaskFilesystems(filesystems: TaskFilesystems): void {
  assertTaskFilesystems(filesystems);
  const allocationId = taskFilesystemAllocationId(filesystems);
  cleanup([filesystems.keeper], [filesystems.metadataVolume, filesystems.workVolume], allocationId);
  allocations.delete(filesystems);
}

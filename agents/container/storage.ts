import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
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
const remove = (args: readonly string[], inspectArgs: readonly string[], remaining: () => number, kind: string,
  allocationId: string) => {
  const before = spawnSync('docker', [...inspectArgs], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (before.status !== 0) {
    if (absent(before)) return;
    throw new Error(`Failed to establish ownership of ${kind}.`);
  }
  const inspected = JSON.parse(before.stdout || '[]')[0] as
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
const cleanup = (containers: readonly string[], volumes: readonly string[], allocationId: string, timeoutMs = 30_000) => {
  const remaining = createDeadline(timeoutMs), failures: unknown[] = [];
  for (const container of containers) {
    try { remove(['rm', '--force', container], ['container', 'inspect', container], remaining,
      'task container', allocationId); }
    catch (error) { failures.push(error); }
  }
  for (const volume of volumes) {
    try { remove(['volume', 'rm', '--force', volume], ['volume', 'inspect', volume], remaining, 'task volume', allocationId); }
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
    || realpathSync(clone.directory) !== identity.clone.directory || clone.head !== identity.clone.head))
    throw new Error('Task filesystems do not belong to the invocation clone.');
}

export function taskFilesystemAllocationId(filesystems: TaskFilesystems): string {
  assertTaskFilesystems(filesystems);
  return allocations.get(filesystems)!.allocationId;
}

/** Allocate bounded, engine-owned task filesystems and keep them mounted. */
export function prepareTaskFilesystems(clone: TaskClone, limits: TaskStorageLimits,
  imageId: string, timeoutMs = 60_000): TaskFilesystems {
  for (const [name, value] of Object.entries(limits)) validLimit(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('Task filesystems require the immutable built image ID.');
  assertBuiltAgentImage(imageId);
  assertTaskClone(clone);
  const remaining = createDeadline(timeoutMs), staging = realpathSync(clone.directory);
  if (/[\n,]/.test(staging)) throw new Error('Staging path cannot be represented as a Docker mount.');
  if (!lstatSync(`${staging}/.git`).isDirectory()) throw new Error('Staging clone must contain standalone Git metadata.');
  const allocationId = randomUUID();
  const workVolume = `codeboost-work-${randomUUID()}`, metadataVolume = `codeboost-metadata-${randomUUID()}`;
  const keeper = `codeboost-keeper-${randomUUID()}`, seeder = `codeboost-seeder-${randomUUID()}`;
  const createdVolumes: string[] = [];
  try {
    for (const [kind, name, bytes, inodes] of [['work', workVolume, limits.workBytes, limits.workInodes],
      ['metadata', metadataVolume, limits.metadataBytes, limits.metadataInodes]] as const) {
      createdVolumes.push(name);
      docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=${bytes},nr_inodes=${inodes},uid=10001,gid=10001,mode=0755,nosuid,nodev`,
        '--label', `io.codeboost.task-storage=${kind}`, '--label', `io.codeboost.allocation=${allocationId}`, name], remaining());
    }
    const seed = ['set -eu', 'cp -a --no-preserve=ownership,timestamps /run/codeboost-staging/. /work/',
      'cp -a --no-preserve=ownership,timestamps /work/.git/. /metadata/', 'rm -rf /work/.git', 'mkdir /work/.git',
      'chown -R 10001:10001 /work /metadata'].join('; ');
    docker(['run', '--detach', '--name', keeper, '--read-only', '--user', '10001:10001', '--network=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--cpus=.25',
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--label', 'io.codeboost.task-storage=keeper', '--label', `io.codeboost.allocation=${allocationId}`,
      '--entrypoint', 'sleep', imageId, 'infinity'], remaining());
    docker(['run', '--rm', '--name', seeder, '--label', `io.codeboost.allocation=${allocationId}`,
      '--read-only', '--user', '0:0', '--network=none', '--cap-drop=ALL', '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--pids-limit=32',
      '--memory=128m', '--cpus=.25', '--mount', `type=bind,source=${staging},target=/run/codeboost-staging,readonly`,
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--entrypoint', 'sh', imageId, '-c', seed], remaining());
    remaining();
    const filesystems = Object.freeze({ keeper, workVolume, metadataVolume, ...limits });
    allocations.set(filesystems, Object.freeze({ allocationId,
      clone: Object.freeze({ ...clone, directory: staging }), limits: Object.freeze({ ...limits }) }));
    return filesystems;
  } catch (error) {
    try { cleanup([seeder, keeper], createdVolumes.reverse(), allocationId); }
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

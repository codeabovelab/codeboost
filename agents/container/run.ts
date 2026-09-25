import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { assertContainerProfile, disposeContainerProfile, profileTimeout, type ContainerProfile } from './profile.ts';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION } from './image.ts';
import { taskFilesystemAllocationId } from './storage.ts';
export { prepareTaskFilesystems, removeTaskFilesystems } from './storage.ts';
export type { TaskFilesystems, TaskStorageLimits } from './storage.ts';

const dockerEnvironment = (secrets: Readonly<Record<string, string>> = {}) => ({
  PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...secrets,
});
const validateSecrets = (profile: ContainerProfile, secrets: Readonly<Record<string, string>>) => {
  const keys = Object.keys(secrets);
  if (profile.vendor === 'codex' && keys.length) throw new Error('Codex profile must not receive environment credentials.');
  if (profile.vendor === 'claude' && (keys.length !== 1 || keys[0] !== 'CLAUDE_CODE_OAUTH_TOKEN'
    || !secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.CLAUDE_CODE_OAUTH_TOKEN.includes('\0')))
    throw new Error('Claude profile requires only its OAuth environment credential.');
};
const docker = (args: readonly string[], options: { timeoutMs?: number; secrets?: Readonly<Record<string, string>> } = {}) =>
  execFileSync('docker', [...args], { encoding: 'utf8', timeout: options.timeoutMs ?? 30_000,
    killSignal: 'SIGKILL', env: dockerEnvironment(options.secrets), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
// Only no-new-privileges plus Docker's builtin seccomp profile; the daemon default may be unconfined.
const exactSecurityOptions = (options: string[] | null | undefined) => options?.length === 2
  && options.some(option => option === 'no-new-privileges' || option === 'no-new-privileges:true')
  && options.includes('seccomp=builtin');
export const hasExactOptions = (value: string | undefined, expected: readonly string[]) => {
  const parts = value?.split(',') ?? [];
  return parts.length === expected.length && new Set(parts).size === parts.length
    && expected.every(option => parts.includes(option));
};
const canonicalDockerBindSource = (source: string) => {
  const desktopHostPath = source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source;
  try { return realpathSync(desktopHostPath); } catch { return source; }
};
/** How long a killed `docker create` may still materialize its container in the daemon. */
const CREATE_SETTLE_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const removeContainerOrThrow = (profile: ContainerProfile, createUnsettled = false) => {
  const remaining = createDeadline(30_000 + (createUnsettled ? CREATE_SETTLE_MS : 0));
  const settleBy = performance.now() + (createUnsettled ? CREATE_SETTLE_MS : 0);
  let before: ReturnType<typeof spawnSync>;
  for (;;) {
    before = spawnSync('docker', ['container', 'inspect', profile.name], {
      encoding: 'utf8', timeout: remaining(), env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (before.status === 0) break;
    const missing = !before.error && /No such (?:object|container)/i.test(`${before.stdout ?? ''}\n${before.stderr ?? ''}`);
    if (!missing) throw new Error('Failed to establish ownership of the agent container; staged credentials were retained.');
    if (!createUnsettled) {
      disposeContainerProfile(profile);
      return;
    }
    // A killed create may still land in the daemon; absence is not proof until the settle window passes.
    if (performance.now() >= settleBy)
      throw new Error('Agent container creation did not settle; staged credentials were retained.');
    sleep(250);
  }
  const inspected = JSON.parse(String(before.stdout || '[]'))[0] as { Config?: { Labels?: Record<string, string> } } | undefined;
  if (inspected?.Config?.Labels?.['io.codeboost.invocation'] !== profile.ownershipId)
    throw new Error('Agent container name is held by another invocation; staged credentials were retained.');
  const result = spawnSync('docker', ['rm', '--force', profile.name], {
    encoding: 'utf8', timeout: remaining(), env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const inspect = spawnSync('docker', ['container', 'inspect', profile.name], {
      encoding: 'utf8', timeout: remaining(), env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const absent = inspect.status !== 0 && !inspect.error
      && /No such (?:object|container)/i.test(`${inspect.stdout ?? ''}\n${inspect.stderr ?? ''}`);
    if (!absent) throw new Error('Failed to confirm removal of the agent container; staged credentials were retained.');
  }
  disposeContainerProfile(profile);
};

type Inspect = {
  Image: string;
  Config: { Image: string; User: string; Env: string[]; Entrypoint: string[] | null; Cmd: string[] | null;
    WorkingDir: string; Labels: Record<string, string> | null };
  HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[] | null; SecurityOpt: string[] | null;
    CapAdd: string[] | null;
    NetworkMode: string; PidMode: string; IpcMode: string; UTSMode: string; UsernsMode: string; CgroupnsMode: string;
    PidsLimit: number; Memory: number; MemorySwap: number; MemoryReservation: number; MemorySwappiness: number | null;
    OomKillDisable: boolean; OomScoreAdj: number; NanoCpus: number; CpuShares: number; CpuPeriod: number; CpuQuota: number;
    CpuRealtimePeriod: number; CpuRealtimeRuntime: number; CpusetCpus: string; CpusetMems: string; ShmSize: number;
    BlkioWeight: number; BlkioWeightDevice: unknown[] | null; BlkioDeviceReadBps: unknown[] | null;
    BlkioDeviceWriteBps: unknown[] | null; BlkioDeviceReadIOps: unknown[] | null; BlkioDeviceWriteIOps: unknown[] | null;
    Ulimits: unknown[] | null; CpuCount: number;
    CpuPercent: number; IOMaximumBandwidth: number; IOMaximumIOps: number; DeviceCgroupRules: unknown[] | null;
    StorageOpt?: Record<string, string> | null; CgroupParent: string;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null; Runtime: string;
    Devices: unknown[] | null; DeviceRequests: unknown[] | null; Tmpfs: Record<string, string> | null;
    Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }> | null };
  Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW: boolean }>;
};

/** Validate daemon-resolved configuration before starting an agent. */
export function validateContainer(container: string, profile: ContainerProfile, timeoutMs = 30_000): void {
  const remaining = createDeadline(timeoutMs);
  assertContainerProfile(profile);
  const inspect = JSON.parse(docker(['container', 'inspect', container], { timeoutMs: remaining() }))[0] as Inspect | undefined;
  if (!inspect) throw new Error('Docker did not return the created container.');
  const image = JSON.parse(docker(['image', 'inspect', profile.expectedImage], { timeoutMs: remaining() }))[0] as
    { Id?: string; Config?: { User?: string; Env?: string[]; Entrypoint?: string[]; Labels?: Record<string, string> } } | undefined;
  const imageId = image?.Id, labels = image?.Config?.Labels ?? {};
  const host = inspect.HostConfig;
  if (!imageId || imageId !== profile.expectedImage || inspect.Image !== profile.expectedImage
    || inspect.Config.Image !== profile.expectedImage
    || image?.Config?.User !== '10001:10001'
    || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(['/usr/local/bin/codeboost-container-probe'])
    || labels['org.opencontainers.image.base.name'] !== BASE_IMAGE
    || labels['io.codeboost.codex.version'] !== CODEX_VERSION
    || labels['io.codeboost.claude.version'] !== CLAUDE_VERSION
    || labels['io.codeboost.profile.version'] !== '1')
    throw new Error('Container does not use the pinned agent image.');
  if (inspect.Config.User !== '10001:10001' || inspect.Config.WorkingDir !== '/work'
    || JSON.stringify(inspect.Config.Entrypoint) !== JSON.stringify(['/usr/local/bin/codeboost-container-probe'])
    || JSON.stringify(inspect.Config.Cmd) !== JSON.stringify(profile.command)
    || inspect.Config.Labels?.['io.codeboost.invocation'] !== profile.ownershipId
    || !host.ReadonlyRootfs || host.Privileged
    || !host.CapDrop?.map(value => value.toUpperCase()).includes('ALL') || (host.CapAdd?.length ?? 0) !== 0
    || !exactSecurityOptions(host.SecurityOpt)
    || host.NetworkMode !== 'none' || host.PidMode !== '' || host.IpcMode !== 'private'
    || host.UTSMode !== '' || host.UsernsMode !== '' || host.CgroupnsMode !== 'private'
    || (host.Devices?.length ?? 0) !== 0 || (host.DeviceRequests?.length ?? 0) !== 0 || host.PidsLimit !== 128
    || host.Memory !== 512 * 1024 * 1024 || host.MemorySwap !== 512 * 1024 * 1024
    || host.MemoryReservation !== 0 || host.MemorySwappiness !== null || host.OomKillDisable || host.OomScoreAdj !== 0
    || host.NanoCpus !== 1_000_000_000 || host.CpuShares !== 0 || host.CpuPeriod !== 0 || host.CpuQuota !== 0
    || host.CpuRealtimePeriod !== 0 || host.CpuRealtimeRuntime !== 0 || host.CpusetCpus !== '' || host.CpusetMems !== ''
    || host.ShmSize !== 16 * 1024 * 1024 || host.BlkioWeight !== 0
    || host.BlkioWeightDevice?.length || host.BlkioDeviceReadBps?.length || host.BlkioDeviceWriteBps?.length
    || host.BlkioDeviceReadIOps?.length || host.BlkioDeviceWriteIOps?.length || host.Ulimits?.length
    || host.CpuCount !== 0 || host.CpuPercent !== 0 || host.IOMaximumBandwidth !== 0 || host.IOMaximumIOps !== 0
    || host.DeviceCgroupRules !== null || host.StorageOpt != null || host.CgroupParent !== ''
    || !['', 'no'].includes(host.RestartPolicy?.Name ?? '') || (host.RestartPolicy?.MaximumRetryCount ?? 0) !== 0
    || host.Runtime !== 'runc')
    throw new Error('Container daemon configuration is missing required lockdown.');
  const tmpfs = host.Tmpfs ?? {};
  const expectedTmpfs = new Map([
    ['/tmp', ['rw', 'nosuid', 'nodev', 'size=33554432', 'nr_inodes=4096', 'mode=1777']],
    ['/home/codeboost', ['rw', 'nosuid', 'nodev', 'size=1048576', 'nr_inodes=128', 'uid=10001', 'gid=10001', 'mode=0700']],
    ...(profile.vendor === 'codex' ? [['/run/codeboost-auth/codex',
      ['rw', 'nosuid', 'nodev', 'size=4194304', 'nr_inodes=256', 'uid=10001', 'gid=10001', 'mode=0700']] as const] : []),
  ]);
  if (Object.keys(tmpfs).length !== expectedTmpfs.size) throw new Error('Container tmpfs mount set changed.');
  for (const [path, expected] of expectedTmpfs) {
    if (!hasExactOptions(tmpfs[path], expected)) throw new Error(`Container tmpfs ${path} options changed.`);
  }
  const mounts = new Map(inspect.Mounts.map(item => [item.Destination, item]));
  const allowedMounts = new Set(['/work', '/work/.git', '/run/codeboost-input',
    ...(profile.vendor === 'codex' ? ['/run/codeboost-auth/codex/auth.json'] : [])]);
  if (inspect.Mounts.some(item => !allowedMounts.has(item.Destination)))
    throw new Error('Container includes an unexpected external mount.');
  const work = mounts.get('/work'), metadata = mounts.get('/work/.git'), input = mounts.get('/run/codeboost-input');
  if (work?.Type !== 'volume' || work.RW !== ['execute', 'fix'].includes(profile.phase)
    || metadata?.Type !== 'volume' || metadata.RW || input?.Type !== 'bind' || input.RW)
    throw new Error('Container mounts do not match the phase isolation profile.');
  const requestedMounts = new Map((host.Mounts ?? []).map(item => [item.Target, item]));
  const requestedInput = requestedMounts.get('/run/codeboost-input');
  if (requestedInput?.Type !== 'bind' || canonicalDockerBindSource(requestedInput.Source) !== profile.inputDirectory
    || canonicalDockerBindSource(input.Source) !== profile.inputDirectory
    || !requestedInput.ReadOnly) throw new Error('Schema input mount identity changed.');
  if (work.Name !== profile.filesystems.workVolume || metadata.Name !== profile.filesystems.metadataVolume)
    throw new Error('Container task volumes do not match their captured identity.');
  if (work.Source === metadata.Source) throw new Error('Worktree and Git metadata must use separate filesystems.');
  const volumes = JSON.parse(docker(['volume', 'inspect', work.Name!, metadata.Name!], { timeoutMs: remaining() })) as
    Array<{ Name: string; Driver: string; Labels: Record<string, string> | null; Options: Record<string, string> | null }>;
  const allocationId = taskFilesystemAllocationId(profile.filesystems);
  const expectedVolumes = new Map([
    [work.Name!, ['work', String(profile.filesystems.workBytes), String(profile.filesystems.workInodes)]],
    [metadata.Name!, ['metadata', String(profile.filesystems.metadataBytes), String(profile.filesystems.metadataInodes)]],
  ]);
  for (const volume of volumes) {
    const expected = expectedVolumes.get(volume.Name), options = volume.Options ?? {}, optionString = options.o ?? '';
    if (!expected || volume.Driver !== 'local' || options.type !== 'tmpfs' || options.device !== 'tmpfs'
      || volume.Labels?.['io.codeboost.task-storage'] !== expected[0]
      || volume.Labels?.['io.codeboost.allocation'] !== allocationId
      || !hasExactOptions(optionString, [`size=${expected[1]}`, `nr_inodes=${expected[2]}`,
        'uid=10001', 'gid=10001', 'mode=0755', 'nosuid', 'nodev']))
      throw new Error('Task volume does not match its bounded tmpfs allocation.');
  }
  const keeper = JSON.parse(docker(['container', 'inspect', profile.filesystems.keeper], { timeoutMs: remaining() }))[0] as
    { State?: { Running?: boolean }; Config?: { Image?: string; User?: string; Labels?: Record<string, string> };
      HostConfig?: { ReadonlyRootfs?: boolean; Privileged?: boolean; NetworkMode?: string; CapDrop?: string[] | null;
        CapAdd?: string[] | null; SecurityOpt?: string[] | null;
        RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null; Runtime?: string };
      Mounts?: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }> } | undefined;
  const keeperVolumes = new Map((keeper?.Mounts ?? []).filter(item => item.Type === 'volume').map(item => [item.Destination, item]));
  if (!keeper?.State?.Running || keeper.Config?.Image !== profile.expectedImage || keeper.Config?.User !== '10001:10001'
    || keeper.Config?.Labels?.['io.codeboost.task-storage'] !== 'keeper'
    || keeper.Config?.Labels?.['io.codeboost.allocation'] !== allocationId || !keeper.HostConfig?.ReadonlyRootfs
    || keeper.HostConfig.Privileged || keeper.HostConfig.NetworkMode !== 'none'
    || !keeper.HostConfig.CapDrop?.map(value => value.toUpperCase()).includes('ALL')
    || (keeper.HostConfig.CapAdd?.length ?? 0) !== 0
    || !exactSecurityOptions(keeper.HostConfig.SecurityOpt)
    || !['', 'no'].includes(keeper.HostConfig.RestartPolicy?.Name ?? '')
    || (keeper.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0) !== 0 || keeper.HostConfig.Runtime !== 'runc'
    || keeperVolumes.get('/work')?.Name !== profile.filesystems.workVolume
    || keeperVolumes.get('/metadata')?.Name !== profile.filesystems.metadataVolume)
    throw new Error('Task filesystems must remain owned by their trusted keeper.');
  const auth = mounts.get('/run/codeboost-auth/codex/auth.json');
  if (profile.vendor === 'codex' && (auth?.Type !== 'bind' || auth.RW)) throw new Error('Codex auth must be a read-only file mount.');
  const requestedAuth = requestedMounts.get('/run/codeboost-auth/codex/auth.json');
  if (profile.vendor === 'codex' && (requestedAuth?.Type !== 'bind'
    || canonicalDockerBindSource(requestedAuth.Source) !== profile.codexAuthFile
    || canonicalDockerBindSource(auth!.Source) !== profile.codexAuthFile || !requestedAuth.ReadOnly))
    throw new Error('Codex auth mount identity changed.');
  if (profile.vendor === 'claude' && auth) throw new Error('Claude profile must not mount Codex auth.');
  if (inspect.Config.Env.some(value => value.indexOf('=') < 1)) throw new Error('Container environment is malformed.');
  const names = inspect.Config.Env.map(value => value.slice(0, value.indexOf('=')));
  const environment = new Map(inspect.Config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  const imageEnvironment = new Map((image?.Config?.Env ?? []).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  const allowedEnvironment = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'CODEBOOST_PHASE', 'CODEBOOST_VENDOR',
    'CODEBOOST_WORK_BYTES', 'CODEBOOST_WORK_INODES', 'CODEBOOST_METADATA_BYTES', 'CODEBOOST_METADATA_INODES',
    'npm_config_cache', 'XDG_CACHE_HOME', ...(profile.vendor === 'codex' ? ['CODEX_HOME'] : ['CLAUDE_CODE_OAUTH_TOKEN'])]);
  if (new Set(names).size !== names.length || names.some(name => !allowedEnvironment.has(name)))
    throw new Error('Container includes an unexpected environment variable.');
  if (environment.get('PATH') !== imageEnvironment.get('PATH')
    || environment.get('HOME') !== '/home/codeboost' || environment.get('CODEBOOST_PHASE') !== profile.phase
    || environment.get('CODEBOOST_VENDOR') !== profile.vendor
    || environment.get('CODEBOOST_WORK_BYTES') !== String(profile.filesystems.workBytes)
    || environment.get('CODEBOOST_WORK_INODES') !== String(profile.filesystems.workInodes)
    || environment.get('CODEBOOST_METADATA_BYTES') !== String(profile.filesystems.metadataBytes)
    || environment.get('CODEBOOST_METADATA_INODES') !== String(profile.filesystems.metadataInodes)
    || environment.get('npm_config_cache') !== '/tmp/npm-cache'
    || environment.get('XDG_CACHE_HOME') !== '/tmp/xdg-cache')
    throw new Error('Container isolation environment changed.');
  if (profile.vendor === 'codex' && (names.includes('CLAUDE_CODE_OAUTH_TOKEN')
    || environment.get('CODEX_HOME') !== '/run/codeboost-auth/codex'))
    throw new Error('Credential profiles must not be combined or redirected.');
  if (profile.vendor === 'claude' && (names.includes('CODEX_HOME') || !names.includes('CLAUDE_CODE_OAUTH_TOKEN')))
    throw new Error('Credential profiles must not be combined.');
  assertContainerProfile(profile);
  remaining();
}

export function createValidatedContainer(profile: ContainerProfile, timeoutMs = 30_000,
  secrets: Readonly<Record<string, string>> = {}): string {
  const remaining = createDeadline(profileTimeout(profile, timeoutMs));
  let createUnsettled = false;
  try {
    validateSecrets(profile, secrets);
    assertContainerProfile(profile);
    const createTimeout = remaining();
    createUnsettled = true;
    try { docker(profile.args, { timeoutMs: createTimeout, secrets }); }
    catch (error) {
      // A nonzero exit means the daemon answered; a killed client leaves the request in flight.
      createUnsettled = typeof (error as { status?: unknown }).status !== 'number';
      throw error;
    }
    createUnsettled = false;
    validateContainer(profile.name, profile, remaining());
    assertContainerProfile(profile);
    remaining();
    return profile.name;
  } catch (error) {
    try { removeContainerOrThrow(profile, createUnsettled); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Container creation failed and cleanup did not settle.'); }
    throw error;
  }
}

export function runContainer(profile: ContainerProfile, timeoutMs = 60_000,
  secrets: Readonly<Record<string, string>> = {}): string {
  const remaining = createDeadline(profileTimeout(profile, timeoutMs));
  const container = createValidatedContainer(profile, remaining(), secrets);
  let failure: unknown;
  try {
    assertContainerProfile(profile);
    const output = docker(['start', '--attach', container], { timeoutMs: remaining(), secrets });
    remaining();
    return output;
  }
  catch (error) { failure = error; throw error; }
  finally {
    try { removeContainerOrThrow(profile); }
    catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], 'Agent invocation failed and cleanup did not settle.');
      throw cleanupError;
    }
  }
}

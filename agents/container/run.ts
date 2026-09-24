import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { assertContainerProfile, disposeContainerProfile, type ContainerProfile, type TaskFilesystems } from './profile.ts';
import { assertBuiltAgentImage, BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION } from './image.ts';

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
const resourceName = (kind: string) => `codeboost-${kind}-${randomUUID()}`;
const exactNoNewPrivileges = (options: string[] | null | undefined) => options?.length === 1
  && (options[0] === 'no-new-privileges' || options[0] === 'no-new-privileges:true');
export const hasExactOptions = (value: string | undefined, expected: readonly string[]) => {
  const parts = value?.split(',') ?? [];
  return parts.length === expected.length && new Set(parts).size === parts.length
    && expected.every(option => parts.includes(option));
};
const canonicalDockerBindSource = (source: string) => {
  const desktopHostPath = source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source;
  try { return realpathSync(desktopHostPath); } catch { return source; }
};
const removeContainerOrThrow = (profile: ContainerProfile) => {
  const result = spawnSync('docker', ['rm', '--force', profile.name], {
    encoding: 'utf8', timeout: 30_000, env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const inspect = spawnSync('docker', ['container', 'inspect', profile.name], {
      encoding: 'utf8', timeout: 30_000, env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const absent = inspect.status !== 0 && !inspect.error && /No such (?:object|container)/i.test(inspect.stderr ?? '');
    if (!absent) throw new Error('Failed to confirm removal of the agent container; staged credentials were retained.');
  }
  disposeContainerProfile(profile);
};

export interface TaskStorageLimits {
  readonly workBytes: number;
  readonly workInodes: number;
  readonly metadataBytes: number;
  readonly metadataInodes: number;
}

/** Allocate bounded, engine-owned task filesystems and keep them mounted. */
export function prepareTaskFilesystems(stagingDirectory: string, limits: TaskStorageLimits,
  imageId: string, timeoutMs = 60_000): TaskFilesystems {
  for (const [name, value] of Object.entries(limits)) validLimit(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('Task filesystems require the immutable built image ID.');
  assertBuiltAgentImage(imageId);
  const remaining = createDeadline(timeoutMs);
  const staging = realpathSync(stagingDirectory);
  if (/[\n,]/.test(staging)) throw new Error('Staging path cannot be represented as a Docker mount.');
  if (!lstatSync(`${staging}/.git`).isDirectory()) throw new Error('Staging clone must contain standalone Git metadata.');
  const workVolume = resourceName('work'), metadataVolume = resourceName('metadata'), keeper = resourceName('keeper');
  const createdVolumes: string[] = [];
  try {
    for (const [kind, name, bytes, inodes] of [['work', workVolume, limits.workBytes, limits.workInodes],
      ['metadata', metadataVolume, limits.metadataBytes, limits.metadataInodes]] as const) {
      docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=${bytes},nr_inodes=${inodes},uid=10001,gid=10001,mode=0755,nosuid,nodev`,
        '--label', `io.codeboost.task-storage=${kind}`, name], { timeoutMs: remaining() });
      createdVolumes.push(name);
    }
    const seed = [
      'set -eu',
      'cp -a --no-preserve=ownership,timestamps /run/codeboost-staging/. /work/',
      'cp -a --no-preserve=ownership,timestamps /work/.git/. /metadata/',
      'rm -rf /work/.git',
      'mkdir /work/.git',
      'chown -R 10001:10001 /work /metadata',
    ].join('; ');
    docker(['run', '--detach', '--name', keeper, '--read-only', '--user', '10001:10001', '--network=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--cpus=.25',
      '--mount', `type=volume,source=${workVolume},target=/work`,
      '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--label', 'io.codeboost.task-storage=keeper', '--entrypoint', 'sleep', imageId, 'infinity'],
    { timeoutMs: remaining() });
    docker(['run', '--rm', '--read-only', '--user', '0:0', '--network=none', '--cap-drop=ALL',
      '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--pids-limit=32',
      '--memory=128m', '--cpus=.25',
      '--mount', `type=bind,source=${staging},target=/run/codeboost-staging,readonly`,
      '--mount', `type=volume,source=${workVolume},target=/work`,
      '--mount', `type=volume,source=${metadataVolume},target=/metadata`,
      '--entrypoint', 'sh', imageId, '-c', seed], { timeoutMs: remaining() });
    remaining();
    return Object.freeze({ keeper, workVolume, metadataVolume, ...limits });
  } catch (error) {
    spawnSync('docker', ['rm', '--force', keeper], { env: dockerEnvironment(), stdio: 'ignore' });
    for (const volume of createdVolumes.reverse())
      spawnSync('docker', ['volume', 'rm', '--force', volume], { env: dockerEnvironment(), stdio: 'ignore' });
    throw error;
  }
}

type Inspect = {
  Image: string;
  Config: { Image: string; User: string; Env: string[]; Entrypoint: string[] | null; Cmd: string[] | null; WorkingDir: string };
  HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[] | null; SecurityOpt: string[] | null;
    CapAdd: string[] | null;
    NetworkMode: string; PidMode: string; IpcMode: string; PidsLimit: number; Memory: number; NanoCpus: number;
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
    || !host.ReadonlyRootfs || host.Privileged
    || !host.CapDrop?.map(value => value.toUpperCase()).includes('ALL') || (host.CapAdd?.length ?? 0) !== 0
    || !exactNoNewPrivileges(host.SecurityOpt)
    || host.NetworkMode !== 'none' || host.PidMode !== '' || host.IpcMode !== 'private'
    || (host.Devices?.length ?? 0) !== 0 || (host.DeviceRequests?.length ?? 0) !== 0 || host.PidsLimit !== 128
    || host.Memory !== 512 * 1024 * 1024 || host.NanoCpus !== 1_000_000_000)
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
    || !requestedInput.ReadOnly) throw new Error('Schema input mount identity changed.');
  if (work.Name !== profile.filesystems.workVolume || metadata.Name !== profile.filesystems.metadataVolume)
    throw new Error('Container task volumes do not match their captured identity.');
  if (work.Source === metadata.Source) throw new Error('Worktree and Git metadata must use separate filesystems.');
  const volumes = JSON.parse(docker(['volume', 'inspect', work.Name!, metadata.Name!], { timeoutMs: remaining() })) as
    Array<{ Name: string; Driver: string; Labels: Record<string, string> | null; Options: Record<string, string> | null }>;
  const expectedVolumes = new Map([
    [work.Name!, ['work', String(profile.filesystems.workBytes), String(profile.filesystems.workInodes)]],
    [metadata.Name!, ['metadata', String(profile.filesystems.metadataBytes), String(profile.filesystems.metadataInodes)]],
  ]);
  for (const volume of volumes) {
    const expected = expectedVolumes.get(volume.Name), options = volume.Options ?? {}, optionString = options.o ?? '';
    if (!expected || volume.Driver !== 'local' || options.type !== 'tmpfs' || options.device !== 'tmpfs'
      || volume.Labels?.['io.codeboost.task-storage'] !== expected[0]
      || !hasExactOptions(optionString, [`size=${expected[1]}`, `nr_inodes=${expected[2]}`,
        'uid=10001', 'gid=10001', 'mode=0755', 'nosuid', 'nodev']))
      throw new Error('Task volume does not match its bounded tmpfs allocation.');
  }
  const keeper = JSON.parse(docker(['container', 'inspect', profile.filesystems.keeper], { timeoutMs: remaining() }))[0] as
    { State?: { Running?: boolean }; Config?: { Image?: string; User?: string; Labels?: Record<string, string> };
      HostConfig?: { ReadonlyRootfs?: boolean; Privileged?: boolean; NetworkMode?: string; CapDrop?: string[] | null;
        CapAdd?: string[] | null; SecurityOpt?: string[] | null };
      Mounts?: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }> } | undefined;
  const keeperVolumes = new Map((keeper?.Mounts ?? []).filter(item => item.Type === 'volume').map(item => [item.Destination, item]));
  if (!keeper?.State?.Running || keeper.Config?.Image !== profile.expectedImage || keeper.Config?.User !== '10001:10001'
    || keeper.Config?.Labels?.['io.codeboost.task-storage'] !== 'keeper' || !keeper.HostConfig?.ReadonlyRootfs
    || keeper.HostConfig.Privileged || keeper.HostConfig.NetworkMode !== 'none'
    || !keeper.HostConfig.CapDrop?.map(value => value.toUpperCase()).includes('ALL')
    || (keeper.HostConfig.CapAdd?.length ?? 0) !== 0
    || !exactNoNewPrivileges(keeper.HostConfig.SecurityOpt)
    || keeperVolumes.get('/work')?.Name !== profile.filesystems.workVolume
    || keeperVolumes.get('/metadata')?.Name !== profile.filesystems.metadataVolume)
    throw new Error('Task filesystems must remain owned by their trusted keeper.');
  const auth = mounts.get('/run/codeboost-auth/codex/auth.json');
  if (profile.vendor === 'codex' && (auth?.Type !== 'bind' || auth.RW)) throw new Error('Codex auth must be a read-only file mount.');
  const requestedAuth = requestedMounts.get('/run/codeboost-auth/codex/auth.json');
  if (profile.vendor === 'codex' && (requestedAuth?.Type !== 'bind'
    || canonicalDockerBindSource(requestedAuth.Source) !== profile.codexAuthFile || !requestedAuth.ReadOnly))
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
  if (profile.vendor === 'codex' && names.includes('CLAUDE_CODE_OAUTH_TOKEN')) throw new Error('Credential profiles must not be combined.');
  if (profile.vendor === 'claude' && (names.includes('CODEX_HOME') || !names.includes('CLAUDE_CODE_OAUTH_TOKEN')))
    throw new Error('Credential profiles must not be combined.');
  assertContainerProfile(profile);
  remaining();
}

export function createValidatedContainer(profile: ContainerProfile, timeoutMs = 30_000,
  secrets: Readonly<Record<string, string>> = {}): string {
  const remaining = createDeadline(timeoutMs);
  try {
    validateSecrets(profile, secrets);
    assertContainerProfile(profile);
    docker(profile.args, { timeoutMs: remaining(), secrets });
    validateContainer(profile.name, profile, remaining());
    assertContainerProfile(profile);
    remaining();
    return profile.name;
  } catch (error) {
    try { removeContainerOrThrow(profile); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Container creation failed and cleanup did not settle.'); }
    throw error;
  }
}

export function runContainer(profile: ContainerProfile, timeoutMs = 60_000,
  secrets: Readonly<Record<string, string>> = {}): string {
  const remaining = createDeadline(timeoutMs);
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

export function removeTaskFilesystems(filesystems: TaskFilesystems): void {
  spawnSync('docker', ['rm', '--force', filesystems.keeper], { timeout: 30_000, env: dockerEnvironment(), stdio: 'ignore' });
  for (const volume of [filesystems.metadataVolume, filesystems.workVolume])
    spawnSync('docker', ['volume', 'rm', '--force', volume], { timeout: 30_000, env: dockerEnvironment(), stdio: 'ignore' });
}

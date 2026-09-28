import { realpathSync } from 'node:fs';
import type { UnreleasedResource } from '../contract.ts';
import { docker as runDockerCommand, pause, runDocker, type DockerOutcome } from '../docker.ts';
import { assertContainerProfile, assertContainerProfileAuthenticity, disposeContainerProfile,
  isContainerProfileAuthentic, profileTimeout,
  type ContainerProfile } from './profile.ts';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION } from './image.ts';
import { taskFilesystemAllocationId } from './storage.ts';
export { prepareTaskFilesystems, removeTaskFilesystems } from './storage.ts';
export type { TaskFilesystems, TaskStorageLimits } from './storage.ts';

const validateSecrets = (profile: ContainerProfile, secrets: Readonly<Record<string, string>>) => {
  const keys = Object.keys(secrets);
  if (profile.vendor === 'codex' && keys.length) throw new Error('Codex profile must not receive environment credentials.');
  if (profile.vendor === 'claude' && (keys.length !== 1 || keys[0] !== 'CLAUDE_CODE_OAUTH_TOKEN'
    || !secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.CLAUDE_CODE_OAUTH_TOKEN.includes('\0')))
    throw new Error('Claude profile requires only its OAuth environment credential.');
};
const docker = (args: readonly string[], options: { timeoutMs?: number; secrets?: Readonly<Record<string, string>>;
  signal?: AbortSignal } = {}) => runDockerCommand(args, { timeoutMs: options.timeoutMs ?? 30_000,
  secrets: options.secrets, signal: options.signal });
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
// When a killed `docker create` for a profile stops counting as possibly in flight (performance.now() timestamp).
const unsettledCreates = new WeakMap<ContainerProfile, number>();
// Profiles whose `docker create` succeeded (with the returned ID) or whose client was killed (ID unknown). Only these
// may own a container named `profile.name`; before that the name can belong to another invocation.
const createdContainers = new WeakMap<ContainerProfile, string | undefined>();

const CONTAINER_ID = /^[0-9a-f]{64}$/;
/**
 * The immutable ID of the agent container this profile created, when `docker create` returned one. Every operation
 * after the create should use it: the name can be taken over by a replacement container.
 */
export function agentContainerId(profile: ContainerProfile): string | undefined {
  return createdContainers.get(profile);
}

const requireContainerId = (profile: ContainerProfile) => {
  const id = createdContainers.get(profile);
  if (!id) throw new Error('Docker did not return the created agent container ID.');
  return id;
};

/** The agent container this profile may have created, for reporting when its removal is not confirmed. */
export function agentContainerResources(profile: ContainerProfile): readonly UnreleasedResource[] {
  if (!createdContainers.has(profile)) return Object.freeze([]);
  const id = createdContainers.get(profile);
  return Object.freeze([Object.freeze({ kind: 'container' as const, name: profile.name, ...(id ? { id } : {}),
    owner: Object.freeze({ label: 'io.codeboost.invocation', value: profile.ownershipId }) })]);
}
// Cleanup is never cancelled: it runs to its own deadline so nothing is dropped.
const removeContainerOrThrow = async (profile: ContainerProfile, waitForSettle = false, timeoutMs = 30_000) => {
  // Destructive cleanup acts only for the builder-registered profile; a copy's name and label are not a capability.
  if (!isContainerProfileAuthentic(profile))
    throw new Error('Container profile was not created by the trusted profile builder.');
  // A profile whose `docker create` never ran, or was refused by the daemon, owns no container: the name may belong
  // to another invocation, which must neither be inspected as ours nor block this profile's own cleanup.
  if (!createdContainers.has(profile)) {
    await disposeContainerProfile(profile, timeoutMs);
    return;
  }
  const settleUntil = unsettledCreates.get(profile) ?? 0;
  const remaining = createDeadline(timeoutMs + (waitForSettle ? Math.max(0, Math.ceil(settleUntil - performance.now())) : 0));
  // Look up by the captured ID; the name only for a create whose ID never came back.
  const capturedId = createdContainers.get(profile), target = capturedId ?? profile.name;
  let before: DockerOutcome;
  for (;;) {
    before = await runDocker(['container', 'inspect', target], { timeoutMs: remaining() });
    if (before.status === 0) break;
    const missing = before.status !== null && !before.error
      && /No such (?:object|container)/i.test(`${before.stdout}\n${before.stderr}`);
    if (!missing) throw new Error('Failed to establish ownership of the agent container; staged credentials were retained.');
    // A killed create may still land in the daemon; absence only counts once its settle window has passed, on every
    // path. Only the create path waits here; later cleanup (such as a supervisor recovery) reports "not settled"
    // inside the window and retries later.
    if (performance.now() >= settleUntil) {
      unsettledCreates.delete(profile);
      createdContainers.delete(profile);
      await disposeContainerProfile(profile, remaining());
      return;
    }
    if (!waitForSettle) throw new Error('Agent container creation did not settle; staged credentials were retained.');
    await pause(250);
  }
  const inspected = JSON.parse(String(before.stdout || '[]'))[0] as
    { Id?: string; Config?: { Labels?: Record<string, string> } } | undefined;
  if (inspected?.Config?.Labels?.['io.codeboost.invocation'] !== profile.ownershipId)
    throw new Error('Agent container name is held by another invocation; staged credentials were retained.');
  // Remove and confirm by the ID the daemon just reported for our container, never by the name: a same-named
  // replacement created after this inspect must not be deleted.
  const id = inspected.Id;
  if (!id || !CONTAINER_ID.test(id) || (capturedId && id !== capturedId))
    throw new Error('Failed to establish the agent container identity; staged credentials were retained.');
  const result = await runDocker(['rm', '--force', id], { timeoutMs: remaining() });
  if (result.status !== 0) {
    const inspect = await runDocker(['container', 'inspect', id], { timeoutMs: remaining() });
    const absent = inspect.status !== null && inspect.status !== 0 && !inspect.error
      && /No such (?:object|container)/i.test(`${inspect.stdout}\n${inspect.stderr}`);
    if (!absent) throw new Error('Failed to confirm removal of the agent container; staged credentials were retained.');
  }
  unsettledCreates.delete(profile);
  createdContainers.delete(profile);
  await disposeContainerProfile(profile, remaining());
};

/**
 * Remove a validated invocation container, then its profile-owned staging and network resources. `timeoutMs` bounds
 * the container step and, separately, the network step.
 */
export async function disposeValidatedContainer(profile: ContainerProfile, timeoutMs = 30_000): Promise<void> {
  assertContainerProfileAuthenticity(profile);
  await removeContainerOrThrow(profile, false, timeoutMs);
}

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
    Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }> | null; Dns: string[];
    DnsOptions: string[]; DnsSearch: string[]; ExtraHosts: string[] | null;
    PortBindings: Record<string, unknown> | null; PublishAllPorts: boolean };
  Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, unknown>; Ports: Record<string, unknown> };
};

/** Validate daemon-resolved configuration before starting an agent. */
export async function validateContainer(container: string, profile: ContainerProfile, timeoutMs = 30_000,
  signal?: AbortSignal): Promise<void> {
  const remaining = createDeadline(timeoutMs);
  await assertContainerProfile(profile, remaining(), signal);
  const inspect = JSON.parse(await docker(['container', 'inspect', container], { timeoutMs: remaining(), signal }))[0] as
    Inspect | undefined;
  if (!inspect) throw new Error('Docker did not return the created container.');
  const image = JSON.parse(await docker(['image', 'inspect', profile.expectedImage], { timeoutMs: remaining(), signal }))[0] as
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
    || host.NetworkMode !== profile.network.name || host.PidMode !== '' || host.IpcMode !== 'private'
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
  if (JSON.stringify(host.Dns) !== JSON.stringify(['127.0.0.1']))
    throw new Error('Container DNS configuration changed.');
  if (host.DnsOptions.length || host.DnsSearch.length || (host.ExtraHosts?.length ?? 0)
    || Object.keys(host.PortBindings ?? {}).length || host.PublishAllPorts
    || Object.keys(inspect.NetworkSettings.Ports ?? {}).length)
    throw new Error('Container host or port configuration changed.');
  if (JSON.stringify(Object.keys(inspect.NetworkSettings.Networks)) !== JSON.stringify([profile.network.name]))
    throw new Error('Container network attachment changed.');
  const tmpfs = host.Tmpfs ?? {};
  const expectedTmpfs = new Map([
    ['/tmp', ['rw', 'nosuid', 'nodev', 'size=33554432', 'nr_inodes=4096', 'mode=1777']],
    ['/home/codeboost', ['rw', 'nosuid', 'nodev', 'size=1048576', 'nr_inodes=128', 'uid=10001', 'gid=10001', 'mode=0700']],
    ...(profile.vendor === 'codex' ? [['/run/codeboost-auth/codex',
      ['rw', 'nosuid', 'nodev', 'size=4194304', 'nr_inodes=256', 'uid=10001', 'gid=10001', 'mode=0700']] as const,
    ['/run/codeboost-output',
      ['rw', 'nosuid', 'nodev', 'noexec', 'size=20971520', 'nr_inodes=64', 'uid=10001', 'gid=10001', 'mode=0700']] as const] : []),
    ...(profile.deferredOutput ? [['/run/codeboost-control',
      ['rw', 'nosuid', 'nodev', 'noexec', 'size=65536', 'nr_inodes=16', 'uid=0', 'gid=0', 'mode=0711']] as const] : []),
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
  const volumes = JSON.parse(await docker(['volume', 'inspect', work.Name!, metadata.Name!],
    { timeoutMs: remaining(), signal })) as
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
  const keeper = JSON.parse(await docker(['container', 'inspect', profile.filesystems.keeper],
    { timeoutMs: remaining(), signal }))[0] as
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
    'npm_config_cache', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    ...(profile.deferredOutput ? ['CODEBOOST_DEFERRED_OUTPUT'] : []),
    ...(profile.vendor === 'codex' ? ['CODEX_HOME'] : ['CLAUDE_CODE_OAUTH_TOKEN'])]);
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
    || environment.get('XDG_CACHE_HOME') !== '/tmp/xdg-cache'
    || environment.get('HTTPS_PROXY') !== profile.network.proxyUrl
    || environment.get('HTTP_PROXY') !== profile.network.proxyUrl
    || environment.get('NO_PROXY') !== 'localhost,127.0.0.1')
    throw new Error('Container isolation environment changed.');
  if (profile.deferredOutput && environment.get('CODEBOOST_DEFERRED_OUTPUT') !== '1')
    throw new Error('Container deferred-output protocol changed.');
  if (profile.vendor === 'codex' && (names.includes('CLAUDE_CODE_OAUTH_TOKEN')
    || environment.get('CODEX_HOME') !== '/run/codeboost-auth/codex'))
    throw new Error('Credential profiles must not be combined or redirected.');
  if (profile.vendor === 'claude' && (names.includes('CODEX_HOME') || !names.includes('CLAUDE_CODE_OAUTH_TOKEN')))
    throw new Error('Credential profiles must not be combined.');
  await assertContainerProfile(profile, remaining(), signal);
  remaining();
}

/**
 * Create and validate the agent container. `signal` cancels creation: the in-flight Docker call is killed, and the
 * container (if the create may have landed) is removed before the promise rejects.
 */
export async function createValidatedContainer(profile: ContainerProfile, timeoutMs = 30_000,
  secrets: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<string> {
  const remaining = createDeadline(profileTimeout(profile, timeoutMs));
  let createUnsettled = false;
  try {
    validateSecrets(profile, secrets);
    await assertContainerProfile(profile, remaining(), signal);
    signal?.throwIfAborted();
    const createTimeout = remaining();
    createUnsettled = true;
    try {
      const id = await docker(profile.args, { timeoutMs: createTimeout, secrets, signal });
      // An unexpected create output leaves the ID unknown, so cleanup falls back to a verified name lookup.
      createdContainers.set(profile, CONTAINER_ID.test(id) ? id : undefined);
    }
    catch (error) {
      // A nonzero exit means the daemon answered; a killed client leaves the request in flight.
      createUnsettled = typeof (error as { status?: unknown }).status !== 'number';
      if (createUnsettled) createdContainers.set(profile, undefined);
      throw error;
    }
    createUnsettled = false;
    await validateContainer(requireContainerId(profile), profile, remaining(), signal);
    await assertContainerProfile(profile, remaining(), signal);
    remaining();
    signal?.throwIfAborted();
    return profile.name;
  } catch (error) {
    if (createUnsettled) unsettledCreates.set(profile, performance.now() + CREATE_SETTLE_MS);
    try { await removeContainerOrThrow(profile, createUnsettled); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Container creation failed and cleanup did not settle.'); }
    throw error;
  }
}

export async function startValidatedContainer(profile: ContainerProfile, timeoutMs = 60_000,
  secrets: Readonly<Record<string, string>> = {}): Promise<string> {
  const remaining = createDeadline(profileTimeout(profile, timeoutMs));
  let failure: unknown;
  try {
    validateSecrets(profile, secrets);
    // Validate and start the container this profile created, by ID: a same-named replacement must never run.
    const id = requireContainerId(profile);
    await validateContainer(id, profile, remaining());
    const output = await docker(['start', '--attach', id], { timeoutMs: remaining(), secrets });
    remaining();
    return output;
  }
  catch (error) { failure = error; throw error; }
  finally {
    try { await removeContainerOrThrow(profile); }
    catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], 'Agent invocation failed and cleanup did not settle.');
      throw cleanupError;
    }
  }
}

export async function runContainer(profile: ContainerProfile, timeoutMs = 60_000,
  secrets: Readonly<Record<string, string>> = {}): Promise<string> {
  const remaining = createDeadline(profileTimeout(profile, timeoutMs));
  await createValidatedContainer(profile, remaining(), secrets);
  let startBudget: number;
  try { startBudget = remaining(); }
  catch (error) {
    try { await removeContainerOrThrow(profile); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent deadline and cleanup both failed.'); }
    throw error;
  }
  return startValidatedContainer(profile, startBudget, secrets);
}

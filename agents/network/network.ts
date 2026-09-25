import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertCapturedInvocation, type InvocationInput } from '../contract.ts';
import { assertBuiltAgentImage } from '../container/image.ts';

export const VENDOR_HOSTS = Object.freeze({
  claude: Object.freeze(['api.anthropic.com']),
  codex: Object.freeze(['api.openai.com', 'chatgpt.com']),
} satisfies Record<InvocationInput['vendor'], readonly string[]>);

export interface VendorNetwork {
  readonly name: string;
  readonly proxyContainer: string;
  readonly proxyUrl: string;
  readonly vendor: InvocationInput['vendor'];
}
interface NetworkIdentity { readonly allocationId: string; readonly imageId: string; readonly invocation: InvocationInput;
  readonly subnet: string; readonly proxyIp: string;
  /** Daemon object IDs captured at creation; a same-named replacement has a different ID. */
  readonly networkId: string; readonly proxyId: string }
export class VendorNetworkCreationCleanupError extends AggregateError {
  readonly startupError: unknown;
  readonly retryCleanup: () => void;

  constructor(startupError: unknown, cleanupError: unknown, retryCleanup: () => void) {
    super([startupError, cleanupError], 'Vendor network creation and cleanup failed.');
    this.startupError = startupError;
    this.retryCleanup = retryCleanup;
  }
}
const identities = new WeakMap<VendorNetwork, NetworkIdentity>();
const removedNetworks = new WeakSet<VendorNetwork>();
const environment = () => ({ PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST });
const deadline = (timeoutMs: number) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Network deadline must be a positive integer.');
  const end = performance.now() + timeoutMs;
  return () => {
    const value = Math.ceil(end - performance.now());
    if (value <= 0) throw new Error('Vendor network operation exceeded its overall deadline.');
    return value;
  };
};
const docker = (args: readonly string[], timeout: number) => execFileSync('docker', [...args], {
  encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const absent = (result: ReturnType<typeof spawnSync>) => result.status !== 0 && !result.error
  && /(?:No such (?:object|container|network)|network .* not found)/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
/** How long a network or proxy whose create client was killed may still materialize in the daemon. */
const CREATE_SETTLE_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const remove = (args: readonly string[], inspect: readonly string[], remaining: () => number, kind: string,
  allocationId: string, settleBy = 0) => {
  let before: ReturnType<typeof spawnSync>;
  for (;;) {
    before = spawnSync('docker', [...inspect], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
      env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (before.status === 0) break;
    if (!absent(before)) throw new Error(`Failed to establish ownership of ${kind}.`);
    // A killed create may still land; only absence after the settle window counts.
    if (performance.now() >= settleBy) return;
    sleep(250);
  }
  const inspected = JSON.parse(String(before.stdout || '[]'))[0] as
    { Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } } | undefined;
  const labels = inspected?.Labels ?? inspected?.Config?.Labels;
  if (labels?.['io.codeboost.egress'] !== allocationId) throw new Error(`Refused to remove unowned ${kind}.`);
  const result = spawnSync('docker', [...args], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return;
  const check = spawnSync('docker', [...inspect], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (!absent(check)) throw new Error(`Failed to confirm removal of ${kind}.`);
};

const validateVendorNetwork = (network: VendorNetwork, invocation: InvocationInput | undefined,
  agentName: string | undefined, remaining: () => number): void => {
  const identity = identities.get(network);
  if (!identity) throw new Error('Vendor network was not created by the trusted network builder.');
  if (invocation && (identity.invocation !== invocation || network.vendor !== invocation.vendor))
    throw new Error('Vendor network does not belong to this invocation.');
  assertBuiltAgentImage(identity.imageId);
  // Inspect by the captured IDs, so a removed-and-recreated network or proxy cannot stand in for the original.
  const inspectAllocated = (args: readonly string[]) => {
    try { return docker(args, remaining()); }
    catch (cause) { throw new Error('Vendor network or proxy changed after allocation.', { cause }); }
  };
  const inspect = JSON.parse(inspectAllocated(['container', 'inspect', identity.proxyId]))[0] as
    { Id?: string; State?: { Running?: boolean }; Config?: { Image?: string; User?: string; Labels?: Record<string, string>; Env?: string[];
      Entrypoint?: string[] | null; Cmd?: string[] | null };
      HostConfig?: { ReadonlyRootfs?: boolean; Privileged?: boolean; CapDrop?: string[]; CapAdd?: string[] | null;
        SecurityOpt?: string[]; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number;
        NetworkMode?: string; PidMode?: string; IpcMode?: string; UTSMode?: string; UsernsMode?: string;
        CgroupnsMode?: string; Devices?: unknown[] | null; DeviceRequests?: unknown[] | null;
        Dns?: string[]; DnsOptions?: string[]; DnsSearch?: string[]; ExtraHosts?: string[] | null;
        PortBindings?: Record<string, unknown> | null; PublishAllPorts?: boolean; Runtime?: string;
        RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null };
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }>; Ports?: Record<string, unknown> };
      Mounts?: unknown[] } | undefined;
  const image = JSON.parse(docker(['image', 'inspect', identity.imageId], remaining()))[0] as
    { Config?: { Env?: string[] } } | undefined;
  const inspectedNetwork = JSON.parse(inspectAllocated(['network', 'inspect', identity.networkId]))[0] as
    { Id?: string; Name?: string; Internal?: boolean; Driver?: string; Labels?: Record<string, string>; IPAM?: { Config?: Array<{ Subnet?: string }> };
      Containers?: Record<string, { Name?: string }> } | undefined;
  const networks = Object.keys(inspect?.NetworkSettings?.Networks ?? {}).sort();
  const endpoints = Object.values(inspectedNetwork?.Containers ?? {}).map(value => value.Name).sort();
  const allowedEndpoints = [network.proxyContainer, ...(agentName ? [agentName] : [])];
  const expectedEnvironment = [...(image?.Config?.Env ?? []),
    `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[network.vendor].join(',')}`].sort();
  if (inspect?.Id !== identity.proxyId || inspectedNetwork?.Id !== identity.networkId
    || inspectedNetwork.Name !== network.name || !Object.keys(inspectedNetwork.Containers ?? {}).includes(identity.proxyId)
    || !inspect?.State?.Running || inspect.Config?.Image !== identity.imageId || inspect.Config?.User !== '10001:10001'
    || inspect.Config?.Labels?.['io.codeboost.egress'] !== identity.allocationId || !inspect.HostConfig?.ReadonlyRootfs
    || inspect.HostConfig.Privileged || !inspect.HostConfig.CapDrop?.map(value => value.toUpperCase()).includes('ALL')
    || (inspect.HostConfig.CapAdd?.length ?? 0) || inspect.HostConfig.SecurityOpt?.length !== 2
    || !inspect.HostConfig.SecurityOpt.some(option => ['no-new-privileges', 'no-new-privileges:true'].includes(option))
    || !inspect.HostConfig.SecurityOpt.includes('seccomp=builtin')
    || inspect.HostConfig.Runtime !== 'runc'
    || !['', 'no'].includes(inspect.HostConfig.RestartPolicy?.Name ?? '')
    || (inspect.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0) !== 0
    || inspect.HostConfig.PidsLimit !== 64 || inspect.HostConfig.Memory !== 64 * 1024 * 1024
    || inspect.HostConfig.MemorySwap !== 64 * 1024 * 1024 || inspect.HostConfig.NanoCpus !== 250_000_000
    || inspect.HostConfig.NetworkMode !== network.name || inspect.HostConfig.PidMode !== ''
    || inspect.HostConfig.IpcMode !== 'private' || inspect.HostConfig.UTSMode !== ''
    || inspect.HostConfig.UsernsMode !== '' || inspect.HostConfig.CgroupnsMode !== 'private'
    || (inspect.HostConfig.Devices?.length ?? 0) !== 0 || (inspect.HostConfig.DeviceRequests?.length ?? 0) !== 0
    || (inspect.HostConfig.Dns?.length ?? 0) !== 0 || (inspect.HostConfig.DnsOptions?.length ?? 0) !== 0
    || (inspect.HostConfig.DnsSearch?.length ?? 0) !== 0 || (inspect.HostConfig.ExtraHosts?.length ?? 0) !== 0
    || Object.keys(inspect.HostConfig.PortBindings ?? {}).length !== 0 || inspect.HostConfig.PublishAllPorts
    || Object.keys(inspect.NetworkSettings?.Ports ?? {}).length !== 0
    || JSON.stringify(networks) !== JSON.stringify(['bridge', network.name].sort()) || inspect.Mounts?.length
    || JSON.stringify(inspect.Config?.Entrypoint) !== JSON.stringify(['node'])
    || JSON.stringify(inspect.Config?.Cmd) !== JSON.stringify(['/usr/local/lib/codeboost-egress-proxy.mjs'])
    || JSON.stringify([...(inspect.Config.Env ?? [])].sort()) !== JSON.stringify(expectedEnvironment)
    || inspect.NetworkSettings?.Networks?.[network.name]?.IPAddress !== identity.proxyIp
    || !inspectedNetwork?.Internal || inspectedNetwork.Driver !== 'bridge'
    || inspectedNetwork.Labels?.['io.codeboost.egress'] !== identity.allocationId
    || inspectedNetwork.IPAM?.Config?.length !== 1 || inspectedNetwork.IPAM.Config[0]?.Subnet !== identity.subnet
    || !endpoints.includes(network.proxyContainer) || endpoints.some(name => !name || !allowedEndpoints.includes(name)))
    throw new Error('Vendor network or proxy changed after allocation.');
  remaining();
};

export function assertVendorNetwork(network: VendorNetwork, invocation?: InvocationInput, agentName?: string,
  timeoutMs = 30_000): void {
  validateVendorNetwork(network, invocation, agentName, deadline(timeoutMs));
}

export function createVendorNetwork(invocation: InvocationInput, imageId: string,
  timeoutMs = 60_000): VendorNetwork {
  assertCapturedInvocation(invocation);
  assertBuiltAgentImage(imageId);
  const vendor = invocation.vendor;
  // Setup runs inside the caller's budget minus a cleanup reserve, so failure cleanup cannot overrun timeoutMs.
  // No allocation may outlive the invocation it serves.
  const invocationLeft = Math.floor(invocation.deadline - Date.now());
  if (invocationLeft < 1) throw new Error('Invocation deadline has passed.');
  timeoutMs = Math.min(timeoutMs, invocationLeft);
  const overall = deadline(timeoutMs), cleanupReserve = Math.min(10_000, Math.floor(timeoutMs / 3));
  const remaining = deadline(Math.max(1, timeoutMs - cleanupReserve)), allocationId = randomUUID();
  const name = `codeboost-egress-${vendor}-${randomUUID()}`;
  const proxyContainer = `codeboost-proxy-${vendor}-${randomUUID()}`;
  const subnetSeed = randomUUID().replaceAll('-', '');
  const subnet = `10.254.${parseInt(subnetSeed.slice(0, 2), 16)}.${parseInt(subnetSeed.slice(2, 4), 16) & 0xf8}/29`;
  let networkPlanned = false, proxyPlanned = false;
  // IDs of the objects this call created; cleanup targets these, and names only for a create whose ID never returned.
  let networkId: string | undefined, proxyId: string | undefined;
  const unsettled = new Set<string>();
  const createdId = (value: string, kind: string) => {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Docker did not return the created ${kind} ID.`);
    return value;
  };
  // Run one create step; a client killed by its deadline leaves the daemon outcome for `object` unknown.
  const create = (object: string, args: readonly string[]) => {
    const timeout = remaining();
    try { return docker(args, timeout); }
    catch (error) {
      if (typeof (error as { status?: unknown }).status !== 'number') unsettled.add(object);
      throw error;
    }
  };
  // The first cleanup shares the caller's overall deadline; a later retry gets its own budget. Killed
  // creates get a settle window, bounded by whatever that budget has left.
  const cleanupPlannedResources = (budget: () => number = deadline(30_000)) => {
    let budgetLeft = 0;
    try { budgetLeft = budget(); } catch { /* the budget is spent */ }
    const settleBy = (object: string) => unsettled.has(object)
      ? performance.now() + Math.min(CREATE_SETTLE_MS, budgetLeft) : 0;
    const failures: unknown[] = [];
    // Target the created IDs; names only for a create whose ID never came back, which alone gets a settle window.
    const proxyTarget = proxyId ?? proxyContainer, networkTarget = networkId ?? name;
    if (proxyPlanned) try { remove(['rm', '--force', proxyTarget], ['container', 'inspect', proxyTarget],
      budget, 'vendor proxy', allocationId, proxyId ? 0 : settleBy(proxyContainer)); }
    catch (cleanupError) { failures.push(cleanupError); }
    if (networkPlanned) try { remove(['network', 'rm', networkTarget], ['network', 'inspect', networkTarget],
      budget, 'vendor network', allocationId, networkId ? 0 : settleBy(name)); }
    catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  };
  try {
    networkPlanned = true;
    networkId = createdId(create(name, ['network', 'create', '--internal', '--driver', 'bridge', '--subnet', subnet,
      '--label', `io.codeboost.egress=${allocationId}`, name]), 'network');
    proxyPlanned = true;
    proxyId = createdId(create(proxyContainer, ['run', '--detach', '--name', proxyContainer, '--read-only', '--user', '10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=64', '--memory=64m', '--memory-swap=64m',
      '--cpus=.25', '--network', name, '--network-alias', 'codeboost-proxy',
      '--label', `io.codeboost.egress=${allocationId}`, '--env', `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[vendor].join(',')}`,
      '--entrypoint', 'node', imageId, '/usr/local/lib/codeboost-egress-proxy.mjs']), 'proxy');
    docker(['network', 'connect', 'bridge', proxyId], remaining());
    docker(['exec', proxyId, 'node', '-e', [
      "const net=require('node:net');let attempts=0;",
      "const check=()=>{const socket=net.connect(3128,'127.0.0.1');",
      "socket.once('connect',()=>{socket.destroy();process.exit(0)});",
      "socket.once('error',()=>{socket.destroy();if(++attempts===50)process.exit(1);setTimeout(check,20)})};check();",
    ].join('')], remaining());
    const proxyInspect = JSON.parse(docker(['container', 'inspect', proxyId], remaining()))[0] as
      { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } } | undefined;
    const proxyIp = proxyInspect?.NetworkSettings?.Networks?.[name]?.IPAddress;
    if (!proxyIp || !/^10\.254\.\d{1,3}\.\d{1,3}$/.test(proxyIp))
      throw new Error('Vendor proxy did not receive its expected internal address.');
    const network = Object.freeze({ name, proxyContainer, proxyUrl: `http://${proxyIp}:3128`, vendor });
    identities.set(network, Object.freeze({ allocationId, imageId, invocation, subnet, proxyIp, networkId, proxyId }));
    validateVendorNetwork(network, invocation, undefined, remaining);
    remaining();
    return network;
  } catch (error) {
    try { cleanupPlannedResources(overall); }
    catch (cleanupError) {
      throw new VendorNetworkCreationCleanupError(error, cleanupError, () => cleanupPlannedResources());
    }
    throw error;
  }
}

export function removeVendorNetwork(network: VendorNetwork, timeoutMs = 30_000): void {
  const identity = identities.get(network);
  if (!identity) {
    if (removedNetworks.has(network)) return;
    throw new Error('Vendor network was not created by the trusted network builder.');
  }
  assertBuiltAgentImage(identity.imageId);
  const allocationId = identity.allocationId;
  const remaining = deadline(timeoutMs), failures: unknown[] = [];
  // Remove by the captured IDs; a same-named replacement is not ours to delete and keeps the network busy.
  try { remove(['rm', '--force', identity.proxyId], ['container', 'inspect', identity.proxyId],
    remaining, 'vendor proxy', allocationId); } catch (error) { failures.push(error); }
  try { remove(['network', 'rm', identity.networkId], ['network', 'inspect', identity.networkId],
    remaining, 'vendor network', allocationId); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  identities.delete(network);
  removedNetworks.add(network);
}

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { InvocationInput } from '../contract.ts';
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
  readonly subnet: string; readonly proxyIp: string }
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
const remove = (args: readonly string[], inspect: readonly string[], remaining: () => number, kind: string,
  allocationId: string) => {
  const before = spawnSync('docker', [...inspect], { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL',
    env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (before.status !== 0) {
    if (absent(before)) return;
    throw new Error(`Failed to establish ownership of ${kind}.`);
  }
  const inspected = JSON.parse(before.stdout || '[]')[0] as
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
  const inspect = JSON.parse(docker(['container', 'inspect', network.proxyContainer], remaining()))[0] as
    { State?: { Running?: boolean }; Config?: { Image?: string; User?: string; Labels?: Record<string, string>; Env?: string[];
      Entrypoint?: string[] | null; Cmd?: string[] | null };
      HostConfig?: { ReadonlyRootfs?: boolean; Privileged?: boolean; CapDrop?: string[]; CapAdd?: string[] | null;
        SecurityOpt?: string[]; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number;
        NetworkMode?: string; PidMode?: string; IpcMode?: string; UTSMode?: string; UsernsMode?: string;
        CgroupnsMode?: string; Devices?: unknown[] | null; DeviceRequests?: unknown[] | null;
        Dns?: string[]; DnsOptions?: string[]; DnsSearch?: string[]; ExtraHosts?: string[] | null;
        PortBindings?: Record<string, unknown> | null; PublishAllPorts?: boolean };
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }>; Ports?: Record<string, unknown> };
      Mounts?: unknown[] } | undefined;
  const image = JSON.parse(docker(['image', 'inspect', identity.imageId], remaining()))[0] as
    { Config?: { Env?: string[] } } | undefined;
  const inspectedNetwork = JSON.parse(docker(['network', 'inspect', network.name], remaining()))[0] as
    { Internal?: boolean; Driver?: string; Labels?: Record<string, string>; IPAM?: { Config?: Array<{ Subnet?: string }> };
      Containers?: Record<string, { Name?: string }> } | undefined;
  const networks = Object.keys(inspect?.NetworkSettings?.Networks ?? {}).sort();
  const endpoints = Object.values(inspectedNetwork?.Containers ?? {}).map(value => value.Name).sort();
  const allowedEndpoints = [network.proxyContainer, ...(agentName ? [agentName] : [])];
  const expectedEnvironment = [...(image?.Config?.Env ?? []),
    `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[network.vendor].join(',')}`].sort();
  if (!inspect?.State?.Running || inspect.Config?.Image !== identity.imageId || inspect.Config?.User !== '10001:10001'
    || inspect.Config?.Labels?.['io.codeboost.egress'] !== identity.allocationId || !inspect.HostConfig?.ReadonlyRootfs
    || inspect.HostConfig.Privileged || !inspect.HostConfig.CapDrop?.map(value => value.toUpperCase()).includes('ALL')
    || (inspect.HostConfig.CapAdd?.length ?? 0) || inspect.HostConfig.SecurityOpt?.length !== 2
    || !inspect.HostConfig.SecurityOpt.some(option => ['no-new-privileges', 'no-new-privileges:true'].includes(option))
    || !inspect.HostConfig.SecurityOpt.includes('seccomp=builtin')
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
  assertBuiltAgentImage(imageId);
  const vendor = invocation.vendor;
  const remaining = deadline(timeoutMs), allocationId = randomUUID();
  const name = `codeboost-egress-${vendor}-${randomUUID()}`;
  const proxyContainer = `codeboost-proxy-${vendor}-${randomUUID()}`;
  const subnetSeed = randomUUID().replaceAll('-', '');
  const subnet = `10.254.${parseInt(subnetSeed.slice(0, 2), 16)}.${parseInt(subnetSeed.slice(2, 4), 16) & 0xf8}/29`;
  let networkPlanned = false, proxyPlanned = false;
  try {
    networkPlanned = true;
    docker(['network', 'create', '--internal', '--driver', 'bridge', '--subnet', subnet,
      '--label', `io.codeboost.egress=${allocationId}`, name], remaining());
    proxyPlanned = true;
    docker(['run', '--detach', '--name', proxyContainer, '--read-only', '--user', '10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--pids-limit=64', '--memory=64m', '--memory-swap=64m',
      '--cpus=.25', '--network', name, '--network-alias', 'codeboost-proxy',
      '--label', `io.codeboost.egress=${allocationId}`, '--env', `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[vendor].join(',')}`,
      '--entrypoint', 'node', imageId, '/usr/local/lib/codeboost-egress-proxy.mjs'], remaining());
    docker(['network', 'connect', 'bridge', proxyContainer], remaining());
    docker(['exec', proxyContainer, 'node', '-e', [
      "const net=require('node:net');let attempts=0;",
      "const check=()=>{const socket=net.connect(3128,'127.0.0.1');",
      "socket.once('connect',()=>{socket.destroy();process.exit(0)});",
      "socket.once('error',()=>{socket.destroy();if(++attempts===50)process.exit(1);setTimeout(check,20)})};check();",
    ].join('')], remaining());
    const proxyInspect = JSON.parse(docker(['container', 'inspect', proxyContainer], remaining()))[0] as
      { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } } | undefined;
    const proxyIp = proxyInspect?.NetworkSettings?.Networks?.[name]?.IPAddress;
    if (!proxyIp || !/^10\.254\.\d{1,3}\.\d{1,3}$/.test(proxyIp))
      throw new Error('Vendor proxy did not receive its expected internal address.');
    const network = Object.freeze({ name, proxyContainer, proxyUrl: `http://${proxyIp}:3128`, vendor });
    identities.set(network, Object.freeze({ allocationId, imageId, invocation, subnet, proxyIp }));
    validateVendorNetwork(network, invocation, undefined, remaining);
    remaining();
    return network;
  } catch (error) {
    const failures: unknown[] = [];
    if (proxyPlanned) try { remove(['rm', '--force', proxyContainer], ['container', 'inspect', proxyContainer],
      deadline(30_000), 'vendor proxy', allocationId); } catch (cleanupError) { failures.push(cleanupError); }
    if (networkPlanned) try { remove(['network', 'rm', name], ['network', 'inspect', name],
      deadline(30_000), 'vendor network', allocationId); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Vendor network creation and cleanup failed.');
    throw error;
  }
}

export function removeVendorNetwork(network: VendorNetwork): void {
  const identity = identities.get(network);
  if (!identity) {
    if (removedNetworks.has(network)) return;
    throw new Error('Vendor network was not created by the trusted network builder.');
  }
  assertBuiltAgentImage(identity.imageId);
  const allocationId = identity.allocationId;
  const remaining = deadline(30_000), failures: unknown[] = [];
  try { remove(['rm', '--force', network.proxyContainer], ['container', 'inspect', network.proxyContainer],
    remaining, 'vendor proxy', allocationId); } catch (error) { failures.push(error); }
  try { remove(['network', 'rm', network.name], ['network', 'inspect', network.name],
    remaining, 'vendor network', allocationId); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  identities.delete(network);
  removedNetworks.add(network);
}

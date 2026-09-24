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
interface NetworkIdentity { readonly allocationId: string; readonly imageId: string }
const identities = new WeakMap<VendorNetwork, NetworkIdentity>();
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
  && /No such (?:object|container|network)/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
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

export function assertVendorNetwork(network: VendorNetwork, vendor?: InvocationInput['vendor']): void {
  const identity = identities.get(network);
  if (!identity) throw new Error('Vendor network was not created by the trusted network builder.');
  if (vendor && network.vendor !== vendor) throw new Error('Vendor network does not match the invocation vendor.');
  assertBuiltAgentImage(identity.imageId);
}

export function createVendorNetwork(vendor: InvocationInput['vendor'], imageId: string,
  timeoutMs = 60_000): VendorNetwork {
  assertBuiltAgentImage(imageId);
  const remaining = deadline(timeoutMs), allocationId = randomUUID();
  const name = `codeboost-egress-${vendor}-${randomUUID()}`;
  const proxyContainer = `codeboost-proxy-${vendor}-${randomUUID()}`;
  let networkPlanned = false, proxyPlanned = false;
  try {
    networkPlanned = true;
    docker(['network', 'create', '--internal', '--driver', 'bridge',
      '--label', `io.codeboost.egress=${allocationId}`, name], remaining());
    proxyPlanned = true;
    docker(['run', '--detach', '--name', proxyContainer, '--read-only', '--user', '10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=64m', '--memory-swap=64m',
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
    const inspect = JSON.parse(docker(['container', 'inspect', proxyContainer], remaining()))[0] as
      { State?: { Running?: boolean }; Config?: { Image?: string; User?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: { ReadonlyRootfs?: boolean; Privileged?: boolean; CapDrop?: string[]; CapAdd?: string[] | null;
          SecurityOpt?: string[]; Memory?: number; MemorySwap?: number; NanoCpus?: number };
        NetworkSettings?: { Networks?: Record<string, unknown> }; Mounts?: unknown[] } | undefined;
    const inspectedNetwork = JSON.parse(docker(['network', 'inspect', name], remaining()))[0] as
      { Internal?: boolean; Driver?: string; Labels?: Record<string, string> } | undefined;
    const networks = Object.keys(inspect?.NetworkSettings?.Networks ?? {}).sort();
    if (!inspect?.State?.Running || inspect.Config?.Image !== imageId || inspect.Config?.User !== '10001:10001'
      || inspect.Config?.Labels?.['io.codeboost.egress'] !== allocationId || !inspect.HostConfig?.ReadonlyRootfs
      || inspect.HostConfig.Privileged || !inspect.HostConfig.CapDrop?.map(value => value.toUpperCase()).includes('ALL')
      || (inspect.HostConfig.CapAdd?.length ?? 0) || inspect.HostConfig.SecurityOpt?.length !== 1
      || !['no-new-privileges', 'no-new-privileges:true'].includes(inspect.HostConfig.SecurityOpt[0] ?? '')
      || inspect.HostConfig.Memory !== 64 * 1024 * 1024
      || inspect.HostConfig.MemorySwap !== 64 * 1024 * 1024 || inspect.HostConfig.NanoCpus !== 250_000_000
      || JSON.stringify(networks) !== JSON.stringify(['bridge', name].sort())
      || inspect.Mounts?.length || !inspect.Config.Env?.includes(`CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[vendor].join(',')}`)
      || !inspectedNetwork?.Internal || inspectedNetwork.Driver !== 'bridge'
      || inspectedNetwork.Labels?.['io.codeboost.egress'] !== allocationId)
      throw new Error('Vendor proxy does not match its pinned isolation profile.');
    remaining();
    const network = Object.freeze({ name, proxyContainer, proxyUrl: 'http://codeboost-proxy:3128', vendor });
    identities.set(network, Object.freeze({ allocationId, imageId }));
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
  assertVendorNetwork(network);
  const allocationId = identities.get(network)!.allocationId;
  const remaining = deadline(30_000), failures: unknown[] = [];
  try { remove(['rm', '--force', network.proxyContainer], ['container', 'inspect', network.proxyContainer],
    remaining, 'vendor proxy', allocationId); } catch (error) { failures.push(error); }
  try { remove(['network', 'rm', network.name], ['network', 'inspect', network.name],
    remaining, 'vendor network', allocationId); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  identities.delete(network);
}

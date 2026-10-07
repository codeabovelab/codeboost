import { randomUUID } from 'node:crypto';
import { assertCapturedInvocation, type InvocationInput, type UnreleasedResource } from '../contract.ts';
import { createOutcomeUnknown, DOCKER_ID } from '../client-outcome.ts';
import { ALLOCATION_IN_USE, allocationListCommands, assertResourceOwner, claimAllocationId, hasOwnerLabels,
  ownerLabelArgs, ownerLabels, releaseAllocationId, type ResourceOwner } from '../labels.ts';
import { assertBuiltAgentImage } from '../container/image.ts';
import { docker as runDockerCommand, dockerEnvironment, pause, runDocker, type DockerOutcome } from '../docker.ts';
import { runTrackedDocker, runTrackedProcess, type ProcessGroupLifecycle } from '../tracked-docker.ts';

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
interface NetworkIdentity { readonly allocationId: string; readonly owner: ResourceOwner; readonly imageId: string; readonly invocation: InvocationInput;
  readonly subnet: string; readonly proxyIp: string;
  /** Daemon object IDs captured at creation; a same-named replacement has a different ID. */
  readonly networkId: string; readonly proxyId: string }
export class VendorNetworkCreationCleanupError extends AggregateError {
  readonly startupError: unknown;
  /** Retry the cleanup within `budgetMs` (default 30 s). */
  readonly retryCleanup: (budgetMs?: number) => Promise<void>;
  readonly #resources: () => readonly UnreleasedResource[];

  constructor(startupError: unknown, cleanupError: unknown, retryCleanup: (budgetMs?: number) => Promise<void>,
    resources: () => readonly UnreleasedResource[] = () => []) {
    super([startupError, cleanupError], 'Vendor network creation and cleanup failed.');
    this.startupError = startupError;
    this.retryCleanup = retryCleanup;
    this.#resources = resources;
  }
  /** The network and proxy this creation may still have left behind, as of now. */
  get resources(): readonly UnreleasedResource[] { return this.#resources(); }
}
// IDs are absent only for a create whose client was killed before it returned one.
const networkResources = (name: string, proxyContainer: string, owner: ResourceOwner, networkId?: string,
  proxyId?: string): readonly UnreleasedResource[] => {
  const labels = Object.freeze({ 'io.codeboost.egress': owner.allocationId, ...ownerLabels(owner) });
  return Object.freeze([
    Object.freeze({ kind: 'container' as const, name: proxyContainer, ...(proxyId ? { id: proxyId } : {}), labels }),
    Object.freeze({ kind: 'network' as const, name, ...(networkId ? { id: networkId } : {}), labels }),
  ]);
};
// Fails closed: an unanswered list cannot prove the ID is unused. Throws when more than `expected` objects carry it.
// The three lists are independent, so ordinary callers run them in parallel. A durable owner permits only one
// subprocess at a time, so lifecycle callers serialize them and refresh the shared deadline before each command.
const assertAllocationObjects = async (allocationId: string, expected: number, remaining: () => number,
  signal?: AbortSignal, lifecycle?: ProcessGroupLifecycle) => {
  const commands = allocationListCommands(allocationId);
  const results: DockerOutcome[] = [];
  if (lifecycle) {
    for (const command of commands) results.push(await runTrackedProcess('docker', command,
      { env: dockerEnvironment(), timeoutMs: remaining(), signal, lifecycle }));
  } else {
    results.push(...await Promise.all(commands.map(command =>
      runDocker(command, { timeoutMs: remaining(), signal }))));
  }
  if (results.some(result => result.status !== 0)) throw new Error('Could not confirm that allocationId is unused.');
  const found = results.reduce((count, result) => count + result.stdout.split('\n').filter(line => line.trim()).length, 0);
  if (found > expected) throw new Error(ALLOCATION_IN_USE);
};
const identities = new WeakMap<VendorNetwork, NetworkIdentity>();
// Parts of a network whose removal is already confirmed, while the other part is still being retried.
const removedParts = new WeakMap<VendorNetwork, Set<UnreleasedResource['kind']>>();
/** The daemon objects a vendor network still owns, for reporting when their removal is not confirmed. */
export function vendorNetworkResources(network: VendorNetwork): readonly UnreleasedResource[] {
  const identity = identities.get(network);
  if (!identity) return Object.freeze([]);
  const removed = removedParts.get(network);
  return Object.freeze(networkResources(network.name, network.proxyContainer, identity.owner,
    identity.networkId, identity.proxyId).filter(resource => !removed?.has(resource.kind)));
}
const removedNetworks = new WeakSet<VendorNetwork>();
const deadline = (timeoutMs: number) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Network deadline must be a positive integer.');
  const end = performance.now() + timeoutMs;
  return () => {
    const value = Math.ceil(end - performance.now());
    if (value <= 0) throw new Error('Vendor network operation exceeded its overall deadline.');
    return value;
  };
};
const docker = (args: readonly string[], timeout: number, signal?: AbortSignal, lifecycle?: ProcessGroupLifecycle) =>
  lifecycle ? runTrackedDocker(args, { timeoutMs: timeout, signal, lifecycle })
    : runDockerCommand(args, { timeoutMs: timeout, signal });
const dockerOutcome = (args: readonly string[], timeout: number, lifecycle?: ProcessGroupLifecycle) => lifecycle
  ? runTrackedProcess('docker', args, { env: dockerEnvironment(), timeoutMs: timeout, lifecycle })
  : runDocker(args, { timeoutMs: timeout });
const absent = (result: DockerOutcome) => result.status !== 0 && result.status !== null && !result.error
  && /(?:No such (?:object|container|network)|network .* not found)/i.test(`${result.stdout}\n${result.stderr}`);
/** How long a network or proxy whose create client was killed may still materialize in the daemon. */
const CREATE_SETTLE_MS = 10_000;
// Cleanup is never cancelled: it runs to its own deadline so nothing is dropped.
// Remove one owned object. Looks it up by `target` (its ID, or its name for a create whose ID never came back), then
// removes and confirms by the ID the daemon just reported: a same-named replacement created after the lookup is never
// touched. A captured ID proves the object is the one this code created (Docker never reuses IDs), so it is removed
// even if its labels are wrong, as when validation refused it for that. A name proves nothing: an object found by
// name is removed only if it carries the egress label and all three owner labels.
const remove = async (object: 'container' | 'network', target: string, remaining: () => number, kind: string,
  owner: ResourceOwner, settleBy = 0, lifecycle?: ProcessGroupLifecycle) => {
  const inspect = (ref: string) => dockerOutcome([object, 'inspect', ref], remaining(), lifecycle);
  let before: DockerOutcome;
  for (;;) {
    before = await inspect(target);
    if (before.status === 0) break;
    if (!absent(before)) throw new Error(`Failed to establish ownership of ${kind}.`);
    // A killed create may still land; only absence after the settle window counts.
    if (performance.now() >= settleBy) return;
    await pause(250);
  }
  const inspected = JSON.parse(String(before.stdout || '[]'))[0] as
    { Id?: string; Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } } | undefined;
  const labels = inspected?.Labels ?? inspected?.Config?.Labels;
  if (!DOCKER_ID.test(target) && (labels?.['io.codeboost.egress'] !== owner.allocationId
    || !hasOwnerLabels(labels, owner))) throw new Error(`Refused to remove unowned ${kind}.`);
  const id = inspected?.Id;
  if (!id || !DOCKER_ID.test(id) || (DOCKER_ID.test(target) && id !== target))
    throw new Error(`Failed to establish the identity of ${kind}.`);
  const result = await dockerOutcome(object === 'container' ? ['rm', '--force', id] : ['network', 'rm', id],
    remaining(), lifecycle);
  if (result.status === 0) return;
  if (!absent(await inspect(id))) throw new Error(`Failed to confirm removal of ${kind}.`);
};

const validateVendorNetwork = async (network: VendorNetwork, invocation: InvocationInput | undefined,
  agentName: string | undefined, remaining: () => number, signal?: AbortSignal,
  lifecycle?: ProcessGroupLifecycle): Promise<void> => {
  const identity = identities.get(network);
  if (!identity) throw new Error('Vendor network was not created by the trusted network builder.');
  if (invocation && (identity.invocation !== invocation || network.vendor !== invocation.vendor))
    throw new Error('Vendor network does not belong to this invocation.');
  assertBuiltAgentImage(identity.imageId);
  // Inspect by the captured IDs, so a removed-and-recreated network or proxy cannot stand in for the original.
  const inspectAllocated = async (args: readonly string[]) => {
    try { return await docker(args, remaining(), signal, lifecycle); }
    catch (cause) { throw new Error('Vendor network or proxy changed after allocation.', { cause }); }
  };
  const inspect = JSON.parse(await inspectAllocated(['container', 'inspect', identity.proxyId]))[0] as
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
  const image = JSON.parse(await docker(['image', 'inspect', identity.imageId], remaining(), signal, lifecycle))[0] as
    { Config?: { Env?: string[] } } | undefined;
  const inspectedNetwork = JSON.parse(await inspectAllocated(['network', 'inspect', identity.networkId]))[0] as
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
    || !hasOwnerLabels(inspect.Config?.Labels, identity.owner)
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
    || !hasOwnerLabels(inspectedNetwork.Labels, identity.owner)
    || inspectedNetwork.IPAM?.Config?.length !== 1 || inspectedNetwork.IPAM.Config[0]?.Subnet !== identity.subnet
    || !endpoints.includes(network.proxyContainer) || endpoints.some(name => !name || !allowedEndpoints.includes(name)))
    throw new Error('Vendor network or proxy changed after allocation.');
  remaining();
};

// Async, so an invalid deadline rejects like every other failure instead of throwing synchronously.
export async function assertVendorNetwork(network: VendorNetwork, invocation?: InvocationInput, agentName?: string,
  timeoutMs = 30_000, signal?: AbortSignal, lifecycle?: ProcessGroupLifecycle): Promise<void> {
  return validateVendorNetwork(network, invocation, agentName, deadline(timeoutMs), signal, lifecycle);
}

/**
 * Create the vendor-only network and its egress proxy. `signal` cancels setup: the in-flight Docker call is killed,
 * and everything created so far is removed (cleanup itself is not cancelled) before the promise rejects.
 */
export async function createVendorNetwork(invocation: InvocationInput, imageId: string, allocationId: string,
  timeoutMs = 60_000, signal?: AbortSignal, processLifecycle?: ProcessGroupLifecycle,
  invocationBudget?: () => number): Promise<VendorNetwork> {
  assertCapturedInvocation(invocation);
  assertBuiltAgentImage(imageId);
  // The network and proxy carry the invocation's runner and attempt and this caller-chosen allocation ID.
  const owner = assertResourceOwner({ runnerOwner: invocation.runnerOwner, attemptId: invocation.attemptId,
    allocationId });
  const labels = ownerLabelArgs(owner);
  const vendor = invocation.vendor;
  // Setup runs inside the caller's budget minus a cleanup reserve, so failure cleanup cannot overrun timeoutMs.
  // No allocation may outlive the invocation it serves.
  const invocationLeft = Math.floor(invocationBudget?.() ?? invocation.deadline - Date.now());
  if (invocationLeft < 1) throw new Error('Invocation deadline has passed.');
  timeoutMs = Math.min(timeoutMs, invocationLeft);
  const overall = deadline(timeoutMs), cleanupReserve = Math.min(10_000, Math.floor(timeoutMs / 3));
  const remaining = deadline(Math.max(1, timeoutMs - cleanupReserve));
  const name = `codeboost-egress-${vendor}-${randomUUID()}`;
  const proxyContainer = `codeboost-proxy-${vendor}-${randomUUID()}`;
  const subnetSeed = randomUUID().replaceAll('-', '');
  const subnet = `10.254.${parseInt(subnetSeed.slice(0, 2), 16)}.${parseInt(subnetSeed.slice(2, 4), 16) & 0xf8}/29`;
  let networkPlanned = false, proxyPlanned = false;
  // IDs of the objects this call created; cleanup targets these, and names only for a create whose ID never returned.
  let networkId: string | undefined, proxyId: string | undefined, registered: VendorNetwork | undefined;
  const unsettled = new Set<string>(), created = new Set<string>();
  const createdId = (value: string, kind: string) => {
    if (!DOCKER_ID.test(value)) throw new Error(`Docker did not return the created ${kind} ID.`);
    return value;
  };
  // Run one create step; a client killed by its deadline leaves the daemon outcome for `object` unknown.
  // Each create is a pure create, so a daemon-answered failure (such as a name held by someone else) made nothing.
  const create = async (object: string, args: readonly string[]) => {
    const timeout = remaining();
    try {
      const output = await docker(args, timeout, signal, processLifecycle);
      created.add(object);
      return output;
    } catch (error) {
      if (createOutcomeUnknown(error)) unsettled.add(object);
      throw error;
    }
  };
  // The first cleanup shares the caller's overall deadline; a later retry gets its own budget. Killed
  // creates get a settle window, bounded by whatever that budget has left.
  // Objects whose removal (or absence) cleanup has confirmed.
  let proxyGone = false, networkGone = false;
  // An object may exist only if its create succeeded or its client was killed before the daemon answered; a create
  // the daemon refused made nothing.
  const mayExist = (kind: UnreleasedResource['kind']) => kind === 'network'
    ? networkPlanned && !networkGone && (created.has(name) || unsettled.has(name))
    : proxyPlanned && !proxyGone && (created.has(proxyContainer) || unsettled.has(proxyContainer));
  const cleanupPlannedResources = async (budget: () => number = deadline(30_000)) => {
    let budgetLeft = 0;
    try { budgetLeft = budget(); } catch { /* the budget is spent */ }
    const settleBy = (object: string) => unsettled.has(object)
      ? performance.now() + Math.min(CREATE_SETTLE_MS, budgetLeft) : 0;
    const failures: unknown[] = [];
    // Target the created IDs; names only for a create whose ID never came back, which alone gets a settle window.
    const proxyTarget = proxyId ?? proxyContainer, networkTarget = networkId ?? name;
    // A create the daemon refused made nothing, so its name (which may belong to someone else) is not touched.
    if (!mayExist('container')) proxyGone = true;
    if (!mayExist('network')) networkGone = true;
    if (proxyPlanned && !proxyGone) try {
      await remove('container', proxyTarget,
        budget, 'vendor proxy', owner, proxyId ? 0 : settleBy(proxyContainer), processLifecycle);
      proxyGone = true;
    } catch (cleanupError) { failures.push(cleanupError); }
    if (networkPlanned && !networkGone) try {
      await remove('network', networkTarget,
        budget, 'vendor network', owner, networkId ? 0 : settleBy(name), processLifecycle);
      networkGone = true;
    } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  };
  claimAllocationId(allocationId);
  // Nothing created yet: a reused ID (still labelling objects from any earlier process) is refused here.
  try { await assertAllocationObjects(allocationId, 0, remaining, signal, processLifecycle); }
  catch (error) { releaseAllocationId(allocationId); throw error; }
  try {
    networkPlanned = true;
    signal?.throwIfAborted();
    networkId = createdId(await create(name, ['network', 'create', '--internal', '--driver', 'bridge', '--subnet', subnet,
      '--label', `io.codeboost.egress=${allocationId}`, ...labels, name]), 'network');
    // The check above and this create are not atomic across processes. Once our network exists, it must be the only
    // object carrying the ID: of two racing allocations, the later check sees both and backs out.
    await assertAllocationObjects(allocationId, 1, remaining, signal, processLifecycle);
    proxyPlanned = true;
    // Create and start separately: a refused create made nothing, while a failed start leaves a container we own by ID.
    proxyId = createdId(await create(proxyContainer, ['create', '--name', proxyContainer, '--read-only', '--user', '10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=64', '--memory=64m', '--memory-swap=64m',
      '--cpus=.25', '--network', name, '--network-alias', 'codeboost-proxy',
      '--label', `io.codeboost.egress=${allocationId}`, ...labels,
      '--env', `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS[vendor].join(',')}`,
      '--entrypoint', 'node', imageId, '/usr/local/lib/codeboost-egress-proxy.mjs']), 'proxy');
    await docker(['start', proxyId], remaining(), signal, processLifecycle);
    await docker(['network', 'connect', 'bridge', proxyId], remaining(), signal, processLifecycle);
    await docker(['exec', proxyId, 'node', '-e', [
      "const net=require('node:net');let attempts=0;",
      "const check=()=>{const socket=net.connect(3128,'127.0.0.1');",
      "socket.once('connect',()=>{socket.destroy();process.exit(0)});",
      "socket.once('error',()=>{socket.destroy();if(++attempts===50)process.exit(1);setTimeout(check,20)})};check();",
    ].join('')], remaining(), signal, processLifecycle);
    const proxyInspect = JSON.parse(await docker(['container', 'inspect', proxyId], remaining(), signal, processLifecycle))[0] as
      { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } } | undefined;
    const proxyIp = proxyInspect?.NetworkSettings?.Networks?.[name]?.IPAddress;
    if (!proxyIp || !/^10\.254\.\d{1,3}\.\d{1,3}$/.test(proxyIp))
      throw new Error('Vendor proxy did not receive its expected internal address.');
    const network = Object.freeze({ name, proxyContainer, proxyUrl: `http://${proxyIp}:3128`, vendor });
    identities.set(network, Object.freeze({ allocationId, owner, imageId, invocation, subnet, proxyIp, networkId,
      proxyId }));
    registered = network;
    await validateVendorNetwork(network, invocation, undefined, remaining, signal, processLifecycle);
    remaining();
    signal?.throwIfAborted();
    releaseAllocationId(allocationId);
    return network;
  } catch (error) {
    // A network registered before a late failure or abort is never handed out, so it must not stay trusted.
    if (registered) identities.delete(registered);
    try { await cleanupPlannedResources(overall); }
    catch (cleanupError) {
      // The claim is kept: a killed create may still land under this allocation ID.
      throw new VendorNetworkCreationCleanupError(error, cleanupError,
        // A retry that settles releases the claim; one that still fails keeps it.
        async (budgetMs = 30_000) => {
          await cleanupPlannedResources(deadline(budgetMs));
          releaseAllocationId(allocationId);
        },
        () => networkResources(name, proxyContainer, owner, networkId, proxyId)
          .filter(resource => mayExist(resource.kind)));
    }
    releaseAllocationId(allocationId);
    throw error;
  }
}

export async function removeVendorNetwork(network: VendorNetwork, timeoutMs = 30_000,
  processLifecycle?: ProcessGroupLifecycle): Promise<void> {
  const identity = identities.get(network);
  if (!identity) {
    if (removedNetworks.has(network)) return;
    throw new Error('Vendor network was not created by the trusted network builder.');
  }
  assertBuiltAgentImage(identity.imageId);
  const remaining = deadline(timeoutMs), failures: unknown[] = [];
  // Remove by the captured IDs; a same-named replacement is not ours to delete and keeps the network busy.
  const removed = removedParts.get(network) ?? new Set<UnreleasedResource['kind']>();
  removedParts.set(network, removed);
  if (!removed.has('container')) try {
    await remove('container', identity.proxyId,
      remaining, 'vendor proxy', identity.owner, 0, processLifecycle);
    removed.add('container');
  } catch (error) { failures.push(error); }
  if (!removed.has('network')) try {
    await remove('network', identity.networkId,
      remaining, 'vendor network', identity.owner, 0, processLifecycle);
    removed.add('network');
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Vendor network cleanup did not settle.');
  identities.delete(network);
  removedNetworks.add(network);
}

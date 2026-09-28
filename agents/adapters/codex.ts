import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile, ProfileCreationCleanupError, type ContainerProfile } from '../container/profile.ts';
import { agentContainerId } from '../container/run.ts';
import { createVendorNetwork, removeVendorNetwork, VendorNetworkCreationCleanupError,
  type VendorNetwork } from '../network/network.ts';
import { createCodexCommand, createPhasePolicy } from '../policy.ts';
import { readBoundedContainerFile, retainNetworkCleanup, retainSetupCleanup,
  startProfileInvocation } from './supervisor.ts';
import { createAdapterInvocationBudget, type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

export const CODEX_OUTPUT_FILE = '/run/codeboost-output/final.txt';
// Read the output from the container this invocation created, by ID; a same-named replacement must not answer.
const codexContainer = (profile: ContainerProfile) => {
  const id = agentContainerId(profile);
  if (!id) throw new Error('The Codex container ID is unknown.');
  return id;
};

export async function readCodexOutput(container: string, maximumBytes: number, timeoutMs = 30_000,
  signal?: AbortSignal) {
  const output = await readBoundedContainerFile(container, CODEX_OUTPUT_FILE, maximumBytes, timeoutMs, signal);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  return Object.freeze({ text, additionalBytes: output.length });
}

export function startCodexInvocation(request: AgentAdapterRequest,
  authFile: string, options: AgentAdapterOptions = {}): InvocationHandle {
  if (!authFile || authFile.includes('\0')) throw new Error('Codex auth path is malformed.');
  const policy = createPhasePolicy(request.invocation);
  const remaining = createAdapterInvocationBudget(request.invocation, options.timeoutMs);
  let network: VendorNetwork;
  try { network = createVendorNetwork(request.invocation, request.imageId, Math.min(60_000, remaining())); }
  catch (error) {
    if (error instanceof VendorNetworkCreationCleanupError)
      return retainSetupCleanup(request.invocation, budget => error.retryCleanup(budget), error.startupError, error,
        'network creation cleanup', () => error.resources);
    throw error;
  }
  try {
    const profile = createContainerProfile({ ...request, policy, network,
      command: createCodexCommand(policy, request.prompt), codexAuthFile: authFile, deferredOutput: true,
      timeoutMs: Math.min(60_000, remaining()) });
    return startProfileInvocation(profile, { ...options,
      invocationBudget: remaining,
      decode: (current, _raw, maximum, timeoutMs, signal) =>
        readCodexOutput(codexContainer(current), maximum, timeoutMs, signal) });
  } catch (error) {
    // Profile creation already tried its cleanup, which removes this network too, and failed. Retry that one cleanup
    // with the window's budget; removing the network again here would start a second full deadline per retry.
    if (error instanceof ProfileCreationCleanupError)
      return retainSetupCleanup(request.invocation, budget => error.retryCleanup(budget), error.startupError, error,
        'profile and network cleanup', () => error.resources);
    try { removeVendorNetwork(network, Math.min(30_000, remaining())); }
    catch (cleanupError) { return retainNetworkCleanup(request.invocation, network, error, cleanupError); }
    throw error;
  }
}

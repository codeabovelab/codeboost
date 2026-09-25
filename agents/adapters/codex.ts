import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile, ProfileCreationCleanupError } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork, VendorNetworkCreationCleanupError,
  type VendorNetwork } from '../network/network.ts';
import { createCodexCommand, createPhasePolicy } from '../policy.ts';
import { readBoundedContainerFile, retainNetworkCleanup, retainSetupCleanup,
  startProfileInvocation } from './supervisor.ts';
import { createAdapterInvocationBudget, type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

export const CODEX_OUTPUT_FILE = '/run/codeboost-output/final.txt';

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
      return retainSetupCleanup(request.invocation, error.retryCleanup, error.startupError, error,
        'network creation cleanup');
    throw error;
  }
  try {
    const profile = createContainerProfile({ ...request, policy, network,
      command: createCodexCommand(policy, request.prompt), codexAuthFile: authFile, deferredOutput: true,
      timeoutMs: Math.min(60_000, remaining()) });
    return startProfileInvocation(profile, { ...options,
      invocationBudget: remaining,
      decode: (current, _raw, maximum, timeoutMs, signal) =>
        readCodexOutput(current.name, maximum, timeoutMs, signal) });
  } catch (error) {
    if (error instanceof ProfileCreationCleanupError) {
      const retryCleanup = () => {
        const failures: unknown[] = [];
        try { error.retryCleanup(); } catch (cleanupError) { failures.push(cleanupError); }
        try { removeVendorNetwork(network); } catch (cleanupError) { failures.push(cleanupError); }
        if (failures.length) throw new AggregateError(failures, 'Adapter setup cleanup did not settle.');
      };
      try { retryCleanup(); }
      catch (cleanupError) { return retainSetupCleanup(request.invocation, retryCleanup,
        error.startupError, cleanupError, 'profile and network cleanup'); }
      throw error.startupError;
    }
    try { removeVendorNetwork(network); }
    catch (cleanupError) { return retainNetworkCleanup(request.invocation, network, error, cleanupError); }
    throw error;
  }
}

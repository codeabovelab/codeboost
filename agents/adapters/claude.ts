import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile, ProfileCreationCleanupError } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork, VendorNetworkCreationCleanupError,
  type VendorNetwork } from '../network/network.ts';
import { createClaudeCommand, createPhasePolicy } from '../policy.ts';
import { retainNetworkCleanup, retainSetupCleanup, startProfileInvocation } from './supervisor.ts';
import { createAdapterInvocationBudget, type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

export function parseClaudeOutput(raw: Buffer): { text: string; providerFailed: boolean } {
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
    { result?: unknown; is_error?: unknown };
  if (typeof envelope.result !== 'string' || typeof envelope.is_error !== 'boolean')
    throw new Error('Claude returned a malformed output envelope.');
  return Object.freeze({ text: envelope.result, providerFailed: envelope.is_error });
}

export function startClaudeInvocation(request: AgentAdapterRequest,
  oauthToken: string, options: AgentAdapterOptions = {}): InvocationHandle {
  if (!oauthToken || oauthToken.includes('\0')) throw new Error('Claude OAuth token is malformed.');
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
      command: createClaudeCommand(policy, request.prompt), claudeToken: oauthToken,
      timeoutMs: Math.min(60_000, remaining()) });
    return startProfileInvocation(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      invocationBudget: remaining,
      decode: (_profile, raw) => parseClaudeOutput(raw) });
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

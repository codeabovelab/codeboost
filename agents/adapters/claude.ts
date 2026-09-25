import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile, ProfileCreationCleanupError } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork, VendorNetworkCreationCleanupError,
  type VendorNetwork } from '../network/network.ts';
import { createClaudeCommand, createPhasePolicy } from '../policy.ts';
import { retainNetworkCleanup, retainSetupCleanup, startProfileInvocation } from './supervisor.ts';
import type { AgentAdapterOptions, AgentAdapterRequest } from './types.ts';

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
  const remaining = () => {
    const value = request.invocation.deadline - Date.now();
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invocation deadline expired during adapter setup.');
    return Math.min(60_000, value);
  };
  let network: VendorNetwork;
  try { network = createVendorNetwork(request.invocation, request.imageId, remaining()); }
  catch (error) {
    if (error instanceof VendorNetworkCreationCleanupError)
      return retainSetupCleanup(request.invocation, error.retryCleanup, error.startupError, error,
        'network creation cleanup');
    throw error;
  }
  try {
    const profile = createContainerProfile({ ...request, policy, network,
      command: createClaudeCommand(policy, request.prompt), claudeToken: oauthToken, timeoutMs: remaining() });
    return startProfileInvocation(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      decode: (_profile, raw) => parseClaudeOutput(raw) });
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

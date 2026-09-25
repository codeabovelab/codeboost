import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork } from '../network/network.ts';
import { createClaudeCommand, createPhasePolicy } from '../policy.ts';
import { retainNetworkCleanup, startProfileInvocation } from './supervisor.ts';
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
  const network = createVendorNetwork(request.invocation, request.imageId);
  try {
    const profile = createContainerProfile({ ...request, policy, network,
      command: createClaudeCommand(policy, request.prompt), claudeToken: oauthToken });
    return startProfileInvocation(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      decode: (_profile, raw) => parseClaudeOutput(raw) });
  } catch (error) {
    try { removeVendorNetwork(network); }
    catch (cleanupError) { return retainNetworkCleanup(request.invocation, network, error, cleanupError); }
    throw error;
  }
}

import type { InvocationHandle } from '../contract.ts';
import { createClaudeCommand, createPhasePolicy } from '../policy.ts';
import { launchInvocation } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
import { assertAdapterRequest, createAdapterInvocationBudget, type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

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
  // Invalid input throws here, before anything is allocated; only Docker setup runs inside the handle.
  assertAdapterRequest(request);
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command: createClaudeCommand(policy, request.prompt),
      claudeToken: oauthToken }),
    profile => start(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      invocationBudget: remaining, decode: (_profile, raw) => parseClaudeOutput(raw) })));
}

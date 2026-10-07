import { join } from 'node:path';
import type { InvocationHandle } from '../contract.ts';
import { readCapturedFile } from '../container/profile.ts';
import { createClaudeCommand, createPhasePolicy, MAX_COMMAND_SCHEMA_BYTES } from '../policy.ts';
import { launchInvocation } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
import { assertAdapterRequest, capAdapterInvocationBudget, createAdapterInvocationBudget,
  type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

/**
 * Read Claude's `--output-format json` envelope. A result whose `subtype` is not `success`, or whose `is_error` is
 * true, is a provider failure; it can omit `result`. With `--json-schema` (planning), a successful answer needs
 * `subtype: "success"` and is the schema-validated `structured_output` object, returned as JSON text; `result` then
 * holds only Claude's prose. Plain-text envelopes without a `subtype` are still accepted.
 */
export function parseClaudeOutput(raw: Buffer, structured = false): { text: string; providerFailed: boolean } {
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
    { subtype?: unknown; result?: unknown; is_error?: unknown; structured_output?: unknown };
  if (typeof envelope.is_error !== 'boolean' || (envelope.result !== undefined && typeof envelope.result !== 'string')
    || (envelope.subtype !== undefined && typeof envelope.subtype !== 'string'))
    throw new Error('Claude returned a malformed output envelope.');
  const prose = envelope.result ?? '';
  if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== 'success'))
    return Object.freeze({ text: prose, providerFailed: true });
  if (!structured) {
    if (envelope.result === undefined) throw new Error('Claude returned a malformed output envelope.');
    return Object.freeze({ text: prose, providerFailed: false });
  }
  // Claude always reports a subtype; a schema-constrained answer is accepted only from an explicit success.
  if (envelope.subtype !== 'success') throw new Error('Claude returned a malformed output envelope.');
  const answer = envelope.structured_output;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer))
    throw new Error('Claude returned no structured output for a schema-constrained answer.');
  return Object.freeze({ text: JSON.stringify(answer), providerFailed: false });
}

/**
 * Read the planning schema for `--json-schema` with the profile's bounded no-follow reader. The profile captures the
 * mounted file again and refuses a command whose schema differs.
 */
export function readPlanningSchema(inputDirectory: string): string {
  const { content } = readCapturedFile(join(inputDirectory, 'schema.json'), 'Planning schema', MAX_COMMAND_SCHEMA_BYTES);
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}

export function startClaudeInvocation(request: AgentAdapterRequest,
  oauthToken: string, options: AgentAdapterOptions = {}): InvocationHandle {
  if (!oauthToken || oauthToken.includes('\0')) throw new Error('Claude OAuth token is malformed.');
  const policy = createPhasePolicy(request.invocation);
  const remaining = options.invocationBudget
    ? capAdapterInvocationBudget(options.invocationBudget, options.timeoutMs)
    : createAdapterInvocationBudget(request.invocation, options.timeoutMs);
  const structured = policy.phase === 'planning';
  // Invalid input throws here, before anything is allocated; only Docker setup runs inside the handle.
  const command = createClaudeCommand(policy, request.prompt,
    structured ? readPlanningSchema(request.inputDirectory) : undefined);
  assertAdapterRequest(request);
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command, claudeToken: oauthToken }),
    profile => start(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      processLifecycle: request.processLifecycle,
      invocationBudget: remaining, decode: (_profile, raw) => parseClaudeOutput(raw, structured) })));
}

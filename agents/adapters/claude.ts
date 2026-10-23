import { join } from 'node:path';
import type { InvocationHandle } from '../contract.ts';
import { readCapturedFile } from '../container/profile.ts';
import { createClaudeCommand, createPhasePolicy, MAX_COMMAND_SCHEMA_BYTES, STRUCTURED_PHASES } from '../policy.ts';
import { launchInvocation } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
import { assertAdapterRequest, capAdapterInvocationBudget, createAdapterInvocationBudget,
  type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

/**
 * The exact source text of each member of a top-level JSON object, by key. `json` must already have passed
 * `JSON.parse` as an object, so only string and nesting boundaries are tracked here; every loop also stops at the end
 * of the text, so other input cannot hang it. Refuses a key that appears twice, where `JSON.parse` would silently keep
 * the last value.
 */
function topLevelMembers(json: string): Map<string, string> {
  const members = new Map<string, string>();
  const isSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n' || char === '\r';
  let at = 0;
  const skipSpace = () => { while (isSpace(json[at])) at++; };
  const skipString = () => { // `at` is on the opening quote; leaves `at` after the closing one.
    for (at++; at < json.length && json[at] !== '"'; at++) if (json[at] === '\\') at++;
    at++;
  };
  skipSpace(); at++; // '{'
  for (skipSpace(); at < json.length && json[at] !== '}'; skipSpace()) {
    const keyStart = at; skipString();
    const key = JSON.parse(json.slice(keyStart, at)) as string;
    skipSpace(); at++; skipSpace(); // ':'
    const valueStart = at;
    if (json[at] === '"') skipString();
    else if (json[at] === '{' || json[at] === '[') {
      let depth = 0;
      do {
        if (json[at] === '"') { skipString(); continue; }
        if (json[at] === '{' || json[at] === '[') depth++;
        else if (json[at] === '}' || json[at] === ']') depth--;
        at++;
      } while (depth > 0 && at < json.length);
    } else while (at < json.length && !isSpace(json[at]) && json[at] !== ',' && json[at] !== '}') at++;
    if (members.has(key)) throw new Error('Claude returned a malformed output envelope.');
    members.set(key, json.slice(valueStart, at));
    skipSpace(); if (json[at] === ',') at++;
  }
  return members;
}

/**
 * Read Claude's `--output-format json` envelope. A result whose `subtype` is not `success`, or whose `is_error` is
 * true, is a provider failure; it can omit `result`, and when `result` is missing or empty its `errors` strings are
 * the text. With `--json-schema` (planning), a successful answer needs `subtype: "success"` and is the
 * schema-validated `structured_output` object. It is returned as the exact JSON text of that member in the CLI's
 * envelope, never re-encoded here, so the plan parser sees any duplicate key or inexact integer the envelope holds
 * (#166). Whether the API or CLI resolves those before writing the envelope is not verified. With a schema, an
 * envelope that repeats a top-level key is malformed, whatever it reports. `result` then holds only Claude's prose.
 * Plain-text envelopes without a `subtype` are still accepted.
 */
export function parseClaudeOutput(raw: Buffer, structured = false): { text: string; providerFailed: boolean } {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const envelope = JSON.parse(source) as
    { subtype?: unknown; result?: unknown; is_error?: unknown; structured_output?: unknown; errors?: unknown };
  // Read every member before classifying: JSON.parse keeps only the last of a repeated key, such as `is_error`.
  const members = structured && envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
    ? topLevelMembers(source) : null;
  if (typeof envelope.is_error !== 'boolean' || (envelope.result !== undefined && typeof envelope.result !== 'string')
    || (envelope.subtype !== undefined && typeof envelope.subtype !== 'string'))
    throw new Error('Claude returned a malformed output envelope.');
  const prose = envelope.result ?? '';
  if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== 'success')) {
    // A run the CLI stops itself, such as at `--max-turns` (#163), gives no `result`, only its `errors` strings.
    const errors = Array.isArray(envelope.errors) ? envelope.errors.filter(error => typeof error === 'string') : [];
    return Object.freeze({ text: envelope.result || errors.join('; '), providerFailed: true });
  }
  if (!structured) {
    if (envelope.result === undefined) throw new Error('Claude returned a malformed output envelope.');
    return Object.freeze({ text: prose, providerFailed: false });
  }
  // Claude always reports a subtype; a schema-constrained answer is accepted only from an explicit success.
  if (envelope.subtype !== 'success') throw new Error('Claude returned a malformed output envelope.');
  const answer = envelope.structured_output;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer))
    throw new Error('Claude returned no structured output for a schema-constrained answer.');
  return Object.freeze({ text: members!.get('structured_output')!, providerFailed: false });
}

/**
 * Read the planning or review schema for `--json-schema` with the profile's bounded no-follow reader. The profile
 * captures the mounted file again and refuses a command whose schema differs.
 */
export function readPlanningSchema(inputDirectory: string, label = 'Planning schema'): string {
  const { content } = readCapturedFile(join(inputDirectory, 'schema.json'), label, MAX_COMMAND_SCHEMA_BYTES);
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}

export function startClaudeInvocation(request: AgentAdapterRequest,
  oauthToken: string, options: AgentAdapterOptions = {}): InvocationHandle {
  if (!oauthToken || oauthToken.includes('\0')) throw new Error('Claude OAuth token is malformed.');
  const policy = createPhasePolicy(request.invocation);
  const remaining = options.invocationBudget
    ? capAdapterInvocationBudget(options.invocationBudget, options.timeoutMs)
    : createAdapterInvocationBudget(request.invocation, options.timeoutMs);
  const structured = STRUCTURED_PHASES.has(policy.phase);
  // Invalid input throws here, before anything is allocated; only Docker setup runs inside the handle.
  const command = createClaudeCommand(policy, request.prompt,
    structured ? readPlanningSchema(request.inputDirectory, policy.phase === 'review' ? 'Review schema' : 'Planning schema') : undefined);
  assertAdapterRequest(request);
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command, claudeToken: oauthToken }),
    profile => start(profile, { ...options, secrets: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      processLifecycle: request.processLifecycle,
      invocationBudget: remaining, decode: (_profile, raw) => parseClaudeOutput(raw, structured) })));
}

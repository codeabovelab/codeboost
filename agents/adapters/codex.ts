import type { InvocationHandle } from '../contract.ts';
import { createCodexCommand, createPhasePolicy } from '../policy.ts';
import { launchInvocation, readBoundedContainerFile } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
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
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command: createCodexCommand(policy, request.prompt),
      codexAuthFile: authFile, deferredOutput: true }),
    profile => start(profile, { ...options, invocationBudget: remaining,
      decode: (current, _raw, maximum, timeoutMs, decodeSignal) =>
        readCodexOutput(current.name, maximum, timeoutMs, decodeSignal) })));
}

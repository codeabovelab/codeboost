import type { InvocationHandle } from '../contract.ts';
import type { ContainerProfile } from '../container/profile.ts';
import { agentContainerId } from '../container/run.ts';
import { createCodexCommand, createPhasePolicy } from '../policy.ts';
import { launchInvocation, readBoundedContainerFile } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
import { assertAdapterRequest, createAdapterInvocationBudget, type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';

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
  // Invalid input, including any phase Codex is refused (today every phase, #93), throws here, before anything is
  // allocated; only Docker setup runs inside the handle.
  const command = createCodexCommand(policy, request.prompt);
  assertAdapterRequest(request);
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command, codexAuthFile: authFile, deferredOutput: true }),
    profile => start(profile, { ...options, invocationBudget: remaining,
      decode: (current, _raw, maximum, timeoutMs, decodeSignal) =>
        readCodexOutput(codexContainer(current), maximum, timeoutMs, decodeSignal) })));
}

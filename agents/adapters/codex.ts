import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork } from '../network/network.ts';
import { createCodexCommand, createPhasePolicy } from '../policy.ts';
import { readBoundedContainerFile, startProfileInvocation } from './supervisor.ts';
import type { AgentAdapterOptions, AgentAdapterRequest } from './types.ts';

export const CODEX_OUTPUT_FILE = '/tmp/codeboost-output/final.txt';

export function readCodexOutput(container: string, maximumBytes: number) {
  const output = readBoundedContainerFile(container, CODEX_OUTPUT_FILE, maximumBytes);
  return Object.freeze({ text: output.toString('utf8'), additionalBytes: output.length });
}

export function startCodexInvocation(request: AgentAdapterRequest,
  authFile: string, options: AgentAdapterOptions = {}): InvocationHandle {
  if (!authFile || authFile.includes('\0')) throw new Error('Codex auth path is malformed.');
  const policy = createPhasePolicy(request.invocation);
  const network = createVendorNetwork(request.invocation, request.imageId);
  try {
    const profile = createContainerProfile({ ...request, policy, network,
      command: createCodexCommand(policy, request.prompt), codexAuthFile: authFile, deferredOutput: true });
    return startProfileInvocation(profile, { ...options,
      decode: (current, _raw, maximum) => readCodexOutput(current.name, maximum) });
  } catch (error) {
    removeVendorNetwork(network);
    throw error;
  }
}

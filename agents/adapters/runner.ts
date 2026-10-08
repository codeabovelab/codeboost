import type { InvocationHandle } from '../contract.ts';
import { readCapturedFile } from '../container/profile.ts';
import { createPhasePolicy, createRunnerCommand, MAX_COMMAND_SCHEMA_BYTES } from '../policy.ts';
import { launchInvocation } from './supervisor.ts';
import { setUpProfile } from './setup.ts';
import { assertAdapterRequest, capAdapterInvocationBudget, createAdapterInvocationBudget,
  type AgentAdapterOptions, type AgentAdapterRequest } from './types.ts';
import { join } from 'node:path';

/** Run exact approved argv arrays in the read-only review container, without a provider credential or external host. */
export function startRunnerCommandInvocation(request: AgentAdapterRequest,
  options: AgentAdapterOptions = {}): InvocationHandle {
  if (request.invocation.vendor !== 'runner' || request.invocation.phase !== 'review')
    throw new Error('Command checks require a runner-owned review invocation.');
  const policy = createPhasePolicy(request.invocation);
  const remaining = options.invocationBudget
    ? capAdapterInvocationBudget(options.invocationBudget, options.timeoutMs)
    : createAdapterInvocationBudget(request.invocation, options.timeoutMs);
  const raw = readCapturedFile(join(request.inputDirectory, 'schema.json'), 'Runner command input', MAX_COMMAND_SCHEMA_BYTES).content;
  const commands = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const command = createRunnerCommand(policy, commands);
  assertAdapterRequest(request);
  return launchInvocation(request.invocation, remaining, (signal, start) => setUpProfile(request, remaining, signal,
    network => ({ ...request, policy, network, command }),
    profile => start(profile, { ...options, processLifecycle: request.processLifecycle, invocationBudget: remaining,
      diagnosticOutput: true })));
}

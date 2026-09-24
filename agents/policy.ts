import type { InvocationInput, Phase } from './contract.ts';
import { permitsCommand } from './contract.ts';

export type AgentTool = 'read' | 'list' | 'search' | 'write' | 'edit' | 'runner-command';
export interface PhasePolicy {
  readonly phase: Phase;
  readonly worktree: 'read-only' | 'read-write';
  readonly tools: readonly AgentTool[];
  readonly web: false;
  readonly mcp: false;
}
interface PolicyIdentity { readonly invocation: InvocationInput }
const identities = new WeakMap<PhasePolicy, PolicyIdentity>();

export function createPhasePolicy(invocation: InvocationInput): PhasePolicy {
  const writable = invocation.phase === 'execute' || invocation.phase === 'fix';
  const tools: AgentTool[] = ['read', 'list', 'search'];
  if (invocation.phase === 'review' || writable) tools.push('runner-command');
  if (writable) tools.push('write', 'edit');
  const policy = Object.freeze({ phase: invocation.phase, worktree: writable ? 'read-write' : 'read-only',
    tools: Object.freeze(tools), web: false as const, mcp: false as const });
  identities.set(policy, Object.freeze({ invocation }));
  return policy;
}

export function assertPhasePolicy(policy: PhasePolicy, invocation?: InvocationInput): InvocationInput {
  const identity = identities.get(policy);
  if (!identity) throw new Error('Phase policy was not created by the trusted policy builder.');
  if (invocation && identity.invocation !== invocation) throw new Error('Phase policy does not belong to this invocation.');
  return identity.invocation;
}

export function assertAgentTool(policy: PhasePolicy, tool: AgentTool): void {
  assertPhasePolicy(policy);
  if (!policy.tools.includes(tool)) throw new Error(`${tool} is forbidden during ${policy.phase}.`);
}

export function dispatchApprovedCommand<T>(policy: PhasePolicy, argv: readonly string[],
  execute: (argv: readonly string[]) => T): T {
  const invocation = assertPhasePolicy(policy);
  assertAgentTool(policy, 'runner-command');
  if (!permitsCommand(invocation, argv)) throw new Error('Command argv was not approved exactly for this invocation.');
  return execute(Object.freeze([...argv]));
}

export function createClaudeCommand(policy: PhasePolicy, prompt: string): readonly string[] {
  if (!prompt || prompt.includes('\0')) throw new Error('Claude prompt must be nonempty and contain no NUL.');
  assertPhasePolicy(policy);
  const writable = policy.worktree === 'read-write';
  const allowed = writable ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  return Object.freeze(['claude', '--print', prompt, '--output-format', 'json', '--restricted', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome', '--permission-prompts', 'none',
    '--permission-mode', writable ? 'acceptEdits' : 'plan', '--allowedTools', allowed,
    '--disallowedTools', 'Bash,WebFetch,WebSearch,NotebookEdit', '--add-dir', '/run/codeboost-input']);
}

export function codexBaseArguments(policy: PhasePolicy): readonly string[] {
  assertPhasePolicy(policy);
  return Object.freeze(['codex', '--strict-config', '--config', 'web_search="disabled"',
    '--config', 'mcp_servers={}', '--ask-for-approval', 'never']);
}

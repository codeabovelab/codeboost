import { describe, expect, it, vi } from 'vitest';
import { captureInvocation, type InvocationInput, type Phase } from '../agents/contract.ts';
import { assertAgentCommand, assertAgentTool, codexBaseArguments, createClaudeCommand, createCodexCommand,
  createPhasePolicy, dispatchApprovedCommand } from '../agents/policy.ts';

let attempt = 0;
const request = (phase: Phase, vendor: 'claude' | 'codex' = 'claude'): InvocationInput => captureInvocation({
  clone: { id: 'clone-1', taskId: 'task-1', directory: '/tmp/task', head: 'a'.repeat(40) },
  vendor, phase, approvedArgv: ['planning', 'questions'].includes(phase) ? [] : [['npm', 'test']],
  deadline: 2000, attemptId: `attempt-${phase}-${++attempt}`,
  context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
}, 1000);

describe('agent phase policy', () => {
  it('refuses to build a policy from a request that was not captured', () => {
    const forged = { ...request('review'), phase: 'execute' as Phase, approvedArgv: [['sh', '-c', 'anything']] };
    expect(() => createPhasePolicy(forged)).toThrow('captured');
  });
  it.each(['planning', 'questions'] as const)('%s exposes only non-mutating built-in tools', phase => {
    const policy = createPhasePolicy(request(phase));
    expect(policy).toMatchObject({ phase, worktree: 'read-only', tools: ['read', 'list', 'search'], web: false, mcp: false });
    for (const tool of ['write', 'edit', 'runner-command'] as const)
      expect(() => assertAgentTool(policy, tool)).toThrow(`forbidden during ${phase}`);
  });

  it('review dispatches only one exact approved argv without granting a shell tool', () => {
    const captured = request('review'), policy = createPhasePolicy(captured), execute = vi.fn(argv => argv.join(' '));
    expect(policy.tools).toEqual(['read', 'list', 'search', 'runner-command']);
    expect(dispatchApprovedCommand(policy, ['npm', 'test'], execute)).toBe('npm test');
    expect(execute).toHaveBeenCalledWith(['npm', 'test']);
    expect(() => dispatchApprovedCommand(policy, ['npm', 'test', '--changed'], execute)).toThrow('not approved exactly');
    expect(() => dispatchApprovedCommand(policy, ['sh', '-c', 'npm test'], execute)).toThrow('not approved exactly');
    expect(() => assertAgentTool({ ...policy }, 'read')).toThrow('trusted policy builder');
  });

  it.each(['execute', 'fix'] as const)('%s permits edits and exact runner commands', phase => {
    const policy = createPhasePolicy(request(phase));
    expect(policy.worktree).toBe('read-write');
    for (const tool of ['read', 'list', 'search', 'write', 'edit', 'runner-command'] as const)
      expect(() => assertAgentTool(policy, tool)).not.toThrow();
    expect(dispatchApprovedCommand(policy, ['npm', 'test'], argv => argv)).toEqual(['npm', 'test']);
  });

  it('builds Claude and Codex controls with web, MCP and direct shell disabled', () => {
    const readonly = createPhasePolicy(request('planning'));
    const claude = createClaudeCommand(readonly, 'Inspect the schema.').argv;
    expect(claude).toContain('--strict-mcp-config');
    expect(claude).toContain('{"mcpServers":{}}');
    expect(claude).toContain('--tools');
    expect(claude).toContain('Read,Glob,Grep');
    expect(claude).toContain('Bash,WebFetch,WebSearch,NotebookEdit');
    expect(claude).not.toContain('Edit');
    const codexPolicy = createPhasePolicy(request('planning', 'codex'));
    expect(codexBaseArguments(codexPolicy)).toEqual(['codex', '--strict-config', '--config', 'web_search="disabled"',
      '--config', 'mcp_servers={}', '--config', 'features.shell_tool=false', '--ask-for-approval', 'never']);
    const codex = createCodexCommand(codexPolicy, 'Inspect the schema.');
    expect(codex.argv).toContain('features.shell_tool=false');
    expect(() => assertAgentCommand({ argv: codex.argv }, codexPolicy)).toThrow('not generated');
    expect(() => assertAgentCommand(codex, codexPolicy, 'claude')).toThrow('vendor');
    expect(() => createClaudeCommand(codexPolicy, 'Wrong vendor.')).toThrow('Claude invocation');
    expect(() => createCodexCommand(readonly, 'Wrong vendor.')).toThrow('Codex invocation');
  });
});

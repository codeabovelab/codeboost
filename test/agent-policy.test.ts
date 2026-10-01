import { describe, expect, it, vi } from 'vitest';
import { captureInvocation, type InvocationInput, type Phase } from '../agents/contract.ts';
import { assertAgentCommand, assertAgentTool, assertCommandSchema, codexBaseArguments, createClaudeCommand,
  createCodexCommand, createPhasePolicy, dispatchApprovedCommand, MAX_COMMAND_SCHEMA_BYTES } from '../agents/policy.ts';
import planSchema from '../schema/versions/1/plan.schema.json' with { type: 'json' };
import editSchema from '../schema/versions/1/plan-edit.schema.json' with { type: 'json' };
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const SCHEMA = '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}\n';

let attempt = 0;
const request = (phase: Phase, vendor: 'claude' | 'codex' = 'claude'): InvocationInput => captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
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

  it('keeps an option-like prompt after -- so neither CLI parses it as a flag', () => {
    const prompt = '--dangerously-bypass-approvals-and-sandbox';
    const claude = createClaudeCommand(createPhasePolicy(request('planning')), prompt, SCHEMA).argv;
    const codex = createCodexCommand(createPhasePolicy(request('review', 'codex')), prompt).argv;
    for (const argv of [claude, codex]) {
      expect(argv.at(-1)).toBe(prompt);
      expect(argv.at(-2)).toBe('--');
      expect(argv.indexOf(prompt)).toBe(argv.length - 1);
    }
  });

  it('builds Claude and Codex controls with web, MCP and direct shell disabled', () => {
    const readonly = createPhasePolicy(request('planning'));
    const claude = createClaudeCommand(readonly, 'Inspect the schema.', SCHEMA).argv;
    expect(claude).toContain('--strict-mcp-config');
    expect(claude).toContain('{"mcpServers":{}}');
    expect(claude).toContain('--tools');
    expect(claude).toContain('Read,Glob,Grep');
    expect(claude).toContain('Bash,WebFetch,WebSearch,NotebookEdit');
    expect(claude).not.toContain('Edit');
    const codexPolicy = createPhasePolicy(request('review', 'codex'));
    expect(codexBaseArguments(codexPolicy)).toEqual(['codex', '--strict-config', '--config', 'web_search="disabled"',
      '--config', 'mcp_servers={}', '--config', 'features.shell_tool=false', '--ask-for-approval', 'never']);
    const codex = createCodexCommand(codexPolicy, 'Inspect the schema.');
    expect(codex.argv).toContain('features.shell_tool=false');
    expect(() => assertAgentCommand({ argv: codex.argv }, codexPolicy)).toThrow('not generated');
    expect(() => assertAgentCommand(codex, codexPolicy, 'claude')).toThrow('vendor');
    expect(() => createClaudeCommand(codexPolicy, 'Wrong vendor.')).toThrow('Claude invocation');
    expect(() => createCodexCommand(readonly, 'Wrong vendor.')).toThrow('Codex invocation');
  });

  it('passes the planning answer schema to Claude as exact text, and only in planning', () => {
    const argv = createClaudeCommand(createPhasePolicy(request('planning')), 'Plan.', SCHEMA).argv;
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe(SCHEMA);
    expect(argv.indexOf('--json-schema')).toBeLessThan(argv.indexOf('--'));
    expect(() => createClaudeCommand(createPhasePolicy(request('planning')), 'Plan.')).toThrow('must');
    for (const phase of ['questions', 'review', 'execute', 'fix'] as const) {
      const policy = createPhasePolicy(request(phase));
      expect(createClaudeCommand(policy, 'Work.').argv).not.toContain('--json-schema');
      expect(() => createClaudeCommand(createPhasePolicy(request(phase)), 'Work.', SCHEMA)).toThrow('Only the Claude planning');
    }
  });

  it('fits both v1 planning schemas and the 32 KiB prompt into one command', () => {
    const prompt = 'p'.repeat(32 * 1024);
    for (const schema of [planSchema, editSchema]) {
      const text = JSON.stringify(schema, null, 2) + '\n';
      const argv = createClaudeCommand(createPhasePolicy(request('planning')), prompt, text).argv;
      expect(argv).toContain(text);
      // Linux caps each argument at 128 KiB (MAX_ARG_STRLEN); the whole argv limit (ARG_MAX) is far larger.
      for (const argument of argv) expect(Buffer.byteLength(argument)).toBeLessThan(128 * 1024);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_COMMAND_SCHEMA_BYTES);
    }
  });

  it('refuses a planning schema that is not a bounded JSON object', () => {
    const planning = () => createPhasePolicy(request('planning'));
    for (const schema of ['', 'not json', '[]', 'null', '"string"', '{"type":"object"}\0', '{"type":"array"}',
      '{"type":"string"}', '{"properties":{}}'])
      expect(() => createClaudeCommand(planning(), 'Plan.', schema)).toThrow('Planning schema');
    const oversized = `{"description":"${'x'.repeat(MAX_COMMAND_SCHEMA_BYTES)}"}`;
    expect(() => createClaudeCommand(planning(), 'Plan.', oversized)).toThrow('limit');
  });

  it('binds the command schema to the exact mounted schema bytes', () => {
    const command = createClaudeCommand(createPhasePolicy(request('planning')), 'Plan.', SCHEMA);
    expect(() => assertCommandSchema(command, Buffer.from(SCHEMA))).not.toThrow();
    expect(() => assertCommandSchema(command, Buffer.from(SCHEMA.trim()))).toThrow('does not match');
    expect(() => assertCommandSchema(command, Buffer.from('{"type":"object"}\n'))).toThrow('does not match');
    // A command without a schema reads nothing from the mount.
    const review = createClaudeCommand(createPhasePolicy(request('review')), 'Review.');
    expect(() => assertCommandSchema(review, Buffer.from('anything'))).not.toThrow();
  });

  it.each(['planning', 'questions'] as const)('refuses Codex in %s, where it could not read the code', phase => {
    expect(() => createCodexCommand(createPhasePolicy(request(phase, 'codex')), 'Plan.'))
      .toThrow(`Codex cannot run the ${phase} phase`);
  });

  it.each(['review', 'execute', 'fix'] as const)('still builds Codex commands for %s', phase => {
    const argv = createCodexCommand(createPhasePolicy(request(phase, 'codex')), 'Work.').argv;
    expect(argv).not.toContain('--output-schema');
    expect(argv.at(-1)).toBe('Work.');
  });
});

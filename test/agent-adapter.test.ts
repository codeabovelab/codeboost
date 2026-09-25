import { describe, expect, it } from 'vitest';
import { parseClaudeOutput } from '../agents/adapters/claude.ts';
import { CODEX_OUTPUT_FILE } from '../agents/adapters/codex.ts';
import { OUTPUT_LIMITS } from '../agents/adapters/supervisor.ts';
import { captureInvocation } from '../agents/contract.ts';
import { createCodexCommand, createPhasePolicy } from '../agents/policy.ts';

describe('production agent adapters', () => {
  it('parses recorded Claude success and failure envelopes', () => {
    expect(parseClaudeOutput(Buffer.from('{"result":"planned","is_error":false}')))
      .toEqual({ text: 'planned', providerFailed: false });
    expect(parseClaudeOutput(Buffer.from('{"result":"login required","is_error":true}')))
      .toEqual({ text: 'login required', providerFailed: true });
    expect(() => parseClaudeOutput(Buffer.from('{"result":3,"is_error":false}'))).toThrow('malformed');
    expect(() => parseClaudeOutput(Buffer.from('not json'))).toThrow();
    expect(() => parseClaudeOutput(Buffer.from([0xff]))).toThrow();
  });

  it('routes Codex final output to the bounded scratch directory', () => {
    const invocation = captureInvocation({
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor: 'codex', approvedArgv: [], deadline: 2_000, attemptId: 'adapter-command',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    }, 1_000);
    const argv = createCodexCommand(createPhasePolicy(invocation), 'Plan this.').argv;
    expect(argv.slice(argv.indexOf('--output-last-message'), argv.indexOf('--output-last-message') + 2))
      .toEqual(['--output-last-message', CODEX_OUTPUT_FILE]);
  });

  it('publishes immutable production output ceilings', () => {
    expect(OUTPUT_LIMITS).toEqual({ stdoutBytes: 16 * 1024 * 1024, stderrBytes: 4 * 1024 * 1024,
      combinedBytes: 20 * 1024 * 1024 });
    expect(Object.isFrozen(OUTPUT_LIMITS)).toBe(true);
  });
});

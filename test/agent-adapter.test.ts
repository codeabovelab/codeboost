import { describe, expect, it, vi } from 'vitest';
import { parseClaudeOutput, startClaudeInvocation } from '../agents/adapters/claude.ts';
import { CODEX_OUTPUT_FILE, startCodexInvocation } from '../agents/adapters/codex.ts';
import { isInvocationActive, OUTPUT_LIMITS, retainSetupCleanup } from '../agents/adapters/supervisor.ts';
import { createInvocationBudget } from '../agents/adapters/types.ts';
import { captureInvocation } from '../agents/contract.ts';
import { createCodexCommand, createPhasePolicy } from '../agents/policy.ts';

describe('production agent adapters', () => {
  const capturedInvocation = (attemptId: string, deadline: number, vendor: 'codex' | 'claude' = 'codex') =>
    captureInvocation({
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor, approvedArgv: [], deadline, attemptId,
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a',
        referencedCodeHash: 'c', stateVersion: 1 },
    }, deadline - 1);

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

  it.each(['codex', 'claude'] as const)('rejects expired %s setup before allocating a network', vendor => {
    const invocation = capturedInvocation(`expired-${vendor}`, Date.now() - 1, vendor);
    const request = { invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused' };
    const start = () => vendor === 'codex'
      ? startCodexInvocation(request, '/unused/auth.json')
      : startClaudeInvocation(request, 'token');
    expect(start).toThrow('deadline expired during adapter setup');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('retains setup cleanup ownership until a retry succeeds', async () => {
    const invocation = capturedInvocation('setup-recovery', Date.now() + 60_000);
    let attempts = 0;
    const handle = retainSetupCleanup(invocation, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('still busy');
    }, new Error('startup failed'), new Error('cleanup failed'));
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    handle.cancel('cancelled');
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    handle.cancel('cancelled');
    const result = await handle.settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).toContain('setup cleanup remains unsettled');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('does not extend an invocation budget when the wall clock moves backward', () => {
    const wall = Date.now();
    const invocation = capturedInvocation('monotonic-budget', wall + 5_000);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(wall).mockReturnValue(wall - 60_000);
    try {
      const remaining = createInvocationBudget(invocation, 1_000);
      expect(remaining()).toBeGreaterThan(0);
      expect(remaining()).toBeLessThanOrEqual(1_000);
    } finally { clock.mockRestore(); }
  });
});

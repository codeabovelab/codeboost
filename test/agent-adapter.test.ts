import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseClaudeOutput, readPlanningSchema, startClaudeInvocation } from '../agents/adapters/claude.ts';
import { CODEX_OUTPUT_FILE, startCodexInvocation } from '../agents/adapters/codex.ts';
import { isInvocationActive, OUTPUT_LIMITS, retainSetupCleanup } from '../agents/adapters/supervisor.ts';
import { createAdapterInvocationBudget, createInvocationBudget } from '../agents/adapters/types.ts';
import { captureInvocation } from '../agents/contract.ts';
import { createCodexCommand, createPhasePolicy } from '../agents/policy.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';

describe('production agent adapters', () => {
  const capturedInvocation = (attemptId: string, deadline: number, vendor: 'codex' | 'claude' = 'codex') =>
    captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'review', vendor, approvedArgv: [], deadline, attemptId,
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

  it('returns schema-constrained Claude answers from structured_output, not the prose result', () => {
    const success = '{"type":"result","subtype":"success","is_error":false,"result":"Here is the plan.",'
      + '"structured_output":{"title":"Plan","items":[]}}';
    expect(parseClaudeOutput(Buffer.from(success), true))
      .toEqual({ text: '{"title":"Plan","items":[]}', providerFailed: false });
    // Without a schema the prose result is still the answer.
    expect(parseClaudeOutput(Buffer.from(success))).toEqual({ text: 'Here is the plan.', providerFailed: false });
    // A failed structured run can omit result; it is a provider failure, not malformed output.
    expect(parseClaudeOutput(Buffer.from(
      '{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"errors":["x"]}'), true))
      .toEqual({ text: '', providerFailed: true });
    for (const missing of ['{"subtype":"success","result":"{\\"title\\":\\"Plan\\"}","is_error":false}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":null}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":[1]}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":"text"}'])
      expect(() => parseClaudeOutput(Buffer.from(missing), true)).toThrow('no structured output');
    // A schema-constrained answer needs an explicit success subtype; plain text keeps accepting envelopes without one.
    expect(() => parseClaudeOutput(Buffer.from('{"is_error":false,"structured_output":{}}'), true)).toThrow('malformed');
    expect(parseClaudeOutput(Buffer.from('{"is_error":false,"result":"ok"}'))).toEqual({ text: 'ok', providerFailed: false });
    expect(() => parseClaudeOutput(Buffer.from('{"structured_output":{}}'), true)).toThrow('malformed');
  });

  it.each([false, true])('treats any non-success subtype as a provider failure (structured: %s)', structured => {
    for (const envelope of ['{"subtype":"error_max_turns","is_error":false,"structured_output":{"a":1}}',
      '{"subtype":"error_during_execution","is_error":true}',
      '{"subtype":"error_max_structured_output_retries","is_error":false,"result":"gave up"}'])
      expect(parseClaudeOutput(Buffer.from(envelope), structured)).toMatchObject({ providerFailed: true });
    expect(() => parseClaudeOutput(Buffer.from('{"subtype":1,"is_error":false,"result":"x"}'), structured))
      .toThrow('malformed');
    expect(() => parseClaudeOutput(Buffer.from('{"subtype":"success","is_error":false,"result":3}'), structured))
      .toThrow('malformed');
  });

  it('reads the planning schema exactly, refusing links, FIFOs, oversized and invalid UTF-8 files', () => {
    const root = mkdtempSync(join(tmpdir(), 'planning-schema-'));
    try {
      const dir = (name: string, write: (file: string) => void) => {
        const directory = join(root, name); execFileSync('mkdir', [directory]); write(join(directory, 'schema.json'));
        return directory;
      };
      const text = '{"type":"object"}\n';
      // The reader returns the exact text; the command builder validates it.
      expect(readPlanningSchema(dir('valid', file => writeFileSync(file, text)))).toBe(text);
      const target = join(root, 'target.json'); writeFileSync(target, text);
      expect(() => readPlanningSchema(dir('link', file => symlinkSync(target, file)))).toThrow('not a link');
      // A FIFO with no writer would block a plain open forever.
      expect(() => readPlanningSchema(dir('fifo', file => execFileSync('mkfifo', [file])))).toThrow('regular file');
      expect(() => readPlanningSchema(dir('big', file => writeFileSync(file, `{"d":"${'x'.repeat(64 * 1024)}"}`))))
        .toThrow('bounded');
      expect(() => readPlanningSchema(dir('binary', file => writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d])))))
        .toThrow('not valid');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads the planning schema before allocating anything, and only in planning', () => {
    const missing = { filesystems: {} as never, inputDirectory: '/nonexistent-codeboost-input',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() };
    const planning = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: 'claude-schema',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    });
    expect(() => startClaudeInvocation({ ...missing, invocation: planning }, 'token')).toThrow('ENOENT');
    expect(isInvocationActive(planning.attemptId)).toBe(false);
    // An invalid schema is refused by the command builder, also before anything is allocated.
    const root = mkdtempSync(join(tmpdir(), 'planning-invalid-'));
    try {
      writeFileSync(join(root, 'schema.json'), '{"type":"array"}');
      const invalid = captureInvocation({ ...planning, attemptId: 'claude-invalid-schema' });
      expect(() => startClaudeInvocation({ ...missing, inputDirectory: root, invocation: invalid }, 'token'))
        .toThrow('"type": "object"');
      expect(isInvocationActive(invalid.attemptId)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(isInvocationActive(planning.attemptId)).toBe(false);
    // Questions carry no schema, so the same request gets past the schema read to the image check.
    const questions = captureInvocation({ ...planning, phase: 'questions', attemptId: 'claude-no-schema' });
    expect(() => startClaudeInvocation({ ...missing, invocation: questions }, 'token')).toThrow('Agent image');
  });

  it.each(['planning', 'questions'] as const)('refuses a Codex %s invocation synchronously, allocating nothing',
    phase => {
      const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
        clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
        phase, vendor: 'codex', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: `codex-${phase}`,
        context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
      });
      expect(() => startCodexInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
        imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() }, '/unused/auth.json'))
        .toThrow(`Codex cannot run the ${phase} phase`);
      expect(isInvocationActive(invocation.attemptId)).toBe(false);
    });

  it('routes Codex final output to the bounded scratch directory', () => {
    const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'review', vendor: 'codex', approvedArgv: [], deadline: 2_000, attemptId: 'adapter-command',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    }, 1_000);
    const argv = createCodexCommand(createPhasePolicy(invocation), 'Review this.').argv;
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
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() };
    const start = () => vendor === 'codex'
      ? startCodexInvocation(request, '/unused/auth.json')
      : startClaudeInvocation(request, 'token');
    expect(start).toThrow('deadline expired during adapter setup');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('retains every colliding setup cleanup owner until all retries succeed', async () => {
    const invocation = capturedInvocation('setup-recovery', Date.now() + 60_000);
    let releaseFirst = false, releaseSecond = false;
    const first = retainSetupCleanup(invocation, () => {
      if (!releaseFirst) throw new Error('first still busy');
    }, new Error('startup failed'), new Error('cleanup failed'));
    const second = retainSetupCleanup(invocation, () => {
      if (!releaseSecond) throw new Error('second still busy');
    }, new Error('duplicate startup failed'), new Error('duplicate cleanup failed'));
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    releaseFirst = true;
    first.cancel('cancelled');
    await first.settled;
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    releaseSecond = true;
    second.cancel('cancelled');
    const result = await second.settled;
    expect(result.stopReason).toBe('cancelled');
    expect(result.stderr).toContain('[codeboost: cancelled:');
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

  it('applies the configured timeout to the original adapter setup budget', () => {
    const invocation = capturedInvocation('configured-budget', Date.now() + 60_000);
    const remaining = createAdapterInvocationBudget(invocation, 250);
    expect(remaining()).toBeGreaterThan(0);
    expect(remaining()).toBeLessThanOrEqual(250);
    expect(() => createAdapterInvocationBudget(invocation, 10 * 60_000 + 1)).toThrow('ten-minute ceiling');
  });
});

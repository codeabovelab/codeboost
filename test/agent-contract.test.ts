import { describe, expect, it } from 'vitest';
import { captureInvocation, permitsCommand, type InvocationInput } from '../agents/contract.ts';

let attempt = 0;
const request = (): InvocationInput => ({
  clone: { id: 'clone-1', taskId: 'task-1', directory: '/tasks/one', head: 'a'.repeat(40) },
  vendor: 'codex', phase: 'review', approvedArgv: [['npm', 'test']], deadline: 2000, attemptId: `attempt-${++attempt}`,
  context: { snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 1, assignmentId: 'assignment-1',
    referencedCodeHash: 'hash-1', stateVersion: 3 },
});
describe('invocation boundary', () => {
  it('captures identity, context and exact argv independently of mutable caller state', () => {
    const original = request();
    const captured = captureInvocation(original, 1000);
    (original.approvedArgv[0] as string[]).push('--changed');
    (original.context as { stateVersion: number }).stateVersion = 4;
    expect(captured.context.stateVersion).toBe(3);
    expect(captured.approvedArgv).toEqual([['npm', 'test']]);
    expect(Object.isFrozen(captured.clone)).toBe(true);
    expect(Object.isFrozen(captured.context)).toBe(true);
    expect(Object.isFrozen(captured.approvedArgv[0])).toBe(true);
    expect(permitsCommand(captured, ['npm', 'test'])).toBe(true);
    expect(permitsCommand(captured, ['npm', 'test', '--changed'])).toBe(false);
    expect(permitsCommand(captured, ['npm'])).toBe(false);
    expect(permitsCommand(captured, ['sh', '-c', 'npm test'])).toBe(false);
  });
  it.each(['planning', 'questions'] as const)('%s cannot acquire command permission', phase => {
    expect(() => captureInvocation({ ...request(), phase }, 1000)).toThrow('cannot execute');
    const input = captureInvocation({ ...request(), phase, approvedArgv: [] }, 1000);
    expect(permitsCommand(input, ['npm', 'test'])).toBe(false);
  });
  it.each([NaN, Infinity, -1, 999, 1000, 1000.1])('rejects invalid deadline %s', deadline => {
    expect(() => captureInvocation({ ...request(), deadline }, 1000)).toThrow('deadline');
  });
  it.each([[], [''], ['npm', '\0'], 'npm test'])('rejects malformed argv %j', argv => {
    expect(() => captureInvocation({ ...request(), approvedArgv: [argv] } as InvocationInput, 1000)).toThrow('argv');
  });
  it('rejects missing context and unsupported profiles', () => {
    expect(() => captureInvocation({ ...request(), context: { ...request().context, stateVersion: -1 } }, 1000)).toThrow('context');
    expect(() => captureInvocation({ ...request(), phase: 'shell' } as unknown as InvocationInput, 1000)).toThrow('profile');
    expect(() => captureInvocation({ ...request(), attemptId: '' }, 1000)).toThrow('identity');
  });
  it('refuses to re-capture an attempt with an upgraded phase, deadline or allowlist', () => {
    const review = captureInvocation(request(), 1000);
    expect(() => captureInvocation({ ...review, phase: 'execute', deadline: 5000,
      approvedArgv: [['sh', '-c', 'anything']] }, 1000)).toThrow('already captured');
    expect(() => captureInvocation({ ...review }, 1000)).toThrow('already captured');
  });
  it('rejects sparse allowlists with missing arguments or commands', () => {
    const argv = ['npm', 'test']; delete argv[1];
    expect(1 in argv).toBe(false);
    expect(() => captureInvocation({ ...request(), approvedArgv: [argv] }, 1000)).toThrow('argv');
    expect(() => captureInvocation({ ...request(), approvedArgv: new Array(1) }, 1000)).toThrow('argv');
  });
});

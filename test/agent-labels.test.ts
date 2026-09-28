import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ALLOCATION_LABEL, assertResourceOwner, ATTEMPT_LABEL, claimAllocationId, hasOwnerLabels, ownerLabelArgs,
  RUNNER_LABEL } from '../agents/labels.ts';
import { captureInvocation, type InvocationInput } from '../agents/contract.ts';

// Every Docker object D creates is labelled with its runner, attempt and allocation (#51 item 3).
const owner = { runnerOwner: '0123456789abcdef0123456789abcdef', attemptId: 'attempt-1',
  allocationId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' };

describe('ownership labels', () => {
  it('writes the three labels and recognises exactly that owner', () => {
    expect(ownerLabelArgs(owner)).toEqual(['--label', `${RUNNER_LABEL}=${owner.runnerOwner}`,
      '--label', `${ATTEMPT_LABEL}=attempt-1`, '--label', `${ALLOCATION_LABEL}=${owner.allocationId}`]);
    const labels = { [RUNNER_LABEL]: owner.runnerOwner, [ATTEMPT_LABEL]: 'attempt-1', [ALLOCATION_LABEL]: owner.allocationId };
    expect(hasOwnerLabels(labels, owner)).toBe(true);
    expect(hasOwnerLabels({ ...labels, [RUNNER_LABEL]: 'f'.repeat(32) }, owner)).toBe(false);
    expect(hasOwnerLabels({ ...labels, [ATTEMPT_LABEL]: 'attempt-2' }, owner)).toBe(false);
    expect(hasOwnerLabels({ [ATTEMPT_LABEL]: 'attempt-1', [ALLOCATION_LABEL]: owner.allocationId }, owner)).toBe(false);
    expect(hasOwnerLabels(null, owner)).toBe(false);
  });

  it('refuses owners that cannot be written or trusted as labels', () => {
    expect(assertResourceOwner(owner)).toEqual(owner);
    expect(() => assertResourceOwner({ ...owner, runnerOwner: 'ABC' })).toThrow('runnerOwner');
    expect(() => assertResourceOwner({ ...owner, runnerOwner: '0'.repeat(31) })).toThrow('runnerOwner');
    expect(() => assertResourceOwner({ ...owner, attemptId: 'a=b\nc' })).toThrow('attemptId');
    expect(() => assertResourceOwner({ ...owner, allocationId: 'not-a-uuid' })).toThrow('allocationId');
    // Only a caller-chosen UUID v4: another version would not match what the runner records.
    expect(() => assertResourceOwner({ ...owner, allocationId: '3f2b1c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d' })).toThrow('allocationId');
  });

  it('requires a runner owner on every captured invocation', () => {
    const base = (runnerOwner: unknown) => ({
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor: 'codex', approvedArgv: [], deadline: Date.now() + 60_000,
      attemptId: `labels-${Math.random()}`, runnerOwner,
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    }) as unknown as InvocationInput;
    expect(() => captureInvocation(base(undefined))).toThrow('runnerOwner');
    // An attempt ID that cannot be a label is refused at capture, before any setup could run.
    const badAttempt = { ...base(owner.runnerOwner), attemptId: 'attempt one/two' };
    expect(() => captureInvocation(badAttempt)).toThrow('ownership label');
    expect(() => captureInvocation(base('0123456789ABCDEF0123456789ABCDEF'))).toThrow('runnerOwner');
    expect(captureInvocation(base(owner.runnerOwner)).runnerOwner).toBe(owner.runnerOwner);
  });

  it('lets each allocation ID name only one allocation', () => {
    const id = randomUUID();
    expect(claimAllocationId(id)).toBe(id);
    expect(() => claimAllocationId(id)).toThrow('already used');
  });
});

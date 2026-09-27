import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationResult, UnreleasedResource } from '../agents/contract.ts';
import type { ContainerProfile } from '../agents/container/profile.ts';

// Drives startProfileInvocation's own cleanup paths without Docker (#51 item 1): the D modules it calls are replaced
// so cleanup can be made to fail forever, and the container exits as soon as it starts.
const state = vi.hoisted(() => ({
  created: new WeakSet<object>(),
  createFails: false,
  budgets: [] as number[],
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  }),
}));
vi.mock('../agents/policy.ts', () => ({ assertPhasePolicy: (policy: { invocation: unknown }) => policy.invocation }));
vi.mock('../agents/container/profile.ts', () => ({
  assertContainerProfileAuthenticity: () => {},
  isContainerProfileAuthentic: () => true,
  disposeContainerProfile: () => { throw new Error('Cannot connect to the Docker daemon'); },
  containerProfileResources: (profile: { resources: readonly UnreleasedResource[] }) => profile.resources,
}));
vi.mock('../agents/container/run.ts', () => ({
  createValidatedContainer: (profile: object) => {
    if (state.createFails) throw new Error('Conflict. The container name is already in use by another invocation.');
    state.created.add(profile);
  },
  validateContainer: () => {},
  disposeValidatedContainer: (_profile: object, budget: number) => {
    state.budgets.push(budget);
    throw new Error('Cannot connect to the Docker daemon');
  },
  agentContainerId: (profile: object) => state.created.has(profile) ? 'c'.repeat(64) : undefined,
  agentContainerResources: (profile: { name: string }) => state.created.has(profile)
    ? [{ kind: 'container', name: profile.name, id: 'c'.repeat(64),
      owner: { label: 'io.codeboost.invocation', value: 'own' } }] : [],
}));
const { CLEANUP_RETRY_WINDOW_MS, isInvocationActive, startProfileInvocation } = await import('../agents/adapters/supervisor.ts');

describe('startProfileInvocation bounded cleanup', () => {
  const networkAndStaging: readonly UnreleasedResource[] = [
    { kind: 'container', name: 'codeboost-proxy-codex-x', id: 'p'.repeat(64), owner: { label: 'io.codeboost.egress', value: 'a' } },
    { kind: 'network', name: 'codeboost-egress-codex-x', id: 'n'.repeat(64), owner: { label: 'io.codeboost.egress', value: 'a' } },
    { kind: 'directory', name: '/tmp/codeboost-input-x' },
  ];
  const fakeProfile = (attemptId: string) => ({
    name: `codeboost-agent-${attemptId}`, deferredOutput: false, resources: networkAndStaging,
    policy: { invocation: { attemptId, deadline: Date.now() + 10 * 60_000,
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 } } },
  }) as unknown as ContainerProfile;
  const watch = (settled: Promise<InvocationResult>) => {
    const box: { result?: InvocationResult } = {};
    void settled.then(result => { box.result = result; });
    return box;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    state.createFails = false; state.budgets = [];
  });
  afterEach(() => { vi.useRealTimers(); });

  it('settles after the agent exits even when container cleanup never succeeds', async () => {
    const profile = fakeProfile('exit-unreachable');
    const box = watch(startProfileInvocation(profile).settled);
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS - 2_000);
    expect(box.result).toBeUndefined();
    expect(isInvocationActive('exit-unreachable')).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(box.result?.stopReason).toBe('capture-failure');
    expect(box.result?.stderr).toContain('cleanup was not confirmed within 60 s');
    expect(box.result?.unreleased).toEqual([
      { kind: 'container', name: 'codeboost-agent-exit-unreachable', id: 'c'.repeat(64),
        owner: { label: 'io.codeboost.invocation', value: 'own' } },
      ...networkAndStaging]);
    expect(isInvocationActive('exit-unreachable')).toBe(false);
    // Retries after the first run only on what is left of the window.
    expect(state.budgets[0]).toBe(30_000);
    expect(Math.max(...state.budgets.slice(1))).toBeLessThanOrEqual(CLEANUP_RETRY_WINDOW_MS);
    expect(state.budgets.at(-1)).toBeLessThanOrEqual(2_000);
    // The profile stays authentic, but it cannot launch again.
    expect(() => startProfileInvocation(profile)).toThrow('settled without confirmed cleanup');
  });

  it('does not report a container whose create the daemon refused, such as a name held by another invocation', async () => {
    state.createFails = true;
    const box = watch(startProfileInvocation(fakeProfile('name-collision')).settled);
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 2_000);
    expect(box.result?.unreleased).toEqual(networkAndStaging);
  });

  it('keeps D\'s own first stop reason when a cancel arrives during cleanup retries', async () => {
    const box = watch((() => {
      const handle = startProfileInvocation(fakeProfile('exit-cancelled'));
      setTimeout(() => { handle.cancel('shutdown'); handle.cancel('cancelled'); }, 5_000);
      return handle.settled;
    })());
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 2_000);
    expect(box.result?.stopReason).toBe('capture-failure');
    expect(box.result?.unreleased).toBeDefined();
  });
});

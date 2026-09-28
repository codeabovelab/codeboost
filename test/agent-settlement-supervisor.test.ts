import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationResult, UnreleasedResource } from '../agents/contract.ts';
import type { ContainerProfile } from '../agents/container/profile.ts';

// Drives startProfileInvocation's own cleanup paths without Docker (#51 item 1): the D modules it calls are replaced
// so cleanup can be made to fail forever, and the container exits as soon as it starts.
const state = vi.hoisted(() => ({
  created: new WeakSet<object>(),
  retired: new WeakSet<object>(),
  createFails: false,
  createHangs: false,
  createTimesOutAfter: undefined as number | undefined,
  createSignals: [] as AbortSignal[],
  disposeOk: false,
  spawned: 0,
  budgets: [] as number[],
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    state.spawned += 1;
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
  createValidatedContainer: async (profile: object, _timeoutMs: number, _secrets: object, signal: AbortSignal) => {
    state.createSignals.push(signal);
    if (state.createTimesOutAfter !== undefined) {
      await new Promise(resolve => setTimeout(resolve, state.createTimesOutAfter));
      throw Object.assign(new Error('docker create ETIMEDOUT after 4999 ms.'), { code: 'ETIMEDOUT' });
    }
    if (state.createHangs) await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('docker create was cancelled.'))));
    if (state.createFails) throw new Error('Conflict. The container name is already in use by another invocation.');
    state.created.add(profile);
  },
  validateContainer: () => {},
  disposeValidatedContainer: async (_profile: object, budget: number) => {
    state.budgets.push(budget);
    if (!state.disposeOk) throw new Error('Cannot connect to the Docker daemon');
  },
  retireContainerProfile: (profile: object) => { state.retired.add(profile); },
  isContainerProfileRetired: (profile: object) => state.retired.has(profile),
  agentContainerId: (profile: object) => state.created.has(profile) ? 'c'.repeat(64) : undefined,
  agentContainerResources: (profile: { name: string }) => state.created.has(profile)
    ? [{ kind: 'container', name: profile.name, id: 'c'.repeat(64),
      owner: { label: 'io.codeboost.invocation', value: 'own' } }] : [],
}));
const { CLEANUP_RETRY_WINDOW_MS, isInvocationActive, launchInvocation,
  startProfileInvocation } = await import('../agents/adapters/supervisor.ts');

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
    Object.assign(state, { createFails: false, createHangs: false, createTimesOutAfter: undefined, createSignals: [],
      disposeOk: false, spawned: 0,
      budgets: [] });
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

  it('returns before container setup finishes, and a cancel during setup kills it before anything starts', async () => {
    state.createHangs = true; state.disposeOk = true;
    let turned = false;
    const handle = startProfileInvocation(fakeProfile('setup-cancel'));
    setTimeout(() => { turned = true; }, 0);
    await vi.advanceTimersByTimeAsync(0);
    // Setup is still in flight, yet the event loop moved on and the attempt is owned.
    expect(turned).toBe(true);
    expect(isInvocationActive('setup-cancel')).toBe(true);
    expect(state.createSignals[0]?.aborted).toBe(false);
    const box = watch(handle.settled);
    handle.cancel('shutdown');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.createSignals[0]?.aborted).toBe(true);
    expect(box.result?.stopReason).toBe('shutdown');
    expect(box.result).not.toHaveProperty('unreleased');
    expect(state.budgets).toEqual([30_000]); // everything the profile owns was released before settling
    expect(state.spawned).toBe(0);
    expect(isInvocationActive('setup-cancel')).toBe(false);
  });

  it('reports a timeout when the deadline passes during setup', async () => {
    state.createHangs = true; state.disposeOk = true;
    const profile = fakeProfile('setup-deadline');
    const handle = startProfileInvocation(profile, { timeoutMs: 5_000 });
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(state.createSignals[0]?.aborted).toBe(true);
    expect(box.result?.stopReason).toBe('timeout');
    expect(state.spawned).toBe(0);
  });

  it('forwards a cancel made during adapter setup to the supervisor it hands off to', async () => {
    state.disposeOk = true;
    const profile = fakeProfile('handoff-cancel');
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const invocation = (profile.policy as unknown as { invocation: never }).invocation;
    const handle = launchInvocation(invocation, () => 60_000, async (_signal, start) => {
      await ready; // setup finished its Docker work just as the cancel arrived
      return start(profile);
    });
    const box = watch(handle.settled);
    handle.cancel('cancelled');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason).toBe('cancelled');
    expect(state.spawned).toBe(0);
    expect(isInvocationActive('handoff-cancel')).toBe(false);
  });

  it('stops the handed-off supervisor when the launch budget ends, even if it was given a longer one', async () => {
    state.createHangs = true; state.disposeOk = true;
    const profile = fakeProfile('handoff-deadline');
    const invocation = (profile.policy as unknown as { invocation: never }).invocation;
    const handle = launchInvocation(invocation, () => 3_000, async (_signal, start) =>
      start(profile, { timeoutMs: 10 * 60_000 })); // no invocationBudget: the supervisor alone would wait 10 min
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.createSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state.createSignals[0]?.aborted).toBe(true);
    expect(box.result?.stopReason).toBe('timeout');
    expect(isInvocationActive('handoff-deadline')).toBe(false);
  });

  it.each([
    ['timeout', 4_999],
    ['capture-failure', 1_000],
  ] as const)('reports %s for a Docker timeout during setup %i ms into a 5 s budget', async (reason, after) => {
    state.createTimesOutAfter = after; state.disposeOk = true;
    // The create's client is killed by its own budget, just before (or long before) the supervisor's deadline timer.
    const handle = startProfileInvocation(fakeProfile(`setup-etimedout-${after}`), { timeoutMs: 5_000 });
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(after);
    expect(box.result?.stopReason).toBe(reason);
  });
});

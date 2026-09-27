import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEANUP_RETRY_WINDOW_MS, isInvocationActive, retainSetupCleanup } from '../agents/adapters/supervisor.ts';
import { captureInvocation, type InvocationResult } from '../agents/contract.ts';

// Retained cleanup must settle even when Docker never answers (#51 item 1). These run without Docker.
describe('bounded cleanup settlement', () => {
  const resources = Object.freeze([Object.freeze({ kind: 'container' as const, name: 'codeboost-proxy-codex-x' }),
    Object.freeze({ kind: 'network' as const, name: 'codeboost-egress-codex-x' })]);
  const captured = (attemptId: string) => captureInvocation({
    clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
    phase: 'planning', vendor: 'codex', approvedArgv: [], deadline: Date.now() + 60_000, attemptId,
    context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
  });
  const watch = (settled: Promise<InvocationResult>) => {
    const state: { result?: InvocationResult } = {};
    void settled.then(result => { state.result = result; });
    return state;
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('settles with the unreleased resources once cleanup keeps failing for the whole retry window', async () => {
    const invocation = captured('bounded-unreachable');
    let attempts = 0;
    const handle = retainSetupCleanup(invocation, () => {
      attempts += 1;
      throw new Error('Cannot connect to the Docker daemon');
    }, new Error('startup failed'), new Error('cleanup failed'), 'network cleanup', resources);
    const state = watch(handle.settled);

    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS - 1_000);
    expect(state.result).toBeUndefined();
    expect(isInvocationActive(invocation.attemptId)).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.result).toMatchObject({ attemptId: invocation.attemptId, exitCode: null, stopReason: 'capture-failure',
      unreleased: resources });
    expect(state.result!.stderr).toContain('cleanup was not confirmed within 60 s');
    expect(attempts).toBeGreaterThan(1);
    expect(isInvocationActive(invocation.attemptId)).toBe(false);

    // No retry outlives settlement.
    const after = attempts;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(after);
  });

  it('keeps the first stop reason and still ends when cancel retries against an unreachable daemon', async () => {
    const invocation = captured('bounded-cancelled');
    const handle = retainSetupCleanup(invocation, () => { throw new Error('daemon unreachable'); },
      new Error('startup failed'), new Error('cleanup failed'), 'setup cleanup', resources);
    const state = watch(handle.settled);
    handle.cancel('shutdown');
    handle.cancel('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 1_000);
    expect(state.result).toMatchObject({ stopReason: 'shutdown', unreleased: resources });
    expect(state.result!.stderr).toContain('[codeboost: shutdown:');
  });

  it('reports nothing unreleased when a retry succeeds inside the window', async () => {
    const invocation = captured('bounded-recovers');
    let healthy = false;
    const handle = retainSetupCleanup(invocation, () => { if (!healthy) throw new Error('busy'); },
      new Error('startup failed'), new Error('cleanup failed'), 'setup cleanup', resources);
    const state = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(5_000);
    healthy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.result?.stopReason).toBe('capture-failure');
    expect(state.result).not.toHaveProperty('unreleased');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('gives every retry only what is left of the window, and starts none after it ends', async () => {
    const invocation = captured('bounded-budgets');
    const calls: { at: number; budget: number }[] = [];
    const handle = retainSetupCleanup(invocation, budget => {
      calls.push({ at: performance.now(), budget });
      throw new Error('daemon unreachable');
    }, new Error('startup failed'), new Error('cleanup failed'), 'setup cleanup', resources);
    const started = performance.now();
    const state = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 5_000);
    expect(state.result?.unreleased).toEqual(resources);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.budget).toBeGreaterThanOrEqual(1);
      expect(call.at + call.budget).toBeLessThanOrEqual(started + CLEANUP_RETRY_WINDOW_MS);
    }
    expect(calls[0]!.budget).toBe(30_000);
  });

  it('reports only what is still unconfirmed when the window ends', async () => {
    const invocation = captured('bounded-partial');
    let proxyRemoved = false;
    const handle = retainSetupCleanup(invocation, () => {
      proxyRemoved = true; // the proxy goes, the network keeps failing
      throw new Error('network has active endpoints');
    }, new Error('startup failed'), new Error('cleanup failed'), 'network cleanup',
    () => resources.filter(resource => !(proxyRemoved && resource.kind === 'container')));
    const state = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 2_000);
    expect(state.result?.unreleased).toEqual([resources[1]]);
  });
});

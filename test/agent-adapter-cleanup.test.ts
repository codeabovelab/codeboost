import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationResult } from '../agents/contract.ts';

// When profile creation and its cleanup both fail, the adapter keeps retrying that one cleanup inside the bounded
// window. It must not add a second network removal with a fresh deadline on every retry (#51 item 1).
const state = vi.hoisted(() => ({ budgets: [] as { at: number; budget: number }[], networkRemovals: 0 }));
vi.mock('../agents/network/network.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/network/network.ts')>(),
  createVendorNetwork: () => ({ name: 'codeboost-egress-codex-x', proxyContainer: 'codeboost-proxy-codex-x',
    proxyUrl: 'http://10.254.0.2:3128', vendor: 'codex' }),
  removeVendorNetwork: () => { state.networkRemovals += 1; },
}));
// The placeholder image is not built here; image trust is not what this test is about.
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
vi.mock('../agents/container/profile.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/container/profile.ts')>();
  return { ...actual, createContainerProfile: () => {
    throw new actual.ProfileCreationCleanupError(new Error('schema input is not readable'),
      new Error('daemon unreachable'), (budgetMs?: number) => {
        state.budgets.push({ at: performance.now(), budget: budgetMs ?? 30_000 });
        throw new Error('daemon unreachable');
      }, () => [{ kind: 'network', name: 'codeboost-egress-codex-x' }]);
  } };
});
const { startCodexInvocation } = await import('../agents/adapters/codex.ts');
const { CLEANUP_RETRY_WINDOW_MS } = await import('../agents/adapters/supervisor.ts');
const { captureInvocation } = await import('../agents/contract.ts');

describe('adapter profile-creation cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    state.budgets = []; state.networkRemovals = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('retries only the profile cleanup, within the window, and never removes the network separately', async () => {
    const invocation = captureInvocation({
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor: 'codex', approvedArgv: [], deadline: Date.now() + 10 * 60_000,
      attemptId: 'adapter-profile-cleanup',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    });
    const started = performance.now();
    const handle = startCodexInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused' }, '/unused/auth.json');
    const box: { result?: InvocationResult } = {};
    void handle.settled.then(result => { box.result = result; });
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 5_000);
    expect(box.result?.unreleased).toEqual([{ kind: 'network', name: 'codeboost-egress-codex-x' }]);
    expect(state.networkRemovals).toBe(0);
    expect(state.budgets.length).toBeGreaterThan(1);
    for (const call of state.budgets) expect(call.at + call.budget).toBeLessThanOrEqual(started + CLEANUP_RETRY_WINDOW_MS);
  });
});

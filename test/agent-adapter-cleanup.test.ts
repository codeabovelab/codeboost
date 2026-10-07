import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationResult } from '../agents/contract.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';

// When profile creation and its cleanup both fail, the adapter keeps retrying that one cleanup inside the bounded
// window. It must not add a second network removal with a fresh deadline on every retry (#51 item 1).
const state = vi.hoisted(() => ({ budgets: [] as { at: number; budget: number }[], networkRemovals: 0,
  profileFails: true, profileDisposals: 0, advanceWall: false, wallOffset: 0,
  networkBudget: undefined as number | undefined, profileBudget: undefined as number | undefined }));
vi.mock('../agents/network/network.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/network/network.ts')>(),
  createVendorNetwork: (...args: unknown[]) => {
    if (state.advanceWall) state.wallOffset = 60_000;
    state.networkBudget = (args[6] as (() => number) | undefined)?.();
    return { name: 'codeboost-egress-claude-x', proxyContainer: 'codeboost-proxy-claude-x',
      proxyUrl: 'http://10.254.0.2:3128', vendor: 'claude' };
  },
  removeVendorNetwork: () => { state.networkRemovals += 1; },
}));
// The placeholder image is not built here; image trust is not what this test is about.
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
vi.mock('../agents/container/profile.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/container/profile.ts')>();
  return { ...actual, disposeContainerProfile: async () => { state.profileDisposals += 1; },
    createContainerProfile: (options: { invocationBudget?: () => number }) => {
    state.profileBudget = options.invocationBudget?.();
    // Otherwise a profile the supervisor refuses at handoff (not issued by the real builder).
    if (!state.profileFails) return { name: 'codeboost-agent-x', network: {}, policy: {} };
    throw new actual.ProfileCreationCleanupError(new Error('schema input is not readable'),
      new Error('daemon unreachable'), (budgetMs?: number) => {
        state.budgets.push({ at: performance.now(), budget: budgetMs ?? 30_000 });
        throw new Error('daemon unreachable');
      }, () => [{ kind: 'network', name: 'codeboost-egress-claude-x' }]);
  } };
});
const { startClaudeInvocation } = await import('../agents/adapters/claude.ts');
const { CLEANUP_RETRY_WINDOW_MS } = await import('../agents/adapters/supervisor.ts');
const { captureInvocation } = await import('../agents/contract.ts');

describe('adapter profile-creation cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    state.budgets = []; state.networkRemovals = 0; state.profileFails = true; state.profileDisposals = 0;
    state.advanceWall = false; state.wallOffset = 0; state.networkBudget = undefined; state.profileBudget = undefined;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('retries only the profile cleanup, within the window, and never removes the network separately', async () => {
    const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'review', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 10 * 60_000,
      attemptId: 'adapter-profile-cleanup',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    });
    const started = performance.now();
    const handle = startClaudeInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() }, 'token');
    const box: { result?: InvocationResult } = {};
    void handle.settled.then(result => { box.result = result; });
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS + 5_000);
    expect(box.result?.unreleased).toEqual([{ kind: 'network', name: 'codeboost-egress-claude-x' }]);
    expect(state.networkRemovals).toBe(0);
    expect(state.budgets.length).toBeGreaterThan(1);
    for (const call of state.budgets) expect(call.at + call.budget).toBeLessThanOrEqual(started + CLEANUP_RETRY_WINDOW_MS);
  });

  it('releases a created profile when the handoff to the supervisor throws', async () => {
    state.profileFails = false;
    const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'review', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 10 * 60_000,
      attemptId: 'adapter-handoff-throws',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    });
    const handle = startClaudeInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() }, 'token');
    const box: { result?: InvocationResult } = {};
    void handle.settled.then(result => { box.result = result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason).toBe('capture-failure');
    expect(box.result?.stderr).toContain('trusted profile builder');
    expect(state.profileDisposals).toBe(1);
  });

  it('carries a supplied monotonic budget through real adapter setup after wall time moves forward', async () => {
    state.profileFails = false; state.advanceWall = true;
    const wall = Date.now(), clock = vi.spyOn(Date, 'now').mockImplementation(() => wall + state.wallOffset);
    try {
      const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
        clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
        phase: 'review', vendor: 'claude', approvedArgv: [], deadline: wall + 5_000,
        attemptId: 'adapter-monotonic-handoff',
        context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
      });
      const end = performance.now() + 5_000, invocationBudget = () => Math.ceil(end - performance.now());
      const handle = startClaudeInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
        imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() }, 'token',
      { invocationBudget });
      const result = await handle.settled;
      expect(result.stopReason).toBe('capture-failure'); // The intentionally fake profile reaches the real handoff.
      expect(state.networkBudget).toBeGreaterThan(0);
      expect(state.profileBudget).toBeGreaterThan(0);
      expect(state.profileDisposals).toBe(1);
    } finally { clock.mockRestore(); }
  });
});

describe('adapter start input', () => {
  it('refuses a network allocation ID that is not a lowercase UUID v4 synchronously', async () => {
    const { startClaudeInvocation } = await import('../agents/adapters/claude.ts');
    const { isInvocationActive } = await import('../agents/adapters/supervisor.ts');
    for (const networkAllocationId of [randomUUID().toUpperCase(), '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '']) {
      const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
        clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
        phase: 'review', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 10 * 60_000, attemptId: randomUUID(),
        context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
      });
      expect(() => startClaudeInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
        imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId }, 'token')).toThrow('lowercase UUID v4');
      expect(isInvocationActive(invocation.attemptId)).toBe(false);
    }
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterSetupCleanupError, CLEANUP_RETRY_WINDOW_MS, isInvocationActive,
  launchInvocation } from '../agents/adapters/supervisor.ts';
import { captureInvocation, type InvocationHandle, type InvocationResult } from '../agents/contract.ts';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';

// The start call returns its handle at once and runs setup inside it (#51 item 2). These run without Docker.
describe('asynchronous launch', () => {
  const captured = (attemptId: string, vendor: 'codex' | 'claude' = 'codex') => captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
    clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
    phase: 'review', vendor, approvedArgv: [], deadline: Date.now() + 10 * 60_000, attemptId,
    context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
  });
  const budget = () => 5 * 60_000;
  const watch = (settled: Promise<InvocationResult>) => {
    const box: { result?: InvocationResult } = {};
    void settled.then(result => { box.result = result; });
    return box;
  };
  /** A promise the test resolves or rejects by hand. */
  const gate = <T = void>() => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the handle before setup finishes and owns the attempt while setup runs', async () => {
    const setup = gate<InvocationHandle>();
    const handle = launchInvocation(captured('launch-owns'), budget, () => setup.promise);
    expect(handle.attemptId).toBe('launch-owns');
    expect(isInvocationActive('launch-owns')).toBe(true);
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result).toBeUndefined();
    setup.reject(new Error('network create refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result).toMatchObject({ stopReason: 'capture-failure', exitCode: null });
    expect(box.result!.stderr).toContain('network create refused');
    expect(isInvocationActive('launch-owns')).toBe(false);
  });

  it('refuses a second launch for an attempt that is still setting up, allocating nothing', () => {
    const invocation = captured('launch-duplicate');
    launchInvocation(invocation, budget, () => gate<InvocationHandle>().promise);
    const second = vi.fn(() => gate<InvocationHandle>().promise);
    expect(() => launchInvocation(invocation, budget, second)).toThrow('still active');
    expect(second).not.toHaveBeenCalled();
  });

  it('aborts setup on cancel and settles only after setup has cleaned up', async () => {
    const cleaned = gate();
    let aborted = false;
    const handle = launchInvocation(captured('launch-cancel'), budget, async signal => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }));
      await cleaned.promise; // setup removes what it created before it rejects
      throw new Error('docker network was cancelled.');
    });
    const box = watch(handle.settled);
    handle.cancel('shutdown');
    handle.cancel('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    expect(box.result).toBeUndefined();
    expect(isInvocationActive('launch-cancel')).toBe(true);
    cleaned.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason).toBe('shutdown');
    expect(isInvocationActive('launch-cancel')).toBe(false);
  });

  it('aborts setup at the invocation deadline and reports a timeout', async () => {
    const handle = launchInvocation(captured('launch-deadline'), () => 3_000, signal =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('killed')))));
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(box.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(box.result?.stopReason).toBe('timeout');
  });

  it('keeps retrying setup cleanup that failed, then reports what it could not remove', async () => {
    const resources = [{ kind: 'network' as const, name: 'codeboost-egress-codex-x', id: 'n'.repeat(64),
      labels: { 'io.codeboost.egress': 'a' } }];
    let retries = 0;
    const handle = launchInvocation(captured('launch-cleanup'), budget, async () => {
      throw new AdapterSetupCleanupError(new Error('profile refused'), new Error('daemon unreachable'),
        async () => { retries += 1; throw new Error('daemon unreachable'); }, resources);
    });
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(box.result).toBeUndefined();
    expect(isInvocationActive('launch-cleanup')).toBe(true);
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_WINDOW_MS);
    expect(retries).toBeGreaterThan(1);
    expect(box.result?.stopReason).toBe('capture-failure');
    expect(box.result?.unreleased).toEqual(resources);
    expect(box.result?.stderr).toContain('profile refused');
    expect(isInvocationActive('launch-cleanup')).toBe(false);
  });

  it.each([
    ['timeout', 2_999],
    ['capture-failure', 100],
  ] as const)('reports %s when setup fails from a Docker timeout %i ms into a 3 s budget', async (reason, after) => {
    const end = performance.now() + 3_000;
    const handle = launchInvocation(captured(`launch-etimedout-${after}`), () => Math.ceil(end - performance.now()),
      async () => {
        await new Promise(resolve => setTimeout(resolve, after));
        throw Object.assign(new Error('docker network ETIMEDOUT after 60000 ms.'), { code: 'ETIMEDOUT' });
      });
    const box = watch(handle.settled);
    await vi.advanceTimersByTimeAsync(after);
    expect(box.result?.stopReason).toBe(reason);
  });

  it('refuses an untrusted image synchronously, allocating nothing', () => {
    const invocation = captured('untrusted-image-claude', 'claude');
    const request = { invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() };
    expect(() => startClaudeInvocation(request, 'token')).toThrow('trusted validated builder');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });
});

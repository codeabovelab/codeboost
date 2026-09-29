import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationResult } from '../agents/contract.ts';
import type { ContainerProfile } from '../agents/container/profile.ts';

// Replays, without Docker, the interleavings of the deferred-output acknowledgement with the container's exit. The
// wrapper (probe.sh) exits as soon as it sees the acknowledgement, and that exit can kill the acknowledging
// `docker exec` before it reports success; CI run 36470233043 failed that way.
type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
const state = vi.hoisted(() => ({
  attach: undefined as FakeChild | undefined,
  acknowledgements: [] as { child: FakeChild; args: readonly string[] }[],
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn((_command: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    if (args[0] === 'start') state.attach = child;
    else if (args[0] === 'exec') state.acknowledgements.push({ child, args });
    else process.nextTick(() => child.emit('close', 0, null));
    return child;
  }),
}));
vi.mock('../agents/policy.ts', () => ({ assertPhasePolicy: (policy: { invocation: unknown }) => policy.invocation }));
vi.mock('../agents/container/profile.ts', () => ({
  assertContainerProfileAuthenticity: () => {},
  isContainerProfileAuthentic: () => true,
  disposeContainerProfile: async () => {},
  containerProfileResources: () => [],
}));
vi.mock('../agents/container/run.ts', () => ({
  createValidatedContainer: async () => {},
  validateContainer: async () => {},
  disposeValidatedContainer: async () => {},
  retireContainerProfile: () => {},
  isContainerProfileRetired: () => false,
  agentContainerId: () => 'c'.repeat(64),
  agentContainerResources: () => [],
}));
const { startProfileInvocation } = await import('../agents/adapters/supervisor.ts');

const token = '11111111-2222-3333-4444-555555555555';
const fakeProfile = (attemptId: string) => ({
  name: `codeboost-agent-${attemptId}`, deferredOutput: true, resources: [],
  policy: { invocation: { attemptId, deadline: Date.now() + 10 * 60_000,
    context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 } } },
}) as unknown as ContainerProfile;

describe('deferred output acknowledgement', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    state.attach = undefined;
    state.acknowledgements = [];
  });
  afterEach(() => { vi.useRealTimers(); });

  /** Start an invocation whose agent writes newline-free stderr, then READY with `status`. */
  const readyInvocation = async (attemptId: string, status = 0, timeoutMs?: number) => {
    const box: { result?: InvocationResult } = {};
    void startProfileInvocation(fakeProfile(attemptId), { timeoutMs, decode: () => ({ text: 'captured' }) })
      .settled.then(result => { box.result = result; });
    await vi.advanceTimersByTimeAsync(0);
    const stderr = state.attach!.stderr;
    stderr.emit('data', Buffer.from(`\x1eCODEBOOST_START:${token}\x1e\n`));
    stderr.emit('data', Buffer.from('trailing-diagnostic'));
    stderr.emit('data', Buffer.from(`\n\x1eCODEBOOST_READY:${token}:${status}\x1e\n`));
    await vi.advanceTimersByTimeAsync(0);
    // The decoded output was collected, so the supervisor acknowledges it with the READY token.
    expect(state.acknowledgements).toHaveLength(1);
    expect(state.acknowledgements[0]!.args.at(-1)).toBe(token);
    return box;
  };
  const acknowledgementExits = (index: number, code: number | null, signal: NodeJS.Signals | null = null) =>
    state.acknowledgements[index]!.child.emit('close', code, signal);
  const containerExits = (code: number | null, signal: NodeJS.Signals | null = null) =>
    state.attach!.emit('close', code, signal);

  it.each([
    ['before the container exit is observed', 'acknowledgement-first'],
    ['after the container exit is observed', 'exit-first'],
  ] as const)('keeps the result when the wrapper takes the acknowledgement and its exec then fails %s',
    async (_label, order) => {
      const box = await readyInvocation(`ack-killed-${order}`);
      // The wrapper saw the acknowledgement and exited with the READY status; the teardown killed the exec.
      if (order === 'acknowledgement-first') { acknowledgementExits(0, 137); containerExits(0); }
      else { containerExits(0); acknowledgementExits(0, 137); }
      await vi.advanceTimersByTimeAsync(0);
      expect(box.result?.stopReason, box.result?.stderr).toBeUndefined();
      expect(box.result?.exitCode).toBe(0);
      expect(box.result?.stdout).toBe('captured');
      expect(box.result?.stderr).toBe('trailing-diagnostic\n');
      // Nothing retries once the container has exited.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.acknowledgements).toHaveLength(1);
    });

  it('retries an acknowledgement that failed while the container keeps waiting for it', async () => {
    const box = await readyInvocation('ack-retried');
    acknowledgementExits(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(state.acknowledgements).toHaveLength(2);
    expect(state.acknowledgements[1]!.args.at(-1)).toBe(token);
    acknowledgementExits(1, 0);
    containerExits(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason, box.result?.stderr).toBeUndefined();
    expect(box.result?.stderr).toBe('trailing-diagnostic\n');
  });

  it('reports the READY status of an agent that failed', async () => {
    const box = await readyInvocation('ack-nonzero', 3);
    acknowledgementExits(0, 0);
    containerExits(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason, box.result?.stderr).toBeUndefined();
    expect(box.result?.exitCode).toBe(3);
  });

  it.each([
    ['an exit status other than READY', 137, null],
    ['a signal', null, 'SIGKILL'],
  ] as const)('fails closed when the container exits with %s instead of taking the acknowledgement',
    async (_label, code, signal) => {
      const box = await readyInvocation(`ack-bypassed-${signal ?? code}`);
      acknowledgementExits(0, 137);
      containerExits(code, signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(box.result?.stopReason).toBe('capture-failure');
      expect(box.result?.stderr).toContain('trailing-diagnostic\n');
      expect(box.result?.stderr).toContain('Container exited without taking the deferred output acknowledgement.');
    });

  it('times out instead of succeeding when no acknowledgement ever takes effect', async () => {
    const box = await readyInvocation('ack-never', 0, 5_000);
    for (let index = 0; index < 4; index += 1) {
      acknowledgementExits(index, 1);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(state.acknowledgements).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(box.result).toBeUndefined();
    // The deadline stopped the container, which exits by signal and ends the last attempt without a retry.
    acknowledgementExits(4, 137);
    containerExits(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);
    expect(box.result?.stopReason).toBe('timeout');
    expect(box.result?.stderr).toContain('trailing-diagnostic\n');
    expect(box.result?.stderr).toContain('Deferred output acknowledgement failed 4 times.');
  });
});

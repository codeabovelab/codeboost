import { describe, expect, it } from 'vitest';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';
import { NOT_STARTED } from '../agents/docker.ts';
import { createOutcomeUnknown } from '../agents/client-outcome.ts';

// Preparation subprocesses run in their own process group, and settle only once the whole group has exited (#51 item 5).
const env = { PATH: process.env.PATH };
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

describe('runInProcessGroup', () => {
  it('reports the group in the same turn as the spawn, and returns a normal exit', async () => {
    let reported: ProcessGroup | undefined;
    const pending = runInProcessGroup('sh', ['-c', 'echo out; echo err >&2; exit 3'],
      { env, timeoutMs: 5_000, onProcessGroup: group => { reported = group; } });
    // Synchronously, before anything else can run: the caller can record it before a crash could lose it.
    expect(reported?.pgid).toBeGreaterThan(1);
    expect(Math.abs(reported!.startedAt - Date.now())).toBeLessThan(5_000);
    expect(await pending).toMatchObject({ status: 3, stdout: 'out\n', stderr: 'err\n' });
    expect(groupAlive(reported!.pgid)).toBe(false);
  });

  it('kills what the leader left in its group before settling, even after a normal exit', async () => {
    let group: ProcessGroup | undefined;
    const began = performance.now();
    const outcome = await runInProcessGroup('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo started'],
      { env, timeoutMs: 30_000, onProcessGroup: reported => { group = reported; } });
    expect(outcome).toMatchObject({ status: 0, stdout: 'started\n' });
    expect(groupAlive(group!.pgid)).toBe(false);
    expect(performance.now() - began).toBeLessThan(10_000);
  });

  it('bounds a group that ignores SIGTERM: SIGKILL after the grace period, then settles as a timeout', async () => {
    let group: ProcessGroup | undefined;
    const began = performance.now();
    const outcome = await runInProcessGroup('sh', ['-c', "trap '' TERM; sleep 60 & while :; do sleep 1; done"],
      { env, timeoutMs: 200, graceMs: 400, onProcessGroup: reported => { group = reported; } });
    const elapsed = performance.now() - began;
    expect(outcome.status).toBeNull();
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    expect(createOutcomeUnknown({ status: outcome.status, cause: outcome.error })).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(groupAlive(group!.pgid)).toBe(false);
  });

  it('stops the group on abort and reports it as cancelled', async () => {
    const controller = new AbortController();
    let group: ProcessGroup | undefined;
    setTimeout(() => controller.abort(), 100);
    const outcome = await runInProcessGroup('sleep', ['60'],
      { env, timeoutMs: 30_000, signal: controller.signal, onProcessGroup: reported => { group = reported; } });
    expect(outcome.status).toBeNull();
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ABORT_ERR');
    expect(groupAlive(group!.pgid)).toBe(false);
  });

  it('stops a group whose output exceeds the limit', async () => {
    const outcome = await runInProcessGroup('sh', ['-c', 'while :; do echo xxxxxxxxxxxxxxxx; done'],
      { env, timeoutMs: 30_000, maxBuffer: 1024 });
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ENOBUFS');
    expect(outcome.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('starts nothing for an aborted signal, an invalid deadline, or a missing program', async () => {
    let reported = false;
    const onProcessGroup = () => { reported = true; };
    for (const outcome of [
      await runInProcessGroup('sleep', ['1'], { env, timeoutMs: 5_000, signal: AbortSignal.abort(), onProcessGroup }),
      await runInProcessGroup('sleep', ['1'], { env, timeoutMs: 0, onProcessGroup }),
    ]) {
      expect((outcome.error as NodeJS.ErrnoException).code).toBe(NOT_STARTED);
      expect(createOutcomeUnknown({ status: outcome.status, cause: outcome.error })).toBe(false);
    }
    const missing = await runInProcessGroup('codeboost-no-such-program', [], { env, timeoutMs: 5_000, onProcessGroup });
    expect((missing.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(reported).toBe(false);
  });
});

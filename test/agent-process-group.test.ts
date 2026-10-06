import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('writes the input to the leader\'s stdin and closes it, and leaves stdin unconnected without one', async () => {
    const input = Buffer.concat([Buffer.from('line\n\0'), Buffer.alloc(256 * 1024, 'x')]);
    const read = await runInProcessGroup('sh', ['-c', 'wc -c'], { env, timeoutMs: 10_000, input });
    expect(read).toMatchObject({ status: 0 });
    expect(Number(read.stdout.trim())).toBe(input.length);
    expect(await runInProcessGroup('sh', ['-c', 'wc -c'], { env, timeoutMs: 10_000 })).toMatchObject({ status: 0, stdout: expect.stringMatching(/^\s*0\n$/) });
    // A leader that never reads its input: the broken pipe is not an error, and the outcome is its own.
    const ignored = await runInProcessGroup('sh', ['-c', 'exec 0<&-; exit 4'], { env, timeoutMs: 10_000, input: Buffer.alloc(1024 * 1024) });
    expect(ignored).toMatchObject({ status: 4 });
    expect(ignored.error).toBeUndefined();
  });

  it('settles an abort while the input is still being written, with no error from the unread input', async () => {
    const controller = new AbortController();
    let group: ProcessGroup | undefined;
    setTimeout(() => controller.abort(), 200);
    // More than a pipe holds, to a leader that never reads it: the write is still pending at the abort.
    const outcome = await runInProcessGroup('sleep', ['60'], { env, timeoutMs: 30_000, signal: controller.signal,
      input: Buffer.alloc(4 * 1024 * 1024), onProcessGroup: reported => { group = reported; } });
    expect(outcome.status).toBeNull();
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ABORT_ERR');
    expect(groupAlive(group!.pgid)).toBe(false);
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

  it('kills the group and still waits for it when the caller cannot record it', async () => {
    let group: ProcessGroup | undefined;
    const outcome = await runInProcessGroup('sh', ['-c', "trap '' TERM; sleep 60 & while :; do sleep 1; done"],
      { env, timeoutMs: 30_000, onProcessGroup: reported => { group = reported; throw new Error('database is locked'); } });
    expect(outcome.status).toBeNull();
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('EUNRECORDED');
    expect(((outcome.error as Error).cause as Error).message).toBe('database is locked');
    expect(groupAlive(group!.pgid)).toBe(false);
  });

  it('stops at once when the signal is aborted during onProcessGroup', async () => {
    const controller = new AbortController();
    let group: ProcessGroup | undefined;
    const began = performance.now();
    const outcome = await runInProcessGroup('sleep', ['60'], { env, timeoutMs: 30_000, signal: controller.signal,
      onProcessGroup: reported => { group = reported; controller.abort(); } });
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ABORT_ERR');
    expect(performance.now() - began).toBeLessThan(10_000);
    expect(groupAlive(group!.pgid)).toBe(false);
  });

  it('settles when a process that left the group still holds its output pipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'escaped-')), pidFile = join(dir, 'pid');
    // The leader starts `sleep` in a new session (outside the group) that inherits stdout, then exits.
    const escape = `const c = require('node:child_process').spawn('sleep', ['60'], { detached: true, `
      + `stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, `
      + `String(c.pid)); c.unref(); console.log('leader done');`;
    try {
      const began = performance.now();
      const outcome = await runInProcessGroup(process.execPath, ['-e', escape], { env, timeoutMs: 30_000 });
      // The output may be incomplete, so it is not reported as a success; what was read is kept.
      expect(outcome).toMatchObject({ status: null, stdout: 'leader done\n' });
      expect((outcome.error as NodeJS.ErrnoException).code).toBe('ESTDIOHELD');
      expect(performance.now() - began).toBeLessThan(10_000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('counts time spent recording the group against the deadline', async () => {
    const began = performance.now();
    const outcome = await runInProcessGroup('sleep', ['60'], { env, timeoutMs: 1_000, graceMs: 100,
      // A slow durable write: the deadline must already be running while it blocks.
      onProcessGroup: () => { const until = performance.now() + 1_000; while (performance.now() < until); } });
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    expect(performance.now() - began).toBeLessThan(1_700);
  });

  it('stops a group whose output exceeds the limit', async () => {
    const outcome = await runInProcessGroup('sh', ['-c', 'while :; do echo xxxxxxxxxxxxxxxx; done'],
      { env, timeoutMs: 30_000, maxBuffer: 1024 });
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ENOBUFS');
    expect(outcome.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('can retain a bounded prefix without stopping when callers classify from exit status or durable state', async () => {
    const outcome = await runInProcessGroup(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"],
      { env, timeoutMs: 5_000, maxBuffer: 1024, discardExcessOutput: true });
    expect(outcome.status).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(outcome.stdout).toBe('x'.repeat(1024));
  });

  it('resolves, never rejects, when spawn itself throws', async () => {
    let reported = false;
    // A NUL byte in an argument makes spawn throw synchronously, as ENOMEM or E2BIG from the spawn itself would.
    const outcome = await runInProcessGroup('sh', ['-c', 'echo a\0b'], { env, timeoutMs: 5_000,
      onProcessGroup: () => { reported = true; } });
    expect(outcome.status).toBeNull();
    expect(outcome.error).toBeInstanceOf(Error);
    expect(reported).toBe(false);
  });

  it('starts nothing for an aborted signal, an invalid deadline, or a missing program', async () => {
    let reported = false;
    const onProcessGroup = () => { reported = true; };
    for (const outcome of [
      await runInProcessGroup('sleep', ['1'], { env, timeoutMs: 5_000, signal: AbortSignal.abort(), onProcessGroup }),
      await runInProcessGroup('sleep', ['1'], { env, timeoutMs: 0, onProcessGroup }),
      // Longer than a Node timer can wait: accepting it would time the call out after 1 ms.
      await runInProcessGroup('sleep', ['1'], { env, timeoutMs: 2 ** 31, onProcessGroup }),
    ]) {
      expect((outcome.error as NodeJS.ErrnoException).code).toBe(NOT_STARTED);
      expect(createOutcomeUnknown({ status: outcome.status, cause: outcome.error })).toBe(false);
    }
    const missing = await runInProcessGroup('codeboost-no-such-program', [], { env, timeoutMs: 5_000, onProcessGroup });
    expect((missing.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(reported).toBe(false);
  });
});

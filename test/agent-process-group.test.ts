import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';
import { NOT_STARTED } from '../agents/docker.ts';
import { createOutcomeUnknown } from '../agents/client-outcome.ts';
import { runTrackedProcess, type ProcessGroupOwner } from '../agents/tracked-docker.ts';
import { createAttachExitGuard, signalAttachedChild, startOwnedAttachClient, watchAttachedChild } from '../agents/adapters/supervisor.ts';

// Preparation subprocesses run in their own process group, and settle only once the whole group has exited (#51 item 5).
const env = { PATH: process.env.PATH };
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

describe('runInProcessGroup', () => {
  it('does not let a delayed attach kill signal a numeric PGID after leader exit', async () => {
    vi.useFakeTimers();
    const guard = createAttachExitGuard(), childKill = vi.fn(), groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = Object.assign(new EventEmitter(), { pid: 999_999, kill: childKill }) as unknown as ChildProcess;
    try {
      setTimeout(() => signalAttachedChild(guard, child, 'SIGKILL'), 1_000);
      guard.markExited();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(groupKill).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
    } finally { groupKill.mockRestore(); vi.useRealTimers(); }
  });

  it('honours synchronous cancellation from attach lifecycle hooks before and after spawn', () => {
    let stopped = false, spawned = 0, attached = 0, terminated = 0;
    const child = Object.assign(new EventEmitter(), { pid: 999_999, kill: () => true }) as unknown as ChildProcess;
    const lifecycle = {
      starting: () => {},
      started: () => { stopped = true; },
      settled: () => {},
      unsettled: () => {},
    };
    startOwnedAttachClient({ lifecycle, stopped: () => stopped,
      spawn: () => { spawned++; return child; }, attach: (_child, owner, group) => {
        attached++; expect(owner).toEqual(group); expect(group?.pgid).toBe(999_999);
      }, terminate: () => { terminated++; }, recordFailure: error => { throw error; } });
    expect({ spawned, attached, terminated }).toEqual({ spawned: 1, attached: 1, terminated: 1 });

    stopped = true;
    expect(() => startOwnedAttachClient({ lifecycle: { ...lifecycle, starting: () => {} }, stopped: () => stopped,
      spawn: () => { spawned++; return child; }, attach: () => {}, terminate: () => {},
      recordFailure: error => { throw error; } })).toThrow(/before the Docker attach client started/);
    expect(spawned).toBe(1);
  });

  it('finishes a spawned attach client on error even when no exit event follows', () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    let finishes = 0, failures = 0;
    const events: string[] = [];
    watchAttachedChild(child, (code, signal) => { finishes++; events.push('finish'); expect(code).toBeNull(); expect(signal).toBeNull(); },
      error => { failures++; events.push('failure'); expect(error.message).toBe('kill failed'); });
    child.emit('error', new Error('kill failed'));
    expect({ finishes, failures }).toEqual({ finishes: 1, failures: 1 });
    expect(events).toEqual(['finish', 'failure']);
  });

  it('never signals an attach PGID after exit while inherited pipes remain open', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const guard = createAttachExitGuard(), pipeClosed = Promise.withResolvers<void>();
    let signals = 0;
    watchAttachedChild(child, () => {
      guard.markExited();
      void pipeClosed.promise.then(() => undefined);
    }, error => { throw error; });
    child.emit('exit', 0, null);
    // The group is now empty but an escaped descendant still owns a pipe. A deadline firing here must not use the
    // reusable numeric PGID; finish may continue waiting for bounded pipe closure without enabling termination.
    if (guard.canSignal()) signals++;
    expect(signals).toBe(0);
    pipeClosed.resolve();
    await pipeClosed.promise;
    expect(guard.canSignal()).toBe(false);
  });

  it('composes durable lifecycle ownership with the caller process-group observer', async () => {
    let owner: ProcessGroupOwner | null = null;
    const events: string[] = [];
    const outcome = await runTrackedProcess('sh', ['-c', 'exit 0'], { env, timeoutMs: 5_000,
      lifecycle: {
        starting: () => { expect(owner).toBeNull(); owner = 'spawning'; events.push('starting'); },
        started: group => { expect(owner).toBe('spawning'); owner = group; events.push('started'); },
        settled: expected => { expect(owner).toEqual(expected); owner = null; events.push('settled'); },
        unsettled: () => { throw new Error('unexpected unsettled process'); },
      },
      onProcessGroup: group => { expect(owner).toEqual(group); events.push('observer'); },
    });
    expect(outcome.status).toBe(0);
    expect(events).toEqual(['starting', 'started', 'observer', 'settled']);
    expect(owner).toBeNull();
  });

  it('does not spawn after the durable starting write exhausts the original deadline', async () => {
    let spawned = false, settled: ProcessGroupOwner | undefined;
    const outcome = await runTrackedProcess('sh', ['-c', 'exit 0'], { env, timeoutMs: 10,
      lifecycle: {
        starting: () => { const until = performance.now() + 20; while (performance.now() < until); },
        started: () => { throw new Error('a process must not start after its deadline'); },
        settled: owner => { settled = owner; },
        unsettled: () => { throw new Error('an unstarted process cannot remain unsettled'); },
      },
      onProcessGroup: () => { spawned = true; },
    });
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    expect(spawned).toBe(false);
    expect(settled).toBe('spawning');
  });

  it('preserves a pre-spawn timeout when recording its settlement also fails', async () => {
    const outcome = await runTrackedProcess('sh', ['-c', 'exit 0'], { env, timeoutMs: 10,
      lifecycle: {
        starting: () => { const until = performance.now() + 20; while (performance.now() < until); },
        started: () => { throw new Error('must not start'); },
        settled: () => { throw new Error('settlement write failed'); },
        unsettled: () => { throw new Error('must not become unsettled'); },
      },
    });
    expect(outcome).toMatchObject({ status: null, error: { code: 'ETIMEDOUT' } });
    expect(((outcome.error as Error).cause as AggregateError).errors).toMatchObject([
      { message: expect.stringContaining('ETIMEDOUT'), code: 'ETIMEDOUT' }, { message: 'settlement write failed' },
    ]);
  });

  it('reports the group in the same turn as the spawn, and returns a normal exit', async () => {
    let reported: ProcessGroup | undefined;
    const pending = runInProcessGroup('sh', ['-c', 'echo out; echo err >&2; exit 3'],
      { env, timeoutMs: 5_000, onProcessGroup: group => { reported = group; } });
    // Synchronously, before anything else can run: the caller can record it before a crash could lose it.
    expect(reported?.pgid).toBeGreaterThan(1);
    expect(Math.abs(reported!.startedAt - Date.now())).toBeLessThan(5_000);
    if (process.platform === 'linux') expect(reported!.identity).toMatch(/^linux:[0-9a-f-]{36}:\d+$/);
    else expect(reported!.identity).toBeNull();
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

  it('retains ownership without signalling a numeric group after its leader exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphaned-group-')), pidFile = join(dir, 'pid');
    const began = performance.now();
    const script = `const {spawn}=require('node:child_process'),fs=require('node:fs');`
      + `const c=spawn('sleep',['60'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
    try {
      const outcome = await runInProcessGroup(process.execPath, ['-e', script], {
        env, timeoutMs: 30_000, allowUnsettledReturn: true,
      });
      expect(outcome.status).toBeNull();
      expect((outcome.error as NodeJS.ErrnoException).code).toBe('EGROUPALIVE');
      expect(performance.now() - began).toBeGreaterThanOrEqual(10_000);
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).not.toThrow();
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not release an untracked caller while a descendant remains in the group', async () => {
    const script = `const {spawn}=require('node:child_process');spawn('sleep',['0.2'],{stdio:'ignore'}).unref();`;
    const began = performance.now();
    const outcome = await runInProcessGroup(process.execPath, ['-e', script], { env, timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ status: 0 });
    expect(outcome.error).toBeUndefined();
    expect(performance.now() - began).toBeGreaterThanOrEqual(150);
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
      const outcome = await runInProcessGroup(process.execPath, ['-e', escape], {
        env, timeoutMs: 30_000, allowUnsettledReturn: true,
      });
      // The output may be incomplete, so it is not reported as a success; what was read is kept.
      expect(outcome).toMatchObject({ status: null, stdout: 'leader done\n' });
      expect((outcome.error as NodeJS.ErrnoException).code).toBe('ESTDIOHELD');
      expect(performance.now() - began).toBeLessThan(10_000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not release an untracked caller while a process outside the group holds its output pipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'escaped-untracked-')), pidFile = join(dir, 'pid');
    const escape = `const c = require('node:child_process').spawn('sleep', ['60'], { detached: true, `
      + `stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, `
      + `String(c.pid)); c.unref(); console.log('leader done');`;
    let settled = false;
    try {
      const pending = runInProcessGroup(process.execPath, ['-e', escape], { env, timeoutMs: 30_000 });
      void pending.then(() => { settled = true; });
      const until = performance.now() + 5_000;
      while (!readFileSync(pidFile, { encoding: 'utf8', flag: 'a+' }).trim()) {
        if (performance.now() >= until) throw new Error('escaped pipe holder did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect(settled).toBe(false);
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      const outcome = await pending;
      expect(outcome).toMatchObject({ status: 0, stdout: 'leader done\n' });
      expect(outcome.error).toBeUndefined();
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

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

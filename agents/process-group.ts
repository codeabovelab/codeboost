import { spawn } from 'node:child_process';
import { NOT_STARTED, type DockerOutcome } from './docker.ts';

/** A subprocess's process group, reported as soon as it exists so the caller can record it durably. */
export interface ProcessGroup {
  /** The group ID, which is the leader's PID. */
  readonly pgid: number;
  /** `Date.now()` right after the spawn; with the ID, it tells this group from a later one that reuses the ID. */
  readonly startedAt: number;
}
export interface ProcessGroupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly cwd?: string;
  /** Aborting stops the group (SIGTERM, then SIGKILL after the grace period); the call still settles only after exit. */
  readonly signal?: AbortSignal;
  /** Called synchronously, in the same turn as the spawn, with the new group. */
  readonly onProcessGroup?: (group: ProcessGroup) => void;
  /** How long a stopped group gets between SIGTERM and SIGKILL. Default 5 s. */
  readonly graceMs?: number;
  /** Bytes kept of each of stdout and stderr; more stops the group. Default 16 MiB. */
  readonly maxBuffer?: number;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
// After the leader exits, how long to keep killing and polling other members of its group before giving up.
const DRAIN_LIMIT_MS = 10_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const notStarted = (message: string): DockerOutcome =>
  ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error(message), { code: NOT_STARTED }) });

// Signal every process in the group; false once the group no longer exists.
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

// The leader can exit while other members of its group still run (for example a child it forked). A group ID stays
// taken while any member exists, so until the group is empty the ID cannot name someone else's group.
const drainGroup = async (pgid: number) => {
  const giveUpAt = performance.now() + DRAIN_LIMIT_MS;
  while (signalGroup(pgid, 0)) {
    signalGroup(pgid, 'SIGKILL');
    if (performance.now() >= giveUpAt) return false;
    await pause(20);
  }
  return true;
};

/**
 * Run one command as the leader of a new process group. The group is reported through `onProcessGroup` before this
 * returns control to the event loop. On abort or at the deadline the whole group gets SIGTERM, then SIGKILL after the
 * grace period, so a child that ignores SIGTERM is still bounded. The promise settles only after the leader has
 * exited and every other member of its group is gone. Never rejects: failures are in the outcome, shaped like
 * `runDocker`'s, so `status` is a number only when the command ran to completion.
 */
export function runInProcessGroup(file: string, args: readonly string[],
  options: ProcessGroupOptions): Promise<DockerOutcome> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    return Promise.resolve(notStarted('Process deadline must be a positive integer.'));
  if (options.signal?.aborted) return Promise.resolve(notStarted(`${file} was cancelled before it started.`));
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS, maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise(resolve => {
    // `detached` makes the child the leader of a new process group (setsid), so signals to -pgid reach all it starts.
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    if (pgid === undefined) {
      // The spawn itself failed (for example ENOENT); nothing started, and 'error' carries the cause.
      child.once('error', error => resolve({ status: null, stdout: '', stderr: '', error }));
      return;
    }
    options.onProcessGroup?.(Object.freeze({ pgid, startedAt: Date.now() }));
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, stopped: 'cancelled' | 'timeout' | 'output-limit' | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped) return;
      stopped = reason;
      signalGroup(pgid, 'SIGTERM');
      graceTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs);
    };
    const collect = (chunks: Buffer[], add: (bytes: number) => number) => (chunk: Buffer) => {
      if (add(chunk.length) > maxBuffer) stop('output-limit');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(out, bytes => (outBytes += bytes)));
    child.stderr.on('data', collect(err, bytes => (errBytes += bytes)));
    const deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      void drainGroup(pgid).then(drained => {
        clearTimeout(graceTimer);
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        if (!drained) {
          resolve({ status: null, stdout, stderr, error: Object.assign(
            new Error(`${file} left processes in its group that did not exit after SIGKILL.`), { code: 'EGROUPALIVE' }) });
          return;
        }
        if (stopped === 'cancelled') {
          resolve({ status: null, stdout, stderr, error: Object.assign(new Error(`${file} ${args[0] ?? ''} was cancelled.`),
            { name: 'AbortError', code: 'ABORT_ERR' }) });
          return;
        }
        if (stopped) {
          resolve({ status: null, stdout, stderr, error: Object.assign(new Error(stopped === 'timeout'
            ? `${file} ${args[0] ?? ''} ETIMEDOUT after ${options.timeoutMs} ms.`
            : `${file} ${args[0] ?? ''} exceeded its output limit.`), { code: stopped === 'timeout' ? 'ETIMEDOUT' : 'ENOBUFS' }) });
          return;
        }
        if (spawnError || code === null) {
          resolve({ status: null, stdout, stderr,
            error: spawnError ?? Object.assign(new Error(`${file} ${args[0] ?? ''} was killed by ${signal}.`), { signal }) });
          return;
        }
        resolve({ status: code, stdout, stderr });
      });
    });
  });
}

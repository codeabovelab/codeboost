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
// Once the group is gone, how long to wait for stdout and stderr to reach end of file. Only a process outside the group
// (one that called setsid but kept the inherited pipe) can hold them open after that, and it must not hold this call.
const STDIO_CLOSE_MS = 1_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const notStarted = (message: string): DockerOutcome =>
  ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error(message), { code: NOT_STARTED }) });

// Signal every process in the group; false once the group no longer exists. Never throws: it runs in timers and
// listeners, where a throw would crash the runner. Any failure other than ESRCH (such as EPERM, for a member that can
// no longer be signalled) counts as still alive, so draining gives up at its limit and reports it.
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
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
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, stopped: 'cancelled' | 'timeout' | 'output-limit' | 'unrecorded' | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped) return;
      stopped = reason;
      signalGroup(pgid, 'SIGTERM');
      graceTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs);
    };
    // Armed at the spawn, before the caller records the group: time spent recording counts against the deadline.
    const deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
    // If the caller cannot record the group, the child must not outlive this call: it is killed at once below, and
    // the call still settles only after the group has exited, with the caller's error.
    let unrecorded: unknown;
    try { options.onProcessGroup?.(Object.freeze({ pgid, startedAt: Date.now() })); }
    catch (error) { unrecorded = error; }
    const collect = (chunks: Buffer[], add: (bytes: number) => number) => (chunk: Buffer) => {
      if (add(chunk.length) > maxBuffer) stop('output-limit');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(out, bytes => (outBytes += bytes)));
    child.stderr.on('data', collect(err, bytes => (errBytes += bytes)));
    const onAbort = () => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (unrecorded !== undefined) { stopped = 'unrecorded'; signalGroup(pgid, 'SIGKILL'); }
    // An abort raised during onProcessGroup came before the listener existed, and an aborted signal never fires again.
    else if (options.signal?.aborted) stop('cancelled');
    let spawnError: Error | undefined;
    const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
    // Settle from the leader's exit, not from 'close': 'close' also waits for every holder of the pipes, which can
    // include a process that left the group and so survives the group kill.
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      void drainGroup(pgid).then(async drained => {
        // The group is empty (or given up on): a later SIGKILL could reach a new group that reuses the ID.
        clearTimeout(graceTimer);
        let stdioTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([closed, new Promise<void>(done => { stdioTimer = setTimeout(done, STDIO_CLOSE_MS); })]);
        // Cleared so a finished call never keeps the process alive.
        clearTimeout(stdioTimer);
        child.stdout.destroy();
        child.stderr.destroy();
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        if (!drained) {
          resolve({ status: null, stdout, stderr, error: Object.assign(
            new Error(`${file} left processes in its group that did not exit after SIGKILL.`), { code: 'EGROUPALIVE' }) });
          return;
        }
        if (stopped === 'unrecorded') {
          resolve({ status: null, stdout, stderr, error: Object.assign(new Error(
            `${file} was stopped because its process group could not be recorded.`, { cause: unrecorded }),
            { code: 'EUNRECORDED' }) });
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
    };
    child.once('exit', finish);
    // A spawn that fails after the child had a PID emits 'error' and may never emit 'exit'.
    child.once('error', error => { spawnError = error; finish(null, null); });
  });
}

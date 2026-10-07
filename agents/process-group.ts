import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { NOT_STARTED, type DockerOutcome } from './docker.ts';

/** A subprocess's process group, reported as soon as it exists so the caller can record it durably. */
export interface ProcessGroup {
  /** The group ID, which is the leader's PID. */
  readonly pgid: number;
  /** `Date.now()` right after the spawn, retained for lifecycle timing and diagnostics. */
  readonly startedAt: number;
  /** Linux boot ID plus kernel start ticks. Null means crash recovery must not signal this group automatically. */
  readonly identity: string | null;
}

/** A kernel-backed identity that changes across both PID reuse and host reboot. */
export function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'ascii').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'ascii'), close = stat.lastIndexOf(')');
    const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/ +/);
    const ticks = fields[19]; // field 22 overall; fields starts with field 3 (`state`).
    if (!/^[0-9a-f-]{36}$/.test(boot) || !ticks || !/^\d+$/.test(ticks)) return null;
    return `linux:${boot}:${ticks}`;
  } catch { return null; }
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
  /** Keep only the bounded prefix instead of stopping on excess output. Use only when exit status/state decides meaning. */
  readonly discardExcessOutput?: boolean;
  /**
   * Written to the leader's stdin, which is then closed; without it stdin is not connected. A leader that exits before
   * reading it all is not an error: what it did is in its status and output.
   */
  readonly input?: Buffer;
}

const DEFAULT_GRACE_MS = 5_000;
/** The longest delay a Node timer honours; `setTimeout` treats anything longer as 1 ms. */
export const MAXIMUM_TIMER_MS = 2 ** 31 - 1;
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
const processExists = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

/** Whether a post-exit signal still targets the recorded group rather than a leader that reused its numeric ID. */
export const canSignalDrainingGroup = (leaderExists: boolean, recorded: string | null,
  current: string | null): boolean => !leaderExists || (recorded !== null && current === recorded);

// The leader can exit while other members of its group still run (for example a child it forked). A group ID stays
// taken while any member exists, so until the group is empty the ID cannot name someone else's group.
const drainGroup = async (group: ProcessGroup) => {
  const { pgid, identity } = group;
  const giveUpAt = performance.now() + DRAIN_LIMIT_MS;
  while (signalGroup(pgid, 0)) {
    // A live group with no positive PID equal to its PGID is the original orphaned group: a new group needs that
    // numeric leader. If such a leader exists, only the exact recorded kernel identity proves it was not reused.
    const leaderExists = processExists(pgid), current = leaderExists ? processIdentity(pgid) : null;
    if (!canSignalDrainingGroup(leaderExists, identity, current)) return false;
    signalGroup(pgid, 'SIGKILL');
    if (performance.now() >= giveUpAt) return false;
    await pause(20);
  }
  return true;
};

/** Kill and await every member of a process group already recorded by the caller. */
export const drainProcessGroup = (group: ProcessGroup): Promise<boolean> => drainGroup(group);

/**
 * Run one command as the leader of a new process group. The group is reported through `onProcessGroup` before this
 * returns control to the event loop. On abort or at the deadline the whole group gets SIGTERM, then SIGKILL after the
 * grace period, so a child that ignores SIGTERM is still bounded. The promise settles only after the leader has
 * exited and every other member of its group is gone. Never rejects: failures are in the outcome, shaped like
 * `runDocker`'s, so `status` is a number only when the command ran to completion.
 */
export function runInProcessGroup(file: string, args: readonly string[],
  options: ProcessGroupOptions): Promise<DockerOutcome> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAXIMUM_TIMER_MS)
    return Promise.resolve(notStarted(`Process deadline must be a positive integer of at most ${MAXIMUM_TIMER_MS} ms.`));
  if (options.signal?.aborted) return Promise.resolve(notStarted(`${file} was cancelled before it started.`));
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS, maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise(resolve => {
    // `detached` makes the child the leader of a new process group (setsid), so signals to -pgid reach all it starts.
    // spawn throws, rather than emitting 'error', for invalid arguments and for spawn failures other than ENOENT,
    // EACCES, EAGAIN, EMFILE and ENFILE (for example ENOMEM or E2BIG). No child exists then; report it, never reject.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true,
        stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: error as Error });
      return;
    }
    const pgid = child.pid;
    if (pgid === undefined) {
      // The spawn itself failed (for example ENOENT); nothing started, and 'error' carries the cause.
      child.once('error', error => resolve({ status: null, stdout: '', stderr: '', error }));
      return;
    }
    if (options.input) {
      // EPIPE when the leader exits without reading everything; the leader's exit decides the outcome.
      child.stdin!.on('error', () => {});
      child.stdin!.end(options.input);
    }
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, stopped: 'cancelled' | 'timeout' | 'output-limit' | 'unrecorded' | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // Set once the leader has exited: from then on the group is drained, not stopped, and its ID may be reused.
    let exited = false;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped || exited) return;
      stopped = reason;
      signalGroup(pgid, 'SIGTERM');
      graceTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs);
    };
    // Armed at the spawn, before the caller records the group: time spent recording counts against the deadline.
    const deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
    // If the caller cannot record the group, the child must not outlive this call: it is killed at once below, and
    // the call still settles only after the group has exited, with the caller's error.
    const group = Object.freeze({ pgid, startedAt: Date.now(), identity: processIdentity(pgid) });
    let unrecorded: unknown;
    try { options.onProcessGroup?.(group); }
    catch (error) { unrecorded = error; }
    // Normally output past the limit stops the group and settles as ENOBUFS. A caller that classifies from durable state
    // may explicitly keep a bounded prefix and let the process finish instead.
    let truncated = false;
    const collect = (chunks: Buffer[], used: () => number, add: (bytes: number) => number) => (chunk: Buffer) => {
      const room = Math.max(0, maxBuffer - used());
      if (room > 0) chunks.push(chunk.subarray(0, room));
      if (add(chunk.length) > maxBuffer) { truncated = true; if (!options.discardExcessOutput) stop('output-limit'); }
    };
    child.stdout!.on('data', collect(out, () => outBytes, bytes => (outBytes += bytes)));
    child.stderr!.on('data', collect(err, () => errBytes, bytes => (errBytes += bytes)));
    const onAbort = () => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (unrecorded !== undefined) { stopped = 'unrecorded'; signalGroup(pgid, 'SIGKILL'); }
    // An abort raised during onProcessGroup came before the listener existed, and an aborted signal never fires again.
    else if (options.signal?.aborted) stop('cancelled');
    let spawnError: Error | undefined;
    let pipesClosed = false;
    const closed = new Promise<void>(resolveClosed => child.once('close', () => { pipesClosed = true; resolveClosed(); }));
    // Settle from the leader's exit, not from 'close': 'close' also waits for every holder of the pipes, which can
    // include a process that left the group and so survives the group kill.
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      exited = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      void drainGroup(group).then(async drained => {
        // The group is empty (or given up on): a later SIGKILL could reach a new group that reuses the ID.
        clearTimeout(graceTimer);
        let stdioTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([closed, new Promise<void>(done => { stdioTimer = setTimeout(done, STDIO_CLOSE_MS); })]);
        // Cleared so a finished call never keeps the process alive.
        clearTimeout(stdioTimer);
        // Timers run before I/O in each event-loop turn: after a long block the timer can win while the rest of the
        // output is already waiting. One more turn lets that I/O (and the end of the pipes) be read first.
        if (!pipesClosed) await new Promise(resolveTurn => setImmediate(resolveTurn));
        child.stdin?.destroy();
        child.stdout!.destroy();
        child.stderr!.destroy();
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        if (!drained) {
          resolve({ status: null, stdout, stderr, error: Object.assign(
            new Error(`${file} left processes in its group that did not exit after SIGKILL.`), { code: 'EGROUPALIVE' }) });
          return;
        }
        if (!pipesClosed) {
          // Only a process outside the group can still hold the pipes; the output may be incomplete, so this is not a
          // successful result even if the leader exited 0.
          resolve({ status: null, stdout, stderr, error: Object.assign(new Error(
            `${file} exited, but a process outside its group still holds its output; the output may be incomplete.`),
            { code: 'ESTDIOHELD' }) });
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
        if (truncated && !stopped && !options.discardExcessOutput) {
          resolve({ status: null, stdout, stderr, error: Object.assign(
            new Error(`${file} ${args[0] ?? ''} exceeded its output limit.`), { code: 'ENOBUFS' }) });
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

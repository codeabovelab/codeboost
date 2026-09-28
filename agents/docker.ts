import { execFile } from 'node:child_process';

/** The only variables a Docker CLI call inherits; credentials are added per call. */
export const dockerEnvironment = (secrets: Readonly<Record<string, string>> = {}) => ({
  PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...secrets,
});

export interface DockerOptions {
  readonly timeoutMs: number;
  /** Aborting kills the client with SIGKILL; the call still settles only after the process has exited. */
  readonly signal?: AbortSignal;
  readonly secrets?: Readonly<Record<string, string>>;
}
export interface DockerOutcome {
  /** Exit code when the client ran to completion; `null` when it was killed or could not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the client was killed (deadline or abort) or could not start: the daemon's outcome is unknown. */
  readonly error?: Error;
}

const MAX_BUFFER = 16 * 1024 * 1024;
/** Error code for a call refused before any client process started (already cancelled, or an invalid deadline). */
export const NOT_STARTED = 'ENOTSTARTED';

/** Run one Docker CLI call without blocking the event loop. Never rejects. */
export function runDocker(args: readonly string[], options: DockerOptions): Promise<DockerOutcome> {
  // Refused before any client starts: nothing reached the daemon, which `NOT_STARTED` tells callers.
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: Object.assign(
      new Error('Docker deadline must be a positive integer.'), { code: NOT_STARTED }) });
  if (options.signal?.aborted)
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: Object.assign(
      new Error(`docker ${args[0] ?? ''} was cancelled before it started.`), { code: NOT_STARTED }) });
  return new Promise(resolve => {
    execFile('docker', [...args], {
      encoding: 'utf8', timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
      env: dockerEnvironment(options.secrets), signal: options.signal,
    }, (error, stdout, stderr) => {
      const out = String(stdout ?? ''), err = String(stderr ?? '');
      if (!error) { resolve({ status: 0, stdout: out, stderr: err }); return; }
      const exitCode = (error as { code?: unknown }).code;
      // Only Node's own abort error means this client was killed by the signal. A numeric exit code is the daemon's
      // answer even if the signal was aborted after the process exited but before this callback ran.
      const aborted = error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR';
      const killed = aborted || (error as { killed?: boolean }).killed === true;
      // A numeric code means the client ran and the daemon answered; anything else leaves the outcome unknown.
      if (typeof exitCode === 'number' && !killed) { resolve({ status: exitCode, stdout: out, stderr: err }); return; }
      const reason = aborted ? new Error(`docker ${args[0] ?? ''} was cancelled.`, { cause: error })
        : killed ? Object.assign(new Error(`docker ${args[0] ?? ''} ETIMEDOUT after ${options.timeoutMs} ms.`,
          { cause: error }), { code: 'ETIMEDOUT' })
        : error;
      resolve({ status: null, stdout: out, stderr: err, error: reason });
    });
  });
}

/** A failed Docker call. `status` is a number only when the daemon answered, as with `execFileSync`. */
export class DockerError extends Error {
  readonly status: number | null;
  readonly stderr: string;
  constructor(args: readonly string[], outcome: DockerOutcome) {
    super(`docker ${args[0] ?? ''} failed${outcome.status === null ? ' (client killed or not started)' : ` (exit ${outcome.status})`}: `
      + `${(outcome.error?.message ?? outcome.stderr).trim().slice(0, 512)}`, { cause: outcome.error });
    this.status = outcome.status;
    this.stderr = outcome.stderr;
  }
}

/** Run a Docker call that must succeed; resolves with trimmed stdout. */
export async function docker(args: readonly string[], options: DockerOptions): Promise<string> {
  const outcome = await runDocker(args, options);
  if (outcome.status !== 0) throw new DockerError(args, outcome);
  return outcome.stdout.trim();
}

/** Wait without blocking; resolves early (without error) when `signal` aborts. */
export const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

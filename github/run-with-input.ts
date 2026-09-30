import { spawn } from 'node:child_process';

/**
 * A command that exited with a failure. The message carries stderr and the start of stdout, where `gh api` prints the
 * response body with GitHub's reason; both are also kept whole, for callers that recognise a refusal.
 */
export class CommandFailed extends Error {
  readonly stderr: string; readonly stdout: string;
  constructor(message: string, stderr: string, stdout: string) { super(message); this.stderr = stderr; this.stdout = stdout; }
}

/**
 * Runs a command with literal argv and writes `input` to its stdin, so large text never travels as an OS argument
 * (Linux limits one argument to 128 KiB, and a NUL cannot be passed at all). Settles only after the process closed:
 * a timeout, an abort or an output past `maxBuffer` sends SIGTERM, then SIGKILL after `killGraceMs` if the process is
 * still running, and the promise rejects once it has exited. If a process it started keeps the output pipes open after
 * it exits, the pipes are closed after `pipeGraceMs` so the promise still settles.
 */
export function runWithInput(command: string, args: readonly string[], options: {
  input?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; killGraceMs?: number; pipeGraceMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('Aborted.')); return; }
    const child = spawn(command, [...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, failure: Error | null = null;
    let escalation: NodeJS.Timeout | null = null;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 5_000);
    };
    const timer = options.timeout ? setTimeout(() => stop(new Error(`${command} timed out.`)), options.timeout) : null;
    const onAbort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Aborted.'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (options.maxBuffer !== undefined && size > options.maxBuffer) stop(new Error(`${command} output exceeded its limit.`));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdin.on('error', () => { /* the exit status reports a process that stopped reading */ });
    child.stdin.end(options.input ?? '');
    child.on('error', error => stop(error));
    let settled = false, pipes: NodeJS.Timeout | null = null;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (pipes) clearTimeout(pipes);
      options.signal?.removeEventListener('abort', onAbort);
      const stderr = Buffer.concat(err).toString('utf8').trim();
      // `gh api` prints only the error's summary on stderr and the response body, with GitHub's reason, on stdout.
      const stdout = code !== 0 ? Buffer.concat(out).toString('utf8').trim() : '';
      if (failure) reject(failure);
      else if (code !== 0) reject(new CommandFailed(`${command} failed (${signal ?? `exit ${code}`}): ${stderr.slice(0, 2000)}${stdout ? `\n${stdout.slice(0, 2000)}` : ''}`, stderr, stdout));
      else resolve(Buffer.concat(out).toString('utf8'));
    };
    child.on('close', finish);
    // 'close' also waits for the pipes; a grandchild that inherited them can hold them open after this process exits.
    child.on('exit', (code, signal) => {
      pipes = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, options.pipeGraceMs ?? 1_000);
    });
  });
}

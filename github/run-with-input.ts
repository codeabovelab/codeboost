import { spawn } from 'node:child_process';

/**
 * Runs a command with literal argv and writes `input` to its stdin, so large text never travels as an OS argument
 * (Linux limits one argument to 128 KiB, and a NUL cannot be passed at all). Settles only after the process closed:
 * a timeout, an abort or an output past `maxBuffer` kills it, and the promise rejects once it has exited.
 */
export function runWithInput(command: string, args: readonly string[], options: {
  input?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('Aborted.')); return; }
    const child = spawn(command, [...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, failure: Error | null = null;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGTERM'); };
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
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${signal ?? `exit ${code}`}): ${stderr.slice(0, 2000)}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

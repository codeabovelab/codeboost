import { DockerError, dockerEnvironment, NOT_STARTED, type DockerOutcome } from './docker.ts';
import { MAXIMUM_TIMER_MS, runInProcessGroup, type ProcessGroup, type ProcessGroupOptions } from './process-group.ts';

export type ProcessGroupOwner = ProcessGroup | 'spawning';
export interface ProcessGroupLifecycle {
  /** Persist the spawning state before the Docker client can exist. */
  readonly starting: () => void;
  /** Replace spawning with the exact group synchronously after spawn. */
  readonly started: (group: ProcessGroup) => void;
  /** Clear this exact owner only after the client and all group members settled. */
  readonly settled: (owner: ProcessGroupOwner) => void;
  /** Preserve durable ownership when the group or its output did not settle. */
  readonly unsettled: (owner: ProcessGroupOwner, reason: 'group-alive' | 'stdio-held') => void;
}

/** Run one subprocess under durable ownership; lifecycle write failures become an unsuccessful settled outcome. */
export async function runTrackedProcess(file: string, args: readonly string[],
  options: ProcessGroupOptions & { readonly lifecycle: ProcessGroupLifecycle }): Promise<DockerOutcome> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAXIMUM_TIMER_MS)
    return { status: null, stdout: '', stderr: '', error: Object.assign(
      new Error(`Process deadline must be a positive integer of at most ${MAXIMUM_TIMER_MS} ms.`), { code: NOT_STARTED }) };
  if (options.signal?.aborted)
    return { status: null, stdout: '', stderr: '', error: Object.assign(
      new Error(`${file} was cancelled before it started.`), { code: NOT_STARTED }) };
  // Arm the monotonic deadline before the synchronous durable write. A timer cannot run while that hook blocks.
  const deadline = performance.now() + options.timeoutMs;
  let owner: ProcessGroupOwner = 'spawning';
  try { options.lifecycle.starting(); }
  catch (error) {
    return { status: null, stdout: '', stderr: '', error: Object.assign(
      new Error(`${file} process ownership could not be recorded before spawn.`, { cause: error }), { code: NOT_STARTED }) };
  }
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) {
    const timeout = Object.assign(new Error(`${file} ${args[0] ?? ''} ETIMEDOUT before spawn.`), { code: 'ETIMEDOUT' });
    try { options.lifecycle.settled('spawning'); }
    catch (error) {
      return { status: null, stdout: '', stderr: '', error: new Error(
        `${file} process ownership settlement could not be recorded.`, { cause: new AggregateError([timeout, error]) }) };
    }
    return { status: null, stdout: '', stderr: '', error: timeout };
  }
  const outcome = await runInProcessGroup(file, args, { ...options, timeoutMs: remaining,
    onProcessGroup: group => {
      options.lifecycle.started(group);
      owner = group;
      options.onProcessGroup?.(group);
    } });
  const code = (outcome.error as { code?: unknown } | undefined)?.code;
  try {
    if (code === 'EGROUPALIVE') options.lifecycle.unsettled(owner, 'group-alive');
    else if (code === 'ESTDIOHELD') options.lifecycle.unsettled(owner, 'stdio-held');
    else options.lifecycle.settled(owner);
  } catch (error) {
    const settlement = new Error(`${file} process ownership settlement could not be recorded.`, { cause: error });
    if (code === 'EGROUPALIVE' || code === 'ESTDIOHELD') Object.assign(settlement, { code });
    return { status: null, stdout: outcome.stdout, stderr: outcome.stderr,
      error: settlement };
  }
  return outcome;
}

/** Run a resource-creating Docker command under durable process-group ownership. */
export async function runTrackedDocker(args: readonly string[], options: {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly lifecycle: ProcessGroupLifecycle;
}): Promise<string> {
  const outcome = await runTrackedProcess('docker', args, {
    env: dockerEnvironment(options.secrets), timeoutMs: options.timeoutMs, signal: options.signal,
    lifecycle: options.lifecycle,
  });
  if (outcome.status !== 0) throw new DockerError(args, outcome);
  return outcome.stdout.trim();
}

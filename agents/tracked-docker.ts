import { DockerError, dockerEnvironment, NOT_STARTED, type DockerOutcome } from './docker.ts';
import { runInProcessGroup, type ProcessGroup, type ProcessGroupOptions } from './process-group.ts';

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
  let owner: ProcessGroupOwner = 'spawning';
  try { options.lifecycle.starting(); }
  catch (error) {
    return { status: null, stdout: '', stderr: '', error: Object.assign(
      new Error(`${file} process ownership could not be recorded before spawn.`, { cause: error }), { code: NOT_STARTED }) };
  }
  const outcome = await runInProcessGroup(file, args, { ...options,
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

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason,
  UnreleasedResource } from '../contract.ts';
import { assertPhasePolicy } from '../policy.ts';
import { agentContainerId, agentContainerResources, createValidatedContainer, disposeValidatedContainer,
  isContainerProfileRetired, retireContainerProfile, validateContainer } from '../container/run.ts';
import { assertContainerProfileAuthenticity, containerProfileResources, disposeContainerProfile,
  isContainerProfileAuthentic, type ContainerProfile } from '../container/profile.ts';
import { drainProcessGroup, processIdentity, type ProcessGroup } from '../process-group.ts';
import type { ProcessGroupLifecycle, ProcessGroupOwner } from '../tracked-docker.ts';

export const OUTPUT_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  combinedBytes: 20 * 1024 * 1024,
});
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_ABORT_GRACE_MS = 1_000;
const ACKNOWLEDGEMENT_RETRY_MS = 250;
const DIAGNOSTIC_BYTES = 1024;
const ATTACH_PIPE_CLOSE_MS = 1_000;
const active = new Map<string, InvocationHandle>();
const activeProfiles = new WeakSet<ContainerProfile>();
const cleanupRecoveries = new Set<InvocationHandle>();
const hasCleanupRecovery = (attemptId: string) =>
  Array.from(cleanupRecoveries).some(handle => handle.attemptId === attemptId);
const ownsAttempt = (attemptId: string) => active.has(attemptId) || hasCleanupRecovery(attemptId);

export interface CaptureLimits {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly combinedBytes: number;
}
export interface DecodedOutput {
  readonly text: string;
  /** Bytes captured outside process stdout, such as Codex's final-output file. */
  readonly additionalBytes?: number;
  readonly providerFailed?: boolean;
}
export interface SupervisorOptions {
  readonly secrets?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly limits?: Partial<CaptureLimits>;
  /** Keep bounded, lossy diagnostics without letting command output change the process exit result. */
  readonly diagnosticOutput?: boolean;
  /** Trusted monotonic budget carried from adapter setup. */
  readonly invocationBudget?: () => number;
  readonly decode?: (profile: ContainerProfile, rawStdout: Buffer, maximumBytes: number,
    timeoutMs: number, signal: AbortSignal) => DecodedOutput | Promise<DecodedOutput>;
  /** Durable ownership for Docker clients that can create or start resources. */
  readonly processLifecycle?: ProcessGroupLifecycle;
}
export class OutputLimitError extends Error {}
export class CaptureDeadlineError extends Error {}

/** Once the attach leader exits its numeric process-group ID may be reused, even while old pipes remain open. */
export function createAttachExitGuard() {
  let exited = false;
  return Object.freeze({ markExited: () => { exited = true; }, canSignal: () => !exited });
}

/** Signal an attached client only while this process still owns its live leader. */
export function signalAttachedChild(guard: ReturnType<typeof createAttachExitGuard>, child: ChildProcess,
  signal: NodeJS.Signals): void {
  if (!guard.canSignal() || child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

/** Start the streaming attach client without losing a synchronous cancellation raised by lifecycle hooks. */
export function startOwnedAttachClient(options: {
  readonly lifecycle: ProcessGroupLifecycle;
  readonly stopped: () => boolean;
  readonly spawn: () => ChildProcess;
  readonly attach: (child: ChildProcess, owner: ProcessGroupOwner, group?: ProcessGroup) => void;
  readonly terminate: () => void;
  readonly recordFailure: (error: unknown) => void;
}): void {
  let owner: ProcessGroupOwner = 'spawning';
  options.lifecycle.starting();
  if (options.stopped()) {
    options.lifecycle.settled('spawning');
    throw new Error('Invocation stopped before the Docker attach client started.');
  }
  let child: ChildProcess;
  try { child = options.spawn(); }
  catch (error) { options.lifecycle.settled('spawning'); throw error; }
  let spawnedGroup: ProcessGroup | undefined;
  if (child.pid !== undefined) {
    const group = Object.freeze({ pgid: child.pid, startedAt: Date.now(), identity: processIdentity(child.pid) });
    spawnedGroup = group;
    try { options.lifecycle.started(group); owner = group; }
    catch (error) {
      options.recordFailure(error);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
  options.attach(child, owner, spawnedGroup);
  if (options.stopped()) options.terminate();
}

/** Observe both normal exit and an error that Node does not promise will be followed by exit. */
export function watchAttachedChild(child: ChildProcess,
  finish: (code: number | null, signal: NodeJS.Signals | null) => void,
  failed: (error: Error) => void): void {
  child.once('exit', (code, signal) => { finish(code, signal); });
  // Finish first: it disables later PGID signalling and hands the recorded group to the drain path. The failure
  // callback can synchronously cancel the invocation, and must not signal a numeric ID that drain may just release.
  child.once('error', error => { finish(null, null); failed(error); });
}

const dockerEnvironment = () => ({ PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST });
const positiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
};
const captureLimits = (override: Partial<CaptureLimits> | undefined): CaptureLimits => {
  const limits = Object.freeze({ ...OUTPUT_LIMITS, ...override });
  positiveInteger(limits.stdoutBytes, 'stdoutBytes');
  positiveInteger(limits.stderrBytes, 'stderrBytes');
  positiveInteger(limits.combinedBytes, 'combinedBytes');
  if (limits.stdoutBytes > OUTPUT_LIMITS.stdoutBytes || limits.stderrBytes > OUTPUT_LIMITS.stderrBytes
    || limits.combinedBytes > OUTPUT_LIMITS.combinedBytes)
    throw new Error('Capture limits cannot exceed the production hard limits.');
  return limits;
};
const diagnosticFor = (reason: StopReason, detail?: string) => Buffer.from(
  `[codeboost: ${reason}${detail ? `: ${detail.replace(/[\r\n]+/g, ' ').slice(0, 512)}` : ''}]\n`);
/**
 * Retains captured output in fixed-size blocks, so memory scales with retained bytes rather than with the number
 * of write events a container emits.
 */
export class ByteCollector {
  static readonly BLOCK_BYTES = 64 * 1024;
  private readonly blocks: Buffer[] = [];
  private used = 0;
  push(data: Buffer): void {
    for (let offset = 0; offset < data.length;) {
      let block = this.blocks.at(-1);
      if (!block || this.used === block.length) {
        block = Buffer.allocUnsafe(ByteCollector.BLOCK_BYTES);
        this.blocks.push(block);
        this.used = 0;
      }
      const count = Math.min(data.length - offset, block.length - this.used);
      data.copy(block, this.used, offset, offset + count);
      this.used += count;
      offset += count;
    }
  }
  toBuffer(): Buffer {
    if (!this.blocks.length) return Buffer.alloc(0);
    return Buffer.concat([...this.blocks.slice(0, -1), this.blocks.at(-1)!.subarray(0, this.used)]);
  }
  get blockCount(): number { return this.blocks.length; }
}

/** How often unconfirmed cleanup is retried. */
const CLEANUP_RETRY_INTERVAL_MS = 1_000;
/**
 * How long cleanup is retried after its first failure before the handle settles anyway, reporting what it could not
 * remove. Without this bound an unreachable daemon would keep `settled` pending forever.
 */
export const CLEANUP_RETRY_WINDOW_MS = 60_000;
const cleanupWindowDetail = () => `cleanup was not confirmed within ${CLEANUP_RETRY_WINDOW_MS / 1_000} s`;

/**
 * Own an attempt while retrying cleanup. Settles when cleanup succeeds, or when the retry window ends, with
 * `unreleased` listing what may remain. `cleanup` receives the budget left in the window. With `immediate`, the first
 * attempt runs now; otherwise cleanup has already failed once and the first retry waits one interval.
 */
const retainCleanup = (invocation: InvocationInput, cleanup: (budgetMs: number) => void | Promise<void>,
  detail: string, resources: () => readonly UnreleasedResource[], register: boolean,
  released?: (unreleased: boolean) => void,
  options: { immediate?: boolean; reason?: StopReason } = {}): InvocationHandle => {
  let resolveSettled!: (result: InvocationResult) => void, cleaning = false, complete = false, retryAgain = false;
  let cancelReason: StopReason | undefined = options.reason;
  let handle!: InvocationHandle;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUpAt = options.immediate ? undefined : performance.now() + CLEANUP_RETRY_WINDOW_MS;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const finish = (unreleased: boolean) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    complete = true;
    if (active.get(invocation.attemptId) === handle) active.delete(invocation.attemptId);
    cleanupRecoveries.delete(handle);
    const remainingResources = unreleased ? resources() : [];
    released?.(unreleased);
    const reason = cancelReason ?? 'capture-failure';
    resolveSettled(Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
      exitCode: null, signal: null, stopReason: reason, stdout: '',
      stderr: diagnosticFor(reason, unreleased ? `${cleanupWindowDetail()}: ${detail}` : detail).toString('utf8'),
      ...(unreleased ? { unreleased: remainingResources } : {}) }));
  };
  const schedule = () => {
    if (timer || complete) return;
    timer = setTimeout(() => { timer = undefined; retry(); }, CLEANUP_RETRY_INTERVAL_MS);
  };
  const retry = () => {
    if (complete) return;
    // A cancel during an attempt asks for one more attempt as soon as this one ends.
    if (cleaning) { retryAgain = true; return; }
    const budget = giveUpAt === undefined ? 30_000 : cleanupBudget(giveUpAt);
    // No attempt starts once the window has ended, so none can run past it.
    if (budget < 1) { finish(true); return; }
    cleaning = true;
    retryAgain = false;
    void (async () => { await cleanup(budget); })().then(() => {
      cleaning = false;
      finish(false);
    }, () => {
      cleaning = false;
      giveUpAt ??= performance.now() + CLEANUP_RETRY_WINDOW_MS;
      if (performance.now() >= giveUpAt) finish(true);
      else if (retryAgain) retry();
      else schedule();
    });
  };
  handle = Object.freeze({ attemptId: invocation.attemptId, settled,
    cancel: (reason: StopReason) => {
      cancelReason ??= reason;
      if (timer) clearTimeout(timer);
      timer = undefined;
      retry();
    } });
  if (register) active.set(invocation.attemptId, handle);
  else cleanupRecoveries.add(handle);
  if (options.immediate) retry();
  else schedule();
  return handle;
};
/**
 * A Docker client killed at its budget, or an expired invocation budget, can reject a moment before the invocation's
 * own deadline timer fires. Within this much of the deadline, such an error is the deadline itself.
 */
const DEADLINE_SLACK_MS = 1_000;
/** Whether a setup error was caused by a deadline. For `[startup, cleanup]` aggregates only the startup error counts. */
const isDeadlineError = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const value = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (value.code === 'ETIMEDOUT' || (typeof value.message === 'string' && /\bdeadline\b|ETIMEDOUT/i.test(value.message)))
    return true;
  const startup = error instanceof AggregateError ? (value as { startupError?: unknown }).startupError
    ?? (Array.isArray(value.errors) ? value.errors[0] : undefined) : undefined;
  return isDeadlineError(value.cause, seen) || isDeadlineError(startup, seen);
};
/** A retry's Docker budget: what is left of the window, at most the usual 30 s; below 1 when the window has ended. */
const cleanupBudget = (giveUpAt: number) => Math.min(30_000, Math.floor(giveUpAt - performance.now()));
/** Everything a profile may still own, including its agent container only if this profile created one. */
const profileResources = (profile: ContainerProfile) =>
  Object.freeze([...agentContainerResources(profile), ...containerProfileResources(profile)]);

/**
 * Reject an invocation that owns `profile`: release (and, if that fails, keep retrying) what the profile holds, then
 * settle. `cleanup` is container-level disposal by default, or profile-only disposal for a rejection that happened
 * before this profile created any container.
 */
const rejectProfile = (profile: ContainerProfile, error: unknown, register = true,
  cleanup: (profile: ContainerProfile, budgetMs: number, processLifecycle?: ProcessGroupLifecycle) => Promise<void>
    = disposeValidatedContainer,
  reason?: StopReason, processLifecycle?: ProcessGroupLifecycle): InvocationHandle => {
  const invocation = assertPhasePolicy(profile.policy);
  activeProfiles.add(profile);
  return retainCleanup(invocation, budget => isContainerProfileAuthentic(profile)
    ? cleanup(profile, budget, processLifecycle) : undefined,
    `Invocation was rejected: ${String(error)}`, () => profileResources(profile), register, unreleased => {
      activeProfiles.delete(profile);
      if (unreleased) retireContainerProfile(profile);
    }, { immediate: true, reason });
};

/**
 * Retain attempt ownership while retrying resources allocated during adapter setup. `retryCleanup` receives the
 * budget left in the retry window and must not run past it. `resources` is read when the window ends, so it reports
 * only what is still unconfirmed then.
 */
export function retainSetupCleanup(invocation: InvocationInput,
  retryCleanup: (budgetMs: number) => void | Promise<void>, startupError: unknown, cleanupError: unknown,
  kind = 'setup cleanup', resources: readonly UnreleasedResource[] | (() => readonly UnreleasedResource[]) = [],
  reason?: StopReason): InvocationHandle {
  return retainCleanup(invocation, budget => retryCleanup(budget),
    `Adapter startup failed and ${kind} remains unsettled: ${String(startupError)}; ${String(cleanupError)}`,
    typeof resources === 'function' ? resources : () => resources, !ownsAttempt(invocation.attemptId), undefined,
    { reason });
}

/** A setup failure whose own cleanup failed; the launcher keeps retrying `retryCleanup`. */
export interface SetupCleanupFailure {
  readonly startupError: unknown;
  /** Retry within `budgetMs` (default 30 s). */
  readonly retryCleanup: (budgetMs?: number) => Promise<void>;
  /** What may still be left, as of now. */
  readonly resources: readonly UnreleasedResource[];
}
const isSetupCleanupFailure = (error: unknown): error is SetupCleanupFailure & Error => error instanceof Error
  && typeof (error as Partial<SetupCleanupFailure>).retryCleanup === 'function'
  && Array.isArray((error as Partial<SetupCleanupFailure>).resources);
export class AdapterSetupCleanupError extends AggregateError implements SetupCleanupFailure {
  readonly startupError: unknown;
  readonly retryCleanup: (budgetMs?: number) => Promise<void>;
  readonly #resources: () => readonly UnreleasedResource[];
  constructor(startupError: unknown, cleanupError: unknown, retryCleanup: (budgetMs?: number) => Promise<void>,
    resources: readonly UnreleasedResource[] | (() => readonly UnreleasedResource[])) {
    super([startupError, cleanupError], 'Adapter setup failed and its cleanup did not settle.');
    this.startupError = startupError;
    this.retryCleanup = retryCleanup;
    this.#resources = typeof resources === 'function' ? resources : () => resources;
  }
  get resources(): readonly UnreleasedResource[] { return this.#resources(); }
}
/** Hands a finished profile to the supervisor from inside `launchInvocation` setup. */
export type ProfileStarter = (profile: ContainerProfile, options?: SupervisorOptions) => InvocationHandle;

/**
 * Return a handle at once and run adapter setup inside it. `setup` receives a signal that `cancel()` aborts, and a
 * starter that hands its finished profile to the supervisor. The handle settles with the supervisor's result, or, if
 * setup fails, after setup cleanup: at once when the failure left nothing behind, or through bounded retries of a
 * `SetupCleanupFailure`. Throws only when nothing was allocated: another invocation owns this attempt ID.
 */
export function launchInvocation(invocation: InvocationInput, budget: () => number,
  setup: (signal: AbortSignal, start: ProfileStarter) => Promise<InvocationHandle>): InvocationHandle {
  if (ownsAttempt(invocation.attemptId)) throw new Error('An invocation with this attempt ID is still active.');
  const abort = new AbortController();
  let cancelReason: StopReason | undefined, inner: InvocationHandle | undefined;
  let resolveSettled!: (result: InvocationResult) => void;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const handle: InvocationHandle = Object.freeze({ attemptId: invocation.attemptId, settled,
    cancel: (reason: StopReason) => {
      cancelReason ??= reason;
      if (inner) inner.cancel(reason);
      else abort.abort();
    } });
  const release = () => { if (active.get(invocation.attemptId) === handle) active.delete(invocation.attemptId); };
  const left = () => { try { return budget(); } catch { return 0; } };
  // The invocation budget bounds the whole launch, not only setup: at expiry the in-flight Docker call is killed,
  // or the handle setup handed off to is stopped, even if that handle was started with a longer budget.
  const timer = setTimeout(() => {
    cancelReason ??= 'timeout';
    if (inner) inner.cancel('timeout');
    else abort.abort();
  }, Math.max(1, left()));
  timer.unref();
  void settled.then(() => clearTimeout(timer));
  const follow = (next: InvocationHandle) => {
    inner = next;
    if (cancelReason) next.cancel(cancelReason);
    void next.settled.then(resolveSettled);
    return next;
  };
  const start: ProfileStarter = (profile, options) => {
    // Hand ownership of the attempt to the supervisor in the same turn, so no other start can slip in.
    release();
    return follow(startProfileInvocation(profile, options));
  };
  active.set(invocation.attemptId, handle);
  void (async () => {
    try {
      const started = await setup(abort.signal, start);
      if (started !== inner) throw new Error('Adapter setup must return the handle its starter produced.');
    } catch (error) {
      if (inner) return; // The supervisor owns the attempt and settles it.
      release();
      const reason: StopReason = cancelReason
        ?? (left() < 1 || (left() < DEADLINE_SLACK_MS && isDeadlineError(error)) ? 'timeout' : 'capture-failure');
      const startupError = isSetupCleanupFailure(error) ? error.startupError : error;
      if (isSetupCleanupFailure(error)) {
        follow(retainSetupCleanup(invocation, budget => error.retryCleanup(budget), startupError, error,
          'setup cleanup', () => error.resources, reason));
        return;
      }
      resolveSettled(Object.freeze({ attemptId: invocation.attemptId, context: invocation.context, exitCode: null,
        signal: null, stopReason: reason, stdout: '',
        stderr: diagnosticFor(reason, `Adapter setup failed: ${String(startupError)}`).toString('utf8') }));
    }
  })();
  return handle;
}
const withDiagnostic = (stderr: Buffer, stdoutBytes: number, reason: StopReason, limits: CaptureLimits,
  detail?: string) => {
  const diagnostic = diagnosticFor(reason, detail).subarray(0, DIAGNOSTIC_BYTES);
  const maximum = Math.max(0, Math.min(limits.stderrBytes, limits.combinedBytes - stdoutBytes));
  if (maximum <= diagnostic.length) return diagnostic.subarray(0, maximum);
  return Buffer.concat([stderr.subarray(0, maximum - diagnostic.length), diagnostic]);
};
/** Read a running container's tmpfs file with a pinned no-follow bounded reader. */
export function readBoundedContainerFile(container: string, source: string, maximumBytes: number,
  timeoutMs = 30_000, signal?: AbortSignal): Promise<Buffer> {
  positiveInteger(maximumBytes, 'maximumBytes');
  positiveInteger(timeoutMs, 'timeoutMs');
  if (maximumBytes > OUTPUT_LIMITS.stdoutBytes)
    throw new Error('Adapter output read cannot exceed the production stdout limit.');
  if (!/^\/run\/codeboost-output\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source))
    throw new Error('Adapter output must come from the bounded output directory.');
  const reader = [
    "const fs=require('node:fs'),path=process.argv[1],maximum=Number(process.argv[2]),directory='/run/codeboost-output';",
    'let dirfd,fd;try{dirfd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);',
    "fd=fs.openSync('/proc/self/fd/'+dirfd+'/'+path.slice(directory.length+1),",
    'fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);',
    "const before=fs.fstatSync(fd,{bigint:true});if(before.size>BigInt(maximum))throw new Error('OUTPUT_LIMIT');",
    "if(!before.isFile()||before.nlink!==1n)throw new Error('UNSAFE_FILE');",
    'const output=Buffer.allocUnsafe(maximum+1);let length=0,count=0;',
    'do{count=fs.readSync(fd,output,length,output.length-length,null);length+=count}',
    "while(count>0&&length<output.length);if(length>maximum)throw new Error('OUTPUT_LIMIT');",
    'const after=fs.fstatSync(fd,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size',
    '||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.nlink!==1n',
    "||!after.isFile())throw new Error('CHANGED_FILE');",
    "const named=fs.lstatSync('/proc/self/fd/'+dirfd+'/'+path.slice(directory.length+1),{bigint:true,throwIfNoEntry:false});",
    "if(!named||!named.isFile()||named.dev!==after.dev||named.ino!==after.ino||named.nlink!==1n)throw new Error('REPLACED_FILE');",
    "process.stdout.write(output.subarray(0,length))}catch(error){const codes={OUTPUT_LIMIT:42,UNSAFE_FILE:43,CHANGED_FILE:44,REPLACED_FILE:45};process.exitCode=codes[error.message]||46}",
    'finally{if(fd!==undefined)fs.closeSync(fd);if(dirfd!==undefined)fs.closeSync(dirfd)}',
  ].join('');
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'node', '-e', reader, source, String(maximumBytes)], {
      env: dockerEnvironment(), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maximumBytes + 1,
      encoding: 'buffer', signal,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if (error.code === 42) {
        reject(new OutputLimitError('Adapter output exceeds its capture limit.')); return;
      }
      if ('killed' in error && error.killed) {
        reject(new CaptureDeadlineError('Adapter output capture exceeded the invocation deadline.')); return;
      }
      const reason = error.code === 43 ? 'unsafe type or link count' : error.code === 44 ? 'changed while reading'
        : error.code === 45 ? 'pathname identity changed' : 'reader failure';
      reject(new Error(`Adapter output is not a stable bounded unlinked regular file (${reason}).`));
    });
  });
}

/**
 * Run as root inside the container: write the deferred output acknowledgement `collected-<token>` that the wrapper
 * waits for. It is idempotent, so a retry succeeds after an attempt that died once it had created the file: a
 * complete file is kept, and a partial one is unlinked and written again. Only root can create entries in the
 * control directory, and without capabilities root cannot reopen its own read-only file for writing.
 */
export const ACKNOWLEDGEMENT_SCRIPT = [
  "const fs=require('node:fs'),c=fs.constants,token=process.argv[1],directory='/run/codeboost-control';",
  "let dirfd,fd,existing;try{dirfd=fs.openSync(directory,c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW);",
  "const name='/proc/self/fd/'+dirfd+'/collected-'+token,create=()=>fs.openSync(name,",
  'c.O_WRONLY|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o444);',
  "try{fd=create()}catch(error){if(error.code!=='EEXIST')throw error;",
  'existing=fs.openSync(name,c.O_RDONLY|c.O_NOFOLLOW|c.O_NONBLOCK);const stat=fs.fstatSync(existing,{bigint:true});',
  "if(!stat.isFile()||stat.nlink!==1n)throw new Error('UNSAFE_ACK');",
  "const complete=fs.readFileSync(existing,'utf8')===token;fs.closeSync(existing);existing=undefined;",
  'if(!complete){fs.unlinkSync(name);fd=create()}}',
  "if(fd!==undefined){fs.writeFileSync(fd,token);fs.fsyncSync(fd);const stat=fs.fstatSync(fd,{bigint:true});",
  "if(!stat.isFile()||stat.nlink!==1n)throw new Error('UNSAFE_ACK')}}finally{if(existing!==undefined)fs.closeSync(existing);",
  'if(fd!==undefined)fs.closeSync(fd);if(dirfd!==undefined)fs.closeSync(dirfd)}',
].join('');

export function isInvocationActive(attemptId: string): boolean {
  return ownsAttempt(attemptId);
}

export function startProfileInvocation(profile: ContainerProfile, options: SupervisorOptions = {}): InvocationHandle {
  assertContainerProfileAuthenticity(profile);
  // A profile that settled with cleanup unconfirmed is retired for every launch path (run.ts), not only this one.
  if (isContainerProfileRetired(profile))
    throw new Error('This container profile settled without confirmed cleanup; start a new profile.');
  const invocation = assertPhasePolicy(profile.policy);
  if (ownsAttempt(invocation.attemptId)) {
    if (activeProfiles.has(profile))
      throw new Error('This container profile already owns the active invocation.');
    // This profile never created a container; the name belongs to the active invocation, so only
    // release this profile's own staging and network.
    return rejectProfile(profile, new Error('An invocation with this attempt ID is still active.'), false,
      disposeContainerProfile, undefined, options.processLifecycle);
  }
  // Rejections before container creation own no container, so they release (and retry) only the profile's own
  // staging and network; a name held by another invocation or a failing inspect cannot block that.
  let limits: CaptureLimits, configuredTimeout: number, carriedBudget: number;
  try {
    limits = captureLimits(options.limits);
    configuredTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    positiveInteger(configuredTimeout, 'timeoutMs');
    if (configuredTimeout > DEFAULT_TIMEOUT_MS)
      throw new Error('timeoutMs cannot exceed the production ten-minute ceiling.');
    carriedBudget = options.invocationBudget?.() ?? DEFAULT_TIMEOUT_MS;
    positiveInteger(carriedBudget, 'invocationBudget');
    if (carriedBudget > DEFAULT_TIMEOUT_MS)
      throw new Error('invocationBudget cannot exceed the production ten-minute ceiling.');
    if (options.processLifecycle && profile.deferredOutput)
      throw new Error('Durably tracked invocations cannot use concurrent deferred-output controls.');
    if (options.diagnosticOutput && (invocation.vendor !== 'runner' || invocation.phase !== 'review'
      || options.decode || profile.deferredOutput))
      throw new Error('Lossy diagnostic output is reserved for runner command checks.');
  } catch (error) {
    return rejectProfile(profile, error, true, disposeContainerProfile,
      isDeadlineError(error) ? 'timeout' : undefined, options.processLifecycle);
  }
  const wallRemaining = options.invocationBudget ? carriedBudget : invocation.deadline - Date.now();
  if (!Number.isSafeInteger(wallRemaining) || wallRemaining < 1) {
    return rejectProfile(profile, new Error('Invocation deadline has already expired.'), true, disposeContainerProfile,
      'timeout', options.processLifecycle);
  }
  const duration = Math.min(wallRemaining, configuredTimeout, carriedBudget), deadline = performance.now() + duration;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value < 1) throw new Error('Invocation deadline has already expired.');
    return value;
  };

  const stdoutChunks = new ByteCollector(), stderrChunks = new ByteCollector();
  let stdoutBytes = 0, stderrBytes = 0, combinedBytes = 0;
  let outputTruncated = false;
  let stopReason: StopReason | undefined, failureDetail: string | undefined;
  let closed = false, terminating = false, settlementComplete = false;
  let decodedOutput: DecodedOutput | undefined, decodePromise: Promise<void> | undefined;
  let decodeAbort: AbortController | undefined;
  const attachExit = createAttachExitGuard();
  let protocolToken: string | undefined, protocolStarted = false, protocolReady = false;
  let readyStatus: number | undefined, acknowledgementFailures = 0;
  let protocolBuffer = Buffer.alloc(0);
  // Setup (container create and validation) runs inside the handle; a stop kills its in-flight Docker call.
  const setupAbort = new AbortController();
  let child: ChildProcess | undefined;
  // Every call after the create targets the container's immutable ID, never its reusable name. Set once the
  // create returns, before anything can use it.
  let container = '';
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controls = new Set<Promise<boolean>>();
  const runControl = (args: readonly string[], timeoutMs = 5_000) => {
    const operation = new Promise<boolean>(resolve => {
      const control = spawn('docker', [...args], { env: dockerEnvironment(), stdio: 'ignore' });
      const timer = setTimeout(() => control.kill('SIGKILL'), timeoutMs);
      timer.unref();
      let completed = false;
      const done = (success: boolean) => {
        if (completed) return;
        completed = true; clearTimeout(timer); resolve(success);
      };
      control.once('close', code => done(code === 0));
      control.once('error', () => done(false));
    });
    controls.add(operation);
    void operation.finally(() => controls.delete(operation));
    return operation;
  };
  const acknowledgeDeferredOutput = (token: string) =>
    runControl(['exec', '--user', '0', container, 'node', '-e', ACKNOWLEDGEMENT_SCRIPT, token]);
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timer.unref(); timers.add(timer); return timer;
  };
  /**
   * The wrapper exits as soon as it sees the acknowledgement, and that exit can kill the acknowledging `docker exec`
   * before it reports success. The exec's status therefore decides nothing: a failed attempt is retried until one
   * succeeds, the container exits, or a stop ends the invocation. The close handler accepts the output only if the
   * container exited with the READY status, as the wrapper does after it has seen the acknowledgement; any other
   * exit status, or a signal to the attached client, fails closed. A container killed from outside cannot be told
   * apart when its kill status equals the READY status, but its output was already collected in full by then.
   */
  const acknowledge = (token: string) => {
    if (closed || stopReason) return;
    void acknowledgeDeferredOutput(token).then(success => {
      if (success || closed || stopReason) return;
      acknowledgementFailures += 1;
      later(() => acknowledge(token), ACKNOWLEDGEMENT_RETRY_MS);
    });
  };
  const terminate = () => {
    if (terminating || closed || !child || !attachExit.canSignal()) return;
    terminating = true;
    const current = child;
    current.stdout?.resume(); current.stderr?.resume();
    if (options.processLifecycle) {
      if (current.pid !== undefined) {
        signalAttachedChild(attachExit, current, 'SIGTERM');
        later(() => { if (!closed) signalAttachedChild(attachExit, current, 'SIGKILL'); }, 1_000);
      }
      return;
    }
    void runControl(['stop', '--signal=TERM', '--time=1', container]);
    later(() => { if (!closed) void runControl(['kill', '--signal=KILL', container]); }, 1_500);
    later(() => {
      if (!closed) {
        void runControl(['rm', '--force', container]);
        current.kill('SIGKILL');
      }
    }, 4_000);
  };
  const stop = (reason: StopReason) => {
    if (settlementComplete || stopReason) return;
    stopReason = reason;
    setupAbort.abort();
    decodeAbort?.abort();
    if (!closed) terminate();
  };
  const capture = (stream: 'stdout' | 'stderr', value: Buffer | string, final = false) => {
    if (!final && (stopReason || closed)) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const streamBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const streamLimit = stream === 'stdout' ? limits.stdoutBytes : limits.stderrBytes;
    const available = Math.max(0, Math.min(streamLimit - streamBytes, limits.combinedBytes - combinedBytes));
    if (available > 0) {
      const retained = chunk.subarray(0, available);
      (stream === 'stdout' ? stdoutChunks : stderrChunks).push(retained);
      if (stream === 'stdout') stdoutBytes += retained.length;
      else stderrBytes += retained.length;
      combinedBytes += retained.length;
    }
    if (chunk.length > available) {
      if (options.diagnosticOutput) outputTruncated = true;
      else if (final) stopReason ??= 'output-limit';
      else stop('output-limit');
    }
  };
  const consumeProtocol = (length: number) => {
    const available = Math.max(0, Math.min(limits.stderrBytes - stderrBytes,
      limits.combinedBytes - combinedBytes));
    const consumed = Math.min(length, available);
    stderrBytes += consumed;
    combinedBytes += consumed;
    if (length > available) stop('output-limit');
  };
  const decodeOutput = () => {
    if (decodePromise) return decodePromise;
    if (!options.decode || decodedOutput || stopReason) return Promise.resolve();
    decodePromise = (async () => {
      try {
        const budget = Math.ceil(deadline - performance.now());
        if (budget < 1) throw new CaptureDeadlineError('Invocation deadline expired before output capture.');
        const controller = new AbortController();
        decodeAbort = controller;
        const aborted = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(stopReason === 'timeout'
            ? new CaptureDeadlineError('Adapter output capture exceeded the invocation deadline.')
            : new Error('Adapter output capture was cancelled.')), { once: true });
        });
        const raw = stdoutChunks.toBuffer();
        const operation = Promise.resolve(options.decode!(profile, raw,
          Math.max(1, Math.min(limits.stdoutBytes - stdoutBytes, limits.combinedBytes - combinedBytes)),
          budget, controller.signal));
        let decodeTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          decodeTimer = setTimeout(() => {
            stop('timeout');
            reject(new CaptureDeadlineError('Adapter output capture exceeded the invocation deadline.'));
          }, budget);
        });
        let decoded: DecodedOutput;
        try { decoded = await Promise.race([operation, timeout, aborted]); }
        catch (error) {
          controller.abort();
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const grace = new Promise<void>(resolve => {
            graceTimer = setTimeout(resolve, CAPTURE_ABORT_GRACE_MS);
          });
          await Promise.race([operation.then(() => undefined, () => undefined), grace]);
          if (graceTimer) clearTimeout(graceTimer);
          void operation.catch(() => { /* prevent a detached noncooperative decoder from becoming unhandled */ });
          throw error;
        } finally {
          if (decodeTimer) clearTimeout(decodeTimer);
          if (decodeAbort === controller) decodeAbort = undefined;
        }
        if (stopReason) return;
        if (performance.now() >= deadline)
          throw new CaptureDeadlineError('Invocation deadline expired while decoding output.');
        const additional = decoded.additionalBytes ?? 0;
        const textBytes = Buffer.byteLength(decoded.text);
        if (!Number.isSafeInteger(additional) || additional < 0)
          throw new Error('Adapter returned an invalid byte count.');
        if ((additional > 0 && additional < textBytes) || textBytes > limits.stdoutBytes
          || textBytes + stderrBytes > limits.combinedBytes)
          throw new OutputLimitError('Decoded adapter output exceeds its capture limit.');
        if (stdoutBytes + additional > limits.stdoutBytes || combinedBytes + additional > limits.combinedBytes)
          throw new OutputLimitError('Adapter output exceeds its capture limit.');
        if (performance.now() >= deadline)
          throw new CaptureDeadlineError('Invocation deadline expired while validating decoded output.');
        decodedOutput = decoded;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason: StopReason = stopReason ?? (performance.now() >= deadline ? 'timeout'
          : error instanceof OutputLimitError || /exceeds its capture limit/i.test(message)
            ? 'output-limit' : error instanceof CaptureDeadlineError ? 'timeout' : 'capture-failure');
        failureDetail ??= message;
        if (closed) stopReason ??= reason;
        else stop(reason);
      }
    })();
    return decodePromise;
  };
  const protocolLine = (line: Buffer) => {
    const text = line.toString('utf8').trim();
    const started = /^\x1eCODEBOOST_START:([0-9a-f-]{36})\x1e$/.exec(text);
    if (started) {
      consumeProtocol(line.length);
      if (stopReason) return true;
      if (protocolStarted) {
        failureDetail ??= 'Deferred output emitted a duplicate START frame.';
        stop('capture-failure');
        return true;
      }
      if (protocolToken && protocolToken !== started[1]) return false;
      protocolStarted = true;
      protocolToken = started[1];
      return true;
    }
    const ready = /^\x1eCODEBOOST_READY:([0-9a-f-]{36}):([0-9]+)\x1e$/.exec(text);
    if (!ready || ready[1] !== protocolToken) return false;
    consumeProtocol(line.length);
    if (stopReason) return true;
    if (protocolReady) {
      failureDetail ??= 'Deferred output emitted a duplicate READY frame.';
      stop('capture-failure');
      return true;
    }
    protocolReady = true;
    readyStatus = Number(ready[2]);
    const readyToken = ready[1]!;
    void decodeOutput().then(() => { if (decodedOutput) acknowledge(readyToken); });
    return true;
  };
  const captureStderr = (value: Buffer | string) => {
    if (stopReason || closed) return;
    if (!profile.deferredOutput) { capture('stderr', value); return; }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    protocolBuffer = Buffer.concat([protocolBuffer, chunk]);
    let newline: number;
    while ((newline = protocolBuffer.indexOf(0x0a)) >= 0) {
      const line = protocolBuffer.subarray(0, newline + 1);
      protocolBuffer = protocolBuffer.subarray(newline + 1);
      if (!protocolLine(line)) capture('stderr', line);
    }
    if (protocolBuffer.length > 1024) {
      const flush = protocolBuffer.subarray(0, protocolBuffer.length - 128);
      protocolBuffer = protocolBuffer.subarray(protocolBuffer.length - 128);
      capture('stderr', flush);
    }
  };
  let resolveSettled!: (result: InvocationResult) => void;
  let wakeCleanup: (() => void) | undefined;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const handle: InvocationHandle = Object.freeze({
    attemptId: invocation.attemptId,
    settled,
    cancel: (reason: StopReason) => { stop(reason); wakeCleanup?.(); },
  });
  active.set(invocation.attemptId, handle);
  activeProfiles.add(profile);
  later(() => stop('timeout'), Math.max(1, Math.ceil(deadline - performance.now())));

  /** Remove everything the profile owns (bounded), then publish the result. */
  const settleWith = async (exitCode: number | null, finalSignal: NodeJS.Signals | null, stdout: Buffer,
    stderr: Buffer) => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.all([...controls]);
    let finalStdout = stdout, finalStderr = stderr;
    let giveUpAt: number | undefined, unreleased: readonly UnreleasedResource[] | undefined;
    // A failed setup may already have released everything, which also ends the profile's authenticity.
    while (isContainerProfileAuthentic(profile)) {
      const budget = giveUpAt === undefined ? 30_000 : cleanupBudget(giveUpAt);
      if (budget < 1) {
        // The window ended between attempts: report instead of starting one that would run past it.
        unreleased = profileResources(profile);
        retireContainerProfile(profile);
        failureDetail = `${cleanupWindowDetail()}: ${failureDetail}`;
        wakeCleanup = undefined;
        break;
      }
      try {
        await disposeValidatedContainer(profile, budget, options.processLifecycle);
        wakeCleanup = undefined;
        break;
      } catch (error) {
        stopReason ??= 'capture-failure';
        failureDetail ??= error instanceof Error ? error.message : String(error);
        giveUpAt ??= performance.now() + CLEANUP_RETRY_WINDOW_MS;
        if (performance.now() >= giveUpAt) {
          wakeCleanup = undefined;
          unreleased = profileResources(profile);
          retireContainerProfile(profile);
          failureDetail = `${cleanupWindowDetail()}: ${failureDetail}`;
          break;
        }
        await new Promise<void>(resolve => {
          let finished = false;
          const wake = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
          const timer = setTimeout(wake, CLEANUP_RETRY_INTERVAL_MS);
          wakeCleanup = wake;
        });
      }
    }
    // Agent answers publish only strictly valid UTF-8: replacement characters would grow the result past the byte
    // ceilings. Runner command output is diagnostic rather than an answer, so it is decoded lossily and bounded again.
    // Only strict output cut at a capture limit may end in an incomplete character, which streaming decode drops;
    // otherwise strict decode flushes, so a trailing lone lead byte fails closed.
    const truncated = stopReason === 'output-limit';
    const strictText = (value: Buffer) => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(value, truncated ? { stream: true } : undefined); }
      catch { return undefined; }
    };
    const boundedDiagnostic = (value: Buffer, maximum: number) => {
      const encoded = Buffer.from(new TextDecoder('utf-8').decode(value));
      if (encoded.length <= maximum) return encoded;
      return Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, maximum), { stream: true }));
    };
    if (options.diagnosticOutput) {
      finalStdout = boundedDiagnostic(finalStdout, Math.min(limits.stdoutBytes, limits.combinedBytes));
      finalStderr = boundedDiagnostic(finalStderr,
        Math.max(0, Math.min(limits.stderrBytes, limits.combinedBytes - finalStdout.length)));
      if (outputTruncated) {
        const notice = Buffer.from('[codeboost: command output truncated]\n');
        const maximum = Math.max(0, Math.min(limits.stderrBytes, limits.combinedBytes - finalStdout.length));
        finalStderr = maximum <= notice.length ? notice.subarray(0, maximum)
          : Buffer.concat([finalStderr.subarray(0, maximum - notice.length), notice]);
      }
    } else {
      const stdoutText = strictText(finalStdout), stderrText = strictText(finalStderr);
      if (stdoutText === undefined || stderrText === undefined) {
        stopReason ??= 'capture-failure';
        failureDetail ??= 'Captured output is not valid UTF-8.';
      }
      finalStdout = Buffer.from(stdoutText ?? ''); finalStderr = Buffer.from(stderrText ?? '');
    }
    if (stopReason) finalStderr = withDiagnostic(finalStderr, finalStdout.length, stopReason, limits, failureDetail);
    const result = Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
      exitCode, signal: finalSignal, ...(stopReason ? { stopReason } : {}),
      stdout: finalStdout.toString('utf8'), stderr: finalStderr.toString('utf8'), ...(unreleased ? { unreleased } : {}) });
    settlementComplete = true;
    activeProfiles.delete(profile);
    active.delete(invocation.attemptId);
    resolveSettled(result);
  };

  const attach = (started: ChildProcess, processOwner?: ProcessGroupOwner, spawnedGroup?: ProcessGroup) => {
    child = started;
    let finished = false, pipeClosed = false, resolvePipeClosed!: () => void;
    const pipesClosed = new Promise<void>(resolve => { resolvePipeClosed = resolve; });
    started.stdout?.on('data', value => capture('stdout', value));
    started.stderr?.on('data', captureStderr);
    started.stdout?.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
    started.stderr?.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      // Disable every later deadline/cancellation signal before awaiting group drain or pipe closure. Once exit fires,
      // the numeric PGID can be reused; drain owns the old group until it reports empty and must be the last signaller.
      attachExit.markExited();
      let unsettled: 'group-alive' | 'stdio-held' | undefined;
    if (spawnedGroup && options.processLifecycle
        && !await drainProcessGroup(spawnedGroup)) unsettled = 'group-alive';
      let pipeTimer: ReturnType<typeof setTimeout> | undefined;
      if (!pipeClosed) await Promise.race([pipesClosed, new Promise<void>(resolve => {
        pipeTimer = setTimeout(resolve, ATTACH_PIPE_CLOSE_MS);
      })]);
      clearTimeout(pipeTimer);
      if (!pipeClosed) {
        unsettled ??= 'stdio-held';
        started.stdout?.destroy(); started.stderr?.destroy();
      }
      closed = true;
      if (processOwner && options.processLifecycle) try {
        if (unsettled) options.processLifecycle.unsettled(processOwner, unsettled);
        else options.processLifecycle.settled(processOwner);
      } catch (error) {
        stopReason ??= 'capture-failure'; failureDetail ??=
          `Could not settle Docker client ownership: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (!stopReason && performance.now() >= deadline) stop('timeout');
      if (protocolBuffer.length) {
        if (!protocolLine(protocolBuffer)) capture('stderr', protocolBuffer, true);
        protocolBuffer = Buffer.alloc(0);
      }
      let finalStdout = stdoutChunks.toBuffer();
      const finalStderr = stderrChunks.toBuffer();
      let exitCode = code;
      if (!stopReason && options.decode && !profile.deferredOutput) await decodeOutput();
      if (decodePromise) await decodePromise;
      if (!stopReason && profile.deferredOutput && !decodedOutput) {
        stopReason = 'capture-failure'; failureDetail ??= 'Deferred output protocol did not complete.';
      }
      if (stopReason === 'timeout' && acknowledgementFailures)
        failureDetail ??= `Deferred output acknowledgement failed ${acknowledgementFailures} times.`;
      if (!stopReason && profile.deferredOutput && (signal !== null || exitCode !== readyStatus)) {
        stopReason = 'capture-failure';
        failureDetail ??= 'Container exited without taking the deferred output acknowledgement.';
      }
      if (decodedOutput && !stopReason) {
        finalStdout = Buffer.from(decodedOutput.text);
        if (decodedOutput.providerFailed) exitCode = exitCode === 0 ? 1 : exitCode;
      }
      await settleWith(exitCode, signal, finalStdout, finalStderr);
    };
    started.once('close', (code, signal) => {
      pipeClosed = true; resolvePipeClosed();
      if (!processOwner) void finish(code, signal);
    });
    if (processOwner) watchAttachedChild(started, (code, signal) => { void finish(code, signal); }, error => {
      failureDetail ??= error.message; stop('capture-failure');
    });
    else started.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
  };

  void (async () => {
    try {
      await createValidatedContainer(profile, remaining(), options.secrets ?? {}, setupAbort.signal,
        options.processLifecycle);
      container = agentContainerId(profile) ?? '';
      if (!container) throw new Error('Docker did not return the created agent container ID.');
      await validateContainer(container, profile, remaining(), setupAbort.signal, options.processLifecycle);
      if (stopReason) throw new Error('Invocation was stopped during setup.');
    } catch (error) {
      closed = true;
      if (!stopReason) {
        const left = deadline - performance.now();
        stopReason = left <= 0 || (left < DEADLINE_SLACK_MS && isDeadlineError(error)) ? 'timeout' : 'capture-failure';
        failureDetail ??= `Container setup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      await settleWith(null, null, Buffer.alloc(0), Buffer.alloc(0));
      return;
    }
    try {
      const spawnAttach = () => spawn('docker', ['start', '--attach', container], {
        env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: options.processLifecycle !== undefined,
      });
      if (options.processLifecycle) startOwnedAttachClient({ lifecycle: options.processLifecycle,
        stopped: () => {
          // Lifecycle hooks are synchronous and can keep the deadline timer from running. Recheck the monotonic
          // deadline at the spawn boundary so an overdue invocation cannot create an attach client afterward.
          if (!stopReason && performance.now() >= deadline) stop('timeout');
          return stopReason !== undefined;
        }, spawn: spawnAttach,
        attach: (started, owner, group) => attach(started, owner, group), terminate,
        recordFailure: error => {
          failureDetail ??= `Could not record Docker client ownership: ${error instanceof Error ? error.message : String(error)}`;
          stopReason ??= 'capture-failure';
        } });
      else attach(spawnAttach());
    } catch (error) {
      closed = true; stopReason ??= 'capture-failure';
      failureDetail ??= `Container start failed: ${error instanceof Error ? error.message : String(error)}`;
      await settleWith(null, null, Buffer.alloc(0), Buffer.alloc(0));
    }
  })();
  return handle;
}

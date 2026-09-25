import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason } from '../contract.ts';
import { assertPhasePolicy } from '../policy.ts';
import { createValidatedContainer, disposeValidatedContainer, validateContainer } from '../container/run.ts';
import type { ContainerProfile } from '../container/profile.ts';
import { removeVendorNetwork, type VendorNetwork } from '../network/network.ts';

export const OUTPUT_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  combinedBytes: 20 * 1024 * 1024,
});
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_ABORT_GRACE_MS = 1_000;
const DIAGNOSTIC_BYTES = 1024;
const active = new Map<string, InvocationHandle>();
const cleanupRecoveries = new Set<InvocationHandle>();

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
  readonly decode?: (profile: ContainerProfile, rawStdout: Buffer, maximumBytes: number,
    timeoutMs: number, signal: AbortSignal) => DecodedOutput | Promise<DecodedOutput>;
}
export class OutputLimitError extends Error {}
export class CaptureDeadlineError extends Error {}

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
const retainCleanupOwnership = (profile: ContainerProfile, detail: string, register = true): InvocationHandle => {
  const invocation = assertPhasePolicy(profile.policy);
  let resolveSettled!: (result: InvocationResult) => void, cleaning = false, complete = false;
  let handle!: InvocationHandle;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; retry(); }, 1_000);
    timer.unref();
  };
  const retry = () => {
    if (cleaning || complete) return;
    cleaning = true;
    try {
      disposeValidatedContainer(profile);
      if (timer) clearTimeout(timer);
      timer = undefined;
      complete = true;
      if (active.get(invocation.attemptId) === handle) active.delete(invocation.attemptId);
      cleanupRecoveries.delete(handle);
      resolveSettled(Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
        exitCode: null, signal: null, stopReason: 'capture-failure', stdout: '',
        stderr: diagnosticFor('capture-failure', detail).toString('utf8') }));
    } catch {
      cleaning = false;
      schedule();
      return;
    }
    cleaning = false;
  };
  handle = Object.freeze({ attemptId: invocation.attemptId, settled,
    cancel: () => { if (timer) clearTimeout(timer); timer = undefined; retry(); } });
  if (register) active.set(invocation.attemptId, handle);
  else cleanupRecoveries.add(handle);
  schedule();
  return handle;
};

/** Retain attempt ownership while retrying a network allocated before profile construction failed. */
export function retainNetworkCleanup(invocation: InvocationInput, network: VendorNetwork,
  startupError: unknown, cleanupError: unknown): InvocationHandle {
  return retainSetupCleanup(invocation, () => removeVendorNetwork(network), startupError, cleanupError,
    'network cleanup');
}

/** Retain attempt ownership while retrying resources allocated during synchronous adapter setup. */
export function retainSetupCleanup(invocation: InvocationInput, retryCleanup: () => void,
  startupError: unknown, cleanupError: unknown, kind = 'setup cleanup'): InvocationHandle {
  const register = !active.has(invocation.attemptId);
  let resolveSettled!: (result: InvocationResult) => void, cleaning = false, complete = false;
  let handle!: InvocationHandle;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const detail = `Adapter startup failed and ${kind} remains unsettled: ${String(startupError)}; ${String(cleanupError)}`;
  const retry = () => {
    if (cleaning || complete) return;
    cleaning = true;
    try {
      retryCleanup();
      if (timer) clearTimeout(timer);
      timer = undefined;
      complete = true;
      if (active.get(invocation.attemptId) === handle) active.delete(invocation.attemptId);
      cleanupRecoveries.delete(handle);
      resolveSettled(Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
        exitCode: null, signal: null, stopReason: 'capture-failure', stdout: '',
        stderr: diagnosticFor('capture-failure', detail).toString('utf8') }));
    } catch {
      cleaning = false;
      if (!timer) {
        timer = setTimeout(() => { timer = undefined; retry(); }, 1_000);
        timer.unref();
      }
      return;
    }
    cleaning = false;
  };
  handle = Object.freeze({ attemptId: invocation.attemptId, settled,
    cancel: () => { if (timer) clearTimeout(timer); timer = undefined; retry(); } });
  if (register) active.set(invocation.attemptId, handle);
  else cleanupRecoveries.add(handle);
  timer = setTimeout(() => { timer = undefined; retry(); }, 1_000); timer.unref();
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

export function isInvocationActive(attemptId: string): boolean {
  return active.has(attemptId);
}

export function startProfileInvocation(profile: ContainerProfile, options: SupervisorOptions = {}): InvocationHandle {
  const invocation = assertPhasePolicy(profile.policy);
  const rejectWithCleanup = (error: unknown, register = true): InvocationHandle => {
    try { disposeValidatedContainer(profile); }
    catch (cleanupError) {
      return retainCleanupOwnership(profile,
        `Invocation was rejected and cleanup remains unsettled: ${String(error)}; ${String(cleanupError)}`, register);
    }
    throw error;
  };
  if (active.has(invocation.attemptId)) {
    return rejectWithCleanup(new Error('An invocation with this attempt ID is still active.'), false);
  }
  let limits: CaptureLimits, configuredTimeout: number;
  try {
    limits = captureLimits(options.limits);
    configuredTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    positiveInteger(configuredTimeout, 'timeoutMs');
    if (configuredTimeout > DEFAULT_TIMEOUT_MS)
      throw new Error('timeoutMs cannot exceed the production ten-minute ceiling.');
  } catch (error) {
    return rejectWithCleanup(error);
  }
  const wallRemaining = invocation.deadline - Date.now();
  if (!Number.isSafeInteger(wallRemaining) || wallRemaining < 1) {
    return rejectWithCleanup(new Error('Invocation deadline has already expired.'));
  }
  const duration = Math.min(wallRemaining, configuredTimeout), deadline = performance.now() + duration;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value < 1) throw new Error('Invocation deadline has already expired.');
    return value;
  };
  try {
    createValidatedContainer(profile, remaining(), options.secrets ?? {});
    validateContainer(profile.name, profile, remaining());
  } catch (error) {
    try { disposeValidatedContainer(profile); }
    catch (cleanupError) {
      const detail = `Container validation failed and cleanup remains unsettled: ${String(error)}; ${String(cleanupError)}`;
      return retainCleanupOwnership(profile, detail);
    }
    throw error;
  }

  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0, combinedBytes = 0;
  let stopReason: StopReason | undefined, failureDetail: string | undefined;
  let closed = false, terminating = false, settlementComplete = false;
  let decodedOutput: DecodedOutput | undefined, decodePromise: Promise<void> | undefined;
  let decodeAbort: AbortController | undefined;
  let protocolToken: string | undefined, protocolStarted = false, protocolReady = false;
  let protocolBuffer = Buffer.alloc(0);
  const child = spawn('docker', ['start', '--attach', profile.name], {
    env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const acknowledgeDeferredOutput = (token: string) => {
    const script = [
      "const fs=require('node:fs'),token=process.argv[1],directory='/run/codeboost-control';",
      'let dirfd,fd;try{dirfd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);',
      "fd=fs.openSync('/proc/self/fd/'+dirfd+'/collected-'+token,",
      'fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o444);',
      "fs.writeFileSync(fd,token);fs.fsyncSync(fd);const stat=fs.fstatSync(fd,{bigint:true});",
      "if(!stat.isFile()||stat.nlink!==1n)throw new Error('UNSAFE_ACK')}finally{if(fd!==undefined)fs.closeSync(fd);",
      'if(dirfd!==undefined)fs.closeSync(dirfd)}',
    ].join('');
    return runControl(['exec', '--user', '0', profile.name, 'node', '-e', script, token]);
  };
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timer.unref(); timers.add(timer); return timer;
  };
  const terminate = () => {
    if (terminating || closed) return;
    terminating = true;
    child.stdout?.resume(); child.stderr?.resume();
    void runControl(['stop', '--signal=TERM', '--time=1', profile.name]);
    later(() => { if (!closed) void runControl(['kill', '--signal=KILL', profile.name]); }, 1_500);
    later(() => {
      if (!closed) {
        void runControl(['rm', '--force', profile.name]);
        child.kill('SIGKILL');
      }
    }, 4_000);
  };
  const stop = (reason: StopReason) => {
    if (settlementComplete || stopReason) return;
    stopReason = reason;
    decodeAbort?.abort();
    if (!closed) terminate();
  };
  const capture = (stream: 'stdout' | 'stderr', value: Buffer | string) => {
    if (stopReason || closed) return;
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
    if (chunk.length > available) stop('output-limit');
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
        const raw = Buffer.concat(stdoutChunks, stdoutBytes);
        const operation = Promise.resolve(options.decode!(profile, raw,
          Math.max(1, Math.min(limits.stdoutBytes - stdoutBytes, limits.combinedBytes - combinedBytes)),
          budget, controller.signal));
        let decodeTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          decodeTimer = setTimeout(() => {
            stop('timeout');
            reject(new CaptureDeadlineError('Adapter output capture exceeded the invocation deadline.'));
          }, budget);
          decodeTimer.unref();
        });
        let decoded: DecodedOutput;
        try { decoded = await Promise.race([operation, timeout, aborted]); }
        catch (error) {
          controller.abort();
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const grace = new Promise<void>(resolve => {
            graceTimer = setTimeout(resolve, CAPTURE_ABORT_GRACE_MS);
            graceTimer.unref();
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
        const additional = decoded.additionalBytes ?? 0;
        const textBytes = Buffer.byteLength(decoded.text);
        if (!Number.isSafeInteger(additional) || additional < 0)
          throw new Error('Adapter returned an invalid byte count.');
        if ((additional > 0 && additional < textBytes) || textBytes > limits.stdoutBytes
          || textBytes + stderrBytes > limits.combinedBytes)
          throw new OutputLimitError('Decoded adapter output exceeds its capture limit.');
        if (stdoutBytes + additional > limits.stdoutBytes || combinedBytes + additional > limits.combinedBytes)
          throw new OutputLimitError('Adapter output exceeds its capture limit.');
        decodedOutput = decoded;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = error instanceof OutputLimitError || /exceeds its capture limit/i.test(message)
          ? 'output-limit' : error instanceof CaptureDeadlineError ? 'timeout' : 'capture-failure';
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
    const readyToken = ready[1]!;
    void decodeOutput().then(() => {
      if (decodedOutput && !stopReason) {
        void acknowledgeDeferredOutput(readyToken)
          .then(success => {
            if (!success) {
              failureDetail ??= 'Deferred output acknowledgement failed.';
              stop('capture-failure');
            }
          });
      }
    });
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
  child.stdout?.on('data', value => capture('stdout', value));
  child.stderr?.on('data', captureStderr);
  child.stdout?.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
  child.stderr?.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
  child.once('error', error => { failureDetail ??= error.message; stop('capture-failure'); });
  later(() => stop('timeout'), Math.max(1, Math.ceil(deadline - performance.now())));

  let resolveSettled!: (result: InvocationResult) => void;
  let wakeCleanup: (() => void) | undefined;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const handle: InvocationHandle = Object.freeze({
    attemptId: invocation.attemptId,
    settled,
    cancel: (reason: StopReason) => { stop(reason); wakeCleanup?.(); },
  });
  active.set(invocation.attemptId, handle);

  child.once('close', async (code, signal) => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (protocolBuffer.length) {
      if (!protocolLine(protocolBuffer)) capture('stderr', protocolBuffer);
      protocolBuffer = Buffer.alloc(0);
    }
    closed = true;
    let finalStdout = Buffer.concat(stdoutChunks, stdoutBytes), finalStderr = Buffer.concat(stderrChunks);
    let exitCode = code, finalSignal = signal;
    if (!stopReason && options.decode && !profile.deferredOutput) await decodeOutput();
    if (decodePromise) await decodePromise;
    if (!stopReason && profile.deferredOutput && !decodedOutput) {
      stopReason = 'capture-failure'; failureDetail ??= 'Deferred output protocol did not complete.';
    }
    if (decodedOutput) {
      finalStdout = Buffer.from(decodedOutput.text);
      if (decodedOutput.providerFailed) exitCode = exitCode === 0 ? 1 : exitCode;
    }
    await Promise.all([...controls]);
    while (true) {
      try {
        disposeValidatedContainer(profile);
        wakeCleanup = undefined;
        break;
      } catch (error) {
        stopReason ??= 'capture-failure';
        failureDetail ??= error instanceof Error ? error.message : String(error);
        await new Promise<void>(resolve => {
          let finished = false;
          const wake = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
          const timer = setTimeout(wake, 1_000); timer.unref();
          wakeCleanup = wake;
        });
      }
    }
    if (stopReason) finalStderr = withDiagnostic(finalStderr, finalStdout.length, stopReason, limits, failureDetail);
    const result = Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
      exitCode, signal: finalSignal, ...(stopReason ? { stopReason } : {}),
      stdout: finalStdout.toString('utf8'), stderr: finalStderr.toString('utf8') });
    settlementComplete = true;
    active.delete(invocation.attemptId);
    resolveSettled(result);
  });
  return handle;
}

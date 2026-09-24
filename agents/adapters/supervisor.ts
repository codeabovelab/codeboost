import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { InvocationHandle, InvocationResult, StopReason } from '../contract.ts';
import { assertPhasePolicy } from '../policy.ts';
import { createValidatedContainer, disposeValidatedContainer, validateContainer } from '../container/run.ts';
import type { ContainerProfile } from '../container/profile.ts';

export const OUTPUT_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  combinedBytes: 20 * 1024 * 1024,
});
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DIAGNOSTIC_BYTES = 1024;
const active = new Map<string, InvocationHandle>();

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
  readonly decode?: (profile: ContainerProfile, rawStdout: Buffer, maximumBytes: number) => DecodedOutput;
}
export class OutputLimitError extends Error {}

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
const withDiagnostic = (stderr: Buffer, stdoutBytes: number, reason: StopReason, limits: CaptureLimits,
  detail?: string) => {
  const diagnostic = diagnosticFor(reason, detail).subarray(0, DIAGNOSTIC_BYTES);
  const maximum = Math.max(0, Math.min(limits.stderrBytes, limits.combinedBytes - stdoutBytes));
  if (maximum <= diagnostic.length) return diagnostic.subarray(0, maximum);
  return Buffer.concat([stderr.subarray(0, maximum - diagnostic.length), diagnostic]);
};
const runControl = (args: readonly string[], timeoutMs = 5_000): ChildProcess => {
  const child = spawn('docker', [...args], { env: dockerEnvironment(), stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
  return child;
};

/** Read a running container's tmpfs file with a pinned no-follow bounded reader. */
export function readBoundedContainerFile(container: string, source: string, maximumBytes: number): Buffer {
  positiveInteger(maximumBytes, 'maximumBytes');
  if (!source.startsWith('/tmp/codeboost-output/') || source.includes('\0'))
    throw new Error('Adapter output must come from the bounded output directory.');
  try {
    const reader = [
      "const fs=require('node:fs'),path=process.argv[1],maximum=Number(process.argv[2]);",
      'let fd;try{fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);',
      "const before=fs.fstatSync(fd);if(before.size>maximum)throw new Error('OUTPUT_LIMIT');",
      "if(!before.isFile()||before.nlink!==1)throw new Error('UNSAFE_FILE');",
      'const output=Buffer.allocUnsafe(maximum+1);let length=0,count=0;',
      'do{count=fs.readSync(fd,output,length,output.length-length,null);length+=count}',
      "while(count>0&&length<output.length);if(length>maximum)throw new Error('OUTPUT_LIMIT');",
      'const after=fs.fstatSync(fd);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size',
      "||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('CHANGED_FILE');",
      'process.stdout.write(output.subarray(0,length))}finally{if(fd!==undefined)fs.closeSync(fd)}',
    ].join('');
    return execFileSync('docker', ['exec', container, 'node', '-e', reader, source, String(maximumBytes)], {
      env: dockerEnvironment(), timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: maximumBytes + 1,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const diagnostic = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error);
    if (diagnostic.includes('OUTPUT_LIMIT')) throw new OutputLimitError('Adapter output exceeds its capture limit.');
    throw new Error('Adapter output is not a stable bounded unlinked regular file.');
  }
}

export function isInvocationActive(attemptId: string): boolean {
  return active.has(attemptId);
}

export function startProfileInvocation(profile: ContainerProfile, options: SupervisorOptions = {}): InvocationHandle {
  const invocation = assertPhasePolicy(profile.policy);
  if (active.has(invocation.attemptId)) {
    disposeValidatedContainer(profile);
    throw new Error('An invocation with this attempt ID is still active.');
  }
  let limits: CaptureLimits, configuredTimeout: number;
  try {
    limits = captureLimits(options.limits);
    configuredTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    positiveInteger(configuredTimeout, 'timeoutMs');
  } catch (error) {
    disposeValidatedContainer(profile);
    throw error;
  }
  const now = Date.now(), deadline = Math.min(invocation.deadline, now + configuredTimeout);
  if (!Number.isSafeInteger(deadline) || deadline <= now) {
    disposeValidatedContainer(profile);
    throw new Error('Invocation deadline has already expired.');
  }
  const remaining = () => {
    const value = deadline - Date.now();
    if (value < 1) throw new Error('Invocation deadline has already expired.');
    return value;
  };
  try {
    createValidatedContainer(profile, remaining(), options.secrets ?? {});
    validateContainer(profile.name, profile, remaining());
  } catch (error) {
    try { disposeValidatedContainer(profile); } catch { /* createValidatedContainer already reports unsettled cleanup */ }
    throw error;
  }

  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0, combinedBytes = 0;
  let stopReason: StopReason | undefined, failureDetail: string | undefined, closed = false, terminating = false;
  let decodedOutput: DecodedOutput | undefined, protocolToken: string | undefined;
  let protocolBuffer = Buffer.alloc(0);
  const child = spawn('docker', ['start', '--attach', profile.name], {
    env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timer.unref(); timers.add(timer); return timer;
  };
  const terminate = () => {
    if (terminating || closed) return;
    terminating = true;
    child.stdout?.resume(); child.stderr?.resume();
    runControl(['stop', '--signal=TERM', '--time=1', profile.name]);
    later(() => { if (!closed) runControl(['kill', '--signal=KILL', profile.name]); }, 1_500);
    later(() => {
      if (!closed) {
        runControl(['rm', '--force', profile.name]);
        child.kill('SIGKILL');
      }
    }, 4_000);
  };
  const stop = (reason: StopReason) => {
    if (closed || stopReason) return;
    stopReason = reason;
    terminate();
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
  const decodeOutput = () => {
    if (!options.decode || decodedOutput || stopReason) return;
    try {
      const raw = Buffer.concat(stdoutChunks, stdoutBytes);
      const decoded = options.decode(profile, raw,
        Math.max(1, Math.min(limits.stdoutBytes - stdoutBytes, limits.combinedBytes - combinedBytes)));
      const additional = decoded.additionalBytes ?? 0;
      if (!Number.isSafeInteger(additional) || additional < 0) throw new Error('Adapter returned an invalid byte count.');
      if (stdoutBytes + additional > limits.stdoutBytes || combinedBytes + additional > limits.combinedBytes)
        throw new OutputLimitError('Adapter output exceeds its capture limit.');
      decodedOutput = decoded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = error instanceof OutputLimitError || /exceeds its capture limit/i.test(message)
        ? 'output-limit' : 'capture-failure';
      failureDetail ??= message;
      if (closed) stopReason ??= reason;
      else stop(reason);
    }
  };
  const protocolLine = (line: Buffer) => {
    const text = line.toString('utf8').trim();
    const started = /^\x1eCODEBOOST_START:([0-9a-f-]{36})\x1e$/.exec(text);
    if (started) {
      if (protocolToken && protocolToken !== started[1]) return false;
      protocolToken = started[1];
      return true;
    }
    const ready = /^\x1eCODEBOOST_READY:([0-9a-f-]{36}):([0-9]+)\x1e$/.exec(text);
    if (!ready || ready[1] !== protocolToken) return false;
    decodeOutput();
    if (decodedOutput) runControl(['exec', profile.name, 'touch', `/tmp/codeboost-output/collected-${ready[1]}`]);
    return true;
  };
  const captureStderr = (value: Buffer | string) => {
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
  later(() => stop('timeout'), Math.max(1, deadline - Date.now()));

  let resolveSettled!: (result: InvocationResult) => void;
  const settled = new Promise<InvocationResult>(resolve => { resolveSettled = resolve; });
  const handle: InvocationHandle = Object.freeze({
    attemptId: invocation.attemptId,
    settled,
    cancel: (reason: StopReason) => stop(reason),
  });
  active.set(invocation.attemptId, handle);

  child.once('close', (code, signal) => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (protocolBuffer.length) {
      if (!protocolLine(protocolBuffer)) capture('stderr', protocolBuffer);
      protocolBuffer = Buffer.alloc(0);
    }
    closed = true;
    let finalStdout = Buffer.concat(stdoutChunks, stdoutBytes), finalStderr = Buffer.concat(stderrChunks, stderrBytes);
    let exitCode = code, finalSignal = signal;
    if (!stopReason && code === 0 && options.decode && !profile.deferredOutput) decodeOutput();
    if (!stopReason && code === 0 && profile.deferredOutput && !decodedOutput) {
      stopReason = 'capture-failure'; failureDetail ??= 'Deferred output protocol did not complete.';
    }
    if (decodedOutput) {
      finalStdout = Buffer.from(decodedOutput.text);
      if (decodedOutput.providerFailed) exitCode = exitCode === 0 ? 1 : exitCode;
    }
    try {
      disposeValidatedContainer(profile);
    } catch {
      stopReason ??= 'capture-failure';
      return; // Ownership remains active because termination/cleanup was not confirmed.
    }
    if (stopReason) finalStderr = withDiagnostic(finalStderr, finalStdout.length, stopReason, limits, failureDetail);
    const result = Object.freeze({ attemptId: invocation.attemptId, context: invocation.context,
      exitCode, signal: finalSignal, ...(stopReason ? { stopReason } : {}),
      stdout: finalStdout.toString('utf8'), stderr: finalStderr.toString('utf8') });
    active.delete(invocation.attemptId);
    resolveSettled(result);
  });
  return handle;
}

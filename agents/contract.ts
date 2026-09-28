import { isLabelAttemptId, isRunnerOwner } from './labels.ts';

/** Lane D/F boundary. Only the runner may construct requests after admission. */
export interface TaskClone {
  readonly id: string;
  readonly taskId: string;
  /** Staging clone, NOT a container-ready mount. D2 must allocate bounded storage. */
  readonly directory: string;
  readonly head: string;
}

export type Phase = 'planning' | 'questions' | 'review' | 'execute' | 'fix';
export interface InvocationContext {
  readonly snapshotId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly assignmentId: string;
  readonly referencedCodeHash: string;
  readonly stateVersion: number;
}
export interface InvocationInput {
  readonly clone: TaskClone;
  readonly phase: Phase;
  readonly vendor: 'claude' | 'codex';
  readonly approvedArgv: readonly (readonly string[])[];
  readonly deadline: number;
  readonly attemptId: string;
  /**
   * The runner token of the database this attempt belongs to: 32 lowercase hex characters, created once per database.
   * Every Docker object D creates for the invocation carries it as `io.codeboost.runner` (#51 item 3).
   */
  readonly runnerOwner: string;
  readonly context: InvocationContext;
}
export type StopReason = 'cancelled' | 'timeout' | 'shutdown' | 'output-limit' | 'capture-failure';
/**
 * A resource D created for an attempt and could not confirm removed. When `id` is present it proves ownership on its
 * own (D captured it at create, and Docker never reuses IDs): remove the object by that ID, whatever its labels say.
 * A name alone proves nothing: without `id`, look the object up by name and remove it by the ID that lookup returns
 * only if all of its `labels` match.
 */
export interface UnreleasedResource {
  readonly kind: 'container' | 'network' | 'directory';
  /** Docker name, or the absolute host path of a staging directory. */
  readonly name: string;
  /** Docker object ID captured at creation; absent when the create's outcome is unknown. */
  readonly id?: string;
  /**
   * The ownership labels the object carries: `io.codeboost.runner`, `io.codeboost.attempt` and
   * `io.codeboost.allocation`, plus its kind's own label (`io.codeboost.invocation` or `io.codeboost.egress`).
   * Absent for host directories.
   */
  readonly labels?: Readonly<Record<string, string>>;
}
export interface InvocationResult {
  readonly attemptId: string;
  readonly context: InvocationContext;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stopReason?: StopReason;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Present only when cleanup was still failing when D's bounded retry window ended (`CLEANUP_RETRY_WINDOW_MS`,
   * 60 s after the first failure). Retries after the first are limited to what is left of the window, and every
   * cleanup subprocess is killed at its deadline, so settlement ends within about 90 s of cleanup starting: at most
   * 30 s for the first, failed attempt, then the 60 s window, which no retry outlasts. These resources
   * may still exist, and the agent container may still be running. `stopReason` is always set. The caller must
   * record them durably and keep them owned until their removal is confirmed.
   */
  readonly unreleased?: readonly UnreleasedResource[];
}
/**
 * F owns persisted pending/stale and admission; D owns running invocations.
 * cancel() records the first reason and requests termination, never settlement.
 * settled resolves only after the container AND capture processes terminate, or, when cleanup keeps failing, once
 * D's bounded cleanup retries end with `unreleased` set.
 * completed/failed/cancelled records are published by F using attemptId + context
 * CAS; discarded stale output still must settle before releasing D's slot.
 * Closing rejects admission before draining requests, cancelling, and awaiting
 * settlement. No retry may replace an active invocation, even after lease expiry.
 */
/**
 * Start calls (`startClaudeInvocation`, `startCodexInvocation`, `startProfileInvocation`) return a handle at once and
 * run Docker setup inside it: they throw only when they allocated nothing, and every later failure settles the handle.
 */
export interface InvocationHandle {
  readonly attemptId: string;
  readonly settled: Promise<InvocationResult>;
  cancel(reason: StopReason): void;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const capturedInvocations = new WeakSet<InvocationInput>();
// One capture per attempt: an existing request cannot be re-captured with an upgraded phase, deadline or allowlist.
const capturedAttempts = new Set<string>();

/** Authenticate a request produced by captureInvocation, so a copied or edited request cannot pass. */
export function assertCapturedInvocation(input: InvocationInput): void {
  if (!capturedInvocations.has(input)) throw new Error('Invocation was not captured by the trusted capture boundary.');
}

/** Capture a deep immutable request so caller edits cannot change an active run. */
export function captureInvocation(input: InvocationInput, now = Date.now()): InvocationInput {
  if (!input || !input.clone || !input.context) throw new Error('Missing invocation context.');
  if (!['planning', 'questions', 'review', 'execute', 'fix'].includes(input.phase)
    || !['claude', 'codex'].includes(input.vendor)) throw new Error('Unsupported invocation profile.');
  if (!isRunnerOwner(input.runnerOwner)) throw new Error('runnerOwner must be 32 lowercase hex characters.');
  if (!nonempty(input.attemptId) || !nonempty(input.clone.id) || !nonempty(input.clone.taskId)
    || !nonempty(input.clone.directory) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.clone.head))
    throw new Error('Invalid task clone or attempt identity.');
  // Checked here, not first inside setup: every Docker object is labelled with it, and invalid input must throw.
  if (!isLabelAttemptId(input.attemptId)) throw new Error('attemptId cannot be written as an ownership label.');
  if (!Number.isFinite(now) || !Number.isSafeInteger(input.deadline) || input.deadline <= now)
    throw new Error('Invocation requires a finite future deadline.');
  const context = input.context;
  if (![context.snapshotId, context.planId, context.assignmentId, context.referencedCodeHash].every(nonempty)
    || !integer(context.planRevision) || !integer(context.stateVersion)) throw new Error('Invalid captured context.');
  if (!Array.isArray(input.approvedArgv) || Array.from(input.approvedArgv).some(argv => !Array.isArray(argv)
    || argv.length === 0 || !nonempty(argv[0]) || Array.from(argv).some(arg => typeof arg !== 'string' || arg.includes('\0'))))
    throw new Error('Commands must be complete literal argv arrays.');
  if (['planning', 'questions'].includes(input.phase) && input.approvedArgv.length)
    throw new Error('Read-only authoring and questions cannot execute commands.');
  if (capturedAttempts.has(input.attemptId))
    throw new Error('Attempt was already captured; a new invocation requires a new attempt identity.');
  const captured = Object.freeze({ ...input, clone: Object.freeze({ ...input.clone }), context: Object.freeze({ ...context }),
    approvedArgv: Object.freeze(input.approvedArgv.map(argv => Object.freeze([...argv]))) });
  capturedInvocations.add(captured);
  capturedAttempts.add(captured.attemptId);
  return captured;
}

/** Dispatcher predicate, not a sandbox. An adapter must enforce this externally. */
export function permitsCommand(input: InvocationInput, argv: readonly string[]): boolean {
  return !['planning', 'questions'].includes(input.phase) && input.approvedArgv.some(approved =>
    approved.length === argv.length && approved.every((arg, index) => arg === argv[index]));
}

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
  readonly context: InvocationContext;
}
export type StopReason = 'cancelled' | 'timeout' | 'shutdown' | 'output-limit' | 'capture-failure';
export interface InvocationResult {
  readonly attemptId: string;
  readonly context: InvocationContext;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stopReason?: StopReason;
  readonly stdout: string;
  readonly stderr: string;
}
/**
 * F owns persisted pending/stale and admission; D owns running invocations.
 * cancel() records the first reason and requests termination, never settlement.
 * settled resolves only after the container AND capture processes terminate.
 * completed/failed/cancelled records are published by F using attemptId + context
 * CAS; discarded stale output still must settle before releasing D's slot.
 * Closing rejects admission before draining requests, cancelling, and awaiting
 * settlement. No retry may replace an active invocation, even after lease expiry.
 */
export interface InvocationHandle {
  readonly attemptId: string;
  readonly settled: Promise<InvocationResult>;
  cancel(reason: StopReason): void;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Capture a deep immutable request so caller edits cannot change an active run. */
export function captureInvocation(input: InvocationInput, now = Date.now()): InvocationInput {
  if (!input || !input.clone || !input.context) throw new Error('Missing invocation context.');
  if (!['planning', 'questions', 'review', 'execute', 'fix'].includes(input.phase)
    || !['claude', 'codex'].includes(input.vendor)) throw new Error('Unsupported invocation profile.');
  if (!nonempty(input.attemptId) || !nonempty(input.clone.id) || !nonempty(input.clone.taskId)
    || !nonempty(input.clone.directory) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.clone.head))
    throw new Error('Invalid task clone or attempt identity.');
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
  return Object.freeze({ ...input, clone: Object.freeze({ ...input.clone }), context: Object.freeze({ ...context }),
    approvedArgv: Object.freeze(input.approvedArgv.map(argv => Object.freeze([...argv]))) });
}

/** Dispatcher predicate, not a sandbox. An adapter must enforce this externally. */
export function permitsCommand(input: InvocationInput, argv: readonly string[]): boolean {
  return !['planning', 'questions'].includes(input.phase) && input.approvedArgv.some(approved =>
    approved.length === argv.length && approved.every((arg, index) => arg === argv[index]));
}

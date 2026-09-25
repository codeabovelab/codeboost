import type { InvocationInput } from '../contract.ts';
import type { TaskFilesystems } from '../container/storage.ts';
import type { CaptureLimits } from './supervisor.ts';

export interface AgentAdapterRequest {
  readonly invocation: InvocationInput;
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly imageId: string;
  readonly prompt: string;
}
export interface AgentAdapterOptions {
  readonly timeoutMs?: number;
  readonly limits?: Partial<CaptureLimits>;
}
const MAXIMUM_INVOCATION_MS = 10 * 60_000;

/** Convert an absolute wall-clock deadline once, then enforce it with a monotonic clock. */
export function createInvocationBudget(invocation: InvocationInput, maximumMs: number): () => number {
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1)
    throw new Error('Invocation setup budget must be a positive integer.');
  const wallRemaining = invocation.deadline - Date.now();
  if (!Number.isSafeInteger(wallRemaining) || wallRemaining < 1)
    throw new Error('Invocation deadline expired during adapter setup.');
  const duration = Math.min(maximumMs, wallRemaining);
  const end = performance.now() + duration;
  return () => {
    const value = Math.ceil(end - performance.now());
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invocation deadline expired during adapter setup.');
    return value;
  };
}

export function createAdapterInvocationBudget(invocation: InvocationInput,
  timeoutMs = MAXIMUM_INVOCATION_MS): () => number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('timeoutMs must be a positive integer.');
  if (timeoutMs > MAXIMUM_INVOCATION_MS)
    throw new Error('timeoutMs cannot exceed the production ten-minute ceiling.');
  return createInvocationBudget(invocation, timeoutMs);
}

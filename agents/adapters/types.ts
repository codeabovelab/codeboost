import type { InvocationInput } from '../contract.ts';
import type { TaskFilesystems } from '../container/storage.ts';
import type { TaskTreeCheck } from '../container/changes.ts';
import { assertBuiltAgentImage } from '../container/image.ts';
import { assertResourceOwner } from '../labels.ts';
import type { CaptureLimits } from './supervisor.ts';

export interface AgentAdapterRequest {
  readonly invocation: InvocationInput;
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly imageId: string;
  readonly prompt: string;
  /**
   * The caller-chosen allocation ID (a lowercase UUID v4) for the vendor network and proxy, recorded before the start
   * call so recovery can match them to the attempt (#51 item 3).
   */
  readonly networkAllocationId: string;
  /** Execute and fix only, and required there: `checkTaskTree`'s result for `filesystems`, made just before this start. */
  readonly treeCheck?: TaskTreeCheck;
}
/** Check a start call's synchronous input, so invalid input throws before a handle exists. */
export function assertAdapterRequest(request: AgentAdapterRequest): void {
  assertBuiltAgentImage(request.imageId);
  assertResourceOwner({ runnerOwner: request.invocation.runnerOwner, attemptId: request.invocation.attemptId,
    allocationId: request.networkAllocationId });
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

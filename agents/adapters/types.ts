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

/**
 * A remote read that ran out of its own time. Nothing it started was applied, so a caller may try again: unlike a
 * refusal, a timeout is never a definite answer to record (#48).
 */
export class RemoteTimeout extends Error {
  override readonly name = 'RemoteTimeout';
}

/** Whether `error`, or an error it was caused by, is a RemoteTimeout: wrappers such as an upstream failure keep it. */
export function timedOut(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++)
    if (current instanceof RemoteTimeout) return true;
  return false;
}

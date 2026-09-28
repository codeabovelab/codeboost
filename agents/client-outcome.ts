/** A full Docker object ID. Every ownership check compares against this form, never against a reusable name. */
export const DOCKER_ID = /^[0-9a-f]{64}$/;

/** Spawn errors: the Docker client process never started, so it cannot have sent any request to the daemon. */
// `ENOTSTARTED` is agents/docker.ts's code for a call it refused before spawning (already cancelled, bad deadline).
const NOT_STARTED = new Set(['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'E2BIG', 'ENOEXEC',
  'ENOTSTARTED']);

/**
 * Whether a failed Docker create may still have reached the daemon, so the object may exist. A numeric exit status
 * means the daemon answered (and refused); a client that never started sent nothing. Anything else, such as a client
 * killed at its deadline, leaves the outcome unknown.
 */
export function createOutcomeUnknown(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
  if (typeof value?.status === 'number') return false;
  const code = typeof value?.code === 'string' ? value.code : value?.cause?.code;
  return !(typeof code === 'string' && NOT_STARTED.has(code));
}

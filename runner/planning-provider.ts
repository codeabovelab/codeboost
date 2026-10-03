import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { InvocationContext, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { allocations, RetainedStorage, stopOf, type ContainerDependencies, type LeftoverPolicy, type Provider } from './question-container.ts';

/** Ask's lane D dependencies, less startup recovery, which the runner owns for planning. */
export type PlanningDependencies = Omit<ContainerDependencies, 'recover'>;

/** What the runner knows about the checkout a plan is written against. */
export interface PlanningProviderOptions {
  /** The vendor chosen in Settings. Only Claude can plan; Codex is refused before any work. */
  readonly vendor: Provider;
  /** Host checkout to clone. The agent sees a read-only copy of `head`, never this directory. */
  readonly repository: string;
  /** The committed head the plan's snapshot was taken from. */
  readonly head: string;
  readonly snapshotId: string;
  /** Written as `io.codeboost.runner` on every Docker object an invocation creates. */
  readonly runnerOwner: string;
  /** Whole-invocation budget, setup included. Lane D caps the invocation itself at ten minutes. */
  readonly timeoutMs?: number;
  readonly deps: PlanningDependencies;
  /** Shared across providers in one process, so the image is built once. */
  readonly image?: { id?: string };
  /** What earlier requests left behind. Invocations stay refused while any of it remains. */
  readonly retained?: PlanningStorage;
}

/**
 * Planning's leftovers: lane D allocations, allocations lane D returned no handle for, and host copies of the planned
 * code. Use one instance for planning and never share it with Ask, so a planning failure never turns Ask off.
 */
export const PLANNING_LEFTOVERS: LeftoverPolicy = Object.freeze({
  removePath: removePlanningRoot,
  paths: (paths: readonly string[]) => `A copy of the planned code from an earlier request could not be deleted (${paths.join(', ')}). Planning stays off until it is deleted.`,
  untracked: () => 'A planning agent\'s setup or cleanup failed and was not confirmed, so codeboost cannot tell which Docker resources were left. Planning is off until codeboost restarts.',
  retained: (count: number) => `Planning storage from an earlier request could not be removed (${allocations(count)}). Planning stays off until Docker removes it. Check that Docker is running, then retry.`,
});
/** Planning's own leftovers. Typed apart from Ask's, so an instance with Ask's wording and removal cannot be passed in. */
export class PlanningStorage extends RetainedStorage {
  readonly feature = 'planning';
  constructor() { super(PLANNING_LEFTOVERS); }
}

const ROOT_PREFIX = 'codeboost-planning-';
/**
 * Delete a planning root: a direct child of the temporary directory named with planning's prefix, and nothing else.
 * Its input directory is made writable first, since the request left it read-only.
 */
export function removePlanningRoot(root: string): void {
  if (dirname(root) !== tmpdir() || !basename(root).startsWith(ROOT_PREFIX))
    throw new Error(`Refusing to remove a path that is not a planning root (${root}).`);
  try { chmodSync(join(root, 'input'), 0o700); } catch { /* never created, or already removed */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// Planning reads the code; it needs no room to write. The same ceilings as Ask.
export const PLANNING_STORAGE: TaskStorageLimits = Object.freeze({
  workBytes: 512 * 1024 * 1024, workInodes: 131_072, metadataBytes: 512 * 1024 * 1024, metadataInodes: 131_072,
});
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Codex reads files only through its shell, and planning runs no process, so Codex cannot plan (#75, #93). */
export const CODEX_PLANNING_REFUSED = 'Codex cannot write plans yet: it can read the code only by running commands, '
  + 'and planning runs none. Choose Claude Code in Settings, then retry.';

export function planningCredential(vendor: Provider, env: PlanningDependencies['env']): string {
  if (vendor === 'codex') throw new Error(CODEX_PLANNING_REFUSED);
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error('Planning with Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`.');
  return token;
}

const stopMessages: Record<StopReason, string> = {
  cancelled: 'Planning agent cancelled.', timeout: 'Planning agent timed out.', shutdown: 'Server stopped during planning.',
  'output-limit': 'Planning agent output exceeded its limit.', 'capture-failure': 'Planning agent output could not be captured.',
};
const sameContext = (left: InvocationContext, right: InvocationContext) =>
  (Object.keys(right) as (keyof InvocationContext)[]).every(key => left[key] === right[key])
  && Object.keys(left).length === Object.keys(right).length;
/** Accept only this exact invocation's output, and only after a clean exit. The text is still unvalidated. */
export function planningOutput(result: InvocationResult, invocation: InvocationInput): string {
  if (result.attemptId !== invocation.attemptId || !result.context || !sameContext(result.context, invocation.context))
    throw new Error('The planning agent returned a result for a different attempt.');
  if (result.stopReason) throw new Error(stopMessages[result.stopReason]);
  if (result.exitCode === null || result.signal !== null)
    throw new Error(`Claude stopped unexpectedly${result.signal ? ` (${result.signal})` : ''}.`);
  if (result.exitCode !== 0) {
    const detail = result.stdout.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`Claude could not write the plan. Check its sign-in and usage limits.${detail ? ` Claude said: ${detail}` : ''}`);
  }
  return result.stdout;
}

/**
 * E2's provider over lane D: each request runs in a fresh container on a read-only copy of `head`, in the "planning"
 * phase (read, list and search only; no commands) with vendor-only egress. The request's schema is the only file in
 * the input mount; D passes it to Claude as `--json-schema` and returns Claude's `structured_output` as JSON text. That
 * text is still unvalidated; E2's `validate` decides whether it is a plan. Codex is refused before any work.
 *
 * Lane D's image build, clone and storage allocation are synchronous Docker and Git calls. A serving process must run
 * this provider off its request thread, as Ask does in its worker.
 */
export interface PlanningProvider extends AuthorProvider {
  invoke(request: AuthorRequest, signal: AbortSignal): Promise<string>;
}
export function createPlanningProvider(options: PlanningProviderOptions): PlanningProvider {
  const { vendor, deps } = options, image = options.image ?? {}, retained = options.retained ?? new PlanningStorage();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Planning timeout must be a positive integer.');
  return { async invoke(request: AuthorRequest, signal: AbortSignal): Promise<string> {
    if (request.phase !== 'planning' || request.access !== 'read-only') throw new Error('Planning requests must be read-only.');
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      signal.throwIfAborted();
      const value = deadline - Date.now();
      if (value < 1) throw new Error(stopMessages.timeout);
      return value;
    };
    signal.throwIfAborted();
    const credential = planningCredential(vendor, deps.env);
    retained.release(deps.removeFilesystems);
    image.id ??= deps.buildImage(remaining());
    const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
    const staging = join(root, 'staging'), input = join(root, 'input');
    let filesystems: TaskFilesystems | undefined, failure: { error: unknown } | undefined;
    try {
      mkdirSync(staging); mkdirSync(input);
      writeFileSync(join(input, 'schema.json'), request.schemaText, { mode: 0o444 });
      chmodSync(input, 0o555);
      // The clone is a full host copy with no byte limit of its own, so the repository must fit before it is made.
      const size = deps.measureRepository(options.repository, options.head, Math.min(60_000, remaining()));
      if (size.checkoutBytes > PLANNING_STORAGE.workBytes || size.entries > PLANNING_STORAGE.workInodes
        || size.objectBytes > PLANNING_STORAGE.metadataBytes)
        throw new Error('The repository is too large for planning.');
      const clone = deps.createClone({ source: options.repository, parent: staging, taskId: `planning-${request.requestId}`,
        head: options.head, timeoutMs: Math.min(120_000, remaining()) });
      const owner = { runnerOwner: options.runnerOwner, attemptId: request.requestId, allocationId: randomUUID() };
      try { filesystems = deps.prepareFilesystems(clone, PLANNING_STORAGE, image.id, owner, Math.min(60_000, remaining())); }
      catch (error) {
        // D throws an AggregateError only when a failed allocation's own cleanup did not settle; it returns no handle.
        if (error instanceof AggregateError) retained.markUntracked();
        throw error;
      }
      remaining();
      const invocation = deps.capture({ clone, phase: 'planning', vendor: 'claude', approvedArgv: [], deadline,
        attemptId: request.requestId, runnerOwner: options.runnerOwner,
        context: { snapshotId: options.snapshotId, planId: request.identity.planId, planRevision: request.revision,
          assignmentId: `${request.mode}-${request.issue}`, referencedCodeHash: options.head, stateVersion: 0 } });
      const adapterRequest = { invocation, filesystems, inputDirectory: input, imageId: image.id, prompt: request.prompt,
        networkAllocationId: randomUUID() };
      const handle = deps.startClaude(adapterRequest, credential);
      const cancel = () => handle.cancel(stopOf(signal.reason));
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      let result: InvocationResult;
      try { result = await handle.settled; }
      finally { signal.removeEventListener('abort', cancel); }
      // D stopped before confirming cleanup; the resources are found again by their labels after a restart.
      if (result.unreleased !== undefined) retained.markUntracked();
      return planningOutput(result, invocation);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      const failures: unknown[] = [];
      if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { retained.retain(filesystems); failures.push(error); }
      try { removePlanningRoot(root); }
      catch (error) {
        retained.retainPath(root);
        failures.push(new Error(`A copy of the planned code could not be deleted (${root}).`, { cause: error }));
      }
      // What cleanup left is retained above, and the next request names it. A successful request is refused rather than
      // returned, as Ask does, so a plan is never kept from an unsettled run. A failed one keeps its own message first.
      if (failures.length) {
        const text = (error: unknown) => error instanceof Error ? error.message : String(error);
        throw failure
          ? new AggregateError([failure.error, ...failures], `${text(failure.error)} Cleanup also did not settle: ${failures.map(text).join('; ')}`)
          : new AggregateError(failures, 'Planning container cleanup did not settle.');
      }
    }
  } };
}

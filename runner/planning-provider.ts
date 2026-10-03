import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { RetainedStorage, stopOf, type ContainerDependencies, type Provider } from './question-container.ts';

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
  /** What earlier requests left behind. Invocations stay refused while any of it remains. Never shared with Ask. */
  readonly retained?: PlanningLeftovers;
}

/**
 * Planning's own record of what Docker or the host did not confirm removed: lane D allocations, allocations lane D
 * returned no handle for, and host copies of the planned code. Kept apart from Ask's, so a planning failure never turns
 * Ask off, and its refusals name planning.
 */
export class PlanningLeftovers {
  readonly storage = new RetainedStorage();
  readonly #roots = new Set<string>();
  /** A host directory holding a copy of the planned code that could not be deleted. */
  retainRoot(root: string) { this.#roots.add(root); }
  roots(): string[] { return [...this.#roots]; }
  /** Retry every removal. Throws while anything is still unconfirmed. */
  release(remove: PlanningDependencies['removeFilesystems']): void {
    for (const root of [...this.#roots]) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); this.#roots.delete(root); }
      catch { /* still on disk; retried next time */ }
    }
    // RetainedStorage words its refusals for Ask; planning words its own below from the same counts.
    try { this.storage.release(remove); } catch { /* reported below */ }
    if (this.#roots.size) throw new Error(`A copy of the planned code from an earlier request could not be deleted (${[...this.#roots].join(', ')}). Planning stays off until it is deleted.`);
    if (this.storage.untracked) throw new Error('A planning agent\'s setup or cleanup failed and was not confirmed, so codeboost cannot tell which Docker resources were left. Planning is off until codeboost restarts.');
    if (this.storage.size) throw new Error(`Planning storage from an earlier request could not be removed (${this.storage.size} allocation${this.storage.size === 1 ? '' : 's'}). Planning stays off until Docker removes it. Check that Docker is running, then retry.`);
  }
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
  const { vendor, deps } = options, image = options.image ?? {}, retained = options.retained ?? new PlanningLeftovers();
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
    const root = mkdtempSync(join(tmpdir(), 'codeboost-planning-'));
    const staging = join(root, 'staging'), input = join(root, 'input');
    let filesystems: TaskFilesystems | undefined;
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
        if (error instanceof AggregateError) retained.storage.markUntracked();
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
      if (result.unreleased !== undefined) retained.storage.markUntracked();
      return planningOutput(result, invocation);
    } finally {
      const failures: unknown[] = [];
      if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { retained.storage.retain(filesystems); failures.push(error); }
      try { chmodSync(input, 0o700); } catch { /* input was never created */ }
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch (error) {
        retained.retainRoot(root);
        failures.push(new Error(`A copy of the planned code could not be deleted (${root}).`, { cause: error }));
      }
      if (failures.length) throw new AggregateError(failures, 'Planning container cleanup did not settle.');
    }
  } };
}

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext, InvocationHandle, InvocationInput, InvocationResult, StopReason, TaskClone } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';
import type { Leftover } from './question-leftovers.ts';

export type Provider = 'claude' | 'codex';
/** What the review knows about a question when it asks the agent. */
export interface QuestionScope {
  readonly repository: string;
  readonly head: string;
  readonly snapshotId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly noteId: string;
  /** The persisted answer attempt. The invocation reuses it, so completion can be compared with the stored attempt. */
  readonly attemptId: string;
  /** Hash of the code assigned to the note's plan item (the review's `contextId`). */
  readonly contextId: string;
}
export interface ContainerQuestion extends QuestionScope {
  readonly provider: Provider;
  readonly prompt: string;
  readonly deadline: number;
}
/**
 * Task storage whose removal Docker did not confirm. The only handle to a D allocation must not be dropped:
 * it is kept here, removal is retried before the next question, and Ask stays off while any remain.
 */
export class RetainedStorage {
  readonly #retained = new Set<TaskFilesystems>();
  #untracked = 0;
  get size() { return this.#retained.size; }
  /** Allocations whose setup failed and whose cleanup D could not confirm. D returns no handle for them. */
  get untracked() { return this.#untracked; }
  retain(filesystems: TaskFilesystems) { this.#retained.add(filesystems); }
  markUntracked() { this.#untracked++; }
  /** Docker names of the retained allocations, for a durable record before this registry is dropped. */
  list(): Leftover[] {
    return [...this.#retained].map(({ keeper, workVolume, metadataVolume }) => ({ keeper, workVolume, metadataVolume }));
  }
  /** Retry removal of every retained allocation. Throws while any removal is still unconfirmed. */
  release(remove: (filesystems: TaskFilesystems) => void): void {
    for (const filesystems of [...this.#retained]) {
      try { remove(filesystems); this.#retained.delete(filesystems); } catch { /* still owned; retried next time */ }
    }
    if (this.#untracked) throw new Error(`Agent storage setup failed and its cleanup was not confirmed, so codeboost cannot tell which Docker resources were left. Ask is off until codeboost restarts and no \`io.codeboost.task-storage\` containers or volumes remain.`);
    if (this.#retained.size) throw new Error(`Agent storage from an earlier question could not be removed (${this.#retained.size} allocation${this.#retained.size === 1 ? '' : 's'}). Ask stays off until Docker removes it. Check that Docker is running, then retry.`);
  }
}
/** Lane D entry points. Injected so the orchestration can be tested without Docker. */
export interface ContainerDependencies {
  buildImage(timeoutMs: number): string;
  createClone(options: { source: string; parent: string; taskId: string; head: string; timeoutMs: number }): TaskClone;
  prepareFilesystems(clone: TaskClone, limits: TaskStorageLimits, imageId: string, timeoutMs: number): TaskFilesystems;
  removeFilesystems(filesystems: TaskFilesystems): void;
  capture(input: InvocationInput): InvocationInput;
  startClaude(request: AgentAdapterRequest, token: string): InvocationHandle;
  startCodex(request: AgentAdapterRequest, authFile: string): InvocationHandle;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// Questions need the code to read, not room to write. tmpfs volumes only use memory for bytes actually stored.
export const QUESTION_STORAGE: TaskStorageLimits = Object.freeze({
  workBytes: 512 * 1024 * 1024, workInodes: 131_072, metadataBytes: 512 * 1024 * 1024, metadataInodes: 131_072,
});
// The profile requires exactly one read-only schema.json in the input mount. Answers are plain text.
const ANSWER_SCHEMA = '{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"codeboost question answer","type":"string"}\n';

export function questionCredential(provider: Provider, env: ContainerDependencies['env']): string {
  if (provider === 'claude') {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('Ask with Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`, set it, and restart codeboost.');
    return token;
  }
  const authFile = env.CODEBOOST_CODEX_AUTH_FILE || join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json');
  if (!existsSync(authFile)) throw new Error(`Ask with Codex needs its auth.json (looked for ${authFile}). Sign in with \`codex login\` or set CODEBOOST_CODEX_AUTH_FILE, then restart codeboost.`);
  return authFile;
}

const stopMessages: Record<StopReason, string> = {
  cancelled: 'Agent cancelled.', timeout: 'Agent timed out. Try again.', shutdown: 'Server stopped. Retry the question.',
  'output-limit': 'Agent output exceeded its limit.', 'capture-failure': 'The agent container failed. Try again.',
};
const sameContext = (left: InvocationContext, right: InvocationContext) =>
  (Object.keys(right) as (keyof InvocationContext)[]).every(key => left[key] === right[key])
  && Object.keys(left).length === Object.keys(right).length;
/** Accept only the result of this exact invocation, and only a clean exit. */
export function answerFromResult(provider: Provider, result: InvocationResult, invocation: InvocationInput): string {
  if (result.attemptId !== invocation.attemptId || !result.context || !sameContext(result.context, invocation.context))
    throw new Error('The agent returned a result for a different question attempt.');
  if (result.stopReason) throw new Error(stopMessages[result.stopReason]);
  const name = provider === 'claude' ? 'Claude' : 'Codex';
  if (result.exitCode === null || result.signal !== null)
    throw new Error(`${name} stopped unexpectedly${result.signal ? ` (${result.signal})` : ''}. Try again.`);
  if (result.exitCode !== 0) {
    const detail = result.stdout.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`${name} could not answer. Check its sign-in and usage limits.${detail ? ` ${name} said: ${detail}` : ''}`);
  }
  return result.stdout;
}

/**
 * Answer one question inside the lane D container: a read-only `/work` checkout of the reviewed head,
 * the "questions" phase (read, list and search only; no commands), and vendor-only network access.
 * Every step is bounded by `deadline`. Storage is released only after the invocation settles.
 */
export async function askInContainer(question: ContainerQuestion, deps: ContainerDependencies,
  signal: AbortSignal, image: { id?: string } = {}, retained = new RetainedStorage()): Promise<string> {
  const remaining = () => {
    signal.throwIfAborted();
    const value = question.deadline - Date.now();
    if (value < 1) throw new Error('Agent timed out. Try again.');
    return value;
  };
  const credential = questionCredential(question.provider, deps.env);
  retained.release(deps.removeFilesystems);
  image.id ??= deps.buildImage(remaining());
  const root = mkdtempSync(join(tmpdir(), 'codeboost-question-'));
  const staging = join(root, 'staging'), input = join(root, 'input');
  let filesystems: TaskFilesystems | undefined;
  try {
    mkdirSync(staging); mkdirSync(input);
    writeFileSync(join(input, 'schema.json'), ANSWER_SCHEMA, { mode: 0o444 });
    chmodSync(input, 0o555);
    const clone = deps.createClone({ source: question.repository, parent: staging, taskId: `question-${question.noteId}`,
      head: question.head, timeoutMs: Math.min(120_000, remaining()) });
    try { filesystems = deps.prepareFilesystems(clone, QUESTION_STORAGE, image.id, Math.min(60_000, remaining())); }
    catch (error) {
      // D throws an AggregateError only when a failed allocation's own cleanup did not settle; it returns no handle.
      if (error instanceof AggregateError) retained.markUntracked();
      throw error;
    }
    remaining();
    const invocation = deps.capture({ clone, phase: 'questions', vendor: question.provider, approvedArgv: [],
      deadline: question.deadline, attemptId: question.attemptId,
      context: { snapshotId: question.snapshotId, planId: question.planId, planRevision: question.planRevision,
        assignmentId: question.noteId, referencedCodeHash: question.contextId,
        stateVersion: 0 } });
    const request = { invocation, filesystems, inputDirectory: input, imageId: image.id, prompt: question.prompt };
    const handle = question.provider === 'claude' ? deps.startClaude(request, credential) : deps.startCodex(request, credential);
    const cancel = () => handle.cancel(signal.reason instanceof Error && /timed out/.test(signal.reason.message) ? 'timeout'
      : signal.reason instanceof Error && /Server stopped/.test(signal.reason.message) ? 'shutdown' : 'cancelled');
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    try { return answerFromResult(question.provider, await handle.settled, invocation); }
    finally { signal.removeEventListener('abort', cancel); }
  } finally {
    const failures: unknown[] = [];
    if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { retained.retain(filesystems); failures.push(error); }
    try { chmodSync(input, 0o700); } catch { /* not created */ }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Question container cleanup did not settle.');
  }
}

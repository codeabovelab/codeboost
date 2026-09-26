import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason, TaskClone } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';

export type Provider = 'claude' | 'codex';
/** What the review knows about a question when it asks the agent. */
export interface QuestionScope {
  readonly repository: string;
  readonly head: string;
  readonly snapshotId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly noteId: string;
}
export interface ContainerQuestion extends QuestionScope {
  readonly provider: Provider;
  readonly prompt: string;
  readonly attemptId: string;
  readonly deadline: number;
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
export function answerFromResult(provider: Provider, result: InvocationResult): string {
  if (result.stopReason) throw new Error(stopMessages[result.stopReason]);
  const name = provider === 'claude' ? 'Claude' : 'Codex';
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
  signal: AbortSignal, image: { id?: string } = {}): Promise<string> {
  const remaining = () => {
    signal.throwIfAborted();
    const value = question.deadline - Date.now();
    if (value < 1) throw new Error('Agent timed out. Try again.');
    return value;
  };
  const credential = questionCredential(question.provider, deps.env);
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
    filesystems = deps.prepareFilesystems(clone, QUESTION_STORAGE, image.id, Math.min(60_000, remaining()));
    remaining();
    const invocation = deps.capture({ clone, phase: 'questions', vendor: question.provider, approvedArgv: [],
      deadline: question.deadline, attemptId: question.attemptId,
      context: { snapshotId: question.snapshotId, planId: question.planId, planRevision: question.planRevision,
        assignmentId: question.noteId, referencedCodeHash: createHash('sha256').update(question.prompt).digest('hex'),
        stateVersion: 0 } });
    const request = { invocation, filesystems, inputDirectory: input, imageId: image.id, prompt: question.prompt };
    const handle = question.provider === 'claude' ? deps.startClaude(request, credential) : deps.startCodex(request, credential);
    const cancel = () => handle.cancel(signal.reason instanceof Error && /timed out/.test(signal.reason.message) ? 'timeout'
      : signal.reason instanceof Error && /Server stopped/.test(signal.reason.message) ? 'shutdown' : 'cancelled');
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    try { return answerFromResult(question.provider, await handle.settled); }
    finally { signal.removeEventListener('abort', cancel); }
  } finally {
    const failures: unknown[] = [];
    if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { failures.push(error); }
    try { chmodSync(input, 0o700); } catch { /* not created */ }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Question container cleanup did not settle.');
  }
}

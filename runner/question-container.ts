import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext, InvocationHandle, InvocationInput, InvocationResult, StopReason, TaskClone } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';
import { removeStaging, type Leftover } from './question-leftovers.ts';

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
  readonly #paths = new Set<string>();
  #untracked = 0;
  get size() { return this.#retained.size; }
  /** Allocations whose setup failed and whose cleanup D could not confirm. D returns no handle for them. */
  get untracked() { return this.#untracked; }
  retain(filesystems: TaskFilesystems) { this.#retained.add(filesystems); }
  markUntracked() { this.#untracked++; }
  /** A host staging directory (a copy of the reviewed code) that could not be deleted. */
  retainPath(path: string) { this.#paths.add(path); }
  paths(): string[] { return [...this.#paths]; }
  /** Docker names of the retained allocations, for a durable record before this registry is dropped. */
  list(): Leftover[] {
    return [...this.#retained].map(({ keeper, workVolume, metadataVolume }) => ({ keeper, workVolume, metadataVolume }));
  }
  /** Retry removal of every retained allocation. Throws while any removal is still unconfirmed. */
  release(remove: (filesystems: TaskFilesystems) => void): void {
    for (const path of [...this.#paths]) {
      try { removeStaging(path); this.#paths.delete(path); } catch { /* still owned; retried next time */ }
    }
    for (const filesystems of [...this.#retained]) {
      try { remove(filesystems); this.#retained.delete(filesystems); } catch { /* still owned; retried next time */ }
    }
    if (this.#paths.size) throw new Error(`A copy of reviewed code from an earlier question could not be deleted (${[...this.#paths].join(', ')}). Ask stays off until it is deleted.`);
    if (this.#untracked) throw new Error(`Agent storage setup failed and its cleanup was not confirmed, so codeboost cannot tell which Docker resources were left. Ask is off until codeboost restarts and no \`io.codeboost.task-storage\` containers or volumes remain.`);
    if (this.#retained.size) throw new Error(`Agent storage from an earlier question could not be removed (${this.#retained.size} allocation${this.#retained.size === 1 ? '' : 's'}). Ask stays off until Docker removes it. Check that Docker is running, then retry.`);
  }
}
export interface RepositorySize { readonly checkoutBytes: number; readonly entries: number; readonly objectBytes: number }
// The same hardening as lane D's clone: no user or system config, no prompts, no lazy fetch from a promisor remote.
const GIT_ENV = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' });
// A tree listing larger than this is itself too large to review; refuse rather than read it.
const TREE_LISTING_LIMIT = 64 * 1024 * 1024;
/** Read-only size measurement with Git's own plumbing: tree entries and blob sizes at `head`, plus object storage. */
export function measureGitRepository(source: string, head: string, timeoutMs: number): RepositorySize {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Invalid reviewed head.');
  const git = (args: string[]) => {
    const result = spawnSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false', '-C', source, ...args], { env: GIT_ENV(), timeout: timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: TREE_LISTING_LIMIT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error('The repository is too large to review, or Git could not measure it.');
    return result.stdout;
  };
  let checkoutBytes = 0, entries = 0;
  for (const line of git(['ls-tree', '-r', '-t', '-l', '--full-tree', head]).split('\n')) {
    if (!line) continue;
    entries++;
    const size = Number(line.split(/\s+/)[3]);
    if (Number.isSafeInteger(size)) checkoutBytes += size;
  }
  let objectBytes = 0;
  for (const line of git(['count-objects', '-v']).split('\n')) {
    const [key, value] = line.split(':').map(part => part.trim());
    if ((key === 'size' || key === 'size-pack' || key === 'size-garbage') && Number.isSafeInteger(Number(value))) objectBytes += Number(value) * 1024;
  }
  return { checkoutBytes, entries, objectBytes };
}
/** Refuse a repository whose staging copy would exceed the question's storage, before any host copy is made. */
export function assertFitsQuestionStorage(size: RepositorySize): void {
  if (size.checkoutBytes > QUESTION_STORAGE.workBytes || size.entries > QUESTION_STORAGE.workInodes
    || size.objectBytes > QUESTION_STORAGE.metadataBytes)
    throw new Error(`The repository is too large for Ask (checkout ${Math.ceil(size.checkoutBytes / 1048576)} MiB in ${size.entries} entries, Git objects ${Math.ceil(size.objectBytes / 1048576)} MiB; the limit is ${QUESTION_STORAGE.workBytes / 1048576} MiB and ${QUESTION_STORAGE.workInodes} entries).`);
}

/** Lane D entry points. Injected so the orchestration can be tested without Docker. */
export interface ContainerDependencies {
  buildImage(timeoutMs: number): string;
  createClone(options: { source: string; parent: string; taskId: string; head: string; timeoutMs: number }): TaskClone;
  prepareFilesystems(clone: TaskClone, limits: TaskStorageLimits, imageId: string, timeoutMs: number): TaskFilesystems;
  removeFilesystems(filesystems: TaskFilesystems): void;
  /** Size of the checkout at `head` and of the object store, measured before anything is copied to the host. */
  measureRepository(source: string, head: string, timeoutMs: number): RepositorySize;
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

/** The only variables the credential lookup reads. They reach the worker as data, never as its environment. */
export const CREDENTIAL_VARIABLES = ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEBOOST_CODEX_AUTH_FILE', 'CODEX_HOME', 'HOME'] as const;
export function credentialEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(CREDENTIAL_VARIABLES.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}
/**
 * The worker's entire environment, an allowlist: what Docker and Git need to run (the same PATH and DOCKER_HOST
 * lane D gives Docker) and the Ask root as TMPDIR. Every setup subprocess, including the image build, inherits only
 * this, so no credential, home directory, Docker config or agent socket reaches it.
 */
export function workerEnvironment(env: Readonly<Record<string, string | undefined>>, root: string): Record<string, string> {
  return { ...(env.PATH ? { PATH: env.PATH } : {}), ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}), TMPDIR: root };
}

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
    // The clone is a full host copy with no byte limit of its own, so the repository must fit before it is made.
    assertFitsQuestionStorage(deps.measureRepository(question.repository, question.head, Math.min(60_000, remaining())));
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
    try { removeStaging(root); } catch (error) { retained.retainPath(root); failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Question container cleanup did not settle.');
  }
}

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext, InvocationHandle, InvocationInput, InvocationResult, StopReason, TaskClone } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { RecoveredTaskStorage, TaskFilesystems, TaskStorageLimits } from '../agents/container/storage.ts';
import { RUNNER_LABEL, type ResourceOwner } from '../agents/labels.ts';
import { recoverLeftovers, type RecoveryReport } from '../agents/recovery.ts';
import { removeStaging } from './question-leftovers.ts';
import { removalCommand } from './recovery.ts';

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
  /** Written as `io.codeboost.runner` on every Docker object this question creates (#51 item 3). */
  readonly runnerOwner: string;
}
/** Task storage this worker allocated, or recovered from an earlier session of the same review. */
export type QuestionStorage = TaskFilesystems | RecoveredTaskStorage;
/**
 * Task storage whose removal Docker did not confirm. The only handle to a D allocation must not be dropped:
 * it is kept here, removal is retried before the next question, and Ask stays off while any remain. Whatever is
 * still here when the process ends is removed by the next process's recovery, which finds it by the review's owner.
 */
export class RetainedStorage {
  readonly #retained = new Set<QuestionStorage>();
  readonly #paths = new Set<string>();
  #untracked = 0;
  get size() { return this.#retained.size; }
  /** Allocations whose setup failed and whose cleanup D could not confirm. D returns no handle for them. */
  get untracked() { return this.#untracked; }
  retain(filesystems: QuestionStorage) { this.#retained.add(filesystems); }
  markUntracked() { this.#untracked++; }
  /** A host staging directory (a copy of the reviewed code) that could not be deleted. */
  retainPath(path: string) { this.#paths.add(path); }
  paths(): string[] { return [...this.#paths]; }
  /** Retry removal of every retained allocation. Throws while any removal is still unconfirmed. */
  release(remove: (filesystems: QuestionStorage) => void): void {
    for (const path of [...this.#paths]) {
      try { removeStaging(path); this.#paths.delete(path); } catch { /* still owned; retried next time */ }
    }
    for (const filesystems of [...this.#retained]) {
      try { remove(filesystems); this.#retained.delete(filesystems); } catch { /* still owned; retried next time */ }
    }
    if (this.#paths.size) throw new Error(`A copy of reviewed code from an earlier question could not be deleted (${[...this.#paths].join(', ')}). Ask stays off until it is deleted.`);
    if (this.#untracked) throw new Error(`An agent's setup or cleanup failed and was not confirmed, so codeboost cannot tell which Docker resources were left. Ask is off until codeboost restarts; the first question after the restart removes what this review's Ask left in Docker.`);
    if (this.#retained.size) throw new Error(`Agent storage from an earlier question or session could not be removed (${this.#retained.size} allocation${this.#retained.size === 1 ? '' : 's'}). Ask stays off until Docker removes it. Check that Docker is running, then retry.`);
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
  prepareFilesystems(clone: TaskClone, limits: TaskStorageLimits, imageId: string, owner: ResourceOwner,
    timeoutMs: number): TaskFilesystems;
  removeFilesystems(filesystems: QuestionStorage): void;
  /** Lane D's scoped recovery (`recoverLeftovers`): acts only on objects labelled with this owner. */
  recover(runnerOwner: string): Promise<RecoveryReport>;
  /** Size of the checkout at `head` and of the object store, measured before anything is copied to the host. */
  measureRepository(source: string, head: string, timeoutMs: number): RepositorySize;
  capture(input: InvocationInput): InvocationInput;
  startClaude(request: AgentAdapterRequest, token: string): InvocationHandle;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// Questions need the code to read, not room to write. tmpfs volumes only use memory for bytes actually stored.
export const QUESTION_STORAGE: TaskStorageLimits = Object.freeze({
  workBytes: 512 * 1024 * 1024, workInodes: 131_072, metadataBytes: 512 * 1024 * 1024, metadataInodes: 131_072,
});
// The profile requires exactly one read-only schema.json in the input mount. Answers are plain text.
const ANSWER_SCHEMA = '{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"codeboost question answer","type":"string"}\n';

/** The only variables the credential lookup reads. They reach the worker as data, never as its environment. */
export const CREDENTIAL_VARIABLES = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;
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

/** Codex reads files only through its shell, and Ask runs no process, so Codex cannot answer questions (#75). */
export const CODEX_QUESTIONS_REFUSED = 'Codex cannot answer questions yet: it can read the code only by running '
  + 'commands, and Ask runs none. Choose Claude Code in Settings, then retry.';

export function questionCredential(provider: Provider, env: ContainerDependencies['env']): string {
  if (provider === 'codex') throw new Error(CODEX_QUESTIONS_REFUSED);
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error('Ask with Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`, set it, and restart codeboost.');
  return token;
}

/**
 * Why a question stopped, carried as a value next to the message shown to the user. Lane D's stop reason is read from
 * `stop`, never inferred from the wording of `message`.
 */
export class StopError extends Error {
  readonly stop: Extract<StopReason, 'timeout' | 'shutdown' | 'cancelled'>;
  constructor(message: string, stop: StopError['stop']) { super(message); this.stop = stop; }
}
export const stopOf = (reason: unknown): StopError['stop'] => reason instanceof StopError ? reason.stop : 'cancelled';

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
    const owner = { runnerOwner: question.runnerOwner, attemptId: question.attemptId, allocationId: randomUUID() };
    try { filesystems = deps.prepareFilesystems(clone, QUESTION_STORAGE, image.id, owner, Math.min(60_000, remaining())); }
    catch (error) {
      // D throws an AggregateError only when a failed allocation's own cleanup did not settle; it returns no handle.
      if (error instanceof AggregateError) retained.markUntracked();
      throw error;
    }
    remaining();
    const invocation = deps.capture({ clone, phase: 'questions', vendor: question.provider, approvedArgv: [],
      deadline: question.deadline, attemptId: question.attemptId, runnerOwner: question.runnerOwner,
      context: { snapshotId: question.snapshotId, planId: question.planId, planRevision: question.planRevision,
        assignmentId: question.noteId, referencedCodeHash: question.contextId,
        stateVersion: 0 } });
    const request = { invocation, filesystems, inputDirectory: input, imageId: image.id, prompt: question.prompt,
      networkAllocationId: randomUUID() };
    const handle = deps.startClaude(request, credential);
    const cancel = () => handle.cancel(stopOf(signal.reason));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    let result: InvocationResult;
    try { result = await handle.settled; }
    finally { signal.removeEventListener('abort', cancel); }
    // D gave up on cleanup: these resources are no longer owned by anything in this process. Fail closed so no new
    // question starts until a restart, whose recovery removes them by the review's owner label.
    // Presence, not length, is the signal: an empty list still means D stopped before cleanup was confirmed. Host leftovers (D's input and auth staging directories) are covered by
    // the Ask root: the worker's TMPDIR is that root, D stages under tmpdir(), and the root is recorded durably before
    // setup and deleted at startup before Ask is enabled again.
    if (result.unreleased !== undefined) retained.markUntracked();
    return answerFromResult(question.provider, result, invocation);
  } finally {
    const failures: unknown[] = [];
    if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { retained.retain(filesystems); failures.push(error); }
    try { removeStaging(root); } catch (error) { retained.retainPath(root); failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Question container cleanup did not settle.');
  }
}

// Bounds lane D's recovery, which otherwise allows two minutes; the first question waits for it.
const RECOVERY_TIMEOUT_MS = 60_000;
/**
 * Ask's call into lane D's recovery. It skips the daemon-wide search for objects without an owner, so other reviews'
 * objects are never listed or inspected and cannot make it fail (#65).
 */
export const recoverAskOwner = (runnerOwner: string): Promise<RecoveryReport> =>
  recoverLeftovers(runnerOwner, RECOVERY_TIMEOUT_MS, { unowned: false });
// Shown in a refusal at most this many objects; the rest are counted.
const MAX_LISTED = 20;
/**
 * The Docker part of the first check of a process (#65): remove whatever an earlier session of this review left,
 * found by the review's Ask owner label, and nothing else. Run it in the worker before its first question, while the
 * review's Ask lock is held: recovery removes every agent container of that owner, and the handles it returns are
 * valid only in the thread that recovered them. Ask only reads, so recovered storage is removed, never exported;
 * storage whose removal is not confirmed is retained, which keeps Ask off until it is removed.
 *
 * Recovery is asked not to look for objects without an owner label: they come from builds before runner labels and
 * may belong to any review on this daemon, so they neither block Ask nor are touched. Objects carrying this owner that
 * recovery cannot identify keep Ask off.
 */
export async function recoverQuestionStorage(runnerOwner: string, deps: Pick<ContainerDependencies, 'recover' | 'removeFilesystems'>,
  retained: RetainedStorage): Promise<void> {
  let report: RecoveryReport;
  try { report = await deps.recover(runnerOwner); }
  catch (error) {
    throw new Error(`Ask is off: codeboost could not remove what an earlier session of this review left in Docker (${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}). Check that Docker is running, then retry.`);
  }
  for (const handle of report.storage) {
    try { deps.removeFilesystems(handle); } catch { retained.retain(handle); }
  }
  const ours = report.unowned.filter(resource => resource.labels[RUNNER_LABEL] === runnerOwner);
  if (!ours.length) return;
  const commands = ours.slice(0, MAX_LISTED).map(removalCommand);
  if (ours.length > MAX_LISTED) commands.push(`… and ${ours.length - MAX_LISTED} more labelled ${RUNNER_LABEL}=${runnerOwner}`);
  throw new Error(`Ask is off: Docker objects labelled with this review's Ask owner are not ones codeboost can identify, so it did not remove them. Remove them, then retry:\n${commands.join('\n')}`);
}

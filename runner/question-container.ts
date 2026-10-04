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
/** How a feature that keeps leftovers words its refusals, and how it deletes its own host copies. */
export interface LeftoverPolicy {
  /** Deletes a retained host copy of the code. Throws while it is still on disk. */
  removePath(path: string): void;
  paths(paths: readonly string[]): string;
  untracked(): string;
  retained(count: number): string;
}
export const allocations = (count: number) => `${count} allocation${count === 1 ? '' : 's'}`;
/** Ask's refusals. Its host copies are removed only under Ask's own staging prefix. */
export const ASK_LEFTOVERS: LeftoverPolicy = Object.freeze({
  removePath: removeStaging,
  paths: (paths: readonly string[]) => `A copy of reviewed code from an earlier question could not be deleted (${paths.join(', ')}). Ask stays off until it is deleted.`,
  untracked: () => 'An agent\'s setup or cleanup failed and was not confirmed, so codeboost cannot tell which Docker resources were left. Ask is off until codeboost restarts; the first question after the restart removes what this review\'s Ask left in Docker.',
  retained: (count: number) => `Agent storage from an earlier question or session could not be removed (${allocations(count)}). Ask stays off until Docker removes it. Check that Docker is running, then retry.`,
});
/**
 * Task storage whose removal Docker did not confirm. The only handle to a D allocation must not be dropped:
 * it is kept here, removal is retried before the next invocation, and the feature stays off while any remain. For Ask,
 * whatever is still here when the process ends is removed by the next process's recovery, which finds it by the
 * review's owner. Each feature keeps its own instance, so one feature's leftovers never turn another off.
 */
export class RetainedStorage {
  readonly #retained = new Set<QuestionStorage>();
  readonly #paths = new Set<string>();
  readonly #policy: LeftoverPolicy;
  #untracked = 0;
  constructor(policy: LeftoverPolicy = ASK_LEFTOVERS) { this.#policy = policy; }
  get size() { return this.#retained.size; }
  /** Allocations whose setup failed and whose cleanup D could not confirm. D returns no handle for them. */
  get untracked() { return this.#untracked; }
  retain(filesystems: QuestionStorage) { this.#retained.add(filesystems); }
  markUntracked() { this.#untracked++; }
  /** A host staging directory (a copy of the code) that could not be deleted. */
  retainPath(path: string) { this.#paths.add(path); }
  paths(): string[] { return [...this.#paths]; }
  /** Retry removal of every retained allocation. Throws while any removal is still unconfirmed. */
  release(remove: (filesystems: QuestionStorage) => void): void {
    for (const path of [...this.#paths]) {
      try { this.#policy.removePath(path); this.#paths.delete(path); } catch { /* still owned; retried next time */ }
    }
    for (const filesystems of [...this.#retained]) {
      try { remove(filesystems); this.#retained.delete(filesystems); } catch { /* still owned; retried next time */ }
    }
    if (this.#paths.size) throw new Error(this.#policy.paths([...this.#paths]));
    if (this.#untracked) throw new Error(this.#policy.untracked());
    if (this.#retained.size) throw new Error(this.#policy.retained(this.#retained.size));
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
/** Whether a repository's checkout or Git objects would not fit `limits`. */
export const exceedsStorage = (size: RepositorySize, limits: TaskStorageLimits) =>
  size.checkoutBytes > limits.workBytes || size.entries > limits.workInodes || size.objectBytes > limits.metadataBytes;
export function assertFitsQuestionStorage(size: RepositorySize): void {
  if (exceedsStorage(size, QUESTION_STORAGE))
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
export const sameContext = (left: InvocationContext, right: InvocationContext) =>
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
 * What differs between features that run one read-only agent in lane D's container (Ask, planning): the phase, the
 * host root and its removal, limits, the credential rule, the output check, and the wording a person sees. Everything
 * else is `runReadOnlyAgent`.
 */
export interface ReadOnlyFeature {
  readonly phase: 'questions' | 'planning';
  /** Prefix of the host root, under tmpdir(), that holds the clone's staging and the input mount. */
  readonly rootPrefix: string;
  /** Deletes one of this feature's roots and refuses any other path. Throws while the root is still on disk. */
  removeRoot(root: string): void;
  readonly storage: TaskStorageLimits;
  /** The credential for `provider`, or a refusal. Runs before any Docker or Git work. */
  credential(provider: Provider, env: ContainerDependencies['env']): string;
  /** Throws when the repository at `head` would not fit `storage`. Runs before any host copy is made. */
  assertFits(size: RepositorySize): void;
  /** Shown when the deadline passes during setup. */
  readonly timedOut: string;
  /** This exact invocation's text after a clean exit, or a refusal. The text is still unvalidated. */
  output(provider: Provider, result: InvocationResult, invocation: InvocationInput): string;
  /** What a run throws when its cleanup did not settle. `failure` holds the run's own error, when it had one. */
  cleanupFailed(failures: readonly unknown[], failure?: { error: unknown }): Error;
}
/** One read-only invocation: whose code, which attempt, and what the agent is asked. */
export interface ReadOnlyRun {
  readonly provider: Provider;
  /** Host checkout to clone. The agent sees a read-only copy of `head`, never this directory. */
  readonly repository: string;
  readonly head: string;
  /** Written as `io.codeboost.runner` on every Docker object this run creates. */
  readonly runnerOwner: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly deadline: number;
  readonly context: InvocationContext;
  readonly prompt: string;
  /** The only file in the input mount. Claude planning receives it as `--json-schema`. */
  readonly schemaText: string;
}

/**
 * Run one read-only agent in lane D's container: a fresh container on a read-only copy of `head`, with vendor-only
 * egress and the feature's phase. Resources are released on every path; what Docker or the host did not confirm
 * removed is kept in `retained`, and the feature stays off while any remains.
 *
 * Lane D's image build, clone and storage allocation are synchronous Docker and Git calls, so a serving process runs
 * this in a worker thread whose TMPDIR is the feature's own root, as Ask's worker does.
 */
export async function runReadOnlyAgent(feature: ReadOnlyFeature, run: ReadOnlyRun, deps: Omit<ContainerDependencies, 'recover'>,
  signal: AbortSignal, image: { id?: string }, retained: RetainedStorage): Promise<string> {
  const remaining = () => {
    signal.throwIfAborted();
    const value = run.deadline - Date.now();
    if (value < 1) throw new Error(feature.timedOut);
    return value;
  };
  const credential = feature.credential(run.provider, deps.env);
  retained.release(deps.removeFilesystems);
  image.id ??= deps.buildImage(remaining());
  const root = mkdtempSync(join(tmpdir(), feature.rootPrefix));
  const staging = join(root, 'staging'), input = join(root, 'input');
  let filesystems: TaskFilesystems | undefined, failure: { error: unknown } | undefined;
  try {
    mkdirSync(staging); mkdirSync(input);
    writeFileSync(join(input, 'schema.json'), run.schemaText, { mode: 0o444 });
    chmodSync(input, 0o555);
    // The clone is a full host copy with no byte limit of its own, so the repository must fit before it is made.
    feature.assertFits(deps.measureRepository(run.repository, run.head, Math.min(60_000, remaining())));
    const clone = deps.createClone({ source: run.repository, parent: staging, taskId: run.taskId,
      head: run.head, timeoutMs: Math.min(120_000, remaining()) });
    const owner = { runnerOwner: run.runnerOwner, attemptId: run.attemptId, allocationId: randomUUID() };
    try { filesystems = deps.prepareFilesystems(clone, feature.storage, image.id, owner, Math.min(60_000, remaining())); }
    catch (error) {
      // D throws an AggregateError only when a failed allocation's own cleanup did not settle; it returns no handle.
      if (error instanceof AggregateError) retained.markUntracked();
      throw error;
    }
    remaining();
    const invocation = deps.capture({ clone, phase: feature.phase, vendor: run.provider, approvedArgv: [],
      deadline: run.deadline, attemptId: run.attemptId, runnerOwner: run.runnerOwner, context: run.context });
    const request = { invocation, filesystems, inputDirectory: input, imageId: image.id, prompt: run.prompt,
      networkAllocationId: randomUUID() };
    const handle = deps.startClaude(request, credential);
    const cancel = () => handle.cancel(stopOf(signal.reason));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    let result: InvocationResult;
    try { result = await handle.settled; }
    finally { signal.removeEventListener('abort', cancel); }
    // D gave up on cleanup: these resources are no longer owned by anything in this process. Fail closed so nothing
    // new starts until a restart, whose recovery removes them by the feature's owner label.
    // Presence, not length, is the signal: an empty list still means D stopped before cleanup was confirmed. Host
    // leftovers (D's input and auth staging directories) are covered by the worker's root: its TMPDIR is that root,
    // D stages under tmpdir(), and the root is recorded durably before setup and deleted at startup.
    if (result.unreleased !== undefined) retained.markUntracked();
    return feature.output(run.provider, result, invocation);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    const failures: unknown[] = [];
    if (filesystems) try { deps.removeFilesystems(filesystems); } catch (error) { retained.retain(filesystems); failures.push(error); }
    try { feature.removeRoot(root); } catch (error) { retained.retainPath(root); failures.push(error); }
    if (failures.length) throw feature.cleanupFailed(failures, failure);
  }
}

/** Ask's part of a read-only run. Its wording and cleanup error are Ask's own and unchanged by the shared runner. */
export const ASK_FEATURE: ReadOnlyFeature = Object.freeze({
  phase: 'questions', rootPrefix: 'codeboost-question-', removeRoot: removeStaging, storage: QUESTION_STORAGE,
  credential: questionCredential, assertFits: assertFitsQuestionStorage, timedOut: 'Agent timed out. Try again.',
  output: answerFromResult,
  cleanupFailed: (failures: readonly unknown[]) => new AggregateError(failures, 'Question container cleanup did not settle.'),
});

/**
 * Answer one question inside the lane D container: a read-only `/work` checkout of the reviewed head,
 * the "questions" phase (read, list and search only; no commands), and vendor-only network access.
 * Every step is bounded by `deadline`. Storage is released only after the invocation settles.
 */
export async function askInContainer(question: ContainerQuestion, deps: ContainerDependencies,
  signal: AbortSignal, image: { id?: string } = {}, retained = new RetainedStorage()): Promise<string> {
  return runReadOnlyAgent(ASK_FEATURE, { provider: question.provider, repository: question.repository, head: question.head,
    runnerOwner: question.runnerOwner, attemptId: question.attemptId, taskId: `question-${question.noteId}`,
    deadline: question.deadline, prompt: question.prompt, schemaText: ANSWER_SCHEMA,
    context: { snapshotId: question.snapshotId, planId: question.planId, planRevision: question.planRevision,
      assignmentId: question.noteId, referencedCodeHash: question.contextId, stateVersion: 0 } },
    deps, signal, image, retained);
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

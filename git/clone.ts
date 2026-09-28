import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, opendirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TaskClone } from '../agents/contract.ts';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';

interface DirectoryIdentity { readonly dev: number; readonly ino: number }
interface CloneIdentity { readonly directory: string; readonly root: DirectoryIdentity; readonly metadata: DirectoryIdentity }
const trustedClones = new WeakMap<TaskClone, CloneIdentity>();
const directoryIdentity = (path: string): DirectoryIdentity | undefined => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : undefined;
};
const sameDirectory = (actual: DirectoryIdentity | undefined, expected: DirectoryIdentity) =>
  actual?.dev === expected.dev && actual.ino === expected.ino;

/** Authenticate a clone and prove its staging directory is still the one the builder created. */
export function assertTaskClone(clone: TaskClone): string {
  const identity = trustedClones.get(clone);
  if (!identity) throw new Error('Task clone was not created by the trusted clone builder.');
  if (!sameDirectory(directoryIdentity(identity.directory), identity.root)
    || !sameDirectory(directoryIdentity(join(identity.directory, '.git')), identity.metadata)
    || realpathSync(identity.directory) !== identity.directory)
    throw new Error('Task clone directory was replaced after it was created.');
  return identity.directory;
}

/** One Git call the clone steps need run, or a point where a long file walk lets other work (and an abort) in. */
type CloneStep = { readonly cwd: string; readonly args: readonly string[]; readonly timeoutMs: number } | typeof PAUSE;
const PAUSE = Symbol('pause');
/** What a Git call returned: `error` is set whenever it did not exit 0. */
interface GitOutcome { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error }
// Entries walked between pauses, so the asynchronous variant never holds the event loop for a whole object store.
const PAUSE_EVERY = 1_000;
const GIT_OPTIONS = ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
  '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false'];
// Deliberately do not inherit Git variables or credential/config environment.
const gitEnvironment = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' });

export interface CloneOptions {
  readonly source: string; readonly parent: string; readonly taskId: string; readonly head: string;
  readonly timeoutMs?: number;
}

/**
 * The clone, as a sequence of Git calls. Both variants run these same steps; only how each call runs differs. Every
 * failure after the clone directory exists, an abort included, removes it before the error leaves.
 */
function* cloneSteps(options: CloneOptions): Generator<CloneStep, TaskClone, GitOutcome | undefined> {
  if (!options.taskId || options.taskId.includes('\0')) throw new Error('Task identity is required.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.head)) throw new Error('A full committed head is required.');
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid clone deadline.');
  const deadline = performance.now() + timeout;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error('Clone deadline exceeded.');
    return value;
  };
  const source = realpathSync(options.source), parent = realpathSync(options.parent);
  const within = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  };
  if (within(source, parent)) throw new Error('Task storage must be outside the source repository.');
  function* run(cwd: string, ...args: string[]): Generator<CloneStep, string, GitOutcome | undefined> {
    const outcome = yield { cwd, args, timeoutMs: remaining() };
    if (!outcome || outcome.status !== 0) throw outcome?.error ?? new Error(`git ${args[0] ?? ''} failed.`);
    remaining();
    return outcome.stdout.trim();
  }
  const common = realpathSync(resolve(source, yield* run(source, 'rev-parse', '--git-common-dir')));
  if (within(common, parent)) throw new Error('Task storage must be outside source metadata.');
  function* audit(metadata: string, independent: boolean): Generator<CloneStep, void, GitOutcome | undefined> {
    for (const name of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
      if (lstatSync(join(metadata, name), { throwIfNoEntry: false })) throw new Error(`Unsupported Git storage: ${name}`);
    }
    const pending = [join(metadata, 'objects')];
    // `walked` counts every entry touched, including each one read from a directory, so one huge directory pauses too.
    let count = 0, walked = 0;
    while (pending.length) {
      remaining();
      if (++count > 100_000) throw new Error('Object storage exceeds inspection limit.');
      if (++walked % PAUSE_EVERY === 0) yield PAUSE;
      const path = pending.pop()!, stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported object entry.');
      if (independent && stat.isFile() && stat.nlink !== 1) throw new Error('Task objects must not be hard-linked.');
      if (stat.isDirectory()) {
        const directory = opendirSync(path, { bufferSize: 1 });
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            remaining();
            if (count + pending.length >= 100_000) throw new Error('Object storage exceeds inspection limit.');
            pending.push(join(path, entry.name));
            if (++walked % PAUSE_EVERY === 0) yield PAUSE;
          }
        } finally { directory.closeSync(); }
      }
    }
  }
  yield* audit(common, false);
  if (yield* run(source, 'for-each-ref', '--format=%(refname)', 'refs/replace'))
    throw new Error('Replacement objects are unsupported.');
  if ((yield* run(source, 'rev-parse', '--verify', `${options.head}^{commit}`)) !== options.head)
    throw new Error('Head is not a commit.');
  const directory = mkdtempSync(join(parent, 'codeboost-task-'));
  try {
    yield* run(parent, '-c', 'protocol.file.allow=always', 'clone', '--local', '--no-hardlinks', '--no-checkout', '--',
      source, directory);
    const metadata = join(directory, '.git');
    if (!lstatSync(metadata).isDirectory()) throw new Error('Task requires standalone Git metadata.');
    yield* audit(metadata, true);
    yield* run(directory, 'remote', 'remove', 'origin');
    yield* run(directory, 'checkout', '--detach', options.head);
    if ((yield* run(directory, 'rev-parse', 'HEAD')) !== options.head) throw new Error('Task head changed during clone.');
    const clone = Object.freeze({ id: randomUUID(), taskId: options.taskId, directory, head: options.head });
    const root = directoryIdentity(directory), cloneMetadata = directoryIdentity(metadata);
    if (!root || !cloneMetadata) throw new Error('Task clone directory is not a real directory.');
    trustedClones.set(clone, Object.freeze({ directory: realpathSync(directory), root, metadata: cloneMetadata }));
    return clone;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Prepare an independent committed snapshot. This is trusted staging, not the
 * writable execution filesystem: D2 must reserve bounded storage and separate
 * metadata before mounting it. Source must stay quiescent during this operation.
 * No hooks, filters from user config, credentials, submodules or network access.
 * Blocks the event loop while it runs; the runner uses `createTaskCloneAsync`.
 */
export function createTaskClone(options: CloneOptions): TaskClone {
  const env = gitEnvironment(), steps = cloneSteps(options);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step === PAUSE) { next = steps.next(); continue; }
    let outcome: GitOutcome;
    try {
      const stdout = execFileSync('git', [...GIT_OPTIONS, ...step.args], { cwd: step.cwd, env, timeout: step.timeoutMs,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      outcome = { status: 0, stdout: stdout.toString(), stderr: '' };
    } catch (error) {
      const failed = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
      outcome = { status: typeof failed.status === 'number' ? failed.status : null,
        stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? ''), error: error as Error };
    }
    next = steps.next(outcome);
  }
  return next.value;
}

export interface AsyncCloneOptions extends CloneOptions {
  /** Aborting stops the running Git call's process group and removes the partial clone before the promise rejects. */
  readonly signal?: AbortSignal;
  /** Called in the same turn as each Git spawn with its process group, so the caller can record it durably. */
  readonly onProcessGroup?: (group: ProcessGroup) => void;
}

/**
 * `createTaskClone` without blocking the event loop. Each Git call runs in its own process group, reported through
 * `onProcessGroup`; an abort sends the group SIGTERM, then SIGKILL after 5 s, and the promise settles only after the
 * group has exited and the partial clone is removed.
 */
export async function createTaskCloneAsync(options: AsyncCloneOptions): Promise<TaskClone> {
  const env = gitEnvironment(), steps = cloneSteps(options), signal = options.signal;
  const aborted = () => Object.assign(new Error('Task clone was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  if (signal?.aborted) throw aborted();
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step === PAUSE) {
      await new Promise(resolve => setImmediate(resolve));
      next = signal?.aborted ? steps.throw(aborted()) : steps.next();
      continue;
    }
    const outcome = await runInProcessGroup('git', [...GIT_OPTIONS, ...step.args], { cwd: step.cwd, env,
      timeoutMs: step.timeoutMs, signal, onProcessGroup: options.onProcessGroup, maxBuffer: 1024 * 1024 });
    const cancelled = (outcome.error as NodeJS.ErrnoException | undefined)?.code === 'ABORT_ERR';
    next = steps.next(outcome.status === 0 ? outcome : { ...outcome, error: cancelled ? aborted() : outcome.error
      ?? new Error(`git ${step.args[0] ?? ''} failed (exit ${outcome.status}): ${outcome.stderr.trim().slice(0, 512)}`) });
  }
  return next.value;
}

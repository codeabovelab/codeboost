import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_COMMIT_REF } from '../agents/container/changes.ts';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { isUuidV4 } from './lifecycle.ts';

/**
 * The runner-owned repository (#87 decision 1): a bare repository per configured repository, under the runner root,
 * holding the commits codeboost makes. Task clones are made from it, the push reads from it, and the review screen
 * reads a task's runner commits from it. codeboost never writes the user's repository: base commits are fetched from
 * it, and each runner commit arrives as the bundle `commitTaskChanges` returned.
 */
export interface RunnerRepository {
  /** The bare repository's directory. */
  readonly path: string;
  /** The user's repository, where base commits come from. Only ever read. */
  readonly source: string;
}
export interface GitCallOptions {
  readonly signal?: AbortSignal;
  /** Called in the same turn as each Git spawn, so the caller can record the group. */
  readonly onProcessGroup?: (group: ProcessGroup) => void;
  /** Deadline for each Git call. Default 120 s. */
  readonly timeoutMs?: number;
}
/** The ref that keeps one attempt's runner commit; deleted when the attempt does not complete. */
export const attemptRef = (attemptId: string): string => {
  if (!isUuidV4(attemptId)) throw new Error('Attempt ID must be a UUID v4.');
  return `refs/codeboost/attempts/${attemptId}`;
};
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function git(repository: string, args: readonly string[], options: GitCallOptions & { allowFiles?: boolean } = {}): Promise<string> {
  const outcome = await runInProcessGroup('git', [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    ...options.allowFiles ? ['-c', 'protocol.file.allow=always'] : [], ...args],
  { cwd: repository, env: gitEnvironment(), timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal,
    onProcessGroup: options.onProcessGroup, maxBuffer: 1024 * 1024 });
  if ((outcome.error as NodeJS.ErrnoException | undefined)?.code === 'ABORT_ERR')
    throw Object.assign(new Error(`git ${args[0]} was cancelled.`), { name: 'AbortError', code: 'ABORT_ERR' });
  // Git's message can quote a path; it stays one line of printable text.
  if (outcome.status !== 0) throw new Error(`git ${args[0]} failed${outcome.status === null ? '' : ` (exit ${outcome.status})`}: `
    + JSON.stringify(outcome.stderr.trim().slice(0, 400) || outcome.error?.message || ''));
  return outcome.stdout.trim();
}
const exists = async (repository: string, object: string, options: GitCallOptions) => {
  try { await git(repository, ['cat-file', '-e', object], options); return true; } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return false;
  }
};

/**
 * Open the runner-owned repository for `repositoryId`, creating it if needed. It lives at
 * `<runnerRoot>/<runnerOwner>/repositories/<hash>.git`, in directories only the current user can write. A new one is
 * created under a temporary name and renamed into place, so a crash never leaves a half-made one under the real name.
 */
export async function openRunnerRepository(o: { runnerRoot: string; runnerOwner: string; repositoryId: string; source: string }
  & GitCallOptions): Promise<RunnerRepository> {
  if (!/^[0-9a-f]{32}$/.test(o.runnerOwner)) throw new Error('Invalid runner owner token.');
  const parent = join(o.runnerRoot, o.runnerOwner, 'repositories');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || (process.getuid && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o022) !== 0)
    throw new Error(`${parent} must be a directory owned by you and not writable by group or others.`);
  const path = join(parent, `${createHash('sha256').update(o.repositoryId).digest('hex').slice(0, 32)}.git`);
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const staging = mkdtempSync(join(parent, '.new-'));
    try {
      const format = await git(o.source, ['rev-parse', '--show-object-format'], o);
      await git(staging, ['init', '-q', '--bare', '--template=', `--object-format=${format === 'sha256' ? 'sha256' : 'sha1'}`, '.'], o);
      try { renameSync(staging, path); } catch (error) {
        // Another opener made it first; theirs is used.
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} is not the runner repository.`);
  if (await git(path, ['rev-parse', '--is-bare-repository'], o) !== 'true') throw new Error(`${path} is not a bare repository.`);
  return Object.freeze({ path, source: o.source });
}

/** Make `head` available for a task clone: a runner commit is there already; a base commit is fetched from the source. */
export async function ensureCommit(repository: RunnerRepository, head: string, options: GitCallOptions = {}): Promise<void> {
  if (!COMMIT_ID.test(head)) throw new Error('A full commit ID is required.');
  if (await exists(repository.path, `${head}^{commit}`, options)) return;
  // Protocol v2 serves any commit the source has by ID. Nothing else is taken: no tags, no refs, no FETCH_HEAD.
  await git(repository.path, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', repository.source, head],
    { ...options, allowFiles: true });
  if (!(await exists(repository.path, `${head}^{commit}`, options))) throw new Error(`The source repository has no commit ${head}.`);
}

/**
 * Take a runner commit in from the bundle `commitTaskChanges` returned, under the attempt's ref, and check that it is
 * the commit the runner made: the bundle's one ref is `head`, and `head` is a single commit on top of `base`.
 */
export async function fetchTaskCommit(repository: RunnerRepository, input: { bundle: Buffer; base: string; head: string;
  attemptId: string }, options: GitCallOptions = {}): Promise<void> {
  if (!COMMIT_ID.test(input.base) || !COMMIT_ID.test(input.head)) throw new Error('A full commit ID is required.');
  const ref = attemptRef(input.attemptId);
  // The bundle file is the runner's own, beside the repository, readable only by the current user.
  const file = join(repository.path, `codeboost-${randomUUID()}.bundle`);
  writeFileSync(file, input.bundle, { mode: 0o600, flag: 'wx' });
  try {
    if (statSync(file).size !== input.bundle.length) throw new Error('The runner commit bundle was not written whole.');
    await git(repository.path, ['bundle', 'verify', '-q', file], options);
    const heads = (await git(repository.path, ['bundle', 'list-heads', file], options)).split('\n');
    if (heads.length !== 1 || heads[0] !== `${input.head} ${TASK_COMMIT_REF}`) throw new Error('The runner commit bundle does not hold exactly the runner commit.');
    await git(repository.path, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--', file, `+${TASK_COMMIT_REF}:${ref}`],
      { ...options, allowFiles: true });
  } finally { rmSync(file, { force: true }); }
  try {
    if (await git(repository.path, ['rev-parse', '--verify', `${ref}^{commit}`], options) !== input.head)
      throw new Error('The fetched runner commit is not the one the commit step made.');
    if (await git(repository.path, ['rev-list', '--parents', '-n', '1', input.head], options) !== `${input.head} ${input.base}`)
      throw new Error('The runner commit is not a single commit on top of its base.');
  } catch (error) {
    // Nothing keeps a commit that failed its checks.
    await git(repository.path, ['update-ref', '-d', ref], { timeoutMs: options.timeoutMs }).catch(() => {});
    throw error;
  }
}

/** Drop an attempt's ref, for an attempt whose commit was not published. Its objects become unreachable. */
export async function dropAttemptRef(repository: RunnerRepository, attemptId: string, options: GitCallOptions = {}): Promise<void> {
  await git(repository.path, ['update-ref', '-d', attemptRef(attemptId)], options);
}

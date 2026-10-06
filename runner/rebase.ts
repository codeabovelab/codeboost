import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';
import type { DockerOutcome } from '../agents/docker.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { isUuidV4 } from './lifecycle.ts';
import { ownerOnlyDirectory, type RunnerRepository } from './runner-repository.ts';
import { MAX_INDEX_BYTES } from './verify-checkout.ts';

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_REBASE_COMMITS = 500;
// runInProcessGroup can spend 1 s delivering SIGTERM, 10 s draining descendants, and 1 s draining held pipes.
const PROCESS_SETTLEMENT_RESERVE_MS = 13_000;
// Cleanup receives an operation-wide 30 s: 13 s to settle a cleanup process group and 17 s for Git and follow-up calls.
const CLEANUP_RESERVE_MS = 30_000;
const MIN_REBASE_TIMEOUT_MS = CLEANUP_RESERVE_MS + PROCESS_SETTLEMENT_RESERVE_MS + 1;

export interface RebaseMapping { oldSha: string; newSha: string }
export interface RebaseConflictInput {
  readonly attemptId: string;
  readonly commit: string;
  readonly files: readonly string[];
  /** The isolated runner-owned worktree. A production resolver must expose it only through lane D's bounded storage. */
  readonly repository: string;
  readonly signal?: AbortSignal;
}
export interface RebaseResult {
  oldHead: string; base: string; head: string; mappings: RebaseMapping[];
  /** Source commits whose foreign conflicts were resolved by the configured agent boundary. */
  resolvedConflicts: string[];
}
export interface GitRebaserOptions {
  repository: RunnerRepository;
  runnerRoot: string;
  runnerOwner: string;
  committer: { name: string; email: string };
  timeoutMs?: number;
  onProcessStarting: (attemptId: string) => void;
  onProcessGroup: (attemptId: string, group: ProcessGroup) => void;
  onProcessGroupSettled: (attemptId: string, group: ProcessGroup | 'spawning') => void;
  onProcessUnsettled: (attemptId: string, group: ProcessGroup) => void;
  onResultPrepared: (attemptId: string, intendedHead: string | null, rewrittenHistory: readonly string[],
    resolvedConflicts: readonly string[]) => void;
  onResultState: (attemptId: string, state: 'uncertain' | 'refused' | 'ready') => void;
  /** F4's sandboxed resolver. It must settle all owned resources before resolving or rejecting. */
  resolveForeignConflict?: (input: RebaseConflictInput) => Promise<void>;
}
interface CallScope { attemptId: string; signal?: AbortSignal; deadline: number; workDeadline: number }

const configuredGit = (): { executable: string; environment: NodeJS.ProcessEnv } => {
  const source = process.env.PATH;
  if (!source) throw new Error('Git requires a configured PATH.');
  // Resolve relative and empty entries while still in the runner's trusted working directory. Carrying them into an
  // agent-controlled worktree would let that checkout supply the `git` executable used to verify itself.
  const path = source.split(delimiter).map(entry => resolve(process.cwd(), entry || '.')).join(delimiter);
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, 'git');
    try {
      const executable = realpathSync(candidate);
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return { executable, environment: { ...gitEnvironment(), PATH: path } };
    } catch { /* This PATH entry does not provide an executable Git. */ }
  }
  throw new Error('Git is not executable on the configured PATH.');
};

/** A conflict is a review outcome, not an infrastructure failure. No rewritten ref is retained. */
export class RebaseConflict extends Error {}

/** The durable ref that keeps a completed rewrite reachable in the runner-owned bare repository. */
export function rebaseRef(attemptId: string): string {
  if (!isUuidV4(attemptId)) throw new Error('Rebase attempt ID must be a UUID v4.');
  return `refs/codeboost/rebases/${attemptId}`;
}

/**
 * Replays one bounded linear task history in an isolated worktree owned by the runner. The caller claims the matching
 * Store marker before calling run(). A successful rewrite keeps its head under rebaseRef(attemptId); abort() removes
 * only an unfinished attempt's worktree and ref.
 */
export class GitRebaser {
  readonly #options: GitRebaserOptions;
  readonly #root: string;
  readonly #gitExecutable: string;
  readonly #gitEnvironment: NodeJS.ProcessEnv;

  constructor(options: GitRebaserOptions) {
    if (!/^[0-9a-f]{32}$/.test(options.runnerOwner)) throw new Error('Invalid runner owner token.');
    if (!options.committer.name || !options.committer.email || /[<>\n\r\0]/.test(options.committer.name + options.committer.email))
      throw new Error('A valid rebase committer is required.');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < MIN_REBASE_TIMEOUT_MS || options.timeoutMs > 120_000))
      throw new Error('Invalid rebase deadline.');
    const git = configuredGit();
    this.#options = options;
    this.#gitExecutable = git.executable;
    this.#gitEnvironment = git.environment;
    this.#root = ownerOnlyDirectory(options.runnerRoot, options.runnerOwner, 'rebases');
  }

  async run(input: { attemptId: string; oldBase: string; oldHead: string; oldHistory: readonly string[]; onto: string;
    ledger?: readonly { sha: string; owner: string | null; origin: 'owned' | 'foreign' }[]; signal?: AbortSignal }): Promise<RebaseResult> {
    const { attemptId, oldBase, oldHead, oldHistory, onto, signal } = input;
    rebaseRef(attemptId);
    for (const value of [oldBase, oldHead, onto]) if (!COMMIT_ID.test(value)) throw new Error('A full commit ID is required for rebasing.');
    const ledger = new Map<string, { owner: string | null; origin: 'owned' | 'foreign' }>();
    for (const entry of input.ledger ?? []) {
      if (!COMMIT_ID.test(entry.sha) || ledger.has(entry.sha) ||
          (entry.origin === 'owned' ? typeof entry.owner !== 'string' || entry.owner.length === 0 : entry.owner !== null))
        throw new Error('The trusted commit ledger is invalid.');
      ledger.set(entry.sha, { owner: entry.owner, origin: entry.origin });
    }
    signal?.throwIfAborted();
    const scope = this.#scope(attemptId, signal);
    const ref = rebaseRef(attemptId);
    const existing = await this.#call(this.#options.repository.path, ['show-ref', '--verify', '--quiet', ref], scope);
    this.#throwIfCancelled(existing, scope);
    if (existing.status === 0) throw new Error('This rebase attempt already has a retained result.');
    if (existing.status !== 1) throw this.#failure('show-ref', existing);
    const old = await this.#history(this.#options.repository.path, oldBase, oldHead, scope);
    if (old.length !== oldHistory.length || old.some((sha, index) => sha !== oldHistory[index]))
      throw new Error('The repository history no longer matches the durably captured review history.');
    if (onto === oldBase) {
      const mappings = old.map(sha => ({ oldSha: sha, newSha: sha }));
      this.#assertResultCurrent(scope);
      this.#options.onResultPrepared(attemptId, null, old, []);
      this.#assertResultCurrent(scope);
      this.#options.onResultState(attemptId, 'ready');
      this.#assertResultCurrent(scope);
      return { oldHead, base: onto, head: oldHead, mappings, resolvedConflicts: [] };
    }

    const path = this.#path(attemptId);
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('The rebase workspace already exists.');
    let added = false, retained = false, uncertainRef = false, attemptedRef: string | undefined;
    let result: RebaseResult | undefined, primary: unknown;
    const resolvedConflicts: string[] = [];
    try {
      await this.#git(this.#options.repository.path, ['worktree', 'add', '--detach', '--', path, oldHead], scope);
      added = true;
      // Git can report a successful checkout even when the host filesystem cannot represent the tree (for example,
      // case-colliding or normalization-colliding names on default macOS volumes). Hash the files into the index and
      // compare trees; status/stat-cache metadata is not proof that the contents are unchanged.
      await this.#assertCheckout(path, oldHead, 'reviewed head', scope);
      let outcome = await this.#call(path, ['rebase', '--quiet', '--reapply-cherry-picks', '--keep-empty', '--empty=keep', '--onto', onto, oldBase, oldHead], scope, false, true);
      for (;;) {
        this.#throwIfCancelled(outcome, scope);
        if (outcome.status === 0) break;
        if (outcome.status === null || outcome.error) throw this.#failure('rebase', outcome);
        // Rebase diagnostics can grow with valid commit messages and path counts. The index, not bounded text, proves a conflict.
        const conflicted = await this.#call(path, ['diff', '--quiet', '--ignore-submodules=all', '--diff-filter=U', '--'], scope);
        this.#throwIfCancelled(conflicted, scope);
        if (conflicted.status !== 1) {
          if (conflicted.status !== 0) throw this.#failure('diff', conflicted);
          throw this.#failure('rebase', outcome);
        }
        const commit = await this.#git(path, ['rev-parse', '--verify', 'REBASE_HEAD^{commit}'], scope);
        if (!old.includes(commit)) throw new RebaseConflict('The conflicted commit is outside the captured rebase history.');
        const entry = ledger.get(commit);
        // Missing ledger entries and explicit foreign entries share the foreign branch. A forged trailer is never read.
        if (entry && (entry.origin !== 'foreign' || entry.owner !== null))
          throw new RebaseConflict('An owned commit conflict needs its plan-item resolver.');
        if (!this.#options.resolveForeignConflict)
          throw new RebaseConflict('A foreign commit conflict needs review.');
        const files = Object.freeze(await this.#paths(path, 'conflicts', scope));
        if (!files.length) throw new RebaseConflict('Git reported a conflict without any conflicted files.');
        if (await this.#hasUnmergedGitlink(path, scope))
          throw new RebaseConflict('A gitlink conflict needs manual resolution.');
        const allowed = new Set(files);
        const priorHead = await this.#git(path, ['rev-parse', '--verify', 'HEAD^{commit}'], scope);
        const outsideBefore = await this.#outsideConflictState(path, allowed, priorHead, scope);
        this.#assertResultCurrent(scope);
        await this.#resolveConflict({ attemptId, commit, files, repository: path }, scope);
        this.#assertResultCurrent(scope);
        if (await this.#git(path, ['rev-parse', '--verify', 'REBASE_HEAD^{commit}'], scope) !== commit)
          throw new RebaseConflict('The conflict resolver changed the rebase operation.');
        if (await this.#git(path, ['rev-parse', '--verify', 'HEAD^{commit}'], scope) !== priorHead)
          throw new RebaseConflict('The conflict resolver changed the rebase operation.');
        if (await this.#outsideConflictState(path, allowed, priorHead, scope) !== outsideBefore)
          throw new RebaseConflict('The conflict resolver changed a file outside the conflicted set.');
        const pathspec = Buffer.from(`${files.join('\0')}\0`);
        await this.#git(path, ['--literal-pathspecs', 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], scope, false, pathspec);
        const unresolved = await this.#call(path, ['diff', '--quiet', '--ignore-submodules=all', '--diff-filter=U', '--'], scope);
        this.#throwIfCancelled(unresolved, scope);
        if (unresolved.status !== 0) {
          if (unresolved.status === 1) throw new RebaseConflict('The conflict resolver left unresolved files.');
          throw this.#failure('diff', unresolved);
        }
        resolvedConflicts.push(commit);
        outcome = await this.#call(path, ['rebase', '--continue'], scope, false, true);
      }
      const head = await this.#git(path, ['rev-parse', '--verify', 'HEAD^{commit}'], scope);
      if (!COMMIT_ID.test(head)) throw new Error('Git returned an invalid rebased head.');
      await this.#assertCheckout(path, head, 'rebased head', scope);
      const next = await this.#history(path, onto, head, scope);
      if (next.length !== old.length) throw new Error('The rebase did not preserve one commit for every task commit.');
      const mappings = old.map((oldSha, index) => ({ oldSha, newSha: next[index]! }));
      attemptedRef = head;
      this.#assertResultCurrent(scope);
      this.#options.onResultPrepared(attemptId, head, next, resolvedConflicts);
      this.#assertResultCurrent(scope);
      const created = await this.#call(this.#options.repository.path, ['update-ref', ref, head, '0'.repeat(head.length)], scope);
      if (created.status === 0) retained = true;
      else if (created.status === null) {
        uncertainRef = true;
        this.#options.onResultState(attemptId, 'uncertain');
      } else this.#options.onResultState(attemptId, 'refused');
      this.#throwIfCancelled(created, scope);
      if (created.status !== 0) {
        // A null status can mean the ref write landed but its settlement record did not. Cleanup reconciles that exact
        // attempted value. A normal nonzero exit proves atomic creation refused and must preserve the winning ref.
        throw this.#failure('update-ref', created);
      }
      this.#assertResultCurrent(scope);
      this.#options.onResultState(attemptId, 'ready');
      this.#assertResultCurrent(scope);
      result = { oldHead, base: onto, head, mappings, resolvedConflicts };
    } catch (error) { primary = error; }
    const cleanupFailures: unknown[] = [];
    if (added || lstatSync(path, { throwIfNoEntry: false })) {
      try { await this.#remove(path, scope); } catch (error) { cleanupFailures.push(error); }
    }
    // Cleanup is deliberately uninterruptible, but an abort that arrived while it ran still cancels the operation.
    // Drop a completed rewrite before reporting that cancellation so no caller can apply a cancelled result.
    if (!primary && signal?.aborted) {
      primary = signal.reason;
    }
    if ((retained && primary) || (!retained && uncertainRef)) {
      try { await this.#git(this.#options.repository.path, ['update-ref', '-d', ref, attemptedRef!], scope, true); retained = false; }
      catch (error) { cleanupFailures.push(error); }
    }
    const cleanup = cleanupFailures.length > 1 ? new AggregateError(cleanupFailures, 'Rebase cleanup failed.') : cleanupFailures[0];
    if (primary && cleanup) throw new AggregateError([primary, cleanup], (primary as Error)?.message ?? 'Rebase and cleanup failed.', { cause: primary });
    if (primary) throw primary;
    if (cleanup) throw cleanup;
    return result!;
  }

  /** Startup/live recovery for an attempt whose Store marker still exists. */
  async abort(attemptId: string, resultHead?: string,
    resultState: 'none' | 'prepared' | 'uncertain' | 'refused' | 'ready' = 'ready'): Promise<void> {
    const ref = rebaseRef(attemptId), path = this.#path(attemptId), stat = lstatSync(path, { throwIfNoEntry: false });
    if (resultHead !== undefined && !COMMIT_ID.test(resultHead)) throw new Error('A full retained result ID is required.');
    const scope = this.#scope(attemptId);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('The rebase workspace is not a plain directory.');
    await this.#remove(path, scope);
    if (resultState === 'refused') return;
    if (resultHead !== undefined) {
      const exists = await this.#call(this.#options.repository.path, ['show-ref', '--verify', '--quiet', ref], scope, true);
      if (exists.status === 1) return;
      if (exists.status !== 0) throw this.#failure('show-ref', exists);
      const current = await this.#call(this.#options.repository.path, ['rev-parse', '--verify', ref], scope, true);
      if (current.status !== 0) {
        const after = await this.#call(this.#options.repository.path, ['show-ref', '--verify', '--quiet', ref], scope, true);
        if (after.status === 1) return;
        throw this.#failure('rev-parse', current);
      }
      if (current.stdout.trim() !== resultHead) {
        if (resultState !== 'ready') return;
        throw new Error('Another retained result owns this rebase ref.');
      }
      if (resultState === 'prepared') throw new Error('The prepared rebase ref outcome is ambiguous; refusing recovery.');
      try { await this.#git(this.#options.repository.path, ['update-ref', '-d', ref, resultHead], scope, true); }
      catch (error) {
        const after = await this.#call(this.#options.repository.path, ['show-ref', '--verify', '--quiet', ref], scope, true);
        if (after.status === 1) return;
        if (resultState !== 'ready' && after.status === 0) {
          const value = await this.#call(this.#options.repository.path, ['rev-parse', '--verify', ref], scope, true);
          if (value.status === 0 && value.stdout.trim() !== resultHead) return;
        }
        throw error;
      }
    }
  }

  async #history(repository: string, base: string, head: string, scope: CallScope): Promise<string[]> {
    const text = await this.#git(repository, ['rev-list', '--reverse', '--parents', `--max-count=${MAX_REBASE_COMMITS + 1}`, `${base}..${head}`], scope);
    const rows = text ? text.split('\n') : [];
    if (rows.length > MAX_REBASE_COMMITS) throw new Error(`Rebase history exceeds ${MAX_REBASE_COMMITS} commits.`);
    let parent = base;
    const commits: string[] = [];
    for (const row of rows) {
      const fields = row.split(' ');
      if (fields.length !== 2 || !fields.every(value => COMMIT_ID.test(value)) || fields[1] !== parent)
        throw new Error('Rebase history must be complete, linear, and descend from its recorded base.');
      commits.push(fields[0]!); parent = fields[0]!;
    }
    if (parent !== head) throw new Error('The reviewed head does not descend linearly from its recorded base.');
    return commits;
  }

  async #assertCheckout(repository: string, commit: string, label: string, scope: CallScope): Promise<void> {
    const verifier = fileURLToPath(new URL('./verify-checkout.ts', import.meta.url));
    const verified = await this.#process(process.execPath, [verifier, this.#gitExecutable], repository,
      this.#gitEnvironment, scope, false, 64 * 1024);
    this.#throwIfCancelled(verified, scope);
    if (verified.status !== 0) throw new Error(`The host filesystem cannot faithfully check out the ${label}.`,
      { cause: this.#failure('checkout verification', verified, 'node') });
    const actual = await this.#git(repository, ['write-tree'], scope);
    const expected = await this.#git(repository, ['rev-parse', '--verify', `${commit}^{tree}`], scope);
    if (actual !== expected) throw new Error(`The host filesystem cannot faithfully check out the ${label}.`);
  }

  #path(attemptId: string): string { rebaseRef(attemptId); return join(this.#root, attemptId); }

  async #remove(path: string, scope: CallScope): Promise<void> {
    // `worktree remove` also unregisters the checkout. It is scoped to the validated UUID path under the owner-only root.
    const outcome = await this.#call(this.#options.repository.path, ['worktree', 'remove', '--force', '--', path], scope, true);
    if (outcome.status !== 0) {
      // A timeout, cancellation, output failure, unsettled group, or callback failure is not evidence that Git merely
      // did not know this worktree. Preserve that actionable outcome and its durable process ownership.
      if (outcome.status === null || outcome.error) throw this.#failure('worktree remove', outcome);
      // An interrupted `worktree add` can create the directory before it registers it. Remove only that exact plain
      // directory after Git proves it is not a registered worktree; never turn a registered cleanup failure into success.
      const listing = await this.#git(this.#options.repository.path, ['worktree', 'list', '--porcelain', '-z'], scope, true);
      const registered = listing.split('\0').some(record => record === `worktree ${path}`);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (registered && stat) throw this.#failure('worktree remove', outcome);
      if (registered) {
        await this.#git(this.#options.repository.path, ['worktree', 'prune'], scope, true);
        const after = await this.#git(this.#options.repository.path, ['worktree', 'list', '--porcelain', '-z'], scope, true);
        if (after.split('\0').some(record => record === `worktree ${path}`)) throw this.#failure('worktree remove', outcome);
      }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('The rebase workspace is not a plain directory.');
      if (stat) await this.#deleteDirectory(path, scope);
    }
    if (lstatSync(path, { throwIfNoEntry: false })) throw this.#failure('worktree remove', outcome);
    await this.#git(this.#options.repository.path, ['worktree', 'prune'], scope, true);
  }

  async #pathRecords(repository: string, mode: 'conflicts' | 'changed' | 'untracked' | 'unmerged', scope: CallScope,
    head?: string): Promise<string[]> {
    const helper = fileURLToPath(new URL('./list-git-paths.ts', import.meta.url));
    const args = [helper, this.#gitExecutable, mode, ...(head ? [head] : [])];
    // Base64 expands the explicitly bounded 32 MiB raw stream by four thirds.
    const outcome = await this.#process(process.execPath, args, repository, this.#gitEnvironment, scope, false,
      Math.ceil(MAX_INDEX_BYTES / 3) * 4 + 4);
    this.#throwIfCancelled(outcome, scope);
    if (outcome.status !== 0) throw this.#failure('path listing', outcome, 'node');
    const encoded = outcome.stdout;
    const raw = Buffer.from(encoded, 'base64');
    if (raw.toString('base64') !== encoded || (raw.length && raw[raw.length - 1] !== 0))
      throw new RebaseConflict('Git returned an invalid path listing.');
    const records = raw.length ? raw.subarray(0, -1).toString('binary').split('\0').map(value => Buffer.from(value, 'binary')) : [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try { return records.map(record => decoder.decode(record)); }
    catch { throw new RebaseConflict('A Git path cannot be represented safely; resolve it manually.'); }
  }

  async #paths(repository: string, mode: 'conflicts' | 'changed' | 'untracked', scope: CallScope, head?: string): Promise<string[]> {
    const paths = await this.#pathRecords(repository, mode, scope, head);
    if (paths.some(path => !path || path.includes('\0'))) throw new RebaseConflict('Git returned an invalid path.');
    return paths;
  }

  async #hasUnmergedGitlink(repository: string, scope: CallScope): Promise<boolean> {
    const records = await this.#pathRecords(repository, 'unmerged', scope);
    return records.some(record => {
      const tab = record.indexOf('\t'), header = record.slice(0, tab).split(' ');
      if (tab < 0 || header.length !== 3 || !/^[0-3]$/.test(header[2]!))
        throw new RebaseConflict('Git returned an invalid unmerged index record.');
      return header[0] === '160000';
    });
  }

  async #outsideConflictState(repository: string, allowed: ReadonlySet<string>, head: string, scope: CallScope): Promise<string> {
    const verifier = fileURLToPath(new URL('./verify-checkout.ts', import.meta.url));
    const gitlinks = await this.#process(process.execPath, [verifier, this.#gitExecutable, 'gitlinks'], repository,
      this.#gitEnvironment, scope, false, 64 * 1024);
    this.#throwIfCancelled(gitlinks, scope);
    if (gitlinks.status !== 0 || !/^[0-9a-f]{64}$/.test(gitlinks.stdout))
      throw this.#failure('gitlink index audit', gitlinks, 'node');
    const changed = new Set([
      ...await this.#paths(repository, 'changed', scope, head),
      ...await this.#paths(repository, 'untracked', scope),
    ]);
    const entries: string[][] = [];
    for (const path of [...changed].filter(value => !allowed.has(value)).sort()) {
      const index = await this.#git(repository, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', path], scope);
      entries.push([path, index, this.#worktreeFingerprint(repository, path)]);
    }
    return JSON.stringify([gitlinks.stdout, entries]);
  }

  #worktreeFingerprint(repository: string, path: string): string {
    const full = resolve(repository, path), root = `${resolve(repository)}${sep}`;
    if (!full.startsWith(root)) throw new RebaseConflict('Git returned a path outside the rebase workspace.');
    const before = lstatSync(full, { throwIfNoEntry: false });
    if (!before) return 'missing';
    if (before.isSymbolicLink()) return `link:${before.mode}:${readlinkSync(full, { encoding: 'buffer' }).toString('hex')}`;
    if (!before.isFile()) throw new RebaseConflict('A changed path is not a regular file or symbolic link.');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new RebaseConflict('A changed path changed type while it was audited.');
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (!length) break;
        hash.update(buffer.subarray(0, length));
      }
      return `file:${stat.mode}:${hash.digest('hex')}`;
    } finally { closeSync(fd); }
  }

  async #resolveConflict(input: Omit<RebaseConflictInput, 'signal'>, scope: CallScope): Promise<void> {
    const resolveConflict = this.#options.resolveForeignConflict!;
    const controller = new AbortController();
    const abort = () => controller.abort(scope.signal?.reason ?? new Error('The rebase was cancelled.'));
    if (scope.signal?.aborted) abort();
    else scope.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = Math.max(0, Math.ceil(scope.workDeadline - performance.now()));
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('The rebase deadline expired during conflict resolution.'),
      { code: 'ETIMEDOUT' })), timeoutMs);
    try {
      controller.signal.throwIfAborted();
      // Await settlement after abort: the resolver owns its container/storage until its promise ends.
      try { await resolveConflict(Object.freeze({ ...input, signal: controller.signal })); }
      catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      }
      controller.signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      scope.signal?.removeEventListener('abort', abort);
    }
  }

  async #git(repository: string, args: readonly string[], scope: CallScope, cleanup = false, input?: Buffer): Promise<string> {
    const outcome = await this.#call(repository, args, scope, cleanup, false, input);
    if (!cleanup) this.#throwIfCancelled(outcome, scope);
    if (outcome.status !== 0) throw this.#failure(args[0] ?? 'git', outcome);
    return outcome.stdout.trim();
  }

  #throwIfCancelled(outcome: DockerOutcome, scope: CallScope): void {
    if (!scope.signal?.aborted) return;
    // A settlement callback failure is evidence too; #process has already combined it with the original signal reason.
    if (outcome.error instanceof AggregateError) throw outcome.error;
    scope.signal.throwIfAborted();
  }

  async #call(repository: string, args: readonly string[], scope: CallScope, cleanup = false, discardExcessOutput = false,
    input?: Buffer) {
    const env = {
      ...this.#gitEnvironment,
      GIT_COMMITTER_NAME: this.#options.committer.name,
      GIT_COMMITTER_EMAIL: this.#options.committer.email,
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
    };
    return this.#process(this.#gitExecutable, [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], repository,
      env, scope, cleanup, discardExcessOutput ? 64 * 1024 : 8 * 1024 * 1024, input, discardExcessOutput);
  }

  async #deleteDirectory(path: string, scope: CallScope): Promise<void> {
    const script = "const fs=require('node:fs');fs.rmSync(fs.readFileSync(0,'utf8'),{recursive:true})";
    const outcome = await this.#process(process.execPath, ['-e', script], this.#root, {}, scope, true, 64 * 1024, Buffer.from(path));
    if (outcome.status !== 0) throw this.#failure('workspace cleanup', outcome, 'node');
  }

  async #process(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, scope: CallScope,
    cleanup: boolean, maxBuffer: number, input?: Buffer, discardExcessOutput = false): Promise<DockerOutcome> {
    // Persist the spawning owner first. The operation deadline already exists, and the remaining subprocess budget is
    // calculated only after this synchronous caller hook returns, so a blocking hook cannot extend the deadline.
    try { this.#options.onProcessStarting(scope.attemptId); }
    catch (error) {
      const starting = error instanceof Error ? error : new Error(String(error));
      try { this.#options.onProcessGroupSettled(scope.attemptId, 'spawning'); }
      catch (settlementError) {
        const settlement = settlementError instanceof Error ? settlementError : new Error(String(settlementError));
        throw new AggregateError([starting, settlement], starting.message, { cause: starting });
      }
      throw starting;
    }
    const limit = cleanup ? scope.deadline : scope.workDeadline;
    const timeoutMs = Math.max(0, Math.ceil(limit - performance.now() - PROCESS_SETTLEMENT_RESERVE_MS));
    if (timeoutMs < 1) {
      const deadline = Object.assign(new Error('The rebase deadline expired.'), { code: 'ETIMEDOUT' });
      try { this.#options.onProcessGroupSettled(scope.attemptId, 'spawning'); }
      catch (error) {
        const callback = error instanceof Error ? error : new Error(String(error));
        return { status: null, stdout: '', stderr: '',
          error: new AggregateError([deadline, callback], deadline.message, { cause: deadline }) };
      }
      return { status: null, stdout: '', stderr: '', error: deadline };
    }
    let group: ProcessGroup | undefined;
    const outcome = await runInProcessGroup(file, args, {
      cwd, env, timeoutMs, graceMs: 1_000, signal: cleanup ? undefined : scope.signal, input,
      onProcessGroup: value => { this.#options.onProcessGroup(scope.attemptId, value); group = value; }, maxBuffer, discardExcessOutput,
    });
    const code = (outcome.error as NodeJS.ErrnoException | undefined)?.code;
    let callbackFailure: unknown;
    try {
      if (group && code === 'EGROUPALIVE') { /* Its group still exists; retain the exact durable owner. */ }
      else if (group && code === 'ESTDIOHELD') this.#options.onProcessUnsettled(scope.attemptId, group);
      else if (group) this.#options.onProcessGroupSettled(scope.attemptId, group);
      else this.#options.onProcessGroupSettled(scope.attemptId, 'spawning');
    } catch (error) { callbackFailure = error; }
    const deadlineFailure = performance.now() >= limit
      ? Object.assign(new Error('The rebase deadline expired while recording process settlement.'), { code: 'ETIMEDOUT' })
      : undefined;
    const childFailure = outcome.error ?? (outcome.status === 0 ? undefined :
      new Error(outcome.stderr.trim() || `${file} exited with status ${outcome.status}.`));
    if (callbackFailure !== undefined) {
      const callback = callbackFailure instanceof Error ? callbackFailure : new Error(String(callbackFailure));
      const signalled = !cleanup && code === 'ABORT_ERR' && scope.signal?.aborted ? scope.signal.reason : undefined;
      const original = signalled instanceof Error ? signalled : childFailure;
      if (original || deadlineFailure) {
        const primary = original ?? deadlineFailure!;
        return { ...outcome, status: null, error: new AggregateError(
          [primary, ...(deadlineFailure && deadlineFailure !== primary ? [deadlineFailure] : []), callback], primary.message, { cause: primary }) };
      }
      return { ...outcome, status: null, error: callback };
    }
    if (deadlineFailure && childFailure) return { ...outcome, status: null,
      error: new AggregateError([childFailure, deadlineFailure], childFailure.message, { cause: childFailure }) };
    if (deadlineFailure) return { ...outcome, status: null, error: deadlineFailure };
    return outcome;
  }

  #scope(attemptId: string, signal?: AbortSignal): CallScope {
    const timeout = this.#options.timeoutMs ?? 120_000, deadline = performance.now() + timeout;
    return { attemptId, signal, deadline, workDeadline: deadline - CLEANUP_RESERVE_MS };
  }

  #assertResultCurrent(scope: CallScope): void {
    scope.signal?.throwIfAborted();
    if (performance.now() >= scope.workDeadline)
      throw Object.assign(new Error('The rebase deadline expired while recording its result.'), { code: 'ETIMEDOUT' });
  }

  #failure(command: string, outcome: DockerOutcome, program = 'git'): Error {
    if (outcome.status === null && outcome.error) return outcome.error;
    const detail = (outcome.status === null && outcome.error ? outcome.error.message :
      outcome.stderr.trim() || outcome.stdout.trim() || outcome.error?.message || 'unknown failure').slice(0, 400);
    return new Error(`${program} ${command} failed${outcome.status === null ? '' : ` (exit ${outcome.status})`}: ${JSON.stringify(detail)}`);
  }
}

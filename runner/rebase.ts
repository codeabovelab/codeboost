import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcessGroup, type ProcessGroup } from '../agents/process-group.ts';
import type { DockerOutcome } from '../agents/docker.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { isUuidV4 } from './lifecycle.ts';
import { ownerOnlyDirectory, type RunnerRepository } from './runner-repository.ts';

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_REBASE_COMMITS = 500;
// runInProcessGroup can spend 1 s delivering SIGTERM, 10 s draining descendants, and 1 s draining held pipes.
const PROCESS_SETTLEMENT_RESERVE_MS = 13_000;
// Cleanup receives an operation-wide 30 s: 13 s to settle a cleanup process group and 17 s for Git and follow-up calls.
const CLEANUP_RESERVE_MS = 30_000;
const MIN_REBASE_TIMEOUT_MS = CLEANUP_RESERVE_MS + PROCESS_SETTLEMENT_RESERVE_MS + 1;

export interface RebaseMapping { oldSha: string; newSha: string }
export interface RebaseResult { oldHead: string; base: string; head: string; mappings: RebaseMapping[] }
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
}
interface CallScope { attemptId: string; signal?: AbortSignal; deadline: number; workDeadline: number }

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

  constructor(options: GitRebaserOptions) {
    if (!/^[0-9a-f]{32}$/.test(options.runnerOwner)) throw new Error('Invalid runner owner token.');
    if (!options.committer.name || !options.committer.email || /[<>\n\r\0]/.test(options.committer.name + options.committer.email))
      throw new Error('A valid rebase committer is required.');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < MIN_REBASE_TIMEOUT_MS || options.timeoutMs > 120_000))
      throw new Error('Invalid rebase deadline.');
    this.#options = options;
    this.#root = ownerOnlyDirectory(options.runnerRoot, options.runnerOwner, 'rebases');
  }

  async run(input: { attemptId: string; oldBase: string; oldHead: string; onto: string; signal?: AbortSignal }): Promise<RebaseResult> {
    const { attemptId, oldBase, oldHead, onto, signal } = input;
    rebaseRef(attemptId);
    for (const value of [oldBase, oldHead, onto]) if (!COMMIT_ID.test(value)) throw new Error('A full commit ID is required for rebasing.');
    signal?.throwIfAborted();
    const scope = this.#scope(attemptId, signal);
    const old = await this.#history(this.#options.repository.path, oldBase, oldHead, scope);
    if (onto === oldBase) return { oldHead, base: onto, head: oldHead, mappings: old.map(sha => ({ oldSha: sha, newSha: sha })) };

    const path = this.#path(attemptId);
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('The rebase workspace already exists.');
    const ref = rebaseRef(attemptId);
    const existing = await this.#call(this.#options.repository.path, ['show-ref', '--verify', '--quiet', ref], scope);
    this.#throwIfCancelled(existing, scope);
    if (existing.status === 0) throw new Error('This rebase attempt already has a retained result.');
    if (existing.status !== 1) throw this.#failure('show-ref', existing);
    let added = false, retained = false, uncertainRef = false, attemptedRef: string | undefined;
    let result: RebaseResult | undefined, primary: unknown;
    try {
      await this.#git(this.#options.repository.path, ['worktree', 'add', '--detach', '--', path, oldHead], scope);
      added = true;
      // Git can report a successful checkout even when the host filesystem cannot represent the tree (for example,
      // case-colliding or normalization-colliding names on default macOS volumes). Hash the files into the index and
      // compare trees; status/stat-cache metadata is not proof that the contents are unchanged.
      await this.#assertCheckout(path, oldHead, 'reviewed head', scope);
      const outcome = await this.#call(path, ['rebase', '--quiet', '--reapply-cherry-picks', '--keep-empty', '--empty=keep', '--onto', onto, oldBase, oldHead], scope, false, true);
      this.#throwIfCancelled(outcome, scope);
      if (outcome.status !== 0) {
        if (outcome.status === null || outcome.error) throw this.#failure('rebase', outcome);
        // Rebase diagnostics can grow with valid commit messages and path counts. The index, not bounded text, proves a conflict.
        const conflicted = await this.#call(path, ['diff', '--quiet', '--ignore-submodules=all', '--diff-filter=U', '--'], scope);
        this.#throwIfCancelled(conflicted, scope);
        if (conflicted.status === 1) throw new RebaseConflict('The rebase has conflicts and needs review.');
        if (conflicted.status !== 0) throw this.#failure('diff', conflicted);
        throw this.#failure('rebase', outcome);
      }
      const head = await this.#git(path, ['rev-parse', '--verify', 'HEAD^{commit}'], scope);
      if (!COMMIT_ID.test(head)) throw new Error('Git returned an invalid rebased head.');
      await this.#assertCheckout(path, head, 'rebased head', scope);
      const next = await this.#history(path, onto, head, scope);
      if (next.length !== old.length) throw new Error('The rebase did not preserve one commit for every task commit.');
      attemptedRef = head;
      const created = await this.#call(this.#options.repository.path, ['update-ref', ref, head, '0'.repeat(head.length)], scope);
      if (created.status === 0) retained = true;
      else if (created.status === null) uncertainRef = true;
      this.#throwIfCancelled(created, scope);
      if (created.status !== 0) {
        // A null status can mean the ref write landed but its settlement record did not. Cleanup reconciles that exact
        // attempted value. A normal nonzero exit proves atomic creation refused and must preserve the winning ref.
        throw this.#failure('update-ref', created);
      }
      result = { oldHead, base: onto, head, mappings: old.map((oldSha, index) => ({ oldSha, newSha: next[index]! })) };
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
    if ((retained && primary && signal?.aborted) || (!retained && uncertainRef)) {
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
  async abort(attemptId: string): Promise<void> {
    const ref = rebaseRef(attemptId), path = this.#path(attemptId), stat = lstatSync(path, { throwIfNoEntry: false });
    const scope = this.#scope(attemptId);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('The rebase workspace is not a plain directory.');
    await this.#remove(path, scope);
    await this.#git(this.#options.repository.path, ['update-ref', '-d', ref], scope, true);
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
    const verified = await this.#process(process.execPath, [verifier], repository, {}, scope, false, 64 * 1024);
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

  async #git(repository: string, args: readonly string[], scope: CallScope, cleanup = false): Promise<string> {
    const outcome = await this.#call(repository, args, scope, cleanup);
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
      ...gitEnvironment(),
      GIT_COMMITTER_NAME: this.#options.committer.name,
      GIT_COMMITTER_EMAIL: this.#options.committer.email,
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
    };
    return this.#process('git', [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], repository,
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

  #failure(command: string, outcome: DockerOutcome, program = 'git'): Error {
    if (outcome.status === null && outcome.error) return outcome.error;
    const detail = (outcome.status === null && outcome.error ? outcome.error.message :
      outcome.stderr.trim() || outcome.stdout.trim() || outcome.error?.message || 'unknown failure').slice(0, 400);
    return new Error(`${program} ${command} failed${outcome.status === null ? '' : ` (exit ${outcome.status})`}: ${JSON.stringify(detail)}`);
  }
}

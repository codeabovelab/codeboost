import { spawn } from 'node:child_process';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import { MAX_REVIEW_PROMPT_BYTES, type ReviewDiff } from '../core/review-prompt.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';

/** The longest diff shown: a data block's 32 KiB string (`dataJSON`). */
const MAX_FILE_DIFF_BYTES = MAX_PROMPT_BYTES;
/** The changed-path list's ceiling. A larger list fails the review's preparation instead of being cut. */
const MAX_PATH_LIST_BYTES = 16 * 1024 * 1024;
/**
 * `--text`: in-tree attributes (`-diff`, `binary`) are the agent's to write, so they never decide what the review
 * sees; real binary content is caught by the UTF-8 and NUL checks below. `-M`: a renamed file is shown as its rename
 * and its edits, not as a whole delete and a whole add. `--ignore-submodules=all` keeps Git out of submodules, whose
 * config is not the runner's (AGENTS.md); an agent cannot change their contents anyway.
 */
const DIFF_OPTIONS = ['--text', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--ignore-submodules=all'];

interface GitOutput { status: number | null; stdout: Buffer; over: boolean }
/**
 * Run hardened Git and keep at most `limit` bytes of its stdout; past that, Git is killed and `over` is set. Its stderr
 * is drained and not read: Git can print hints there (for example about the empty graft file the hardened environment
 * names), and the exit status says whether it failed. When `signal` aborts, Git is killed, and the promise rejects
 * only once Git has exited, so nothing still reads the repository.
 */
function git(executable: string, repository: string, args: string[], limit: number, signal: AbortSignal): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, [...GIT_OPTIONS, ...args], { cwd: repository, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0, over = false, failure: unknown;
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (over) return;
      if (chunk.length > limit - size) { chunks.push(chunk.subarray(0, limit - size)); size = limit; over = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk); size += chunk.length;
    });
    child.stderr.resume();
    child.on('error', error => { failure ??= error; });
    child.on('close', status => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else resolve({ status: over ? null : status, stdout: Buffer.concat(chunks), over });
    });
  });
}

/** The most other changed paths one file's diff excludes by name (a rename into a directory of its own name). */
const MAX_NAMED_EXCLUDES = 1000;
/**
 * Pathspecs for exactly `paths`, or null when they would need more than MAX_NAMED_EXCLUDES excludes. A literal path
 * matches the files under it too, so those are excluded: as a whole directory, or, where one of `paths` is under
 * another (a file renamed into a directory of its own name), as each other changed path under it, by name.
 */
function exactly(paths: readonly string[], changed: readonly string[]): string[] | null {
  const specs = paths.map(path => `:(literal)${path}`);
  for (const path of paths) {
    if (!paths.some(other => other.startsWith(`${path}/`))) { specs.push(`:(exclude,literal)${path}/`); continue; }
    for (const other of changed) if (!paths.includes(other) && other.startsWith(`${path}/`)) specs.push(`:(exclude,literal)${other}`);
  }
  return specs.length - paths.length > MAX_NAMED_EXCLUDES ? null : specs;
}

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). A renamed file is listed by its new path, and its diff shows the rename. The diff is null
 * where the prompt cannot carry it: not UTF-8 text without NUL, longer than 32 KiB, after the paths before it alone
 * already fill a whole prompt (so at most a few thousand diffs are read), or a rename into a directory of its own name
 * among more than a thousand other changes there. The agent reads those files at the head.
 *
 * Git runs without system or global config, hooks, replace objects, external diff or text conversion programs, in-tree
 * diff attributes or submodules, one file at a time, with pathspecs that match only that file, and its output is
 * bounded. `signal` stops it.
 */
export async function reviewDiffs(repository: string, base: string, head: string, signal: AbortSignal, executable = 'git'): Promise<ReviewDiff[]> {
  for (const commit of [base, head]) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error('Review diffs need full commit IDs.');
  const listed = await git(executable, repository, ['diff', '--name-status', '-z', ...DIFF_OPTIONS, base, head, '--'], MAX_PATH_LIST_BYTES, signal);
  if (listed.over) throw new Error('The list of files the plan changed is too long for a review.');
  if (listed.status !== 0) throw new Error('Git could not list the files the plan changed.');
  const output = listed.stdout;
  if (output.length && output[output.length - 1] !== 0) throw new Error('Git returned an unterminated path record.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fields: string[] = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    try { fields.push(decoder.decode(output.subarray(start, end))); } catch { throw new Error('A changed path is not UTF-8 text.'); }
    start = end + 1;
  }
  // Each record is a status, then its path, or for a rename (R and a score) its old and new paths.
  const records: { path: string; paths: string[] }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (status.startsWith('R')) {
      const from = fields[index++], to = fields[index++];
      if (from === undefined || to === undefined) throw new Error('Git returned an incomplete rename record.');
      records.push({ path: to, paths: [from, to] });
    } else {
      const path = fields[index++];
      if (path === undefined || !/^[ACDMTUX]$/u.test(status)) throw new Error('Git returned an unexpected change record.');
      records.push({ path, paths: [path] });
    }
  }
  const changed = records.flatMap(record => record.paths);
  const changes = records.map(({ path, paths }) => ({ path, pathspecs: exactly(paths, changed) }));
  const diffs: ReviewDiff[] = [];
  // Once the paths so far alone fill a whole prompt, no later diff is read: the prompt can still list a later file with
  // a short path, but with a null diff.
  let listable = 0;
  for (const { path, pathspecs } of changes) {
    listable += Buffer.byteLength(JSON.stringify({ path, diff: null }));
    if (listable > MAX_REVIEW_PROMPT_BYTES || pathspecs === null) { diffs.push({ path, diff: null }); continue; }
    const result = await git(executable, repository, ['diff', ...DIFF_OPTIONS, base, head, '--', ...pathspecs], MAX_FILE_DIFF_BYTES, signal);
    if (!result.over && result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    let diff: string | null = null;
    if (!result.over) { try { diff = decoder.decode(result.stdout); } catch { diff = null; } }
    if (diff?.includes('\0')) diff = null;
    diffs.push({ path, diff });
  }
  return diffs;
}

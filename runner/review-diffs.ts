import { spawn } from 'node:child_process';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import { MAX_REVIEW_PROMPT_BYTES, type ReviewChange, type ReviewDiff } from '../core/review-prompt.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';

/** The longest diff shown: a data block's 32 KiB string (`dataJSON`). */
const MAX_FILE_DIFF_BYTES = MAX_PROMPT_BYTES;
/** The changed-path list's ceiling. A larger list fails the review's preparation instead of being cut. */
const MAX_PATH_LIST_BYTES = 16 * 1024 * 1024;
/**
 * `--text`: in-tree attributes (`-diff`, `binary`) are the agent's to write, so they never decide what the review
 * sees; real binary content is caught by the UTF-8 and NUL checks below. `-M`: a renamed file is shown as its rename
 * and its edits, not as a whole delete and a whole add. `--ignore-submodules=all` keeps Git out of submodules, whose
 * config is not the runner's (AGENTS.md); an agent cannot change their contents anyway. A file turned into a submodule
 * entry, or back, is listed as a type change whose diff shows only the file's side.
 */
const DIFF_OPTIONS = ['--text', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--ignore-submodules=all'];

/** Git's default `diff.renameLimit`, given on the command line so the repository's config cannot change it. */
export const REVIEW_RENAME_LIMIT = 1000;
/** Git 2.54 still exits 0 when it skips rename detection: "warning: exhaustive rename detection was skipped …" ("inexact" in older Gits). */
const RENAMES_SKIPPED = 'rename detection was skipped';
/**
 * The review cannot show the plan's change truthfully, so a person must review it: Git skipped rename detection, and a
 * large renamed file would show only as a delete and an add, hiding its edits.
 */
export class ReviewDiffsRefused extends Error {}

interface GitOutput { status: number | null; stdout: Buffer; over: boolean; renamesSkipped: boolean }
/**
 * Run hardened Git and keep at most `limit` bytes of its stdout; past that, Git is killed and `over` is set. Its stderr
 * is searched as it arrives for the rename-skip warning (`renamesSkipped`), so no amount of other messages can hide it,
 * and is not kept: other messages (for example about the empty graft file the hardened environment names) are hints. When `signal` aborts, Git is killed, and the promise rejects
 * only once Git has exited, so nothing still reads the repository.
 */
function git(executable: string, repository: string, args: string[], limit: number, signal: AbortSignal): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // A repository made on macOS sets core.precomposeunicode, which turns a decomposed name in a pathspec into its
    // composed form: the agent's commits keep names exactly as written, so the pathspec must too.
    const child = spawn(executable, [...GIT_OPTIONS, '-c', 'core.precomposeunicode=false', ...args], { cwd: repository, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0, over = false, failure: unknown, renamesSkipped = false, tail = '';
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (over) return;
      if (chunk.length > limit - size) { chunks.push(chunk.subarray(0, limit - size)); size = limit; over = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk); size += chunk.length;
    });
    // The last few characters carry over, so a warning split between two chunks is still found.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = tail + chunk;
      if (text.includes(RENAMES_SKIPPED)) renamesSkipped = true;
      tail = text.slice(-RENAMES_SKIPPED.length);
    });
    child.on('error', error => { failure ??= error; });
    child.on('close', status => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else resolve({ status: over ? null : status, stdout: Buffer.concat(chunks), over, renamesSkipped });
    });
  });
}

/**
 * The most bytes of named excludes one file's diff passes (a rename into a directory of its own name): far under the
 * operating systems' limits on a command's arguments (1 MiB on macOS, about 2 MiB on Linux).
 */
const MAX_NAMED_EXCLUDE_BYTES = 64 * 1024;
/**
 * Pathspecs for exactly `paths`, or null when they would need more than MAX_NAMED_EXCLUDE_BYTES of excludes. A literal
 * path matches the files under it too, so those are excluded: as a whole directory, or, where one of `paths` is under
 * another (a file renamed into a directory of its own name), as each other changed path under it, by name. `sorted` is
 * every changed path in code-unit order, so the paths under one directory are found by a binary search.
 */
function exactly(paths: readonly string[], sorted: readonly string[]): string[] | null {
  const specs = paths.map(path => `:(literal)${path}`);
  let bytes = 0;
  for (const path of paths) {
    if (!paths.some(other => other.startsWith(`${path}/`))) { specs.push(`:(exclude,literal)${path}/`); continue; }
    const prefix = `${path}/`;
    let low = 0, high = sorted.length;
    while (low < high) { const mid = (low + high) >> 1; if (sorted[mid]! < prefix) low = mid + 1; else high = mid; }
    for (let index = low; index < sorted.length && sorted[index]!.startsWith(prefix); index++) {
      const other = sorted[index]!;
      if (paths.includes(other)) continue;
      const spec = `:(exclude,literal)${other}`;
      if ((bytes += Buffer.byteLength(spec) + 1) > MAX_NAMED_EXCLUDE_BYTES) return null;
      specs.push(spec);
    }
  }
  return specs;
}

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). A renamed file is listed by its new path, and its diff shows the rename. The diff is null
 * where the prompt cannot carry it: not UTF-8 text without NUL, longer than 32 KiB, after the paths before it alone
 * already fill a whole prompt (so at most a few thousand diffs are read), or a rename into a directory of its own name
 * among other changes there whose names pass 64 KiB. The agent reads those files at the head.
 *
 * Git runs without system or global config, hooks, replace objects, external diff or text conversion programs or
 * submodules, and with `--text`, so no in-tree attribute can hide or replace a diff's lines (a built-in diff driver
 * named there can still change a hunk header's function context). It runs one file at a time, with pathspecs that match
 * only that file, and its output is
 * bounded. `signal` stops it.
 */
export async function reviewDiffs(repository: string, base: string, head: string, signal: AbortSignal,
  options: { executable?: string; renameLimit?: number } = {}): Promise<ReviewDiff[]> {
  const { executable = 'git', renameLimit = REVIEW_RENAME_LIMIT } = options;
  for (const commit of [base, head]) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error('Review diffs need full commit IDs.');
  const listed = await git(executable, repository, ['diff', '--name-status', '-z', ...DIFF_OPTIONS, `-l${renameLimit}`, base, head, '--'], MAX_PATH_LIST_BYTES, signal);
  if (listed.over) throw new Error('The list of files the plan changed is too long for a review.');
  if (listed.status !== 0) throw new Error('Git could not list the files the plan changed.');
  if (listed.renamesSkipped)
    throw new ReviewDiffsRefused(`Git skipped rename detection: the plan adds and deletes too many files for it (Git's rename limit is ${renameLimit}), so a renamed file's edits cannot be shown to the review.`);
  const output = listed.stdout;
  if (output.length && output[output.length - 1] !== 0) throw new Error('Git returned an unterminated path record.');
  // `ignoreBOM`: a leading U+FEFF is part of a name (or a diff), not a mark to drop.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const fields: string[] = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    try { fields.push(decoder.decode(output.subarray(start, end))); } catch { throw new Error('A changed path is not UTF-8 text.'); }
    start = end + 1;
  }
  // Each record is a status, then its path, or for a rename (R and a score) its old and new paths.
  const records: { path: string; paths: string[]; change: ReviewChange; from: string | null }[] = [];
  const kinds: Record<string, ReviewChange> = { A: 'added', D: 'deleted', M: 'modified', T: 'type changed' };
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (status.startsWith('R')) {
      const from = fields[index++], to = fields[index++];
      if (from === undefined || to === undefined) throw new Error('Git returned an incomplete rename record.');
      records.push({ path: to, paths: [from, to], change: 'renamed', from });
    } else {
      const path = fields[index++];
      const change = kinds[status];
      if (path === undefined || change === undefined) throw new Error('Git returned an unexpected change record.');
      records.push({ path, paths: [path], change, from: null });
    }
  }
  const sorted = records.flatMap(record => record.paths).sort();
  const diffs: ReviewDiff[] = [];
  // Once the paths so far alone fill a whole prompt, no later diff is read: the prompt can still list a later file with
  // a short path, but with a null diff.
  let listable = 0;
  for (const { path, paths, change, from } of records) {
    listable += Buffer.byteLength(JSON.stringify({ path, diff: null, change, from }));
    // Built only for a diff that is read, so the bound above also bounds this work.
    const pathspecs = listable > MAX_REVIEW_PROMPT_BYTES ? null : exactly(paths, sorted);
    if (pathspecs === null) { diffs.push({ path, diff: null, change, from }); continue; }
    const result = await git(executable, repository, ['diff', ...DIFF_OPTIONS, `-l${renameLimit}`, base, head, '--', ...pathspecs], MAX_FILE_DIFF_BYTES, signal);
    if (!result.over && result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    let diff: string | null = null;
    if (!result.over) { try { diff = decoder.decode(result.stdout); } catch { diff = null; } }
    // A listed change always prints at least its header: empty output means the pathspec missed it, so it is not shown.
    if (diff === '' || diff?.includes('\0')) diff = null;
    diffs.push({ path, diff, change, from });
  }
  return diffs;
}

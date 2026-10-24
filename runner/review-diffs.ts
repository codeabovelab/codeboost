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

/**
 * Pathspecs for exactly `paths`: a literal path matches the files under it too, so those are excluded, except where
 * one of `paths` is under another (a file renamed into a directory of its own name, say), which an exclude would hide.
 */
const exactly = (...paths: string[]) => [...paths.map(path => `:(literal)${path}`),
  ...paths.filter(path => !paths.some(other => other.startsWith(`${path}/`))).map(path => `:(exclude,literal)${path}/`)];

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). A renamed file is listed by its new path, and its diff shows the rename. The diff is null
 * where the prompt cannot carry it: not UTF-8 text without NUL, longer than 32 KiB, or after the paths before it alone
 * already fill a whole prompt (so at most a few thousand diffs are read). The agent reads those files at the head.
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
  const changes: { path: string; pathspecs: string[] }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (status.startsWith('R')) {
      const from = fields[index++], to = fields[index++];
      if (from === undefined || to === undefined) throw new Error('Git returned an incomplete rename record.');
      changes.push({ path: to, pathspecs: exactly(from, to) });
    } else {
      const path = fields[index++];
      if (path === undefined || !/^[ACDMTUX]$/u.test(status)) throw new Error('Git returned an unexpected change record.');
      changes.push({ path, pathspecs: exactly(path) });
    }
  }
  const diffs: ReviewDiff[] = [];
  // The prompt can list a file with a null diff where its diff does not fit, so a file after the others' paths alone
  // fill a whole prompt can never be listed: its diff is not read.
  let listable = 0;
  for (const { path, pathspecs } of changes) {
    listable += Buffer.byteLength(JSON.stringify({ path, diff: null }));
    if (listable > MAX_REVIEW_PROMPT_BYTES) { diffs.push({ path, diff: null }); continue; }
    const result = await git(executable, repository, ['diff', ...DIFF_OPTIONS, base, head, '--', ...pathspecs], MAX_FILE_DIFF_BYTES, signal);
    if (!result.over && result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    let diff: string | null = null;
    if (!result.over) { try { diff = decoder.decode(result.stdout); } catch { diff = null; } }
    if (diff?.includes('\0')) diff = null;
    diffs.push({ path, diff });
  }
  return diffs;
}

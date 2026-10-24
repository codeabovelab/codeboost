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
 * sees; real binary content is caught by the UTF-8 and NUL checks below. `--ignore-submodules=all` keeps Git out of
 * submodules, whose config is not the runner's (AGENTS.md); an agent cannot change their contents anyway.
 */
const DIFF_OPTIONS = ['--text', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all'];
/** Each diff header starts a line, and every other diff line starts with ' ', '+', '-', '@' or '\'. */
const HEADER = Buffer.from('\ndiff --git ');

interface GitOutput { status: number | null; stdout: Buffer; over: boolean }
/**
 * Run hardened Git and keep at most `limit` bytes of its stdout; past that, Git is killed and `over` is set. Its stderr
 * is drained and not read: Git can print hints there (for example about the empty graft file the hardened environment
 * names), and the exit status says whether it failed.
 */
function git(executable: string, repository: string, args: string[], limit: number, signal: AbortSignal): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, [...GIT_OPTIONS, '--literal-pathspecs', ...args],
      { cwd: repository, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (over) return;
      const room = limit - size;
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size = limit; over = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk); size += chunk.length;
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', status => resolve({ status: over ? null : status, stdout: Buffer.concat(chunks), over }));
  });
}

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). The diff is null where the prompt cannot carry it: not UTF-8 text without NUL, longer than
 * 32 KiB, or after the diffs before it have already filled a whole prompt (none after that could be listed). The agent
 * reads those files at the head.
 *
 * Git runs without system or global config, hooks, replace objects, external diff or text conversion programs, in-tree
 * diff attributes or submodules, with literal pathspecs, one file at a time, and its output is bounded. A literal
 * pathspec still matches a directory's files, so each file's diff keeps only its own section. `signal` stops it.
 */
export async function reviewDiffs(repository: string, base: string, head: string, signal: AbortSignal, executable = 'git'): Promise<ReviewDiff[]> {
  for (const commit of [base, head]) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error('Review diffs need full commit IDs.');
  const listed = await git(executable, repository, ['diff', '--name-only', '-z', ...DIFF_OPTIONS, base, head, '--'], MAX_PATH_LIST_BYTES, signal);
  if (listed.over) throw new Error('The list of files the plan changed is too long for a review.');
  if (listed.status !== 0) throw new Error('Git could not list the files the plan changed.');
  const names = listed.stdout;
  if (names.length && names[names.length - 1] !== 0) throw new Error('Git returned an unterminated path record.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths: string[] = [];
  for (let start = 0; start < names.length;) {
    const end = names.indexOf(0, start);
    try { paths.push(decoder.decode(names.subarray(start, end))); } catch { throw new Error('A changed path is not UTF-8 text.'); }
    start = end + 1;
  }
  const diffs: ReviewDiff[] = [];
  let shown = 0;
  for (const path of paths) {
    if (shown > MAX_REVIEW_PROMPT_BYTES) { diffs.push({ path, diff: null }); continue; }
    // One byte past the longest diff, so a complete section of exactly 32 KiB is told apart from a longer one.
    const result = await git(executable, repository, ['diff', ...DIFF_OPTIONS, base, head, '--', path], MAX_FILE_DIFF_BYTES + HEADER.length, signal);
    if (!result.over && result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    // This file's own section: a later header belongs to a file under it (a file replaced by a directory, say).
    const next = result.stdout.indexOf(HEADER);
    const own = next === -1 ? (result.over ? null : result.stdout) : result.stdout.subarray(0, next + 1);
    let diff: string | null = null;
    if (own && own.length <= MAX_FILE_DIFF_BYTES) { try { diff = decoder.decode(own); } catch { diff = null; } }
    if (diff?.includes('\0')) diff = null;
    if (diff !== null) shown += Buffer.byteLength(diff);
    diffs.push({ path, diff });
  }
  return diffs;
}

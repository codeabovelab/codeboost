import { spawn } from 'node:child_process';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import type { ReviewDiff } from '../core/review-prompt.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';

/** The longest diff shown: a data block's 32 KiB string (`dataJSON`). Git is not read past it. */
const MAX_FILE_DIFF_BYTES = MAX_PROMPT_BYTES;
/** The changed-path list's ceiling. A larger list fails the review's preparation instead of being cut. */
const MAX_PATH_LIST_BYTES = 16 * 1024 * 1024;
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none'];

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
      if (size + chunk.length > limit) { over = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk); size += chunk.length;
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', status => resolve({ status: over ? null : status, stdout: Buffer.concat(chunks), over }));
  });
}

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). A diff that is not UTF-8 text without NUL, or longer than 32 KiB, is null: the agent
 * reads that file at the head. Git runs hardened (no hooks, replace objects, config or external diff programs), with
 * literal pathspecs, one file at a time, and its output is bounded. `signal` stops it.
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
  for (const path of paths) {
    const result = await git(executable, repository, ['diff', ...DIFF_OPTIONS, base, head, '--', path], MAX_FILE_DIFF_BYTES, signal);
    // Longer than a data block's string: never shown, so not read further.
    if (result.over) { diffs.push({ path, diff: null }); continue; }
    if (result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    let diff: string | null;
    try { diff = decoder.decode(result.stdout); } catch { diff = null; }
    diffs.push({ path, diff: diff?.includes('\0') ? null : diff });
  }
  return diffs;
}

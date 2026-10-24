import { spawnSync } from 'node:child_process';
import { MAX_PROMPT_BYTES } from '../core/planning-author.ts';
import type { ReviewDiff } from '../core/review-prompt.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';

/**
 * How much of one file's diff is read: well past a data block's 32 KiB string (`dataJSON`), which is what decides
 * whether a diff is shown. The margin is for Git's stderr: Node stops at this many bytes of output in all, and Git can
 * print hints there (for example about the empty graft file the hardened environment names).
 */
const MAX_FILE_OUTPUT_BYTES = 2 * MAX_PROMPT_BYTES + 64 * 1024;
/** The changed-path list's ceiling. A larger list fails the review's preparation instead of being cut. */
const MAX_PATH_LIST_BYTES = 16 * 1024 * 1024;
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none'];

/**
 * Every file that differs between `base` and `head` in `repository`, in Git's path order, with its `git diff` text for
 * the review prompt (#201). A diff that is not UTF-8 text without NUL, or longer than 32 KiB, is null: the agent
 * reads that file at the head. Git runs hardened (no hooks, replace objects, config or external diff programs), with
 * literal pathspecs, and its output is bounded.
 */
export function reviewDiffs(repository: string, base: string, head: string, executable = 'git'): ReviewDiff[] {
  for (const commit of [base, head]) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error('Review diffs need full commit IDs.');
  const git = (args: string[], maxBuffer: number) => spawnSync(executable, [...GIT_OPTIONS, '--literal-pathspecs', ...args],
    { cwd: repository, env: gitEnvironment(), maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  const listed = git(['diff', '--name-only', '-z', ...DIFF_OPTIONS, base, head, '--'], MAX_PATH_LIST_BYTES);
  if (listed.error || listed.status !== 0) throw new Error('Git could not list the files the plan changed.');
  const names = listed.stdout;
  if (names.length && names[names.length - 1] !== 0) throw new Error('Git returned an unterminated path record.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths = names.length ? names.subarray(0, -1).toString('binary').split('\0').map(raw => {
    try { return decoder.decode(Buffer.from(raw, 'binary')); } catch { throw new Error('A changed path is not UTF-8 text.'); }
  }) : [];
  return paths.map(path => {
    const result = git(['diff', ...DIFF_OPTIONS, base, head, '--', path], MAX_FILE_OUTPUT_BYTES);
    // Longer than a data block's string, whether Node stopped reading it (ENOBUFS) or not: never shown.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') return { path, diff: null };
    if (result.error || result.status !== 0) throw new Error(`Git could not show the change to ${path}.`);
    if (result.stdout.length > MAX_PROMPT_BYTES) return { path, diff: null };
    let diff: string;
    try { diff = decoder.decode(result.stdout); } catch { return { path, diff: null }; }
    return { path, diff: diff.includes('\0') ? null : diff };
  });
}

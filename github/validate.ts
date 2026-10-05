/** Shapes the GitHub adapters accept, kept in one place so the adapters cannot drift apart. */
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SHA = /^[a-f0-9]{40}$/;
/** A conservative branch name: no leading dash, no `..` or `//`, no trailing `.` or `/`. */
export const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/;

/**
 * The branch a task's PR targets: `github.baseBranch`, required with a runner block (#103). Checked before anything is
 * created; Git's own refusal would come only after a run, at the push or the opening.
 */
export function baseBranch(github: { baseBranch?: unknown } | undefined): string {
  const name = github?.baseBranch;
  // A short branch name, as GitHub's pull request API takes it: not a full ref (`refs/heads/main`) and not HEAD.
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || /\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)|[./]$/.test(name)
    || name === 'HEAD' || name.startsWith('refs/'))
    throw new Error('The runner publishes pull requests: add github.baseBranch, the branch they target (for example "main"), to the review configuration.');
  return name;
}

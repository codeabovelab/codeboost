import { CommandFailed } from '../../github/run-with-input.ts';

/**
 * gh's failed exit as `runWithInput` (github/run-with-input.ts) reports it: a CommandFailed whose message is
 * `gh failed (exit N): ` plus the first 2,000 characters of stderr, then, when stdout is not empty, a newline and the first
 * 2,000 characters of stdout. `stderr` and `stdout` are kept whole, already trimmed as runWithInput trims them.
 */
export function ghFailedExit(exitCode: number, stderr: string, stdout: string): CommandFailed {
  return new CommandFailed(`gh failed (exit ${exitCode}): ${stderr.slice(0, 2000)}${stdout ? `\n${stdout.slice(0, 2000)}` : ''}`,
    stderr, stdout);
}

/**
 * gh's own exit for an issue read of an issue that does not exist. Checked with gh 2.102.0
 * (`gh api repos/cli/cli/issues/999999999`): exit status 1, `gh: Not Found (HTTP 404)` on stderr, and GitHub's JSON body
 * on stdout. The tests that use it read only the error's class (through `ghAnswered`) and its message, not the separate
 * stderr and stdout fields.
 */
export function ghIssueNotFound(): CommandFailed {
  return ghFailedExit(1, 'gh: Not Found (HTTP 404)',
    '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/issues/issues#get-an-issue","status":"404"}');
}

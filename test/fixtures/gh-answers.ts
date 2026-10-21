import { CommandFailed } from '../../github/run-with-input.ts';

/**
 * gh's own exit for an issue read of an issue that does not exist, as `runWithInput` reports it. Checked with gh 2.102.0
 * (`gh api repos/cli/cli/issues/999999999`): exit status 1, `gh: Not Found (HTTP 404)` on stderr, and GitHub's JSON body
 * on stdout. The message joins them as `runWithInput` does. The tests that use it read only the error's class (through
 * `ghAnswered`) and its message, not the separate stderr and stdout fields.
 */
export function ghIssueNotFound(): CommandFailed {
  const stderr = 'gh: Not Found (HTTP 404)';
  const stdout = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/issues/issues#get-an-issue","status":"404"}';
  return new CommandFailed(`gh failed (exit 1): ${stderr}\n${stdout}`, stderr, stdout);
}

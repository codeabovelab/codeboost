# Opening the task's pull request (F2d)

**Who this is for:** people who build or review lane F, the runner.
**What it covers:** what codeboost does after a task's plan items have run: the check for whether the issue is already fixed, then opening the task's pull request (PR), or a draft PR when the task needs a person.

## Summary

- Before it opens a PR, codeboost checks whether the issue is already fixed. A match, or a check that cannot be completed, opens no PR. A running task then moves to **possibly already fixed**.
- When the check is clear, codeboost pushes the task head to the task's branch and opens the PR. The task moves to **in review**.
- A task in **needs human** gets a draft PR with its open problems. If the check matches, no draft is opened and the task stays in needs human.
- A later run of the same task reuses its PR while it is still open. It does not open a second one.
- codeboost records each opening before it calls GitHub. If the outcome is lost, the next publish finds the PR by a marker in its description. An opening that GitHub does not show yet stays owned for 10 minutes before it is abandoned.
- A GitHub response changes the task status only if the task is unchanged since the call began.

## Terms

| Term | Meaning |
|---|---|
| Check | The pre-PR "already fixed" check in `github/already-fixed.ts`. |
| Own PR | A PR that codeboost opened for this task, identified by repository and number. |
| Own commit | A commit in the task's ledger with origin `owned`. |
| Opening | The Store record written just before the GitHub call that opens a PR. Its state is `opening`, `opened` or `abandoned`. |
| Marker | The HTML comment `<!-- codeboost:opening=<opening ID> -->` at the top of the PR description. |
| Publish | `PullRequestPublisher.publish` in `runner/publish.ts`: the check, push, and open (or reuse) steps together. |

## The check

The check matches when any of these is true:

| Signal | Source | Not a match |
|---|---|---|
| Something other than this task closed the issue. | The issue state and its latest close event (GraphQL). | Closed by an own PR or an own commit. A reopened issue. |
| Another open or merged PR links to the issue. | Cross-reference events, and manual links: "connected" and "disconnected" events replayed in order. | Own PRs, matched by repository and number. Closed, unmerged PRs. A manual link whose latest event is a disconnect. |
| A new commit on the base branch mentions the issue. | The commits from the task's base to the current base branch head. | Own commits. `#123` when the issue is `#12`. `other/repo#12`. |

A commit mentions the issue with `#12`, `GH-12`, `owner/repo#12`, or the issue URL. A PR in another repository that links the issue counts as a match. It is not excluded by number, because its number belongs to another repository.

**The check fails closed.** It returns `unknown` in each of these cases, and `unknown` is handled like a match:

- more than 100 timeline events, or more than 250 new base commits;
- a task base that is not an ancestor of the base branch;
- a closed issue with no close event;
- a linked item that is missing, of an unknown type, or in a malformed response;
- a GitHub error or invalid JSON;
- the whole check running past its single deadline (45 seconds by default). Reaching the deadline stops the running `gh` call.

A cancelled check throws. It does not return `unknown`.

## Publishing

Publish runs these steps in order:

1. **Recover.** If an opening is still `opening`, look for an open PR from the task branch whose description has its marker. If one exists, record it as opened. If none exists, the request may still be in flight or not yet visible. So publish stops with `OpeningUnsettled` until the opening is 10 minutes old (`settleMs`). After that, it marks the opening `abandoned` and continues.
2. **Status and no changes.** Refuse unless the task is running (or in needs human, for a draft). If the task head is its base, open nothing. A running task moves to needs human.
3. **Check.** Run the check. Record the result, and any status change, in one transaction. That transaction refuses if the task changed during the check.
4. **Find the earlier PR.** If the task has an opened PR on the same branch, ask GitHub whether it is still open.
5. **Push.** Re-read the task as in step 6, then push the task head to `codeboost/issue-<issue>-<task slug>-<hash>`. The slug is readable but can collide. The hash is 16 hex characters of SHA-256 over the exact task identity, so two tasks never share a branch.
6. **Re-read.** Right before the GitHub call, the Store confirms that the latest check is clear and that the task is unchanged since that check: same state version, same snapshot, same head.
7. **Open or reuse.** Open a new PR, or update the open earlier PR and mark it ready (or a draft). An update is recorded before it starts. If its confirmation is lost, the next publish drops the record in step 1 and repeats the update after a new check; the update is idempotent. Record the result.

Each opening or refresh owns the task state version at the moment it passed step 6. The PR is always recorded. The status changes only when the task still has that version. Every status change, admission and context change increases the version. So a response that arrives after the task changed never moves it.

| Task during the GitHub call | PR | Status after |
|---|---|---|
| Unchanged, running | Open, head as pushed | in review |
| Unchanged, running | Open, head on GitHub differs from the pushed head | needs human |
| Unchanged, needs human | Draft opened, or the earlier PR updated and turned back into a draft | needs human |
| Changed (cancelled, reassigned, new attempt, new head) | Opened | Unchanged; the PR is recorded so it can be reused or closed later |

The adapter refuses any answer for a PR that is not open. A PR closed between the lookup and the update is never recorded as the task's review PR.

**Environment.** Each `gh` process gets only an allowlist of variables: the path, home and locale; GitHub tokens, host and configuration directories; the D-Bus session bus that Linux keyring sign-in uses; and proxy and CA settings (`github/gh-env.ts`). Prompts, the pager and update checks are turned off.

## The PR description

The description starts with the marker and `Fixes #<issue>`. The plan follows, inside a fenced code block. A draft also lists its open problems inside a fenced code block.

GitHub ignores closing keywords and @-mentions inside code. So plan text or agent output cannot close other issues or notify people. The fence is longer than any run of backticks in the text, so the text cannot end the block.

The description stays under 60,000 characters. If the full plan is too long, only item IDs and titles are listed. At most 20 open problems are shown, each cut to 2,000 characters.

## What this slice does not do

- **Push.** `BranchPusher` is injected. The real push needs D's commit export (#66) and a runner-owned host repository.
- **Continue from possibly already fixed.** The Continue and Cancel actions are user actions for a later slice.
- **Close the draft on cancel.** The design closes the draft PR when a person cancels a needs-human task. The PR record is kept for that.
- **The pre-merge check.** `GhMergeGateway` keeps its own check for now. F6 moves it onto this module. The merge check treats a PR in another repository as `unknown`; this check treats it as a match.

## Tests

`test/already-fixed.test.ts` and `test/publish.test.ts` cover each row above. Each guard was also broken on purpose, and a test failed each time: own-PR and own-commit exclusion, repository-qualified exclusion, every bound, the ancestor check, the fail-closed catch, the issue-number boundary, the state-version and head re-read, the status check before the no-changes shortcut, the version-owned status change, the open-state check, the settle time, the branch hash, the environment allowlist, reuse of the earlier PR, lost-opening recovery, the fence length, and the description bounds.

## Test this document with a reader

Ask someone new to lane F to answer these questions from this page alone. Then fix any section they could not use.

1. Why does a check that cannot be completed open no PR?
2. What happens to a PR that opens after the task was cancelled or reassigned?
3. Why is the second run's PR not a new PR?

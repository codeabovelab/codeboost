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
| Marker | The HTML comment `<!-- codeboost:opening=<opening ID> -->` that is the PR description's first line. Only that line identifies the PR; a marker-shaped string anywhere else (plan text, problems) is ignored. |
| Publish | `PullRequestPublisher.publish` in `runner/publish.ts`: the check, push, and open (or reuse) steps together. |

## The check

The check matches when any of these is true:

| Signal | Source | Not a match |
|---|---|---|
| The issue is closed. | The issue state and its latest close event (GraphQL). The closer is a PR, a commit, or a Projects workflow. A close by the task's own PR or own commit also counts: it means that PR merged, so the fix is already in. | A reopened issue. |
| Another open or merged PR links to the issue. | Cross-reference events that would close the issue (`willCloseTarget`: a closing keyword such as `Fixes #12`). GitHub closes issues only from PRs into the default branch, so `willCloseTarget` is false for every PR into another branch; when the task's base is not the default branch, a PR in this repository into that same base that references the issue counts too (decided 2026-09-30). Manual links: "connected" and "disconnected" events replayed in order. Both sides of a manual link are read, because which side GitHub reports as the subject depends on where the link was made; the linked PR is the side that is a PR, and a link between two PRs or to an unknown type makes the check `unknown`. | The task's own open PRs, matched by repository and number (its own merged PR is a match). Closed, unmerged PRs. A manual link whose latest event is a disconnect. A PR that only mentions the issue, in this repository or another (decided 2026-09-30: on cli/cli a third of open issues had such mentions, mostly merged PRs in unrelated repositories). |
| A new commit on the base branch mentions the issue. | The commits from the task's base to the current base branch head. | Own commits. `#123` when the issue is `#12`. `other/repo#12`. |

A commit mentions the issue with `#12`, `GH-12`, `owner/repo#12`, or the issue URL. A PR in another repository that would close the issue, or is linked manually, counts as a match. It is not excluded by number, because its number belongs to another repository. GitHub turns `willCloseTarget` false once the issue is closed, so a merged PR that closed the issue is reported through the closed state instead.

An abandoned opening's PR has no recorded number, so the check cannot exclude it by number. The main path looks the branch up first and adds a visible PR's number to the own PRs. If GitHub's PR list still does not show that PR after the 10-minute settle time but the issue timeline already does, the check counts the task's own PR as another PR, and the task moves to possibly already fixed. That fails closed: a person sees the PR and continues.

**The check fails closed.** It returns `unknown` in each of these cases, and `unknown` is handled like a match:

- more than 100 timeline events, or more than 250 new base commits;
- a task base that is not an ancestor of the base branch, or a comparison that lists a commit twice;
- a closed issue with no close event;
- a linked item that is missing, of an unknown type, or in a malformed response;
- a GitHub error or invalid JSON;
- the whole check running past its single deadline (12 seconds by default). For the check the runner waits 1 second after SIGTERM before SIGKILL, and half a second for inherited pipes, so the whole check settles within 13.5 seconds, below the 15-second request budget. Reaching the deadline stops the running `gh` call.

A cancelled check throws. It does not return `unknown`.

## Publishing

Only one publish runs per task at a time; a second one is refused. A publish whose signal is already aborted changes nothing. Publish runs these steps in order:

1. **Recover.** First, an update whose confirmation was lost is settled: what GitHub shows for its PR (draft flag and head), in any base, is recorded, and the update is dropped, to be repeated after a new check. A pending update recorded for another repository is refused loudly, not cleared unseen. Then, if an opening is still `opening`, the task's own open PRs from its branch are listed in any base (with the markers of all the task's openings for that branch).
   - **Its PR is there.** It is recorded as opened, wherever it is. If this was a draft opening, this publish is a draft publish too, and the PR has since been made ready, it is turned back into a draft first: a failure keeps the opening owned, except that drafts being unsupported is definite, so the PR is recorded as it is and publishing continues: the main path returns `draft unsupported`, or refuses a PR it would not accept. The recovered opening ends this publish only when it is this publish's own work (same task state version, same review version, same draft mode) and the main path would accept its PR (in the configured base, the task's only open PR). Otherwise publishing continues: the main path pushes the current head and brings the PR into the current mode, or, for a PR it would not accept, makes all the task's PRs drafts and refuses (step 3).
   - **Another of the task's PRs is open into the base this opening asked for.** This opening created nothing (GitHub allows one open PR per branch and base), so it is marked `abandoned`. If that other PR's opening was abandoned too, the main path (a running task) or the draft step (a stopped one) adopts it next.
   - **Nothing.** The request may still be in flight or not yet visible, so publish stops with `OpeningUnsettled` until the opening is 10 minutes old (`settleMs`). After that, it marks the opening `abandoned` and continues.
   **Draft what the task cannot keep ready.** Then, if the task is not in review, approved but merge blocked, or merged, and cannot be published as ready now (cancelled, needs human, possibly already fixed, an attempt active, requeue pending, rebase or merge in progress), every branch with a PR recorded as ready, or with an abandoned opening, is looked up. An abandoned opening's PR that has appeared since is adopted, because the main path, which also adopts it, may refuse first. A task in review, approved or merged has no such step, and publish refuses it on status: recovery still records its lost opening's own PR, but a late PR of another abandoned opening is not adopted or drafted for it. A ready PR is then made a draft, after re-reading the task: one approved meanwhile keeps its PR ready. An approved task's PR is left alone, because GitHub does not merge a draft. A draft flag that GitHub already shows is only recorded. The record saying "ready" is what makes the draft owed. So an earlier draft change that failed (`leftReady`), and a PR that recovery has just recorded, are both drafted by the next publish of that task, even though step 2 then refuses. Only a publish fulfils a draft owed: until something publishes the task again, its PR stays ready. Nothing in the runner calls publish for a cancelled task yet; closing the PR on cancel is a later slice (see "What this slice does not do"). A GitHub failure here does not replace step 2's refusal. The refusal names the PR that may still be ready, and the next publish tries again. A PR that has since closed keeps its "ready" record, and an abandoned opening stays abandoned, so each later publish of that task looks its branch up again.
2. **Status.** Before any other GitHub call, refuse unless the task is running (or in needs human, for a draft), with no attempt active, no merge active, no interrupted work waiting to be requeued, and no rebase in progress.
3. **Find the branch PR.** Ask GitHub for the branch's open PR every time, with the markers of the task's opened and abandoned openings for that branch, whatever their base (none if the task has no PR yet). GitHub allows one open PR per branch and base, so every lookup lists all open PRs from the branch. Two rules follow. **Observing and drafting** (recovery and the draft step in step 1) look for the task's own PRs, those carrying its markers, in any base (`findOwned`): what GitHub shows is recorded, and a PR is made a draft, wherever it is, because both are safe anywhere. So a lost update or opening settles, and a stopped task's PRs are all drafted, even after a base change or a retarget. **Changing content** (push, description update, ready change, opening) happens only on the main path and only in the configured base (`findOpened`): it refuses when the task's own PR is in another base (retargeted by a person, or left by a change of the base setting; retarget it or close it) or when two of the task's PRs are open (close all but one), instead of opening a second PR from the same branch. Anyone else's PR from the branch into another base (a backport, say) is ignored. A PR into the configured base without one of the task's markers is refused as not codeboost's, unless its number is one of the task's recorded PRs: then a person removed its marker, and it is refused as misplaced (restore its first line or close it). GitHub's PR list can lag behind a PR, so when the list shows no PR but the record has an opened one, that PR is read directly (one request per recorded PR, closed ones included): if it is still open on the task branch, into the configured base, with its marker, only the list is behind, and publish stops with `OpeningUnsettled` (retry later) and pushes nothing, because a push would move the open PR's head with no update recorded as in flight. If it is open but a person moved it (renamed its branch, removed its marker, retargeted it), a retry would never see it, so publish refuses with `PullRequestMisplaced`: close it, or restore its branch, base and first line. Before refusing, it makes that PR a draft where it is, while its first line still identifies it; otherwise the refusal says it may still be ready. A marker is read from the description's first line with surrounding white space removed, because GitHub returns a description edited on github.com with CRLF line endings. A record's base is only where the PR was opened. A lost opening counts as having created nothing only when another of the task's PRs is open into the base that opening asked for. Moving the task to in review is a change too: recovery does it only for a PR in the configured base with no other of the task's PRs open. Any other recovered PR is recorded, and the main path's misplaced draft step adopts the task's other open PRs, makes them all drafts and refuses; the task stays as it was. When the main path refuses the task's PRs for their place (another base, or two open), it first makes every one of them a draft, so none stays ready while a person decides. An open PR that carries none of them was not opened by codeboost: publish refuses before anything is pushed. A PR with an opened record's marker but another number is refused too. An abandoned opening whose PR is now visible is adopted here (number, URL and draft state recorded, task status unchanged), whatever the check then says, so the record names every PR the task has on GitHub. When the PR's draft state on GitHub differs from the record, the record is corrected here (for example after a draft change whose record was lost), under the task's state-version guard. This comes before the check: an abandoned opening's PR links the issue and has no recorded number, so only its marker shows it is the task's own, and its number is added to the own PRs for the check. The PR-number mismatch is refused here, before any GitHub change on this branch other than the draft step in step 1, which skips a mismatched PR and only makes PRs safer. If the task head is its base, nothing is published: after the full publish guard (versions, status, no requeue or rebase), an earlier ready PR is turned into a draft (reported as `leftReady` if the repository has no drafts), and a running task moves to needs human.
4. **Check.** Run the check. Record the result, and any status change, in one transaction. That transaction refuses if the task changed during the check.
5. **Push.** When the task already has an open PR, the refresh is recorded first (the push moves that PR's head), then the push runs; otherwise the push runs straight after the check's transaction with no await in between. Push the task head to `codeboost/issue-<issue>-<task slug>-<hash>`. The slug is readable but can collide. The hash is 16 hex characters of SHA-256 over the exact task identity, so two tasks never share a branch. After the push's await the update re-reads the task, its review and its status before any other change to the PR, and again after the description update's await, right before a ready or draft change (`beforeReady`); a change during the push leaves the update in flight and the PR's description and draft state as they were.
6. **Re-read.** Right before the GitHub call, the Store confirms that the latest check is clear and that nothing changed since that check: same task state version, same review version (approvals, choices and notes), same snapshot, same head.
7. **Open or reuse.** Open a new PR (a draft opening that GitHub creates as ready fails, keeping the opening owned; recovery then turns it into a draft. A validation refusal (HTTP 422, for example no commits between base and head, or a PR already open for the branch) is definite: GitHub created nothing, so the opening is abandoned at once and publish fails with `PullRequestRefused`, carrying GitHub's reason, which `gh` prints on stdout. Refusals are recognised from `gh`'s stderr (`gh: <message> (HTTP 422)`) and from GitHub's `errors[].message` fields in the JSON body on stdout, where GitHub puts a validation reason such as drafts being unsupported, never from the raw stdout, which could echo the PR body. A refusal that repeats, such as no commits between base and head when the base branch already contains the task head, fails every publish in the same way until a person acts; each attempt leaves one abandoned opening), or update the open earlier PR (found in step 3 with the markers of every earlier opening, abandoned ones included; an abandoned opening's PR was already adopted in step 3, and an update only ever starts on an opened record) and mark it ready (or a draft). An update is recorded before it starts. If its confirmation is lost, the next publish first records what GitHub shows for it (draft flag and head), then drops the record in step 1 and repeats the update after a new check; the update is idempotent. Record the result.

Each opening or refresh owns the task state version and the plan's review version at the moment it passed step 6. The PR is always recorded. The status changes only when the task still has both (review input such as approvals, choices and notes changes only the review version). Every status change, admission and context change increases the version. So a response that arrives after the task changed never moves it.

| Task during the GitHub call | PR | Status after |
|---|---|---|
| Unchanged, running | Open, head as pushed | in review |
| Unchanged, running | Open, head on GitHub differs from the pushed head (GitHub has not caught up, or someone else pushed) | running; the PR is made a draft and the record keeps the head GitHub reports; the next publish reconciles it |
| Unchanged, needs human | Draft opened, or the earlier PR updated and turned back into a draft | needs human |
| Changed (cancelled, reassigned, reviewed, new attempt, new head) | Opened | Unchanged; the PR is recorded, and made a draft, so a task that is not in review never keeps a ready PR |

The open or update itself has succeeded by then, so if making the PR a draft fails, publish still reports the PR as opened, with `leftReady`, rather than failing. An abort during that draft change is not a failure of it: publish rejects, and the next publish reconciles the PR.

After an update, the read-back polls up to 5 times, half a second apart, until GitHub shows the pushed head, because GitHub updates a PR's head a moment after a push.

When the check matches (or is unknown) and the task's earlier PR is open and ready for review, publish turns it back into a draft. A task that is not being published as ready never leaves its PR ready for review. This happens before the check result is recorded, after re-reading the task, its review and its head: if the task changed during the check, nothing is drafted. If the draft change fails, or GitHub does not show the PR as a draft afterwards, the task is still running, and a retry checks again and repeats it. A refresh likewise fails when GitHub does not show the requested draft or ready state. A PR-number mismatch is refused before any GitHub change.

The adapter refuses any answer for a PR that is not open. A PR closed between the lookup and the update is never recorded as the task's review PR.

**Deadlines.** Each PR operation (open, lookup, refresh, draft change) has one deadline for all of its commands and poll waits together: 60 seconds by default (`operationMs`), combined with the caller's signal. Stopping `gh` at the deadline can take up to 6 seconds more (see Transport), so one operation settles within 66 seconds. A whole publish has no deadline of its own. Its caller bounds it with the signal. A caller that runs publish inside an HTTP request must give it a deadline below the request budget.

**Shutdown.** The publisher reads the coordinator's `closing` flag (the `closing` dependency) and its own flag right before each push, opening, description update and ready change, with no await in between (runner-lifecycle.md, "Irreversible actions"). Either flag refuses with `ShuttingDownError`. An update refused this way stays in flight for the next publish to settle. A draft change on its own is not refused: it only makes a PR safer, and `close()` stops it through the abort. The draft change inside an update comes after `beforeReady`, so it is refused with the update. `close()` sets the publisher's flag, aborts every publish in progress, and awaits their settlement. The server must await `close()` before the Store's write gate closes (shutdown step 3), so a publish's last records still land. Nothing calls the publisher yet; the change that wires it in adds `close()` to the shutdown order.

**Repository.** The publisher refuses a check or PR gateway configured for another repository than its own, because the Store records each PR under the publisher's repository.

**Transport.** The PR title and description go to `gh api --input -` as a JSON body on stdin (`github/run-with-input.ts`), never as arguments: Linux limits one argument to 128 KiB, and a 60,000-character description of multibyte text is larger. The runner settles only after `gh` has exited, including on a timeout or abort: it sends SIGTERM, then SIGKILL after 5 seconds if `gh` is still running, and if a process `gh` started keeps the output pipes open after `gh` exits, it closes them after 1 second. The already-fixed check uses the same runner, so its 12-second deadline always holds. The already-fixed check also waits for both of its reads to settle before it returns.

**Environment.** Each `gh` process gets only an allowlist of variables: the path, home and locale; GitHub tokens, host and configuration directories; the D-Bus session bus that Linux keyring sign-in uses; the Windows system and temporary directories; and proxy and CA settings (`github/gh-env.ts`). Prompts, the pager and update checks are turned off.

**Token scopes.** The check and the PR calls need only the `repo` scope that a default `gh auth login` grants. The timeline query asks for no field that needs more: a Projects closer is read by its type name alone, because any field on `ProjectV2` needs `read:project`, and without that scope GitHub refuses the whole query, which would make every check `unknown`. A test checks the query text for this, and the query was run against GitHub with a default token.

## The PR description

The description starts with the marker and `Fixes #<issue>`. The plan follows, inside a fenced code block. A draft also lists its open problems inside a fenced code block.

GitHub ignores closing keywords and @-mentions inside code. So plan text or agent output cannot notify people from the description, and cannot end the block: the fence is longer than any run of backticks in the text.

Fences do not protect commit messages. A squash or merge commit can carry the PR title and description, and GitHub acts on closing keywords in default-branch commit messages. So every issue reference in the title's summary, the plan and the problems is neutralised: `#7` becomes `＃7`, `GH-7` gets a non-breaking hyphen, and `/issues/7` or `/pull/7` gets a division slash. Only the task's own `Fixes #<issue>` line and the title's `(#<issue>)` remain real references. The title is not fenced, so an @-mention in it would notify: `@name` becomes `＠name` there.

Inside the fences, control characters other than newline and tab, and lone UTF-16 surrogates (also in the title), become U+FFFD, because GitHub may refuse them and that refusal would repeat on every publish. Titles and problems are cut by UTF-16 length, never inside a surrogate pair. An empty summary becomes `codeboost plan`.

The description stays under 60,000 characters. If the full plan is too long, only item IDs and titles are listed. At most 20 open problems are shown, each cut to 2,000 characters.

## Repositories without draft PRs

Some repositories do not support draft PRs (for example private repositories on GitHub Free). GitHub's refusal is a definite outcome, so nothing is left in flight:

| Case | Result |
|---|---|
| A needs-human task has no PR yet | No PR is opened; the opening is marked `abandoned`; publish returns `draft unsupported`. A ready PR is never opened instead, because it would invite review of work that needs a person. |
| A needs-human task has an open ready PR | After a clear check, turning it into a draft comes before the push or any description change, so the refusal leaves the PR exactly as it was; publish returns `draft unsupported` with its number. (A matching check gives `draft skipped` with `leftReady`, and no changes gives `no changes` with `leftReady`.) |
| The check matches and the earlier PR is ready | The result is recorded as usual; publish reports the PR it could not make a draft as `leftReady`. |
| A task that cannot publish has a ready PR | The publish guard's refusal also says which PR stays ready for review. |

## What this slice does not do

- **Repository renames and transfers.** Every PR record is kept under the configured repository name. After a rename or transfer, publish fails closed (the task's PRs are refused or reported as unsettled) until the records are moved; nothing here moves them.

- **Push.** `BranchPusher` is injected. The real push needs D's commit export (#66) and a runner-owned host repository.
- **Continue from possibly already fixed.** The Continue and Cancel actions are user actions for a later slice.
- **Close the draft on cancel.** The design closes the draft PR when a person cancels a needs-human task. The PR record is kept for that.
- **The pre-merge check.** `GhMergeGateway` keeps its own check for now. F6 moves it onto this module. The merge check treats a PR in another repository as `unknown`; this check treats it as a match.

## Tests

`test/already-fixed.test.ts` and `test/publish.test.ts` cover each row above. Each guard was also broken on purpose, and a test failed each time: own-PR and own-commit exclusion, repository-qualified exclusion, every bound, the ancestor check, the fail-closed catch, the issue-number boundary, the state-version and head re-read, the status check before the no-changes shortcut, the version-owned status change, the open-state check, the settle time, the branch hash, the environment allowlist, reuse of the earlier PR, lost-opening recovery, adoption on the main path and counting that PR as the task's own, drafting a PR that a task which cannot publish still has ready, adopting an abandoned opening's PR that appears after the task stopped, the abort checks on the no-changes path and in that draft step (a lookup that fails, one that answers, a draft change that fails and one that lands), recording a late PR by adoption alone, an abort during the head-mismatch draft change, the `closing` checks before a push and before a ready change, `close()` aborting a publish in progress, the repository check, the definite 422 refusal, a retargeted own PR and another base's PR from the branch, refusals matched on stderr and GitHub's `errors[].message` only, the configured base in recovery and the head settle, the draft step finding the task's PR in any base, closing-only cross-references, both sides of a manual link, the query text, the fence length, and the description bounds.

## Test this document with a reader

Ask someone new to lane F to answer these questions from this page alone. Then fix any section they could not use.

1. Why does a check that cannot be completed open no PR?
2. What happens to a PR that opens after the task was cancelled or reassigned?
3. Why is the second run's PR not a new PR?

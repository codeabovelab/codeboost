# One-click merge handoff (F6b of #22)

**Audience:** people who build or review codeboost's runner and merge code.
**Purpose:** say exactly what happens between a click on **Merge PR** and GitHub merging the task's pull request, and what stops it.

## Summary

With a runner, **Merge PR** no longer merges at once. It starts one **merge job** and returns. The job:

1. prepares the merge (refresh, rebase, review check, push, `cmd:` checks), as `prepare-merge` does;
2. waits for GitHub's required checks on the pushed head, for up to 30 minutes;
3. merges through the existing guarded merge, which reruns the already-fixed check and pins the exact head.

Any change that needs a person (a stale approval, a moved pull request, a failing check) stops the job and says why. A task cancelled while the job runs ends it `cancelled`, however the job learns of it. A failing or slow required check, or a refusal from GitHub, moves the task to **approved, merge blocked**; **Retry merge** starts the whole job again. The browser follows the job by polling.

Without a runner, **Merge PR** works as before.

## Terms

| Term | Meaning |
|---|---|
| Merge job | The background work one click starts. One per task at a time. |
| Preparation | `PreMergeCoordinator.start`: refresh, rebase, review check, push of the rewritten head, `cmd:` checks. |
| Readiness | The record preparation leaves when it succeeds. It binds the task state version, review version, snapshot, base, head and command policy. The guarded merge refuses without it. |
| Required checks | The union of the checks GitHub's rulesets and classic branch protection require. |
| Guarded merge | `MergeCoordinator.merge`: two or more fresh inspections, then `gh pr merge --match-head-commit`. |
| Already-fixed check | The check that the issue is not fixed elsewhere: closed, another PR closes it, or a base-branch commit mentions it. |

## The job, step by step

| Step | What happens | It continues when | It stops when |
|---|---|---|---|
| Admission | The click's review token must be current, the task mergeable, the issue trusted (read from GitHub, as for `prepare-merge`), and no merge job, runner attempt, publish or preparation active. The job record is saved under the click's action ID and the click returns the review with the job (`running`, step `preparing`). | always | the token is stale, the issue is not trusted, or something is busy. The refusal is saved under the click's action ID, so a resend replays it; a refusal because the server is shutting down (HTTP 503, also when shutdown stops the click's trust read), or because trust could not be read, saves nothing and may be sent again |
| Prepare | The job records its own `prepare-merge` action and runs preparation. | preparation is `ready` | preparation needs review (job: `review-required`) or fails (job: `failed`) |
| Wait for checks | The job inspects the pull request (fresh) at once, then again after 10 s, with the wait doubling up to 60 s. | every required check succeeds, or the required set was read and is empty, and nothing else blocks | a required check fails, or 30 minutes pass (job: `blocked`, if the preparation still applies: the block re-checks readiness in its transaction, and a review edit or other task change meanwhile ends the job `failed` instead); the pull request moved, another blocker appears, or GitHub cannot be read (job: `failed`; one failed read fails closed rather than retrying) |
| Merge | The job calls the guarded merge with the current review token. Its inspections rerun the already-fixed check. | GitHub merged or queued the head (job: `merged` or `queued`) | GitHub refused (job: `blocked`; `failed` when GitHub refused because the head changed, which needs a fresh review, or when the review, snapshot or plan revision changed while GitHub was asked: the block is for the review the merge attempt was admitted for), validation refused (job: `failed`), or the outcome is unknown (job: `submitted`; the merge attempt reconciles as before) |

While waiting, an unknown mergeability (GitHub is still computing it) and a pending or missing required check keep the job waiting. No inspection starts after the 30 minutes, and one still running when they end is stopped, so only checks seen passing within the limit count. The guarded merge that follows inspects again and may ask GitHub to merge shortly after the limit; it refuses anything no longer clear. Unreadable branch rules never pass. Another blocker outranks a failing check: checks that fail on a head a collaborator pushed say nothing about this review, so the job ends `failed` and the task's status is unchanged.

## Outcomes

| Job state | Task status afterwards | What the person does |
|---|---|---|
| `merged` | merged | nothing |
| `queued` | unchanged (in review, or approved, merge blocked on a retry) while GitHub's queue holds it | nothing |
| `submitted` | unchanged | refresh; the merge attempt settles from GitHub |
| `blocked` | approved, merge blocked | fix the check or GitHub's reason, then **Retry merge**. After GitHub refused a merge, a retry whose preparation rebases makes a new snapshot, and that needs every item approved again (the replacement-snapshot rule of `merge-queue.md`); the retry then ends `failed` and says so. To change the task's code, use the scope-amendment flow, as from review: it accepts a blocked task. |
| `review-required` | unchanged | review the refreshed pull request, then merge again |
| `failed` | unchanged | read the reason, then merge again |
| `cancelled` | cancelled | nothing |

Moving the task to **approved, merge blocked** advances its state version, so the next job prepares again from the start.

## The already-fixed range

A rebase moves the pull request's base. The guarded merge would then scan only the base commits after the new base and miss the ones the rebase brought in. The scan must cover every base commit after the task's original base (the base of its first snapshot), since a rebase can bring any of them under the pull request. Each opening records the pre-PR check it followed (schema v19). That check of the task's **first opening into the current base branch** scanned the branch from its snapshot's base to the branch's tip then, and found nothing. When it scanned from the task's original base, each merge inspection scans from that tip to the branch's tip now. A later rebase onto the branch can bring in any commit after the original base: those up to that tip were scanned by that check, and later ones are in the merge's scan, so the scan covers them whichever of the task's openings into that branch the merge follows (after a re-publish recorded a newer check from a rebased base, and after a person closed the pull request and a new one was opened from a rebased base). A newer check is not a safe start: it scanned only from a rebased base, and a compare range excludes its own start commit. An opening into another base branch, left by a change of the `github.baseBranch` setting, says nothing about this branch and is not used. A first opening recorded before schema v19 has no check; the task's oldest clear check stands in. When there is no such check, or it scanned from a rebased base (the base branch setting changed after a rebase), the scan starts at the task's original base. If that start is not on the base branch (for example, it was force-pushed), the answer is unknown and merging stays blocked. The check reads at most 250 base commits: if more landed since the scan's start, its answer is unknown and merging stays blocked, as for a pull request never rebased. There is no person override yet (the Continue action of `pull-request-opening.md` is a later slice). The task's own commits, the ledger's owned entries, are excluded, as in the pre-PR check. The status shown while a merge attempt is submitting, queued or merged scans from the pull request's base, as before: those inspections follow the attempt's pinned pull request, and no merge is asked for while an attempt is active.

## Cancel, shutdown and restart

| Event | Effect |
|---|---|
| Cancel during preparation | as for `prepare-merge`: the preparation stops, and the task closes when its work has settled |
| Cancel while waiting | the wait stops at once; the task closes; the job ends `cancelled` |
| Cancel during the guarded merge | before GitHub is asked, the merge stops and the job ends `cancelled`; once a merge attempt is submitting, a cancel is refused, as before |
| Shutdown | in shutdown's first, synchronous step, before requests drain, the job is told to stop: a wait ends at once, and nothing after it asks GitHub to merge. A preparation in progress stops only when preparation does, after the drain, as for a `prepare-merge` click; the job then stops without merging. The job is awaited before the store closes. While preparing or waiting, it stays `running` on disk. A guarded merge in progress stops as a click's does: if GitHub was not asked yet, the job stays `running`; if it was, the job ends as the merge attempt records it: `blocked` if GitHub refused (`failed` if the head changed, or the review changed while GitHub was asked), otherwise `submitted`, and the attempt reconciles as before |
| Restart | a `running` job that had not asked GitHub to merge becomes `failed` ("The server restarted before the merge finished"). One that had (its merge action ID is saved before the guarded merge starts) ends as its merge attempt records it: `merged`, `queued`, `submitted`, or `blocked` after a refusal, which also moves the task to approved, merge blocked (`failed`, task unchanged, when the head changed or the review changed while GitHub was asked). A `prepare-merge` action and a push marker are settled as before |

## Storage

Schema v19 adds `task_pull_requests.check_id` (the pre-PR check each opening followed) and `merge_jobs`: one row per job or refused click (`action_id`, task key, `state`, `step`, `reason`, required-check names and states, the merge result URL, times). A refused click's row is marked `refused`: it is replayed to that click and never shown as the task's job. Writing it never changes the task's state version, so the readiness preparation recorded stays valid while the job waits. A resend of the same click returns its row; another click while a job runs is refused.

## API and browser

- `POST /api/action` with `merge` returns `{ job }` at once when a runner is configured.
- `GET /api/merge` returns `{ queue, job }`: `job` is the task's latest job. A saved refusal is not a job; it is replayed only to its own click.
- Merge PR is offered only while the task is in a mergeable status (read after the inspection) and the only blockers left are ones the job resolves or reports: preparation, a moved base (with a merge conflict it causes), `cmd:` checks, required checks (the job waits for pending ones and ends `blocked` on failing ones, so a person can retry after re-running CI), and mergeability GitHub is still computing.
- While a job runs, the Merge button keeps keyboard focus: it is marked `aria-disabled`, not disabled, and a repeat activation starts nothing.
- The browser polls `GET /api/merge` with the existing 2 s to 30 s backoff while a job runs, shows its step in the merge banner, and lists waiting checks in the blocker dialog. When the job ends, the page updates only the merge control and banner (the outcome, and "Refresh to see the result"), so a person's selection and input survive; after **Refresh**, the page offers **Retry merge** when the job is `blocked`. The design's full step list and a Cancel button come later.

## Tests

`test/merge-job.test.ts` runs the job against the real Store and guarded merge with a faked GitHub and preparation. It covers the three wait cases the design names (zero required checks, one check pending then passing, a timeout), a failing check, GitHub still computing mergeability, preparation ending for review or failing, another blocker while waiting, a failed GitHub read while waiting, GitHub's refusal, an unknown merge outcome, a merge queue (`queued`), cancel while waiting (told or not) and during the guarded merge's validation, shutdown while waiting and during the guarded merge, startup settlement, resends, a second click, a stale token, a busy runner, and which blockers keep Merge PR available (including Retry merge after `blocked`). `test/pre-merge.test.ts` runs the #22 acceptance cases through the job with real preparation: a base move that leaves approvals valid merges; a rebase that makes an approval stale stops for review; a breaking command after a rebase fails the job; a collaborator push stops for review; a cancel during a command check ends the job `cancelled`. Server tests cover the merge route, its trust admission (an untrusted click refused and replayed, a failed read saving nothing), `GET /api/merge`, the `prepare-merge` refusal, cancel closing the pull requests, and shutdown; a production test covers startup settlement; a browser test follows a job to merged.

## Check this document with a reader

Before merging, ask someone who did not write it to answer, from this page alone: what one click does, when the task becomes approved, merge blocked, and why a job survives a review edit only by failing.

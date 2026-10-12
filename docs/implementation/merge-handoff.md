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
| Admission | The click's review token must be current, the task mergeable, and no merge job, runner attempt, publish or preparation active. The job record is saved under the click's action ID and the click returns the review with the job (`running`, step `preparing`). | always | the token is stale, or something is busy (nothing is saved; the click may be sent again) |
| Prepare | The job records its own `prepare-merge` action and runs preparation. | preparation is `ready` | preparation needs review (job: `review-required`) or fails (job: `failed`) |
| Wait for checks | The job inspects the pull request (fresh) at once, then again after 10 s, with the wait doubling up to 60 s. | every required check succeeds, or the required set was read and is empty, and nothing else blocks | a required check fails, or 30 minutes pass (job: `blocked`); the pull request moved, or another blocker appears (job: `failed`) |
| Merge | The job calls the guarded merge with the current review token. Its inspections rerun the already-fixed check. | GitHub merged or queued the head (job: `merged` or `queued`) | GitHub refused (job: `blocked`), validation refused (job: `failed`), or the outcome is unknown (job: `submitted`; the merge attempt reconciles as before) |

While waiting, an unknown mergeability (GitHub is still computing it) and a pending or missing required check keep the job waiting. Unreadable branch rules never pass. Another blocker outranks a failing check: checks that fail on a head a collaborator pushed say nothing about this review, so the job ends `failed` and the task stays in review.

## Outcomes

| Job state | Task status afterwards | What the person does |
|---|---|---|
| `merged`, `queued` | merged, or in review while queued | nothing |
| `submitted` | unchanged | refresh; the merge attempt settles from GitHub |
| `blocked` | approved, merge blocked | fix the check or GitHub's reason, then **Retry merge** |
| `review-required` | unchanged | review the refreshed pull request, then merge again |
| `failed` | unchanged | read the reason, then merge again |
| `cancelled` | cancelled | nothing |

Moving the task to **approved, merge blocked** advances its state version, so the next job prepares again from the start.

## The already-fixed range

A rebase moves the pull request's base. The guarded merge would then scan only the base commits after the new base and miss the ones the rebase brought in. Each merge inspection of a runner-published pull request therefore scans from the base of the snapshot on which the pull request's own pre-PR check ran (recorded with the opening, schema v19) to the base branch's tip, even after a re-publish recorded a newer check from a rebased base. An opening recorded before schema v19 uses the latest clear check. The task's own commits, the ledger's owned entries, are excluded, as in the pre-PR check. Without such a check, the scan starts at the pull request's base, as before.

## Cancel, shutdown and restart

| Event | Effect |
|---|---|
| Cancel during preparation | as for `prepare-merge`: the preparation stops, and the task closes when its work has settled |
| Cancel while waiting | the wait stops at once; the task closes; the job ends `cancelled` |
| Cancel during the guarded merge | before GitHub is asked, the merge stops and the job ends `cancelled`; once a merge attempt is submitting, a cancel is refused, as before |
| Shutdown | the job is stopped in shutdown's first, synchronous step, before requests drain, and awaited before the store closes. While preparing or waiting, it stays `running` on disk. A guarded merge in progress stops as a click's does: if GitHub was not asked yet, the job stays `running`; if it was, the job ends as the merge attempt records it: `blocked` if GitHub refused, otherwise `submitted`, and the attempt reconciles as before |
| Restart | a `running` job becomes `failed` ("The server restarted before the merge finished"); a `prepare-merge` action and a push marker are settled as before |

## Storage

Schema v19 adds `merge_jobs`: one row per job (`action_id`, task key, `state`, `step`, `reason`, required-check names and states, the merge result URL, times). Writing it never changes the task's state version, so the readiness preparation recorded stays valid while the job waits. A resend of the same click returns its row; another click while a job runs is refused.

## API and browser

- `POST /api/action` with `merge` returns `{ job }` at once when a runner is configured.
- `GET /api/merge` returns `{ queue, job }`.
- The browser polls `GET /api/merge` with the existing 2 s to 30 s backoff while a job runs, shows its step in the merge banner, lists waiting checks in the blocker dialog, and offers **Retry merge** when the job is `blocked`. The design's full step list and a Cancel button come later.

## Tests

`test/merge-job.test.ts` runs the job against the real Store and guarded merge with a faked GitHub and preparation. It covers the three wait cases the design names (zero required checks, one check pending then passing, a timeout), a failing check, GitHub still computing mergeability, preparation ending for review or failing, another blocker while waiting, GitHub's refusal, an unknown merge outcome, a merge queue (`queued`), cancel while waiting (told or not) and during the guarded merge's validation, shutdown while waiting and during the guarded merge, startup settlement, resends, a second click, a stale token, a busy runner, and which blockers keep Merge PR available (including Retry merge after `blocked`). `test/pre-merge.test.ts` runs the #22 acceptance cases through the job with real preparation: a base move that leaves approvals valid merges; a rebase that makes an approval stale stops for review; a breaking command after a rebase fails the job; a collaborator push stops for review; a cancel during a command check ends the job `cancelled`. Server tests cover the merge route, `GET /api/merge`, the `prepare-merge` refusal, cancel closing the pull requests, and shutdown; a production test covers startup settlement; a browser test follows a job to merged.

## Check this document with a reader

Before merging, ask someone who did not write it to answer, from this page alone: what one click does, when the task becomes approved, merge blocked, and why a job survives a review edit only by failing.

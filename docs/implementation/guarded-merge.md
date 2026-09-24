# Guarded merge gate (#21)

The review screen can now turn a fully approved snapshot into a GitHub merge without trusting browser-supplied SHAs or check results. The browser sends only the current review token. The trusted coordinator reloads the plan, snapshot, approvals, choices, and notes; reads GitHub state itself; and pins the merge to the reviewed head.

## Gate

Merging blocks when any plan item is unreviewed or stale, an Ambiguous or Unplanned segment remains, a current change request is open, or a `cmd:` acceptance check lacks a passing result for the current head. Historical change requests from an earlier revision or snapshot remain visible but do not block the current revision.

The GitHub adapter reads the current PR base/head, effective branch rulesets, classic branch protection, required check contexts and app identities, and issue cross-references. It ignores review records that are not required checks. Cross-referenced PRs are read in one GraphQL request; more than 100 references fail closed as unknown. Display status is cached for five seconds and the combined inspection has a 12-second deadline. An unreadable or incomplete rule source, a pending/missing/failing check, another open or merged PR for the issue, a conflict, or a closed PR blocks merging.

Automatic merging also requires a server-enforced current-base policy: a merge queue or strict required-status-check rule. A client-side fetch cannot supply that guarantee. The coordinator performs the complete gate twice without using the display cache, verifies the same base/head pair, then re-reads the local review generation immediately before invoking `gh pr merge --match-head-commit` with literal argv. GitHub's refusal text is returned to the local UI, and a failed attempt remains disabled until Refresh loads fresh state. There is no “merge anyway” path around missing atomic protection. Demo mode never constructs the coordinator, including when a gateway is injected.

## Deferred runner work

This slice does not mutate Git history or run plan commands. If the base moved, the gate sends the task back to review. A plan item with a `cmd:` acceptance check remains blocked because the current review service has no trusted container result. Issue #22 tracks rebasing through the ledger, recomputing review state, running commands in the container, and persisting results against the exact head.

## Validation

Unit and integration tests cover local review blockers; current and stale base/head pairs; PR state and mergeability; known, unknown, empty, pending, and failing check requirements; app-bound checks; server base protection; already-fixed results; a requirement changing between validation passes; and the exact `gh` merge argv. Browser coverage proves blockers are visible, the ready action uses the reviewed head, and duplicate clicks start only one merge.

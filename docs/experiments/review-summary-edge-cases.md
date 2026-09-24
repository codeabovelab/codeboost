# Review-summary edge-case validation (#10)

Validated on 2026-09-23 from `5a2685c`, before selecting real issues for the plan-indexed review experiment. These were summary-only concerns from PR #9, not reproduced defects. No production behavior changed during this validation.

## Renamed-file reassignment

A real-Git fixture declares `retry.ts` → `renamed.ts`, then creates an unplanned rename with a content edit. The review exposes unplanned segments on both the removed old path and added new path. Manually assigning every segment to the rename item leaves each segment in scope.

Result: no defect reproduced. `ReviewService` evaluates a manual assignment against both `path` and `renamed_from`. The integration fixture remains as coverage.

## Literal pathspec metacharacters

A planting fixture uses the literal declared filename `*.txt` beside a decoy `a.txt`. An owned commit edits the literal file; a later commit removes it while retaining the decoy. The plant helper rejects the history at its declared-file transition check with `Declared plant needs a regular file retained through the remaining history.`

Result: no defect reproduced. The decoy does not satisfy the literal transition check. The fixture remains as coverage for Git pathspec metacharacters.

## Accepted-change status styling

The existing browser flow accepts an unplanned change, opens the Accepted row, and reloads it. The status reads `Accepted outside plan` and uses the existing muted treatment. A proposed error-color assertion failed because the rendered class is `muted`, confirming the summary did not describe the current styling accurately enough to imply a patch.

Result: no defect reproduced. The summary supplied no expected color, state token, contrast failure, or browser failure. The explicit label already distinguishes the acknowledged exception, so no new color semantics were inferred and the existing browser coverage remains unchanged.

## Gate result

All three concerns are resolved as validated behavior. No issue supplied a failing case that justified a production patch. Issue #3's manual assignment and paired human go/no-go experiment remain pending and must use the frozen protocol in `review-protocol.md`.

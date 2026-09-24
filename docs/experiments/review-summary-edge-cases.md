# Review-summary edge-case validation (#10)

Validated on 2026-09-23 before selecting real issues for the plan-indexed review experiment. The validation branch started from baseline `5a2685c`; final exact-head results are recorded in PR #17. These were summary-only concerns from PR #9, not reproduced defects. No production behavior changed during this validation.

## Renamed-file reassignment

A real-Git fixture reduces the demo plan to P1, declares `retry.ts` → `renamed.ts`, then creates an unplanned rename with a content edit. The review exposes removed and added text segments with `-` and `+` operations. The fixture resolves the removed side through `oldPath` and the added side through `path`, verifies both declared names, then manually assigns both segments. Each remains in scope.

Result: no defect reproduced. `ReviewService` evaluates a manual assignment against both `path` and `renamed_from`. The integration fixture remains as coverage.

## Literal pathspec metacharacters

A planting fixture uses the literal declared filename `*.txt` beside a decoy `a.txt`. An owned commit edits the literal file; a later commit removes it while retaining the decoy. Direct controls prove `git ls-tree ... -- '*.txt'` returns no match and that `ls-tree` rejects `:(glob)` pathspec magic as unsupported. The plant helper then rejects the history at its declared-file transition check with `Declared plant needs a regular file retained through the remaining history.`

Result: no defect reproduced. The decoy does not satisfy the literal transition check. The fixture remains as coverage for Git pathspec metacharacters.

## Accepted-change status styling

The existing browser flow accepts an unplanned change, opens the Accepted row, and reloads it. The status reads `Accepted outside plan` and uses the existing muted treatment. A proposed error-color assertion failed because the rendered class is `muted`, confirming the summary did not describe the current styling accurately enough to imply a patch.

Result: no defect reproduced. The summary supplied no expected color, state token, contrast failure, or browser failure. The explicit label already distinguishes the acknowledged exception, so no new color semantics were inferred and the existing browser coverage remains unchanged.

## Gate result

All three concerns are resolved as validated behavior. No issue supplied a failing case that justified a production patch. The paired human go/no-go experiment was later cancelled before results were recorded; optional future validation is tracked in #19 and must use a freshly committed protocol.

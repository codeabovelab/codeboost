# Plan-indexed review: go/no-go protocol

Status: **cancelled by product decision before timed results were recorded**. This document is retained as historical experiment design and does not claim a passed gate. Optional future validation is tracked in #19 and must start from a fresh committed protocol and fresh blinded packages.

The cancelled experiment no longer blocks subsequent roadmap work. No speed, catch-rate, or comparative product claim may be inferred from its preparation work.

## Pair selection and order

Choose four pairs of comparable, small real issues in a repository owned by the reviewer. Match each pair on scope, language, and estimated review complexity before implementing either issue. Record issue URLs, PR URLs, base/head SHAs, and which review method each gets. Do not reuse the demo fixture as an experimental issue.

| Pair | Real issue A / PR | Real issue B / PR | A method | B method |
|---|---|---|---|---|
| 1 | Pending selection | Pending selection | Raw GitHub diff | codeboost |
| 2 | Pending selection | Pending selection | codeboost | Raw GitHub diff |
| 3 | Pending selection | Pending selection | Raw GitHub diff | codeboost |
| 4 | Pending selection | Pending selection | codeboost | Raw GitHub diff |

The reviewer must not implement the paired changes or inspect the plants before deciding on the PR. An operator prepares plans and commits by hand, records trusted ledger ownership, and supplies both the plan and code to each review method. The earlier one-issue manual assignment also remains required: record how every change maps to the attribution table and turn unclear cases into fixtures.

## Planting

The operator runs `node scripts/plant.ts review.json NEW_DIRECTORY plant-input.json`. The input contains `declaredText`, `undeclaredText`, and a fresh top-level `undeclaredPath`. The helper creates a separate local clone and database, randomly selects eligible owned commits, amends those commits while preserving readable messages/trailers, records old/new mappings and ownership, and writes the returned `review.json` for the local UI. It never pushes or changes the source repository. Both plants are owned through the ledger, so the undeclared-file plant is out of scope rather than foreign.

The helper supports linear histories and regular, top-level declared files retained through the remaining history. It refuses unsupported targets and stops on cherry-pick conflicts; the operator must inspect a failed disposable clone and choose a fresh output path, never silently resolve a conflict or alter the frozen issue pair. Plant text must represent a plausible unrelated code change, not an obvious marker. The automated test uses obvious markers only to verify the helper.

`sealed.json` outside the clone records locations and selected commits with owner-only file permissions. It is unblinding data, not encryption. The operator must withhold it from the reviewer until that PR's decision is recorded. Do not show CLI input or sealed data to the reviewer. Open PRs only after inspecting the prepared branch; PR publication is a separate action.

## Measurement

Time each review from first opening to the recorded decision. Record elapsed seconds, unexplained changes, the undeclared-file plant found (yes/no), and declared-file plant found (yes/no). Record decisions before unblinding. Also record interruptions and tool failures without silently dropping trials.

Pass only when all are true:

- codeboost catches at least 3 of its 4 undeclared-file plants and more than raw-diff review catches;
- median codeboost time is no slower than median raw-diff time;
- no change is left unexplained.

Report declared-file catch rate for both methods without a pass threshold. Stop after four pairs. If within one catch of the bar, perform four more preselected pairs once, then decide. Do not add further trials. Record the outcome in a committed results document before merge/agent/planning/queue/learning implementation begins.

## Current evidence

Engineering tests prove browser interactions, persistence, attribution, and planting mechanics. They do **not** establish human review speed or catch rates. The experiment was cancelled without a result.

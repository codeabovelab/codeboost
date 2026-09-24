# Plan-indexed review: go/no-go protocol

Status: **pair selection frozen; implementations and reviews not started**. Max Hwang (`mchwang`) is the blinded reviewer and Codex is the experiment operator. This document does not claim a passed gate. Complete each row's PR and SHA fields and commit that exact revision before the first timed review. No issue, assignment, order, or threshold may change once the first review begins.

## Pair selection and order

Choose four pairs of comparable, small real issues in a repository owned by the reviewer. Match each pair on scope, language, and estimated review complexity before implementing either issue. Record issue URLs, PR URLs, base/head SHAs, and which review method each gets. Do not reuse the demo fixture as an experimental issue.

All eight issues are in `codeabovelab/guardyx-gstack`. A/B placement within each pair was randomized once before implementation; the method pattern remains the alternating pattern approved in the protocol.

| Pair | Real issue A / PR / base..head | Real issue B / PR / base..head | A method | B method |
|---|---|---|---|---|
| 1 — MCP discovery | [#556](https://github.com/codeabovelab/guardyx-gstack/issues/556) / PR pending / SHA pending | [#554](https://github.com/codeabovelab/guardyx-gstack/issues/554) / PR pending / SHA pending | Raw GitHub diff | codeboost |
| 2 — companion documentation | [#493](https://github.com/codeabovelab/guardyx-gstack/issues/493) / PR pending / SHA pending | [#176](https://github.com/codeabovelab/guardyx-gstack/issues/176) / PR pending / SHA pending | codeboost | Raw GitHub diff |
| 3 — agent-key security | [#506](https://github.com/codeabovelab/guardyx-gstack/issues/506) / PR pending / SHA pending | [#443](https://github.com/codeabovelab/guardyx-gstack/issues/443) / PR pending / SHA pending | Raw GitHub diff | codeboost |
| 4 — compliance export | [#504](https://github.com/codeabovelab/guardyx-gstack/issues/504) / PR pending / SHA pending | [#503](https://github.com/codeabovelab/guardyx-gstack/issues/503) / PR pending / SHA pending | codeboost | Raw GitHub diff |

The pairs are matched before implementation on repository, primary implementation language, subsystem, and expected review surface. Pair 1 changes MCP discovery behavior; pair 2 changes operational/compliance documentation without runtime behavior; pair 3 changes agent-key lifecycle across the API and UI; pair 4 adds per-invocation compliance evidence across export and PDF surfaces. If implementation discovery makes a pair materially unequal or blocked, stop before the first timed review and record a new frozen protocol revision rather than silently substituting an issue.

The reviewer must not implement the paired changes or inspect the plants before deciding on the PR. The operator must not expose plant inputs, `sealed.json`, mappings, planted locations, or unblinded implementation notes in the PR, review package, task messages, or protocol updates. An operator prepares plans and commits by hand, records trusted ledger ownership, and supplies both the plan and code to each review method. The earlier one-issue manual assignment is recorded in `manual-assignment.md`; all 12 segments were assigned and in scope, with no unclear case requiring another fixture.

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

Engineering tests prove browser interactions, persistence, attribution, and planting mechanics. The separate manual assignment proves that one real merged issue can be completely classified through stored review choices. Neither establishes human review speed or catch rates. Four Guardyx issue pairs are selected, but no paired implementation, timed decision, or catch-rate result exists yet.

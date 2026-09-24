# Plan-indexed review: go/no-go protocol

Status: **pair selection frozen; all four pairs prepared; reviews not started**. Max Hwang (`mchwang`) is the blinded reviewer and Codex is the experiment operator. This document does not claim a passed gate. Every row's PR and exact base/head SHAs are committed below. No issue, assignment, order, or threshold may change once the first review begins.

## Pair selection and order

Choose four pairs of comparable, small real issues in a repository owned by the reviewer. Match each pair on scope, language, and estimated review complexity before implementing either issue. Record issue URLs, PR URLs, base/head SHAs, and which review method each gets. Do not reuse the demo fixture as an experimental issue.

All eight issues are in `codeabovelab/guardyx-gstack`. A/B placement within each pair was randomized once before implementation; the method pattern remains the alternating pattern approved in the protocol.

| Pair | Real issue A / PR / base..head | Real issue B / PR / base..head | A method | B method |
|---|---|---|---|---|
| 1 — companion documentation | [#493](https://github.com/codeabovelab/guardyx-gstack/issues/493) / [PR #600](https://github.com/codeabovelab/guardyx-gstack/pull/600) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..6a273dab42005e01a6f4c2ea92297f40ad29e0d7` | [#176](https://github.com/codeabovelab/guardyx-gstack/issues/176) / [PR #601](https://github.com/codeabovelab/guardyx-gstack/pull/601) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..f61a793ebe4e7352f7ebf74238adfad3c18750d0` | Raw GitHub diff | codeboost |
| 2 — agent-key security | [#506](https://github.com/codeabovelab/guardyx-gstack/issues/506) / [PR #602](https://github.com/codeabovelab/guardyx-gstack/pull/602) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..11a5d74d9bcdd0dcd1faa96e02cfe101ed9c8b6a` | [#443](https://github.com/codeabovelab/guardyx-gstack/issues/443) / [PR #603](https://github.com/codeabovelab/guardyx-gstack/pull/603) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..042999d9ebc3dc61fb029b21644bd20b4537a347` | codeboost | Raw GitHub diff |
| 3 — asynchronous notifications | [#13](https://github.com/codeabovelab/guardyx-gstack/issues/13) / [PR #608](https://github.com/codeabovelab/guardyx-gstack/pull/608) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..78f62ee413a291a5f0ea555c39bc8d61b6721f9b` | [#429](https://github.com/codeabovelab/guardyx-gstack/issues/429) / [PR #609](https://github.com/codeabovelab/guardyx-gstack/pull/609) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..b8cd873ac688fa27ac841fb2e2df2d6d135446c6` | Raw GitHub diff | codeboost |
| 4 — compliance evidence | [#504](https://github.com/codeabovelab/guardyx-gstack/issues/504) / [PR #610](https://github.com/codeabovelab/guardyx-gstack/pull/610) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..4ce1259c396ed40001efc02216a4cd181f8e50b4` | [#507](https://github.com/codeabovelab/guardyx-gstack/issues/507) / [PR #611](https://github.com/codeabovelab/guardyx-gstack/pull/611) / `f95a7ebaaa1e48a81fa724e8d6be677a17e7ee69..f9988770b89a14f006adf0ecefb15115d3d748d0` | codeboost | Raw GitHub diff |

The pairs are matched before implementation on repository, primary implementation language, scope, and expected review surface. Pair 1 changes operational/compliance documentation without runtime behavior; pair 2 changes agent-key lifecycle across the API and UI; pair 3 adds medium asynchronous notification delivery across backend jobs and consumer-facing interfaces; pair 4 adds compliance evidence across stored invocation data, exports, mapping data, and PDF surfaces. If implementation discovery makes a pair materially unequal or blocked, stop before the first timed review and record a new frozen protocol revision rather than silently substituting an issue.

Selection history: the first frozen draft paired #554 with #556. Before either implementation began, their required baseline check found that both depend on live 1,400-action/session telemetry unavailable from the operator's environment. A proposed replacement included #335, but inspect-before-build then proved that `main` already contains its requested in-flight guard even though the issue remains open. A current-tree audit also excluded other stale open issues whose requested work has shipped. The table above contains only work confirmed absent from current `main`; every A/B placement was randomized after that audit. No timed review, experimental implementation, or plant had started before this final selection.

Before timed review began, an automated reviewer was mistakenly requested on the original pair 3 and pair 4 draft PRs. That invalidated reviewer blindness for those four packages. PRs #604–#607 were closed, fresh randomized packages were created without changing their issues or method assignments, and the replacement PRs and exact revisions are recorded above. Automated review stays off every experimental draft until its human decision is recorded.

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

Engineering tests prove browser interactions, persistence, attribution, and planting mechanics. The separate manual assignment proves that one real merged issue can be completely classified through stored review choices. Neither establishes human review speed or catch rates. All four pairs are prepared at the eight exact PR revisions above, and every revision passed the repository preflight. No timed decision or catch-rate result exists yet.

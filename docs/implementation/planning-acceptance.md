# E4 planning acceptance and remaining gate

The dedicated E4 suite composes E2/E3 with the real SQLite Store. The checked-in
plan, edit cards and hostile text under `test/fixtures/planning/` are **synthetic**.
They are not captured Claude/Codex responses and do not establish live adapter,
semantic prompt-injection resistance, Docker isolation or product performance.

Runnable checks:

```sh
npm test
npm run typecheck
npm run test:browser
```

The PR body records the final pushed head and observed counts. The browser suite
is the existing integrated review baseline, not planning-screen acceptance (G).

| Acceptance | Evidence |
| --- | --- |
| JSON/YAML import, selected issue, eight broken plans, atomic failed import | `planning-acceptance.test.ts` against real Store |
| Immutable historical revisions, replay, sibling invalidation and stable identity | E4 reopens SQLite and tries repository/task/plan mismatches; `store.test.ts` additionally races Apply in independent processes |
| Malformed extracted output and invalid resulting cards never become ready | E4 asserts returned failure, cancelled durable request, null reply and unchanged plan revision |
| Hostile filenames, branches, argv, issue/comments, lessons and feedback | E4 decodes each prompt block at the provider boundary and asserts exact source data plus escaped delimiters; no recursive rendering |
| Initial/revised draft identity and revision; input/UTF-8/prompt budgets | `planning-author.test.ts`, including exact 32 KiB boundary and post-escaping expansion |
| Parser depth/size, duplicates, aliases, tags, safe numbers and registry copies | Existing frozen `plan-v1.test.ts`, `registry.test.ts`, `plan.test.ts` reused |
| Late response, cancellation, timeout ownership, shutdown admission, input changes | `planning-suggestions.test.ts` controlled promises/timers with real Store |
| Unapproved appended flags | E4 asserts `command-not-allowed` and exact-argv denial; no execution occurs in E |

## Dependency stop

E4's recorded real-authoring-output portion of T9/T18 is still blocked by D5
(lane D issue #28). No pinned, validated production provider is available on main
at the E4 assignment baseline `b181d15`. Do not relabel synthetic fixtures as
recordings or invoke an unisolated CLI to fill this gap. After D5 lands:

1. Capture both vendors' real extracted draft and edit documents with pinned CLI/
   model/profile provenance and the exact trusted request/schema versions.
2. Replay them through E2 validation and E3/Store; test missing, malformed, oversized
   and near-limit envelopes through D's actual extraction boundary.
3. Run the real permission/hostile-input and stdin-closure gates, attach exact-head
   evidence, and complete E4's remaining recorded-output acceptance.

F1/G4 also own durable failure reasons and atomic snapshot binding (#34), live API
and UI integration. The current Store guarantees identity/revision Apply CAS;
E3's in-memory snapshot check is not cross-process snapshot CAS. G must not treat
these fixture-only results as a completed production planning milestone. T18/T9
remain incomplete until all assigned lane slices pass their original acceptance.

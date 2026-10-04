# E4 planning acceptance and remaining gate

The dedicated E4 suite composes E2/E3 with the real SQLite Store. The checked-in
plan, edit cards and hostile text under `test/fixtures/planning/` are **synthetic**.
They are not captured Claude/Codex responses and do not establish live adapter,
semantic prompt-injection resistance, Docker isolation or product performance.
Only files under `test/fixtures/planning/recorded/` are vendor output.

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
| Malformed extracted output and invalid resulting cards never become ready | E4 asserts returned failure, durable failed reason, null reply and unchanged plan revision |
| Hostile filenames, branches, argv, issue/comments, lessons and feedback | E4 decodes each prompt block at the provider boundary and asserts exact source data plus escaped delimiters; no recursive rendering |
| Initial/revised draft identity and revision; input/UTF-8/prompt budgets | `planning-author.test.ts`, including exact 32 KiB boundary and post-escaping expansion |
| Parser depth/size, duplicates, aliases, tags, safe numbers and registry copies | Existing frozen `plan-v1.test.ts`, `registry.test.ts`, `plan.test.ts` reused |
| Late response, cancellation, timeout ownership, shutdown admission, input changes | `planning-suggestions.test.ts` controlled promises/timers with real Store |
| Unapproved appended flags | E4 asserts `command-not-allowed` and exact-argv denial; no execution occurs in E |

## Recorded vendor output

D5 has merged. Codex is refused in every phase (#75, #93): it reads files only
through its shell, and planning runs no process. So only Claude is recorded, and
the recorded-output part of T9/T18 needs one manual run of
`scripts/record-planning.ts` with a Claude token:

```sh
CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-planning.ts
```

The script sends one draft request and one suggestion request through
`runner/planning-provider.ts`. That provider uses D's container, the read-only
planning phase and vendor-only egress. D passes the request schema to Claude as
`--json-schema` and returns Claude's `structured_output` as JSON text. The script
saves that text exactly as D returned it to
`test/fixtures/planning/recorded/claude-<mode>.json`, with the image tag, CLI
version, and hashes of the repository files, prompt, schema and the exact argv D
ran Claude with. It saves before it validates, and it refuses
to write output that contains the token. It removes the token from its own
environment before any Docker call, and replaces it in every error it prints. Read each file before you commit it.
Never put credentials in a fixture, an issue or a PR.

The adapter passes no model flag, so each recording names the CLI's default model,
not a pinned one.

| Acceptance | Evidence |
| --- | --- |
| Real output validates and persists | `planning-recorded.test.ts` replays the draft into the Store and the suggestion through E3, then reopens SQLite |
| A recording matches today's request | The same test fails when the repository files, prompt, schema, Claude argv (flags, tool sets, `--json-schema`), image tag or CLI version changes; record again. Other image changes, such as Dockerfile packages, are not detected |
| Recordings exist | The same test fails until both files exist |
| Provider runs only read-only Claude planning and settles before release | `planning-provider.test.ts` with injected lane D stand-ins: Codex is refused before any Docker or Git work; a result for another attempt or context is refused; storage Docker did not remove, or that D returned no handle for, keeps planning off, with planning's own refusals |
| Missing, malformed, error and boundary-size envelopes | `planning-extraction.test.ts`: structured envelopes through `parseClaudeOutput`, then E3 and the Store at exactly 1 MiB and 1 MiB + 1 byte |

The edit schema caps every text field, so no valid reply is near 1 MiB. The size
tests therefore show which check rejects the text: at exactly 1 MiB the schema,
and at 1 MiB + 1 byte the size limit. If a real output fails validation, fix the
prompt or schema and record again. Do not edit the recording.

The provider and Ask share one container runner, `runReadOnlyAgent` in
`runner/question-container.ts`. Each passes its phase, host root and removal,
limits, credential rule, output check and wording as a `ReadOnlyFeature` (`ASK_FEATURE`, `PLANNING_FEATURE`). Ask's wording
and cleanup error are unchanged (#117 part 1).

Left for #117 part 2: the provider's image build, clone and storage calls are
synchronous, so a server must run it off its request thread, as Ask does. That
worker should also set TMPDIR to a planning root, as Ask's does, so the input and
auth staging that lane D leaves when it gives up on cleanup is covered. E3's
default 120-second suggestion timeout is shorter than the provider's ten-minute
budget. Startup recovery does not yet remove planning's Docker resources after a
crash, because they are not attempt allocations in the Store. The recording
script prints its runner label if it leaves any.

F/G still own live API and UI integration. The Store now guarantees revision/snapshot
binding and pending-only settlement across processes, and E3 requires the caller's
snapshot identity before admission. G must not treat these fixture-only results as a
completed production planning milestone. T18/T9 remain incomplete until all assigned
lane slices pass their original acceptance.

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

#117 part 2 wires the provider into the server. Each request runs in planning's
own worker thread (`runner/planning.ts`, `AgentWorker` with `PLANNING_NAMING`),
whose TMPDIR is a planning root recorded in a ledger beside the review database,
so lane D's leftover input and auth staging is covered. Its Docker objects carry
the database's planning owner, apart from Ask's and the runner's, and the first
request of a process removes what earlier sessions left by that owner only. E3's
suggestion timer and the request share one ten-minute budget. The recording
script still runs the provider in its own process and prints its runner label if
it leaves anything.

The planning check (#164) proves that the vendor chosen in Settings can run a
planning invocation before any request does. It is one planning job in the same
worker and profile as a real request (read, list and search only, vendor-only
egress, a mounted schema), on the review's code at the snapshot's head, with a
real request's budget, since a process's first job may build the agent image. It
asks for the schema's own answer, `{"ok": true}`, so it covers sign-in, the
schema-constrained answer and the read-only profile (`PlanningAgent.probe`).
`PlanningCheck` starts it when the server starts, before it listens, and again
on the first request after the vendor changes, cancelling the check it replaces.
`productionPlanning`'s `describe` waits for it, at most 30 s in all, before it
reads the issue or records a planning request, and the request checks again just
before it starts, so a vendor chosen during the issue read never runs unchecked.
That last check runs inside the Store's transaction, so it starts no check
itself: it refuses, and the check it needs starts on the next turn. The provider
checks once more when it is invoked, as defence in depth (E3 invokes it in a
microtask right after the recorded action); a refusal there settles the request
as failed. A failed check refuses the request with a `GuardRefusal` that starts
"Planning is unavailable:" and ends with the reason exactly as given (some end
with a command to copy), and a check still running after the wait is refused
with the same prefix; the server records the refusal and starts no agent.
Requests within a minute of a failure are refused with it; the next request
after that checks again. With no vendor chosen nothing is checked, and the
request fails later, as before, with `NO_PLANNING_AGENT`. Once planning requests
have settled, or after the server's 20 s grace for them, shutdown cancels a
running check and waits up to 20 s more for it before closing the worker. A
check that runs before the runner's setup has set the runner-owned repository
fails, on a task with runner commits, with "which is not configured"; the
recheck a minute later passes once the runner's setup has finished, and without
a runner block it fails each time, as every planning request would. A check that
has not settled within a real request's budget and a minute fails, so the
recheck applies to it. A reason that holds until codeboost restarts (an
abandoned worker, cleanup codeboost could not confirm, a database with other
hard links, a missing token) gets no promise of a recheck, and Codex is told to
choose another agent. A recheck joins the worker's one startup recovery, so a
recovery that never ends fails each recheck until codeboost restarts. A passed
check is kept until a check for another vendor replaces it: a worker abandoned
later, cleanup that did not settle (the check's own run included, when its
answer still came back), or a token revoked later, shows as a failed request. A
refusal recorded when a request stopped waiting, or when the Store could not be
read during the wait, is replayed if the browser resends the same action;
keeping a Store error out of the record needs `web/server.ts`. Showing the
check's state in the review view before a request, and the other limits that
need `web/server.ts`, are #198. A check deferred from the Store's transaction
can start during shutdown, before planning closes; close then waits for it
within its bound. If startup fails after planning's setup, the CLI exits, and
the next start's planning recovery removes what the check left. Tests:
`test/planning-production.test.ts` ("the planning check (#164)", with a check
that passes, one that fails and one that does not finish),
`test/planning-worker.test.ts` (the check in planning's worker, including a
wrong answer) and `test/agent-planning.test.ts` (against the vendor, real
Docker: an invalid sign-in fails, and a live probe in the Live probes workflow
passes with a real one).

The Store guarantees revision/snapshot binding and pending-only settlement across
processes, and E3 requires the caller's snapshot identity before admission. G4 now
composes the browser with production planning setup, lane D's provider boundary,
F's HTTP lifecycle and Store persistence in `plans-production.spec.ts`. The exact-head
real-Docker planning gate also passes, completing T18.

T9 is complete as of 2026-10-19 ([CI](ci.md#t9-status)). F6 runs the recordings in
both required jobs, `test` and `real-docker`, and the live Claude probes in the
nightly `Live probes` workflow. No workflow records fixtures: when a recording goes
stale, run `scripts/record-planning.ts` again as above.

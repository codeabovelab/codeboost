# Plan library alignment: closing #6

Original audit baseline: `22e76a8bc90b59c8407bb78bee1c229b249b4936` (main, 2026-10-11). The change was last brought up to date with `main` at `7fd4dfe52d02de62a516e4d880b4564e83c78513` (2026-10-19).

Issue #6 tracked the v1 plan library contract and the runner obligations that came out of the PR #1 and PR #4 reviews. PR #4 delivered the library part. Later lanes delivered most of the runner part. This change closes the remaining library and test gaps and moves the remaining runtime gaps to their own issues.

## What each obligation rests on now

| Obligation | Status | Evidence |
| --- | --- | --- |
| Deterministic JSON/YAML parsing: duplicate decoded keys; no anchors, aliases, tags or merge keys; strict scalars; safe integers; byte and depth limits | Done before this change | `core/parse-v1.ts`; `test/plan-v1.test.ts` ("frozen v1 input contract", "v1 retained parser fixtures") |
| Post-run audits: declared files, symlink targets and descendants, dangling targets, no new links or file-to-link conversions, gitlinks review-only | Done before this change | `core/run-audit.ts`, `runner/execution.ts`; `test/run-audit.test.ts`, `test/identity.test.ts`, real-Docker cases in `test/agent-container.test.ts` ("reports a new symlink, and writes through declared links to a file, a directory child and a dangling target", "watches the old target of a dangling link the item retargets, whatever lies on the way") |
| Request IDs, cancellation, replay and CAS for suggestions and Apply, bound to repository, task and plan identity; one card per revision, with sibling and old-revision cards invalidated on Apply; Refresh suggestions under a new request | Done before this change | `runner/store.ts`, `core/plan.ts`; `test/store.test.ts` ("binds suggestion requests before the reply and rejects cross-plan, cancelled, delayed, replayed, and sibling applications", "serializes competing Apply operations across independent processes"), `test/identity.test.ts`, `test/planning-drafts-api.test.ts`, `test/browser/plans-authoring.spec.ts` ("replays an ambiguous suggestion Apply, stales siblings, and refreshes before the next edit") |
| Library contracts from the issue body: exact full-argv approval, selected issue and path identity required, canonical leaf paths, symlink lineage and target overlap, gitlink authoring refused, the v1 tokenizer, the `update_file` edit on an exact existing path | Done before this change (PR #4) | `core/plan.ts`, `core/parse-v1.ts`; `test/identity.test.ts` ("update_file cannot silently add or rename a path"), `test/plan-v1.test.ts` ("requires exact complete argv approval", "requires selected issue and known path identity", "rejects plan authoring at a gitlink", "retains link type through projected renames and rejects children beneath it", "rejects declared ancestors of a retained link target"), `test/plan.test.ts` |
| Container-visible schema and output channels | Done before this change | Schema: `test/agent-container.test.ts` ("creates a Claude planning profile only when its command carries the exact mounted schema"), `test/agent-adapter.test.ts` (planning schema reader). Output file: `test/agent-supervisor.test.ts` ("rejects unsafe Codex output from %s": a link, a FIFO, an oversized file, invalid UTF-8, a replaced directory) (real Docker) |
| Stable plan identity in approvals and attribution choices | Done before this change (PR #4) | `core/approvals.ts`; `test/identity.test.ts` ("binds approval to stable identity, item ID, and file metadata", "cannot transfer standalone acceptance to another plan") |
| Retained schemas loaded through the registry | **This change** | `loadPlanSchemas` in `core/plan.ts`; `test/schema-versions.test.ts` |
| Released snapshots and semantics never change | **This change** | SHA-256 digests in `test/schema-versions.test.ts` |
| Trusted base entries and path identity | **This change** (tests); task storage is probed at runner startup since #162 | `runner/review.ts`; `test/review.test.ts`. #162: `agents/container/storage.ts` (`probeTaskStoragePathIdentity`), `runner/production.ts` (`setUpRunner`); `test/runner-production.test.ts`, `test/path-identity-probe.test.ts`, `test/runner-workspace.test.ts` ("#162") |
| Hostile repository, issue, lesson, feedback, previous-plan and continuation-context text in every authoring prompt | **This change** (revised drafts, suggestions and the continuation context) | `test/planning-author.test.ts` |
| Container mounts: Git metadata on its own filesystem, read-only, with no writable hard links or aliases into it | Done before this change | `agents/container/profile.ts`, probe `metadata-alias` in `agents/policy.ts`; `test/agent-container.test.ts` ("keeps Git metadata read-only, on another filesystem, and mounted against replacement", "keeps Git metadata unchanged under link, alias, truncation and replacement attempts during %s"), negative controls in `test/agent-gate.test.ts` (real Docker) |
| Process termination: output overflow, deadline and cancellation stop the whole container, including a process that ignores SIGTERM | Done before this change | `agents/adapters/supervisor.ts`; `test/agent-supervisor.test.ts` ("terminates %s at bounded output limits", "enforces a finite wall deadline and force-settles the container", "preserves the first cancellation reason until an ignored SIGTERM fully settles") (real Docker) |
| Output shown in the UI bounded: captured output comes only from the supervisor, which bounds stdout and stderr; when a planning run exits with an error, the provider's message quotes its output with whitespace collapsed, cut to at most 300 UTF-16 code units (`runner/planning-provider.ts`) | Done before this change; 300-unit quote tested in this change | `test/agent-supervisor.test.ts` output-limit cases (real Docker); `test/planning-provider.test.ts` ("quotes at most 300 code units of a failed run's output, with whitespace collapsed"). The Docker daemon's own log is #165 (*later:* the daemon keeps none) |
| Output limits at the exact byte | **This change** (tests; the supervisor already enforced the limits) | Supervisor enforcement: `test/agent-supervisor.test.ts` (real Docker). Decoder behaviour only, not a limit: the Claude decoder handles an envelope of exactly the stdout ceiling, and the 1 MiB parser limit applies to the decoded answer at the exact byte: `test/agent-adapter.test.ts`. At #6 the decoder re-serialized the answer, so the limit applied to the re-encoded text. *Later:* #166 returns the exact text of `structured_output` in the CLI's envelope, so the limit applies to those bytes |
| Prompt byte budget before spawn | Done before this change | `MAX_PROMPT_BYTES` in `core/planning-author.ts`; `test/planning-author.test.ts` ("accepts exactly the prompt byte limit and rejects the next byte without truncation") |
| Model budget before spawn | Moved to #163 | — |
| Planning profile probed at startup | Moved to #164 | — |
| Docker daemon log limits | Moved to #165. *Later:* fixed in #165 with `--log-driver=none`, checked before launch | `agents/container/profile.ts`, `agents/container/run.ts`; `test/agent-container.test.ts` ("creates the agent container with no Docker daemon log", "refuses an agent container with %s at validation") (real Docker), `test/agent-daemon-log.test.ts`. Agent containers only; the runner's own task-storage script containers keep the daemon's default log until the container is removed |
| Claude structured output under the v1 parsing contract | Moved to #166 (found during this change). *Later:* fixed in #166 | `agents/adapters/claude.ts`; `test/agent-adapter.test.ts` ("lets draft validation refuse %s in a structured answer") |

## Schema loading

`core/plan.ts` used to import the v1 snapshots and compile only those. It now builds every version from `schema/versions.json`:

- Each registry entry names a plan path and an edit path. Each path must be a retained snapshot whose `$id` equals its path. No path may be named twice. All registry-named snapshots compile into one validator, so each `$id` is registered once.
- Each validator key maps to an implementation and the semantics document it implements. A registry entry that pairs a key with a different document is refused at load, and so is a key or implementation that another version already uses. A key with no implementation loads, and that version validates as unsupported (`docs/plan-format.md`: "Treat a missing validator implementation as unsupported").
- A plan or edit reply is checked by the schema of the version it declares. `validatePlan` selects the version once and uses that selection for both the shape check and the semantic validator. The v1 validator also calls the module's `assertPlan`, which repeats the shape check through the production registry, not through a loader a test injects. A value with no registered version is checked by the current schema, so the error names `/schema_version` as before.
- `assertPlan` also refuses a version with no validator implementation. So do the paths that skip the semantic validator: `validateContinuationPlan` when every item is complete (it still checks the completed prefix, IDs, dependencies and the selected issue), and the store's check of a ready draft (`runner/store.ts`). `assertEditReply` refuses it in the same way, so the store does not mark such a reply ready.
- Imports, including provider drafts, must be in the current version: no migrations exist yet. The store's check of a ready draft (`runner/store.ts`) skips the semantic validator; it relies on the draft having passed `importPlan` when the planning author validated it, and the draft is imported again on Apply.
- A suggestion's edit reply must declare the same version as the plan it edits. The provider gets the edit schema of the previous plan's version. The suggestion binding cannot catch a mismatch, because the store builds its `schemaVersion` from the current plan (`runner/store.ts`), so this check in `applySuggestion` is the guard for each card. A reply with no cards never reaches it; it has nothing to apply.
- A new draft's provider gets the current version's plan schema.

Each snapshot must require `schema_version` and allow only its own version, stated at its top level as `required` and a one-value `enum`, or the loader refuses it. A plan snapshot must also require `items` and not `edits`, and an edit snapshot the reverse, so an entry cannot swap the two. Selection relies on this.

The loader compiles each snapshot as it reaches it. The v1 snapshots use only local `#/$defs` references. A future snapshot that refers to another snapshot must have that snapshot added to the validator before it is compiled.

While v1 is the only registered version, every module-level path selects v1, and the v1 schema refuses any other `schema_version`. So no test can yet tell these from a version-blind implementation:

- `assertPlan` and `assertEditReply` selecting by declared version;
- imports required to be in the current version;
- an edit reply required to match its plan's version;
- the suggestion provider getting the previous plan's edit schema;
- a new draft's provider getting the current version's plan schema;
- `validateContinuationPlan` with every item complete, and the store's check of a ready draft, refusing a version with no validator (tested through the loader's `assertPlan` only).

`test/schema-versions.test.ts` tests selection and validation through an injected two-version loader. The change that registers a second version must add module-level tests for the paths above. Selection, Ajv and the semantic validator each read `schema_version` separately. Every caller passes parsed or stored data today, but a second version should select once and pass the selection on.

Unversioned CLI copies are never registered: the loader compiles only the snapshots registry paths name. `test/schema-versions.test.ts` loads the registry with the copies available beside the snapshots and checks that they are not compiled. `test/registry.test.ts` checks that the copies equal the current snapshots byte for byte.

Some code stays v1 whatever version a plan declares. A second version that changes these would also need them selected through the registry:

- the JSON/YAML parser (`core/parse-v1.ts`);
- the edit operations and payload rules in `applySuggestion`, and `validateContinuationPlan`;
- the Plans screen, which checks `schema_version === 1` (`web/public/app.js`);
- the `Plan` and `EditReply` types, whose `schema_version` is the literal `1` (`core/plan.ts`).

A load error is a defect in the build: it throws when the module loads, so the server does not start. A validator key with no implementation is not a load error: the server starts and every plan in that version is refused as unsupported. `test/registry.test.ts` checks that each version's key is `v<version>`.

## Retained file digests

`test/schema-versions.test.ts` pins the SHA-256 of every file a registry entry names, and checks that the pinned set equals the named set. Editing a released snapshot or its semantics document fails the test. Adding a version without pinning its files also fails.

## Test evidence

Each break below was made on purpose, one at a time, and made the named tests fail. The code was restored afterwards. The envelope fixtures in `test/agent-adapter.test.ts` describe decoder behaviour and are not in this table.

Loader breaks in `core/plan.ts`, each failing at least one test in `test/schema-versions.test.ts`: `select` ignoring the declared version; own-key lookups of snapshot paths or validator keys removed; the safe-integer check on version keys, the shared-path check (snapshots and semantics), the `$id` check, the plan/edit role check, the `required` check, or the whole version-pinning check removed; the reused-key, reused-implementation, semantics-pairing or missing-current check removed; an unsupported version validating as valid, or passing `assertPlan` or `assertEditReply`; `validate` skipping the shape check.

| Break | Failing test |
| --- | --- |
| Previous plan rendered without escaping | revised-draft and suggestion cases of "renders every hostile value once as escaped JSON" |
| Lessons rendered without escaping | all three cases of the same test |
| Continuation context rendered without escaping | "renders an agent-written out-of-scope path once as escaped JSON in the continuation context" |
| Mode `120000` read as a file | "lists base entries by Git mode" |
| NFC normalization removed | "keys paths by the configured case and Unicode identity" |
| `caseSensitive` type check removed | "refuses to start without a known checkout path identity" |
| Non-ASCII refusal on a case-insensitive checkout removed | "keys paths by the configured case and Unicode identity" |
| Supervisor check on decoded output size removed | both cases of "accepts decoded output at the … limit and stops one byte over it" (real Docker) |

# The codeboost plan format (version 1)

**Who this is for.** Anyone who writes, imports, or builds code around a codeboost plan: people, and the Claude and Codex agents that draft plans. **What it is for.** It defines the one structure every plan must follow, so codeboost can import a plan from any source and check it the same way. It is written in plain language (ISO 24495-1:2023).

## Summary

- A plan is a list of **plan items** for one GitHub issue. Each item says which files it will change, what changes in each file, and how to check the result.
- One schema, [`schema/plan.schema.json`](../schema/plan.schema.json), defines the structure. It is the contract for three things:
  1. **Generating.** codeboost gives the schema to Claude (`claude -p --json-schema`) or Codex (`codex exec --output-schema`), so the agent's answer always has the right shape.
  2. **Importing.** A plan in a YAML or JSON file, written by a person or another tool, is checked against the same schema.
  3. **Suggesting.** The plan assistant's suggested edits follow a second schema, [`schema/plan-edit.schema.json`](../schema/plan-edit.schema.json).
- YAML and JSON have exactly the same structure. YAML is for people; JSON is what the agents return.
- After the schema check, codeboost runs a second set of checks that a schema cannot express (see "Checks after import").
- A full example: [`schema/examples/plan-412-r3.yaml`](../schema/examples/plan-412-r3.yaml).

## Terms

| Term | Meaning |
|---|---|
| Plan | All plan items for one issue, at one revision. |
| Revision | The plan's version number: r1, r2, and so on. Each import or approved change makes a new revision. |
| Plan item | One change with an ID such as P1. |
| Declared files | The files a plan item lists. The agent may edit only these. |
| Acceptance | How to check a plan item: a `cmd` that codeboost runs, or a `check` that the review agent judges. |
| Schema | The file that defines which fields a plan must have and what each may hold. |

## The structure

### The plan

| Field | Type | Rule |
|---|---|---|
| `schema_version` | number | Always `1`. |
| `issue` | number | The GitHub issue number. |
| `revision` | number | 1 or more. codeboost sets the final number when it imports the plan. |
| `summary` | text | What the plan does, in one or two sentences. |
| `items` | list of plan items | 1 to 30 items, in the order they run. |
| `questions` | list of text | Questions for the reviewer when the issue leaves something undecided. Use `[]` when there are none. |

### A plan item

| Field | Type | Rule |
|---|---|---|
| `id` | text | `P` and a number, such as `P1`. Unique in the plan. |
| `title` | text | Short, like a good commit subject. Up to 120 characters. |
| `intent` | text | Why the item exists, in one or two sentences. The review agent checks the code against it. |
| `files` | list of files | 1 to 40. Every file the item will add, change, rename, or delete. |
| `acceptance` | list of checks | 1 to 10. Include at least one `cmd` when you can. |
| `depends_on` | list of IDs | Items that must be done first. Only earlier items. `[]` when none. |

### A file

| Field | Type | Rule |
|---|---|---|
| `path` | text | From the repo root, with forward slashes. For a rename, the new path. |
| `kind` | one of `edit`, `add`, `delete`, `rename` | What happens to the file. |
| `renamed_from` | text or `null` | The old path for a rename; otherwise `null`. |
| `change` | text | What changes in this file, in plain words. Name functions and behavior, not line numbers. |

### A check

| Field | Type | Rule |
|---|---|---|
| `type` | `cmd` or `check` | `cmd` is one program and its literal arguments, such as `go test ./... -run TestRetry`. codeboost runs it in the agent's container without a shell, using the command-tokenization grammar below; shell syntax outside quoted literals and all expansions are forbidden. It passes when it exits with 0. `check` is a statement the review agent judges. |
| `text` | text | The command, or the statement. |

**Every field is always present.** A field with nothing to say is `null` or `[]`, never left out. This is what lets the same schema work with both agents' strict answer modes.

A short example:

```yaml
schema_version: 1
issue: 412
revision: 3
summary: Keep the Idempotency-Key header on every retry.
items:
  - id: P1
    title: Preserve idempotency key across retries
    intent: Every retry must send the same key as the first attempt.
    files:
      - path: src/retry/client.go
        kind: edit
        renamed_from: null
        change: Read the key once before the loop and set it on every attempt.
    acceptance:
      - type: cmd
        text: go test ./src/retry/... -run TestRetryKeepsKey
      - type: check
        text: The key is set on every attempt, not only the first.
    depends_on: []
questions: []
```

## Deterministic input parsing

Import accepts UTF-8 JSON or one YAML 1.2 document representing JSON-compatible data. Reject invalid UTF-8, input above 1 MiB, and nesting deeper than 50 containers before producing a plan. Parse into an intermediate syntax tree with duplicate-key detection; do not convert an unchecked YAML graph into application objects.

For both formats, object keys must be strings and unique after decoding at every level; reject duplicates rather than choosing the first or last value. JSON follows RFC 8259 syntax. YAML allows mappings, sequences, strings (including quoted and block strings), the exact plain literals `true`, `false`, and `null`, and numbers spelled using the JSON number grammar. Reject empty implicit values, non-finite values (`.nan`/`.inf`), non-JSON number spellings such as hex/octal or numeric separators, complex/non-string keys, every anchor and alias, merge keys (`<<`), explicit tags (including custom tags), extra documents, and parser warnings/errors before schema validation. Ordinary YAML 1.2 plain strings remain strings; do not infer dates, functions, or application-specific types. Integers used for issue, revision, or indexes must also be exactly representable safe integers in the implementation.

Only after these checks convert to JSON-compatible values, select the registered schema, and validate. Never enable alias expansion or custom object construction. Required fixtures: equivalent JSON/YAML produce identical structured plans; duplicate decoded keys in either format, anchors/aliases, merge keys, tags, non-finite/non-JSON numbers, empty values, complex keys, multiple documents, excessive depth, and oversized input all fail before schema validation. An ordinary quoted string containing `<<` or `&` as part of its text is data, not YAML syntax.

## Command tokenization (version 1)

`cmd` is parsed by one deterministic tokenizer, never a shell. Only ASCII space separates arguments outside quotes. Single or double quotes delimit a literal part of an argument; remove the delimiters and concatenate adjacent parts (`ab" cd"` becomes one argument `ab cd`). Empty quoted strings produce an empty argument. There are no escapes: reject every backslash, unmatched quote, newline, tab, NUL, or other control character. Outside quotes reject shell metacharacters `;`, `&`, `|`, `<`, `>`, `$`, backticks, parentheses, glob characters (`*`, `?`, `[` and `]`), braces, `!`, `#`, and `~`; inside quotes they are ordinary literal characters. Reject an empty command or executable. Do not expand variables, globs, substitutions, or home paths. Match the resulting complete argv against the approved array exactly. Implementations must share fixtures for empty arguments, spaces inside quotes, adjacent quoted parts, rejected backslashes/unclosed quotes, and quoted literal punctuation.

## Plan fields in agent prompts

Every consumer of a current plan (execution, review, fixes, and conflict resolution as well as authoring) embeds the structured plan/item as a JSON data block. Serialize all free-form fields, including `intent`, file `change`, and acceptance text; escape `<`, `>`, and `&` as JSON Unicode escapes, and never recursively expand placeholders in values. The trusted prompt defines the phase and asks the agent to act on the approved task data; text inside a field cannot change tool permissions, authorize another command, change roles, or escape that phase. Tool dispatch uses separately validated structured scope/argv, never instructions extracted from prose. Hostile-field evaluations must include forged closing delimiters and demands to run an unapproved command. Serialization prevents delimiter breakout, not semantic injection; enforced permissions remain necessary.

## Checks after import

The schema checks the shape. codeboost then checks the meaning. A **failure** blocks approval. A **warning** shows on the item, and you can approve anyway.

| Check | Result if it fails |
|---|---|
| `issue` exactly matches the selected task's GitHub issue number in the selected repository. Require a selected task before import; a mismatch fails without changing the task or rewriting the plan. | Failure |
| Item IDs are unique. | Failure |
| Every `depends_on` ID exists, comes earlier in the list, and there is no loop. | Failure |
| Both `path` and `renamed_from` use canonical repo-relative forward-slash form: reject absolute/drive paths, backslashes, control characters, empty components, `.` and `..`, repeated or trailing separators, and `.git` components. Do not silently rewrite paths. Before duplicate, occupancy, dependency, or projected-state checks, compare filesystem identity keys using the actual task checkout's case and Unicode equivalence rules; reject aliases that name the same entry (for example `src/A` and `src/a` on a case-insensitive checkout). If those rules cannot be established, fail closed. Apply the same keys to base-tree paths and projected paths. | Failure |
| No parent component of `path` or `renamed_from` is a symlink in the projected state, and neither path points into `.git`. Inspect components without following links. In version 1, the final component may be a pre-existing symlink identified by the base Git tree's symlink mode, with that type carried through projected renames. A path declaration alone never authorizes converting a regular file into a symlink. Edits, deletes, and renames of such a link operate on the link itself, never its target. Version 1 rejects new symlinks and regular-file-to-symlink conversions; supporting them requires a future schema version with typed declarations, not interpretation of `change` prose. Inspect the stored target text without following it; any new or retained target must resolve within the repo, outside `.git`, without traversing another symlink. Deleting or replacing an unsafe existing link is allowed if the resulting state satisfies these rules. Recheck the actual target after the run, before committing. | Failure |
| Each declaration names one leaf Git entry (regular file or permitted pre-existing symlink), never the repository root, a directory/tree, or a gitlink (v1 only reviews foreign gitlink changes). A declaration never authorizes descendants; moving or deleting a directory requires enumerating its affected leaf entries. Reject destinations occupied by a directory and any child path beneath a projected file, symlink, or submodule. | Failure |
| For a declared pre-existing symlink, resolve its target identity without following filesystem links and reject the item if that target is also a writable declared entry, or is a directory containing any writable declared descendant, in the same invocation. Use filesystem identity keys and path-component ancestry (not string-prefix comparison); for example `link -> target/` conflicts with `target/file`. A link and its target cannot both be edited under one item; split legitimate changes into separate dependent items. Managed link operations use unlink/recreate or rename without dereferencing the link. Post-run path diffs alone cannot prove which spelling an arbitrary program used to write. | Failure |
| File operations are valid in the projected repo state immediately before the item runs (see below). `edit` and `delete` need an existing path; `add` needs an unused path; `rename` needs an existing `renamed_from` and an unused destination `path`. | Failure |
| `renamed_from` is set only for kind `rename`. | Failure |
| The same path is not declared twice in one item. | Failure |
| The item has at least one `cmd`. | Warning: "No test command" |
| Each `cmd` is parsed as one executable and literal arguments, with the entire argv matched element-for-element against a repo-approved argv entry. Prefix matches, appended flags, extra arguments, and argument substitution are not allowed. An unlisted argv needs the person's explicit approval as a new exact allowlist entry; plan approval alone does not grant execution permission. Shell operators, pipelines, redirects, substitutions, and expansions are rejected. Execute the resulting argv without a shell. | Invalid syntax blocks approval; a valid but unlisted command warns and cannot run until allowed |
| A completed agent invocation changes a dependency or a script codeboost will run. | Before its own installation or script invocation, codeboost stops in "needs approval". This post-invocation gate cannot prevent an agent from executing a changed script during its invocation; container and network restrictions must already contain that execution. |
| `questions` is not empty. | The plan shows the questions at the top; answer them or approve anyway |

**Submodules in version 1.** Gitlinks are review-only metadata leaves: the linking engine can display and attribute externally produced pointer changes, but v1 plans cannot author, add, delete, or rename a gitlink. Reject declarations targeting an existing gitlink and reject agent-produced gitlinks. Authoring them requires a future typed target-commit field and runner-controlled operation. Do not initialize or update nested submodule worktrees. Before each agent or check invocation, reject an initialized/populated gitlink directory and bind an empty read-only mount at every existing gitlink path; refuse the invocation if that protection cannot be enforced. Before tests and before committing, inspect gitlink locations without following links and reject nested content, including content under newly introduced gitlinks. A top-level Git diff is not enough. Reviewing submodule pointers reads the Git entry only; the agent never receives an editable nested checkout. Tests must attempt writes beneath a gitlink and provide a pre-populated nested checkout, and both must be refused.

**Clean invocation state.** Before every invocation, including restart/retry, materialize a fresh task filesystem from the recorded trusted head. Do not reuse a partially written checkout or rely on `git reset` to remove untracked files. Keep ledger/plan state outside that filesystem and preserve previous output separately for diagnosis. Inspect actual entries without following links immediately before launch: reject unexpected/untracked entries, occupied add destinations, or symlink parents that disagree with the projected state. No agent/check runs until actual occupancy and entry types agree. Test restart with an untracked symlink parent and an occupied add destination.

**Git metadata trust.** Mount the task's `.git` read-only for the agent, including execution/fix phases; only the runner may create commits or update refs after the invocation ends. Before any post-run Git command, inspect metadata with ordinary filesystem reads against the runner-owned baseline and reject unexpected changes. Runner Git uses a sanitized immutable configuration and an explicit environment: no inherited Git variables, user/system config, hooks, fsmonitor, external diff/textconv, clean/smudge filters, SSH commands, or credential helpers supplied by the task. Network/push endpoints and credentials come only from trusted runner settings. Build that config outside the writable task mount and do not read agent-provided config before this audit. Tests must plant each command-helper setting and prove that status/diff/add/push inspection never executes its marker.

**After each run, codeboost checks the result too.** A plan check alone cannot stop an agent from creating a new symlink and writing through it. So after each invocation, before committing, codeboost: records otherwise-safe regular-file changes outside the declared list as out of scope, commits them with the owning item, and exposes them for review; these are scope findings rather than safety violations. Separately, the safety audit rejects new symlinks or regular-file-to-symlink conversions (a renamed pre-existing symlink is tracked by its base-tree lineage); permits changed pre-existing links only at declared paths and rejects targets that leave the repo, enter `.git`, or traverse another symlink; and rejects any agent change to `.git` itself (including config, hooks, refs, and objects). Any safety violation stops tests and commits and moves the task to needs human; preserve the rejected output separately for diagnosis. Only after this audit may the runner create its own objects and commit. Hooks are disabled (`core.hooksPath=/dev/null`) in addition to the metadata/config isolation above; disabling hooks alone is not sufficient.

**Projected file state.** Start with the paths at the plan's base commit, then walk items in their listed execution order. Check an item's file operations against the state before that item; after it passes, apply its declared additions, deletions, and renames to the projected state before checking the next item. No repo files change during validation. A path may participate in only one operation per item, counting both the source and destination of a rename. If an item uses a path created or renamed by an earlier item, it must depend on that item, directly or through other dependencies.

For example, P1 may add `src/new.go`, then P2 with `depends_on: [P1]` may edit it. Likewise, P1 may rename `src/old.go` to `src/new.go`, then P2 may edit the new path. Editing a missing path, adding an existing path, or renaming onto an occupied path blocks approval. Recompute the projected state from the base commit after each plan edit.

Issue text and agent-produced plan fields remain untrusted. The prompt builder serializes issue data and previous plans as JSON and escapes delimiter characters before insertion (see the template). Escaping prevents data from closing its wrapper; it does not guarantee that a model ignores malicious instructions. Human plan approval, command validation, and the container remain required. Test both delimiter-escape payloads and instruction-like issue text.

## How a plan gets into codeboost

| Source | What happens |
|---|---|
| **Claude or Codex drafts it** | codeboost runs the agent with the prompt in [`prompts/plan-author.md`](../prompts/plan-author.md) and passes the schema. The answer is a JSON plan. codeboost runs the checks after import and shows the plan on the Plans screen as a draft. |
| **You import a file** | On the Plans screen, choose "Import plan" and pick a `.yaml`, `.yml`, or `.json` file, or paste one. codeboost reads it, runs the schema and the checks after import, and saves it as the next draft revision. The file's `revision` is replaced by the next free number. |
| **You edit on the Plans screen** | Each change is checked as you type. Approving saves the revision. |

codeboost keeps the master copy in its own database. The copy in the PR description is written from that master and is never read back.

## Suggested edits (plan assistant)

When you ask the plan assistant on the Plans screen for changes, it answers in the shape of [`schema/plan-edit.schema.json`](../schema/plan-edit.schema.json):

- `reply`: its answer to you, in plain words;
- `base_revision`: the revision it read. codeboost refuses edits made against an older revision;
- `edits`: 0 to 10 suggested edits. Each one becomes a card with **Apply** and **Dismiss**. Nothing changes until you click Apply.

| `op` | Fields it uses | What it does |
|---|---|---|
| `add_item` | `new_item` | Adds a whole new plan item. |
| `remove_item` | `item` | Removes an item. |
| `set_field` | `item`, `field` (`title` or `intent`), `value` | Replaces the title or intent. |
| `add_file` | `item`, `file` | Declares a file at a new path. |
| `update_file` | `item`, `file` | Replaces the existing entry identified by exactly matching `file.path`; the path is immutable for this operation. A missing path is an error, never an implicit add. |
| `remove_file` | `item`, `value` (the path) | Removes a declared file. |
| `add_check` | `item`, `check` | Adds an acceptance entry. |
| `remove_check` | `item`, `check_index` | Removes an acceptance entry by position, starting at 0. |
| `set_depends` | `item`, `depends_on` | Replaces the item's `depends_on` list. |

To change a declared path or rename destination, import a complete replacement plan as a new revision and run all meaning checks. Separate add/remove suggestions are permitted only when each intermediate plan is valid; they are not an atomic path-change operation. Do not infer the old entry from prose or list position.

Fields an operation does not use are `null`. The strict answer schema checks structure, not the relationship between `op` and its payload. Before showing an enabled Apply button, a semantic validator must enforce the operation table: required payloads are non-null, unused payloads are null, and `item` identifies an existing item except for `add_item`, where it matches the unique `new_item.id`. File updates/removals must target an existing entry; additions must not duplicate one; `check_index` must be in range; and `set_field` must satisfy the destination field's limits. Reject invalid suggestions with an explanation. Dry-run each edit on a copy and run both the plan schema and all meaning checks; repeat against the current revision atomically when Apply is clicked. Invalid edits never mutate the saved plan. An example: [`schema/examples/plan-edit-412-r3.json`](../schema/examples/plan-edit-412-r3.json).

## Versions

- Every plan carries `schema_version`. This document describes version 1.
- Wording changes that do not change accepted data keep the same version. Changes to accepted data, including adding, renaming, or removing a field or changing a limit, require the next schema version. This applies to both plan and suggested-edit schemas.
- A nullable field is still required. Adding one breaks old plans (the field is missing) and old readers (the field is unknown), so it must not be added under version 1.
- [`schema/versions.json`](../schema/versions.json) is the version registry. Its `current` number selects the schema used for new drafts; its `versions` object maps exact decimal version numbers to plan and edit schema paths relative to `schema/`. Version 1 is retained at `schema/versions/1/plan.schema.json` and `schema/versions/1/plan-edit.schema.json`. Each snapshot has a unique version-qualified `$id` matching its registry path under `https://github.com/codeabovelab/codeboost/schema/` (for example `versions/1/plan.schema.json`). Future versions must use new IDs so all retained schemas can coexist in one validator. After release, snapshots are immutable, including descriptions. The unversioned `schema/plan.schema.json` and `schema/plan-edit.schema.json` are exact copies of the current snapshots for CLI compatibility; verification must check those copies against the registry.
- Parse the input as data, require an integer `schema_version`, and look it up in the registry without constructing a path from user input. Reject missing or unsupported versions. A new version adds a new directory and registry entry; retain all earlier entries. With only version 1 registered there is no migration to run.
- Keep released schemas unchanged. On import, read `schema_version`, validate against that version's schema, convert using an explicit version migration, then validate against the current schema and run the meaning checks. Reject unsupported versions with an explanation. Never validate an old plan against a newer schema before converting it. Suggested edits must use a supported schema version and still match the current plan revision; otherwise ask the assistant to regenerate them.

**PR #1 review decisions.** File validation uses projected state so dependent items can work on new or renamed files. Version changes are explicit because every field is required and unknown fields are rejected. T18 includes regression checks for both rules.

## PR #1 feedback dispositions

The script approval gate covers codeboost-run commands, while container and network isolation must contain an agent that edits and immediately executes a script. Symlink parent components are prohibited; version 1 supports declared pre-existing final links, identified by Git mode and tracked through renames, with target checks. New links and ordinary-file conversions require a future typed schema. Canonical path checks use the task filesystem's identity rules. A declared link and its writable target cannot share an invocation. Gitlinks remain metadata-only, with empty read-only nested paths and pre-test/post-run audits. Imported plans must match the already-selected issue and repository context. Retained schemas have explicit registry paths, and repository metadata in authoring prompts uses escaped JSON data blocks just like issue text. These are semantic/runtime requirements, not guarantees supplied by JSON Schema alone.

## Notes for builders

- **The schema files have no `$schema` line.** Claude Code's `--json-schema` rejects the draft 2020-12 URL (tested with Claude Code 2.1.278). Validate with a draft 2020-12 validator, set in code.
- **Strict-mode rule.** Every object lists all its properties in `required` and sets `additionalProperties: false`. Optional values are nullable. Keep this rule for every new field, or Codex's `--output-schema` may refuse the schema.
- **One file per schema.** Each agent receives one schema file, so `plan-edit.schema.json` holds exact copies of the `item`, `file`, and `check` definitions. A test must fail if the copies differ.
- **Closing stdin.** `codex exec` reads extra input from stdin when stdin is not a terminal, and waits forever if nothing arrives. Always run it with stdin closed (`< /dev/null`).
- **Tested with:** Claude Code 2.1.278 and Codex CLI 0.153.4, 2026-09-22. Both returned plans and suggested edits that passed both schemas.

## Test this document with a reader

Before relying on this format, ask someone who has not seen codeboost to write a two-item plan for a small issue using only this page. Note every place they hesitate or ask a question, and fix that part of the page.

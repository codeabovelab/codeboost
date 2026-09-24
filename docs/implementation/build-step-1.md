# Build step 1: plan format and linking foundation

Started from PR #1 and updated to its merged baseline `91fd2b4` on main. Work follows the approved build order; the user explicitly chose it over prioritizing plan drafting in the UI.

## Delivered in this slice

- A single private TypeScript package with pinned dependencies, Vitest, strict typechecking, and CI on Node 26.7.0.
- Draft 2020-12 validation against the existing v1 schemas. Imports assign the caller's next revision; unsupported versions fail instead of being silently converted.
- Projected file operations, dependency checks, path restrictions, command argv parsing, warnings, and safe individual suggestion transformations.
- A read-only Git adapter and a pure attribution engine. Ownership comes only from a supplied ledger, never a trailer. Line edits retain earlier owners; changes involving a foreign commit conservatively remain Unplanned.
- Text segments, shared-hunk labels, and evidence cards for path/mode/binary/empty/symlink/submodule changes.
- Approval fingerprints include item data, exact changed content (CRLF normalized), and Git function context. They ignore line numbers and commit IDs, and staleness propagates through dependencies. Duplicate-segment choices expire if copy count changes.

## Decisions

**Reuse.** Inspected AgentDiff's `agentdiff/plan_validator.py` and `agentdiff/diff_parser.py` on 2026-09-22. Its file grouping and plan format do not provide the ledger-backed line ancestry needed here. No AgentDiff code was copied. Use Ajv for JSON Schema, `yaml` for YAML, and `diff` for bounded Myers line comparison.

**Module boundaries.** `core` has no runtime I/O. `git` reads repository objects, never the worktree's file targets. Future `runner/store` remains the sole persistent writer. Empty scaffolds for agents/github/web are intentionally not shipped.

**History scope.** Linear histories only in this slice. Reject merges and non-ancestor bases rather than guessing ownership. Keep rename provenance so a later edit that defeats final rename detection cannot erase the move's owner.

**Command grammar.** One executable with literal argv. Space-separated arguments and single/double quotes are supported; shell syntax outside quotes is rejected. Quoted punctuation (for example a test regex) is literal data. The library never executes a command.

**Persistence.** Caller supplies typed immutable base entries, the actual checkout path-identity function, stable repository/task/plan IDs, selected issue, and trusted ledger. Suggested edits return a new revision; atomic compare-and-swap and revision allocation are requirements for the later store integration.

## Validation

`npm test` runs schema fixtures and real Git repositories: the documented invalid plans; projected add/edit/rename/delete chains; bad dependencies/paths; malformed suggestions; stale revisions; two owners in one hunk; forged trailers; out-of-scope changes; pure deletions; overlapping edits; reverted work; all six non-text change kinds; literal filenames; clean rebases with remapped ledger; stale checks/dependents; whitespace/context changes; assignment and duplicate-copy expiry; and rename provenance when final rename detection is lost.

A focused independent review found BOM-only changes could disappear because the default UTF-8 decoder strips the mark. A real-Git regression first failed, then passed with BOM-preserving decoding. Invalid UTF-8 filenames fail instead of being silently replaced. A separate failing fixture showed `diff.ignoreSubmodules=all` could hide gitlinks; reads now force submodule visibility and repository-wide paths, with regression coverage for relative-diff settings too.

The rename case first failed (moved lines became Unplanned), then passed after the provenance fix. `npm run typecheck` checks all source and tests. The public examples and shared schema definitions are checked on every test run.

## Review round 1

Copilot reported two findings. Fixed scope after rename: scope now travels with each owning change at its actual path, instead of comparing all segments against both ends of the final rename. Real rename/edit and rename/delete cases failed before the fix and pass after it; declaring only the historical name does not authorize the destination.

Declined the claim that repository aliases can override `rev-parse`, `rev-list`, `diff`, or `cat-file`: these are built-in commands, and Git ignores aliases that shadow them. A scratch probe and a permanent adapter regression confirmed the shell alias never ran. See [Git's alias documentation](https://git-scm.com/docs/git-config/2.54.0).

## Review round 2

Fixed inherited Git environment redirection. A regression with `GIT_DIR` pointing at a second repository initially returned the foreign repository's content. The adapter now drops inherited `GIT_*` variables, ignores global/system Git configuration, and disables lazy fetch and transport access. The same regression now reads only the requested repository.

## Review rounds 3–4

Round 3 reviewed the pre-fix commit and repeated the environment finding; the existing fix resolved it. Round 4 exposed repository-local object alternates, reproduced by reading borrowed history from a second repository. The adapter now rejects an alternates file before resolving commits.

Declined adding rename-only ownership to later text edits. The approved design represents a no-content rename as a separate file-change segment. A real-Git test confirms that a foreign rename remains an Unplanned file card while the later P2 text edit belongs to P2; the rename has not disappeared from review. Text edits before a rename still retain their line ancestry. Scope tests now explicitly require nonempty P2 rows.

## Review round 5

Fixed unbounded accumulation of unique blobs across a history. The adapter checks object size before loading it and enforces a cumulative 64 MiB byte budget; callers can choose a smaller positive limit. A small-budget fixture failed before the fix, then passed with explicit rejection below the required total and success at the exact total. Repeated references to the same blob do not count twice.

## Review round 6

Fixed symlinked object storage bypassing the alternates check. Root, loose-directory, and pack-directory symlink regressions all reproduced the problem. The adapter now inspects the object store without following symlinks, rejects links at any depth, and bounds inspection to 100,000 entries before resolving commits. The caller must keep storage stable during reads; concurrent filesystem isolation belongs to the runner.

## Review round 7

Fixed eager directory listing before the inspection limit: use incremental directory reads with a one-entry buffer and close handles on every exit. Callers may lower the entry budget; the regression first failed and now rejects explicitly.

Declined the YAML finding: the pinned yaml 2.9.1 implementation and types explicitly define `maxAliasCount: 0` as rejecting all aliases (`-1` disables limits). An otherwise valid plan with an alias fails with “Alias resolution is disabled”.

Clarified the gitdir policy rather than rejecting normal linked worktrees. The caller selects and trusts the repository and its administrative directory; gitfiles and symlinked gitdirs are supported, while object-storage symlinks and alternates within that gitdir are rejected. Real-Git fixtures exercise both administrative layouts. Filesystem containment of an untrusted repository root belongs to the runner, not this read-only library.

## Review round 8

Fixed aggregate diff retention outside the blob budget. The adapter limits total raw-diff and context-patch output to 8 MiB and total file records across commit and final diffs to 20,000. Both budgets can be lowered by callers. Small-budget cases first failed and now reject explicitly; the exact file-record boundary succeeds.

## Remaining gates

This is a working foundation, not a completed application or a claim that all implementation tasks are done. T18's pure validation/edit core is present; its agent adapters, import UI, and persistence are pending. Ledger storage, rebase mappings, and the read-only review screen remain next. The already-fixed GitHub check belongs to the later GitHub/runner integration.

The design's timed go/no-go experiment was cancelled by product decision before results were recorded. Disposable Git histories are engineering tests, not evidence that plan-indexed review beats raw review. The cancelled experiment does not block merging, agent execution, planning UI, queue, or learning work. Optional future validation is tracked in #19, and product claims must not imply that the cancelled gate passed.

## Alignment with the merged v1 contract (#6)

This library slice now selects retained v1 schemas and dispatches the registered `v1` semantics. CLI schema copies are never registered separately. Version-specific parser fixtures remain in `test/plan-v1.test.ts`; future versions need separate semantics and fixtures rather than editing acceptance rules in place.

The importer accepts strings or UTF-8 bytes, bounds input to 1 MiB and nesting to 50 containers, detects decoded duplicate keys in both formats, and inspects YAML nodes without alias expansion. It rejects anchors, aliases, tags, merge keys, implicit empty values, non-JSON numeric spellings, unsafe/lossy integers, and extra documents. Exact complete argv approval replaces prefix matching; tokenizer rules follow the retained v1 grammar.

`PlanContext` now requires stable identity, selected issue, typed base entries, and a trusted `pathKey` function that implements the checkout's actual case/Unicode identity. Unknown rules fail closed. The library never guesses filesystem behavior from the OS. Caller-provided identity must preserve components/separators and throw for unrepresentable paths. Projected membership, collisions, leaf checks, dependencies, and linking scope use these keys. Gitlinks cannot be authored. Existing symlink types survive renames; parent traversal, unsafe retained rename targets, and declared-link/writable-target overlap are rejected. No target or file type is inferred from plan prose.

Suggestion transformations require the trusted identity/revision binding captured when the request began. A delayed response cannot apply to another plan with matching local IDs. Applying a card increments revision and thereby makes siblings stale; callers must regenerate remaining cards. **This pure API is not a server endpoint:** the store must load the binding by opaque suggestion ID, enforce cancellation/consumption, and atomically CAS plus consume/invalidate IDs. A caller must never construct the binding from UI/model claims at Apply time.

Approval fingerprints and standalone choice keys include stable plan identity; fingerprints retain item IDs and file-change metadata. File cards now record typed blob/commit object IDs. Explicit null ledger owners remain foreign.

Validation began with 60 passing tests. The added v1 regressions reproduced 18 failures before fixes. The final suite also covers decoded duplicate keys, byte/depth boundaries, unsafe numbers, Unicode identity, symlink lineage, cross-plan suggestions/approvals/choices, refreshed suggestions, and real-Git identity/metadata cases.

### Explicit remaining work

Issue #6 remains open for runner/store integration: obtain typed base entries and actual filesystem identity from a trusted checkout; audit actual occupancy, new symlinks/conversions, link targets and target mutations after execution; provide persistent request IDs, cancellation, replay prevention and concurrent CAS; enforce prompt budgets/profiles, output limits, container mounts, and process termination. The library only checks declared/projected state and trusted supplied context. In particular an edit may repair an unsafe existing link, but only the future runtime audit can validate its new target and accepted filesystem state. No application, runtime safety boundary, or concurrent store has been added here. Issues #2 and #3 remain the next approved build steps.

## Merged-contract review round 1

Updated README import/linking examples to supply the new required context. Declined the scored-rename report: the raw-diff regex captures only `([A-Z])` and consumes the score separately with `\d*`, so the existing branch receives `R`, not `R100`. A focused real-Git test observed a scored rename followed by an added-file record and loaded both correctly before any parser change. Retained that regression. A separate locally discovered C1-control regression failed first, then passed after using the complete Unicode control category for commands/paths.

## Merged-contract review round 3

Reproduced seven failing fixtures covering six valid findings. Replay now rejects before cumulative line/segment/reference/text growth exceeds its budget; origin unions and hunk-sharing avoid unchecked flattening, and grouping no longer repeatedly re-splits accumulated text. Read and linking operations each use a monotonic overall deadline, with Git subprocess/diff timeouts clamped to the remaining budget. Filesystem checks are cooperative between calls; process-level containment remains the runner's job.

File metadata retains the whole rename path lineage, so a later deletion includes its owner's evidence on the final original-path file card. Multiple metadata owners remain conservatively Ambiguous; foreign owners remain Unplanned. Link target validation rejects intermediate regular-file/gitlink entries, overlap in both ancestry directions, and multi-file unsafe-link repair. Repair of an unsafe existing link remains possible as its own item. Tests cover text, empty, and binary rename/deletion cards; exact line/segment boundaries; reference fanout; and deterministic deadline exhaustion.

## Merged-contract review round 4

The review had no inline findings, but its summary identified lost metadata after deleting and recreating a path. A real binary-file regression reproduced only the recreating owner being retained. Metadata updates now combine existing path evidence before storing/propagating it, so prior deletion owners survive reuse and subsequent renames. Owned deletion plus recreation is Ambiguous; foreign deletion plus recreation stays Unplanned. Both regressions pass.

## Merged-contract review round 5

Reproduced a repository-local graft making an unrelated root commit appear descended from the selected base. The adapter now rejects Git-resolved graft and shallow metadata before object/ancestry reads and pins the child graft file to `/dev/null` as defense in depth. Git resolves administrative paths so linked worktrees share the same check. Caller isolation must keep all Git metadata, not just blobs, stable during a read. Full shallow-clone support is deliberately outside this linear immutable-history slice.

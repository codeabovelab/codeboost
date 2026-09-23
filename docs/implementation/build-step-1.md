# Build step 1: plan format and linking foundation

Started from PR #1 and updated to its design commit `2229e88`. Work follows the approved build order; the user explicitly chose it over prioritizing plan drafting in the UI.

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

**Persistence.** Caller supplies the immutable base-file list and trusted ledger. Suggested edits return a new revision; atomic compare-and-swap and revision allocation are requirements for the later store integration.

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

## Remaining gates

This is a working foundation, not a completed application or a claim that all implementation tasks are done. T18's pure validation/edit core is present; its agent adapters, import UI, and persistence are pending. Ledger storage, rebase mappings, and the read-only review screen remain next. The already-fixed GitHub check belongs to the later GitHub/runner integration.

The design's manual real-issue assignment and timed go/no-go experiment have not been performed. Disposable Git histories are engineering tests, not evidence that plan-indexed review beats raw review. Write and commit the experiment protocol before using the real review screen for that comparison. Do not proceed to merging, agent execution, planning UI, queue, or learning until the documented gate passes.

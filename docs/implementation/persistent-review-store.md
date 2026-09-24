# Persistent review store (#2)

This slice follows the library foundation merged at `550340a`. The read-only review screen tracked in #3 was implemented after this store. The store uses Node's built-in SQLite through `runner/store.ts`; no additional runtime dependency is required.

## Contract and decisions

Only the trusted runner calls `Store`. Web handlers must send commands through the runner rather than opening this database or passing model/browser claims as ledger entries, approval fingerprints, checkout context, or audited evidence. All production SQL lives in this module. Its database handle is private.

SQLite owns plan revision allocation. Stable repository/task/plan identity scopes every record; the selected issue is fixed at plan creation. Imports start at revision 1 regardless of the uploaded revision and increment only after validation. Historical revisions and base/head snapshots are append-only. Review writes compare both revision and snapshot ID; imports compare revision. Returned objects are decoded copies.

Suggestion requests receive opaque UUID attempt IDs before an agent response exists. Each request captures both the plan revision and repository snapshot. Completion and Apply atomically compare that binding with the current plan; a response for an older snapshot cannot become ready or apply. Apply loads the saved reply and binding, atomically saves the next revision, consumes that request, and invalidates pending/ready siblings. Invalid edits roll back without consuming the request.

The request lifecycle is `pending` to `ready` to `consumed`, or `pending` to a terminal `failed`, `cancelled`, or `invalidated` state. Plan and snapshot changes invalidate active requests while retaining completed replies as stale history. Runner cleanup uses `settleSuggestion`, which compares the opaque attempt ID, expected binding, and `pending` state; if another process has already completed the request, cleanup loses without altering the ready result. Explicit user cancellation may cancel pending or ready work. Every non-success terminal transition persists a bounded reason, and `getSuggestions` recovers the binding, reason, and reply after restart. A reply arriving after any terminal transition cannot reactivate a request.

Each write transaction takes SQLite's immediate write lock. WAL plus FULL synchronization provides committed recovery; the lock has a five-second busy timeout. Contending processes either serialize or fail explicitly. There is no asynchronous callback inside a transaction. Schema migrations advance through explicit versions; v4 adds request snapshot bindings and terminal reasons, and invalidates active legacy requests that cannot be bound safely. Unknown versions fail. Require Node 26.7.0 or later, matching the CI baseline.

Ledger entries are immutable within a plan identity. Entries retain full SHA, nullable owner, owned/foreign origin, and immediate source SHA. Rebase records the new base/head, one-to-one mappings, and inherited ownership atomically. A missing or explicitly foreign source yields a foreign destination with null owner. No trailer is consulted. Historical owners survive plan amendments; new normal entries must name a current item. Replaying incompatible ownership is an error, never an upsert.

Approvals and choices retain the revision and snapshot where the user made the decision. Fingerprints/choice keys from the pure library retain typed file-card object IDs and stable identity. Records are not deleted on unrelated revisions or rebases: the runner recomputes current segments and uses `approvalStates`/`applyChoices` to determine freshness. A stored approval is not itself a claim that the current code is approved.

Execution checkpoints retain the audited snapshot, revision, executed prefix, actual typed entries, and original out-of-scope paths. Continuation approval is a separate immutable record, requiring a newer revision at the same snapshot. The caller must first reconcile the prefix and validate the remaining suffix. Original scope evidence is never rewritten. Consumers must compare a stored continuation revision with the current revision and checkpoint snapshot before using it.

## Validation

`npm test` includes disk-backed SQLite integration tests for revision allocation, cancelled/delayed/cross-plan/replayed suggestions, independent connections racing completion against cleanup and snapshot movement, two independent processes racing Apply, terminal-reason restart recovery, v3 request migration, late transaction rollback, abrupt process exit with committed and uncommitted writes, identity isolation, foreign/owned rebase chains, real-Git linking from stored mappings, stale review writes, typed metadata fingerprints, and checkpoint preservation. A child-process startup test treats any SQLite warning as a failure. `npm run typecheck` includes `runner`.

Baseline: 136 tests. Final counts and CI evidence are recorded in the PR.

## Remaining integration

The store does not read Git or execute agents. The runner remains responsible for obtaining immutable typed tree entries and actual filesystem identity; keeping metadata stable; auditing paths, links, and occupancy; reconciling execution prefixes; and phase/container enforcement (#6). Checkpoint persistence is not an implemented execution state machine. This slice adds neither UI nor an HTTP endpoint. No migration against a shared environment is performed.

The review screen tracked in #3 is implemented. The later paired go/no-go experiment was cancelled before results were recorded and no longer blocks subsequent roadmap work; optional future validation is tracked in #19.

## Review round 1

Copilot's summary identified two findings (no inline threads). Both were reproduced with failing regressions, then fixed: immutable ledger comparisons now compare the typed fields rather than JSON property order, and a checkpoint's item must be the last item in its completed prefix. No findings were declined. Final suite: 151 tests.

## Review round 2

Reproduced a historical-owner retry failure after an amendment removed the owning item. Normal history writes now apply current-item validation only to new ledger entries; existing SHAs still pass the immutable field comparison. The regression also checks that new commits cannot claim the removed owner and that rebases retain historical ownership. No findings declined. Final suite: 152 tests.

## Review round 3

Reproduced continuation reapproval failing after a second plan amendment. Continuation records now include revision in their immutable primary key; the getter returns the latest approved revision, leaving earlier approvals intact. Repeating approval for the same revision is idempotent, with a separately reproduced regression. This changes the unreleased schema introduced by this PR, not a released database format.

Declined the duplicate-source-mapping finding as a correctness issue: the rewrites primary key already rejects a repeated source within a snapshot, and the surrounding transaction rolls back its new snapshot and all ledger writes. A new regression passed before any implementation change and confirms the unchanged snapshot, empty ledger, and absence of mappings after rejection. Final suite: 154 tests.

## Review round 4

Reproduced a saved assignment throwing in `applyChoices` after its target item was removed by amendment. Revision commits now discard assignments whose targets no longer exist, in the same transaction as the revision and request invalidation. Unrelated assignments and standalone acceptances remain. Removed assignments cannot reactivate if an ID is later reintroduced. No finding declined this round. Final suite: 155 tests.

## Review round 5

Reproduced and fixed three cases: old approvals reviving after item removal/reintroduction; an unknown identity-mapped SHA remaining unrecorded and later claimable; and the linking engine rejecting historical owners absent from the selected plan revision. Revision commits now discard approvals for removed IDs. Missing identity-map sources receive immutable foreign/null-owner ledger entries. `ownership(identity, revision)` produces a conservative view for that revision, mapping absent owners to null without altering the historical ledger; pass the same revision as the plan supplied to the linking engine. `getLedger` remains the raw provenance record. No findings declined this round. Final suite: 157 tests.

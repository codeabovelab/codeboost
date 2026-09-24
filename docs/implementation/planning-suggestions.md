# E3 suggestion lifecycle

The coordinator is a single in-process owner per runner/store. Construct one instance,
not one per HTTP request. The existing `Store` remains the only durable writer and
the only Apply authority. The coordinator does not allocate plan revisions or trust
provider-supplied identity. It captures the identity, revision, immutable base snapshot
and store-generated request ID before invocation. The caller supplies the snapshot ID
that owns its repository data; admission compares that complete identity before the
Store atomically allocates the request. Input containers are copied.

| Holder | States and legal transitions | Owner |
| --- | --- | --- |
| Coordinator | open → closing; closing rejects new starts synchronously | Runner-owned coordinator |
| Invocation | pending → running → completed/failed/cancelled/stale; pending may cancel before launch | Coordinator until provider settles |
| Cancellation | first reason retained; durable request settles and abort is requested immediately; invocation remains tracked and its result stays pending until provider termination | Coordinator and D adapter |
| Durable request | pending → ready → consumed, or pending → failed/cancelled/invalidated; plan or snapshot changes invalidate pending/ready while retaining completed history | Existing Store transactions |
| Durable plan | revision advances only through Store import/Apply; advancing invalidates sibling/pending requests | Store |
| Subprocess/container | abort requested → terminating → terminated; promise settles after final termination | D adapter |
| HTTP and UI | not created by E; F rejects admission/drains admitted requests before coordinator close, then closes Store; G preserves drafts and ignores stale responses | F/G |

The Store persists each request's plan revision, snapshot ID, and terminal reason.
Failed, cancelled, and stale E outcomes use `settleSuggestion`, which can transition
only the exact pending attempt at its captured revision and snapshot. If another
process completed the request first, cleanup loses without changing the ready result.
If another process cancelled or invalidated it first, E rereads the durable state and
reconciles its returned classification while retaining the original diagnostic.
Revision and snapshot changes invalidate durable requests with their cause while
retaining completed replies as stale history. Durable reasons use the Store's bounded
format even when a provider returns an oversized diagnostic. Restart therefore
preserves both the terminal classification and its actionable reason.

There is one active invocation per plan identity. A new start (including a retry)
cannot replace it, regardless of elapsed time, cancellation, or persisted state.
No lease or wall-clock heuristic releases ownership. Timeouts request abort but
do not settle early. First timeout/cancellation/shutdown reason wins over a later
generic provider abort. Different plan identities remain distinct; the production
runner must additionally enforce its global task limit.

Before publication, compare the current plan revision and snapshot with the captured
ones, validate every card via E2, then call Store.completeSuggestions, whose CAS
also checks the request is still pending and bound to the current revision/snapshot.
JavaScript has no await between these checks and publication; Store provides the
transactional request CAS across independent processes.
If the provider rejects or publication CAS refuses after external cancellation or
revision advance, read durable state and return cancelled/stale instead of a provider
failure. Retain the original provider/Store diagnostic alongside that classification.
Automatic cleanup uses the same captured binding and pending-state guard. Explicit
user dismissal remains a separate Store operation. E is not a multi-process scheduler.

`close()` flips admission to closing before aborting invocations and waits for all
providers to settle. It does not close storage. There is no HTTP server, polling,
browser input, retry endpoint or subprocess implementation in this lane.

Checks use controllable promises and timers with real SQLite to assert both returned
outcomes and durable state. Required cases include import before late completion,
snapshot change, completion racing failure cleanup, external cancellation, bounded
provider errors, timeout followed by an unsettled provider,
retry while cancellation is pending, shutdown admission, and post-submit mutation
of caller-owned input. Apply/replay/independent-process serialization remain Store's
existing acceptance boundary; E4 adds integrated fixtures.

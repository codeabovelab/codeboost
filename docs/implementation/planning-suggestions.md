# E3 suggestion lifecycle

The coordinator is a single in-process owner per runner/store. Construct one instance,
not one per HTTP request. The existing `Store` remains the only durable writer and
the only Apply authority. The coordinator does not allocate plan revisions or trust
provider-supplied identity. It captures the identity, revision, immutable base snapshot
and store-generated request ID before invocation. Input containers are copied.

| Holder | States and legal transitions | Owner |
| --- | --- | --- |
| Coordinator | open → closing; closing rejects new starts synchronously | Runner-owned coordinator |
| Invocation | pending → running → completed/failed/cancelled/stale; pending may cancel before launch | Coordinator until provider settles |
| Cancellation | first reason retained; request abort while invocation remains tracked; terminal cancelled/failed only after provider settlement | Coordinator and D adapter |
| Durable request | pending → ready; pending/ready → cancelled or invalidated; ready → consumed on Apply | Existing Store transactions |
| Durable plan | revision advances only through Store import/Apply; advancing invalidates sibling/pending requests | Store |
| Subprocess/container | abort requested → terminating → terminated; promise settles after final termination | D adapter |
| HTTP and UI | not created by E; F rejects admission/drains admitted requests before coordinator close, then closes Store; G preserves drafts and ignores stale responses | F/G |

The existing request table has no failed/stale reason fields. Failed or aborted E
invocations cancel the durable request to make Apply unavailable; the returned
outcome retains the precise reason and distinguishes failed/cancelled/stale.
Revision changes already invalidate durable requests. Snapshot-only changes cancel
them at settlement. F owns any future durable failure-reason or snapshot-binding
schema additions. Completed historical provider results are not silently rewritten.

There is one active invocation per plan identity. A new start (including a retry)
cannot replace it, regardless of elapsed time, cancellation, or persisted state.
No lease or wall-clock heuristic releases ownership. Timeouts request abort but
do not settle early. First timeout/cancellation/shutdown reason wins over a later
generic provider abort. Different plan identities remain distinct; the production
runner must additionally enforce its global task limit.

Before publication, compare the current plan revision and snapshot with the captured
ones, validate every card via E2, then call Store.completeSuggestions, whose CAS
also checks the request is still pending. JavaScript has no await between these
checks and publication; the injected Store must implement transactional request CAS.
Store's current contract binds request identity/revision, not cross-process snapshot
CAS. Production F integration must supply that stronger boundary if another process
can change snapshots concurrently. E is not a multi-process scheduler.

`close()` flips admission to closing before aborting invocations and waits for all
providers to settle. It does not close storage. There is no HTTP server, polling,
browser input, retry endpoint or subprocess implementation in this lane.

Checks use controllable promises and timers with real SQLite to assert both returned
outcomes and durable state. Required cases include import before late completion,
snapshot change, external cancellation, timeout followed by an unsettled provider,
retry while cancellation is pending, shutdown admission, and post-submit mutation
of caller-owned input. Apply/replay/independent-process serialization remain Store's
existing acceptance boundary; E4 adds integrated fixtures.

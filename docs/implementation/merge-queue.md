# Merge-queue lifecycle (#24)

Queue-backed merging is enabled only when the configured GitHub adapter implements the recorded K1 queue-observation contract. The reviewed head remains the authority throughout the lifecycle; browser requests never supply a head, attempt ID, or queue conclusion.

## Durable lifecycle

SQLite owns the merge-attempt record and retains its plan revision, snapshot, review version, and exact reviewed head. Legal transitions are:

```text
submitting -> queued -> merged
                    -> removed
                    -> failed
```

An observation may settle `submitting` after a process restart, because the enqueue command may have completed before the local queued update. Enqueue command success is never recorded as merged. Once submission begins, cancellation, timeout, transport failure, or another ambiguous command outcome leaves the persisted `submitting` record disabled, retains its diagnostic, and remains recoverable through queue inspection. Direct merges use the same durable ownership: a later pull-request read can reconcile an ambiguous direct command to merged, while any non-merged state remains disabled rather than being treated as proof that retry is safe. Only a confirmed GitHub refusal becomes a retryable `failed` attempt. Once the external command succeeds, a later local refresh failure likewise does not turn that committed action into a command failure.

Every update compares the current attempt ID and legal source state. A delayed poll for an older attempt therefore cannot overwrite a retry. Immediately before enqueue, the coordinator persists GitHub's opaque connection cursor for the latest queue-timeline event; later inspection paginates forward from that cursor, with a bounded fail-closed page limit. Correlated state requires exactly one post-cursor add sequence and its matching active or terminal shape; multiple add sequences fail closed. An older or later attempt for the same reviewed head therefore cannot settle this attempt, and long-running restart recovery does not depend on the boundary remaining in a recent-event window. Removed and failed attempts retain GitHub's terminal reason. Retry creates a new attempt only when the same revision, snapshot, review version, and reviewed head are still current. Any snapshot replacement or plan amendment after a stored attempt requires every plan item to have an approval bound to the current snapshot and revision. When GitHub explicitly requires fresh review without a locally observed replacement snapshot, those approvals must come from a review generation at or after the attempted generation. A distinct replacement snapshot can satisfy the gate after complete re-review even if its commit SHA was restored to the original value. After those approvals are recorded, the old attempt is historical rather than retryable.

## Runtime ownership

The coordinator owns at most one enqueue and one shared queue inspection. Cancellation does not release either operation until its GitHub call settles. One fourteen-second deadline covers every sequential validation, queue-correlation, and submission stage rather than restarting for each remote call. Shutdown rejects every new API request at admission and rechecks irreversible work after partially received request bodies, then gives admitted requests a bounded fourteen-and-a-half-second drain. It aborts request-scoped status inspections and coordinator work before waiting for server closure and closing SQLite, so an admitted status read or queue poll cannot deadlock teardown.

`GET /api/merge` is the narrow polling path. It reads only the persisted attempt and the K1 queue observation; it does not reload Git history or reconstruct the review. The browser patches only the merge control and status banner, so current selection, scroll, code attachment, and composer drafts remain unchanged. Polling starts at two seconds, doubles while the same active state persists, and caps at thirty seconds; a lifecycle transition or explicit user action resets the interval. A review action advances the merge-poll generation, preventing an older response from re-enabling retry against pre-action review state. The action stays disabled while submitting or queued and after confirmed merge. Removal or failure exposes the reason but keeps retry disabled until a full review refresh revalidates current GitHub blockers. Retry is then offered only for an unchanged reviewed context, and the full gate is revalidated twice before another enqueue.

Transient or incomplete GitHub observations leave the attempt active and surface an observation error. Only a validated queued, merged, removed, or failed observation changes durable state. Queue rules count as the server-side current-base guard; adapters without queue inspection continue to fail closed.

Both pre-action validation reads must agree on whether merge queues apply. Queue mode performs one final fresh validation after capturing its timeline cursor, immediately before durable ownership and `gh pr merge`. Any mode change aborts before the command; the coordinator never decides whether to create durable queue ownership from an earlier observation.

## Acceptance evidence

Controlled unit and browser regressions cover enqueue success, delayed merge, queue removal, unmergeable failure, head replacement, retry, stale observation publication, active-attempt retry refusal, shutdown settlement, durable restart recovery, and preservation of UI input while polling. Final evidence is recorded against the exact pushed PR head.

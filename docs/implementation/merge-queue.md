# Merge-queue lifecycle (#24)

Queue-backed merging is enabled only when the configured GitHub adapter implements the recorded K1 queue-observation contract. The reviewed head remains the authority throughout the lifecycle; browser requests never supply a head, attempt ID, or queue conclusion.

## Durable lifecycle

SQLite owns the merge-attempt record and retains its plan revision, snapshot, review version, and exact reviewed head. Legal transitions are:

```text
submitting -> queued -> merged
                    -> removed
                    -> failed
```

An observation may settle `submitting` after a process restart, because the enqueue command may have completed before the local queued update. Enqueue command success is never recorded as merged. Once the external command succeeds, a later local refresh failure does not turn that committed action into a command failure; the persisted `submitting` record remains disabled and recoverable through queue inspection.

Every update compares the current attempt ID and legal source state. A delayed poll for an older attempt therefore cannot overwrite a retry. Removed and failed attempts retain GitHub's terminal reason. Retry creates a new attempt only when the same revision, snapshot, review version, and reviewed head are still current. A replaced head marks the old attempt as requiring fresh review; after the new snapshot is reviewed, the old attempt is historical rather than retryable.

## Runtime ownership

The coordinator owns at most one enqueue and one shared queue inspection. Cancellation does not release either operation until its GitHub call settles. Shutdown rejects new HTTP work, aborts and awaits both operations, drains admitted requests, and only then lets the service close SQLite.

`GET /api/merge` is the narrow polling path. It reads only the persisted attempt and the K1 queue observation; it does not reload Git history or reconstruct the review. The browser patches only the merge control and status banner, so current selection, scroll, code attachment, and composer drafts remain unchanged. The action stays disabled while submitting or queued and after confirmed merge. Removal or failure exposes the reason; retry is offered only for an unchanged reviewed context, and the full gate is revalidated twice before another enqueue.

Transient or incomplete GitHub observations leave the attempt active and surface an observation error. Only a validated queued, merged, removed, or failed observation changes durable state. Queue rules count as the server-side current-base guard; adapters without queue inspection continue to fail closed.

## Acceptance evidence

Controlled unit and browser regressions cover enqueue success, delayed merge, queue removal, unmergeable failure, head replacement, retry, stale observation publication, active-attempt retry refusal, shutdown settlement, durable restart recovery, and preservation of UI input while polling. Final evidence is recorded against the exact pushed PR head.

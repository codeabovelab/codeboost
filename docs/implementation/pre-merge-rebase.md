# Pre-merge rebase foundation

**Issue and lane:** #22, lane F3. This is the trusted local rewrite and recovery boundary. It does not yet push the rewritten head, run plan `cmd:` checks, wait for GitHub checks, or hand a pair to the merge coordinator; those remain F4-F6 work in #22.

## Ownership and lifecycle

Before the first Git process, `Store.beginRebase` records one marker in `tasks.rebase_in_progress`:

```text
{ attemptId, oldBase, oldHead, onto, startedAt, processGroup }
```

Admission checks the current plan revision, snapshot, review version, task state version, mergeable task status, cancellation state, active runner attempt, active merge, existing rebase, and both ends of the reviewed snapshot. Recording the marker advances the task state version. While it exists, another rebase, the legacy rewrite path, merge admission, runner admission, reassignment, and ordinary status changes fail closed. Cancellation remains pending until the owned rebase has settled and exact-attempt cleanup clears the marker; that cleanup then closes the task.

`processGroup` is null only while no Git call owns work. Immediately before spawn it becomes `spawning`; the synchronous spawn callback replaces that with `{ pgid, startedAt }`. After that exact group is confirmed settled, a compare-and-swap clears it. A group that cannot be drained remains recorded, and a descendant that escapes the group leaves `unsettled`; restart recovery fails closed on either unknown state. A duplicate spawn or late settlement therefore cannot replace or erase another live process owner.

`GitRebaser` works only in `<runner.root>/<runner owner>/rebases/<attempt UUID>`, beside the runner-owned bare repository. It accepts at most 500 commits and requires the old history to be complete, linear, and descended from the recorded base. Git runs with user/system configuration, hooks, replacement objects, lazy fetches, maintenance, and submodule recursion disabled. Before and after replay, a bounded verifier reads the index as NUL-delimited bytes, checks path spellings against raw directory entries, and compares file modes, symlink bytes, and path-filtered file hashes before requiring the index tree to equal the expected commit tree. It never enters a gitlink or trusts Git's stat cache. One monotonic deadline covers history inspection, worktree creation, replay, validation, ref retention, process-group teardown, and cleanup, with explicit budget reserved for teardown and cleanup. Rebase diagnostics retain only a bounded prefix without stopping Git; conflict classification reads the unmerged index instead of diagnostic text. Other abnormal process outcomes retain their timeout, cancellation, output-limit, or unsettled-group reason. If cleanup also fails, both failures are retained with the original as the cause. The rewrite uses one commit for every old commit, including empty or already-applied commits, so ledger mappings stay one-to-one. A successful head is retained at `refs/codeboost/rebases/<attempt UUID>`; its mutable worktree is removed before the call returns.

`Store.finishRebase` accepts that result only from the same attempt while the captured plan, snapshot, review version, task version, old base, old head, and target base are unchanged. A non-empty mapping must end at both the captured old head and the committed rewritten head; an empty mapping is valid only when the captured history is empty and the result equals the new base. The snapshot, rewrite map, and owned/foreign ledger provenance commit atomically, and the marker clears in that transaction. A stale result changes nothing and leaves its marker for exact-attempt cleanup.

Conflicts are a review outcome (`RebaseConflict`). Cancellation and failures settle the Git process group before cleanup. Cleanup removes only the validated UUID workspace. A partially created but unregistered worktree is removed only after Git's own worktree list proves it is not registered. Result refs are created atomically from the absent state; a reused attempt ID cannot overwrite or delete a previously retained result, while an ambiguous create is reconciled against the exact attempted value.

## Restart recovery

Startup validates every stored marker before touching its resource. If its recorded process group is still alive with the same start time, recovery terminates and awaits it first. If the group has disappeared, recovery independently proves that no process still has the rebase workspace open before clearing that group owner. The production recovery adapter accepts only the configured plan key, then removes the matching worktree and unfinished result ref from that plan's runner repository. Only after that succeeds does `Store.abortRebase` compare-and-swap the same attempt ID to clear the marker. A missing adapter, malformed marker, wrong plan, process or cleanup failure, workspace user, or changed marker blocks startup and retains the durable ownership evidence.

This ordering is intentionally local-only. The later push integration must extend the durable lifecycle before its first external write and reconcile an ambiguous push outcome; it must not reuse this local completion point as proof that GitHub moved.

## Regression evidence

`test/runner-rebase.test.ts` covers clean one-to-one replay, the already-current no-op, process-group ownership, the whole-operation deadline, conflicts, cancellation before and during Git, exact cleanup, retained refs, and a read-only source checkout. `test/runner-lifecycle-store.test.ts` covers admission, durable process ownership, and compare-and-swap races plus owned/foreign provenance. `test/runner-recovery.test.ts` covers process termination and restart ordering plus fail-closed absence of a recovery implementation. `test/runner-production.test.ts` covers exact-plan recovery routing.

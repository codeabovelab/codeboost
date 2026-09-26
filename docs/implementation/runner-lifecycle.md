# F1 runner lifecycle and state-holder contract

**Status:** contract proposed; the four open decisions are approved (2026-09-25). Nothing in this document is implemented yet.
**Lane and step:** lane F (runner and pre-merge automation), step F1. Related issue: #22.
**Baseline:** `main` at `af8f3c2` (D1–D5 merged). The D changes this contract needs are tracked in #51.

## About this document

**Who it is for.** People who build or review lanes F, G, I, J and K, and the agent that implements F1.

**What it is for.** The plan requires F1 to publish and review its lifecycle contract before any F1 code is written. This document is that contract. It says:

- which states a runner job can be in, and which changes between states are legal;
- which part of the program owns each piece of state, and when that owner may let go of it;
- when a retry is allowed;
- the order of steps when the program shuts down;
- the feedback events that the learning lane (J) will read.

**When implementation starts.** The plan starts F implementation after D5 merges, and D5 merged as #50. F1 code can start now. The attempt lifecycle itself uses only the D interface already on `main` (`agents/contract.ts`), which D4 (#47) did not change. Preparation, shutdown and startup recovery need D changes that do **not** exist yet: bounded settlement; `runnerOwner` (and the attempt ID) on `InvocationInput` and on every allocator that runs before an invocation; a scoped `recoverLeftovers` API that returns authenticated storage handles; and asynchronous, abortable versions of both preparation helpers, `createTaskClone` and `prepareTaskFilesystems`. They are listed as prerequisites under "Shutdown". D5 delivered none of them: it did not change `agents/contract.ts`, and its hand-off doc confirms that the supervisor still retries cleanup until settlement (`docs/implementation/agent-isolation.md`). They are tracked in #51. The F1 implementation may start against fakes, but it must not merge until #51's pre-F1 items land.

## Summary

1. Every agent run or runner command is an **attempt**. An attempt has one ID, which is never reused. A retry is a new attempt.
2. An attempt moves through `pending → running → completed | failed | cancelled | stale`. The runner as a whole is `open` or `closing`.
3. For attempts that can write to the task folder, the durable record becomes terminal only after the container has stopped. "Cancel" first records the reason and shows "Stopping". It does not free anything.
4. A result is saved only if a compare-and-swap succeeds: the attempt ID must still be the task's current attempt, and the captured context (including the context generation) must still be current. Late results are thrown away, but their container must still stop before its slot is freed.
5. Retry is allowed only when the last attempt is terminal on disk, nothing for that task is still running in this process, and its captured context still matches the current code, plan and assignment. Otherwise the user must start a new request.
6. Shutdown order: reject new work → drain HTTP requests (with a time limit) → abort and await request-owned work → cancel and await runner jobs → write terminal states → close storage → release the runner lock.
7. Each piece of user feedback becomes one append-only **feedback event**, written in the same transaction as the user action, or, for a merge, in the same transaction as the confirmed outcome. Lane J reads these events after a task closes.

## Terms used

| Term | Meaning in this document |
|---|---|
| Task | One run of one GitHub issue through its plan, from start to merge or cancel. A task is identified by its full `PlanIdentity` (`repositoryId`, `taskId`, `planId`, from `core/identity.ts`), stored as its `identityKey` (the plan key). A bare `taskId` is never used alone, because it is unique only inside its repository and plan. |
| Attempt | One agent invocation or one runner command for a task. Has a unique `attemptId`, which the `Store` generates as a lowercase UUID v4. Any stored value that does not match `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` is refused before it is used anywhere, including as a directory name. |
| Phase | D's invocation profile, from the closed `Phase` union in `agents/contract.ts`: `planning`, `questions`, `review`, `execute`, `fix`. `captureInvocation` rejects any other value. |
| Attempt kind | F's own label for an attempt, stored on the attempt row. Each kind runs under exactly one D phase (see the table below). |
| Writable attempt | An attempt whose D phase is `execute` or `fix`. It can change the task folder. |
| Captured context | The `InvocationContext` saved when an attempt is admitted: snapshot ID, plan ID, plan revision, assignment ID, referenced-code hash, and the task's context generation (sent in D's `stateVersion` field). |
| State version | A number stored on each task. It goes up by one on every durable change to the task or its attempts, including an attempt's own lifecycle changes. The UI and user actions use it for ordering and compare-and-swap. It is **not** part of the captured context. |
| Context generation | A second number stored on each task. It goes up only when something an attempt depends on changes: the plan revision, the snapshot, the assignment or the referenced code. Every such change also increases the state version in the same transaction, so UI ordering and user-action checks see it too. Attempt lifecycle changes increase only the state version, never the context generation. F puts it in `InvocationContext.stateVersion`. |
| Current | A captured context is current when its snapshot ID, plan ID, plan revision, assignment ID, referenced-code hash and context generation all match the task's present durable values. An attempt's own transitions therefore never make it non-current. |
| Settled | D's `InvocationHandle.settled` promise has resolved. The container and its output capture have stopped. |
| First reason | The first stop reason recorded for an attempt: `cancelled`, `shutdown`, `stale` or `time-limit`. Later reasons never replace it. |
| Slot | The in-memory right to run an attempt. A limited number of slots exist. |
| Admission | The point where the runner accepts new work and writes the pending attempt. |
| Feedback event | An append-only record of one piece of feedback that the user wrote or chose. |

### Attempt kinds and D phases

F never sends D a phase outside D's union. Runner-only work is modelled as an attempt kind that maps to an existing D phase.

| Attempt kind | D phase | Why this phase |
|---|---|---|
| `planning` | `planning` | Read-only authoring |
| `question` | `questions` | Read-only answer |
| `review` | `review` | Read-only review agent |
| `check` | `review` | Runs only the approved `cmd:` argv through D's dispatcher, on the read-only mount |
| `execute` | `execute` | Carries out one plan item on a writable mount |
| `fix` | `fix` | Fixes one review problem on a writable mount |
| `rebase-fix` | `fix` | Resolves one rebase conflict. F's post-run audit refuses changes outside the conflicting files. |

If F3 needs a D profile that no existing phase provides, that is a change to `agents/contract.ts`. It goes through D's owner and its contract tests before F3 uses it.

## State holders and owners

AGENTS.md requires these five holders to be treated separately. Each one has exactly one owner.

| Holder | What it holds | Owner | It lets go when |
|---|---|---|---|
| Durable records | Task rows, attempt rows, feedback events (SQLite through `runner/store.ts`) | `Store`. It is the only writer. | Never deleted by the lifecycle. Terminal rows stay as history. |
| In-memory jobs | One `Job` per active attempt: attempt ID, handle, first reason, settlement promise | The runner coordinator (one instance per process) | After D's `settled` resolves **and** the terminal durable write has succeeded. If that write fails, the job becomes an unresolved marker (see "Slots and concurrency", rule 5) and is not removed. |
| Agent containers and their processes | The agent container, capture processes, egress proxy and network, and their cleanup | D (the adapter behind `InvocationHandle`) | When `settled` resolves. F never signals or kills these directly. |
| Task storage | The task-storage volumes and keeper container for one attempt | **F holds the capability** (`TaskFilesystems` from `prepareTaskFilesystems`, or a recovery handle); D implements the operations | It outlives `settled`. Order for every writable attempt, whatever its outcome: `settled` → the partial-output export if the attempt did not complete (a completed attempt's work is taken out by F2's commit step instead) → the terminal write, which stores `diagnostic_ref` → `removeTaskFilesystems` → the slot is freed. If removal fails, the slot stays held under an unresolved marker, and startup recovery removes the storage. D never removes it at settlement. |
| Preparation subprocesses and files | Host-side work F runs before launch, such as `git clone`, and the attempt directory it fills | F (the job, then startup recovery) | When the process group has exited and the attempt directory has been captured and removed (see "Launch"). |
| Admitted HTTP requests | Requests that have passed the token and admission checks | `web/server.ts` (`activeRequests`) | After the response ends, or after it is aborted during shutdown |
| Rendered UI | What the browser shows, drafts, selections, the latest state version seen | `web/public/app.js` | It never owns durable truth. It shows server state and keeps unsent input. |

## Attempt states

### States

| State | Meaning | Durable? | UI label |
|---|---|---|---|
| `pending` | Admitted and saved. The container has not started yet. | yes | Waiting to start |
| `running` | D returned a handle. The container may be running. | yes | Running, or Stopping if a stop reason is recorded |
| `completed` | The result passed validation and was saved by compare-and-swap. | yes, terminal | Done |
| `failed` | Non-zero exit, timeout, output limit, capture failure, invalid output, or interrupted by a crash. | yes, terminal | Failed: *reason* |
| `cancelled` | Stopped by a user, a hard stop, or shutdown. | yes, terminal | Cancelled: *reason* |
| `stale` | Its captured context stopped being current before its result was saved. | yes, terminal | Out of date: *cause* |

`closing` is a state of the whole coordinator (`open → closing`), not of one attempt.

### Legal transitions

Any change not in this table is illegal. The `Store` refuses it.

| From | To | Trigger | Guard |
|---|---|---|---|
| — | `pending` | Admission | In memory, first: coordinator is `open`, no job or unresolved marker for the task, and a slot is free; then reserve the slot. In one `Store` transaction: the task's status is `running` or `queued`; task state version equals the caller's expected version; no non-terminal attempt exists for the task; captured context is current. |
| `pending` | `running` | D returns a handle | Attempt ID is the task's current attempt; state is `pending`; **no first reason recorded**. The launch check (see "Launch") ran immediately before the D start call. |
| `pending` | `cancelled` | Stop before or during launch | Same attempt ID; state is `pending`; first reason is `cancelled`, `shutdown` or `time-limit` |
| `pending` | `stale` | Context changed before launch | Same attempt ID; state is `pending`; first reason is `stale`, or no first reason and the context is no longer current |
| `pending` | `failed` | Preparation or launch error | Same attempt ID; state is `pending`; **no first reason recorded; captured context still current** (otherwise the row takes `stale`) |
| `pending` → `pending`, `running` → `running` | same state, first reason set | A stop request ("Stopping") | Same attempt ID; state unchanged; **first reason is null**. It sets the first reason, and the attempt's state stays the same. The state version increases. This is how rule 1 of "Rules for the running state" becomes durable. |
| `running` | `completed` | Validated result | Attempt ID is current; state is `running`; no first reason recorded; captured context still current; **task status is not closed (neither `merged` nor `cancelled`) and `cancel_requested` is null** |
| `running` | `failed` | Settled with an error or invalid output | Attempt ID is current; state is `running`; captured context still current (otherwise the row takes `stale`); and **either no first reason recorded, or first reason `shutdown` with a D `stopReason` of `timeout`, `output-limit` or `capture-failure`** (D stopped first; see rule 2) |
| `running` | `cancelled` | Settled after a user, hard-stop, shutdown or time-limit reason | Attempt ID is current; state is `running`; first reason is `cancelled`, `shutdown` or `time-limit` |
| `running` | `stale` | Settled after the context changed | Attempt ID is current; state is `running`; first reason is `stale`, **or** no first reason is recorded and the context is no longer current (a change made by another transaction that the runner had not yet seen) |
| `pending` or `running` | terminal state from the first reason, or `failed` if there is none | Startup recovery (the previous process died). Uses the same first-reason mapping as settlement. | Runs before admission opens, after D's recovery has removed leftover containers |

**Admission requires an active task.** Every admission, not only a retry, needs task status `running` or `queued`. A closed task (`merged`, `cancelled`) never admits work. A human-gated task must first be moved back by its own explicit user action, which is a separate transition in F2 or lane I.

**Admission is two steps.** SQLite cannot check in-memory facts, so the coordinator first checks `open`, the task's job or marker, and slot capacity, and reserves a slot, all in one synchronous turn with no await. It then runs the `Store` transaction. If the transaction refuses or throws, the coordinator releases the reservation in the same turn. Two admissions therefore cannot both see the same free slot.

These guards enforce the first-reason precedence in "Rules for the running state", rule 2: once a first reason is recorded, only the matching terminal state is legal.

Every legal change increases the task's state version by one. Recording a first reason on a `running` row is also a durable change and increases it, so a poll can show "Stopping".

### Launch: ending an attempt that has no handle

A `pending` attempt has no `settled` promise, so the slot rules need a separate release path for it. Between admission and launch, F may prepare resources such as the task clone and the prompt. The in-memory job tracks that preparation as its own promise, with the same ownership rules as an invocation:

- Preparation receives an `AbortSignal` from the job. Stopping a pending attempt aborts that signal with the first reason.
- **Preparation files have a durable owner.** The attempt ID is used as a directory name only after it passes the UUID check under "Terms used", so it cannot contain `/` or `..`. Before preparation creates anything, F uses the fixed attempt directory `<runner root>/<runner owner token>/attempts/<attemptId>/`, and passes it as the parent to the clone helper. The helper names its clone with `mkdtemp`, so the fixed parent is what makes the clone findable after a crash. **Today's `createTaskClone` (`git/clone.ts`) runs git with synchronous `execFileSync`.** It cannot be aborted and would block the event loop, so F1 cannot use it for preparation as it is. D, which owns `git/clone.ts`, must add an asynchronous variant that takes an `AbortSignal`, spawns git in its own process group, and exposes that group's ID (third prerequisite under "Shutdown").
- **Preparation processes have a durable owner.** Right after spawning a preparation child, in the same synchronous turn, F saves the process group ID and the child's start time on the attempt row (`preparation_pgid`, `preparation_started_at`). A process group outlives the runner if the runner crashes, so startup recovery uses these fields to stop it (step 4). To close the gap between spawn and that write, F first saves `preparation_started_at` with a null `preparation_pgid` (**preparation starting**), then spawns, then saves the group ID. If recovery finds an attempt that is marked as starting but has no group ID, a child may exist that nobody can identify. Recovery then **fails closed**: it does not open admission, it leaves that attempt directory in place, and the CLI names the attempt and its directory. The user must stop the unknown process and then confirm with `--release-preparation <attemptId>`. A quiet directory proves nothing, because a blocked process may resume later, so codeboost does not rely on it. Before removing anything, it checks that no process has a file open or a working directory inside the attempt directory, using `lsof +D` on macOS or `/proc/*/fd` and `/proc/*/cwd` on Linux. If a process is found, or the check cannot run, it refuses and keeps admission closed. The path comes only from IDs that are already saved, so a crash cannot leave an unknown path. The job removes the directory when the attempt ends. Startup recovery handles the rest (step 4).
- An `AbortSignal` does not stop a child process by itself. Every preparation subprocess (for example `git clone`) is started in its own process group, owned by the job. On abort, F sends `SIGTERM` to the group, waits a fixed grace period (5 seconds), then sends `SIGKILL`, and awaits the `close` event. Preparation settles only after that. A child that ignores `SIGTERM` is therefore still bounded by the kill. Preparation never leaves work running after it settles.
- Preparation counts against two limits, so it cannot hold a slot forever. The task budget is already running during preparation: the admission transaction of the task's first attempt moves the task to `running` and sets `budget_deadline` (see "Proposed storage additions"), before preparation starts. If the **task time budget** runs out first, the job records the first reason `time-limit`, then aborts the signal; the pending row ends `cancelled` and the task goes to `needs human`, as for a running attempt. If the **attempt deadline** passes first, the job aborts the signal with `timeout` and records no first reason; the row ends `failed` "Timed out while preparing".
- Shutdown aborts every preparation signal in step 4.

| Case | What F does | When the slot is freed |
|---|---|---|
| Preparation fails before the D start call (for example the clone fails) | Preparation has already stopped its own subprocesses before rejecting (rule above). Remove anything it created. Write the terminal state from the first reason if one is recorded; otherwise write `failed` with the bounded preparation error. | After that terminal write succeeds |
| Stop or context change before the D start call | Record the first reason. Await the preparation promise and remove anything it created. Then write the terminal state (`cancelled` or `stale`). | After that terminal write succeeds |
| The D start call throws | Write the terminal state from the first reason if one is recorded (a stop can be recorded while preparation is finishing); otherwise write `failed` with the launch error. D4's adapters throw only after their setup cleanup has succeeded. If cleanup is still unfinished, they return a handle instead, which settles when cleanup ends. So nothing is left running. | After that terminal write succeeds |
| The D start call returns a handle | Write `pending → running`. From here the running-state rules apply, even if the handle comes from failed setup that is still cleaning up. | After `settled` resolves and the terminal write succeeds |
| The handle arrives, but `pending → running` is refused because a first reason is now recorded (a stop landed while preparation finished) | This is a normal stop, not a storage failure. Call `handle.cancel(...)` with the matching D reason, await `settled`, then write the terminal state from the first reason (`pending → cancelled` or `stale`). | After `settled` and that terminal write, as usual |
| The handle arrives but the `pending → running` write fails for any other reason (for example a storage error) | Keep the job with its handle, call `handle.cancel('capture-failure')`, and await `settled`. Then keep an unresolved marker for the task, because the row is still `pending`. | Only at startup recovery |

**Launch check.** Immediately before the D start call, in one synchronous turn with no await between them, F reads the task and plan rows (the `Store` is synchronous) and confirms that the attempt is still `pending`, has no first reason, has a current captured context, and has time left. For the time check it reads the clock in the same turn: if the task budget is spent, it records `time-limit` and ends the row `cancelled` (the task goes to `needs human`); if the attempt deadline has passed, it ends the row `failed` "Timed out while preparing". In both cases D is not called. Only when every check passes does it call D's start, which is also synchronous. If the context is no longer current, F takes `pending → stale` without launching. A writable invocation therefore never starts against an old plan, snapshot, assignment or referenced code. The later publish check cannot undo filesystem changes.

In every case, a failed terminal write leaves an unresolved marker (see "Slots and concurrency", rule 5).

**Launch setup must not block the server.** The D4 adapters do their Docker setup synchronously inside the start call: `createVendorNetwork`, profile creation and `startProfileInvocation` use `execFileSync` and `spawnSync` (`agents/network/network.ts`, `agents/container/`). While that runs, the event loop cannot set `closing`, cancel the launch, or begin the HTTP drain. **Prerequisite:** D's start call must return its handle at once and do the Docker setup asynchronously inside that handle's lifecycle. Then `cancel()` works during setup, and `settled` resolves only after setup cleanup. It is listed with the other D prerequisites under "Shutdown".

**Rule for D.** D's start call must keep this shape: it either throws with nothing left running, or it returns a handle that settles only after everything it started has stopped. An adapter that needs an asynchronous start must still follow this rule. Changing it is a change to D's contract.

### Rules for the running state

1. **Stop requests do not end the attempt.** A cancel, hard stop, shutdown, time limit or detected staleness sets the first reason on the in-memory job, writes it onto the row, and calls `handle.cancel(...)`. The row stays `running`, and the UI shows "Stopping".

   **The in-memory job is the source of the first reason until the terminal write.** The terminal write stores the job's first reason and the terminal state together in one transaction. So if the earlier reason write fails, nothing is lost while the process lives, and the UI shows "Stopping (not saved yet)". If that terminal write also fails, the unresolved marker keeps the reason in memory. The one case that loses it is a crash after a failed reason write and before a successful terminal write. Startup recovery then records `failed` "Interrupted" and adds "a stop may have been requested" to the diagnostic. It cannot recover a reason that was never saved.
2. **The terminal state comes from the first reason.** When `settled` resolves, the terminal state is chosen in this order:

   | First reason recorded by F | D result | Terminal state |
   |---|---|---|
   | `cancelled` (user or hard stop) | any | `cancelled` |
   | `shutdown` | `stopReason` is `timeout`, `output-limit` or `capture-failure` | **D's reason wins.** D keeps the first reason it received, so a non-shutdown `stopReason` proves D stopped the attempt before the shutdown request reached it. The row ends `failed` with D's reason, and it is not requeued as a shutdown cancellation |
   | `shutdown` | any other | `cancelled`, with the reason "Stopped by shutdown" |
   | `stale` (context change) | any | `stale`, with the cause (for example "plan revision 4 replaced 3") |
   | `time-limit` | any | `cancelled`, reason "Task time limit reached"; the same transaction sets the task's status to `needs human`, **but only if the task is not closed and `cancel_requested` is null**. A pending cancel task wins: the same transaction closes the task as `cancelled` and inserts `task-closed`, and the time limit only supplies the attempt's diagnostic. A closed status never changes. |
   | none, and the captured context is **not current** | any | `stale`, with the cause. This row comes before every D stop reason, so a timeout that coincides with a context change always ends `stale` |
   | none | `stopReason` `timeout` | `failed`, reason "Timed out after *n* minutes" |
   | none | `stopReason` `output-limit` or `capture-failure` | `failed`, with D's bounded diagnostic |
   | none | exit 0 and output passes validation | `completed` (if the compare-and-swap succeeds) |
   | none | anything else | `failed`, with the bounded exit and stderr summary |

3. **F keeps its own reason.** D's `StopReason` has no `stale` value. F passes `cancelled` to D for staleness, and keeps the real cause in its own first-reason field. No layer may replace an actionable reason with generic cancellation text.
4. **Timeouts are D's job.** F sets `deadline` in `InvocationInput` and does not run a second timer that settles early. F also enforces a whole-task time budget (default 2 hours). When the budget runs out, F follows rule 1: it records the first reason `time-limit` and calls `handle.cancel('timeout')`. The row stays `running` and the slot stays held. After `settled` resolves, one transaction writes terminal `cancelled` and sets the task to `needs human`. Startup recovery applies the same mapping, so a crash before settlement still ends in `needs human`, and the retry guard refuses it.
5. **Late results lose.** If the compare-and-swap for `completed` fails, the result is discarded and the row is settled by the table above. Discarded output still waits for `settled` before its slot is freed.

### Exception for existing read-only lifecycles

E3 suggestions (`requests` table) write `cancelled` to disk when the stop is requested, before the provider settles. This is acceptable for read-only phases, because they share no writable folder with a later attempt and E3's coordinator still blocks a new start until the provider settles. **New F records use the stricter rule above for every phase.** The table under "Existing lifecycles" records how each one maps.

## Slots and concurrency

1. A slot is taken at admission. For an attempt that got a handle, it is freed only in the `finally` step that runs after `settled` resolves. For an attempt that ended without a handle, it is freed by the "Launch" table above. In both cases the terminal write must have succeeded first. Cancel does not free a slot. Lease expiry and clock changes do not free a slot.
2. At most one non-terminal attempt exists per task.
3. codeboost 1.0 runs one task at a time. Writable attempts therefore share one global slot.
4. Existing limits stay: two question slots (`runner/questions.ts`); one suggestion request per plan identity (E3).
5. A slot is freed only after the terminal durable write succeeds. If `settled` has resolved but the write fails, or its outcome is unknown, the coordinator keeps an **unresolved marker** for that task in place of the job. The marker holds the slot and blocks admission and retry for the task. The UI shows "Needs restart: result could not be saved". Only startup recovery clears the marker, because it runs before admission and reconciles the durable row. The coordinator never removes a marker on its own.

## Retry

A retry is a new attempt with a new attempt ID. The runner allows it only when all of these are true:

| Check | Where it is checked |
|---|---|
| The last attempt for the task is `failed` or `cancelled` on disk, **and** the task's status is `running` or `queued`, **and** `requeue_pending` is false | `Store` transaction |
| No in-memory job **and no unresolved marker** exists for the task | Coordinator, synchronously before the transaction |
| The caller's expected state version and attempt ID match the task's current values | `Store` transaction (prevents a double retry from two tabs) |
| The last attempt's captured context is still current: snapshot ID, plan ID, plan revision, assignment ID, referenced-code hash and context generation (every field in "Current") | `Store` transaction |
| The coordinator is `open` | Coordinator |

**Closed and human-gated tasks are never retryable.** If the task is closed (`merged` or `cancelled`) or waits for a person (`needs human`, `needs amendment`, `needs approval`, `possibly already fixed`), retry is refused. Leaving a human-gated status needs its own explicit user action, such as sending the task back with guidance or approving a continuation. That action belongs to F2 or lane I, not to retry. A closed task never reopens. The task time limit moves the task to `needs human`, so a timed-out task cannot be retried this way either.

A `stale` attempt can never be retried. The UI instead offers "Run again on the current code". That creates a new request, which captures a fresh context.

The server computes `retryable` and sends it to the UI. The UI never works it out itself.

## Publishing a result

1. Wait for `settled`.
2. Validate the output (schema, size, file-scope audit for writable attempts). Do not await anything between the last check and the transaction.
3. **If the job holds an in-memory first reason** (its earlier write failed), skip publication: settle the row through the first-reason mapping in rule 2, passing that reason. Otherwise, in one `Store` transaction: confirm that the attempt ID is the task's current attempt, the state is `running`, there is no first reason, the captured context is still current, the task is not closed, and `tasks.cancel_requested` is null (the same guard as the `running → completed` row). Do not compare the task's state version here; the attempt's own transitions have increased it. Then write `completed` and the result, and increase the state version.
4. If step 3 refuses, reread durable state and settle the row by the rules above. Keep the original diagnostic.
5. For a completed writable attempt, F2's result extraction is split in two:
   - Step 2, before any `Store` write, makes the commit object inside the still-present task storage. It records nothing in the `Store`.
   - The step-3 transaction first runs every guard against the captured context. Then, in the same transaction, it writes `completed` and records the ledger entry (`recordHistory`), which increases the context generation. Because the guard runs before that increase inside one transaction, the attempt's own ledger write never makes it non-current.

   If step 3 refuses, nothing reaches the `Store`, and the unpublished commit is discarded when the task storage is removed. Then, for every writable attempt, call `removeTaskFilesystems` after the terminal write, whatever the outcome. Free the slot only after it succeeds. If it fails, keep an unresolved marker, and startup recovery removes the storage.

**Irreversible actions.** Before each commit, push, PR open or merge, re-read the task's state version, the plan's `review_version` (which `saveReview` and `addReviewNote` advance) and the coordinator's `closing` flag **after the final await**. Stop if any of them changed. For a merge this means an approval or choice edit made during the final GitHub check blocks the merge. A check made before an await does not count. (This follows the AGENTS.md rules on guarded external actions.)

## Shutdown

`web/server.ts` `close()` and the runner coordinator follow this order. Part of step 1 and all of steps 2 and 3 already exist. F1 adds the coordinator barrier in step 1, steps 4 and 5, and step 8.

| Step | Action | Existing? |
|---|---|---|
| 1 | Set `stopping` on the server and `closing` on every coordinator (runner, questions, suggestions, merge), in the same synchronous turn, before any active-work list is copied. New API requests get HTTP 503. Every coordinator's start method checks `closing` synchronously and throws, so a request admitted before shutdown cannot start new work after it. | server flag: yes. Coordinator barrier: **new**. Today `close()` sets only `stopping`, and `questions.close()` runs later, so a request that was still reading its body can call `questions.start()` after shutdown began. The server also rechecks `stopping` after reading a body only for `merge`, so `service.act`, `setQuestionProvider` and future planning writers can still change the `Store`. F1 adds a `stopping` check after the body is read and before **every** mutating dispatch, returning HTTP 503, and adds regressions for each writer. Two GET handlers also write: `/api/review` (`ReviewService.load()` calls `recordHistory` when HEAD moved) and `/api/merge` (queue polling records merge observations and outcomes). `/api/review` can also write after an await: `merges.displayStatus()` checks GitHub and can then record a direct merge (`finishMergeAttempt`, `runner/merge.ts`). Per-handler checks would miss paths like this, so F1 adds a **write gate on the `Store`**. Step 1 closes the gate in the same synchronous turn. After that, every `Store` write method throws "Shutting down" unless the caller passes the shutdown capability. The server hands that capability at construction to each coordinator's own settlement and `close()` code: the runner, questions (`finishAnswer` after abort), suggestions (`settleSuggestion` in E3's `close()`) and merge. Startup recovery holds it too. HTTP handlers and `ReviewService` never receive it. So after step 1, only work that is settling can write, and it can still record its terminal rows before step 7 closes the `Store`. The gate throws a distinct `ShuttingDownError`, which the server maps to HTTP 503 "The review server is shutting down.", never to the 409 used for review errors. So an admitted `/api/review` whose `load()` reaches `recordHistory` after step 1 returns 503 with no view, and the UI treats it like any other 503 during shutdown. There is no partial or read-only view. Merge reconciliation and queue polling hit the same gate. **Today both catch every error and turn it into a status** (`displayStatus()` and `#pollQueue()` in `runner/merge.ts`), which would swallow the gate error and answer HTTP 200. F1 changes each of these catch blocks to rethrow `ShuttingDownError` first, before any other handling, so these paths also end with 503. The next startup checks GitHub again, so a skipped merge observation is recovered, not lost. Regressions cover `/api/review` history, `/api/review` direct-merge reconciliation during the GitHub await, and `/api/merge` polling. |
| 2 | Stop accepting connections, and wait for admitted requests up to the drain limit (at most 14.5 s, below the 15 s request timeout). | yes |
| 3 | After the drain limit, abort the signals of the remaining requests, destroy requests that are still reading a body, then await request-owned work (the merge coordinator). | yes |
| 4 | For every `pending` and `running` attempt that has an in-memory job, record the first reason `shutdown` **only if no first reason is set yet**. A job already marked `cancelled`, `stale` or `time-limit` keeps its reason. For `running`, call `cancel('shutdown')` and await `settled`. For `pending`, await its preparation promise (and the D start call if it is in progress), remove what preparation created, and cancel any handle that start returned, then await its `settled` (the "Launch" table). F does not abandon a job after a timer (decision 4). **This is not yet guaranteed to end:** D4's supervisor escalates to a forced kill, but it retries unfinished container, network or setup cleanup every second with no limit (`agents/adapters/supervisor.ts`). If Docker is unreachable, `settled` never resolves and shutdown waits with the `Store` open. See the prerequisite below. | new |
| 5 | For each attempt from step 4, in the order set by the task-storage holder row: the partial-output export (writable attempts), then the terminal state from its first reason (a `shutdown` reason gives `cancelled` "Stopped by shutdown") with its `diagnostic_ref`, then `removeTaskFilesystems`, and only then free its slot. A failed write leaves the row non-terminal, and a failed removal keeps the slot held. Startup recovery handles both. | new |
| 6 | Await server closure; await the question and suggestion coordinators' `close()`. | yes (questions); suggestions: new wiring |
| 7 | Close the `Store`. | yes |
| 8 | Release the single-runner lock (decision 1). Release it on every exit path after it was taken, including a startup failure. | new |

**Partial output and interrupted rebases.** The design requires a hard stop to keep partial output for diagnosis, and to cancel an interrupted rebase before the workspace is rebuilt.

| Holder | Owner | Rule |
|---|---|---|
| Partial output of a stopped writable attempt | F, using a new D export | The task filesystems are Docker volumes behind a keeper container. F allocates them with `prepareTaskFilesystems` and removes them with `removeTaskFilesystems`; D's supervisor does not remove them at settlement. But F cannot read a volume from the host. So the order is: `settled` → a **D-provided bounded export** (a new D operation, for example `exportTaskDiff(filesystems, maxBytes)`, which runs `git diff` against the last codeboost commit in a read-only container and returns at most 1 MiB) → F saves it → the terminal write stores `diagnostic_ref` → `removeTaskFilesystems` → the slot is freed. **The export has an overall deadline** (60 seconds, passed to D as an `AbortSignal`), because `maxBytes` bounds only the returned data, not the Docker work. On timeout or any export failure, F records "Partial output could not be exported: <reason>" as the diagnostic and continues with the terminal write and removal; shutdown and recovery never wait on an export past its deadline. F saves the export to a runner-owned diagnostics directory, with a total byte cap. **Retention never deletes a file an attempt row still references.** When the cap is exceeded, retention first deletes unreferenced files, oldest first. If that is not enough, it takes the oldest referenced file and, in one transaction, sets that row's `diagnostic_ref` to null and appends "(partial output removed by retention)" to its diagnostic. Only after that commit does it delete the file. No row is ever left pointing at a missing file. The attempt row references it as `diagnostic_ref`. If the capture fails, the row records that it failed. The task filesystem is never reused. |
| Interrupted rebase | F3 | F3 records `rebase in progress` durably before starting a rebase and clears it after. It is stored as `tasks.rebase_in_progress`: null, or JSON `{ attemptId, oldHead, onto, startedAt }`. F3 sets it by compare-and-swap from null, and clears it by compare-and-swap on the same `attemptId`. Startup recovery aborts every recorded rebase through the runner before it hands the task to I3. |
| Workspace rebuild | I3 | I3 never rebuilds before both rows above are resolved for the task. |

**Process shutdown is a hard stop.** When the process stops, the running task does not finish. Its attempt ends `cancelled` with the reason "Stopped by shutdown". Restart recovery (lane I3) puts the task back in the queue. This is different from "Stop the queue" (lane I), which lets the running task finish.

**First prerequisite before F1 merges: settlement ends.** Settlement must be proven to end. D5, or a D follow-up, must either bound cleanup retries and settle with a terminal cleanup-failure result, or show in the real-Docker suite that every cleanup path ends, including when the Docker daemon is unreachable. Until one of these lands, decision 4 stays conditional, and the F1 implementation PR must not merge. F1 does not add its own timer to work around this.

**Second prerequisite before F1 merges: a D recovery API scoped to one database.** Decision 1 allows one runner per database, so several databases can have live runners on the same machine at once. Recovery must therefore never touch another database's resources. D's current labels (`io.codeboost.invocation`, `io.codeboost.task-storage`, `io.codeboost.allocation`, `io.codeboost.egress`) do not say which database owns a resource, so they are not enough.

| Part | Owner | Rule |
|---|---|---|
| Runner owner token | F | A random ID of exactly 32 lowercase hexadecimal characters (`^[0-9a-f]{32}$`), stored in the database (`app_settings`). A stored value that does not match is refused before it is used as a label or in any path, and startup exits. It is stored together with the database file's device and inode numbers. It is read, or created, in startup recovery step 2, after the lock is taken and the `Store` is opened. If the stored device and inode don't match the open file (the database was copied), F creates a new token. So a copy never shares a token with its original. |
| Token in every request | D contract | `InvocationInput` gains a `runnerOwner` field, **and so does every allocator that runs before an invocation exists**: `prepareTaskFilesystems` (which today takes no owner, `agents/container/storage.ts`) and vendor network creation. Every resource D creates carries the label `io.codeboost.runner=<token>`: containers, networks, egress proxies, task-storage volumes and allocations. |
| Recovered storage handles | D | D tracks task-storage ownership in a process-local `WeakMap`, which is empty after a restart. So `recoverLeftovers` returns, for each kept volume set, an **authenticated recovery handle** that D registers in its ownership map after checking the volumes' runner and allocation labels. **Binding to an attempt:** task-storage volumes also carry `io.codeboost.attempt=<attemptId>`, set by `prepareTaskFilesystems` from a new `attemptId` parameter. **F chooses the allocation ID, not D.** F generates it (a lowercase UUID v4) and saves it as `attempts.allocation_id` **before** it starts the asynchronous allocation, then passes it to `prepareTaskFilesystems`, which labels the volumes and keeper with it (`io.codeboost.allocation`). So a crash in the middle of allocation still leaves a row that matches whatever D created. The D prerequisite includes accepting a caller-provided allocation ID. The handle carries both IDs. F uses a handle only if its attempt ID and allocation ID both match one attempt row of this database. A handle that matches no row, or disagrees with the row, is reported and listed by `--list-unowned-agent-resources` for the user to remove by hand; it is never exported or removed automatically. `exportTaskDiff` and `removeTaskFilesystems` accept these handles. F never builds a `TaskFilesystems` value from report fields. |
| Scoped recovery | D | `recoverLeftovers(runnerOwner): Promise<RecoveryReport>` acts only on resources whose `io.codeboost.runner` label equals the token. It stops and removes agent containers, egress proxies and networks, and resolves only when they are gone. **It keeps task storage whole: the volumes and their keeper container**, which it recognises by its task-storage labels. The recovery handle depends on that keeper and lists them in the report by allocation, so F can export partial output first. F then calls `removeTaskFilesystems` for each one (startup recovery step 4). It rejects with a bounded diagnostic if anything cannot be stopped or removed. |
| Unowned resources | D and F | Resources with codeboost labels but no `io.codeboost.runner` label (from builds before this change) fail closed. The report lists them, and F refuses to open admission while any exist. **codeboost never removes them itself**, because it cannot prove that no older-build runner is alive: older builds take no lock this build can see, and an idle older runner may have no container running at the moment of a check. So `--list-unowned-agent-resources` prints each resource and the exact `docker rm` / `docker network rm` / `docker volume rm` commands. The user stops every older codeboost process, runs those commands, and starts again. There is no machine-wide lock. |
| When it runs | F | Only while holding this database's single-runner lock (startup recovery step 1 comes first). |

This belongs to D (D5 or a D follow-up), not F. It changes `agents/contract.ts`, so it goes through D's contract tests.

**Also before F1 merges: asynchronous launch.** D's start call must return a handle immediately and run its Docker setup asynchronously and abortably (see "Launch setup must not block the server").

**Third prerequisite before F1 merges: abortable preparation helpers.** Both preparation helpers are synchronous today. `createTaskClone` runs git with `execFileSync`, and `prepareTaskFilesystems` runs `docker` with `execFileSync` and `spawnSync` (`agents/container/storage.ts`). Either would block the event loop, and cancel or shutdown could not abort it. D must add asynchronous variants of both that take an `AbortSignal`, spawn their subprocesses in their own process group, expose the group ID, and settle only after those processes have exited. Storage allocation must also label its volumes with the runner owner and attempt ID before it returns (see "Recovered storage handles"), so that storage allocated just before a crash is found by recovery.

**Prerequisite before F2's writable attempts: a bounded task-volume export.** D must add a bounded diff export over the task volumes (see "Partial output and interrupted rebases"). F1 does not need it: F1 runs only read-only attempts, and their task storage is removed without an export.

**A second Ctrl+C** does not skip steps 4 to 8. The CLI prints "Still stopping agents…" and keeps waiting.

## Startup recovery

This runs before the coordinator opens.

1. Take the single-runner lock for this database (decision 1), **before opening the `Store`**, because opening runs migrations. If another process holds it, exit with "Another codeboost runner is using this database." The OS lock cannot name the holder, so the message does not claim to. Do not serve the review screen: it is not read-only, because `ReviewService.load()` records history when HEAD moves (`runner/review.ts`) and `act()` writes review actions. A true read-only mode would need `Store`-level write refusal and is out of scope for F1.
2. After the lock, in this exact order:
   - **2a. Open the `Store`.** Migrations run here, under the lock. Read the runner owner token, or create it (see the table under "Shutdown").
   - **2b. Stop leftover preparation.** For every attempt row with a saved `preparation_pgid`: if a process group with that ID and start time is still alive, send `SIGTERM`, then `SIGKILL` after the grace period, and wait until it has exited. A crashed clone or storage allocator could otherwise still be creating or writing resources while D's recovery scans them, or while F exports and removes them.
   - **2c. Call D's startup recovery** with the token, and await it.
   - **2d. If D's recovery rejects, startup stops here**, before step 3 finalizes any row or step 6 hands anything to I3: close the `Store`, release the lock, and exit with D's diagnostic. The next start retries.
3. **Export phase, outside any transaction.** Every attempt kind gets task storage from D, including read-only ones, so recovery can find handles for any kind. **Export only for writable attempts** (`execute`, `fix`, `rebase-fix`) whose row is not `completed`. The partial-output rule applies only to stopped writable attempts. For each matching handle, run the bounded partial-output export. Write it to the diagnostics directory under the fixed name `<attemptId>.diff`, so a retry overwrites instead of duplicating. Each export has the same 60-second deadline as above; a timeout counts as an export failure. An export failure is kept in memory as that attempt's diagnostic ("Partial output could not be exported: …"), with no file. This phase makes no database writes. Before F2 there are no writable attempts, so this phase exports nothing, but read-only attempts can still leave handles to remove in step 4. Then finalize the unclean leftovers. These are `pending` or `running` rows left by a crash, or by a shutdown whose terminal write failed. **Finalization phase: one transaction** that only finalizes rows and stores each `diagnostic_ref` (or the export-failure diagnostic). It does no D or file work. If it fails, for example because of a storage error, startup stops there: it does not run step 4, does not open admission, closes the `Store`, releases the lock, and exits with the error. The next start runs recovery again from step 1, and its export phase rewrites the same fixed-name files. A diagnostics file whose attempt row never got a `diagnostic_ref` is removed by the diagnostics directory's normal retention. Finalize each one, storing its `diagnostic_ref` from the export in the same transaction, using the first-reason table in "Rules for the running state", rule 2:
   - first reason `cancelled` → `cancelled`; `stale` → `stale` with its cause;
   - first reason `shutdown`: if the row has a saved D `stop_reason` of `timeout`, `output-limit` or `capture-failure`, **D's reason wins** → `failed`, as at settlement. Otherwise → `cancelled` "Stopped by shutdown". **Limit:** D's `InvocationHandle` reports its stop reason only in the settled result, and F saves it only with the terminal write. If the process dies after D stopped for its own reason but before settlement, D's reason is lost with the process. Recovery then cannot see it and maps the row to a shutdown cancellation, which is requeued. The next attempt has its own deadline, so a lost timeout costs one bounded re-run, not an unbounded one. Keeping D's reason across a crash would need D to report it before settlement; that is not a prerequisite;
   - no first reason, and the captured context **is no longer current** → `stale` with its cause (the change happened, but the runner died before it recorded the reason). This is checked **first**, before both deadline fallbacks below, matching the settlement precedence;
   - no first reason, context current, and the task's `budget_deadline` has passed → the `time-limit` mapping (task `needs human`);
   - no first reason, context current, and the attempt's `deadline` has passed → `failed` "Timed out", not requeued;
   - no first reason and the context still current → `failed` "Interrupted: codeboost stopped while this was running".
   - first reason `time-limit` → `cancelled`, and in the same finalization transaction the task goes to `needs human` **only if it is not closed and `cancel_requested` is null**. A pending cancel task wins and closes the task as `cancelled` with its `task-closed` event, exactly as at settlement (rule 2).
4. Clear every unresolved marker (these exist only in memory, so a restart has already cleared them; step 3 reconciles their rows). Abort every recorded interrupted rebase (F3). For **every** task-storage handle D's recovery returned that matches an attempt row, whether or not step 3 exported it, call `removeTaskFilesystems`. Step 3's transaction already stored the `diagnostic_ref` of each exported one. The coordinator does not open (step 8) until every removal has succeeded. Then (preparation groups were already stopped in step 2b), for every directory under `<runner root>/<runner owner token>/attempts/` whose attempt is not marked as starting with a null group ID (step 7) (all attempts are terminal after step 3): check ownership (a real directory on the same device, not a symlink, named by a known attempt ID of this database), save a bounded partial-output diagnostic as for a hard stop, and remove it. Unknown entries are reported and left alone.
5. Insert any missing `task-closed` events. This applies **only** to tasks with a confirmed `merged` merge attempt (feedback-event rule 2). An attempt's terminal state never closes a task: a `cancelled` or `failed` attempt means only that the attempt ended. **Cancel attempt** (stop the current run; the task stays open) and **cancel task** (close the task and discard its workspace) are different user actions. Only cancel task closes a task. **If a runner attempt is `pending` or `running`, cancel task does not close the task at once.** It records the first reason `cancelled` on that attempt, and in the same transaction it sets `tasks.cancel_requested` to its `actionId`. The response says "Stopping, then cancelling". When that attempt settles, one transaction writes the attempt's terminal state, sets the task to `cancelled` and inserts `task-closed`. Only after that does F discard the workspace. With no active attempt, cancel task closes the task and writes `task-closed` in one local transaction. Either way it never needs reconciliation. Startup recovery finishes a pending `cancel_requested` in the same way after step 3. **Cancel task is refused while a merge attempt is `submitting` or `queued`**, including when its outcome is unclear. GitHub may still merge, and a closed task can never change to `merged`. The user can cancel the task after the merge coordinator records `merged`, `removed` or `failed`. If the result is `merged`, the task closes as merged instead. "Reject with feedback" never closes a task (see the status list).
6. **Requeue input.** Hand lane I3 every task whose status is not closed (`merged` or `cancelled`) and not human-gated, and whose latest attempt is either (a) `cancelled` with first reason `shutdown`, whether written by clean shutdown or by step 3, or (b) `failed` "Interrupted" by step 3. Attempts that end `cancelled` by the user or `stale` are not requeued; they wait for a user action. I3 rebuilds the workspace and requeues. F1 only makes the attempt rows terminal and produces this list. **Requeue claim:** the same transaction as step 3 sets `tasks.requeue_pending = true` for each listed task. While it is set, retry and every other admission for that task are refused, so recovery and a user retry cannot both start work on it. Exactly one path clears it, by an atomic compare-and-swap from `true` to `false` in the same transaction that admits the next attempt: I3's requeue, or, until lane I exists, the user's explicit "Resume" action (a `user_actions` row). The loser of that compare-and-swap is refused.
7. **Unowned preparation check.** If any attempt has `preparation_started_at` set and `preparation_pgid` null (see "Launch"), stop here: do not open the coordinator, name each attempt and directory, and wait for `--release-preparation`. Step 4 does not remove those directories.
8. Open the coordinator.

## HTTP and UI contract

**Status reads.** `GET /api/runner` returns only the task and attempt rows plus `stateVersion`, `retryable`, `unresolved` and `stopRequested`. `stopRequested` comes from the in-memory job: null, or `{ attemptId, reason, saved }`, where `saved` is false while the first-reason write has failed. The UI shows "Stopping (not saved yet)" only from this field. It does not change `stateVersion`, so user actions still compare against the durable state version. `unresolved` is computed by the server from the in-memory marker: null, or `{ attemptId, reason: "result-not-saved" | "start-not-saved" }`. The UI shows "Needs restart: result could not be saved" only from this field, because the durable row alone may still look active. It does not rebuild Git history or the full review.

**User actions.** Cancel, retry and "run again" requests send `attemptId`, `expectedStateVersion` and an `actionId` idempotency key (see "Feedback-event contract"). A replayed `actionId` returns the saved outcome. The server takes the plan identity from its trusted configuration, never from the request, and every `Store` call is scoped by that identity. A mismatch returns HTTP 409 with the current state. The UI then shows that state and keeps any draft.

**UI rules** (from AGENTS.md "Async review UI"):

| Rule | How |
|---|---|
| An old poll cannot overwrite newer state | Apply a response only if its `stateVersion` is at least the one already shown, and only if it answers the newest request. |
| Stale results stay visible | Show terminal `stale` attempts with their cause. Do not hide them. |
| Drafts survive | A response never clears the feedback composer. It clears it only if the current text and attachment still equal what was sent. |
| Polling backs off | Back off to a capped interval. Reset only on a lifecycle change or a user action. |
| Selection is announced | The selected task or attempt row uses `aria-current`. |

## Planning API for lane G

Every `POST` below follows the user-action protocol in "Feedback-event contract": it carries an `actionId`, and a replay returns the saved response.

F1 owns the production planning endpoints that G4 needs. They wrap E3's coordinator and the existing `Store` methods. They do not add a second writer.

| Endpoint | Store or coordinator call | Guard |
|---|---|---|
| `POST /api/plan/import` | `Store.importRevision` | expected revision |
| `POST /api/plan/suggestions` | E3 coordinator start (`beginSuggestions`) | expected revision and snapshot |
| `GET /api/plan/suggestions/:id` | `Store.getSuggestions` | reads only the request row |
| `POST /api/plan/suggestions/:id/cancel` | `pending`: `handle.cancel(reason)` on the `SuggestionHandle` that `SuggestionCoordinator.start()` returned. E3's coordinator has no cancel-by-ID method, so F keeps a map from request ID to handle, adds each handle when it starts the request, and removes it only after the handle's outcome settles. If the request is `pending` but F holds no handle (for example after a restart), F calls `Store.cancelSuggestions`. It is safe to do so because startup recovery has already stopped the crashed process's provider. A live planning provider runs only through D (G4 after D5), in a container labelled with this database's runner owner, and D's `recoverLeftovers` (startup step 2) stops it before admission opens. Until D5 there is no live planning provider at all ("Planning agent not available yet"). If a planning provider ever runs outside D, this endpoint must refuse such a request instead, until startup has reconciled it. `ready`: `Store.cancelSuggestions` (dismiss), because no invocation is running. | request is `pending` or `ready`, as `Store.cancelSuggestions` already allows |
| `POST /api/plan/suggestions/:id/apply` | `Store.applySuggestion` | request `ready` and bound to the current revision and snapshot |

Live planning invocation waits for D5. Until then, the server returns "Planning agent not available yet" instead of using a fake provider.

## Feedback-event contract (for lane J)

**What becomes an event.** Only feedback the user wrote or chose. Issue text, issue comments and agent output never become events.

`actionId` identifies the one user action (or confirmed external outcome) that caused the event. **For user actions it is an idempotency key the UI generates** (a UUID) when the user acts. The server validates it before opening any transaction: it must be a lowercase UUID v4 (the same regular expression as attempt IDs, 36 characters), or the request is refused with HTTP 400 and nothing is stored. The UI generates it and resends unchanged if it retries after a lost response. Every writing user action goes through one `user_actions` table, keyed by `(planKey, actionId)`. That covers notes, choice changes, finding acceptance, rejection, cancel, retry, "run again", **starting a merge**, and every planning endpoint that writes: plan import, suggestion start, suggestion cancel and suggestion apply. Each planning request carries an `actionId`; its `user_actions` row is inserted in the same transaction as the `Store` call it wraps, and the saved response includes the request ID or plan revision it produced. For a merge, the `user_actions` row is inserted in the same transaction as `beginMergeAttempt`, and it saves the merge attempt ID with the response "in progress". When the merge coordinator records the outcome, the same transaction updates that saved response. A replayed merge click therefore returns the same attempt's current outcome and never starts a second attempt. The row holds the action kind, a hash of the request body and the bounded response. **The first definite outcome is recorded, including a refusal.** If the action applies, its row is inserted in the same transaction. If a guard refuses it (for example HTTP 409 for a stale state version), the refusal and its response are recorded in their own transaction. Only outcomes that applied nothing for a passing reason are not recorded, so the UI may resend them: HTTP 503 during shutdown, and a storage error. A replay is handled before any other guard:

- the same `actionId` with the same request hash returns the saved response and applies nothing, even though the state version has since moved on;
- the same `actionId` with a different request hash (including a different action kind) is refused with HTTP 409 "Action ID already used" and applies nothing.

So neither an action nor its events can be duplicated, including a retry that would otherwise admit a second attempt. For a merge `task-closed` it is the merge attempt ID. A later change to the same source is a new user action with a new `actionId`.

**Which actions produce feedback.** This list is complete; the event kinds are in the table below.

| Action | Event |
|---|---|
| Reject with feedback | `reject` |
| Change note on a plan item | `change-request` |
| Accept a segment | `segment-accept` |
| Assign a segment | `segment-assign` |
| Accept an open problem | `finding-accept` |
| Guidance when sending a needs-human task back | `needs-human-guidance` |
| Cancel task | `task-closed` (at close, which may come after the attempt settles) |
| Confirmed merge (external outcome, not a user action) | `task-closed` |

Every other writing action is **idempotency-only**: it has a `user_actions` row and produces no event. That covers cancel attempt, retry, "run again", settings changes, questions, merge initiation (its event waits for the confirmed outcome), plan import, and suggestion start, cancel and apply.

| Event kind | Source action | `sourceRef` |
|---|---|---|
| `reject` | "Reject with feedback" | the rejection's note IDs |
| `change-request` | A change note on a plan item | note ID |
| `segment-accept` | Accepting an Ambiguous or Unplanned segment | choice key |
| `segment-assign` | Assigning a segment to a plan item | choice key |
| `finding-accept` | Marking an open problem "accepted" | finding ID |
| `needs-human-guidance` | Guidance added when sending a needs-human task back | note ID |
| `task-closed` | Confirmed merge, or the user's cancel task | plan key |

**Fields:** `id`, `planKey` (the task's full identity), `actionId`, `planRevision`, `snapshotId`, `item` (or null), `kind`, `text` (user text only, 4000 characters or fewer, or null), `sourceRef`, `supersedes` (or null), `createdAt`.

**Rules:**

1. **Local actions.** For each feedback-producing action, write its event in the same `Store` transaction as the action. There is never an event without its action, or a feedback-producing action without its event.
2. **External actions.** A GitHub merge cannot share a SQLite transaction. For a merge, one transaction records the **confirmed** outcome (`finishMergeAttempt` with state `merged`), sets `tasks.status` to `merged`, and inserts `task-closed`. Never write any of them when the merge is submitted, queued or ambiguous. Startup recovery also runs a reconciliation step: for every task with a confirmed `merged` merge attempt whose status or event is missing, one transaction sets the status and inserts the event. The uniqueness rule below makes this safe to repeat.
3. Events are append-only. If a choice changes later, write a new event with `supersedes` set to the earlier event. J uses the newest event for each `sourceRef`.
4. Replaying the same action or reconciliation does not duplicate an event: `(planKey, kind, actionId)` is unique. Each action produces at most one event, and it is applied only once, because `user_actions` holds one row per `(planKey, actionId)`. A superseding event for the same `sourceRef` has a new `actionId`, so it is never rejected. Note and choice IDs are only unique inside their plan identity, so the key must include the full plan key.
5. J reads events only through `Store.feedbackEvents(identity: PlanIdentity)`, which scopes every row by `identityKey(identity)`, and only after that task's `task-closed` event exists.

## Proposed storage additions

This is the smallest schema that holds the contract. The F1 implementation PR sets the final column names. The migration increases `user_version` from 5 to 6.

**Backfill in the same migration transaction.** Every existing `plans` row gets one `tasks` row:

| Column | Initial value |
|---|---|
| `status` | `merged` if its latest merge attempt is `merged`; otherwise `in review` (v5 data only comes from the review screen) |
| `state_version`, `context_generation` | `0` |
| `assignment_id` | `unassigned`, the value F uses until F2 assigns work |
| `referenced_code_hash` | the head SHA of the plan's current snapshot, or `none` if it has no snapshot |
| `current_attempt_id` | null (v5 has no attempt rows) |
| `requeue_pending` | false |
| `cancel_requested` | null |
| `rebase_in_progress` | null |
| `budget_deadline` | null. The budget has not started; it starts on the task's first move to `running`. Every deadline check treats null as "not started", never as expired. |
| `created_at`, `updated_at` | the migration time |

A merged v5 task also gets its `task-closed` event, keyed by the merge attempt ID. A test migrates a v5 fixture with an open and a merged plan, checks every column of both rows, and then checks that retry, recovery and the time-limit check treat the migrated open task as not expired and not requeue-pending.

| Table | Key columns |
|---|---|
| `tasks` | `plan_key` (primary key, references `plans(key)`), `status`, `requeue_pending` (boolean), `rebase_in_progress` (JSON or null; see "Partial output and interrupted rebases"), `budget_deadline` (absolute time the task budget ends; null until the budget starts: the admission transaction of the task's first attempt moves the task to `running` and sets it to that time plus the configured budget, so the budget covers preparation), `cancel_requested` (action ID or null), `state_version`, `context_generation`, `assignment_id`, `referenced_code_hash`, `current_attempt_id` (nullable; the composite foreign key `(plan_key, current_attempt_id)` references `attempts(plan_key, id)`, so a task can only point at its own attempt), `created_at`, `updated_at` |
| `attempts` | `id` (**primary key**; never reused), `deadline` (the attempt's absolute deadline, saved at admission), `plan_key` (references `tasks(plan_key)`; `(plan_key, id)` is also unique, for the composite key), `kind`, `phase`, `item`, `state`, `context` (JSON), `first_reason`, `stop_reason`, `exit_code`, `signal`, `result` (JSON, only for `completed`, 1 MiB or less), `diagnostic` (bounded), `diagnostic_ref` (partial-output file, or null), `preparation_pgid` and `preparation_started_at` (or null), `allocation_id` (task storage, or null), `created_at`, `started_at`, `settled_at` |
| `user_actions` | `plan_key`, `action_id` (together the primary key), `kind`, `request_hash`, `response` (JSON, bounded), `created_at` |
| `feedback_events` | the fields listed above, with `id` as primary key, with a unique index on `(plan_key, kind, action_id)` |

`tasks.status` holds the product states from the design (queued, running, needs human, needs amendment, needs approval, possibly already fixed, in review, approved but merge blocked, merged, cancelled). **Closed** means `merged` or `cancelled` (by the user's cancel task); a closed status never changes again. **Reject with feedback is not a closed status.** Following the design's step 8, it creates the next plan revision, marks the affected items to run again, and moves the task from `in review` to `queued`, in one transaction with its `reject` event. The design's learning section (L1) also lists "rejected" as a way a task closes. That conflicts with step 8, and this contract follows step 8. **Until the design is reconciled, this contract governs** when a task closes and when J may read its feedback, for lanes F and J. The design is owned by the plan's documentation owner (rule 3 of "Ownership and integration rules"), so this PR does not edit it. Reconciling line 533 is tracked as a follow-up for that owner. J therefore distills a task's feedback, including every reject round, when it closes by merge or cancel. **Human-gated** means `needs human`, `needs amendment`, `needs approval` or `possibly already fixed`. F1 defines the list and its invariants. F2 adds the per-item transitions. I1 adds queue admission and scheduling.

**Where the current context lives.** The `Current` check reads two rows in one transaction: `plans` (plan revision, snapshot ID) and `tasks` (assignment ID, referenced-code hash, context generation). The plan ID comes from the plan key. Every `Store` method that changes any of these fields increases `tasks.context_generation` **in the same transaction**. That covers `importRevision`, `applySuggestion`, `recordHistory`, `recordRebase`, and any new method that reassigns work or changes the referenced code. A regression test lists these methods and fails if one of them changes a context field without increasing the generation. An assignment change that keeps the same plan revision and snapshot therefore still makes old attempts non-current.

**Where results live.** `attempts.result` holds the validated structured result of a `completed` attempt: for example review findings, a question answer or check outcomes. It is limited to 1 MiB, the same as the plan-document limit after extraction. Larger or already-owned artifacts stay with their existing owners, and `result` references them by ID. Commits go in the ledger and snapshots (`recordHistory`), and continuation evidence goes in checkpoints. Raw stdout and stderr are never kept beyond the bounded `diagnostic`.

## Existing lifecycles and how they map

| Lifecycle | Current states | Maps to | Gap and owner |
|---|---|---|---|
| Questions (`runner/questions.ts`, `QuestionAnswer`) | `pending`, `complete`, `failed`; 125 s persisted lease | `running`, `completed`, `failed` | No durable `cancelled` or `stale`; stale is only worked out when the screen renders. The lease allows a second process to start after 125 s. Fixed when F moves Ask onto D's contract after D5. |
| Suggestions (E3, `requests`) | `pending`, `ready`, `consumed`, `failed`, `cancelled`, `invalidated` | `running`, `completed`, `completed` (applied), `failed`, `cancelled`, `stale` | Durable `cancelled` before settlement (allowed for read-only phases; see the exception above). No change. |
| Merge attempts (C and K, `merge_attempts`) | `submitting`, `queued`, `merged`, `removed`, `failed` | `running`, `running` (external), `completed`, and `removed`/`failed` as terminal failures for display only | **Excluded from F's generic retry and state machine.** Merge attempts keep their own states and guards in `MergeCoordinator`, including `requiresFreshReview` after `removed`. F's retry rule never applies to them, and the mapping is only for the shared UI vocabulary. When the outcome is unclear, ownership is kept, as AGENTS.md requires. F6 integrates. |

## Required race regressions for the F1 implementation

Each case needs a test that fails before the fix and passes after it. Each test checks both the returned or visible result and the durable row. Use controllable promises, clocks and a fake `InvocationHandle` with real SQLite.

| AGENTS.md case | F1 test |
|---|---|
| Old poll returns after a user action | Poll starts → user cancels → old poll response has a lower `stateVersion` → UI keeps "Stopping" |
| Lease expires while the original still runs | Move the clock past any persisted time → retry is refused while `settled` is unresolved |
| Timeout, then the provider stays unsettled, then retry | D reports timeout but `settled` is held → retry refused → release → row `failed` with the timeout reason → retry allowed |
| Shutdown, then a new request | `closing` set → admission throws; HTTP returns 503 |
| Partially received request, then shutdown | Body half-sent → shutdown → request destroyed after the drain limit → no attempt row created |
| Abort, then subprocess close arrives later | `cancel` → slot still held → `settled` resolves → slot freed → row `cancelled` with the first reason |
| Submit, then the user edits, then the response returns | Feedback submitted → user types more → response arrives → draft kept |
| Code reassigned or snapshot changed, then retry or render | Snapshot advances during a run → result discarded → row `stale` with the cause → retry disabled; "run again" allowed |
| Terminal write fails after settlement (review finding) | `settled` resolves → the terminal write throws → slot and unresolved marker remain → retry and admission refused → restart recovery makes the row terminal |
| Request admitted, then shutdown, then the request tries to start work (review finding) | Question body half-sent → shutdown sets `closing` → body completes → `questions.start()` throws → no answer attempt is saved |
| Merge confirmed, then the event write is lost (review finding) | `merged` recorded without `task-closed` → restart → reconciliation inserts exactly one event → a second restart inserts none |
| Attempt's own transitions, then publish (review round 2) | Admit → `pending` → `running` (the state version rises each time) → with no context change, a valid result publishes `completed`; the context generation is unchanged |
| Two admissions race for one slot (review round 2) | Two admissions in the same tick for different tasks with one free slot → exactly one reserves and saves `pending`; a refused `Store` transaction releases its reservation |
| Second process starts (review round 2) | Runner A holds the lock → process B exits before opening the `Store`; no migration or history write occurs |
| Two plans emit the same source ID (review round 2) | Two plan identities with the same `taskId` in different repositories both record `task-closed` at revision 1 → both events are saved, and `feedbackEvents` for each identity returns only its own |
| Stop before launch, and launch error (review round 3) | (a) Stop while the clone is being prepared → preparation settles and is removed → row `cancelled` → slot freed → next task admitted. (b) D start throws → row `failed` with the launch error → slot freed. (c) The `pending → running` write fails → slot and marker remain until restart |
| First reason wins at settlement (review round 5) | (a) User cancels → provider then exits with an error → row `cancelled`, not `failed`. (b) User cancels → plan revision changes → row `cancelled`, not `stale` |
| Shutdown during preparation (review round 5) | Attempt `pending` while its clone is prepared → shutdown → preparation awaited and removed → row `cancelled` "Stopped by shutdown" → Store closes → restart lists the task for requeue and writes no `task-closed` |
| Choice changed twice at one revision (review round 5) | Assign segment to P1 → reassign to P2 at the same revision → two events saved, the second supersedes the first; replaying the second request adds none |
| Preparation hangs, then cancel (review round 6) | Clone preparation blocks → user cancels → the signal aborts and the clone subprocess is awaited → row `cancelled` → slot freed |
| Crash with a recorded first reason (review round 6) | User cancels (first reason saved) → process killed before settlement → restart → row `cancelled`, not `failed`, and not requeued |
| Clean stop, then restart (review round 6) | Shutdown completes → the lock connection is closed and the OS lock released; the lock file is still there → a new process takes the lock and starts |
| Preparation fails (review round 7) | Clone fails before the D start call → partial clone removed → row `failed` with the clone error → slot freed |
| Retry a closed or gated task (review round 7) | Task `cancelled` by cancel task (or `needs human` after the time limit) with a `cancelled` last attempt → retry refused; restart does not requeue it |
| Assignment changes alone (review round 7) | Work reassigned without a plan-revision or snapshot change → generation increases in the same transaction → the old attempt's result is refused and the row becomes `stale` |
| Two databases, one crashes (review round 8) | Runners for databases A and B are live → A crashes and restarts → recovery removes only resources labelled with A's token; B's container, network, egress proxy and volume keep running |
| Context changes during preparation (review round 9) | Admit a writable attempt → assignment changes while the clone is prepared → launch check fails → row `stale`; D start is never called |
| Stop during launch, then the start throws (review round 9) | User cancels while preparation finishes → D start throws → row `cancelled`, not `failed` |
| Reason write fails (review round 9) | The first-reason write throws → settlement → the terminal write stores `cancelled` with the reason from memory |
| Time limit, then crash (review round 9) | `time-limit` saved → process killed → restart → row `cancelled`, task `needs human`, retry refused |
| Admitted write after shutdown (review round 9) | For each of `act`, `setQuestionProvider` and the planning writers: body half-sent → shutdown → body completes → HTTP 503 and no `Store` change |
| Stale, then shutdown (review round 9) | Attempt marked `stale` → shutdown → row `stale`, not requeued |
| Copied database (review round 9) | Copy the database file → start the copy → new token; recovery for the copy leaves the original's resources alone |
| Review edit during the final merge check (review round 10) | Merge passes its GitHub checks → approval changed before the final re-read → merge refused |
| Writing GET after shutdown (review round 10) | `/api/review` with a moved HEAD, and `/api/merge` with a queue result, both admitted → shutdown → neither writes to the `Store` |
| Legacy resource present (review round 10) | An agent container without a runner label exists → startup refuses admission and lists it |
| Lost response, then replay (review round 10) | Add a note → the transaction commits → the response is lost → resend with the same `actionId` → one note, one event, same response |
| v5 upgrade (review round 10) | Migrate a v5 database with an open and a merged plan → two task rows with the backfill values; the merged one has one `task-closed` |
| Path alias (review round 10) | Start through a symlinked parent directory while a runner holds the lock through the real path → the second start exits |
| Unresolved marker is visible (review round 10) | Terminal write fails → `GET /api/runner` returns `unresolved` → the UI shows the restart message |
| Lost retry response, then replay (review round 11) | Retry commits a new attempt → the response is lost → resend with the same `actionId` → the saved response comes back, and there is no second attempt and no 409 |
| Action ID reused for another action (review round 11) | Send a note with `actionId` X → send a reject with X → HTTP 409, nothing applied |
| Task budget runs out during preparation (review round 12) | Budget ends while the clone is prepared → `time-limit` recorded → preparation aborted → row `cancelled`, task `needs human`, retry refused |
| Deadline already passed at launch (review round 12) | Timer delayed → launch check sees an expired deadline → row `failed` "Timed out while preparing"; D is not called |
| Time limit versus cancel task (review round 12) | `time-limit` recorded → user cancels the task → provider settles → row `cancelled`, task stays `cancelled`, one `task-closed` |
| Refused action, then replay (review round 12) | Retry refused with 409 → the response is lost → the state changes → replay with the same `actionId` → the same 409 comes back and nothing is applied |
| Reject reopens the task (review round 12) | Reject with feedback → next revision, affected items marked, task `queued`, one `reject` event, no `task-closed` |
| Admit work on a closed task (review round 13) | Task `cancelled` → a fresh (not retry) admission → refused, no attempt row |
| Question settling after the gate closes (review round 13) | Question running → shutdown → the abort path's `finishAnswer` writes through the capability → row `failed` with the shutdown reason; `questions.close()` resolves |
| Hard-link alias (review round 13) | Hard-link the database to a second name → start through either name → refused |
| First start with no database (review round 13) | Start with a missing database path → lock created → database created → identity written into the lock → a concurrent second start exits at step 1 |
| Preparation child ignores SIGTERM (review round 14) | Clone subprocess ignores `SIGTERM` → cancel → `SIGKILL` after the grace period → `close` awaited → row `cancelled` → slot freed; shutdown completes |
| Cancel task during a merge (review round 14) | Merge attempt `queued` → cancel task → refused; after the merge is recorded as `merged`, the task is `merged` with one `task-closed` |
| Retry after queue removal (review round 14) | Merge attempt `removed` with `requiresFreshReview` → F's retry endpoint does not offer or accept a merge retry |
| Cancel task while an attempt runs (review round 15) | Attempt running → cancel task → the task stays open with `cancel_requested`, "Stopping, then cancelling" → the provider returns a valid result → not published → one transaction: row `cancelled`, task `cancelled`, one `task-closed` → then `removeTaskFilesystems` → then the slot is freed |
| Review load hits the gate (review round 15) | `/api/review` admitted with a moved HEAD → shutdown → `recordHistory` throws `ShuttingDownError` → HTTP 503, not 409 |
| Crash during preparation (review round 15) | Clone half-written in the attempt directory → process killed → restart → diagnostic saved, directory removed, an unknown sibling directory left and reported |
| Cancel task recorded after the final await (review round 16) | Result validated → cancel task commits `cancel_requested` → publication transaction refuses `completed` → row `cancelled`, task `cancelled` |
| Crash with a live clone child (review round 16) | Clone child running → runner killed → restart → recovery kills and awaits the saved process group before capturing and removing the directory |
| Lost merge response (review round 16) | Merge click → attempt started → response lost → replay with the same `actionId` → the same attempt's status returns; `beginMergeAttempt` is not called again |
| Symlink swap at first start (review round 16) | Parent directory writable by others → startup exits. With a safe parent: a symlink placed at the path before creation → `O_NOFOLLOW` create fails → exit |
| Unsaved stop is visible (review round 16) | First-reason write throws → `GET /api/runner` returns `stopRequested.saved = false` → UI shows "Stopping (not saved yet)" |
| Preparation started but no group ID saved (review round 17) | Crash after "preparation starting" and before the group ID → restart → admission stays closed and the attempt is named; `--release-preparation` removes the directory only after it stays unchanged |
| Time limit versus pending cancel task (review round 17) | `cancel_requested` set → the `time-limit` settlement arrives → task `cancelled` with one `task-closed`, never `needs human` |
| Recovery transaction fails (review round 17) | Storage error in step 3 → no directory removed, no admission, Store closed, lock released, non-zero exit |
| Planning replay (review round 17) | Suggestion apply commits → response lost → replay with the same `actionId` → the same new revision returns, and no second apply |
| Unsafe stored attempt ID (review round 18) | An attempt row with ID `../x` → recovery refuses it, reports it and touches no path |
| Stop reason recorded on a running row (review round 18) | Cancel → `running` row gets its first reason, state version +1, state still `running`; a second cancel changes nothing |
| Gate error inside merge status (review round 18) | `/api/review` → `displayStatus` → direct-merge reconciliation throws `ShuttingDownError` → HTTP 503, not 200 with a blocker; the same for `/api/merge` polling |
| D recovery fails (review round 18) | `recoverLeftovers` rejects → no row finalized, nothing handed to I3, lock released, non-zero exit |
| Context changed, then crash with no reason (review round 18) | Plan revision advances → runner killed before recording `stale` → restart → row `stale`, not requeued |
| Stop recorded, then the handle arrives (review round 19) | First reason saved on a `pending` row → D returns a handle → `pending → running` refused → handle cancelled and settled → row `cancelled` |
| Provider error after a context change (review round 19) | Plan revision advances → provider exits with an error → row `stale`, not `failed` |
| D timeout, then a context change, then settlement (review round 19) | D stops the attempt with `timeout` → the snapshot changes while cleanup runs → `settled` → row `stale` |
| D timeout, then shutdown (review round 19) | D stops with `timeout` and cleanup keeps `settled` pending → shutdown records `shutdown` → settlement → row `failed` with the timeout; not requeued |
| Corrupt runner token (review round 19) | `app_settings` token is `../x` → startup exits before any label or path use |
| Crash after the budget ran out (review round 19) | `budget_deadline` passes → runner killed before saving `time-limit` → restart → row `cancelled`, task `needs human` |
| Hard link before migrations (review round 19) | Hard-linked database name → step 1 refuses before SQLite opens it; no migration runs |
| Recovered volume bound to its attempt (review round 20) | Crash with task storage for attempt A → restart → the handle's attempt and allocation IDs match A's row → export saved as A's `diagnostic_ref` → volumes removed; a volume whose labels match no row is reported and kept |
| Unsafe parent before the lock (review round 20) | Parent writable by others and a lock file pre-created by another user → startup exits at step 0 without opening, removing or trusting that lock |
| Expired and non-current after a crash (review round 20) | Budget passed and plan revision advanced, no reason recorded → restart → row `stale`, not `time-limit` |
| Task storage outlives settlement (review round 21) | Writable attempt cancelled → `settled` → the volumes still exist → export runs → terminal write with `diagnostic_ref` → `removeTaskFilesystems` → slot freed. The order is asserted, and a completed writable attempt also ends with its storage removed |
| Storage removal fails (review round 22) | Terminal write succeeds → `removeTaskFilesystems` throws → slot held, unresolved marker shown → restart removes the storage before admission |
| Storage allocation is abortable (review round 23) | Cancel while `prepareTaskFilesystems` is waiting on Docker → the async variant aborts, its process group exits, and the event loop keeps serving `/api/runner` meanwhile → row `cancelled` |
| Shutdown frees slots only after storage removal (review round 23) | Writable attempt → shutdown → export → terminal write → removal fails → slot stays held → Store closes → restart removes the storage |
| Cancel a pending suggestion (review round 23) | Suggestion running → cancel endpoint → the saved handle's `cancel` is called → provider settles → request `cancelled`, coordinator slot free |
| Invalid action ID (review round 23) | A 10 KB `actionId`, and one that is not a UUID → HTTP 400; no `user_actions` row |
| Two starters after a crash (review round 23) | Runner killed (the OS releases its lock) → two processes start at once → exactly one gets the exclusive lock and the other exits; the lock file is never deleted |
| Retry versus recovery requeue (review round 24) | Restart lists the task and sets `requeue_pending` → user retry → refused → "Resume" and I3 requeue race → exactly one admits an attempt |
| Crash during a rebase (review round 25) | F3 sets `rebase_in_progress` → runner killed → restart → step 4 aborts that rebase and clears the field by compare-and-swap on its `attemptId` → only then is the task listed for I3 |
| Release an unknown preparation (review round 26) | A process still has a file open in the attempt directory → `--release-preparation` refuses and admission stays closed; after the process exits → released |
| Shutdown during launch setup (review round 26) | D start returns its handle → Docker setup still running → shutdown → `/api/runner` keeps answering, `cancel` reaches setup → setup cleanup → `settled` |
| Completed writable attempt keeps its work (review round 26) | `execute` exits 0 → F2 extracts the commit from task storage → `completed` → only then `removeTaskFilesystems` |
| Suggestion cancel after a restart (review round 26) | Provider container from the crashed process → startup step 2 removes it → pending request → cancel endpoint → `cancelled` |
| Legacy resources are never removed automatically (review rounds 27–28) | Unlabelled resources exist → startup refuses admission and lists them with removal commands; no codeboost code path deletes them; after manual removal, the next start opens admission |
| Ledger write in the publication transaction (review round 27) | Completed `execute` → the step-3 guard passes → `completed` and `recordHistory` in one transaction → generation +1. A stale variant → refused, no ledger entry, the commit is discarded with the storage |
| D timeout, then shutdown, then crash (review round 28) | (a) Row with a saved `stop_reason` of `timeout` and first reason `shutdown` → restart → `failed`, not requeued. (b) D timed out, then shutdown, then a crash before settlement (no `stop_reason` saved) → restart → `cancelled` "Stopped by shutdown" and requeued once; the requeued attempt has a fresh finite deadline |
| Recovery keeps the keeper (review round 29) | Crash with task storage → `recoverLeftovers` → the agent container and network are gone, but the volumes and their keeper container remain → export succeeds → `removeTaskFilesystems` removes both |
| Crash during async allocation (review round 30) | `allocation_id` saved → allocation starts → process killed → restart → the handle's attempt and allocation IDs match the row → exported and removed; never classed as unowned |
| Recovery finalization fails after export (review round 30) | Export writes `<attemptId>.diff` → the finalization transaction fails → exit → next start re-exports to the same name and finalizes once |
| Preparation still writing at restart (review round 32) | Crashed storage allocator's group still alive → restart → step 2b kills and awaits it → only then D recovery and export run |
| Renamed database (review rounds 32–33) | Runner A holds the lock → the database file is renamed, and separately moved to another directory on the same filesystem → runner B starts through the new path → same device and inode, same lock file → B exits |
| Export hangs (review round 32) | Docker export never returns → the 60-second deadline aborts it → diagnostic "Partial output could not be exported" → terminal write and removal continue; shutdown finishes |
| Time limit versus closed task in recovery (review round 32) | `time-limit` saved, then cancel task recorded, then crash → restart → task `cancelled` with one `task-closed`, never `needs human` |
| In-memory cancel, then a valid result (review round 33) | The first-reason write fails after cancel → the provider returns a valid result → publication is skipped → row `cancelled` with the in-memory reason |
| Retention with referenced files (review round 33) | The cap is exceeded by referenced files only → the oldest row's `diagnostic_ref` is cleared and noted first → then the file is deleted; no row points at a missing file |
| Recovered read-only storage (review round 34) | Crash with a running `review` attempt's task storage → restart → no export runs → storage removed → no diagnostics file; a crashed `execute` attempt's storage is exported, then removed |
| Old attempt settles after a retry (D/F contract) | Attempt A cancelled and settled → retry B admitted → a late publish from A is refused → B's row and the visible status are unchanged |

## Decisions (approved 2026-09-25)

The user approved the proposal for each of these four questions.

| # | Question | Decision | What F1 must do |
|---|---|---|---|
| 1 | How is one runner per database enforced across processes? | An exclusive lock file next to the database. **Updated in review round 23:** the lock is an operating-system lock held on that file, not a process-ID check. The approved proposal used a process ID and start time, but taking over a stale lock of that kind is not race-safe: two starters could both judge it stale, and one could delete the other's new lock. | Derive the lock path from the **canonical** database path: resolve the parent directory with `realpath`, and refuse a database path that is itself a symlink. Refuse a database file whose hard-link count is more than 1, both before and after opening, because two hard-linked names would give two lock paths for one file. Startup order, which also covers a database that does not exist yet:

0. **Before the lock file is opened:** resolve the parent directory with `realpath`, and check that it is owned by the current user and not writable by group or others. Otherwise exit. Only then is the lock path a safe boundary.
1. **Identify the database file before locking.** If it exists, open it with `O_NOFOLLOW`, `fstat` the descriptor, and refuse anything that is not a regular file or has a link count above 1. If it does not exist, create it with `O_CREAT | O_EXCL | O_NOFOLLOW` (an empty file is a valid new SQLite database). If that creation fails with `EEXIST` because another starter won the race, open the existing file as above. Keep the descriptor. **Updated in review round 32:** the lock is keyed by this file's identity, not its name, because a name-based lock lets a renamed database get a second lock while the first runner still holds the old one.
2. Open the lock file `~/.codeboost/locks/<device>-<inode>.runner-lock`, creating the directory with mode 0700 if needed and applying the same owner and mode check as step 0. The location does not depend on the database's directory, so a database moved to another directory on the same filesystem, which keeps its inode, still meets the same lock. Moving it to another filesystem copies it and gives it a new inode, so it becomes a different database. Open the lock file as a small, dedicated SQLite database. Set `PRAGMA locking_mode = EXCLUSIVE`, and start a write transaction to take SQLite's exclusive POSIX lock on it. If that fails with `SQLITE_BUSY`, another runner holds it: exit. The operating system releases this lock when the process exits or crashes. **There is no stale lock and no takeover**: lock files are never deleted, and a new starter only ever tries to take the OS lock. A leftover lock file for a deleted database is harmless, because no process holds its lock. The lock database stores no owner details: while one process holds the exclusive lock, another cannot read it, so an owner record could never be shown.
3. Open the `Store` under the lock. Migrations run here. `node:sqlite` can open a database only by path, not by descriptor. **What this defends against, and what it does not.** Because only this user can change the directory, another user cannot swap the path. A swap by the user's **own** processes between step 1 and SQLite's open is not prevented; step 4 detects it only afterwards, and migrations may already have run on the other file. Startup then exits before admission. This is accepted: the same user can already write the database file directly, so the lock guards against accidental double starts, not against the user's own processes.
4. `lstat` the database path and compare it with step 1's descriptor: same device and inode, a regular file, and a link count of 1. Exit on a mismatch. Keep the lock connection, and so the OS lock, open until shutdown step 8.

Renames (including moves between directories on the same filesystem), symlink aliases and relative paths therefore meet the same lock, because they reach the same device and inode. Hard-link aliases are refused. A copy is a different file with a different inode, so it is a different database with its own lock and its own runner owner token. Take the lock at startup and release it at the end of shutdown, by closing the lock connection. Lock files must be on a local filesystem, because POSIX locks are unreliable on network filesystems, so startup refuses a network mount. Do not use a lease row in the main database, because lease expiry could release a live runner. |
| 2 | Does E3 keep writing `cancelled` before the provider settles? | Yes. This exception applies only to read-only phases. | Leave E3 unchanged. New F records use "terminal only after settlement" for every phase. Revisit this when G4 wires the planning endpoints. |
| 3 | Is process shutdown a hard stop? | Yes. | Stopping the process cancels the running task with the reason "Stopped by shutdown". It does not wait for the task to finish. Restart recovery requeues the task. |
| 4 | Does F set its own time limit on settlement at shutdown? | No. F waits for D's forced-kill escalation. | Do not abandon a job after a timer. The D5 real-Docker suite must prove that settlement always ends, including for a child process that ignores SIGTERM. D4 does not yet prove it: its cleanup retries have no limit (see the prerequisite under "Shutdown"). If D5 cannot prove it, reopen this decision before F1 merges. |

## Out of scope for F1

- Per-item execution, review rounds, PR opening (F2); rebase and ledger mapping (F3–F4); head-bound checks (F5); merge handoff (F6).
- Queue admission, run windows, workspace rebuild (lane I).
- Lesson distillation and the Lessons inbox (lane J). F1 only records the events.
- Moving Ask onto D's contract. This is F's job, but it happens after D5 and is not part of F1.

## Testing this document with a reader

Before approval, ask one reviewer from lane G or I, who did not write this document, to answer these from the document alone:

1. A user clicks Cancel on a running `fix` attempt. What does the UI show, and when does the retry button turn on?
2. The plan revision changes while an `execute` attempt runs. Which terminal state does the attempt get, and can it be retried?
3. What happens, in order, when the user presses Ctrl+C with one running attempt and one open poll?
4. Which user actions create feedback events, and when may lane J read them?

If any answer differs from the intended one, fix the section that caused it before approval.

# F1 runner lifecycle and state-holder contract

**Status:** contract proposed; the four open decisions are approved (2026-09-25). Nothing in this document is implemented yet.
**Lane and step:** lane F (runner and pre-merge automation), step F1. Related issue: #22.
**Baseline:** `main` at `5881a43` (D1–D4 merged; D5 not started).

## About this document

**Who it is for.** People who build or review lanes F, G, I, J and K, and the agent that implements F1.

**What it is for.** The plan requires F1 to publish and review its lifecycle contract before any F1 code is written. This document is that contract. It says:

- which states a runner job can be in, and which changes between states are legal;
- which part of the program owns each piece of state, and when that owner may let go of it;
- when a retry is allowed;
- the order of steps when the program shuts down;
- the feedback events that the learning lane (J) will read.

**When implementation starts.** The plan starts F implementation after D5 merges. Review this contract now so that F1 code can start as soon as D5 lands. The attempt lifecycle itself uses only the D interface already on `main` (`agents/contract.ts`), which D4 (#47) did not change. Startup recovery and shutdown need three D changes that do **not** exist yet: bounded settlement, a `runnerOwner` field on `InvocationInput`, and a scoped `recoverLeftovers` API. They are listed as prerequisites under "Shutdown". The F1 implementation may start against fakes, but it must not merge until D delivers them.

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
| Attempt | One agent invocation or one runner command for a task. Has a unique `attemptId`. |
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
| Agent containers and their processes | The agent container, capture processes, networks, task storage and their cleanup | D (the adapter behind `InvocationHandle`) | When `settled` resolves. F never signals or kills these directly. |
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
| `pending` | `running` | D returns a handle | Attempt ID is the task's current attempt; state is `pending`. The launch check (see "Launch") ran immediately before the D start call. |
| `pending` | `cancelled` | Stop before or during launch | Same attempt ID; state is `pending`; first reason is `cancelled`, `shutdown` or `time-limit` |
| `pending` | `stale` | Context changed before launch | Same attempt ID; state is `pending`; first reason is `stale`, or no first reason and the context is no longer current |
| `pending` | `failed` | Preparation or launch error | Same attempt ID; state is `pending`; **no first reason recorded** |
| `running` | `completed` | Validated result | Attempt ID is current; state is `running`; no first reason recorded; captured context still current; **task status is open (not closed) and no cancel-task request is pending** |
| `running` | `failed` | Settled with an error or invalid output | Attempt ID is current; state is `running`; **no first reason recorded** |
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
- **Preparation files have a durable owner.** Before preparation creates anything, F uses the fixed attempt directory `<runner root>/<runner owner token>/attempts/<attemptId>/`, and passes it as the parent to the clone helper. The helper names its clone with `mkdtemp`, so the fixed parent is what makes the clone findable after a crash. **Today's `createTaskClone` (`git/clone.ts`) runs git with synchronous `execFileSync`.** It cannot be aborted and would block the event loop, so F1 cannot use it for preparation as it is. D, which owns `git/clone.ts`, must add an asynchronous variant that takes an `AbortSignal`, spawns git in its own process group, and exposes that group's ID (third prerequisite under "Shutdown").
- **Preparation processes have a durable owner.** Right after spawning a preparation child, in the same synchronous turn, F saves the process group ID and the child's start time on the attempt row (`preparation_pgid`, `preparation_started_at`). A process group outlives the runner if the runner crashes, so startup recovery uses these fields to stop it (step 4). A crash in the synchronous gap between spawn and that write can still leave an unknown child. Recovery then sees the attempt directory change while it captures it, and it leaves that directory alone and reports it. The path comes only from IDs that are already saved, so a crash cannot leave an unknown path. The job removes the directory when the attempt ends. Startup recovery handles the rest (step 4).
- An `AbortSignal` does not stop a child process by itself. Every preparation subprocess (for example `git clone`) is started in its own process group, owned by the job. On abort, F sends `SIGTERM` to the group, waits a fixed grace period (5 seconds), then sends `SIGKILL`, and awaits the `close` event. Preparation settles only after that. A child that ignores `SIGTERM` is therefore still bounded by the kill. Preparation never leaves work running after it settles.
- Preparation counts against two limits, so it cannot hold a slot forever. If the **task time budget** runs out first, the job records the first reason `time-limit`, then aborts the signal; the pending row ends `cancelled` and the task goes to `needs human`, as for a running attempt. If the **attempt deadline** passes first, the job aborts the signal with `timeout` and records no first reason; the row ends `failed` "Timed out while preparing".
- Shutdown aborts every preparation signal in step 4.

| Case | What F does | When the slot is freed |
|---|---|---|
| Preparation fails before the D start call (for example the clone fails) | Preparation has already stopped its own subprocesses before rejecting (rule above). Remove anything it created. Write the terminal state from the first reason if one is recorded; otherwise write `failed` with the bounded preparation error. | After that terminal write succeeds |
| Stop or context change before the D start call | Record the first reason. Await the preparation promise and remove anything it created. Then write the terminal state (`cancelled` or `stale`). | After that terminal write succeeds |
| The D start call throws | Write the terminal state from the first reason if one is recorded (a stop can be recorded while preparation is finishing); otherwise write `failed` with the launch error. D4's adapters throw only after their setup cleanup has succeeded. If cleanup is still unfinished, they return a handle instead, which settles when cleanup ends. So nothing is left running. | After that terminal write succeeds |
| The D start call returns a handle | Write `pending → running`. From here the running-state rules apply, even if the handle comes from failed setup that is still cleaning up. | After `settled` resolves and the terminal write succeeds |
| The handle arrives but the `pending → running` write fails | Keep the job with its handle, call `handle.cancel('capture-failure')`, and await `settled`. Then keep an unresolved marker for the task, because the row is still `pending`. | Only at startup recovery |

**Launch check.** Immediately before the D start call, in one synchronous turn with no await between them, F reads the task and plan rows (the `Store` is synchronous) and confirms that the attempt is still `pending`, has no first reason, has a current captured context, and has time left. For the time check it reads the clock in the same turn: if the task budget is spent, it records `time-limit` and ends the row `cancelled` (the task goes to `needs human`); if the attempt deadline has passed, it ends the row `failed` "Timed out while preparing". In both cases D is not called. Only when every check passes does it call D's start, which is also synchronous. If the context is no longer current, F takes `pending → stale` without launching. A writable invocation therefore never starts against an old plan, snapshot, assignment or referenced code. The later publish check cannot undo filesystem changes.

In every case, a failed terminal write leaves an unresolved marker (see "Slots and concurrency", rule 5).

**Rule for D.** D's start call must keep this shape: it either throws with nothing left running, or it returns a handle that settles only after everything it started has stopped. An adapter that needs an asynchronous start must still follow this rule. Changing it is a change to D's contract.

### Rules for the running state

1. **Stop requests do not end the attempt.** A cancel, hard stop, shutdown, time limit or detected staleness sets the first reason on the in-memory job, writes it onto the row, and calls `handle.cancel(...)`. The row stays `running`, and the UI shows "Stopping".

   **The in-memory job is the source of the first reason until the terminal write.** The terminal write stores the job's first reason and the terminal state together in one transaction. So if the earlier reason write fails, nothing is lost while the process lives, and the UI shows "Stopping (not saved yet)". If that terminal write also fails, the unresolved marker keeps the reason in memory. The one case that loses it is a crash after a failed reason write and before a successful terminal write. Startup recovery then records `failed` "Interrupted" and adds "a stop may have been requested" to the diagnostic. It cannot recover a reason that was never saved.
2. **The terminal state comes from the first reason.** When `settled` resolves, the terminal state is chosen in this order:

   | First reason recorded by F | D result | Terminal state |
   |---|---|---|
   | `cancelled` (user or hard stop) | any | `cancelled` |
   | `shutdown` | any | `cancelled`, with the reason "Stopped by shutdown" |
   | `stale` (context change) | any | `stale`, with the cause (for example "plan revision 4 replaced 3") |
   | `time-limit` | any | `cancelled`, reason "Task time limit reached"; the same transaction sets the task's status to `needs human`, **but only if the task is not closed**. If the user cancelled the task while the provider was settling, the task stays `cancelled`: a closed status never changes, and its `task-closed` event stands. |
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
| The last attempt for the task is `failed` or `cancelled` on disk, **and** the task's status is `running` or `queued` | `Store` transaction |
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
3. In one `Store` transaction: confirm that the attempt ID is the task's current attempt, the state is `running`, there is no first reason, the captured context is still current, the task is not closed, and `tasks.cancel_requested` is null (the same guard as the `running → completed` row). Do not compare the task's state version here; the attempt's own transitions have increased it. Then write `completed` and the result, and increase the state version.
4. If step 3 refuses, reread durable state and settle the row by the rules above. Keep the original diagnostic.

**Irreversible actions.** Before each commit, push, PR open or merge, re-read the task's state version, the plan's `review_version` (which `saveReview` and `addReviewNote` advance) and the coordinator's `closing` flag **after the final await**. Stop if any of them changed. For a merge this means an approval or choice edit made during the final GitHub check blocks the merge. A check made before an await does not count. (This follows the AGENTS.md rules on guarded external actions.)

## Shutdown

`web/server.ts` `close()` and the runner coordinator follow this order. Part of step 1 and all of steps 2 and 3 already exist. F1 adds the coordinator barrier in step 1, steps 4 and 5, and step 8.

| Step | Action | Existing? |
|---|---|---|
| 1 | Set `stopping` on the server and `closing` on every coordinator (runner, questions, suggestions, merge), in the same synchronous turn, before any active-work list is copied. New API requests get HTTP 503. Every coordinator's start method checks `closing` synchronously and throws, so a request admitted before shutdown cannot start new work after it. | server flag: yes. Coordinator barrier: **new**. Today `close()` sets only `stopping`, and `questions.close()` runs later, so a request that was still reading its body can call `questions.start()` after shutdown began. The server also rechecks `stopping` after reading a body only for `merge`, so `service.act`, `setQuestionProvider` and future planning writers can still change the `Store`. F1 adds a `stopping` check after the body is read and before **every** mutating dispatch, returning HTTP 503, and adds regressions for each writer. Two GET handlers also write: `/api/review` (`ReviewService.load()` calls `recordHistory` when HEAD moved) and `/api/merge` (queue polling records merge observations and outcomes). `/api/review` can also write after an await: `merges.displayStatus()` checks GitHub and can then record a direct merge (`finishMergeAttempt`, `runner/merge.ts`). Per-handler checks would miss paths like this, so F1 adds a **write gate on the `Store`**. Step 1 closes the gate in the same synchronous turn. After that, every `Store` write method throws "Shutting down" unless the caller passes the shutdown capability. The server hands that capability at construction to each coordinator's own settlement and `close()` code: the runner, questions (`finishAnswer` after abort), suggestions (`settleSuggestion` in E3's `close()`) and merge. Startup recovery holds it too. HTTP handlers and `ReviewService` never receive it. So after step 1, only work that is settling can write, and it can still record its terminal rows before step 7 closes the `Store`. The gate throws a distinct `ShuttingDownError`, which the server maps to HTTP 503 "The review server is shutting down.", never to the 409 used for review errors. So an admitted `/api/review` whose `load()` reaches `recordHistory` after step 1 returns 503 with no view, and the UI treats it like any other 503 during shutdown. There is no partial or read-only view. Merge reconciliation and queue polling hit the same gate and end the same way. The next startup checks GitHub again, so a skipped merge observation is recovered, not lost. Regressions cover `/api/review` history, `/api/review` direct-merge reconciliation during the GitHub await, and `/api/merge` polling. |
| 2 | Stop accepting connections, and wait for admitted requests up to the drain limit (at most 14.5 s, below the 15 s request timeout). | yes |
| 3 | After the drain limit, abort the signals of the remaining requests, destroy requests that are still reading a body, then await request-owned work (the merge coordinator). | yes |
| 4 | For every `pending` and `running` attempt that has an in-memory job, record the first reason `shutdown` **only if no first reason is set yet**. A job already marked `cancelled`, `stale` or `time-limit` keeps its reason. For `running`, call `cancel('shutdown')` and await `settled`. For `pending`, await its preparation promise (and the D start call if it is in progress), remove what preparation created, and cancel any handle that start returned, then await its `settled` (the "Launch" table). F does not abandon a job after a timer (decision 4). **This is not yet guaranteed to end:** D4's supervisor escalates to a forced kill, but it retries unfinished container, network or setup cleanup every second with no limit (`agents/adapters/supervisor.ts`). If Docker is unreachable, `settled` never resolves and shutdown waits with the `Store` open. See the prerequisite below. | new |
| 5 | Write each attempt's terminal state from its first reason (a `shutdown` reason gives `cancelled` "Stopped by shutdown"), and free its slot. A failed write leaves the row non-terminal for startup recovery to handle. | new |
| 6 | Await server closure; await the question and suggestion coordinators' `close()`. | yes (questions); suggestions: new wiring |
| 7 | Close the `Store`. | yes |
| 8 | Release the single-runner lock (decision 1). Release it on every exit path after it was taken, including a startup failure. | new |

**Partial output and interrupted rebases.** The design requires a hard stop to keep partial output for diagnosis, and to cancel an interrupted rebase before the workspace is rebuilt.

| Holder | Owner | Rule |
|---|---|---|
| Partial output of a stopped writable attempt | F, using a new D export | The task filesystems are Docker volumes behind a keeper container. F allocates them with `prepareTaskFilesystems` and removes them with `removeTaskFilesystems`; D's supervisor does not remove them at settlement. But F cannot read a volume from the host. So the order is: `settled` → a **D-provided bounded export** (a new D operation, for example `exportTaskDiff(filesystems, maxBytes)`, which runs `git diff` against the last codeboost commit in a read-only container and returns at most 1 MiB) → F saves it → `removeTaskFilesystems`. F saves the export to a runner-owned diagnostics directory, with a total byte cap and oldest-first deletion. The attempt row references it as `diagnostic_ref`. If the capture fails, the row records that it failed. The task filesystem is never reused. |
| Interrupted rebase | F3 | F3 records `rebase in progress` durably before starting a rebase and clears it after. Startup recovery aborts every recorded rebase through the runner before it hands the task to I3. |
| Workspace rebuild | I3 | I3 never rebuilds before both rows above are resolved for the task. |

**Process shutdown is a hard stop.** When the process stops, the running task does not finish. Its attempt ends `cancelled` with the reason "Stopped by shutdown". Restart recovery (lane I3) puts the task back in the queue. This is different from "Stop the queue" (lane I), which lets the running task finish.

**First prerequisite before F1 merges: settlement ends.** Settlement must be proven to end. D5, or a D follow-up, must either bound cleanup retries and settle with a terminal cleanup-failure result, or show in the real-Docker suite that every cleanup path ends, including when the Docker daemon is unreachable. Until one of these lands, decision 4 stays conditional, and the F1 implementation PR must not merge. F1 does not add its own timer to work around this.

**Second prerequisite before F1 merges: a D recovery API scoped to one database.** Decision 1 allows one runner per database, so several databases can have live runners on the same machine at once. Recovery must therefore never touch another database's resources. D's current labels (`io.codeboost.invocation`, `io.codeboost.task-storage`, `io.codeboost.allocation`, `io.codeboost.egress`) do not say which database owns a resource, so they are not enough.

| Part | Owner | Rule |
|---|---|---|
| Runner owner token | F | A random ID stored in the database (`app_settings`), together with the database file's device and inode numbers. It is read, or created, in startup recovery step 2, after the lock is taken and the `Store` is opened. If the stored device and inode don't match the open file (the database was copied), F creates a new token. So a copy never shares a token with its original. |
| Token in every request | D contract | `InvocationInput` gains a `runnerOwner` field. Every resource D creates carries the label `io.codeboost.runner=<token>`: containers, networks, egress proxies, task-storage volumes and allocations. |
| Scoped recovery | D | `recoverLeftovers(runnerOwner): Promise<RecoveryReport>` removes only resources whose `io.codeboost.runner` label equals the token. It resolves only when all of them are gone, and rejects with a bounded diagnostic if one cannot be removed. F then refuses to open admission. |
| Unowned resources | D and F | Resources with codeboost labels but no `io.codeboost.runner` label (from builds before this change) fail closed. The report lists them, F refuses to open admission, and the CLI prints the list with the instruction to stop every codeboost process and then run `--remove-unowned-agent-resources`. That flag removes them only when no other codeboost runner lock is live on the machine. It never adopts or reuses them. |
| When it runs | F | Only while holding this database's single-runner lock (startup recovery step 1 comes first). |

This belongs to D (D5 or a D follow-up), not F. It changes `agents/contract.ts`, so it goes through D's contract tests.

**Third prerequisite before F1 merges: an abortable clone helper.** D must add an asynchronous, abortable variant of `createTaskClone` that spawns git in its own process group and exposes the group ID (see "Launch").

**Prerequisite before F2's writable attempts: a bounded task-volume export.** D must add a bounded diff export over the task volumes (see "Partial output and interrupted rebases"). F1 does not need it, because F1 has no writable attempts yet.

**A second Ctrl+C** does not skip steps 4 to 8. The CLI prints "Still stopping agents…" and keeps waiting.

## Startup recovery

This runs before the coordinator opens.

1. Take the single-runner lock for this database (decision 1), **before opening the `Store`**, because opening runs migrations. If another live process holds it, exit with a message that names that process ID. Do not serve the review screen: it is not read-only, because `ReviewService.load()` records history when HEAD moves (`runner/review.ts`) and `act()` writes review actions. A true read-only mode would need `Store`-level write refusal and is out of scope for F1.
2. Open the `Store` (migrations run here, under the lock). Read the runner owner token, or create it (see the table under "Shutdown"). Then call D's startup recovery with that token, and await it. **D does not provide this yet.** `agents/contract.ts` exposes only per-invocation handles, and the supervisor's cleanup ownership lives in memory, so it is lost when the process crashes. See the second prerequisite under "Shutdown".
3. **Unclean leftovers.** These are `pending` or `running` rows left by a crash, or by a shutdown whose terminal write failed. Finalize each one using the first-reason table in "Rules for the running state", rule 2:
   - first reason `cancelled` → `cancelled`; `shutdown` → `cancelled` "Stopped by shutdown"; `stale` → `stale` with its cause;
   - no first reason → `failed` "Interrupted: codeboost stopped while this was running".
   - first reason `time-limit` → `cancelled` and the task set to `needs human`, in the same transaction.
4. Clear every unresolved marker (these exist only in memory, so a restart has already cleared them; step 3 reconciles their rows). Abort every recorded interrupted rebase (F3). Then, for every attempt row with a saved `preparation_pgid`: if a process group with that ID and start time is still alive, send `SIGTERM`, then `SIGKILL` after the grace period, and wait until it has exited. Only after that, for every directory under `<runner root>/<runner owner token>/attempts/` (all attempts are terminal after step 3): check ownership (a real directory on the same device, not a symlink, named by a known attempt ID of this database), save a bounded partial-output diagnostic as for a hard stop, and remove it. Unknown entries are reported and left alone.
5. Insert any missing `task-closed` events. This applies **only** to tasks with a confirmed `merged` merge attempt (feedback-event rule 2). An attempt's terminal state never closes a task: a `cancelled` or `failed` attempt means only that the attempt ended. **Cancel attempt** (stop the current run; the task stays open) and **cancel task** (close the task and discard its workspace) are different user actions. Only cancel task closes a task. **If a runner attempt is `pending` or `running`, cancel task does not close the task at once.** It records the first reason `cancelled` on that attempt, and in the same transaction it sets `tasks.cancel_requested` to its `actionId`. The response says "Stopping, then cancelling". When that attempt settles, one transaction writes the attempt's terminal state, sets the task to `cancelled` and inserts `task-closed`. Only after that does F discard the workspace. With no active attempt, cancel task closes the task and writes `task-closed` in one local transaction. Either way it never needs reconciliation. Startup recovery finishes a pending `cancel_requested` in the same way after step 3. **Cancel task is refused while a merge attempt is `submitting` or `queued`**, including when its outcome is unclear. GitHub may still merge, and a closed task can never change to `merged`. The user can cancel the task after the merge coordinator records `merged`, `removed` or `failed`. If the result is `merged`, the task closes as merged instead. "Reject with feedback" never closes a task (see the status list).
6. **Requeue input.** Hand lane I3 every task whose status is not closed (`merged` or `cancelled`) and not human-gated, and whose latest attempt is either (a) `cancelled` with first reason `shutdown`, whether written by clean shutdown or by step 3, or (b) `failed` "Interrupted" by step 3. Attempts that end `cancelled` by the user or `stale` are not requeued; they wait for a user action. I3 rebuilds the workspace and requeues. F1 only makes the attempt rows terminal and produces this list.
7. Open the coordinator.

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

F1 owns the production planning endpoints that G4 needs. They wrap E3's coordinator and the existing `Store` methods. They do not add a second writer.

| Endpoint | Store or coordinator call | Guard |
|---|---|---|
| `POST /api/plan/import` | `Store.importRevision` | expected revision |
| `POST /api/plan/suggestions` | E3 coordinator start (`beginSuggestions`) | expected revision and snapshot |
| `GET /api/plan/suggestions/:id` | `Store.getSuggestions` | reads only the request row |
| `POST /api/plan/suggestions/:id/cancel` | `pending`: E3 coordinator cancel, which stops the invocation. `ready`: `Store.cancelSuggestions` (dismiss), because no invocation is running. | request is `pending` or `ready`, as `Store.cancelSuggestions` already allows |
| `POST /api/plan/suggestions/:id/apply` | `Store.applySuggestion` | request `ready` and bound to the current revision and snapshot |

Live planning invocation waits for D5. Until then, the server returns "Planning agent not available yet" instead of using a fake provider.

## Feedback-event contract (for lane J)

**What becomes an event.** Only feedback the user wrote or chose. Issue text, issue comments and agent output never become events.

`actionId` identifies the one user action (or confirmed external outcome) that caused the event. **For user actions it is an idempotency key the UI generates** (a UUID) when the user acts, and resends unchanged if it retries after a lost response. Every writing user action goes through one `user_actions` table, keyed by `(planKey, actionId)`. That covers notes, choice changes, finding acceptance, rejection, cancel, retry, "run again", and **starting a merge**. For a merge, the `user_actions` row is inserted in the same transaction as `beginMergeAttempt`, and it saves the merge attempt ID with the response "in progress". When the merge coordinator records the outcome, the same transaction updates that saved response. A replayed merge click therefore returns the same attempt's current outcome and never starts a second attempt. The row holds the action kind, a hash of the request body and the bounded response. **The first definite outcome is recorded, including a refusal.** If the action applies, its row is inserted in the same transaction. If a guard refuses it (for example HTTP 409 for a stale state version), the refusal and its response are recorded in their own transaction. Only outcomes that applied nothing for a passing reason are not recorded, so the UI may resend them: HTTP 503 during shutdown, and a storage error. A replay is handled before any other guard:

- the same `actionId` with the same request hash returns the saved response and applies nothing, even though the state version has since moved on;
- the same `actionId` with a different request hash (including a different action kind) is refused with HTTP 409 "Action ID already used" and applies nothing.

So neither an action nor its events can be duplicated, including a retry that would otherwise admit a second attempt. For a merge `task-closed` it is the merge attempt ID. A later change to the same source is a new user action with a new `actionId`.

**Which actions produce feedback.** Some actions exist only for idempotency and produce no event: cancel attempt, retry, "run again", and settings changes. Each of the rest produces exactly one event of the kind in the table below. Cancel task produces only `task-closed`.

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

A merged v5 task also gets its `task-closed` event, keyed by the merge attempt ID. A test migrates a v5 fixture with an open and a merged plan and checks both rows.

| Table | Key columns |
|---|---|
| `tasks` | `plan_key` (primary key, references `plans(key)`), `status`, `cancel_requested` (action ID or null), `state_version`, `context_generation`, `assignment_id`, `referenced_code_hash`, `current_attempt_id` (nullable; the composite foreign key `(plan_key, current_attempt_id)` references `attempts(plan_key, id)`, so a task can only point at its own attempt), `created_at`, `updated_at` |
| `attempts` | `id` (**primary key**; never reused), `plan_key` (references `tasks(plan_key)`; `(plan_key, id)` is also unique, for the composite key), `kind`, `phase`, `item`, `state`, `context` (JSON), `first_reason`, `stop_reason`, `exit_code`, `signal`, `result` (JSON, only for `completed`, 1 MiB or less), `diagnostic` (bounded), `diagnostic_ref` (partial-output file, or null), `preparation_pgid` and `preparation_started_at` (or null), `created_at`, `started_at`, `settled_at` |
| `user_actions` | `plan_key`, `action_id` (together the primary key), `kind`, `request_hash`, `response` (JSON, bounded), `created_at` |
| `feedback_events` | the fields listed above, with `id` as primary key, with a unique index on `(plan_key, kind, action_id)` |

`tasks.status` holds the product states from the design (queued, running, needs human, needs amendment, needs approval, possibly already fixed, in review, approved but merge blocked, merged, cancelled). **Closed** means `merged` or `cancelled` (by the user's cancel task); a closed status never changes again. **Reject with feedback is not a closed status.** Following the design's step 8, it creates the next plan revision, marks the affected items to run again, and moves the task from `in review` to `queued`, in one transaction with its `reject` event. The design's learning section (L1) also lists "rejected" as a way a task closes. That conflicts with step 8, and this contract follows step 8. J therefore distills a task's feedback, including every reject round, when it closes by merge or cancel. **Human-gated** means `needs human`, `needs amendment`, `needs approval` or `possibly already fixed`. F1 defines the list and its invariants. F2 adds the per-item transitions. I1 adds queue admission and scheduling.

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
| Clean stop, then restart (review round 6) | Shutdown completes → lock file removed → a new process takes the lock and starts |
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
| Cancel task while an attempt runs (review round 15) | Attempt running → cancel task → the task stays open with `cancel_requested`, "Stopping, then cancelling" → the provider returns a valid result → not published → row `cancelled`, task `cancelled`, one `task-closed`, workspace discarded afterwards |
| Review load hits the gate (review round 15) | `/api/review` admitted with a moved HEAD → shutdown → `recordHistory` throws `ShuttingDownError` → HTTP 503, not 409 |
| Crash during preparation (review round 15) | Clone half-written in the attempt directory → process killed → restart → diagnostic saved, directory removed, an unknown sibling directory left and reported |
| Cancel task recorded after the final await (review round 16) | Result validated → cancel task commits `cancel_requested` → publication transaction refuses `completed` → row `cancelled`, task `cancelled` |
| Crash with a live clone child (review round 16) | Clone child running → runner killed → restart → recovery kills and awaits the saved process group before capturing and removing the directory |
| Lost merge response (review round 16) | Merge click → attempt started → response lost → replay with the same `actionId` → the same attempt's status returns; `beginMergeAttempt` is not called again |
| Symlink swap at first start (review round 16) | Parent directory writable by others → startup exits. With a safe parent: a symlink placed at the path before creation → `O_NOFOLLOW` create fails → exit |
| Unsaved stop is visible (review round 16) | First-reason write throws → `GET /api/runner` returns `stopRequested.saved = false` → UI shows "Stopping (not saved yet)" |
| Old attempt settles after a retry (D/F contract) | Attempt A cancelled and settled → retry B admitted → a late publish from A is refused → B's row and the visible status are unchanged |

## Decisions (approved 2026-09-25)

The user approved the proposal for each of these four questions.

| # | Question | Decision | What F1 must do |
|---|---|---|---|
| 1 | How is one runner per database enforced across processes? | An exclusive lock file next to the database, holding the process ID and the process start time. | Derive the lock path from the **canonical** database path: resolve the parent directory with `realpath`, and refuse a database path that is itself a symlink. Refuse a database file whose hard-link count is more than 1, both before and after opening, because two hard-linked names would give two lock paths for one file. Startup order, which also covers a database that does not exist yet:

1. Create the lock file exclusively (`O_EXCL`) at the canonical path, holding the process ID and start time. No database file is needed for this.
2. Open (and, for a new database, create) the `Store` under the lock. Migrations run here. **Path safety:** the canonical parent directory must be owned by the current user and not writable by group or others; otherwise startup exits. For a new database, F first creates the file itself with `O_CREAT | O_EXCL | O_NOFOLLOW` and keeps that descriptor. For an existing one, it opens it with `O_NOFOLLOW`. Only then does SQLite open the path. Step 4 compares the path's `lstat` with the descriptor's `fstat`. Because only this user can change the directory, a symlink cannot be swapped in between these checks by another user. A swap by the user's own processes is caught by that comparison.
3. Read the open file's device and inode numbers and link count. Refuse a link count above 1. Write the identity into the lock file **through the file descriptor opened in step 1**, and keep that descriptor open until shutdown step 8. The lock path is never replaced, so the file this process created stays the one at the path.
4. Stat the database path again and check that it still has that identity. Exit on a mismatch.

Symlink aliases therefore meet the same lock, hard-link aliases are refused, and a new database is created only while the lock is held. Take the lock at startup and release it at the end of shutdown. Accept a leftover lock file only if no live process has that ID and start time. Do not use a SQLite lease row, because lease expiry could release a live runner. |
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

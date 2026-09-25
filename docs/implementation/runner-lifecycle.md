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

**When implementation starts.** The plan starts F implementation after D5 merges. Review this contract now so that F1 code can start as soon as D5 lands. The contract uses only the D interface that is already on `main` (`agents/contract.ts`), D4 (#47) merged without changing that interface. D5 changes this contract only if it changes that interface.

## Summary

1. Every agent run or runner command is an **attempt**. An attempt has one ID, which is never reused. A retry is a new attempt.
2. An attempt moves through `pending → running → completed | failed | cancelled | stale`. The runner as a whole is `open` or `closing`.
3. For attempts that can write to the task folder, the durable record becomes terminal only after the container has stopped. "Cancel" first records the reason and shows "Stopping". It does not free anything.
4. A result is saved only if a compare-and-swap succeeds: the attempt ID, the task's state version and the captured context must all still be current. Late results are thrown away, but their container must still stop before its slot is freed.
5. Retry is allowed only when the last attempt is terminal on disk, nothing for that task is still running in this process, and its captured context still matches the current code, plan and assignment. Otherwise the user must start a new request.
6. Shutdown order: reject new work → drain HTTP requests (with a time limit) → abort and await request-owned work → cancel and await runner jobs → write terminal states → close storage.
7. Each piece of user feedback becomes one append-only **feedback event**, written in the same transaction as the user action. Lane J reads these events after a task closes.

## Terms used

| Term | Meaning in this document |
|---|---|
| Task | One run of one GitHub issue through its plan, from start to merge or cancel. |
| Attempt | One agent invocation or one runner command for a task. Has a unique `attemptId`. |
| Phase | The kind of attempt: `planning`, `questions`, `review`, `execute`, `fix` (from `agents/contract.ts`), plus runner-only `check` and `rebase`. |
| Writable phase | `execute`, `fix`, and a rebase conflict fix. These can change the task folder. |
| Captured context | The `InvocationContext` saved when an attempt is admitted: snapshot ID, plan ID, plan revision, assignment ID, referenced-code hash and state version. |
| State version | A number stored on each task. It goes up by one on every durable change to the task or its attempts. |
| Current | A captured context is current when every field matches the task's present durable state. |
| Settled | D's `InvocationHandle.settled` promise has resolved. The container and its output capture have stopped. |
| First reason | The first stop reason recorded for an attempt. Later reasons never replace it. |
| Slot | The in-memory right to run an attempt. A limited number of slots exist. |
| Admission | The point where the runner accepts new work and writes the pending attempt. |
| Feedback event | An append-only record of one piece of feedback that the user wrote or chose. |

## State holders and owners

AGENTS.md requires these five holders to be treated separately. Each one has exactly one owner.

| Holder | What it holds | Owner | It lets go when |
|---|---|---|---|
| Durable records | Task rows, attempt rows, feedback events (SQLite through `runner/store.ts`) | `Store`. It is the only writer. | Never deleted by the lifecycle. Terminal rows stay as history. |
| In-memory jobs | One `Job` per active attempt: attempt ID, handle, first reason, settlement promise | The runner coordinator (one instance per process) | After D's `settled` resolves **and** the terminal durable write has been attempted |
| Subprocesses and containers | The agent container, capture processes and cleanup | D (the adapter behind `InvocationHandle`) | When `settled` resolves. F never kills a process directly. |
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

| From | To | Trigger | Guard (checked in one transaction) |
|---|---|---|---|
| — | `pending` | Admission | Coordinator is `open`; task state version equals the caller's expected version; no non-terminal attempt exists for the task; captured context is current; a slot is free |
| `pending` | `running` | D returns a handle | Attempt ID is the task's current attempt; state is `pending` |
| `pending` | `cancelled` / `stale` / `failed` | Stop before launch, context change, or launch error | Same attempt ID; state is `pending` |
| `running` | `completed` | Validated result | Attempt ID is current; state is `running`; no first reason recorded; task state version and captured context still current |
| `running` | `failed` | Settled with an error or invalid output | Attempt ID is current; state is `running` |
| `running` | `cancelled` | Settled after a user, hard-stop or shutdown reason | Attempt ID is current; state is `running`; first reason is `cancelled` or `shutdown` |
| `running` | `stale` | Settled after the context changed | Attempt ID is current; state is `running`; context no longer current |
| `pending` or `running` | `failed` | Startup recovery (the previous process died) | Runs before admission opens, after D's recovery has removed leftover containers |

Every legal change increases the task's state version by one. Recording a first reason on a `running` row is also a durable change and increases it, so a poll can show "Stopping".

### Rules for the running state

1. **Stop requests do not end the attempt.** A cancel, hard stop, shutdown or detected staleness writes the first reason onto the `running` row and calls `handle.cancel(...)`. The row stays `running`, and the UI shows "Stopping".
2. **The terminal state comes from the first reason.** When `settled` resolves, the terminal state is chosen in this order:

   | First reason recorded by F | D result | Terminal state |
   |---|---|---|
   | `cancelled` (user or hard stop) | any | `cancelled` |
   | `shutdown` | any | `cancelled`, with the reason "Stopped by shutdown" |
   | `stale` (context change) | any | `stale`, with the cause (for example "plan revision 4 replaced 3") |
   | none | `stopReason` `timeout` | `failed`, reason "Timed out after *n* minutes" |
   | none | `stopReason` `output-limit` or `capture-failure` | `failed`, with D's bounded diagnostic |
   | none | exit 0 and output passes validation | `completed` (if the compare-and-swap succeeds) |
   | none | anything else | `failed`, with the bounded exit and stderr summary |

3. **F keeps its own reason.** D's `StopReason` has no `stale` value. F passes `cancelled` to D for staleness, and keeps the real cause in its own first-reason field. No layer may replace an actionable reason with generic cancellation text.
4. **Timeouts are D's job.** F sets `deadline` in `InvocationInput` and does not run a second timer that settles early. F also enforces a whole-task time budget (default 2 hours). When the budget runs out, F records `cancelled` with the reason "Task time limit reached" and moves the task to needs human.
5. **Late results lose.** If the compare-and-swap for `completed` fails, the result is discarded and the row is settled by the table above. Discarded output still waits for `settled` before its slot is freed.

### Exception for existing read-only lifecycles

E3 suggestions (`requests` table) write `cancelled` to disk when the stop is requested, before the provider settles. This is acceptable for read-only phases, because they share no writable folder with a later attempt and E3's coordinator still blocks a new start until the provider settles. **New F records use the stricter rule above for every phase.** The table under "Existing lifecycles" records how each one maps.

## Slots and concurrency

1. A slot is taken at admission and freed only in the `finally` step that runs after `settled` resolves. Cancel does not free a slot. Lease expiry and clock changes do not free a slot.
2. At most one non-terminal attempt exists per task.
3. codeboost 1.0 runs one task at a time. Writable-phase attempts therefore share one global slot.
4. Existing limits stay: two question slots (`runner/questions.ts`); one suggestion request per plan identity (E3).
5. A locally tracked job blocks a retry for its task even if the durable row looks terminal. This can only happen if a terminal write failed. In that case the task stays blocked until restart recovery. It does not unblock itself.

## Retry

A retry is a new attempt with a new attempt ID. The runner allows it only when all of these are true:

| Check | Where it is checked |
|---|---|
| The last attempt for the task is `failed` or `cancelled` on disk | `Store` transaction |
| No in-memory job exists for the task | Coordinator, synchronously before the transaction |
| The caller's expected state version and attempt ID match the task's current values | `Store` transaction (prevents a double retry from two tabs) |
| The last attempt's captured context is still current: snapshot, plan revision, assignment and referenced-code hash | `Store` transaction |
| The coordinator is `open` | Coordinator |

A `stale` attempt can never be retried. The UI instead offers "Run again on the current code". That creates a new request, which captures a fresh context.

The server computes `retryable` and sends it to the UI. The UI never works it out itself.

## Publishing a result

1. Wait for `settled`.
2. Validate the output (schema, size, file-scope audit for writable phases). Do not await anything between the last check and the transaction.
3. In one `Store` transaction: confirm that the attempt ID is the task's current attempt, the state is `running`, there is no first reason, and the task's state version and captured context match. Then write `completed` and the result, and increase the state version.
4. If step 3 refuses, reread durable state and settle the row by the rules above. Keep the original diagnostic.

**Irreversible actions.** Before each commit, push, PR open or merge, re-read the task's state version and the coordinator's `closing` flag **after the final await**. Stop if either changed. A check made before an await does not count. (This follows the AGENTS.md rules on guarded external actions.)

## Shutdown

`web/server.ts` `close()` and the runner coordinator follow this order. Steps 1 and 2 already exist. F1 adds steps 4 and 5 and moves storage closing to the end.

| Step | Action | Existing? |
|---|---|---|
| 1 | Set `stopping` on the server and `closing` on every coordinator, in the same synchronous turn, before any active-work list is copied. New API requests get HTTP 503. New admissions throw. | server: yes; runner: new |
| 2 | Stop accepting connections, and wait for admitted requests up to the drain limit (at most 14.5 s, below the 15 s request timeout). | yes |
| 3 | After the drain limit, abort the signals of the remaining requests, destroy requests that are still reading a body, then await request-owned work (the merge coordinator). | yes |
| 4 | Record the first reason `shutdown` on every running attempt, call `cancel('shutdown')`, then await every `settled`. D guarantees that settlement ends by escalating to a forced kill. F does not abandon a job after a timer. | new |
| 5 | Write the terminal states for the attempts from step 4. | new |
| 6 | Await server closure; await the question and suggestion coordinators' `close()`. | yes (questions); suggestions: new wiring |
| 7 | Close the `Store`. | yes |

**Process shutdown is a hard stop.** When the process stops, the running task does not finish. Its attempt ends `cancelled` with the reason "Stopped by shutdown". Restart recovery (lane I3) puts the task back in the queue. This is different from "Stop the queue" (lane I), which lets the running task finish.

**A second Ctrl+C** does not skip steps 4 to 7. The CLI prints "Still stopping agents…" and keeps waiting.

## Startup recovery

This runs before the coordinator opens.

1. Take the single-runner lock for this database (decision 1). If another live runner holds it, start the review screen read-only and do not start the runner.
2. Run D's leftover-container and network cleanup. Await it.
3. For every `pending` or `running` attempt row, write `failed` with the reason "Interrupted: codeboost stopped while this was running". A first reason that was already recorded is kept in the diagnostic.
4. Hand the tasks to lane I3 for workspace rebuild and requeue. F1 only makes the attempt rows terminal.
5. Open the coordinator.

## HTTP and UI contract

**Status reads.** `GET /api/runner` returns only the task and attempt rows plus `stateVersion` and `retryable`. It does not rebuild Git history or the full review.

**User actions.** Cancel, retry and "run again" requests send `taskId`, `attemptId` and `expectedStateVersion`. A mismatch returns HTTP 409 with the current state. The UI then shows that state and keeps any draft.

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
| `POST /api/plan/suggestions/:id/cancel` | E3 coordinator cancel | pending only |
| `POST /api/plan/suggestions/:id/apply` | `Store.applySuggestion` | request `ready` and bound to the current revision and snapshot |

Live planning invocation waits for D5. Until then, the server returns "Planning agent not available yet" instead of using a fake provider.

## Feedback-event contract (for lane J)

**What becomes an event.** Only feedback the user wrote or chose. Issue text, issue comments and agent output never become events.

| Event kind | Source action | `sourceRef` |
|---|---|---|
| `reject` | "Reject with feedback" | the rejection's note IDs |
| `change-request` | A change note on a plan item | note ID |
| `segment-accept` | Accepting an Ambiguous or Unplanned segment | choice key |
| `segment-assign` | Assigning a segment to a plan item | choice key |
| `finding-accept` | Marking an open problem "accepted" | finding ID |
| `needs-human-guidance` | Guidance added when sending a needs-human task back | note ID |
| `task-closed` | Task merged, cancelled or rejected | task ID |

**Fields:** `id`, `taskId`, `repository`, `planKey`, `planRevision`, `snapshotId`, `item` (or null), `kind`, `text` (user text only, 4000 characters or fewer, or null), `sourceRef`, `supersedes` (or null), `createdAt`.

**Rules:**

1. Write the event in the same `Store` transaction as the user action. There is never an event without its action, or an action without its event.
2. Events are append-only. If a choice changes later, write a new event with `supersedes` set to the earlier event. J uses the newest event for each `sourceRef`.
3. Replaying the same action does not duplicate an event. `(kind, sourceRef, planRevision)` is unique.
4. J reads events only through `Store.feedbackEvents(taskId)`, and only after that task's `task-closed` event exists.

## Proposed storage additions

This is the smallest schema that holds the contract. The F1 implementation PR sets the final column names. The migration increases `user_version` from 5 to 6.

| Table | Key columns |
|---|---|
| `tasks` | `id`, `plan_key`, `status`, `state_version`, `current_attempt_id`, `created_at`, `updated_at` |
| `attempts` | `id`, `task_id`, `phase`, `item`, `state`, `context` (JSON), `first_reason`, `stop_reason`, `exit_code`, `signal`, `diagnostic` (bounded), `created_at`, `started_at`, `settled_at` |
| `feedback_events` | the fields listed above, with a unique index on `(kind, source_ref, plan_revision)` |

`tasks.status` holds the product states from the design (queued, running, needs human, needs amendment, needs approval, possibly already fixed, in review, approved but merge blocked, merged, cancelled). F1 defines the list and its invariants. F2 adds the per-item transitions. I1 adds queue admission and scheduling.

## Existing lifecycles and how they map

| Lifecycle | Current states | Maps to | Gap and owner |
|---|---|---|---|
| Questions (`runner/questions.ts`, `QuestionAnswer`) | `pending`, `complete`, `failed`; 125 s persisted lease | `running`, `completed`, `failed` | No durable `cancelled` or `stale`; stale is only worked out when the screen renders. The lease allows a second process to start after 125 s. Fixed when F moves Ask onto D's contract after D5. |
| Suggestions (E3, `requests`) | `pending`, `ready`, `consumed`, `failed`, `cancelled`, `invalidated` | `running`, `completed`, `completed` (applied), `failed`, `cancelled`, `stale` | Durable `cancelled` before settlement (allowed for read-only phases; see the exception above). No change. |
| Merge attempts (C and K, `merge_attempts`) | `submitting`, `queued`, `merged`, `removed`, `failed` | `running`, `running` (external), `completed`, `failed`, `failed` | None. When the outcome is unclear, ownership is kept, as AGENTS.md requires. F6 integrates. |

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
| Old attempt settles after a retry (D/F contract) | Attempt A cancelled and settled → retry B admitted → a late publish from A is refused → B's row and the visible status are unchanged |

## Decisions (approved 2026-09-25)

The user approved the proposal for each of these four questions.

| # | Question | Decision | What F1 must do |
|---|---|---|---|
| 1 | How is one runner per database enforced across processes? | An exclusive lock file next to the database, holding the process ID and the process start time. | Take the lock at startup and release it at the end of shutdown. Accept a leftover lock file only if no live process has that ID and start time. Do not use a SQLite lease row, because lease expiry could release a live runner. |
| 2 | Does E3 keep writing `cancelled` before the provider settles? | Yes. This exception applies only to read-only phases. | Leave E3 unchanged. New F records use "terminal only after settlement" for every phase. Revisit this when G4 wires the planning endpoints. |
| 3 | Is process shutdown a hard stop? | Yes. | Stopping the process cancels the running task with the reason "Stopped by shutdown". It does not wait for the task to finish. Restart recovery requeues the task. |
| 4 | Does F set its own time limit on settlement at shutdown? | No. F waits for D's forced-kill escalation. | Do not abandon a job after a timer. The D5 real-Docker suite must prove that settlement always ends, including for a child process that ignores SIGTERM. If D5 cannot prove this, reopen this decision before F1 merges. |

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

# Repository agent instructions

Follow the repository conventions in `CLAUDE.md`. Read `DESIGN.md` before making visual or interaction changes.

## Async jobs and polling

For features with background jobs, polling, retries, cancellation, or shutdown:

- Define the lifecycle states and ownership before implementation: pending, running, completed, failed, cancelled, stale, and closing.
- Treat persisted state, in-memory jobs, subprocesses, HTTP requests, and rendered UI as separate state holders. Define how each transitions and settles.
- Never apply a background response without proving it is still current. Use a generation, attempt ID, version, or guarded merge so older polling responses cannot overwrite newer actions.
- A current response may still move a record only along a transition allowed from the state the action was guarded for. Derive the new status from that state as well as the response; a response alone must never move a record out of a state that waits for a person.
- Do not release a concurrency slot when cancellation is requested. Keep the job tracked until its underlying invocation or subprocess has terminated.
- Do not let a retry replace a locally active job, even when its persisted lease has expired or wall-clock time changes.
- Validate retry context against the current snapshot, plan revision, assignment, and referenced code. If any context is stale, disable retry and require a new request.
- Preserve the original timeout, cancellation, and shutdown reason through every layer. Do not replace actionable errors with generic cancellation text.
- Begin shutdown by rejecting new work at the outer admission boundary. Drain already-admitted HTTP requests, then cancel and await jobs, then close storage.
- Bound the HTTP drain during shutdown. After its grace period, abort and await owned work before awaiting server closure so an admitted poll cannot deadlock teardown.
- Polling endpoints should read only the state they need. Do not rebuild Git history or the full review merely to retrieve background-job status.
- Back off recurring external-status polling to a bounded cap. Reset the interval only after a meaningful lifecycle change or explicit user action.

## Async review UI

- A background response must not erase text, selections, attachments, navigation changes, or other input made after the request started.
- Clear a submitted draft only if its current value and attachment still match what was submitted. Treat this as compare-and-swap behavior.
- Preserve completed historical results, but visibly mark them stale when their snapshot, plan revision, assignment, or referenced code no longer matches.
- When polling updates one part of the screen, update only that state. Preserve scroll position unless the user was already following the bottom.
- While a request is in flight, do not disable the control that has keyboard focus; disabling it drops focus to the page. Mark it `aria-disabled`, ignore repeat activation with an in-flight guard, and test that focus stays on the control after the response.
- When a row or control's visual selection determines the current content or input, expose the same state with the appropriate accessibility attribute, such as `aria-current` or `aria-selected`, and test it across navigation.

## Required race regressions

Before opening or updating a PR for asynchronous behavior, test every applicable interleaving with controllable promises, clocks, and partial requests:

- Poll starts, then a user action completes, then the old poll returns.
- A job lease expires, then retry is attempted while the original job still runs.
- Timeout fires, then the provider remains unsettled temporarily, then retry is attempted.
- Shutdown starts, then a new request arrives.
- A request is partially received, then shutdown starts, then the request completes.
- An abort error fires, then subprocess close arrives later.
- Submit starts, then the user edits the composer or switches items, then the response returns.
- Referenced code is reassigned or the snapshot changes, then retry or rendering occurs.
- A synchronous caller hook inside a lifecycle (such as a callback that records a spawned process group) throws, blocks past the deadline, or aborts the signal, then the lifecycle continues. Timers and listeners that bound the lifecycle must already be armed when the hook runs, and a signal already aborted when its listener is attached must still take effect.
- A child process exits, but a descendant outside its process group still holds its output pipes.

Every reproduced race requires a failing-before and passing-after regression. Assert both the visible result and the durable state when they can diverge.

## Review readiness

- Before requesting or re-requesting an automated Copilot review, self-review the full current diff, fix every issue found, and repeat the self-review and fix cycle until a complete pass finds no new issues. Re-run the relevant validation after fixes; only then request Copilot review.
- Each self-review pass rereads every changed function in full against the base, not only the lines changed since the previous round. Code unchanged since the first commit of the PR still gets reviewed in every pass.
- Treat every behavioural claim the change makes, in code comments, the PR body or docs (for example "pauses every 1,000 entries", "settles only after exit", "never throws", "bounded by N seconds"), as something to verify. Trace each claim through every path that can break it, including nested loops, callbacks, error paths and early returns, and give it a test that fails if the claim is false.
- A test's setup must leave the state the production path would: if production never runs a step (such as a commit that refreshes Git's index), the test must not run it before the behaviour under test either.
- The author's self-review is not enough for concurrency, process, subprocess, timer or resource-cleanup code. Before requesting Copilot review, also run an independent review that does not share the author's context: `/codex review`, a separate review agent, or `/code-review` at `high` effort or above. Fix its findings like any other.
- Run final validation against the exact pushed head after the last change.
- Report current test counts separately from historical milestone counts.
- Before requesting automated review, report the current head, CI state, mergeability, unresolved threads, and deferred follow-up issues.
- In evidence records, label cited commits as baselines, intermediate checkpoints, or validated heads. Keep final exact-head results in a place that can name the resulting commit, such as the PR body or CI record.
- Reproduce summary-only review concerns or turn them into a concrete follow-up issue. Do not repeatedly patch vague wording without a failure case.
- A validation fixture for a summary-only concern must assert the disputed intermediate representation or state before using a downstream outcome as evidence that the concern was exercised.
- For each review round, record what changed, what was declined and why, and the regression evidence. Re-request review until a round returns no new findings.
- Treat review-lesson extraction as a merge gate. Before invoking merge, classify every review finding in the PR body as: covered by an existing rule (cite it), captured by a new rule in this branch (cite it), or one-off (record why). Do not merge until this audit is complete and every required `AGENTS.md` update is included in the reviewed head. Omit rules that merely repeat existing guidance.

## Guarded external actions

- A bounded safety scan must fail closed when its limit is exceeded. Never truncate evidence and report the result as clear.
- Align subprocess output limits with every payload the schema accepts, or tighten the upstream page and field bounds; valid bounded input must not fail only because the transport budget is smaller.
- Exclude the subject of a duplicate or supersession check by stable identity only. A shared branch name or other mutable attribute does not prove two records are the same subject.
- Preserve repository identity with pull request numbers in cross-reference scans. Never resolve or exclude a repository-qualified reference by number alone.
- When a relation can be added and removed (a manually linked PR, a label, an assignment), replay its add and remove events in order and count only its latest state. An add event alone does not prove the relation still holds.
- After the final asynchronous external validation, re-read the local generation immediately before an irreversible action. A generation check performed before that await is insufficient.
- Check an operation's source-state preconditions before any shortcut or early return that writes state or reports success, not only on the main path.
- Batch and briefly cache read-only status probes, and give the combined operation an overall deadline below the serving request timeout.
- Budget a multi-stage validation across all sequential stages; giving each stage the full request allowance does not create an overall deadline.
- Preserve the distinction between an explicit unbound identity and missing or malformed authorization metadata. Missing or malformed identities must fail closed.
- Validate every field used to classify an external record as clear, including enum values and required nullable fields. Partial records and malformed policy objects must fail closed.
- Validate coupled lifecycle fields as allowed combinations. A terminal-looking conclusion must not override an active or unknown status.
- Treat a successful external command as the transition it actually performed. If it can enqueue or schedule work, model and verify that lifecycle before reporting the final action as complete.
- For safety-critical API responses, require and validate every requested field before any early return, including terminal-success paths. Treat an omitted field differently from an explicit `null` allowed by the API contract.
- Once an irreversible external command succeeds, do not convert later refresh or rendering failures into action failure. Return the committed result, keep repeat controls disabled, and require fresh confirmation of terminal state.
- Track an in-flight irreversible subprocess as part of server shutdown. Abort it, await its settlement, and only then close the state it depends on.
- Set the shutdown admission flag before snapshotting active work, and enforce it again at the irreversible action boundary for requests admitted before shutdown began.
- An approval must not override server-computed plan-scope violations. Irreversible gates must block attributed out-of-scope files until the plan is amended.
- When startup acquires a store, process, listener, or other resource before later dependency construction, close that resource on every construction failure. Prefer validating dependencies before acquisition when possible.
- When deriving a review configuration for a clone, experiment, fork, or new identity, clear external action bindings unless they are re-established and validated for the derived target.
- A deadline must abort and await the underlying operation before releasing its in-flight ownership; rejecting only the caller can leave untracked work running.
- Invalidate pre-action status caches after both successful and refused external mutations before rendering or fetching status again. Use a generation guard so reads started before or during the mutation cannot repopulate the cache afterward.
- Keep irreversible integrations disabled in demo mode even when configuration or an injected dependency is present. After a stale or refused irreversible action, keep its control disabled until fresh state is loaded.
- When a durable external-action attempt is bound to an older snapshot, require approvals or evidence recorded against the replacement generation before another action, whether or not the prior outcome explicitly requested fresh review. A mismatch with the old context is not itself fresh review.
- If the external lifecycle mechanism or mode changes between validation passes, abort before the irreversible command. Create durable lifecycle ownership from the final stable mode, never from an earlier observation.
- When an irreversible command has an ambiguous timeout, cancellation, transport, or unknown outcome, retain durable in-flight ownership and reconcile external state before enabling retry. Only a confirmed refusal may become retryable failure.
- Correlate retry observations to the current attempt with an immutable external identity or event boundary, and fail closed when multiple post-boundary action sequences appear. Matching only the resource or commit identity can replay another attempt's terminal event.
- Make an idempotency key required at the API boundary for every replayable action, and look up its saved outcome before any other guard, including in-flight, validation and coordinator shutdown guards. The one exception is the server's HTTP 503 during shutdown, which applies nothing; the client must keep the key and resend it. Save every definite outcome under the key (refusals before admission too), keep the saved response current with the durable outcome it reports, and replay failures as failures with complete result fields. Only a passing, nothing-applied outcome (shutdown, abort, deadline, storage error) stays resendable.
- When a refusal must also change durable state (for example, handing an expired task to a person), commit that change outside the refused transaction, together with the saved refusal. Never write it inside the transaction the refusal rolls back.

## Owned host and Docker resources

- Treat the cleanup handle of an external resource (container, volume, network, temporary directory) as owned state. If removal fails, keep the handle, record it durably before its in-memory owner can be dropped (shutdown, crash, abandon, restart), and fail closed until removal is confirmed. Never delete the durable evidence before the final release report has been saved.
- Give every subprocess an explicit allowlisted environment. Pass credentials only to the component that needs them, through a separate channel. Name-based scrubbing of an inherited environment is not isolation. Run Git with the repository's hardened invocation: no user or system config, no hooks, no lazy fetch, no network protocols.
- Build that allowlist from each tool's documented credential and configuration channels on every supported platform (for example, the D-Bus session bus that a Linux keyring uses), and test that each is passed.
- Treat paths read from a durable record or discovered on disk as untrusted. Before deleting, opening or probing one, validate its exact location and name, not only its basename, and never follow a link to it. Keep files that other local users must not plant or swap, such as lock files, in a directory only the current user can write. Write durable records through a unique temporary file opened exclusively, and delete it if the write fails.
- Exclude other processes with an OS-level lock held for the owner's lifetime, keyed by the resource's stable identity rather than a path spelling. A PID liveness check never authorizes taking over a lock. Run shared one-time startup work single-flight under that lock, and keep the lock until the work has finished.

## Agent-controlled content

- When a subprocess reports a problem only as a warning and carries on, decide pass or fail by what each message means for the result, not by whether anything was printed: fail on messages that mean it did less than it should (for example could not read a path), and let through messages about harmless input the agent controls. Test both a benign case and a failing case, and filter the output as it arrives so that no volume of benign messages can push a failure out of a bounded buffer.
- Quote or escape agent-controlled text (file names, paths, branch names) wherever it lands in output that people or tools parse, such as diffs, notices, logs or reports, so it cannot forge that output's structure.
- Never spread a collection whose size follows unbounded input into function arguments (`Math.max(...runs)`); engines limit the argument count, so use a loop.
- A hardened Git invocation must also keep Git out of nested repositories and populated submodules, whose own config and hooks are the agent's: pass `--ignore-submodules` on the command line (the config default does not bind plumbing or override `.gitmodules`), and never run Git with a nested repository as its working directory.

## Blinded experiments

- Keep experimental PRs as drafts with automated review disabled until the assigned human decision is recorded. An automated review invalidates reviewer blindness; replace the affected package rather than reusing it.
- If an experiment is cancelled, record it as cancelled rather than passed, remove it from roadmap prerequisites, and track any future validation as explicitly non-blocking. Do not infer product claims from preparation work or incomplete trials.

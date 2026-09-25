# Repository agent instructions

Follow the repository conventions in `CLAUDE.md`. Read `DESIGN.md` before making visual or interaction changes.

## Async jobs and polling

For features with background jobs, polling, retries, cancellation, or shutdown:

- Define the lifecycle states and ownership before implementation: pending, running, completed, failed, cancelled, stale, and closing.
- Treat persisted state, in-memory jobs, subprocesses, HTTP requests, and rendered UI as separate state holders. Define how each transitions and settles.
- Never apply a background response without proving it is still current. Use a generation, attempt ID, version, or guarded merge so older polling responses cannot overwrite newer actions.
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

Every reproduced race requires a failing-before and passing-after regression. Assert both the visible result and the durable state when they can diverge.

## Review readiness

- Before requesting or re-requesting an automated Copilot review, self-review the full current diff, fix every issue found, and repeat the self-review and fix cycle until a complete pass finds no new issues. Re-run the relevant validation after fixes; only then request Copilot review.
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
- After the final asynchronous external validation, re-read the local generation immediately before an irreversible action. A generation check performed before that await is insufficient.
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

## Blinded experiments

- Keep experimental PRs as drafts with automated review disabled until the assigned human decision is recorded. An automated review invalidates reviewer blindness; replace the affected package rather than reusing it.
- If an experiment is cancelled, record it as cancelled rather than passed, remove it from roadmap prerequisites, and track any future validation as explicitly non-blocking. Do not infer product claims from preparation work or incomplete trials.

# Read-only review screen (#3)

Started from `dd6a1e7`, after merging the SQLite store PR. This delivers the local review surface and experiment tooling; issue #3 remains open until the human go/no-go work is complete.

## Run it

`npm ci --ignore-scripts`, then `npm run demo`. Open the private loopback URL printed by the command. The demo uses a real disposable Git repository and SQLite database under ignored `.codeboost-local/demo`; restart preserves approvals and notes. No source files in the codeboost checkout are edited by the demo. Stop with Ctrl+C.

For an existing trusted store, use `npm start -- --config /absolute/path/review.json`. The JSON has `database`, `repository`, `identity` (`repositoryId`, `taskId`, `planId`), and `pathIdentity` (`caseSensitive` boolean, `unicodeNormalization` equal to `none` or `NFC`). Paths should be absolute. Supply actual checkout identity rules, not an OS guess. The demo probes its local filesystem; it uses only simple ASCII fixture paths. Unsupported or more complex filesystem equivalence must not be approximated by this adapter.

The selected repository's current HEAD is compared to the stored base. Refresh observes new heads and creates an immutable snapshot; approvals are recomputed for the resulting changes. It does not fetch, rebase, run tests, invoke agents, or merge. Histories still obey the library's linear/complete/bounded-history constraints.

## UI and storage

The app follows the Evidence Desk tokens and self-hosts IBM Plex Sans/Mono. It has item and exception rows, four status checks, a provenance gutter, file metadata, shared-hunk labels, assignments, standalone acceptance, no-change confirmation, approval counts/staleness, before/after approval evidence, per-item questions/change requests, keyboard controls, resizable/collapsible side panes, desktop breakpoints, and loading/error/empty states. Questions are saved for discussion; no AI answer is fabricated. Tests/AI review are explicitly not run. Change requests remain pending for a future revision workflow.

The server binds only 127.0.0.1 and requires its random private token for APIs. Host/origin checks, a restrictive CSP, bounded UTF-8 JSON bodies, and DOM escaping prevent another website from reading or writing local review state. Browser commands contain item/segment IDs and the reviewed state token, never approval fingerprints or ledger ownership. The runner derives those from Git/store data. A database review counter prevents concurrent review actions from approving unseen assignments; plan and snapshot CAS remain enforced.

Store schema v2 adds the review counter and per-item notes through a transactional v1 migration. The test suite verifies existing revisions and ledger entries survive. This is an automatic local SQLite migration, not a migration against a shared environment.

## Known limits and remaining gates

- No agent answers, test execution, AI findings ingestion, send-to-agent action, or merge control is included. These belong after the go/no-go gate. Four checks distinguish unavailable evidence from success.
- File cards show mode/path/object IDs and blob byte sizes. PNG/JPEG/GIF/WebP previews are bounded to 1 MiB each and 4 MiB across a history; unsupported/oversized images say unavailable. Gitlink byte sizes are not applicable. SVG/HTML is never embedded.
- The protocol at `docs/experiments/review-protocol.md` must be filled with the real pairs and committed before the first timed review. The manual assignment, real paired PRs, human timing, and final result are pending. Do not mark issue #3 closed or claim the gate passed.
- The planting helper is intentionally limited to disposable clones and supported regular top-level paths; it never publishes PRs.

## Validation

Baseline before this slice: 157 tests. Run `npm run typecheck`, `npm test`, and `npm run test:browser`. Browser tests use real Git and SQLite with Chromium and cover persistence, assignments, metadata, no-change approval, stale views, unsafe origins, keyboard/breakpoints, error display, and untrusted text. A browser regression exposed false stale reasons from JSON field order; structural comparison replaced that check. The plant test verifies source HEAD stays unchanged and both plants retain ledger ownership.

A large-change regression reproduced HTTP 413 when the browser sent the full content-based choice key for a 20 KB segment. Browser segment IDs are now bounded SHA-256 identifiers; the runner reconstructs the original identity/content/copy key before saving the choice. This retains choice expiry semantics without sending source content back in a review command.

## Review round 1

Reproduced and fixed no-change approval with item-owned ambiguous segments; the runner refuses it and the UI directs the user to resolve attribution first. Previously approved no-change items become stale if ambiguous work appears. Reproduced malformed non-ASCII credentials returning a generic conflict instead of unauthorized; credentials now require the expected ASCII hex shape before constant-time comparison. Reproduced stale item controls surviving a failed refresh; errors now discard the loaded view and require refresh. Added acceptance persistence and whole-plan empty-state browser coverage. No findings declined.

## Review round 2

Extended the attribution guard to mixed items with both owned and ambiguous segments. The regression reproduced ordinary approval succeeding with unresolved attribution. Approval now rejects any item-specific ambiguity, previously approved affected items become stale, and the UI routes every such item to attribution resolution. Added browser coverage for this mixed case. No findings declined.

A toolbar-focus browser regression reproduced review shortcuts being disabled while a button had focus. Only text-entry/select controls now suppress the single-letter shortcuts; native Enter/Space button behavior is unchanged. The plan-row click case already worked because rendering replaces the focused row.

Review round 3 identified demo fixture config escapes and inherited Git environment redirection. Regression checks first reproduced the config, symlink, and environment failures. Existing demos now require exact fixture paths and ordinary config/database/repository objects (including `.git` and SQLite sidecars). Demo and plant Git commands share a case-insensitive environment scrub and disable inherited global/system Git configuration. Four helper tests cover these boundaries, including mixed-case variable names for Windows.

Review round 4 had no inline findings but raised two summary concerns. Both were reproduced: planting accepted a non-ASCII path under case-insensitive identity even though the viewer refuses it; accepted cards retained an unplanned scope label. Planting now applies the same path guard, and accepted cards explicitly say “Accepted outside plan.” The underlying provenance remains intact. Unit/browser regressions cover both fixes; no concerns were declined.

Review round 5 found a symlinked-ancestor escape and raw-spelling collisions in planting guards. Both regression cases failed before the fix. Demo creation/reuse now checks every ancestor (canonicalizing only the OS temporary-directory prefix); planting compares canonical identities for declared files and every path in the base/commit trees before cloning. The summary's status-styling concern had no additional concrete example; accepted cards already use the explicit label added in round 4.

Review round 6 reproduced destination-inside-source mutation; planting now resolves the existing destination ancestor and rejects canonical source descendants before creating files, including `.git` and symlink aliases. The Git-environment finding was declined: `gitRaw` already passes `{cwd, env, ...}` to `execFileSync`. A new end-to-end test with inherited `GIT_DIR`/`GIT_WORK_TREE` passed before any production change. The summary's snapshot-race claim supplied no concrete interleaving; the service already checks revision/snapshot/review version before publishing a view and writes use atomic store CAS, covered by concurrent-write tests.

Review round 7 reproduced oversized-dimension raster previews and dangling SQLite sidecar symlinks. Preview metadata is now parsed from the bounded buffer with image-size: at most 8,192 pixels per side, 4 million pixels per image and 16 million pixels across unique preview blobs. Unknown dimensions omit the preview; existing compressed/response byte limits remain. Sidecars use lstat so dangling links are rejected. Both new regressions failed before the fixes. The summary mentioned rename-scope/literal-path concerns without specific findings; no additional behavior was inferred from that shorthand.

## Feedback on selected code

Click a changed line number, Shift-click to extend a range, or highlight code within one changed block. The selection toolbar offers Ask and Request change; each attaches the full selected lines to that item's composer. Question/change-request drafts retain separate attachments. Remove snippet returns to item-level feedback.

The server validates the segment and range against the current review token and constructs the saved reference itself: path, old/new side, exact text, line range, base and head commits. Limits are 200 lines and 16,000 characters. References on unassigned changes require assigning them to a plan item first. Existing item-level notes remain compatible without a database migration.

Saved references navigate to the selected lines while the reviewed commits and assignment still match. Otherwise they are labeled Outdated and open the original captured snippet, never silently pointing at new code. This deliberately marks references outdated on any base/head change, even if the snippet is unchanged. Refresh invalidates transient selections; outdated draft attachments must be removed and reselected before submission. No agent or GitHub comment is invoked.

Snippet-feedback validation: 176 unit/integration tests and 15 browser tests pass (baseline 174 and 13), plus typecheck and diff checks. Coverage includes clicked lines, Shift-click ranges, DOM text highlighting, independent question/change drafts, removal, persistence, navigation, removed-side references, forged/invalid references and outdated snapshots. The actual PR #597 walkthrough was also opened in Chromium and the selected-line/composer layout visually inspected without saving test notes to its database.

## Agent answers and Settings

Scope update requested during the PR #597 walkthrough: Ask now invokes a read-only question agent before the broader implementation/queue go/no-go gate. This supersedes the earlier “no agent answers” limitation only for questions. Request change still saves feedback without running edits, and answering never changes a plan revision or approval.

Open Settings and choose Claude Code or Codex. The choice persists in this review database (schema v3 adds app_settings); existing notes and snippet references survive migration. No provider is selected automatically. The installed CLI must already be signed in. The question, selected snippet, plan item, changed code, checks and bounded prior conversation are sent to the selected provider. Truncation and absent evidence are part of the context; the agent must not claim unrun tests passed.

The question is saved before launch. Conversation displays Answering, then a persisted answer or an error with Retry answer. Retries reuse the question and have attempt IDs to reject late results from older attempts. At most two requests run per server; each has a two-minute deadline. Graceful shutdown cancels running answers; after a crash, pending attempts become retryable after their lease expires. A question from an older snapshot must be asked again against current code. Answers retain their provider and original question snapshot. Polling updates only notes, preserving the current draft and code selection.

The CLI adapter runs without a shell in a fresh temporary directory. Claude uses safe mode with no tools and no session persistence. Codex uses an ephemeral, read-only session with user config/rules ignored, shell/apps/plugins/hooks/memory/delegation disabled, and web search disabled. These are restricted question adapters, not the future containerized code-running agent environment. Stdout and answer sizes are bounded; raw process logs and credentials are not returned to the browser.

Codex options were checked against the installed CLI help and the official [non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Both installed providers passed live connection checks. A separate copy of PR #597's review database passed a real Settings → Ask → saved Claude answer browser test; the user's review state and source checkout were unchanged. Native Node startup is covered by enabling TypeScript's erasableSyntaxOnly check after the live test caught an unsupported parameter-property declaration.

Validation: 181 unit/integration tests, 19 browser tests, and typecheck pass. A delayed-initial-review regression reproduced an unresponsive Settings button; binding controls before awaiting the first load fixes it. The restarted PR #597 instance also passed an immediate Settings-open check with both provider options visible.

Single-click submission follow-up: a held `/api/action` browser request reproduced the lack of immediate feedback (the submit button stayed enabled with no saving state). Question/change submission now shows Saving immediately, disables submission while a review action or refresh is in progress, and scrolls the saved note into view. Failures explicitly retain the draft for refresh/retry. The delayed-request regression checks one click produces exactly one stored question and one agent invocation; a lost first click was not independently reproduced.

Answer scrolling: when an asynchronous answer or failure arrives, Conversation follows the bottom if the reader was already within 32 pixels of it. Scrolling up keeps the current position through polling updates. Only the conversation list scrolls; the code pane and composer stay in place. Browser regressions cover both arrival at the bottom and arrival while reading earlier messages; the bottom-follow test failed before the fix with a 1,302-pixel gap.

Conversation width: drag the divider on its left edge to resize between 280 and 480 pixels. Focus the divider and use Left/Right for 20-pixel steps or Home/End for the limits. The width survives collapsing/reopening the pane within the page; reloading uses the layout default. This replaces the hard-to-discover native corner resize grip. The browser regression covers pointer dragging, keyboard limits, code-pane space, and collapse/reopen.

Selection actions now appear in a bordered floating toolbar beside the visible selected lines, with Ask emphasized. The toolbar stays within the code viewport, leaves line numbers available for Shift-click extension, and hides when the selection scrolls out of view. Clear selection removes it. The long-diff browser regression checks proximity, viewport bounds, attachment, scrolling away/back, and clearing; existing range/highlight tests remain required.

PR #11 review round 1 reproduced a stale-poll race: a held question-list response hid a question submitted after the poll began. Review actions and refreshes now advance a generation counter; earlier poll successes and errors are ignored. The browser regression failed with one visible note instead of two before the fix.

PR #11 review round 2 confirmed the poll fix and raised an outdated-retry issue in its summary. A browser regression reproduced the retry button on an older snapshot; such unanswered questions now instruct the reviewer to ask again against current code. Completed historical answers retain their outdated label. The summary's timeout-reporting concern supplied no concrete failure; timeout and interrupted-lease regressions remain in the validation suite.

PR #11 review round 3 reproduced retrying a locally active job after its persisted lease expires (for example after a clock jump). The manager now rejects a retry while that note is in its running map, before touching the persisted attempt. The regression advances wall time without advancing the deadline timer and checks the original attempt, single invocation, and shutdown cancellation remain intact.

PR #11 review round 4 reproduced new question work entering during shutdown. Questions now marks itself closing synchronously before cancelling/draining jobs; start rejects before any store write or agent invocation, during and after shutdown. The regression failed before the guard and checks that the unstarted note has no attempt recorded.

PR #11 round 5 confirmed the shutdown fix and made the timeout-summary concern concrete: the CLI adapter replaced the abort reason with generic cancellation. Direct adapter regressions reproduced this for timeout and shutdown reasons. The adapter now preserves Error-valued abort reasons; provider launch errors remain sanitized.

PR #11 round 6 reproduced releasing a concurrency slot while a cancelled invocation was still unsettled. Cancellation now persists the visible failure promptly but retains the job until the invocation settles; retries remain blocked and shutdown awaits it. The CLI adapter defers rejection and temporary-directory cleanup until child close, including abort and output-limit failures. Regressions cover late settlement and abort-error-before-close ordering. Injected agents must settle after cancellation; production adapters terminate with SIGKILL and await closure.

The review's polling-efficiency observation is tracked separately in issue #12: answer polling currently rebuilds the full review, and the follow-up will measure and remove that work while preserving snapshot metadata and stale-response protection.

PR #11 round 7 confirmed cancellation tracking and described outdated snippet retries in its summary. Direct UI reassignment of owned code is already rejected; a persisted assignment change reproduced the stale-reference case, now guarded in both manager and retry UI. The summary also mentioned in-flight composer state: browser tests reproduced lost typing during submission. Action responses now capture current drafts before rendering and clear only the unchanged submitted draft/attachment, preserving edits and drafts on other items.

PR #11 round 8 returned no inline findings and identified one related summary gap: completed answers only warned for an older snapshot or plan revision, not a snippet invalidated by reassignment. Completed answers now show the same historical-context warning for either condition. A browser regression preserves the historical answer while checking the warning after a persisted assignment change.

PR #11 round 9 returned no inline findings and identified shutdown ordering in its summary. Server shutdown now stops accepting connections and drains in-flight HTTP requests before closing the question manager and database. A partial-body request regression proves a question already admitted during shutdown starts its agent and is persisted as interrupted rather than left unanswered.

Current PR validation: 188 unit/integration tests, 32 browser tests, typecheck, and diff checks. Earlier counts above identify the stage when each behavior was added.

The documentation-only review after adding `AGENTS.md` exposed one more concrete lifecycle race: an expired persisted attempt could show Retry while its cancelled provider was still settling. Question polling now exposes whether the local invocation remains active, displays Finishing cancellation, and keeps polling without exposing Retry until settlement. A browser regression advances the persisted clock while leaving the invocation unresolved, then confirms Retry appears only after settlement.

The follow-up review exposed the same active-job marker missing from the initial review response. Reloading during provider settlement could therefore expose Retry and stop polling. Initial loads and action responses now include the marker used by question polling; the browser regression reloads during settlement and confirms Retry remains hidden until the invocation finishes.

The next review made assignment drift concrete for item-level answers without snippet references. Each answer now records a hash of the changed segments supplied for its item. Moving code into or out of that item preserves the answer but labels it as earlier review context and rejects retrying the old question; a regression assigns new code without changing the snapshot or plan revision, checks the historical marker, and proves no second agent invocation starts.

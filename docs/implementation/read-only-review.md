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

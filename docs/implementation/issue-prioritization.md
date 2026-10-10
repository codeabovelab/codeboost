# Lane H: issue prioritization

Baseline: `0ae71a503592de90926063fa563c1f7c715db22b` (`origin/main`,
2026-09-24).

Follow-up #41 was reproduced from validated-head baseline
`1e59b7dfda199c8156c09a9cb9a690e5b55f1b5e`: GitHub documents `MEMBER` as
organization membership, while its repository-collaborator endpoint reports
the identities with access to the repository. The trust policy below records
the corrected repository-scoped boundary.

## H1 decision: ranking policy

The first released policy is deterministic, explainable, and independent of an
AI model. It ranks open GitHub issues by the following additive score:

| Signal | Score |
| --- | ---: |
| Highest priority label: `P0`, `P1`, `P2`, or `P3` | 100, 75, 50, or 25 |
| `security` label | +40 |
| `bug` label | +20 |
| Positive reactions (`+1`, `heart`, `hooray`, `rocket`) | +1 each, capped at 20 |
| Comments | +1 each, capped at 10 |
| Age | +1 per complete 30 days, capped at 12 |

Labels are compared case-insensitively. When several priority labels are
present, only the highest priority contributes. Labels other than those listed
above do not affect the score. AI triage is excluded because the same issue set
must produce the same order without a provider call.

Issues sort by descending score, then oldest creation time, then ascending issue
number. Every contributing signal is emitted as a user-visible reason. An issue
with no contributing signal says that it has no configured priority signals.

An issue is trusted by default only when its author appears in GitHub's current,
repository-scoped collaborator list. GitHub's `author_association` remains
validated and visible metadata, but does not grant trust: in particular,
`MEMBER` proves organization membership rather than access to this repository.
Issues from deleted or non-collaborating authors remain visible but require an
explicit trust decision before queueing. Trust affects eligibility, never the
score, so an untrusted author cannot improve rank by embedding instructions in
issue text.

## Issue-access contract inspection

The existing `github/merge.ts` gateway is scoped to one configured issue and
pull request. It reads an issue timeline only for duplicate-work detection and
does not expose an issue-list contract that H can reuse. H therefore adds a
dedicated read-only gateway with these boundaries:

- Codeboost invokes `gh` with literal arguments; issue text is parsed only as
  data and is never interpolated into a shell command or prompt.
- Each `gh` process gets only the allowlisted variables in
  `github/gh-env.ts`, plus fixed settings that turn off prompts, the pager,
  colour and update checks. Other variables from the server, such as
  unrelated credentials, are not passed on.
- When the fetch deadline passes or the fetch is cancelled, the `gh` process
  gets SIGTERM, then SIGKILL after half a second. The fetch returns only after
  that process has exited, or a quarter of a second after it exits if a process
  it started keeps its output open. So a fetch aborted at its 12-second
  deadline settles by 12.75 s, below the 15-second request timeout.
- The gateway fetches open issues and the repository's current collaborators,
  excludes pull requests, follows bounded pagination for both collections, and
  validates every field used for normalization, trust, or ranking. If the
  configured GitHub identity cannot read collaborators, the refresh is
  unavailable rather than falling back to author-association metadata.
- A complete successful snapshot includes repository identity and a retrieval
  timestamp. A subsequent retrieval failure returns an explicit stale snapshot
  only when a previously validated snapshot exists; otherwise it is unavailable.
- Malformed fields, an exceeded issue or collaborator limit, an unknown author
  association, or an incomplete response fail the entire refresh closed.
  Partial records are never ranked as if missing values were zero.

## Ownership and staged delivery

Lane H is done. H1-H3 owned dedicated issue retrieval, normalization and
ranking modules plus their tests and this document. They did not edit the
Store, runner, shared web shell, package files or CI.

**Schedule change (2026-09-25, approved by the product owner).** H4 was planned
to wait for G4 to release the shared web files. G could not start until E4
merged, and E4 waited for D5, so the web files had no active owner. H4
therefore took them, split in two:

- **H4a (#55): the Issues screen.** It owned `web/server.ts`,
  `web/public/*`, a new `web/issues.ts`, the demo fixture
  `scripts/demo-issues.ts` and their tests. It did not edit `runner/store.ts`.
  Its plan was to hand the web files to G when G1 started. Lane G has since
  finished and released its shared screen files (see
  `docs/implementation/planning-screen.md`); `web/server.ts` is lane F's
  server contract.
- **H4b (#108, PR #139): the "trust this issue" action.** It was planned to
  record trust decisions through the storage owner (F) after F1's Store changes
  landed, so the two lanes would not both bump the schema version.

H1 is complete when this policy and access inspection are committed. H2/H3 are
complete when dedicated tests prove normalized retrieval, deterministic reasons,
stable tie-breaking, trust classification, bounded failure, and stale versus
unavailable states, and `npm run typecheck` passes.

## H4a: Issues screen

**What you see.** "Issues" in the app bar opens a ranked table: rank, issue
number and title (a link to GitHub), labels, one line of reasons, score, trust
and the date it was opened. Trust shows "✓ Collaborator" or "! Needs trust".
The status line says one of:

- "✓ Current": the list was retrieved at the time shown;
- "! Stale": the last good list is shown, with the time and error of the
  failed refresh;
- "✕ Unavailable": no list has been retrieved yet, with the error;
- "– Not configured": the review configuration has no `github.repository`.

Demo mode shows fixture issues and never contacts GitHub.

**State holders.**

| Holder | Owner | Lifecycle |
| --- | --- | --- |
| Retrieval (`gh` subprocesses) | `IssueBoard` in `web/issues.ts` | One refresh at a time, under an abort controller owned by the server. Concurrent requests join it. The gateway timeout is 12 seconds, below the 15-second request timeout. |
| Last good list | `IssuePrioritizer` (H3) | Kept in memory only. After a restart, the first failure is "unavailable", not "stale". |
| HTTP requests | `web/server.ts` | `GET /api/issues` reads the current view without fetching. `POST /api/issues` with `{"action":"refresh"}` starts or joins a refresh. A request that is aborted stops waiting but does not cancel the shared refresh. |
| Rendered screen | `web/public/app.js` | A generation number discards a response that a newer refresh has replaced. Switching screens hides and shows views without re-rendering, so review drafts, selections and focus stay. |

**Shutdown.** The server rejects new requests, drains admitted requests within
the grace period, then aborts the refresh and awaits the gateway's settlement
before closing storage.

**Evidence.** `test/issue-board.test.ts` covers joining, a departing request,
stale after success, shutdown abort-and-await, endpoint validation and the
unconfigured state. `test/browser/issues.spec.ts` covers ranked order, reasons,
trust marks, `aria-current` navigation, review input kept across navigation,
review shortcuts ignored on the Issues screen, the unavailable → current → stale
sequence, a late refresh after leaving the screen, and the 1280px layout.

## H4b: Trust this issue

**Decision and scope.** A trust decision is bound to the lower-cased repository identity, issue number and the issue's
current author login. It applies to planning and execute prompts. Revoking trust does not interrupt an invocation that
already started; every later plan-item admission, planning read and publish evaluates the new decision. Publishing is
guarded too, so a revoked decision cannot cross the next irreversible boundary.

**Durable state.** Schema v17 adds one `issue_trust` row per repository and issue, retaining who decided, when, the
author that was observed, and a revocation time. Changing or deleting the GitHub author makes the row inapplicable.
Trust and untrust requests carry UUID v4 action IDs and use the ordinary durable action replay before GitHub is read.
Definite GitHub read failures are saved too and replay with their upstream-failure classification; shutdown remains
resendable. Concurrent callers with one action ID all observe the first durable outcome.
Each execute attempt also stores the SHA-256 digest and count of the exact comment strings put in its prompt. The
evidence is durably `prepared` after every pre-launch check and before the launcher receives the prompt, then becomes
`delivered` only after the launcher returns an owned handle; recovery can therefore distinguish either crash window.

**Admission.** Start, resume, continuation approval and every plan item fetch the issue author and the complete current
collaborator list under a bounded GitHub read. A collaborator-authored issue passes without a local decision. Every
other issue needs a live, unrevoked row for that exact repository, number and author. A prompt text read revalidates the
admitted author and collaborator result against the issue and collaborator snapshot used for that text, closing the gap
between authorization and prompt construction. When explicit trust widened the comments, its author-bound Store row is
re-read immediately after the awaited text fetch so revocation cannot admit the stale all-comments result. The returned
execute source carries the same synchronous guard into `prepareExecution`, and the planning description carries it
into the recorded user action; each runs in the same turn immediately before its prompt is constructed. Malformed,
partial, failed and over-limit reads fail closed. Action-time
failures are saved under the action ID; per-item failures settle that attempt without admitting the next item. The task
and review versions are still checked in the same transaction that admits an attempt, after the external read.

**Comments.** Without matching explicit trust, only current collaborators' comments enter planning and execute prompts.
With matching trust, every bounded comment enters the same untrusted-data block, including comments from deleted
accounts. The issue author is re-read with the comments, so a decision for an earlier author cannot widen the prompt.

**Screen and demo.** The Issues table offers `Trust this issue` for outside authors, `Trust all comments` for current
collaborators, and `Remove trust` for either explicit decision. The collaborator's author-bound decision widens comment
access without changing its already-eligible status. While a request is in flight, the focused control remains
enabled for focus purposes, uses `aria-disabled`, and ignores repeat activation. Responses merge only their own row;
overlapping refreshes and trust requests cannot overwrite a committed decision or reset another control. Demo fixtures
use the same Store and API, but resolve author and collaborator state locally and never contact GitHub.

# Lane H: issue prioritization

Baseline: `b181d152ed522cf0ea6179d0ab7f0b45b00a6a4f` (`origin/main`,
2026-09-24).

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

An issue is trusted by default only when GitHub reports its author association
as `OWNER`, `MEMBER`, or `COLLABORATOR`. Other issues remain visible but require
an explicit trust decision before queueing. Trust affects eligibility, never the
score, so an untrusted author cannot improve rank by embedding instructions in
issue text.

## Issue-access contract inspection

The existing `github/merge.ts` gateway is scoped to one configured issue and
pull request. It reads an issue timeline only for duplicate-work detection and
does not expose an issue-list contract that H can reuse. H therefore adds a
dedicated read-only gateway with these boundaries:

- Codeboost invokes `gh` with literal arguments; issue text is parsed only as
  data and is never interpolated into a shell command or prompt.
- The gateway fetches open issues, excludes pull requests, follows bounded
  pagination, and validates every field used for normalization or ranking.
- A complete successful snapshot includes repository identity and a retrieval
  timestamp. A subsequent retrieval failure returns an explicit stale snapshot
  only when a previously validated snapshot exists; otherwise it is unavailable.
- Malformed fields, an exceeded issue/page limit, an unknown author association,
  or an incomplete response fail the entire refresh closed. Partial records are
  never ranked as if missing values were zero.

## Ownership and staged delivery

H1-H3 own dedicated issue retrieval, normalization and ranking modules plus
their tests and this document. They do not edit the Store, runner, shared web
shell, package files or CI. H4 waits for G4 to release shared web files and will
record explicit trust decisions through the then-current storage owner.

H1 is complete when this policy and access inspection are committed. H2/H3 are
complete when dedicated tests prove normalized retrieval, deterministic reasons,
stable tie-breaking, trust classification, bounded failure, and stale versus
unavailable states, and `npm run typecheck` passes.

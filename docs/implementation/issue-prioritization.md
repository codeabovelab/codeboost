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

H1-H3 own dedicated issue retrieval, normalization and ranking modules plus
their tests and this document. They do not edit the Store, runner, shared web
shell, package files or CI. H4 waits for G4 to release shared web files and will
record explicit trust decisions through the then-current storage owner.

H1 is complete when this policy and access inspection are committed. H2/H3 are
complete when dedicated tests prove normalized retrieval, deterministic reasons,
stable tie-breaking, trust classification, bounded failure, and stale versus
unavailable states, and `npm run typecheck` passes.

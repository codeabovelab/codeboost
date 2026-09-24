# Manual real-issue assignment

This prerequisite exercise uses real issue [#10](https://github.com/codeabovelab/codeboost/issues/10) and merged [PR #17](https://github.com/codeabovelab/codeboost/pull/17). It is an attribution exercise, not a timed trial and not evidence for the go/no-go thresholds.

- Base: `5a2685cc709ca8f9f384e35e4d733012c7290d69`
- Head: `442147d1bc9a33edeca1a605c9de3ada13f397f1`
- Ledger setup: the squash commit was intentionally recorded as foreign so every resulting segment required an explicit manual assignment.
- Plan: P1 rename-reassignment regression, P2 literal-path regression, P3 evidence record, and P4 durable review rules.

| Plan item | Declared file | Assigned segments | Final attribution | Final scope |
|---|---|---:|---|---|
| P1 | `test/review.test.ts` | 4 text | Attributed | In scope |
| P2 | `test/plant.test.ts` | 4 text | Attributed | In scope |
| P3 | `docs/experiments/review-summary-edge-cases.md` | 1 file + 1 text | Attributed | In scope |
| P4 | `AGENTS.md` | 2 text | Attributed | In scope |

Codeboost exposed 12 segments before assignment, all in the Unplanned row. Each segment mapped to exactly one item through that item's declared file contract. After the assignments, the per-item segment counts were 4, 4, 2, and 2; all four rows reported `✓ Attributed` and `✓ In scope`. No segment was unclear or multiply owned, so this exercise produced no ambiguity fixture. The earlier rename and literal-path concerns already have focused fixtures in `test/review.test.ts` and `test/plant.test.ts`.

The assignment was rerun from a detached worktree at the exact head using a fresh SQLite review store. The stored choices, rather than a hand-written diff classification alone, produced the final attribution and scope results above. `manual-assignment.json` records every stable choice ID with its kind, operation, path, original row, assigned item, and final scope so the 12 assignments can be checked individually.

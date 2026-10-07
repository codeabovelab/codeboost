## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Review readiness

- Before requesting or re-requesting an automated Copilot review, self-review the full current diff, fix every issue found, and repeat the self-review and fix cycle until a complete pass finds no new issues. Re-run the relevant validation after fixes, then complete the mandatory independent-agent review loop below before requesting Copilot review.
- Each self-review and independent-agent review pass examines the full current PR diff against the base, including changed tests, configuration and documentation, and rereads every changed function in full. Do not review only the fixes or lines changed since the previous round. Code unchanged since the first commit of the PR still gets reviewed in every pass.
- Treat every behavioural claim the change makes, in code comments, the PR body or docs (for example "pauses every 1,000 entries", "settles only after exit", "never throws", "bounded by N seconds"), as something to verify. Trace each claim through every path that can break it, including nested loops, callbacks, error paths and early returns, and give it a test that fails if the claim is false.
- A test's setup must leave the state the production path would: if production never runs a step (such as a commit that refreshes Git's index), the test must not run it before the behaviour under test either.
- Independent-agent review is mandatory before every Copilot review request, including the first request and every re-request, for all changes, including documentation-only changes. The author's self-review is not a substitute. Use a reviewer that did not implement the change and does not share the author's working context: `/codex review`, a separate review agent, or `/code-review` at `high` effort or above.
- Repeat independent-agent review -> address findings -> re-run relevant validation -> independent-agent review until a complete pass on the latest head reports no new issues and no earlier valid findings remain unresolved. A pass that found issues is not clean merely because they were fixed afterward; the fixes require another independent full-diff pass. Do not stop after a fixed number of rounds.
- Only after that independent loop is clean may Copilot review be requested on the same reviewed and validated head. If Copilot finds issues, including summary-only concerns, address them and re-run relevant validation, then repeat the independent-agent review/fix loop until clean before requesting another Copilot review. Repeat this sequence until Copilot also completes a review with no new issues and no earlier valid findings remain unresolved. Never request Copilot in parallel with an unfinished independent-review cycle.
- A clean review applies only to its exact base/head pair. Any subsequent change, including documentation or review-lesson updates, rebases or base integration, invalidates that result. Complete the independent-agent review/fix loop and relevant validation again for the new pair before requesting Copilot.
- If an independent-agent or Copilot review cannot complete because of quota, timeout, tool failure or unavailability, report the blocked gate. A missing or incomplete review is not a clean result; do not bypass the independent-review prerequisite.
- Run final validation against the exact pushed head after the last change.
- Report current test counts separately from historical milestone counts.
- Before requesting automated Copilot review, report the current head, CI state, mergeability, unresolved threads, deferred follow-up issues, and the latest clean independent-agent review with its exact base/head pair.
- In evidence records, label cited commits as baselines, intermediate checkpoints, or validated heads. Keep final exact-head results in a place that can name the resulting commit, such as the PR body or CI record.
- Reproduce summary-only review concerns or turn them into a concrete follow-up issue. Do not repeatedly patch vague wording without a failure case.
- A validation fixture for a summary-only concern must assert the disputed intermediate representation or state before using a downstream outcome as evidence that the concern was exercised.
- For each self-review, independent-agent and Copilot round, record the review type and reviewer, exact base/head pair, findings, what changed, what was declined and why, and the regression evidence. Record the clean independent-agent pass that authorizes each Copilot request; re-requests must follow the same prerequisite.
- Treat review-lesson extraction as a merge gate. Before invoking merge, classify every review finding in the PR body as: covered by an existing rule (cite it), captured by a new rule in this branch (cite it), or one-off (record why). Do not merge until this audit is complete and every required `AGENTS.md` update is included in the reviewed head. Omit rules that merely repeat existing guidance.

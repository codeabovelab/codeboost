# Review rounds (#201)

**Status:** part 1 built (the review agent's prompt, answer and lane D command). Part 2 (the runner's round loop, the
Store, the merge blocker and the screen) is not built yet.
**Design:** [How codeboost runs a plan → Review rounds](../designs/codeboost-plan-indexed-review.md#how-codeboost-runs-a-plan).

## About this document

**Who it is for.** People who build or review the review rounds, and the agent that builds part 2.

**What it says.** How one review round asks the review agent for problems, what a valid answer is, how the answer is
recorded for tests, and the decisions part 2 builds to.

## What a review round does

After every plan item has run, codeboost reviews the finished code in rounds:

1. A separate review agent reads the code and checks each plan item against its intent and its `check:` entries. It can
   read but not edit.
2. codeboost runs every `cmd:` entry on the final code.
3. Each problem is filed against one plan item. A problem that spans several items becomes one problem per item.
4. One new `fix` invocation fixes each problem for its plan item. The fix commit carries that item's trailers.
5. The rounds stop when a round finds nothing, or after the round limit (default 3). The problems of the last round are
   not fixed: the task moves to **needs human** with them open.

## Part 1: the review agent

### The request

`prepareReview` (`core/review-prompt.ts`) builds one round's request from trusted runner data:

| Input | What it is |
|---|---|
| `round` | The round number, from 1 to `MAX_REVIEW_ROUNDS` (10). |
| `plan` | The approved plan revision that ran. |
| `head` | The full commit ID the agent reads: the head after the last item, or after the last round's fixes. |
| `changes` | For each plan item, the paths its commits changed. |
| `issue`, `approvedLessons` | Untrusted text, as in the execute prompt. |
| `earlierProblems` | The problems the previous round filed and a fix ran for, so the agent can say whether each fix worked. Round 1 has none. |

The template is `prompts/review.md`. Every input goes into an escaped JSON data block, filled in one pass, so inserted
text is never read as a placeholder or as a closing tag. The prompt is at most 32 KiB. Every round's prompt must also
leave room for the next round's earlier problems (`MAX_ROUND_PROBLEM_BYTES`, 12 KiB, plus that section's own text), so a
valid answer can never make the next round's prompt too large. A prompt without that room is refused at once.

### The answer

The answer schema is `prompts/review-answer.schema.json`. Lane D mounts it as the only input file and passes its exact
text to Claude as `--json-schema` ([agent isolation](agent-isolation.md), "Review answers"). The answer is one object:

- `round`: the round number from the request;
- `problems`: at most 20, each with `items` (the plan item IDs whose code must change), `summary` (300 characters),
  `detail` (1,500 characters), and `check` (the exact text of the `check:` entry it fails, or null).

`validate` refuses an answer that:

- is not strict JSON (a repeated key, an inexact integer), using the plan parser's rules;
- does not match the schema;
- is for another round;
- names an item that is not in the plan;
- holds text with NUL or an unpaired surrogate (the data blocks of later prompts refuse it);
- splits into problems that take more than 12 KiB as the next round's data block.

A valid answer becomes a list of `ReviewProblem`s, one per named item, in plan order. An item named twice in one problem
gets one copy. A copy keeps the `check` text only when it is exactly one of that item's own `check:` entries; otherwise
it is null. An empty list means the round found nothing.

### The invocation

The review agent is Claude in lane D's read-only `review` phase: read, list and search tools, `plan` permission mode, no
commands, vendor-only egress. It shares planning's model budget: 64 KiB of prompt and schema, and `--max-turns 50`.
Codex is refused, as in every phase (#93). `reviewOutput` (`runner/review-agent.ts`) accepts only the invocation's own
output after a clean exit.

`REVIEW_FEATURE` runs a review as a read-only run outside the runner, for the recording script and the Docker test. In
part 2 the runner starts review attempts through its coordinator instead, so stops, shutdown and recovery apply.

### Recorded output

`scripts/record-review.ts` records two real Claude answers on a fixed finished task (`test/fixtures/review/recording-inputs.ts`):
round 1, and round 2 with round 1's problem listed as earlier. The task's second plan item has a planted defect (its
test calls `label(3)` once). To record, run this with your own token and Docker:

```bash
CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-review.ts
```

Read each file in `test/fixtures/review/recorded/` before committing it. `test/review-recorded.test.ts` replays them:

- each recording must match today's files, prompt, schema and exact Claude argv, by hash; a change to any of them means
  recording again;
- each output must pass `validate`, and must file a problem against P2.

`test/agent-review.test.ts` runs a review in a real container with an invalid token: only a request that reached the
vendor comes back with its 401. The unit tests (`test/agent-policy.test.ts`, `test/agent-adapter.test.ts`,
`test/review-prompt.test.ts`) check that the review command carries the schema.

## Part 2 decisions (approved 2026-10-23)

- **Where problems are stored.** Schema v20 adds `review_rounds` (round, revision, head, state) and `review_problems`
  (round, plan item, source `agent` or `check`, summary, detail, state `open`, `fixed` or `accepted`, the fix attempt). A round's agent
  problems are written in the terminal write that completes its review attempt; `cmd:` failures in the check attempt's
  terminal write. So a crash never loses a round or repeats one.
- **One review attempt per round** covers every plan item. `cmd:` failures are filed against each item that lists the
  command, through the existing `check` attempt on the final head.
- **One `fix` attempt per problem**, using the execute prompt's fix mode, with the same file-scope audit, trailers and
  ledger entry as execute.
- **The round limit** is `runner.reviewRounds` in the runner block, from 1 to 10, default 3. Problems found by the last
  round are not fixed.
- **A review answer that fails validation, or a failed review attempt,** moves the task to needs human. Nothing retries
  on its own.
- **"Accepted"** is a user action (`accept-problem`) that raises the review version and records a feedback event. The
  merge gate blocks on open problems that are not accepted.
- **Ordering.** Rounds run inside the same run as the plan items, so publishing waits for them.

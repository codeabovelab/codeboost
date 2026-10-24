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

1. A separate review agent reads the code and what the plan changed, and checks each plan item against its intent and
   its `check:` entries. It reports any change no item's intent covers, such as an unrelated edit in a declared file.
   It can read but not edit.
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
| `base`, `diffs` | The commit the plan's first item started from, and every file that differs between it and `head`, in path order, with its `git diff` text. `reviewDiffs` (`runner/review-diffs.ts`) makes them with hardened Git: no system or global config, hooks, external diff or text conversion programs, and `--text`, so an in-tree attribute the agent wrote cannot hide a diff. Each file's diff uses pathspecs that match only that file, so a file replaced by a directory, or a file whose type changed, shows exactly its own change. A renamed file is listed by its new path and shown as its rename and its edits; a rename into a directory of its own name excludes the other changed files there by name, and gets a null diff if their names pass 64 KiB. A name keeps a leading byte-order mark, and its Unicode form: Git's `core.precomposeunicode`, which `git init` sets on macOS, is turned off for these calls. An empty diff for a listed file is null. A stop kills Git and returns only once Git has exited. Submodule (gitlink) changes are left out, as Git stays out of submodules. A diff is null where the prompt cannot carry it: binary or not UTF-8, longer than a data block's 32 KiB string, or after the paths before it alone already fill a whole prompt (those are not read, so at most a few thousand diffs are; the prompt can still list such a file, with a null diff). The agent reads such a file instead. The agent cannot run Git, so the diffs are how it sees what each item changed. |
| `issue`, `approvedLessons` | Untrusted text, as in the execute prompt. |
| `earlierProblems` | The problems the review agent filed in the previous round and a fix ran for, so the agent can say whether each fix worked. `prepareReview` refuses them in round 1, and any from another round. Part 2 passes only the agent's problems: failed `cmd:` checks are left out, because the agent cannot run commands and the next round runs the checks again. |

The template is `prompts/review.md`. Every input goes into an escaped JSON data block, filled in one pass, so inserted
text is never read as a placeholder or as a closing tag. The prompt is at most `MAX_REVIEW_PROMPT_BYTES`: the review's
64 KiB model budget less its schema. The plan block may use all of it; the issue, lessons and earlier-problems blocks are
at most 32 KiB each.

The plan's items, intents, files and checks, and the base commit, always go in: without them there is nothing to review. Each of the rest
goes in if it still fits, tried in this order (a part that does not fit is skipped, and the later ones are still
tried):

1. the text of each file change in the plan;
2. the changed files' diffs, in path order: the longest run of whole diffs that fits, then each later file whole, or
   with a null diff, wherever it still fits, so one large diff cannot push every smaller one after it out
   (`request.diffsListed` counts the files listed); the agent reads any other changed file at the head;
3. the previous round's problems, as many as fit, in order (`request.earlierListed`): they are a hint, and the agent
   checks every item anyway;
4. the issue's description;
5. the approved lessons;
6. the issue's comments.

codeboost's own note in the prompt names whatever was left out: the smallest prompt the budget must hold includes every
note, with the earlier-problems note for the most problems a round can give. `request.leftOut` lists the parts left out, and `request.earlierListed` counts the earlier problems listed.
Room is kept from round 1 on for the longest round number, the earlier-problems note, the diffs' note (its text is
fixed, as the number of changed files can change between rounds), the issue's title at GitHub's
256 characters escaped at their longest, and the notes of the issue's description, of its comments (for the 1,000 the
issue loader reads at most) and of the lessons. So every later round of the same plan fits whenever round 1 did, even
if the title was changed, a description written, comments posted or lessons approved in between. A later round refuses
only a prompt that does not fit without the reserve, which this room makes impossible for an issue GitHub can hold. The title's room relies on GitHub's 256-character limit: the issue loader itself accepts titles up to 4,096 characters, so a longer title from another source could still make a later round refuse. So an answer is never refused for its size: any valid answer can be the next round's earlier problems. Text
that no data block can hold (NUL, an unpaired surrogate) is refused wherever it is, whether or not it would fit. Part 2
starts a new plan revision again at round 1, with no earlier problems.

**Known limit.** A plan too large to fit even without its change texts (with the issue's number and title, the
prompt's own text and the room for the notes) cannot be reviewed in one prompt, and `prepareReview` refuses it. The plan schema allows such a plan (30 items, each with 10 checks of up to 400
characters). Part 2 then moves the task to needs human, after the plan's items have run. Reviewing such a plan in
batches of items, or checking that it can be reviewed before its items run, is follow-up #209.

The prompt goes to Claude as one command argument, as planning's does. At most about 62 KiB, it is under Linux's 128 KiB
limit for one argument. This is an exception to the AGENTS.md rule that input-sized text goes on stdin. It is safe while the budget holds the prompt under that limit, which a test checks, and NUL is refused first. Follow-up #210 moves every Claude prompt to stdin.

### The answer

The answer schema is `prompts/review-answer.schema.json`. Lane D mounts it as the only input file and passes its exact
text to Claude as `--json-schema` ([agent isolation](agent-isolation.md), "Review answers"). The answer is one object:

- `round`: the round number from the request;
- `problems`: at most 10 (the prompt asks for the 10 that matter most), each with `items` (at most 10 plan item IDs
  whose code must change), `summary` (300 characters), `detail` (1,500 characters), and `check` (the exact text of the
  `check:` entry it fails, or null). So one round files at most 100 problems, one per item named; part 2 runs one fix
  for each, within the task's time limit.

`validate` refuses an answer that:

- is not strict JSON (a repeated key, an inexact integer), using the plan parser's rules;
- does not match the schema;
- is for another round;
- names an item that is not in the plan;
- holds text with NUL or an unpaired surrogate (the data blocks of later prompts refuse it), or a summary or detail that
  is only white space.

`validateReviewAnswer(plan, round, source)` does the same check without the rest of the request, so an answer can be
checked again without rebuilding its prompt.

A valid answer becomes a list of `ReviewProblem`s: for each problem in the answer's order, one copy per named item, in
plan order. An item named twice in one problem gets one copy, and so does the same problem given twice for one item. A copy keeps the `check` text only when it is exactly one of that item's own `check:` entries; otherwise
it is null. An empty list means the round found nothing.

### The invocation

The review agent is Claude in lane D's read-only `review` phase: read, list and search tools, `plan` permission mode, and
vendor-only egress. It runs no commands: the Claude command gives it only `Read,Glob,Grep` and disallows Bash, and it is
refused for a review captured with approved argv. (The review phase's policy also lists the runner's command tool, for
command checks; Claude is not given it.) It shares planning's model budget: 64 KiB of prompt and schema, and `--max-turns 50`.
Codex is refused, as in every phase (#93). `reviewOutput` (`runner/review-agent.ts`) accepts only the invocation's own
output after a clean exit.

`REVIEW_FEATURE` runs a review as a read-only run outside the runner, for the recording script and the Docker test. In
part 2 the runner starts review attempts through its coordinator instead, so stops, shutdown and recovery apply. Their
launcher must mount the review answer schema: the execute launcher's plain-text schema is refused for a review.

### Recorded output

`scripts/record-review.ts` records two real Claude answers on a fixed finished task
(`test/fixtures/review/recording-inputs.ts`): round 1, and round 2 with a hand-written earlier problem
(`REVIEW_RECORDING_EARLIER`) like the one round 1 should find. `buildReviewRecordingRepository` commits the code before
the plan and then after it, with a fixed Git identity and dates, so the commits and diffs are the same on every run.
The task has two planted defects:

- the second plan item's test calls `label(3)` once;
- the first item's commit also weakens `isLabelled()`, which no item asked for. Only a review that reads the diffs can
  see that.

To record, run this with your own token and Docker:

```bash
CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-review.ts
```

Read each file in `test/fixtures/review/recorded/` before committing it. `test/review-recorded.test.ts` replays them:

- each recording must match today's files, prompt, schema and exact Claude argv, by hash; a change to any of them means
  recording again;
- the repository made again must give the recorded base and head commits;
- each output must pass `validate`, must file a problem against P2, and must file one against P1 naming
  `isLabelled`.

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

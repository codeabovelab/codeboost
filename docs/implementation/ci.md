# Continuous integration

This page describes which GitHub Actions workflows run which tests, and when. It
also lists the settings that only a repository administrator can make. These
settings are not stored in the repository.

## Workflows

| Workflow file | Job (check name) | Runs on | What it runs |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | `test` | every pull request; pushes to `main` and `codex/**` | Type check; every Vitest file except the Docker-backed files; the Playwright browser suite |
| `.github/workflows/agent-isolation.yml` | `real-docker` | every pull request; pushes to `main` and `codex/**` | Type check; the complete Vitest suite against real Docker |
| `.github/workflows/live-probes.yml` | `live-probes` | started by hand (`workflow_dispatch`); every night at 06:23 UTC | The four live Claude startup probes only |

`test` and `real-docker` have no path filters. They run on every pull request,
so both can be required checks. A required check that a path filter skips
never reports, and GitHub then blocks the merge.

### `test`

`test` runs the Vitest files that do not need Docker, and then the browser
suite (`npm run test:browser`). It excludes the Docker-backed files with
`--exclude`. The Docker-backed files are the `dockerTests` list in
`vitest.config.ts`. The excludes must equal that list:
`test/vitest-config.test.ts` fails if they differ.

When a test file starts to use Docker, add it to `dockerTests` in
`vitest.config.ts`, to `DOCKER_TESTS` in `test/vitest-config.test.ts` and to the
excludes in `ci.yml`.

`test/agent-adapter.test.ts` runs in `test`. It does not start Docker or a
vendor CLI: its cases test parsers and budgets, or refuse a request before
anything is allocated. It passes with no Docker binary on `PATH`.

### `real-docker`

`real-docker` runs `npm test` with no excludes. `vitest.config.ts` runs the
ordinary files first. Then it runs the Docker-backed files one at a time,
because they share one image tag and one Docker daemon. This job is the T9
Docker gate. [Agent isolation](agent-isolation.md#what-the-gate-proves) lists
what it proves.

### Recorded outputs and the hostile-issue eval

These files are ordinary Vitest files, so both `test` and `real-docker` run
them. They do not call a vendor or GitHub.

- Recorded Claude planning output: `test/fixtures/planning/recorded/`, replayed
  by `test/planning-recorded.test.ts`.
- GitHub (`gh`) responses: fixtures inside `test/merge.test.ts` and the other
  merge and publishing tests.
- Hostile issue texts: `test/fixtures/hostile-issues.json`, used by
  `test/execution-prompt.test.ts`.

### `live-probes`

The live probes call the real Claude service. They are not a pull request
check, and they do not run on a pull request or a push. GitHub runs scheduled
workflows only from the default branch, so the nightly run starts after this
workflow is on `main`.

The job:

1. Fails at once if the repository secret `CLAUDE_CODE_OAUTH_TOKEN` is empty or
   missing. A missing secret never gives a passing run.
2. Runs the Docker Vitest project with `CODEBOOST_RUN_AUTH_PROBES=1`. It selects
   only the tests whose titles end in `(live Claude)`, in
   `test/agent-container.test.ts`, `test/agent-question.test.ts` and
   `test/agent-supervisor.test.ts`. The files run one at a time.
3. Runs `node scripts/live-probes.ts check` on the Vitest JSON report. Vitest
   exits with success when it skips every test, so this step fails unless each
   probe listed in `scripts/live-probes.ts` passed and no other test ran.

If you add, rename or remove a probe, or rename a `describe` block around one,
update `LIVE_PROBES` in `scripts/live-probes.ts`. `test/vitest-config.test.ts`
parses each probe file. It fails unless the tests that
`CODEBOOST_RUN_AUTH_PROBES` enables have exactly the full names in the list: the
`describe` titles and the test title, joined with spaces, as Vitest names them.
The switch may only be the condition of an `if` block that holds only tests and
declarations, or of `it.runIf`. Any other use fails the test.

Codex has no probe, because Codex is refused in every phase (#93).

## Settings for a repository administrator

The repository cannot make these settings itself.

1. **Required checks on `main`.** In the branch protection rule or ruleset for
   `main`, require the status checks `test` and `real-docker`. Do not require
   `live-probes`.
2. **Live probe secret.** Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN`
   (Settings, then Secrets and variables, then Actions). Make the token with
   `claude setup-token`. Until the secret exists, every `live-probes` run fails
   at its first step.

Never put a token in an issue, a pull request, a commit or chat.

## Record the planning fixtures again

`test/planning-recorded.test.ts` fails when a recording no longer matches
today's request: for example, when the prompt, the schema, the Claude command,
the image tag or the CLI version changes. To record again, run this on a
machine with Docker:

```sh
CODEBOOST_RUN_AUTH_PROBES=1 CLAUDE_CODE_OAUTH_TOKEN=... node scripts/record-planning.ts
```

Read each file in `test/fixtures/planning/recorded/` before you commit it. No
workflow records fixtures. [Planning acceptance](planning-acceptance.md#recorded-vendor-output)
describes the recordings.

## Run the same checks locally

```sh
npm run typecheck
npm test                              # all Vitest files; needs Docker
npx vitest run --project parallel     # only the files that do not need Docker
npx vitest run --project docker       # only the Docker-backed files
npm run test:browser
```

To run the live probes locally, set `CODEBOOST_RUN_AUTH_PROBES=1` and
`CLAUDE_CODE_OAUTH_TOKEN`, then run the `vitest` command from
`live-probes.yml`.

## What remains before T9 is complete

T9 in the [plan](../designs/codeboost-plan-indexed-review.md) stays open until
all of these are true:

1. A repository administrator requires `test` and `real-docker` on `main`.
2. Both required jobs pass on the same head after this setup is merged.
3. The `CLAUDE_CODE_OAUTH_TOKEN` secret exists and a `live-probes` run passes.

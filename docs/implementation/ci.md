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

A check takes its name from the job id, or from the job's `name` when it has
one, and a matrix adds its values to the name. So do not rename the `test` or
`real-docker` job, and do not give either one a `name` or a `strategy` (matrix):
the required check would then never report, and no pull request could merge.
`test/vitest-config.test.ts` fails if either job has any key other than
`runs-on`, `timeout-minutes` and `steps`, or if either workflow has another
job. It also fails if a workflow has a top-level key other than the ones it has
now (`name`, `on`, `permissions`, and `concurrency` in `live-probes.yml`
only), so no workflow can add `defaults` or `env` for every job.

The test pins each job's steps exactly, in this order, including each step's
`run` text. It also runs the `live-probes` token check with an empty, a missing
and a set token.

| Job | Steps |
| --- | --- |
| `test` | `actions/checkout@v4`; `actions/setup-node@v4` with Node 26.7.0 and the npm cache; `npm ci --ignore-scripts`; `npm run typecheck`; `npm test` with one `--exclude` for each Docker-backed file; `npx playwright install --with-deps chromium`; `npm run test:browser` |
| `real-docker` | `actions/checkout@v4`; `actions/setup-node@v4` with Node 26.7.0 and the npm cache; `npm ci --ignore-scripts`; `npm run typecheck`; `npm test` |
| `live-probes` | the token check; `actions/checkout@v4`; `actions/setup-node@v4` with Node 26.7.0 and the npm cache; `npm ci --ignore-scripts`; the live probe Vitest run; `node scripts/live-probes.ts check live-probes.json` |

The `live-probes` job also may have only the keys `runs-on`,
`timeout-minutes` and `steps`, so it has no `defaults`, `env` or `strategy`.

### `test`

`test` runs the Vitest files that do not need Docker, and then the browser
suite (`npm run test:browser`). Its time limit is 45 minutes; its longest
recent run took 20 minutes. It excludes the Docker-backed files with
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
because they share one image tag and one Docker daemon. `test/vitest-config.test.ts`
pins the whole of `vitest.config.ts`, so it fails if either project gets any
other key, such as an `exclude`, `testNamePattern` or `passWithNoTests` that
could drop files or tests from both jobs. This job is the T9
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
workflow is on `main`. The repository is public, so GitHub disables this
scheduled workflow after 60 days without repository activity. To turn it on
again, open the Actions tab, select the `Live probes` workflow and select
**Enable workflow**.

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

`test/vitest-config.test.ts` fails if the `live-probes` job, or the `test` job
in `ci.yml` or the `real-docker` job in `agent-isolation.yml`, or any step of
these jobs, has an `if` condition or `continue-on-error`. Either one could skip
a step or let it fail while the job passes.

If you add, rename or remove a probe, or rename a `describe` block around one,
update `LIVE_PROBES` in `scripts/live-probes.ts`. `test/vitest-config.test.ts`
parses each probe file. It fails unless the tests that
`CODEBOOST_RUN_AUTH_PROBES` enables have exactly the full names in the list: the
`describe` titles and the test title, joined with spaces, as Vitest names them.
Every `it`, `test` and `describe` call in a probe file must have a string
literal or a template literal without expressions as its title, or the test
fails. So the test sees every title, and fails if a test that the switch does
not enable has a title that ends with the marker. Each `describe` around a
gated test, and each gated `it` or `test` call, must have exactly a literal
title, a function expression and optionally a numeric timeout.
`describe.each`, `describe.for`, `describe.skip` or any other modifier, or an
options object such as `{ skip: true }`, makes the test fail.
The switch may only be the condition of an `if` block without `else`, or of
`it.runIf`. Each statement in such an `if` block must be a plain `it` or `test`
call, or a `const` or `let` declaration of plain names. Each
name must have a plain value: a function expression, or a constant. A constant
is a string, number or boolean literal, a template literal whose expressions are
constants, or a binary operation on constants. Any other value, such as a call
or an assignment like `(on = true)`, makes the test fail, and so does a `var`,
because it is visible outside the block. Such a gate must be where Vitest always
registers tests as it loads the file: a statement directly in the body of the
file, or directly in the body of a `describe` callback that is itself such a
statement. A gate inside any other block or expression, such as another `if`, a
loop or a helper that is never called, makes the test fail. The test counts every occurrence of the name
`CODEBOOST_RUN_AUTH_PROBES` in each probe file's text, comments and strings
included, and fails unless each one is such a gate. It also fails if any other
source file under `test/` names the switch: any `.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.mjs` or `.cjs` file, helpers and fixtures included, except
`test/vitest-config.test.ts` itself. It
cannot catch a variable name built at runtime from pieces, such as
`process.env['CODEBOOST_' + 'RUN_AUTH_PROBES']`.

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

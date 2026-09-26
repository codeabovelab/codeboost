# D5 agent isolation gate

This page describes the combined gate for lane D. The gate is the set of real-Docker
tests that must pass before lanes F and G may run agents in production. It also
states what those lanes must do when they call the isolation boundary.

## Run the gate

The gate needs a running Docker daemon. Run the suites one file at a time, because
they share one image tag and one daemon:

```bash
npx vitest run --no-file-parallelism test/agent-contract.test.ts test/agent-clone.test.ts test/agent-container.test.ts test/agent-network.test.ts test/agent-policy.test.ts test/agent-proxy.test.ts test/agent-adapter.test.ts test/agent-supervisor.test.ts test/agent-output.test.ts test/agent-gate.test.ts test/agent-question.test.ts
```

The `Agent isolation` workflow runs the same command. The main `CI` workflow skips
the Docker suites so that they never run in parallel.

The live vendor probes need real credentials, so CI does not run them. To run them,
set `CODEBOOST_RUN_AUTH_PROBES=1`, `CODEBOOST_CODEX_AUTH_FILE` (a Codex `auth.json`
path) and `CLAUDE_CODE_OAUTH_TOKEN`. Do not put credentials in an issue, a pull
request or chat.

## What the gate proves

Each row is a T9 requirement for the Docker suite. The suite fails if any row fails.

| Requirement | Tests |
| --- | --- |
| Isolation holds: non-root, no capabilities, read-only root, no host paths or secrets, vendor-only egress | `agent-container`: read-only isolation, lockdown and mount validation; `agent-network`: egress and DNS |
| A read-only phase cannot write `/work` | `agent-container`: phase worktree for all five phases |
| Planning and questions cannot run a process | `agent-policy`: tool sets exclude the command tool, and command dispatch refuses these phases |
| Task and scratch byte and inode limits hold | `agent-container`: task capacity; scratch capacity for Codex and Claude (`/tmp`, `HOME`, `CODEX_HOME`, output directory) |
| Hard links and alias writes from `.git/config` and objects fail, and metadata stays unchanged | `agent-container`: metadata alias probe in planning, review and execute, with a digest of `.git` before and after |
| Mountpoint replacement fails | `agent-container`: metadata and metadata alias probes (`mv` and `rm -rf` of `.git`) |
| Both vendor startup probes read the schema and return bounded valid output through their documented channel | `agent-supervisor` live probes: Codex through its output file, Claude through its stdout envelope (credentials required) |
| Hostile input stays inside the boundary | `agent-container`: repositories with links that leave the checkout are refused, links inside the checkout still work, oversized repositories fail closed; `agent-policy`: option-like prompts; `agent-proxy`: hostile CONNECT traffic; `agent-supervisor`: hostile output |

## Why the gate can fail

A test that cannot fail proves nothing. `agent-gate` runs each negative probe from
production in a container that is missing one protection. It then checks that the
probe reports that exact breach. The cases include writable Git metadata, a writable
worktree in each read-only phase, task and scratch areas without a byte or an inode
limit, the Codex-only scratch areas, a writable control directory, and repository
links or secret content in the worktree.

A probe also discards the output of any forbidden command it tries. So a breach that
succeeds, such as reading a file through a link, cannot copy data into the output.

Probe scripts must use the `deny` helper for actions that must fail. Do not write
`! command` in a probe: `set -e` ignores a negated command, so the probe would
continue and report success even when the forbidden action worked. Before D5, the
metadata, read-only isolation and capacity probes had this defect.

## Handoff to lanes F and G

Use only these entry points to run an agent:

1. `createTaskClone` creates a committed, standalone staging clone.
2. `prepareTaskFilesystems` copies that clone into bounded task storage. Call
   `removeTaskFilesystems` when the task ends. It refuses a repository that has a
   symbolic link with an absolute target or a target outside the checkout, before it
   creates any storage. Report this to the user as a repository the agent cannot run
   on; do not retry it.
3. `captureInvocation` freezes the request. Capture each attempt ID once. A new
   attempt needs a new attempt ID.
4. `startCodexInvocation` or `startClaudeInvocation` runs the agent and returns a
   handle. Pass the vendor credential only as the function argument.

The boundary guarantees the following:

- The profile is immutable, and every launch revalidates it against Docker.
- Tools are limited by phase. Planning and questions can only read, list and search.
- Web search and MCP are off, stdin is closed, and network traffic reaches only the
  vendor hosts.
- Output is bounded and decoded as strict UTF-8. Invalid output fails as
  `capture-failure`.
- The invocation deadline bounds every launch. Cleanup still runs after the deadline.

The caller must do the following:

- Keep ownership until `settled` resolves. It resolves only after the container has
  stopped and its cleanup has finished. The supervisor retries cleanup until then.
- Call `cancel` to stop an invocation. The first stop reason is kept.
- Treat `stopReason` as the result of the invocation. A missing `stopReason` means
  the agent finished normally.

## First consumer: Ask

Ask (`runner/question-container.ts`) is the first production caller. It follows the four entry points above in the
"questions" phase with no approved commands, clones the reviewed snapshot head, and writes a fixed answer schema as the
only input file. Because every entry point above is synchronous, a worker thread (`runner/question-worker.ts`) owns the
image, clones and allocations, so the review server keeps serving while Docker and Git run. The worker settles a
question only after the invocation settles and its storage is removed.

Ask keeps the contract's identity and cleanup rules:

- The invocation's `attemptId` is the answer attempt that `Questions` saved, and `referencedCodeHash` is the note's
  `contextId` (the hash of the code assigned to its plan item). An answer is accepted only when the result and the
  worker reply carry that attempt and the captured context. The Store then compares the attempt before saving it.
- Output counts as an answer only with exit code 0 and no signal. A missing exit code or a signal is a failure.
- If Docker does not confirm storage removal, the worker keeps the allocation, retries removal before the next
  question, and refuses Ask while any removal is unconfirmed.
- At shutdown the worker makes one last removal attempt (bounded to 30 seconds) before it is terminated. It reports
  anything still unremoved, and codeboost writes those names to `<database>.ask-leftovers.json`. After a restart,
  Ask stays off while any recorded container or volume still exists (a read-only `docker inspect` check). The
  refusal shows the `docker rm`/`docker volume rm` commands, and the record clears itself once they are gone. An
  unreadable record, or a Docker daemon that cannot answer, keeps Ask off. Removal goes through D only once D has
  recovery handles (#51 item 4).
- If the worker itself crashes, its containers and storage may still exist. The bridge does not start a
  replacement worker; Ask stays off until codeboost restarts. Reclaiming those leftovers after a crash or restart
  needs lane D's labelled resources and scoped recovery (#51, item 4), which do not exist yet.

`test/agent-question.test.ts` runs this path
against real Docker; its live case, like the vendor probes above, needs `CODEBOOST_RUN_AUTH_PROBES=1` and
`CLAUDE_CODE_OAUTH_TOKEN`.

## Limits of this gate

- CI does not run the live vendor probes. Run them locally with credentials before
  a release that changes the image, the adapters or the prompts.
- T9 as a whole is complete only when lane F runs every suite in required CI (F6).

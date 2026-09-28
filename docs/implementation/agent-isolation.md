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
2. `prepareTaskFilesystems` copies that clone into bounded task storage, labelled with the owner you pass: your
   runner token, the attempt ID, and an allocation ID (a lowercase UUID v4) you record first. Use each allocation
   ID once: before creating anything, D refuses an ID that another allocation in this process holds, or that any
   container, volume or network still carries (so a reuse after a restart is caught too). That check and the first
   create are not atomic, so right after its first create D checks again that its object is the only one with the ID;
   if not, it removes what it made and refuses. Cleanup removes an object only if all three owner labels match. Call
   `removeTaskFilesystems` when the task ends. It refuses a repository that has a
   symbolic link with an absolute target or a target outside the checkout, before it
   creates any storage. Report this to the user as a repository the agent cannot run
   on; do not retry it.
3. `captureInvocation` freezes the request. Capture each attempt ID once. A new
   attempt needs a new attempt ID.
4. `startCodexInvocation` or `startClaudeInvocation` returns a handle at once and runs
   the Docker setup and the agent inside it. It throws only when it allocated nothing
   (invalid input, an expired budget, or an attempt ID that is still owned); every
   later failure settles the handle. `cancel()` during setup kills the in-flight Docker
   call. The request carries `networkAllocationId`, a UUID you choose for the vendor network. Pass the vendor
   credential only as the function argument.

The boundary guarantees the following:

- The profile is immutable, and every launch revalidates it against Docker.
- Tools are limited by phase. Planning and questions can only read, list and search.
- Web search and MCP are off, stdin is closed, and network traffic reaches only the
  vendor hosts.
- Output is bounded and decoded as strict UTF-8. Invalid output fails as
  `capture-failure`.
- The invocation deadline bounds every launch. Cleanup still runs after the deadline.

The caller must do the following:

- Keep ownership until `settled` resolves. It resolves after the container has
  stopped and its cleanup has finished. If cleanup keeps failing, the supervisor retries it every second for
  60 seconds after the first failure, then settles anyway. Retries after the first get only what is left of
  the window, and each cleanup subprocess is killed at its deadline. That result has a `stopReason` and lists
  the resources it could not confirm removed in `unreleased`; the container may still be running. Worst case,
  settlement ends about 90 seconds after cleanup starts: up to 30 seconds for the first, failed attempt, then
  the 60-second window. Cleanup retries are asynchronous Docker calls (#51 item 2), so the event loop stays free
  and a cancel or shutdown is handled while a retry runs; the window bounds the total wait.
- Every Docker setup failure settles the start call's handle rather than throwing (#51 item 2). If profile creation
  fails and its own cleanup fails too, that handle keeps retrying the cleanup and settles with `capture-failure`
  (plus `unreleased` if the window ends), so callers must not rely on a throw for this case.
- When `unreleased` is present, record those resources durably and keep them owned until their removal is
  confirmed. Each Docker entry has its creation-time ID (when known) and its ownership labels (`labels`: runner,
  attempt, allocation, and `io.codeboost.invocation` or `io.codeboost.egress`); remove one only if all still match. An object is listed only if this invocation created it or may have (its create succeeded,
  or its client was killed before the daemon answered). A create the daemon refused, for example because another
  invocation holds the name, made nothing, so that name is never reported or touched. The egress proxy is created
  and started as two steps for this reason. Directory entries are host paths under the caller's `TMPDIR`.
- A profile that settled with `unreleased` is retired: every launch path (`startProfileInvocation`,
  `createValidatedContainer`, `startValidatedContainer`, `runContainer`) refuses it, while its cleanup still runs.
- Call `cancel` to stop an invocation. The first stop reason is kept.
- Treat `stopReason` as the result of the invocation. A missing `stopReason` means
  the agent finished normally.

## First consumer: Ask

Ask (`runner/question-container.ts`) is the first production caller. It follows the four entry points above in the
"questions" phase with no approved commands, clones the reviewed snapshot head, and writes a fixed answer schema as the
only input file. Because the image build, the clone and storage allocation are still synchronous (#51 item 5), a worker thread
(`runner/question-worker.ts`) owns the image, clones and allocations, so the review server keeps serving while Docker
and Git run. The adapters' start calls are asynchronous (#51 item 2). The worker settles a
question only after the invocation settles and its storage is removed.

Ask keeps the contract's identity and cleanup rules:

- The invocation's `attemptId` is the answer attempt that `Questions` saved, and `referencedCodeHash` is the note's
  `contextId` (the hash of the code assigned to its plan item). An answer is accepted only when the result and the
  worker reply carry that attempt and the captured context. The Store then compares the attempt before saving it.
- The worker's environment is an allowlist: `PATH`, `DOCKER_HOST` and its Ask root as `TMPDIR`. Every setup
  subprocess, including the image build, inherits only that, so no credential, home directory, Docker config or
  agent socket reaches it. The credential lookup's own variables (`CLAUDE_CODE_OAUTH_TOKEN`,
  `CODEBOOST_CODEX_AUTH_FILE`, `CODEX_HOME`, `HOME`) reach the worker as data and go only to the adapters. The
  leftover Docker queries use the same `PATH`/`DOCKER_HOST` environment as lane D. Missing sign-in is reported
  before any Docker work.
- Lane D's clone is a full host copy with no byte limit of its own. Before cloning, Ask measures the checkout at the
  reviewed head (`git ls-tree -r -t -l`) and the object store (`git count-objects -v`) and refuses a repository
  that would not fit the question's 512 MiB and 131,072-entry allocation. A bounded, D-owned clone would replace
  this check.
- The stop reason (timeout, shutdown or cancellation) travels as a typed value (`StopError`) from `Questions`
  through the worker message to `handle.cancel()`, separate from the message shown to the user.
- Output counts as an answer only with exit code 0 and no signal. A missing exit code or a signal is a failure.
- If Docker does not confirm storage removal, the worker keeps the allocation, retries removal before the next
  question, and refuses Ask while any removal is unconfirmed.
- At shutdown the worker makes one last removal attempt (bounded to 30 seconds) before it is terminated. It reports
  anything still unremoved, and codeboost writes those names to `<database>.ask-leftovers.json`. After a restart,
  Ask stays off while any recorded container or volume still exists. The check is read-only label queries
  (`docker ps`, `docker volume ls` and `docker network ls` for `io.codeboost.allocation`, `io.codeboost.invocation`
  and `io.codeboost.egress`) with one 15-second limit, and the question can cancel it. The refusal shows
  `docker rm`/`docker volume rm` commands for exactly the resources that remain, and the record clears itself once
  they are gone. An unreadable record, a Docker daemon that cannot answer in time, or a worker that does not report
  at shutdown keeps Ask off. Allocations beyond the record's cap of 100 count as unidentified, never dropped; Ask
  roots are never dropped, and recording one past the cap is refused. Any labelled resource that is not part of a
  still-listed allocation keeps the unidentified marker until none remain. Removal goes through D only once D has
  recovery handles (#51 item 4).
- Host copies are owned through one Ask root per worker, `<tmp>/codeboost-ask-XXXXXX`. The bridge creates it and
  records it before the worker starts, and runs the worker with it as `TMPDIR`. So the reviewed clone, lane D's
  input directory and its Codex auth copy all land inside it. The root is deleted, read-only directories included,
  once the worker thread has stopped (clean shutdown, crash or abandon); if that fails, or the process is killed,
  the next check deletes it. Ask stays off while an earlier root remains. The record accepts only direct children
  of the real temp directory with that exact name.
- Each Ask root carries an `.owner` stamp naming its lock, written before the folder appears under its Ask name. The
  first check of a process also looks for `codeboost-ask-*` folders the record does not list, for example after the
  database was renamed and its record stayed behind. It deletes only folders this user owns whose stamp names a lock
  in the private lock directory and whose owner lock is free. It leaves folders whose owner is still running, and
  folders with a missing, malformed or foreign stamp, because Ask did not provably create those.
- If storage setup itself fails and D cannot confirm its own cleanup, D returns no handle and Ask cannot tell which
  resources were left. Ask stays off for the rest of the session, and the record counts the failure. After a
  restart, Ask stays off while any container, volume or network labelled `io.codeboost.allocation`,
  `io.codeboost.invocation` or `io.codeboost.egress` exists. Resources now carry caller-provided allocation IDs
  and runner labels (#51 item 3), but Ask does not yet use them to name its resources.
- One process at a time runs Ask for a review. The lock is an exclusive SQLite transaction on a lock file keyed by
  the database file's identity (device and inode), in a private directory (`<tmp>/codeboost-asklocks-<uid>`, mode
  0700, checked to be owned by you). A lock path that is a symlink is refused, never followed. It is an OS file lock that the operating
  system releases when its process ends, so every spelling and every later name of the database, including an
  atomic rename while a server runs, finds the same lock. It is taken before the scan and kept until the worker
  and any startup scan still in flight have finished. Only the holder scans, starts a worker or writes the
  record. The record itself is kept next to the database's canonical path (`realpath`), so relative,
absolute and symlinked spellings share them. A database with other hard links is refused. Separating different
  reviews that share one Docker daemon needs a per-database runner token: resources now carry runner labels
  (#51 item 3), but Ask labels them with a random per-session owner until F1d's token exists (#59).
- The first question of each process runs that scan even without a record, because a process killed before it
  could write one leaves no record. Until Ask labels resources with a per-database runner token and filters its
  scan by it, another codeboost process running Ask at the same moment also keeps this one off.
- Lane D's settlement now ends within about 60 seconds of a cleanup failure (#51 item 1). A result with `unreleased` turns Ask off (it counts as untracked leftovers) until a restart finds no labelled resources. Ask's own abandonment path predates the bound and is unchanged. Abandonment happens once: a crash, a watchdog and shutdown all wait on
  the same bounded termination. A question not settled 30 seconds after its
  deadline, or still settling after the 20-second shutdown grace period, makes the bridge abandon the worker. It
  records unknown leftovers, waits up to 15 seconds for the worker thread to stop (a synchronous Docker or Git call
  finishes first), then rejects the waiting questions, so shutdown cannot hang on D. A worker that does not answer
  the final release request at shutdown goes through the same bounded path. If the thread is still busy
  after that wait, its ownership is already durable (unknown leftovers and the recorded root) and no new question is
  admitted; the root is deleted as soon as the thread stops. After any abandonment the review lock is kept until the
  process exits: Docker CLI children the thread started can outlive it and cannot be awaited until lane D exposes
  process groups (#51 item 5).
- If the worker itself crashes, its containers and storage may still exist. The bridge does not start a
  replacement worker, and it records the crash at once as unidentified leftovers. After a restart, Ask stays off
  while any container, volume or network labelled `io.codeboost.allocation`,
  `io.codeboost.invocation` or `io.codeboost.egress` exists. Reclaiming those leftovers after a crash or restart
  needs lane D's labelled resources and scoped recovery (#51, item 4), which do not exist yet.

`test/agent-question.test.ts` runs this path
against real Docker; its live case, like the vendor probes above, needs `CODEBOOST_RUN_AUTH_PROBES=1` and
`CLAUDE_CODE_OAUTH_TOKEN`.

## Limits of this gate

- CI does not run the live vendor probes. Run them locally with credentials before
  a release that changes the image, the adapters or the prompts.
- T9 as a whole is complete only when lane F runs every suite in required CI (F6).

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
| Codex does not run planning or questions, because it cannot read code there (see [Codex in read-only phases](#codex-in-read-only-phases)) | `agent-policy`: the Codex command refuses these phases; `agent-adapter`: the Codex start call refuses them and allocates nothing |
| A planning answer is checked against the mounted schema | `agent-policy`: only the Claude planning command passes `--json-schema`; `agent-container`: the profile refuses a command whose schema differs from the mounted file; `agent-adapter`: the answer is read from `structured_output` |
| Task and scratch byte and inode limits hold | `agent-container`: task capacity; scratch capacity for Codex and Claude (`/tmp`, `HOME`, `CODEX_HOME`, output directory) |
| Hard links and alias writes from `.git/config` and objects fail, and metadata stays unchanged | `agent-container`: metadata alias probe in planning, review and execute, with a digest of `.git` before and after |
| Mountpoint replacement fails | `agent-container`: metadata and metadata alias probes (`mv` and `rm -rf` of `.git`) |
| Both vendor startup probes read the schema and return bounded valid output through their documented channel | `agent-supervisor` live probes (credentials required): Codex in review through its output file; Claude in questions through its stdout envelope; Claude in planning returns a schema-constrained answer as bare JSON. **Known failure:** the Codex probes (here and in `agent-container`) fail, because Codex cannot read files in any phase (see [Codex in read-only phases](#codex-in-read-only-phases)). |
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

1. `createTaskClone` creates a committed, standalone staging clone. The runner uses `createTaskCloneAsync`, which
   takes an `AbortSignal` and reports each Git process group through `onProcessGroup` (#51 item 5).
2. `prepareTaskFilesystems` (or `prepareTaskFilesystemsAsync`, which takes `signal` and `onProcessGroup` in the same
   way) copies that clone into bounded task storage, labelled with the owner you pass: your
   runner token, the attempt ID, and an allocation ID (a lowercase UUID v4) you record first. Use each allocation
   ID once: before creating anything, D refuses an ID that another allocation in this process holds, or that any
   container, volume or network still carries (so a reuse after a restart is caught too). That check and the first
   create are not atomic, so right after its first create D checks again that its object is the only one with the ID;
   if not, it removes what it made and refuses. Cleanup removes an object by the ID captured at its create, even if
   its labels are wrong; an object found only by name (including task storage) must carry all three owner labels. Call
   `removeTaskFilesystems` when the task ends (`removeTaskFilesystemsAsync` from a server, which does the same removal
   without blocking the event loop). It refuses a repository that has a
   symbolic link with an absolute target or one that can lead outside the checkout (resolved in the container as its
   kernel would, even once the agent creates a missing directory on the way), or any link in its Git metadata; the
   seeder checks this and the allocation removes what it made, then throws an `UnusableRepositoryError`. Report
   this to the user as a repository the agent cannot run on; do not retry it.
3. `captureInvocation` freezes the request. Capture each attempt ID once. A new
   attempt needs a new attempt ID.
4. `startCodexInvocation` or `startClaudeInvocation` returns a handle at once and runs
   the Docker setup and the agent inside it. It throws only when it allocated nothing
   (invalid input, an expired budget, or an attempt ID that is still owned); every
   later failure settles the handle. `cancel()` during setup kills the in-flight Docker
   call. The request carries `networkAllocationId`, a UUID you choose for the vendor network. Pass the vendor
   credential only as the function argument.
   - **Planning answers.** Use `startClaudeInvocation` for planning. It reads `schema.json` from the input directory
     and passes its exact text to Claude as `--json-schema`. The container profile refuses the command if that text
     differs from the file it mounts. The result's `stdout` is Claude's `structured_output` object as JSON text, with
     no prose or Markdown around it. A Claude run that fails its own schema check settles with a nonzero exit code.
     Questions answer in plain text and carry no schema flag. The schema file must be a regular file with one link,
     at most 64 KiB of UTF-8, and a JSON object with `"type": "object"`; otherwise the start call throws. Leave out a
     draft 2020-12 `$schema` line: Claude's `--json-schema` rejects it (see [plan format](../plan-format.md)).
   - **Codex.** `startCodexInvocation` throws for planning and questions, and allocates nothing. See
     [Codex in read-only phases](#codex-in-read-only-phases).
5. To keep a stopped writable attempt's partial output, call `exportTaskDiff(storage, { base, imageId })` before
   `removeTaskFilesystems`. `base` is the full ID of the commit the storage was seeded from (the clone's head). For a
   recovery handle, also pass the `metadataBaseline` you recorded (step 6). It returns at most 1 MiB of diff
   (`truncated` says whether it was cut), and takes `signal` and a deadline for the Docker work.
   A changed file over 8 MiB, an untracked nested repository, a path Git will not add, an entry named `.git`, a fifo
   or socket, an ignored untracked path, a submodule directory with content, and a changed file whose `ident` or
   `working-tree-encoding` attribute changes what the diff shows each appear as a `codeboost:` notice line. When Git
   fails, the error carries Git's last two error lines.
6. To audit what a writable attempt changed (#66, `agents/container/changes.ts`):
   - **Record the baseline.** The storage value carries `metadataBaseline`, a digest of the metadata volume that the
     seeder takes as its last step. Record it with the allocation. `snapshotDeclaredLinks`, `inspectTaskChanges` and
     `exportTaskDiff` each check the metadata against it before running any Git command, and need it back
     (`metadataBaseline`) for a recovery handle.
   - **Before launch**, call `snapshotDeclaredLinks(storage, paths, { imageId })` with the item's declared paths.
     For each declared symlink it records where it resolves, one part at a time as the kernel would, and the state of
     the target and everything beneath it. A link on the way, a target that is a link, or a link inside a directory
     target shows as `through-link`. Do not launch an item with a `through-link` declared link: a write through it
     lands somewhere its target does not cover. Keep the result.
   - **After the handle settles**, call `inspectTaskChanges(storage, { base, linkSnapshot, imageId })`. It returns the
     change manifest: every difference between the work tree and `base`, read without following links, with content
     IDs as a commit would store them. New ignored files, fifos and entries under a `.git` part are listed; a new
     directory that `base`'s own ignore rules ignore, with no tracked entry beneath it, is one entry (`ignored: true`). It also returns `agentCommits`,
     `metadataChanged`, `linkTargetChanges`, `nestedGitlinkContent` and `digest`. If the metadata changed, no Git
     command runs: the manifest has `metadataChanged: true` and every other list empty. Every change whose new entry
     is a symlink carries `linkTargetTraversesLink`: whether its target, resolved one part at a time as the kernel
     would in an agent container, passes through another link or is one. A target outside the work tree or in the
     metadata counts as `true`.
   - **Needs human.** The metadata is read-only to agents, so any agent commit or metadata change means a protection
     failed. Route it to needs human, as for link target changes and nested gitlink content.
   - **Refusals.** It refuses, and never returns part of the answer, when:
     - there are more than 10,000 changes (a populated submodule counts as one);
     - a name or link target it reports is longer than 1,024 bytes, is not strict UTF-8, or holds a Unicode control,
       format, line or paragraph separator, or unassigned character (unchanged names are never checked);
     - the recorded targets hold more than 20,000 entries;
     - it cannot read something;
     - `base` is not a commit in the storage, or Git fails;
     - for a snapshot, the metadata changed since seeding (an export refuses then too).

     Treat a refusal as needs human.
   - **Both calls** run in a read-only container with no network, take `signal`, `onProcessGroup` and `timeoutMs`
     (default 120 s), and settle only after their container is gone.
   - **To commit what the audit approved**, call `commitTaskChanges(storage, { base, linkSnapshot, digest, message,
     trailers, author, committer, imageId })`, with the approved manifest's `digest`. Identities are F's (`name`,
     `email`, and `date` in Git's raw form, such as `1700000000 +0000`); nothing comes from the environment or the
     repository, so the same inputs always give the same commit ID.
     - It runs the inspection again in its own container and builds the commit from those same reads: `base` plus
       exactly the manifest's changes, each file stored as the inspection hashed it. Ignored files the manifest lists
       are committed. What the manifest does not list stays as `base` has it.
     - Both volumes stay read-only. The objects go to a scratch store in the container's `/tmp`, and the commit comes
       back as a `git bundle` (`bundle`) whose one ref, `refs/heads/codeboost` (`TASK_COMMIT_REF`), points at `head`,
       with `base` as its prerequisite. Fetch it into a runner-owned repository and check that the ref is `head`.
     - It refuses with `TaskCommitRefused` when the manifest's digest is not `digest` (the work tree changed after the
       audit). It also refuses, whatever the audit said, any agent commit, metadata change, change to a declared link's
       target (a `retargeted` entry is the item's own edit of the link, which the audit judges), gitlink content, and any change a tree cannot hold: a directory, a fifo or other special file, a path
       under a `.git` part, or a symlink named `.gitmodules`.
     - An empty change set makes no commit: `head` is `base`, `unchanged` is true and `bundle` is empty.
     - It fails on whatever fails an inspection, on a bundle over `maxBundleBytes` (64 MiB at most), on new content
       that does not fit the container's 512 MB `/tmp` (within its 1 GB of memory), and on any Git failure. Identities,
       the message and trailer values must not hold Unicode noncharacters, which Git would re-encode, and a date's
       offset of zero is written `+0000`. The default deadline is 300 s.
     - Hooks, signing and the repository's commit encoding never apply. Calling it again with the same inputs on the
       same storage gives the same `head`.
7. After a crash or restart, call `recoverLeftovers(runnerOwner)` (`agents/recovery.ts`) while holding the
   database's single-runner lock and before admitting work. It touches only objects labelled with that runner
   token. It removes agent containers, egress proxies, seeders, export, inspection and commit containers and networks, and
   resolves once they are gone. It keeps task storage whole (both volumes and the keeper) and returns one recovery
   handle per allocation, carrying its attempt and allocation IDs. `removeTaskFilesystems` accepts a handle as it accepts the value
   `prepareTaskFilesystems` returned. D issues a handle only after checking every part's owner labels. Objects without
   a runner label (from older builds), objects of this runner that D does not create, and storage whose parts
   disagree are listed in `unowned` and never touched. An object counts as D's only with exactly one kind label,
   the value D writes for it, and complete owner labels. A storage check that cannot reach Docker rejects the whole
   recovery rather than reporting the storage. It refuses to run while this process still holds task
   storage of that runner, since every agent mounts storage; the lock is what excludes other processes. If any
   removal is not confirmed, it rejects with a `RecoveryError` whose message is about 1 KB at most and whose
   `removed` lists what it did remove, and issues no handle; running it again retries.

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

## Codex in read-only phases

Decision for #75, recorded 2026-10-01.

**Problem.** Codex 0.153.4 reads files only through its shell. D turns the shell off
(`features.shell_tool=false`), because planning and questions must not run a process
(design, "Phase enforcement"). So in these phases Codex cannot see `/work` or the
mounted schema. E4's recordings showed this: Codex planned without the code and asked
for the schema.

**Options considered.**

| Option | Result |
| --- | --- |
| a. Turn the shell on for Codex in read-only phases | Rejected. It breaks the rule that planning and questions run no process, and the design says to refuse a phase that an adapter cannot enforce. |
| b. Keep the shell off and put the schema and chosen files in the prompt | Rejected. The 32 KiB prompt limit caps how much code Codex sees, and E2 would have to choose the files. |
| c. Use Claude only for planning and questions | **Chosen.** |

**What this changes.**

- `createCodexCommand` and `startCodexInvocation` refuse the `planning` and `questions`
  phases. The start call refuses before it allocates anything.
- Ask offers only Claude Code. The Store refuses Codex as the question agent. A review
  database that already names Codex reads back as Codex, and Ask refuses it with a
  message that tells the user to choose Claude Code.
- The Ask worker receives only `CLAUDE_CODE_OAUTH_TOKEN` as credential data.
- E4 records Claude only: one draft and one suggestion.

**Codex in other phases.** The same shell setting applies to review, execute and fix.
On 2026-10-01 the live Codex probe in review answered that it could not read the file.
So Codex cannot read code in any phase. That is a separate decision from this one.

**When to revisit.** Allow Codex in these phases again when a pinned Codex version has
a file-reading tool that runs no process. Then pass the mounted schema to it with
`--output-schema /run/codeboost-input/schema.json` and add a Codex planning probe.

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
  agent socket reaches it. The credential lookup's only variable, `CLAUDE_CODE_OAUTH_TOKEN`, reaches the worker as
  data and goes only to the Claude adapter. Ask refuses Codex before any Docker work (see
  [Codex in read-only phases](#codex-in-read-only-phases)).
  Lane D's recovery runs in the worker, so it has the same environment. Missing sign-in is reported before any
  Docker work.
- Lane D's clone is a full host copy with no byte limit of its own. Before cloning, Ask measures the checkout at the
  reviewed head (`git ls-tree -r -t -l`) and the object store (`git count-objects -v`) and refuses a repository
  that would not fit the question's 512 MiB and 131,072-entry allocation. A bounded, D-owned clone would replace
  this check.
- The stop reason (timeout, shutdown or cancellation) travels as a typed value (`StopError`) from `Questions`
  through the worker message to `handle.cancel()`, separate from the message shown to the user.
- Output counts as an answer only with exit code 0 and no signal. A missing exit code or a signal is a failure.
- Every Docker object Ask creates carries the review's **Ask owner token** as `io.codeboost.runner` (#65). The token
  is per review database: the Store keeps it as `ask_owner`, tied to the database file's device and inode, like the
  runner's token. It is a separate token from the runner's (`runner_owner`), because D's recovery removes every agent
  container of the owner it is given. With one token, Ask's recovery could remove the runner's live agents, and the
  runner's recovery would find Ask's storage.
- The first question of each process, under the review's Ask lock and before any question starts, asks the worker
  to run D's `recoverLeftovers(askOwner)`. It removes the agent containers, proxies, seeders and networks of that
  owner. It returns a handle for each task-storage allocation, and Ask removes that storage at once (Ask only reads,
  so there is nothing to export). The handles are valid only in the thread that recovered them, which is why the
  worker runs recovery. Recovery runs even without a record, because a process killed early leaves no record.
  It is single-flight: concurrent first questions share it.
- Recovery touches nothing that carries another owner. Another review on the same Docker daemon, with live
  questions or with leftovers of its own, does not block Ask and is not changed by it. Ask calls recovery with
  `{ unowned: false }`, so D does not list or inspect other owners' objects at all, and their number or a failed
  inspect of one cannot make Ask's recovery fail. Objects without an owner label come from builds before #51 item 3
  and could belong to any review, so Ask neither removes them nor refuses because of them. This differs from the runner, whose startup recovery refuses to admit work while any exist
  (`runner-lifecycle.md`, "Unowned resources"): Ask only reads, and refusing would bring back the cross-review block
  that #65 removes.
- Ask stays off when recovery rejects (Docker unreachable, a removal not confirmed, the 60-second limit), and when an
  object carries this review's owner but recovery cannot identify it. The refusal for an unidentified object lists a
  `docker … rm` command for each one (at most 20). The next question retries the whole startup check, including a
  check that failed before it reached Docker (a legacy record, an Ask root that could not be deleted). Recovered storage whose
  removal Docker does not confirm is kept and retried before each question, like the worker's own storage.
- If Docker does not confirm storage removal, the worker keeps the allocation, retries removal before the next
  question, and refuses Ask while any removal is unconfirmed.
- At shutdown the worker makes one last removal attempt (bounded to 30 seconds) before it is terminated. Whatever is
  left carries the review's owner label, so the next process's recovery removes it; nothing about Docker is written
  to the record. A recovery still in flight at shutdown stops with the worker, and the next process runs it again.
  The Docker clients it started may outlive the thread, so after that the review's Ask lock is kept until this
  process exits, as after an abandonment.
- `<database>.ask-leftovers.json` lists only Ask roots (below). A record from a build before #65 can also list agent
  storage by name, or count failures it could not name. Those builds labelled Ask's objects with no owner or a random
  one, so recovery cannot find them. While such a record exists, Ask stays off and shows the `docker rm` and
  `docker volume rm` commands for the named storage. The user removes it, then deletes the record. An unreadable
  record keeps Ask off. Ask roots are never dropped, and recording one past the cap of 100 is refused. Records
  written by this build leave out the legacy fields, so an older build reads them as unreadable and keeps Ask off.
- Known limits of owner scoping. Builds between #51 item 3 and #65 labelled Ask's objects with a random owner per
  session; what such a process left after being killed is found by nobody, and has to be removed by hand
  (`docker ps -a`, `docker volume ls` and `docker network ls` with `--filter label=io.codeboost.runner`, keeping
  the owners of running reviews). The token is tied to the database file's device and inode, so a database moved to
  another filesystem or restored from a backup gets a new token, and its earlier leftovers are not recovered.
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
  resources were left. Ask stays off for the rest of the session. The resources carry the review's owner label, so
  the first question after a restart removes them through recovery.
- One process at a time runs Ask for a review. The lock is an exclusive SQLite transaction on a lock file keyed by
  the database file's identity (device and inode), in a private directory (`<tmp>/codeboost-asklocks-<uid>`, mode
  0700, checked to be owned by you). A lock path that is a symlink is refused, never followed. It is an OS file lock that the operating
  system releases when its process ends, so every spelling and every later name of the database, including an
  atomic rename while a server runs, finds the same lock. It is taken before the startup check and kept until the worker
  and any startup check still in flight have finished. Only the holder recovers, starts a worker or writes the
  record. The lock is what keeps recovery away from other processes' live questions: D's recovery cannot see other
  processes, and it removes every agent container of the owner. It does not cover Docker clients that a killed
  process left running, which can still create objects while the next process recovers; that needs lane D's
  process groups (#51 item 5). The record itself is kept next to the database's canonical path (`realpath`), so relative,
absolute and symlinked spellings share them. A database with other hard links is refused. A copy of the database
  is a different file, so it gets its own Ask owner token and its own lock.
- Lane D's settlement now ends within about 60 seconds of a cleanup failure (#51 item 1). A result with `unreleased` turns Ask off until codeboost restarts; recovery then removes what is left. Ask's own abandonment path predates the bound and is unchanged. Abandonment happens once: a crash, a watchdog and shutdown all wait on
  the same bounded termination. A question not settled 30 seconds after its
  deadline, or still settling after the 20-second shutdown grace period, makes the bridge abandon the worker. It
  waits up to 15 seconds for the worker thread to stop (a synchronous Docker or Git call
  finishes first), then rejects the waiting questions, so shutdown cannot hang on D. A worker that does not answer
  the final release request at shutdown goes through the same bounded path. If the thread is still busy
  after that wait, its ownership is already durable (the owner label and the recorded root) and no new question is
  admitted; the root is deleted as soon as the thread stops. After any abandonment the review lock is kept until the
  process exits: Docker CLI children the thread started can outlive it and cannot be awaited until lane D exposes
  process groups (#51 item 5).
- If the worker itself crashes, its containers and storage may still exist, and its Docker CLI children may still be
  changing them. The bridge does not start a replacement worker, so Ask stays off until codeboost restarts. The
  first question after the restart removes them through recovery.

`test/agent-question.test.ts` runs this path
against real Docker, including two reviews with different Ask owners on one daemon; its live case, like the vendor probes above, needs `CODEBOOST_RUN_AUTH_PROBES=1` and
`CLAUDE_CODE_OAUTH_TOKEN`.

## Limits of this gate

- CI does not run the live vendor probes. Run them locally with credentials before
  a release that changes the image, the adapters or the prompts. The two Codex probes
  fail until Codex can read files in its phases; that failure is expected, not a
  regression.
- T9 as a whole is complete only when lane F runs every suite in required CI (F6).

# codeboost

Review agent-made Git changes one plan item at a time. The approved plan lists each item's files and acceptance checks; the review engine shows which item produced each change and flags foreign or overlapping work.

**Status:** the plan/linking library, SQLite store, and local review screen are implemented. Run `npm run demo` and open its private local URL. Ask runs Claude Code or Codex inside the locked-down agent container for read-only answers; choose the provider in Settings. Ask needs Docker, plus `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) for Claude or a Codex `auth.json` (`CODEBOOST_CODEX_AUTH_FILE`, default `~/.codex/auth.json`). The first question builds the agent image, which can take a few minutes. A configured GitHub review can merge only after the guarded exact-head gate passes. The agent container, vendor-only network and Claude/Codex adapters are implemented ([agent isolation](docs/implementation/agent-isolation.md)); only Ask uses them so far. Automated rebasing, plan command execution, and code-writing agents are not implemented. The paired human review experiment was cancelled before results were recorded and no longer blocks roadmap work; optional future validation is tracked in [#19](https://github.com/codeabovelab/codeboost/issues/19).

## Development

Requires Node 26.7 or later and Git.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests create disposable local repositories. They do not invoke agents, access GitHub, or execute plan acceptance commands.

## Guarded GitHub merge

An existing-store configuration may add a trusted GitHub binding:

```json
{
  "github": {
    "repository": "owner/repository",
    "pullRequest": 123,
    "issue": 456,
    "method": "merge"
  }
}
```

The issue must match the stored plan. The authenticated `gh` account must be able to read the pull request, issue timeline, applicable rulesets, and classic branch protection, and to merge the PR. Codeboost unions required checks from both rule sources, requires strict server-enforced current-base checks, rechecks the base and head immediately before merging, and passes the reviewed head to `gh pr merge --match-head-commit`. Missing permissions and ambiguous rule responses block the merge. When the branch uses a merge queue, codeboost adds the exact reviewed head to the queue and treats the merge as done only when GitHub confirms it merged; a queued pull request is not merged, and removal or a changed head sends it back to review. A moved base and any unexecuted `cmd:` acceptance check remain blocked until [#22](https://github.com/codeabovelab/codeboost/issues/22) adds the runner path.

## Library

- `core/plan.ts`: schema validation; YAML/JSON import; projected file-state and dependency checks; literal command parsing; individual suggestion validation and application.
- `git/history.ts`: reads an immutable base-to-head commit range and file blobs. Uses argv, disables external diff/textconv helpers, hooks, and replacement objects.
- `core/linking.ts`: replays line changes using an explicit `Map<commitSha, planItemId | null>` supplied by the caller. Trailers never establish ownership. Foreign work is Unplanned; overlapping item edits are Ambiguous; undeclared edits stay on their owner's row as out of scope.
- `core/approvals.ts`: approval snapshots, dependency staleness, assignments, and accept-as-is choices keyed by content and duplicate occurrence/count.

Example from TypeScript (Node can load these source modules):

```ts
import { importPlan } from './core/plan.ts';
import { readHistory } from './git/history.ts';
import { linkHistory } from './core/linking.ts';

const { plan, warnings } = importPlan(planText, 'yaml', {
  identity: storedPlanIdentity, // Stable repositoryId, taskId, and planId from storage.
  baseEntries: entriesAtBaseCommit, // Typed file/gitlink entries; symlinks include target text.
  pathKey: checkoutPathKey, // Actual checkout case/Unicode identity; fail if unknown.
  allowedCommands: [['npm', 'test']],
  issue: 412,
}, nextRevision);
const history = readHistory(repoPath, baseCommit, headCommit);
const segments = linkHistory(plan, history, trustedCommitLedger, checkoutPathKey);
```

Inputs such as `planText` and the ledger must come from the trusted runner. `runner/store` owns the database, persistent request lifecycle, revision allocation, and atomic Apply. The browser sends review commands through `runner/review`; it cannot write ledger ownership or approval fingerprints. See [storage decisions](docs/implementation/persistent-review-store.md).

## Current limits and safety

- History must be linear and descend from the requested base. Merge histories are rejected with a rebase instruction; repositories using grafts, shallow ancestry, object alternates, or symlinked object storage are rejected (storage inspection is limited to 100,000 entries). Reads are bounded to 500 commits, 32 MiB per Git response, 64 MiB of unique blob bytes across the history (callers may lower `maxBlobBytes`), 8 MiB of cumulative diff output, 20,000 cumulative file records (including the final diff), and a shared 30-second monotonic deadline for a read. Git children receive only the remaining time and are killed on timeout. Filesystem inspections check the deadline between operations; a blocked filesystem syscall still requires an external worker supervisor. Oversized work fails explicitly.
- Linking separately bounds cumulative split lines and candidate segments to 100,000 each, reference/work operations to 1,000,000, and text/origin strings to 32 Mi UTF-16 code units. It checks before expanding lines/origin sets; grouping no longer repeatedly splits accumulated content. Callers may lower these budgets. Linking has a 30-second overall deadline and each line diff uses at most 2 seconds or the remaining total, whichever is smaller.
- The caller selects and trusts the repository and its Git administrative directory. Normal Git discovery, linked-worktree gitfiles, and symlinked gitdirs are supported; object-storage links and alternates inside that selected gitdir are rejected. This adapter is not a filesystem-containment boundary for untrusted repository roots.
- Git administrative metadata and object storage must remain unchanged during a read; these library checks do not isolate a concurrently hostile filesystem.
- Ownership uses line diffs, not semantic inference. Within one replacement block, new lines inherit all affected owners conservatively. Function context comes from Git hunk headers, not an AST.
- The importer requires accurate typed base entries, stable plan identity, a selected issue, and a trusted checkout path-identity function. It rejects path traversal, Git metadata paths, and traversal through a listed file/symlink/submodule. Runtime symlink and write-scope enforcement belong to the future container/runner; plan validation alone is not a sandbox.
- Allowed commands restrict accidents, not hostile programs or changed scripts. Parsing returns argv and never executes it. An unlisted valid command is a warning and must not run until allowed.
- Container isolation, vendor-only network access and credential handling are implemented by the lane D boundary (`agents/`), not by this library. Ask runs in that boundary in the read-only "questions" phase: it sees a clone of the reviewed head, supplied review context, and nothing else from your computer. Safe dependency installation is not implemented.

See [implementation decisions and evidence](docs/implementation/build-step-1.md) and the [plan format](docs/plan-format.md).

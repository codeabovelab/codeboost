# codeboost

Review agent-made Git changes one plan item at a time. The approved plan lists each item's files and acceptance checks; the review engine shows which item produced each change and flags foreign or overlapping work.

**Status:** the plan/linking library, SQLite store, and local read-only review screen are implemented. Run `npm run demo` and open its private local URL. Ask can invoke Claude Code or Codex for read-only answers; choose the provider in Settings. Code-writing agents and merge commands are not implemented. The human go/no-go experiment is still pending; see [the local review guide](docs/implementation/read-only-review.md).

## Development

Requires Node 26.7 or later and Git.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests create disposable local repositories. They do not invoke agents, access GitHub, or execute plan acceptance commands.

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
- No code here claims container isolation, vendor-only network access, credential protection, or safe dependency installation. Those controls must be implemented before running code-writing agents. Question answering uses bounded supplied context in a separate temporary working directory, with command tools disabled.

See [implementation decisions and evidence](docs/implementation/build-step-1.md) and the [plan format](docs/plan-format.md).

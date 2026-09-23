# codeboost

Review agent-made Git changes one plan item at a time. The approved plan lists each item's files and acceptance checks; the review engine shows which item produced each change and flags foreign or overlapping work.

**Status:** the first library slice is implemented. There is no application, server, agent runner, database, or merge command yet. Follow the [build order](docs/designs/codeboost-plan-indexed-review.md#build-order-and-the-gono-go-check); the read-only screen and real-PR go/no-go experiment come before agent execution.

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
- `core/linking.ts`: replays line changes using an explicit `Map<commitSha, planItemId>` supplied by the caller. Trailers never establish ownership. Foreign work is Unplanned; overlapping item edits are Ambiguous; undeclared edits stay on their owner's row as out of scope.
- `core/approvals.ts`: approval snapshots, dependency staleness, assignments, and accept-as-is choices keyed by content and duplicate occurrence/count.

Example from TypeScript (Node can load these source modules):

```ts
import { importPlan } from './core/plan.ts';
import { readHistory } from './git/history.ts';
import { linkHistory } from './core/linking.ts';

const { plan, warnings } = importPlan(planText, 'yaml', {
  baseFiles: pathsAtBaseCommit, // Include symlink and submodule entries, never their targets.
  allowedCommands: [['npm', 'test']],
  issue: 412,
}, nextRevision);
const history = readHistory(repoPath, baseCommit, headCommit);
const segments = linkHistory(plan, history, trustedCommitLedger);
```

Inputs such as `planText` and the ledger must come from the caller. The future `runner/store` owns the database and ledger; this library does not infer them from commit messages. Before saving a suggested edit, the store must compare-and-swap the plan revision in one transaction. The pure `applySuggestion` function validates a copy but cannot lock storage.

## Current limits and safety

- History must be linear and descend from the requested base. Merge histories are rejected with a rebase instruction; repositories using object alternates are rejected. Reads are bounded to 500 commits, 32 MiB per Git response, 64 MiB of unique blob bytes across the history (callers may lower `maxBlobBytes`), and a 2-second budget per line diff; oversized work fails explicitly.
- Ownership uses line diffs, not semantic inference. Within one replacement block, new lines inherit all affected owners conservatively. Function context comes from Git hunk headers, not an AST.
- The importer requires an accurate base-file list. It rejects path traversal, Git metadata paths, and traversal through a listed file/symlink/submodule. Runtime symlink and write-scope enforcement belong to the future container/runner; plan validation alone is not a sandbox.
- Allowed commands restrict accidents, not hostile programs or changed scripts. Parsing returns argv and never executes it. An unlisted valid command is a warning and must not run until allowed.
- No code here claims container isolation, vendor-only network access, credential protection, or safe dependency installation. Those controls must be implemented before running agents.

See [implementation decisions and evidence](docs/implementation/build-step-1.md) and the [plan format](docs/plan-format.md).

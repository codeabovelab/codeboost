# Planning screen

**Lane and step:** lane G, step G1. Tracking issue: #145.

G1 adds a Plans screen over the planning contracts already owned by lanes E and F. It does not add another plan writer: the browser imports through `POST /api/plan/import`, then reloads `GET /api/review` so the current Store revision remains the only displayed authority.

## Display contract

The screen renders the complete current plan: issue, summary, revision, open questions, ordered items, dependencies, files (including both sides of a rename) and acceptance checks. Navigation uses `?view=plans`, announces the active destination with `aria-current`, and preserves the existing Review composer DOM while the Plans screen is open.

## Import contract

The person selects a `.json`, `.yaml` or `.yml` file. Its extension chooses the existing import format; the browser sends the file contents, current revision and a UUID action ID to F1's import endpoint. A retry after an ambiguous transport outcome retains the exact action ID and request by format and file contents, even when another file is definitely refused or a refresh has since observed the first request's commit. A definite refusal clears only that file's retry. A successful import is reported as committed before the browser reloads the current plan, so a reload failure is not described as an import failure. The focused submit control stays enabled with `aria-disabled` and an in-flight guard. If the person selects another file while the request runs, the older response does not clear that newer selection. Every full review response uses one shared generation: an import or merge advances it, so a Review or Plans refresh captured before that write cannot replace the committed state in the UI. Full Review and Plans responses invalidate merge polls that return afterward and reconcile a terminal queue observation that applied while the response was pending only when its action ID and reviewed head match. Plans refresh does the same for completed or failed answers with the same note and answer-attempt IDs, including cancellation settlement, while keeping fresh blockers and stale-context metadata from the full response. Superseding work releases the stale operation's UI ownership immediately, while a failed plan operation resumes any current merge-queue polling it interrupted. Writes are kept single-flight across the Review and Plans screens.

The Store validates schema, issue identity, revision, paths, dependencies and commands. G1 does not duplicate those rules in JavaScript. A rejected import leaves the rendered and durable revision unchanged.

## Acceptance

`test/browser/plans.spec.ts` covers JSON and YAML imports, full plan and rename rendering, navigation/reload, unsent Review draft preservation, duplicate activation and focus, a newer file selection surviving an older response, exact ambiguous retry before and after a refresh observes a lost-response commit, retry preservation across another file's refusal, committed-import/reload-failure reporting, post-import Review writes while a superseded read remains unsettled, immediate stale Plans UI release after an irreversible merge, both orderings of Review/Plans refreshes against terminal merge and question observations, cancellation settlement, stale merge-queue poll suppression after import reloads, queue-poll resumption after a rejected import, and an issue-mismatch refusal that leaves the Store at the original revision.

G2 adds authoring and suggestion cards. G3 adds revision-bound Apply and request-time draft/attachment preservation. G4 completes real-provider/store integration and the remaining T18 browser/adapter gate.

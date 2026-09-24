# Lane E: planning contract audit

E1 baseline: `5eec4b5f56979033ca0e406d9216db5f71c55acd` (main, 2026-09-24).
Owner and subsequent assignments: issue #29. This is evidence for E1, not completion of T18.

## Existing contracts and issue #6 reconciliation

| Requirement | Existing implementation and runnable evidence | Disposition |
| --- | --- | --- |
| Registry-selected immutable schema and semantic dispatch; identical CLI copies | `core/plan.ts`, `schema/versions.json`; `test/registry.test.ts` | Reuse; no schema edit needed |
| Deterministic bounded JSON/YAML, decoded duplicate keys, prohibited YAML features, safe integers, UTF-8 and depth limits | `core/parse-v1.ts`; `test/plan-v1.test.ts` frozen fixtures | Reuse |
| Selected issue, canonical leaf paths, checkout case/Unicode identity, projected dependencies, base entry types and retained link lineage | `validatePlan`; `test/plan.test.ts`, `test/plan-v1.test.ts` | Reuse; runtime link-write auditing still belongs to D/F |
| Exact complete command argv; appended flags cannot inherit approval | `commandArgv`/`commandAllowed`; frozen v1 tests | Reuse; execution enforcement belongs to D/F |
| `update_file` requires the same existing path; payload and resulting-plan validation | `applySuggestion`; `test/plan.test.ts` | Reuse |
| Stable repository/task/plan binding, revision CAS, replay/sibling invalidation | `runner/store.ts` request records and transactional Apply; `test/store.test.ts` | Reuse the store as the only writer |
| Writer boundary and runtime availability (B0 subset consumed by E) | Core plan transforms are pure; ReviewStore owns SQLite transactions; store tests cover reopen, crash recovery, independent-process competing Apply and Node compatibility | Existing interface is sufficient for injected E orchestration |

Baseline command:

```sh
npx vitest run test/plan.test.ts test/plan-v1.test.ts test/registry.test.ts test/store.test.ts
npm run typecheck
```

Observed: 4 test files, 109 tests passed; typecheck passed on Node 26.7.0.
The PR body records the final validated head separately from this baseline.

## Remaining ordered work

1. **E2:** Implement a pure prompt builder and a read-only injected authoring-provider
   contract. The current template documents escaping, limits and read-only permissions,
   but no module renders it or validates a provider's extracted plan/edit response.
   Preserve all untrusted fields as escaped JSON data, reject oversized/NUL input,
   select immutable schemas internally, and validate replies before publication.
2. **E3:** Coordinate suggestion requests through the existing store methods. Capture
   identity, revision and request ID before invocation; reject stale completion and
   retain invocation ownership until settlement. Apply stays in ReviewStore. Failure,
   cancellation and shutdown need explicit lifecycle rules and controlled race tests.
3. **E4:** Exercise imports, malformed provider output, hostile prompt data, delayed
   responses and replay end to end through the E interface and real SQLite authority.
   Synthetic provider fixtures must be labeled as such. Real recorded Claude/Codex
   output and OS/container enforcement cannot be claimed from fake-provider tests.

## Ownership and integration boundaries

PR #23 owns shared review/UI integration and does not edit E's dedicated modules,
prompt template or planning tests. E must not change schema snapshots or the store.
Issue #6's library/storage gaps above have existing coverage; do not rebuild them.
Keep #6 open for its remaining runtime/integration obligations rather than equating
this audit with full acceptance. New shared gaps must be assigned to the integration
owner before dependent work proceeds.

G consumes E after its PRs land. G's production path requires D5's isolated invocation
and F1's planning API/persistence integration. Missing D5 does not prevent E2/E3
injected-provider work. D owns stdin closure, launch/token budgets, bounded vendor
envelopes and immutable phase profiles; E handles the extracted document, not a CLI
envelope. Runtime symlink snapshots, tool denial and command execution stay in D/F.
No UI, live provider, Docker or product-performance claim is established by E1.

# E2 authoring boundary

`core/planning-author.ts` prepares draft or suggestion requests without invoking a
process or writing a plan. Callers supply trusted PlanContext, request ID and target
revision. Text remains untrusted, even approved lessons and feedback. One template
pass inserts escaped JSON after resolving conditionals. Inputs and final prompts
are bounded to 32 KiB; source is never truncated. Provider output is an extracted
JSON document subject to the retained parser's 1 MiB/depth/UTF-8 limits.

Only the issue's number, title, body and comments enter the prompt; structural
TypeScript compatibility does not grant authority to extra API metadata. The
provider identity contains only repositoryId, taskId and planId; extra caller
properties are not part of the trusted boundary. Cyclic prompt data fails the
bounded traversal before serialization. Initial drafts require revision one;
revised drafts require the previous plan's revision + 1.
Draft replies must match the selected issue and requested revision. Suggestions
must match the captured base revision, and every independent card must produce a
valid plan against the original captured context. A single bad card rejects the
whole response. Warnings are returned for display; validation is not plan approval
and never grants command execution. The request and its identity are frozen;
private validation context and prior plan are snapshots of caller-owned data.
The trusted `pathKey` function must remain stable for that checkout snapshot.

The injected provider receives only read-only planning metadata, prompt/schema
strings and AbortSignal. It resolves or rejects only after the underlying invocation
and descendants terminate. Metadata is a contract, not a sandbox: production use
requires D5's immutable profile, read/list/search-only tools, disabled web/MCP,
closed stdin, isolated clone, vendor egress, launch/token budgets, bounded vendor
envelopes and safe output extraction. This module does not implement a live adapter.

E3 owns request coordination through the existing store interface. Only `Store`
may publish suggestions or apply a card with its identity/revision transaction.
G/F integrate API, UI draft preservation and persistence; no second writer is added.

Checks: `npx vitest run test/planning-author.test.ts` and `npm run typecheck`.
Fixtures in this suite are synthetic contract data, not recorded vendor output.

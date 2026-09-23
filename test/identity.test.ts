import { expect, it } from 'vitest';
import { applySuggestion, type Plan, type PlanContext } from '../core/plan.ts';
import { approveItem, approvalStates, choiceKeys, applyChoices } from '../core/approvals.ts';
import type { Segment } from '../core/linking.ts';
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'A' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan: Plan = { schema_version: 1, issue: 1, revision: 3, summary: 'Example', questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
const edit = { op: 'set_field', item: 'P1', summary: 'Title', reason: 'Clarify', field: 'title', value: 'New title', file: null, check: null, check_index: null, depends_on: null, new_item: null };
const reply = { schema_version: 1, base_revision: 3, reply: '', edits: [edit, { ...edit, field: 'intent', value: 'New intent' }] };
const binding = { identity, schemaVersion: 1, baseRevision: 3, issue: 1 };
it('rejects a delayed A suggestion on B even with identical issue, revision, and item IDs', () => {
 expect(() => applySuggestion(plan, reply, 0, { ...context, identity: { ...identity, planId: 'B' } }, binding)).toThrow(/context/);
 expect(applySuggestion(plan, reply, 0, context, binding).revision).toBe(4);
});
it('stales sibling suggestions after Apply and permits explicitly regenerated suggestions', () => {
 const next = applySuggestion(plan, reply, 0, context, binding);
 expect(() => applySuggestion(next, reply, 1, context, binding)).toThrow(/revision/);
 const refreshed = { ...reply, base_revision: 4, edits: [reply.edits[1]] };
 expect(applySuggestion(next, refreshed, 0, context, { ...binding, baseRevision: 4 }).items[0]!.intent).toBe('New intent');
 expect(plan.revision).toBe(3);
});
it('update_file cannot silently add or rename a path', () => {
 const update = { ...reply, edits: [{ ...edit, op: 'update_file', field: null, value: null, file: { ...plan.items[0]!.files[0], path: 'missing' } }] };
 expect(() => applySuggestion(plan, update, 0, context, binding)).toThrow(/does not exist/);
});
const segment: Segment = { path: 'a', oldPath: 'a', kind: 'file', owners: ['P1'], row: 'P1', scope: 'in-scope', oldLine: null, newLine: null, operation: null, content: JSON.stringify({ oldMode: '100644', newMode: '100755', oldObject: { kind: 'blob', oid: 'a' }, newObject: { kind: 'blob', oid: 'a' } }), context: '', hunk: 0, sharesHunkWith: [] };
it('binds approval to stable identity, item ID, and file metadata', () => {
 const approval = approveItem(plan, [segment], 'P1', identity);
 expect(approvalStates(plan, [segment], [approval], identity).P1).toBe('approved');
 expect(approvalStates(plan, [segment], [approval], { ...identity, planId: 'B' }).P1).toBe('stale');
 const renamed = structuredClone(plan); renamed.items[0]!.id = 'P2';
 expect(approvalStates(renamed, [{ ...segment, row: 'P2' }], [approval], identity).P2).toBe('unreviewed');
 for (const field of ['oldMode', 'newMode', 'oldObject', 'newObject']) {
  const metadata = JSON.parse(segment.content); metadata[field] = null;
  expect(approvalStates(plan, [{ ...segment, content: JSON.stringify(metadata) }], [approval], identity).P1).toBe('stale');
 }
 expect(approvalStates(plan, [], [approval], identity).P1).toBe('stale');
});
it('cannot transfer standalone acceptance to another plan', () => {
 const unplanned = { ...segment, row: 'Unplanned', owners: [null] };
 const choices = [{ key: choiceKeys([unplanned], identity)[0]!, action: 'accept' as const, item: null }];
 expect(applyChoices(plan, [unplanned], choices, identity)[0]!.row).toBe('Accepted');
 expect(applyChoices(plan, [unplanned], choices, { ...identity, planId: 'B' })[0]!.row).toBe('Unplanned');
});

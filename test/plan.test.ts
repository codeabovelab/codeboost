import { stringify } from 'yaml';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySuggestion, assertEditReply, commandArgv, commandAllowed, importPlan, isRepoPath, validatePlan, type Plan, type PlanContext } from '../core/plan.ts';
import planSchema from '../schema/plan.schema.json' with { type: 'json' };
import editSchema from '../schema/plan-edit.schema.json' with { type: 'json' };
export const basePlan = (): Plan => ({ schema_version: 1, issue: 1, revision: 1, summary: 'Change behavior.', questions: [], items: [
  { id: 'P1', title: 'Change', intent: 'Improve behavior', files: [{ path: 'a.txt', kind: 'edit', renamed_from: null, change: 'Update behavior.' }], acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] },
] });
const context: PlanContext = { baseFiles: ['a.txt'], allowedCommands: [['npm', 'test']], issue: 1 };
const reply = (op: string, payload: object = {}) => ({ schema_version: 1, base_revision: 1, reply: '', edits: [{
  op, item: 'P1', summary: 'Improve plan', reason: 'Clarify it', field: null, value: null, file: null,
  check: null, check_index: null, depends_on: null, new_item: null, ...payload,
}] });

describe('plan format', () => {
  it('imports the shipped YAML example and replaces its revision', () => {
    const source = readFileSync(new URL('../schema/examples/plan-412-r3.yaml', import.meta.url), 'utf8');
    const result = importPlan(source, 'yaml', { baseFiles: ['src/retry/client.go', 'src/retry/backoff.go', 'src/retry/config.go', 'src/retry/client_test.go', 'docs/retry.md'], allowedCommands: [['go', 'test'], ['markdownlint']] }, 8);
    expect(result.plan.revision).toBe(8);
    expect(result.warnings.map(w => w.code)).toEqual(['open-questions']);
  });
  it('validates the shipped suggestion reply', () => {
    const reply = JSON.parse(readFileSync(new URL('../schema/examples/plan-edit-412-r3.json', import.meta.url), 'utf8'));
    expect(() => assertEditReply(reply)).not.toThrow();
  });
  it('keeps strict object definitions in sync', () => {
    for (const key of ['item', 'file', 'check'] as const) expect(editSchema.$defs[key]).toEqual(planSchema.$defs[key]);
    function visit(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties as object)));
      }
      Object.values(node).forEach(visit);
    }
    visit(planSchema); visit(editSchema);
  });
  it.each([
    (p: any) => p.items[0].acceptance = [], (p: any) => p.extra = true,
    (p: any) => p.items[0].id = 'P0', (p: any) => p.items[0].files[0].path = '/tmp/x',
    (p: any) => p.items[0].files[0].kind = 'copy', (p: any) => p.items[0].files = [],
    (p: any) => p.schema_version = 2, (p: any) => delete p.summary,
  ])('rejects the eight documented broken plans %#', mutate => {
    const plan = basePlan(); mutate(plan); expect(() => importPlan(JSON.stringify(plan), 'json', context, 2)).toThrow();
  });
  it.each(['../a', 'a/../b', 'a//b', './a', 'C:/a', '/a', 'a\\b', '.git/config', 'a/\0b'])('rejects unsafe path %s', path => expect(isRepoPath(path)).toBe(false));
  it('rejects duplicate YAML keys, aliases, and extra documents', () => {
    for (const text of ['issue: 1\nissue: 2', 'x: &a [1]\ny: *a', '---\nissue: 1\n---\nissue: 2'])
      expect(() => importPlan(text, 'yaml', context, 1)).toThrow();
  });
  it('validates add, edit, rename, delete in projected order', () => {
    const plan = basePlan(); plan.items[0]!.files[0]!.kind = 'add';
    const p2 = structuredClone(plan.items[0]!); p2.id = 'P2'; p2.depends_on = ['P1']; p2.files[0]!.kind = 'rename'; p2.files[0]!.renamed_from = 'a.txt'; p2.files[0]!.path = 'b.txt';
    const p3 = structuredClone(p2); p3.id = 'P3'; p3.depends_on = ['P2']; p3.files[0]!.kind = 'edit'; p3.files[0]!.renamed_from = null;
    const p4 = structuredClone(p3); p4.id = 'P4'; p4.depends_on = ['P3']; p4.files[0]!.kind = 'delete';
    plan.items.push(p2, p3, p4);
    expect(validatePlan(plan, { ...context, baseFiles: [] }).errors).toEqual([]);
    p3.depends_on = []; expect(validatePlan(plan, { ...context, baseFiles: [] }).errors.some(e => e.code === 'dependency')).toBe(true);
  });
  it('rejects collisions, parent files, duplicate paths, cycles, and issue mismatch', () => {
    const plan = basePlan(); plan.items[0]!.files[0] = { path: 'b', kind: 'rename', renamed_from: 'a.txt', change: 'Move.' };
    expect(validatePlan(plan, { ...context, baseFiles: ['a.txt', 'b'] }).errors[0]?.code).toBe('existing-file');
    plan.items[0]!.files[0] = { path: 'link/x', kind: 'add', renamed_from: null, change: 'Add.' };
    expect(validatePlan(plan, { ...context, baseFiles: ['link'] }).errors[0]?.code).toBe('path-parent');
    plan.items[0]!.files.push({ ...plan.items[0]!.files[0]! }); plan.items[0]!.depends_on = ['P1'];
    const codes = validatePlan(plan, { ...context, issue: 2 }).errors.map(e => e.code);
    expect(codes).toContain('duplicate-path'); expect(codes).toContain('dependency'); expect(codes).toContain('issue');
  });
  it('parses literal quoted test patterns but rejects executable shell syntax', () => {
    expect(commandArgv("go test ./src/... -run 'Jitter|Retry' -count=3")).toEqual(['go', 'test', './src/...', '-run', 'Jitter|Retry', '-count=3']);
    for (const text of ['npm test; echo bad', 'npm test && x', 'npm test | x', 'npm test > file', 'npm test $(x)', 'npm test `x`', 'npm test\nx', 'npm test *']) expect(() => commandArgv(text)).toThrow();
    expect(commandAllowed(['npm', 'test-extra'], [['npm', 'test']])).toBe(false);
    expect(validatePlan(basePlan(), { ...context, allowedCommands: [] }).warnings[0]?.code).toBe('command-not-allowed');
  });
});

describe('suggestions', () => {
  it('returns a new revision without mutating inputs', () => {
    const plan = basePlan(), original = structuredClone(plan);
    const next = applySuggestion(plan, reply('set_field', { field: 'title', value: 'New title' }), 0, context);
    expect(next.revision).toBe(2); expect(next.items[0]!.title).toBe('New title'); expect(plan).toEqual(original);
  });
  it('rejects malformed payloads and invalid results', () => {
    for (const r of [reply('add_item'), reply('remove_file'), reply('remove_check', { check_index: 4 }), reply('remove_check', { check_index: 0 }), reply('set_field', { field: 'title', value: '' }), reply('remove_item'), reply('set_depends', { depends_on: ['P1'] })])
      expect(() => applySuggestion(basePlan(), r, 0, context)).toThrow();
  });
  it('rejects stale suggestions and cannot accidentally apply shifted indexes', () => {
    const r = reply('add_check', { check: { type: 'check', text: 'Works' } });
    const next = applySuggestion(basePlan(), r, 0, context);
    expect(() => applySuggestion(next, r, 0, context)).toThrow(/different revision/);
  });
  it('supports file and item operations with full post-validation', () => {
    const added = { path: 'b.txt', kind: 'add', renamed_from: null, change: 'Add.' };
    let plan = applySuggestion(basePlan(), reply('add_file', { file: added }), 0, context);
    const update = { ...reply('update_file', { file: { ...added, change: 'Refined' } }), base_revision: 2 };
    plan = applySuggestion(plan, update, 0, context); expect(plan.items[0]!.files[1]!.change).toBe('Refined');
    plan = applySuggestion(plan, { ...reply('remove_file', { value: 'b.txt' }), base_revision: 3 }, 0, context);
    expect(plan.items[0]!.files).toHaveLength(1);
    const newItem = { ...structuredClone(plan.items[0]!), id: 'P2', depends_on: ['P1'] };
    plan = applySuggestion(plan, { ...reply('add_item', { item: 'P2', new_item: newItem }), base_revision: 4 }, 0, context);
    expect(plan.items).toHaveLength(2);
  });
});
it('rejects file/parent collisions declared within the same item', () => {
  const plan = basePlan(); plan.items[0]!.files = ['new', 'new/child'].map(path => ({ path, kind: 'add', renamed_from: null, change: 'Create' }));
  expect(validatePlan(plan, context).errors.some(e => e.code === 'path-parent')).toBe(true);
});

it('rejects an alias in an otherwise valid plan before schema validation', () => {
  const source = stringify(basePlan());
  expect(() => importPlan(source, 'yaml', context, 1)).not.toThrow();
  const aliased = source.replace('summary: Change behavior.', 'summary: &summary Change behavior.').replace('title: Change', 'title: *summary');
  expect(aliased).toContain('*summary');
  expect(() => importPlan(aliased, 'yaml', context, 1)).toThrow(/Alias resolution is disabled/);
});

import { parseV1 } from '../core/parse-v1.ts';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { commandAllowed, commandArgv, importPlan, validatePlan, type Plan } from '../core/plan.ts';
const plan = (): Plan => ({ schema_version: 1, issue: 1, revision: 1, summary: 'Example', questions: [], items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const context = { identity: { repositoryId: 'repo', taskId: 'task', planId: 'plan' }, issue: 1, baseFiles: ['a'], baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (p: string) => p, allowedCommands: [] };
describe('frozen v1 input contract', () => {
 it('requires exact complete argv approval', () => {
  expect(commandAllowed(['go', 'test', '-exec', 'evil'], [['go', 'test']])).toBe(false);
  expect(commandAllowed(['go', 'test'], [['go', 'test']])).toBe(true);
 });
 it.each(['test (x)', 'test #x', 'test !x', "test 'a\\b'"])('rejects forbidden tokenizer spelling %s', text => expect(() => commandArgv(text)).toThrow());
 it('preserves empty args, adjacent quotes, and quoted punctuation', () => expect(commandArgv(`test '' ab" cd" '#!()'`)).toEqual(['test', '', 'ab cd', '#!()']));
 it('requires selected issue and known path identity', () => {
  expect(validatePlan(plan(), { ...context, issue: undefined } as any).errors.length).toBeGreaterThan(0);
  expect(validatePlan(plan(), { ...context, pathKey: undefined } as any).errors.length).toBeGreaterThan(0);
 });
 it('rejects decoded duplicate JSON keys', () => {
  const input = JSON.stringify(plan()).replace('"issue":1', '"issue":2,"iss\\u0075e":1');
  expect(() => importPlan(input, 'json', context, 2)).toThrow(/duplicate/i);
 });
 it.each(['&unused Example', '!!str Example', '', '.nan', '0x10', '1_000'])('rejects prohibited YAML scalar %s before schema checks', scalar => {
  const input = stringify(plan()).replace('summary: Example', 'summary: '+scalar);
  expect(() => importPlan(input, 'yaml', context, 2)).toThrow(/parse|anchor|tag|scalar/i);
 });
 it('rejects non-JSON numeric spelling even when it would be a valid issue', () => {
  expect(() => importPlan(stringify(plan()).replace('issue: 1', 'issue: 0x1'), 'yaml', context, 2)).toThrow();
 });
 it('rejects nesting above 50 and measures UTF-8 bytes', () => {
  expect(() => importPlan('['.repeat(51)+'0'+']'.repeat(51), 'json', context, 2)).toThrow(/depth/i);
  const large = JSON.stringify({ ...plan(), summary: 'é'.repeat(530000) });
  expect(() => importPlan(large, 'json', context, 2)).toThrow(/size|MiB/i);
 });
 it('accepts equivalent JSON/YAML and treats quoted punctuation as data', () => {
  const p = plan(); p.summary = 'literal << &anchor';
  expect(importPlan(stringify(p), 'yaml', context, 2).plan).toEqual(importPlan(JSON.stringify(p), 'json', context, 2).plan);
 });
 it('rejects plan authoring at a gitlink', () => {
  expect(validatePlan(plan(), { ...context, baseEntries: [{ path: 'a', kind: 'gitlink' }] } as any).errors.length).toBeGreaterThan(0);
 });
 it('uses checkout identity for occupied destinations and parent collisions', () => {
  const p = plan(); p.items[0]!.files[0] = { path: 'A', kind: 'add', renamed_from: null, change: 'Create' };
  expect(validatePlan(p, { ...context, pathKey: (s: string) => s.normalize('NFC').toLowerCase() }).errors.length).toBeGreaterThan(0);
 });
 it('rejects editing a link and its writable directory target in the same invocation', () => {
  const p = plan(); p.items[0]!.files.push({ path: 'dir/file', kind: 'edit', renamed_from: null, change: 'Change' });
  expect(validatePlan(p, { ...context, baseFiles: ['a', 'dir/file'], baseEntries: [{ path: 'a', kind: 'symlink', target: 'dir' }, { path: 'dir/file', kind: 'file' }] } as any).errors.length).toBeGreaterThan(0);
 });
});

describe('v1 retained parser fixtures', () => {
 it.each([
  '{"a":{"x":1,"\\u0078":2}}', '{"a":1,}', '[1,]', '01', '+1', 'true false',
  '"raw\nnewline"', '{"issue":1.00000000000000001}', '{"issue":1e-9999}',
 ])('rejects invalid or lossy JSON before schema validation: %s', text => expect(() => parseV1(text, 'json')).toThrow());
 it.each(['x: &a value', 'x: !!str value', 'x: !custom value', 'x: *alias', 'x: ~', 'x: True', 'x: 0o10', 'x: +1', 'x: .inf', 'x: 01', 'x: 1_000', '1: value', '? [a, b]\n: x', 'x: {a: 1, "\\u0061": 2}', '<<: {}', '%YAML 1.1\n---\nx: yes', '---\nx: 1\n---\nx: 2'])('rejects prohibited YAML: %s', text => expect(() => parseV1(text, 'yaml')).toThrow());
 it('accepts container depth 50 and rejects 51 in both formats', () => {
  for (const format of ['json', 'yaml'] as const) {
   expect(() => parseV1('['.repeat(50)+'0'+']'.repeat(50), format)).not.toThrow();
   expect(() => parseV1('['.repeat(51)+'0'+']'.repeat(51), format)).toThrow(/depth/);
  }
 });
 it('checks byte boundary and invalid UTF-8 before decoding', () => {
  expect(parseV1('"'+ 'a'.repeat(1048574)+'"', 'json')).toHaveLength(1048574);
  expect(() => parseV1('"'+ 'a'.repeat(1048575)+'"', 'json')).toThrow(/size/);
  expect(() => parseV1(new Uint8Array([0xff]), 'json')).toThrow();
  expect(() => parseV1('"\ud800"', 'json')).toThrow(/UTF/);
 });
 it('keeps ordinary strings and quoted syntax as data', () => {
  expect(parseV1('x: 2026-09-22\ny: "&a << !tag"\nz: |\n  text\n', 'yaml')).toEqual({ x: '2026-09-22', y: '&a << !tag', z: 'text\n' });
 });
});

it('uses Unicode identity and fails closed on unknown identity rules', () => {
 const p = plan(); p.items[0]!.files[0]!.path = 'café';
 const c = { ...context, baseEntries: [{ path: 'cafe\u0301', kind: 'file' as const }], pathKey: (s: string) => s.normalize('NFC') };
 expect(validatePlan(p, c).errors).toEqual([]);
 expect(validatePlan(p, { ...c, pathKey: () => { throw new Error('Unknown filesystem'); } }).errors[0]?.message).toMatch(/Unknown/);
});
it('retains link type through projected renames and rejects children beneath it', () => {
 const p = plan(); p.items[0]!.files[0] = { path: 'moved', kind: 'rename', renamed_from: 'a', change: 'Move link' };
 p.items.push({ ...structuredClone(p.items[0]!), id: 'P2', depends_on: ['P1'], files: [{ path: 'moved/child', kind: 'add', renamed_from: null, change: 'Create' }] });
 expect(validatePlan(p, { ...context, baseEntries: [{ path: 'a', kind: 'symlink', target: 'target' }] }).errors.some(e => e.code === 'path-parent')).toBe(true);
});
it('rejects directories, colliding base leaves, and retained links through hidden symlinks', () => {
 const p = plan(); p.items[0]!.files[0]!.path = 'dir';
 expect(validatePlan(p, { ...context, baseEntries: [{ path: 'dir/file', kind: 'file' }] }).errors.some(e => e.code === 'missing-file')).toBe(true);
 expect(validatePlan(plan(), { ...context, baseEntries: [{ path: 'a', kind: 'file' }, { path: 'a/child', kind: 'file' }] }).errors.some(e => e.code === 'context')).toBe(true);
 p.items[0]!.files[0] = { path: 'b', kind: 'rename', renamed_from: 'a', change: 'Move' };
 expect(validatePlan(p, { ...context, baseEntries: [{ path: 'a', kind: 'symlink', target: 'other/../target' }, { path: 'other', kind: 'symlink', target: 'dir' }] }).errors.some(e => e.code === 'symlink-target')).toBe(true);
});

it('rejects C1 control characters in commands and paths', () => {
 expect(() => commandArgv("test '\u0085'")).toThrow();
 const p = plan(); p.items[0]!.files[0]!.path = 'a\u0085';
 expect(validatePlan(p, { ...context, baseEntries: [{ path: 'a\u0085', kind: 'file' }] }).errors.length).toBeGreaterThan(0);
});

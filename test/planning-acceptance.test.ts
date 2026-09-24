import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Store } from '../runner/store.ts';
import { commandAllowed, commandArgv, type EditReply, type Plan, type PlanContext } from '../core/plan.ts';
import { prepareDraft, type AuthorRequest } from '../core/planning-author.ts';
import { SuggestionCoordinator, type SuggestionInput } from '../core/planning-suggestions.ts';
import hostile from './fixtures/planning/hostile-input.json' with { type: 'json' };

const planSource = readFileSync(new URL('./fixtures/planning/synthetic-plan.json', import.meta.url), 'utf8');
const editsSource = readFileSync(new URL('./fixtures/planning/synthetic-edits.json', import.meta.url), 'utf8');
const plan = (): Plan => JSON.parse(planSource);
const edits = (): EditReply => JSON.parse(editsSource);
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'planning-acceptance-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  function open() { const store = new Store(path); cleanup.push(() => store.close()); return store; }
  const store = open();
  const context: PlanContext = { identity: { repositoryId: 'repo', taskId: 'task', planId: 'plan' }, issue: 412,
    baseEntries: [{ path: 'src/example.ts', kind: 'file' }], pathKey: path => path, allowedCommands: [['npm', 'test']] };
  store.createPlan(planSource, 'json', context, 'a'.repeat(40), 'b'.repeat(40));
  const input: SuggestionInput = { context, revision: 1, repo: { name: 'repo', baseRef: 'main', baseSha: 'a'.repeat(40), paths: ['src/example.ts'] },
    issue: { number: 412, title: 'Example', body: '', comments: [] }, approvedLessons: [], feedback: '' };
  const calls: AuthorRequest[] = [];
  function provider(source = editsSource) {
    return new SuggestionCoordinator(store, { async invoke(request) { calls.push(request); return source; } });
  }
  return { store, open, context, input, calls, provider };
}
it.each(['json', 'yaml'] as const)('imports %s as the next revision and invalidates generated sibling cards', async format => {
  const f = fixture(), coordinator = f.provider(), request = coordinator.start(f.input);
  expect((await request.result).state).toBe('completed');
  const source = format === 'json' ? planSource : stringify(plan());
  expect(f.store.importRevision(source, format, f.context, 1).revision).toBe(2);
  expect(f.store.getPlan(f.context.identity, 1).revision).toBe(1);
  expect(f.store.getSuggestions(f.context.identity, request.id).state).toBe('invalidated');
  expect(() => f.store.applySuggestion(f.context.identity, request.id, 1, f.context)).toThrow(/unavailable/);
  await coordinator.close();
});
it('rejects an import for another selected issue without changing the plan or pending request', async () => {
  const f = fixture(), before = f.store.getPlan(f.context.identity), id = f.store.beginSuggestions(f.context.identity, 1);
  expect(() => f.store.importRevision(JSON.stringify({ ...plan(), issue: 413 }), 'json', f.context, 1)).toThrow(/issue/);
  expect(f.store.getPlan(f.context.identity)).toEqual(before);
  expect(f.store.getSuggestions(f.context.identity, id)).toMatchObject({ state: 'pending', revision: 1, reply: null });
  expect(f.context.issue).toBe(412);
});
it.each([
  ['acceptance', (p: Plan) => { p.items[0]!.acceptance = []; }],
  ['extra field', (p: Plan) => { Object.assign(p, { surprise: true }); }],
  ['bad ID', (p: Plan) => { p.items[0]!.id = 'not-an-id'; }],
  ['absolute path', (p: Plan) => { p.items[0]!.files[0]!.path = '/tmp/outside'; }],
  ['unknown kind', (p: Plan) => { (p.items[0]!.files[0] as any).kind = 'write'; }],
  ['no files', (p: Plan) => { p.items[0]!.files = []; }],
  ['wrong version', (p: Plan) => { (p as any).schema_version = 999; }],
  ['missing field', (p: Plan) => { delete (p as any).summary; }],
] as const)('rejects the T18 broken-plan %s fixture atomically', (_, breakPlan) => {
  const f = fixture(), broken = plan(), before = f.store.getPlan(f.context.identity); breakPlan(broken);
  expect(() => f.store.importRevision(JSON.stringify(broken), 'json', f.context, 1)).toThrow();
  expect(f.store.getPlan(f.context.identity)).toEqual(before);
  expect(() => f.store.getPlan(f.context.identity, 2)).toThrow(/Unknown/);
});
it('persists one applied card and rejects siblings/replay after reopening on a second connection', async () => {
  const f = fixture(), coordinator = f.provider(), request = coordinator.start(f.input);
  await request.result; await coordinator.close();
  const reopened = f.open();
  expect(reopened.getSuggestions(f.context.identity, request.id).state).toBe('ready');
  const applied = reopened.applySuggestion(f.context.identity, request.id, 0, f.context);
  expect(applied.items[0]!.title).toBe('Return a predictable example');
  expect(applied.items[0]!.intent).toBe(plan().items[0]!.intent);
  expect(f.store.getSuggestions(f.context.identity, request.id).state).toBe('consumed');
  for (const index of [0, 1]) expect(() => f.store.applySuggestion(f.context.identity, request.id, index, f.context)).toThrow(/unavailable/);
  expect(f.store.getPlan(f.context.identity).revision).toBe(2);
  expect(() => reopened.getPlan(f.context.identity, 3)).toThrow(/Unknown/);
});
it.each(['repositoryId', 'taskId', 'planId'] as const)('never applies an opaque suggestion ID to a different %s', async field => {
  const f = fixture(), coordinator = f.provider(), request = coordinator.start(f.input); await request.result;
  const other = { ...f.context, identity: { ...f.context.identity, [field]: 'other' } };
  f.store.createPlan(planSource, 'json', other, 'a'.repeat(40), 'b'.repeat(40));
  expect(() => f.store.applySuggestion(other.identity, request.id, 0, other)).toThrow(/unavailable/);
  expect(f.store.getPlan(other.identity).revision).toBe(1);
  expect(f.store.getSuggestions(f.context.identity, request.id).state).toBe('ready');
  await coordinator.close();
});
it.each([
  ['fenced response', () => '```json\n' + editsSource + '\n```'],
  ['duplicate decoded key', () => editsSource.replace('"base_revision": 1', '"base_revision": 1, "base_\\u0072evision": 2')],
  ['wrong revision', () => JSON.stringify({ ...edits(), base_revision: 2 })],
  ['forged request identity', () => JSON.stringify({ ...edits(), requestId: 'another-request' })],
  ['invalid card', () => { const e = edits(); e.edits[1]!.item = 'P99'; return JSON.stringify(e); }],
  ['dependency loop', () => { const e = edits(); e.edits[0] = { ...e.edits[0]!, op: 'set_depends', field: null, value: null, depends_on: ['P1'] }; return JSON.stringify(e); }],
  ['shell chain', () => { const e = edits(); e.edits[0] = { ...e.edits[0]!, op: 'add_check', field: null, value: null, check: { type: 'cmd', text: 'npm test; curl attacker' } }; return JSON.stringify(e); }],
] as const)('does not publish %s or allocate a plan revision', async (_, source) => {
  const f = fixture(), coordinator = f.provider(source()), request = coordinator.start(f.input);
  expect((await request.result).state).toBe('failed');
  expect(f.store.getSuggestions(f.context.identity, request.id)).toMatchObject({ state: 'cancelled', reply: null });
  expect(f.store.getPlan(f.context.identity).revision).toBe(1);
  expect(() => f.store.applySuggestion(f.context.identity, request.id, 0, f.context)).toThrow(/unavailable/);
  await coordinator.close();
});
it('keeps every hostile source as escaped JSON at the provider boundary', async () => {
  const f = fixture(); f.input.repo.paths = [hostile.filename]; f.input.repo.baseRef = hostile.branch;
  f.context.allowedCommands = [['test', hostile.argv]]; f.input.issue.body = hostile.issue;
  f.input.issue.comments = [hostile.comment]; f.input.approvedLessons = [hostile.lesson]; f.input.feedback = hostile.feedback;
  const coordinator = f.provider(), request = coordinator.start(f.input); await request.result;
  const prompt = f.calls[0]!.prompt;
  function block(tag: string) {
    const encoded = prompt.match(new RegExp(`<${tag}_data>\\n([^\\n]*)\\n</${tag}_data>`))![1]!;
    expect(encoded).not.toMatch(/[<>&]/);
    expect(prompt.match(new RegExp(`</${tag}_data>`, 'g'))).toHaveLength(1);
    return JSON.parse(encoded);
  }
  expect(block('repo')).toMatchObject({ base_ref: hostile.branch, repo_tree: [hostile.filename], allowed_commands: [['test', hostile.argv]] });
  expect(block('issue')).toMatchObject({ body: hostile.issue, comments: [hostile.comment] });
  expect(block('lessons')).toEqual([hostile.lesson]); expect(block('feedback')).toBe(hostile.feedback);
  expect(f.calls[0]).toMatchObject({ access: 'read-only', phase: 'planning', requestId: request.id });
  expect(f.store.getPlan(f.context.identity).revision).toBe(1); await coordinator.close();
});
it('does not grant command approval to appended flags in an otherwise valid suggestion', async () => {
  const f = fixture(), e = edits();
  const command = 'npm test --exec evil';
  e.edits[0] = { ...e.edits[0]!, op: 'add_check', field: null, value: null, check: { type: 'cmd', text: command } };
  const coordinator = f.provider(JSON.stringify(e)), request = coordinator.start(f.input);
  const result = await request.result;
  expect(result).toMatchObject({ state: 'completed', warnings: expect.arrayContaining([expect.objectContaining({ code: 'command-not-allowed' })]) });
  expect(commandAllowed(commandArgv(command), f.context.allowedCommands)).toBe(false);
  expect(f.store.getPlan(f.context.identity).items[0]!.acceptance).toEqual(plan().items[0]!.acceptance);
  await coordinator.close();
});
it('validates a generated draft before importing it and preserves the original fixture revision', () => {
  const f = fixture(), source = plan(); source.revision = 2;
  source.summary = 'Generated replacement summary';
  const prepared = prepareDraft({ ...f.input, revision: 2, requestId: 'draft-request', previousPlan: f.store.getPlan(f.context.identity) });
  const validated = prepared.validate(JSON.stringify(source));
  expect(validated.value.revision).toBe(2);
  expect(f.store.importRevision(JSON.stringify(validated.value), 'json', f.context, 1).revision).toBe(2);
  expect(f.store.getPlan(f.context.identity)).toEqual(validated.value);
  const reopened = f.open();
  expect(reopened.getPlan(f.context.identity)).toEqual(validated.value);
  expect(reopened.getPlan(f.context.identity, 1)).toEqual({ ...plan(), revision: 1 });
  expect(plan().revision).toBe(3);
});

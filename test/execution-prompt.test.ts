import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareExecution, type ExecutionInput } from '../core/execution-prompt.ts';
import type { Plan } from '../core/plan.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const plan = (intent = 'Retry with backoff'): Plan => ({ schema_version: 1, issue: 7, revision: 3, summary: 'Retries', questions: [], items: [
  { id: 'P1', title: 'Backoff', intent, files: [{ path: 'retry.ts', kind: 'edit', renamed_from: null, change: 'Add delay()' }],
    acceptance: [{ type: 'cmd', text: 'npm test' }, { type: 'cmd', text: 'npm run lint -- --fix' }, { type: 'cmd', text: "npm 'unclosed" }, { type: 'check', text: 'Delays grow' }], depends_on: [] },
  { id: 'P2', title: 'Docs', intent: 'Document it', files: [{ path: 'README.md', kind: 'edit', renamed_from: null, change: 'Explain' }], acceptance: [], depends_on: ['P1'] },
] });
const base = (over: Partial<ExecutionInput> = {}): ExecutionInput => ({
  identity, attemptId: 'attempt-1', mode: 'execute', plan: plan(), itemId: 'P1',
  issue: { number: 7, title: 'Retries fail', body: 'Crash on retry.', comments: [] },
  approvedLessons: [], allowedCommands: [['npm', 'test']], ...over,
});
const TAGS = ['plan_item_data', 'issue_data', 'lessons_data', 'problem_data'];
/** Every data block opens and closes exactly once, so nothing inside can close it early. */
function assertDelimitersIntact(prompt: string, withProblem: boolean) {
  for (const tag of TAGS) {
    const expected = tag === 'problem_data' && !withProblem ? 0 : 1;
    expect(prompt.split(`<${tag}>`).length - 1, `<${tag}>`).toBe(expected);
    expect(prompt.split(`</${tag}>`).length - 1, `</${tag}>`).toBe(expected);
  }
}

describe('execution prompt', () => {
  it('derives approved commands only from the item’s structured, approved cmd checks', () => {
    const request = prepareExecution(base());
    expect(request.approvedArgv).toEqual([['npm', 'test']]);
    expect(request).toMatchObject({ mode: 'execute', phase: 'execute', access: 'write', item: 'P1', revision: 3 });
    assertDelimitersIntact(request.prompt, false);
    expect(request.prompt).not.toContain('{{');
  });
  it('requires a problem in fix mode only, and the plan’s own issue', () => {
    expect(() => prepareExecution(base({ mode: 'fix' }))).toThrow(/exactly one problem/);
    expect(() => prepareExecution(base({ problem: { source: 'check', text: 'x' } }))).toThrow(/exactly one problem/);
    expect(() => prepareExecution(base({ issue: { number: 8, title: '', body: '', comments: [] } }))).toThrow(/issue mismatch/);
    expect(() => prepareExecution(base({ itemId: 'P9' }))).toThrow(/Unknown plan item/);
    const fix = prepareExecution(base({ mode: 'fix', problem: { source: 'review', text: 'Off by one' } }));
    assertDelimitersIntact(fix.prompt, true);
  });
  it('does not let later edits to the caller’s input change a prepared request', () => {
    const input = base(), request = prepareExecution(input);
    (input.allowedCommands as string[][]).push(['npm', 'run', 'lint', '--', '--fix']);
    input.plan.items[0]!.intent = 'changed';
    expect(request.approvedArgv).toEqual([['npm', 'test']]);
    expect(Object.isFrozen(request.approvedArgv[0])).toBe(true);
  });
});

describe('hostile-issue eval set', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hostile-issues.json', import.meta.url), 'utf8')) as
    { name: string; body: string; comments?: string[]; problem?: string }[];
  for (const fixture of fixtures) {
    it(`keeps "${fixture.name}" inside its data block and out of the approved commands`, () => {
      const problem = fixture.problem ? { source: 'review' as const, text: fixture.problem } : undefined;
      const request = prepareExecution(base({
        mode: problem ? 'fix' : 'execute', problem, plan: plan(fixture.body),
        issue: { number: 7, title: fixture.name, body: fixture.body, comments: fixture.comments ?? [] },
        approvedLessons: [fixture.body],
      }));
      assertDelimitersIntact(request.prompt, !!problem);
      expect(request.approvedArgv).toEqual([['npm', 'test']]);
      // Planted placeholders stay literal text: the template is filled in one pass and data is never re-read.
      // The body is embedded three times (plan item intent, issue body, lessons); each copy must stay literal.
      if (fixture.body.includes('{{')) {
        expect(request.prompt.split('{{problem_data_json}}').length - 1).toBe(3);
        expect(request.prompt).not.toContain('## The problem to fix');
      }
    });
  }
});

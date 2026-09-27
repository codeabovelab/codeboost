import { readFileSync } from 'node:fs';
import { identityKey, type PlanIdentity } from './identity.ts';
import { commandAllowed, commandArgv, type Plan, type PlanContext } from './plan.ts';
import { dataJSON } from './planning-author.ts';

const template = readFileSync(new URL('../prompts/execute.md', import.meta.url), 'utf8').replace(/^<!--[\s\S]*?-->\s*/u, '');

/** Trusted runner inputs for one execute or fix invocation. Every text field is untrusted data. */
export interface ExecutionInput {
  identity: PlanIdentity;
  attemptId: string;
  mode: 'execute' | 'fix';
  plan: Plan;
  itemId: string;
  issue: { number: number; title: string; body: string; comments: readonly string[] };
  approvedLessons: readonly string[];
  /** Exact argv arrays approved in Settings (PlanContext.allowedCommands). */
  allowedCommands: PlanContext['allowedCommands'];
  /** Fix mode only: the one problem to fix. */
  problem?: { source: 'review' | 'check'; text: string; evidence?: string };
}
export interface ExecutionRequest {
  readonly mode: 'execute' | 'fix';
  readonly phase: 'execute' | 'fix';
  readonly access: 'write';
  readonly identity: Readonly<PlanIdentity>;
  readonly attemptId: string;
  readonly item: string;
  readonly revision: number;
  readonly prompt: string;
  /** Structured argv for D's dispatcher, derived only from the item's `cmd` checks that are approved. Never from prose. */
  readonly approvedArgv: readonly (readonly string[])[];
}

/**
 * Build the trusted execute/fix request. Untrusted text (issue, plan fields, lessons, problem) goes only into escaped
 * JSON data blocks, filled in one pass over the trusted template. approvedArgv comes only from the item's structured
 * `cmd` acceptance entries that exactly match an approved argv array.
 */
export function prepareExecution(input: ExecutionInput): ExecutionRequest {
  identityKey(input.identity);
  if (input.mode !== 'execute' && input.mode !== 'fix') throw new Error('Unknown execution mode.');
  if (typeof input.attemptId !== 'string' || !input.attemptId) throw new Error('Attempt ID is required.');
  if (input.issue.number !== input.plan.issue) throw new Error('Selected issue mismatch.');
  if ((input.mode === 'fix') !== (input.problem !== undefined)) throw new Error('A fix needs exactly one problem; execute takes none.');
  const plan = structuredClone(input.plan), item = plan.items.find(entry => entry.id === input.itemId);
  if (!item) throw new Error('Unknown plan item.');
  const allowed = structuredClone(input.allowedCommands);
  const approvedArgv: string[][] = [];
  for (const check of item.acceptance) {
    if (check.type !== 'cmd') continue;
    let argv: string[];
    try { argv = commandArgv(check.text); } catch { continue; } // an unparsable command is never runnable
    if (commandAllowed(argv, allowed) && !approvedArgv.some(seen => seen.length === argv.length && seen.every((arg, i) => arg === argv[i])))
      approvedArgv.push(argv);
  }
  const dependencies = item.depends_on.map(id => { const dep = plan.items.find(entry => entry.id === id); return dep ? { id: dep.id, title: dep.title } : { id, title: null }; });
  const slots: Record<string, string> = {
    mode_instruction: input.mode === 'execute'
      ? 'Make the changes this plan item describes.'
      : 'A review or check found one problem in this plan item. Fix that problem.',
    item_data_json: dataJSON({ plan_summary: plan.summary, revision: plan.revision, item, depends_on: dependencies, approved_commands: approvedArgv }, 'Plan item data'),
    issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title, body: input.issue.body, comments: input.issue.comments }, 'Issue data'),
    lessons_data_json: dataJSON(input.approvedLessons, 'Lessons'),
    problem_data_json: dataJSON(input.problem ?? null, 'Problem'),
  };
  const conditional = template.replace(/\{\{#if problem\}\}([\s\S]*?)\{\{\/if\}\}/gu, (_, block: string) => input.problem ? block : '');
  // One pass over the trusted template only: inserted data is never interpreted again.
  const prompt = conditional.replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
    if (!(key in slots)) throw new Error(`Unknown template slot ${key}.`);
    return slots[key]!;
  });
  const { repositoryId, taskId, planId } = input.identity;
  return Object.freeze({
    mode: input.mode, phase: input.mode, access: 'write', identity: Object.freeze({ repositoryId, taskId, planId }),
    attemptId: input.attemptId, item: item.id, revision: plan.revision, prompt,
    approvedArgv: Object.freeze(approvedArgv.map(argv => Object.freeze([...argv]))),
  });
}

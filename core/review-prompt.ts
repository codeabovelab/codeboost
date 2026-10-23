import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { identityKey, type PlanIdentity } from './identity.ts';
import { parseV1 } from './parse-v1.ts';
import type { Plan } from './plan.ts';
import { dataJSON, MAX_PROMPT_BYTES } from './planning-author.ts';

/** The largest round number a review answer can carry; the round limit (#201) is at most this. */
export const MAX_REVIEW_ROUNDS = 10;
const template = readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8').replace(/^<!--[\s\S]*?-->\s*/u, '');
/** The exact bytes lane D mounts and passes to Claude as `--json-schema`. */
export const REVIEW_SCHEMA_TEXT = readFileSync(new URL('../prompts/review-answer.schema.json', import.meta.url), 'utf8');
const validateAnswer = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(REVIEW_SCHEMA_TEXT) as object);

/** A problem an earlier round filed against one item, shown to the next round so it can say whether the fix worked. */
export interface EarlierProblem { round: number; item: string; summary: string; detail: string; check: string | null }
/** Trusted runner inputs for one review round. Every text field is untrusted data. */
export interface ReviewInput {
  identity: PlanIdentity;
  attemptId: string;
  round: number;
  plan: Plan;
  /** The commit the agent reads: the task head after the last item, or after the last round's fixes. */
  head: string;
  /** For each plan item, the paths its commits changed. Items with no entry changed nothing. */
  changes: Readonly<Record<string, readonly string[]>>;
  issue: { number: number; title: string; body: string; comments: readonly string[] };
  approvedLessons: readonly string[];
  earlierProblems: readonly EarlierProblem[];
}
export interface ReviewRequest {
  readonly phase: 'review';
  readonly access: 'read-only';
  readonly identity: Readonly<PlanIdentity>;
  readonly attemptId: string;
  readonly round: number;
  readonly revision: number;
  readonly head: string;
  readonly prompt: string;
  readonly schemaText: string;
}
/** One problem filed against one plan item. A problem the agent named several items for becomes one per item. */
export interface ReviewProblem { item: string; summary: string; detail: string; check: string | null }
export interface PreparedReview {
  readonly request: ReviewRequest;
  /** Parse and check the agent's answer; throws with the reason when it is not a valid answer to this request. */
  validate(source: string | Uint8Array): ReviewProblem[];
}

/**
 * Build the trusted review request for one round (#201). Untrusted text (issue, plan fields, lessons, earlier problems)
 * goes only into escaped JSON data blocks, filled in one pass over the trusted template.
 */
export function prepareReview(input: ReviewInput): PreparedReview {
  identityKey(input.identity);
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > MAX_REVIEW_ROUNDS)
    throw new Error(`Review round must be an integer from 1 to ${MAX_REVIEW_ROUNDS}.`);
  if (typeof input.attemptId !== 'string' || !input.attemptId) throw new Error('Attempt ID is required.');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.head)) throw new Error('Review head must be a full commit ID.');
  if (input.issue.number !== input.plan.issue) throw new Error('Selected issue mismatch.');
  const plan = structuredClone(input.plan), ids = new Set(plan.items.map(item => item.id));
  for (const id of Object.keys(input.changes)) if (!ids.has(id)) throw new Error(`Changes name ${id}, which is not a plan item.`);
  for (const problem of input.earlierProblems)
    if (!ids.has(problem.item) || problem.round >= input.round) throw new Error('Earlier problems must name plan items from earlier rounds.');
  const items = plan.items.map(item => ({ ...item, changed_files: [...(input.changes[item.id] ?? [])] }));
  const slots: Record<string, string> = {
    round: String(input.round),
    plan_data_json: dataJSON({ summary: plan.summary, revision: plan.revision, head: input.head, items }, 'Plan data'),
    issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title, body: input.issue.body, comments: input.issue.comments }, 'Issue data'),
    lessons_data_json: dataJSON(input.approvedLessons, 'Lessons'),
    earlier_problems_json: dataJSON(input.earlierProblems.map(problem => ({ ...problem })), 'Earlier problems'),
  };
  const conditional = template.replace(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/gu,
    (_, block: string) => input.earlierProblems.length ? block : '');
  // One pass over the trusted template only: inserted data is never interpreted again.
  const prompt = conditional.replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
    if (!(key in slots)) throw new Error(`Unknown template slot ${key}.`);
    return slots[key]!;
  });
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('Review prompt exceeds 32 KiB.');
  const { repositoryId, taskId, planId } = input.identity;
  const request: ReviewRequest = Object.freeze({ phase: 'review', access: 'read-only',
    identity: Object.freeze({ repositoryId, taskId, planId }), attemptId: input.attemptId, round: input.round,
    revision: plan.revision, head: input.head, prompt, schemaText: REVIEW_SCHEMA_TEXT });
  return Object.freeze({ request, validate(source: string | Uint8Array): ReviewProblem[] {
    // The same strict JSON syntax as plans: a repeated key or an inexact integer is refused, not resolved.
    const answer = parseV1(source, 'json');
    if (!validateAnswer(answer)) {
      const first = validateAnswer.errors?.[0];
      throw new Error(`The review answer does not match its schema: ${first ? `${first.instancePath || '/'} ${first.message}` : 'invalid'}.`);
    }
    const reply = answer as { round: number; problems: { items: string[]; summary: string; detail: string; check: string | null }[] };
    if (reply.round !== request.round) throw new Error(`The review answer is for round ${reply.round}, not round ${request.round}.`);
    const problems: ReviewProblem[] = [];
    for (const problem of reply.problems) {
      const unknown = problem.items.filter(id => !ids.has(id));
      if (unknown.length) throw new Error(`The review answer names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a plan item' : 'are not plan items'}.`);
      // Split per item (design, "Review rounds" step 3), in plan order; a repeated ID files one copy.
      for (const item of plan.items) if (problem.items.includes(item.id))
        problems.push({ item: item.id, summary: problem.summary, detail: problem.detail, check: problem.check });
    }
    return problems;
  } });
}

import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { identityKey, type PlanIdentity } from './identity.ts';
import { parseV1 } from './parse-v1.ts';
import type { Plan } from './plan.ts';
import { dataJSON } from './planning-author.ts';

/** The largest round number a review answer can carry; the round limit (#201) is at most this. */
export const MAX_REVIEW_ROUNDS = 10;
const template = readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8').replace(/^<!--[\s\S]*?-->\s*/u, '');
/** The exact bytes lane D mounts and passes to Claude as `--json-schema`. */
export const REVIEW_SCHEMA_TEXT = readFileSync(new URL('../prompts/review-answer.schema.json', import.meta.url), 'utf8');
/**
 * The largest review prompt, in UTF-8 bytes: the review's model budget, 64 KiB of prompt and schema (planning's
 * `MAX_PLANNING_INPUT_BYTES`, which lane D's command builder enforces again), less the schema. Each data block in it is
 * also at most 32 KiB (`dataJSON`).
 */
export const MAX_REVIEW_PROMPT_BYTES = 64 * 1024 - Buffer.byteLength(REVIEW_SCHEMA_TEXT, 'utf8');
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
  issue: { number: number; title: string; body: string; comments: readonly string[] };
  approvedLessons: readonly string[];
  /**
   * The problems the review agent found in the previous round and a fix ran for; empty in round 1. As many as fit go
   * into the prompt, in order; the prompt says how many it leaves out.
   */
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
  /** How many of the earlier problems the prompt lists; the rest did not fit. */
  readonly earlierListed: number;
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
  if (typeof input.attemptId !== 'string' || !/^[0-9a-f-]{1,64}$/u.test(input.attemptId)) throw new Error('Attempt ID must be 1 to 64 lowercase hex digits and hyphens.');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.head)) throw new Error('Review head must be a full commit ID.');
  if (!Number.isSafeInteger(input.plan.revision) || input.plan.revision < 1) throw new Error('Plan revision must be a positive integer.');
  if (input.issue.number !== input.plan.issue) throw new Error('Selected issue mismatch.');
  const plan = structuredClone(input.plan), ids = new Set(plan.items.map(item => item.id));
  if (input.round === 1 && input.earlierProblems.length) throw new Error('Round 1 has no earlier problems.');
  for (const problem of input.earlierProblems)
    if (!ids.has(problem.item) || problem.round !== input.round - 1) throw new Error('Earlier problems must name plan items from the previous round.');
  const slots: Record<string, string> = {
    round: String(input.round),
    plan_data_json: dataJSON({ summary: plan.summary, revision: plan.revision, head: input.head, items: plan.items }, 'Plan data'),
    issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title, body: input.issue.body, comments: input.issue.comments }, 'Issue data'),
    lessons_data_json: dataJSON(input.approvedLessons, 'Lessons'),
  };
  const fill = (listed: number) => {
    const earlier = input.earlierProblems.slice(0, listed).map(({ round, item, summary, detail, check }) => ({ round, item, summary, detail, check }));
    const left = input.earlierProblems.length - listed;
    const values: Record<string, string> = { ...slots, earlier_problems_json: dataJSON(earlier, 'Earlier problems'),
      earlier_omitted: left ? `\n\n${left} more problem${left === 1 ? '' : 's'} from the previous round did not fit here. Check every plan item again.` : '' };
    return template.replace(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/gu, (_, block: string) => input.earlierProblems.length ? block : '')
      // One pass over the trusted template only: inserted data is never interpreted again.
      .replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
        if (!(key in values)) throw new Error(`Unknown template slot ${key}.`);
        return values[key]!;
      });
  };
  const fits = (listed: number) => {
    try { return Buffer.byteLength(fill(listed), 'utf8') <= MAX_REVIEW_PROMPT_BYTES; }
    catch { return false; } // a data block over its own 32 KiB limit
  };
  // Earlier problems are a hint for the agent, which checks every item anyway: list as many as fit, in order.
  let low = 0, high = input.earlierProblems.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
  // Without earlier problems the prompt is what it is: a block or the whole over its limit is refused with its reason.
  const prompt = fill(low);
  if (Buffer.byteLength(prompt, 'utf8') > MAX_REVIEW_PROMPT_BYTES)
    throw new Error(`The review prompt exceeds ${MAX_REVIEW_PROMPT_BYTES} bytes. Shorten the issue or the lessons, or split the plan.`);
  const { repositoryId, taskId, planId } = input.identity;
  const request: ReviewRequest = Object.freeze({ phase: 'review', access: 'read-only',
    identity: Object.freeze({ repositoryId, taskId, planId }), attemptId: input.attemptId, round: input.round,
    revision: plan.revision, head: input.head, prompt, schemaText: REVIEW_SCHEMA_TEXT, earlierListed: low });
  return Object.freeze({ request, validate: (source: string | Uint8Array) => validateReviewAnswer(plan, input.round, source) });
}

/**
 * Parse and check a review agent's answer for `round` of `plan`, without the rest of the request: an answer that matches
 * the schema, names only the plan's items and holds text a data block accepts is valid, whatever its size (#201).
 */
export function validateReviewAnswer(plan: Plan, round: number, source: string | Uint8Array): ReviewProblem[] {
  const ids = new Set(plan.items.map(item => item.id));
  // The same strict JSON syntax as plans: a repeated key or an inexact integer is refused, not resolved.
  const answer = parseV1(source, 'json');
  if (!validateAnswer(answer)) {
    const first = validateAnswer.errors?.[0];
    throw new Error(`The review answer does not match its schema: ${first ? `${first.instancePath || '/'} ${first.message}` : 'invalid'}.`);
  }
  const reply = answer as { round: number; problems: { items: string[]; summary: string; detail: string; check: string | null }[] };
  if (reply.round !== round) throw new Error(`The review answer is for round ${reply.round}, not round ${round}.`);
  const problems: ReviewProblem[] = [];
  for (const problem of reply.problems) {
    const unknown = problem.items.filter(id => !ids.has(id));
    if (unknown.length) throw new Error(`The review answer names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a plan item' : 'are not plan items'}.`);
    // Later prompts carry this text in data blocks, which refuse NUL and unpaired surrogates: refuse it here instead.
    if ([problem.summary, problem.detail, problem.check ?? ''].some(text => text.includes('\0') || !text.isWellFormed()))
      throw new Error('The review answer contains text with NUL or an unpaired surrogate.');
    // Split per item (design, "Review rounds" step 3), in plan order; a repeated ID files one copy. An item keeps the
    // check text only when it is one of that item's own `check:` entries.
    for (const item of plan.items) if (problem.items.includes(item.id)) {
      const check = problem.check !== null && item.acceptance.some(entry => entry.type === 'check' && entry.text === problem.check) ? problem.check : null;
      problems.push({ item: item.id, summary: problem.summary, detail: problem.detail, check });
    }
  }
  return problems;
}

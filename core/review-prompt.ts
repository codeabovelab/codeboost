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
  /** What else did not fit and was left out, with a note in the prompt saying so. */
  readonly leftOut: readonly ReviewLeftOut[];
}
/** The parts of a review prompt that are left out, in this order, when it would not fit its budget. */
export type ReviewLeftOut = 'issue comments' | 'issue description' | 'lessons' | 'file change texts';
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
  // What the prompt gives up, in this order, when it does not fit its budget: earlier problems first (they are a hint;
  // the agent checks every item anyway), then the issue's comments, its description, the lessons, and the plan's file
  // change texts. The plan's items, intents, files and checks always go in: without them there is nothing to review.
  // codeboost's own note says what was left out. Only a plan too large without its change texts is refused.
  const issueData = (comments: boolean, body: boolean) => dataJSON({ number: input.issue.number, title: input.issue.title,
    body: body ? input.issue.body : '', comments: comments ? input.issue.comments : [] }, 'Issue data');
  const planData = (changes: boolean) => dataJSON({ summary: plan.summary, revision: plan.revision, head: input.head,
    items: changes ? plan.items : plan.items.map(item => ({ ...item, files: item.files.map(file => ({ ...file, change: '' })) })) },
  'Plan data', MAX_REVIEW_PROMPT_BYTES);
  const tiers: { leftOut: ReviewLeftOut[]; slots: () => Record<string, string> }[] = [
    { leftOut: [], slots: () => ({ plan_data_json: planData(true), issue_data_json: issueData(true, true), lessons_data_json: dataJSON(input.approvedLessons, 'Lessons') }) },
    { leftOut: ['issue comments'], slots: () => ({ plan_data_json: planData(true), issue_data_json: issueData(false, true), lessons_data_json: dataJSON(input.approvedLessons, 'Lessons') }) },
    { leftOut: ['issue comments', 'issue description'], slots: () => ({ plan_data_json: planData(true), issue_data_json: issueData(false, false), lessons_data_json: dataJSON(input.approvedLessons, 'Lessons') }) },
    { leftOut: ['issue comments', 'issue description', 'lessons'], slots: () => ({ plan_data_json: planData(true), issue_data_json: issueData(false, false), lessons_data_json: dataJSON([], 'Lessons') }) },
    { leftOut: ['issue comments', 'issue description', 'lessons', 'file change texts'], slots: () => ({ plan_data_json: planData(false), issue_data_json: issueData(false, false), lessons_data_json: dataJSON([], 'Lessons') }) },
  ];
  const notes = (leftOut: readonly ReviewLeftOut[]) => ({
    issue_left_out: leftOut.includes('issue description') ? `\n\nThe issue's description${input.issue.comments.length ? ' and comments' : ''} did not fit here, so ${input.issue.comments.length ? 'they are' : 'it is'} left out. The plan says what the issue asks.`
      : leftOut.includes('issue comments') && input.issue.comments.length ? `\n\nThe issue's ${input.issue.comments.length} comment${input.issue.comments.length === 1 ? '' : 's'} did not fit here, so ${input.issue.comments.length === 1 ? 'it is' : 'they are'} left out.` : '',
    lessons_left_out: leftOut.includes('lessons') && input.approvedLessons.length ? '\n\nThe approved lessons did not fit here, so they are left out.' : '',
    plan_left_out: leftOut.includes('file change texts') ? '\n\nThe text of each file change did not fit here, so it is left out. Read each item\'s intent and its files.' : '',
  });
  const total = input.earlierProblems.length;
  const fill = (values: Record<string, string>, listed: number, note: boolean) => {
    const earlier = input.earlierProblems.slice(0, listed).map(({ round, item, summary, detail, check }) => ({ round, item, summary, detail, check }));
    const left = total - listed;
    const all: Record<string, string> = { ...values, round: String(input.round), earlier_problems_json: dataJSON(earlier, 'Earlier problems'),
      earlier_left_out: note && left ? `\n\n${listed ? `${left} more problem${left === 1 ? '' : 's'}` : `The ${left} problem${left === 1 ? '' : 's'}`} the previous round found did not fit here. Check every plan item again.` : '' };
    return template.replace(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/gu, (_, block: string) => listed ? block : '')
      // One pass over the trusted template only: inserted data is never interpreted again.
      .replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
        if (!(key in all)) throw new Error(`Unknown template slot ${key}.`);
        return all[key]!;
      });
  };
  const fits = (prompt: string) => Buffer.byteLength(prompt, 'utf8') <= MAX_REVIEW_PROMPT_BYTES;
  let chosen: { prompt: string; listed: number; leftOut: ReviewLeftOut[] } | undefined, refusal: unknown;
  for (const tier of tiers) {
    let values: Record<string, string>;
    try { values = { ...tier.slots(), ...notes(tier.leftOut) }; } catch (error) { refusal = error; continue; } // a block over its limit
    const attempt = (listed: number, note: boolean) => { try { const prompt = fill(values, listed, note); return fits(prompt) ? prompt : null; } catch { return null; } };
    // Every earlier problem, or as many as fit with the note (one more always adds more than the note's count shrinks),
    // or none with the note, or none at all.
    let prompt = total ? attempt(total, false) : null, listed = total;
    if (prompt === null && total) {
      let low = 0, high = total - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (attempt(mid, true) !== null) low = mid; else high = mid - 1; }
      prompt = attempt(low, true); listed = low;
    }
    if (prompt === null) { prompt = attempt(0, false); listed = 0; }
    if (prompt !== null) { chosen = { prompt, listed, leftOut: tier.leftOut }; break; }
    refusal = new Error(`The review prompt exceeds ${MAX_REVIEW_PROMPT_BYTES} bytes.`);
  }
  if (!chosen) throw new Error(`${refusal instanceof Error ? refusal.message : String(refusal)} The plan is too large to review even without its file change texts, the issue and the lessons.`);
  const { prompt, listed: low, leftOut } = chosen;
  const { repositoryId, taskId, planId } = input.identity;
  const request: ReviewRequest = Object.freeze({ phase: 'review', access: 'read-only',
    identity: Object.freeze({ repositoryId, taskId, planId }), attemptId: input.attemptId, round: input.round,
    revision: plan.revision, head: input.head, prompt, schemaText: REVIEW_SCHEMA_TEXT, earlierListed: low, leftOut: Object.freeze([...leftOut]) });
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
  const problems: ReviewProblem[] = [], seen = new Set<string>();
  for (const problem of reply.problems) {
    const unknown = problem.items.filter(id => !ids.has(id));
    if (unknown.length) throw new Error(`The review answer names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a plan item' : 'are not plan items'}.`);
    // Later prompts carry this text in data blocks, which refuse NUL and unpaired surrogates: refuse it here instead.
    if ([problem.summary, problem.detail, problem.check ?? ''].some(text => text.includes('\0') || !text.isWellFormed()))
      throw new Error('The review answer contains text with NUL or an unpaired surrogate.');
    // Split per item (design, "Review rounds" step 3), in plan order; a repeated ID files one copy, and so does the same
    // problem given twice for one item (each copy is one fix). An item keeps the check text only when it is one of that
    // item's own `check:` entries.
    for (const item of plan.items) if (problem.items.includes(item.id)) {
      const check = problem.check !== null && item.acceptance.some(entry => entry.type === 'check' && entry.text === problem.check) ? problem.check : null;
      const copy = { item: item.id, summary: problem.summary, detail: problem.detail, check }, key = JSON.stringify(copy);
      if (!seen.has(key)) { seen.add(key); problems.push(copy); }
    }
  }
  return problems;
}

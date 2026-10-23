import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { identityKey, type PlanIdentity } from './identity.ts';
import { parseV1 } from './parse-v1.ts';
import type { Plan } from './plan.ts';
import { DataTooLarge, dataJSON } from './planning-author.ts';

/** The largest round number a review answer can carry; the round limit (#201) is at most this. */
export const MAX_REVIEW_ROUNDS = 10;
/** The most problems the earlier-problems note can count: one round's answer split per item (10 problems × 10 items). */
const MAX_NOTE_COUNT = 100;
const template = readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8').replace(/^<!--[\s\S]*?-->\s*/u, '');
/** The exact bytes lane D mounts and passes to Claude as `--json-schema`. */
export const REVIEW_SCHEMA_TEXT = readFileSync(new URL('../prompts/review-answer.schema.json', import.meta.url), 'utf8');
/**
 * The largest review prompt, in UTF-8 bytes: the review's model budget, 64 KiB of prompt and schema (planning's
 * `MAX_PLANNING_INPUT_BYTES`, which lane D's command builder enforces again), less the schema. The plan block may use
 * all of it; the issue, lessons and earlier-problems blocks are at most 32 KiB each, and every string 32 KiB (`dataJSON`).
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
/** The parts of a review prompt that can be left out when it would not fit its budget (see prepareReview). */
export type ReviewLeftOut = 'file change texts' | 'issue description' | 'lessons' | 'issue comments';
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
  // Text a data block cannot hold (NUL, an unpaired surrogate) is refused wherever it is, before any of it is left out.
  for (const [label, value] of [['Plan data', plan], ['Issue data', input.issue], ['Lessons', input.approvedLessons], ['Earlier problems', input.earlierProblems]] as const)
    assertText(value, label);
  // The plan's items, intents, files and checks always go in: without them there is nothing to review. The rest goes in
  // while it fits, in this order: the file change texts, the earlier problems (as many as fit, in order: a hint, as the
  // agent checks every item anyway), the issue's description, the lessons, the issue's comments. codeboost's own note
  // names each part left out; the prompt always keeps room for every note.
  const total = input.earlierProblems.length;
  type Parts = { changes: boolean; earlier: number; description: boolean; lessons: boolean; comments: boolean };
  const changeTexts = plan.items.some(item => item.files.some(file => file.change));
  const issueNote = (description: boolean, comments: number) => {
    const what = [description ? 'description' : '', comments ? `${comments} comment${comments === 1 ? '' : 's'}` : ''].filter(Boolean);
    return what.length ? `\n\nThe issue's ${what.join(' and ')} did not fit here, so ${what.length > 1 || comments > 1 ? 'they are' : 'it is'} left out.` : '';
  };
  // With none listed, the note is the section, under its own heading.
  const earlierNote = (listed: number, left: number) => left
    ? `\n\n${listed ? `${left} more problem${left === 1 ? '' : 's'}` : `## Problems the previous round found\n\nThe ${left} problem${left === 1 ? '' : 's'}`} the previous round found did not fit here. Check every plan item again.` : '';
  const changesNote = '\n\nThe text of each file change did not fit here, so it is left out. Read each item\'s intent and its files.';
  const lessonsNote = '\n\nThe approved lessons did not fit here, so they are left out.';
  /**
   * `reserve`: what can differ from round to round at its longest, for the room the prompt keeps: the round number, the
   * earlier-problems note for the most problems a round can give, and the description's and lessons' notes even where
   * there is no description or lesson yet (one written or approved between rounds then still fits). The change texts'
   * note is the same in every round of one plan.
   */
  const render = (parts: Parts, reserve = false): string | null => {
    const left = total - parts.earlier, comments = input.issue.comments.length;
    const values: Record<string, string> = {
      round: reserve ? String(MAX_REVIEW_ROUNDS) : String(input.round),
      plan_data_json: dataJSON({ summary: plan.summary, revision: plan.revision, head: input.head, items: parts.changes ? plan.items
        : plan.items.map(item => ({ ...item, files: item.files.map(file => ({ ...file, change: '' })) })) }, 'Plan data', MAX_REVIEW_PROMPT_BYTES),
      plan_left_out: !parts.changes && changeTexts ? changesNote : '',
      issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title, body: parts.description ? input.issue.body : '',
        comments: parts.comments ? input.issue.comments : [] }, 'Issue data'),
      issue_left_out: issueNote(reserve || (!parts.description && !!input.issue.body), parts.comments ? 0 : comments),
      lessons_data_json: dataJSON(parts.lessons ? input.approvedLessons : [], 'Lessons'),
      lessons_left_out: reserve || (!parts.lessons && input.approvedLessons.length) ? lessonsNote : '',
      earlier_problems_json: dataJSON(input.earlierProblems.slice(0, parts.earlier).map(({ round, item, summary, detail, check }) =>
        ({ round, item, summary, detail, check })), 'Earlier problems'),
      earlier_left_out: reserve ? earlierNote(0, Math.max(total, MAX_NOTE_COUNT)) : earlierNote(parts.earlier, left),
    };
    const prompt = template.replace(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/gu, (_, block: string) => parts.earlier ? block : '')
      // One pass over the trusted template only: inserted data is never interpreted again.
      .replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
        if (!(key in values)) throw new Error(`Unknown template slot ${key}.`);
        return values[key]!;
      });
    return Buffer.byteLength(prompt, 'utf8') <= MAX_REVIEW_PROMPT_BYTES ? prompt : null;
  };
  // Only a size refusal means "does not fit"; any other refusal (data that is not JSON text, a template slot) is a bug.
  const sized = (parts: Parts, reserve = false) => { try { return render(parts, reserve); } catch (error) { if (error instanceof DataTooLarge) return null; throw error; } };
  // The smallest prompt: the plan without its change texts, the issue's number and title, the prompt's own text and the
  // note for each part left out, with the round number and the earlier-problems note at their longest. The next round
  // of the same plan therefore fits whenever this one does, unless the issue's title or its number of comments changed
  // in between. Every later prompt is at most this size until a part goes in.
  let parts: Parts = { changes: false, earlier: 0, description: false, lessons: false, comments: false };
  if (sized(parts, true) === null)
    throw new Error(`The plan is too large to review in one prompt: even without its file change texts, the issue's description and comments, the lessons and the earlier problems, the prompt takes more than ${MAX_REVIEW_PROMPT_BYTES} bytes.`);
  const keep = (next: Parts) => { if (sized(next) !== null) parts = next; };
  keep({ ...parts, changes: true });
  if (total) {
    if (sized({ ...parts, earlier: total }) !== null) parts = { ...parts, earlier: total };
    else {
      // With the note, each more problem listed adds more than the note's count shrinks, so this is monotonic.
      let low = 0, high = total - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (sized({ ...parts, earlier: mid }) !== null) low = mid; else high = mid - 1; }
      parts = { ...parts, earlier: low };
    }
  }
  keep({ ...parts, description: true });
  keep({ ...parts, lessons: true });
  keep({ ...parts, comments: true });
  const prompt = sized(parts)!, listed = parts.earlier;
  const leftOut: ReviewLeftOut[] = [
    ...(!parts.changes && changeTexts ? ['file change texts' as const] : []),
    ...(!parts.description && input.issue.body ? ['issue description' as const] : []),
    ...(!parts.lessons && input.approvedLessons.length ? ['lessons' as const] : []),
    ...(!parts.comments && input.issue.comments.length ? ['issue comments' as const] : []),
  ];
  const { repositoryId, taskId, planId } = input.identity;
  const request: ReviewRequest = Object.freeze({ phase: 'review', access: 'read-only',
    identity: Object.freeze({ repositoryId, taskId, planId }), attemptId: input.attemptId, round: input.round,
    revision: plan.revision, head: input.head, prompt, schemaText: REVIEW_SCHEMA_TEXT, earlierListed: listed, leftOut: Object.freeze([...leftOut]) });
  return Object.freeze({ request, validate: (source: string | Uint8Array) => validateReviewAnswer(plan, input.round, source) });
}

/** Refuse NUL and unpaired surrogates in every string of `value`, as `dataJSON` would where it reached them. */
function assertText(value: unknown, label: string): void {
  if (typeof value === 'string') { if (value.includes('\0') || !value.isWellFormed()) throw new Error(`${label} must be valid text without NUL.`); }
  else if (Array.isArray(value)) for (const child of value) assertText(child, label);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assertText(key, label); assertText(child, label); }
}
/**
 * Parse and check a review agent's answer for `round` of `plan`, without the rest of the request: an answer that matches
 * the schema, names only the plan's items and holds text a data block accepts is valid, at any size the schema allows
 * (#201). Like a plan, the answer's JSON text is at most 1 MiB.
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

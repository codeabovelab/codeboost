import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { identityKey, type PlanIdentity } from './identity.ts';
import { parseV1 } from './parse-v1.ts';
import type { Plan } from './plan.ts';
import { dataJSON, MAX_PROMPT_BYTES } from './planning-author.ts';

/** The largest round number a review answer can carry; the round limit (#201) is at most this. */
export const MAX_REVIEW_ROUNDS = 10;
/**
 * The most one round's problems may take, in UTF-8 bytes of their JSON data block, split per item and in the shape the
 * next round reads them back (`EarlierProblem`). Every round's prompt keeps this much room, so a valid answer never
 * makes the next round's prompt too large (the schema's per-field limits count characters, not bytes).
 */
export const MAX_ROUND_PROBLEM_BYTES = 12 * 1024;
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
  /** The problems the review agent found in the previous round and a fix ran for; empty in round 1. */
  earlierProblems: readonly EarlierProblem[];
  /** The last round the limit allows: no next round reads its problems, so its prompt keeps no room for them. */
  final?: boolean;
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
  if (typeof input.attemptId !== 'string' || !/^[0-9a-f-]{1,64}$/u.test(input.attemptId)) throw new Error('Attempt ID is required.');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.head)) throw new Error('Review head must be a full commit ID.');
  if (!Number.isSafeInteger(input.plan.revision) || input.plan.revision < 1) throw new Error('Plan revision must be a positive integer.');
  if (input.issue.number !== input.plan.issue) throw new Error('Selected issue mismatch.');
  const plan = structuredClone(input.plan), ids = new Set(plan.items.map(item => item.id));
  for (const [id, paths] of Object.entries(input.changes))
    if (!ids.has(id) || !Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error(`Changes name ${id}, which is not a plan item with a list of paths.`);
  for (const problem of input.earlierProblems)
    if (!ids.has(problem.item) || problem.round !== input.round - 1) throw new Error('Earlier problems must name plan items from the previous round.');
  const items = plan.items.map(item => ({ ...item, changed_files: [...(input.changes[item.id] ?? [])] }));
  const planData = (entries: typeof items) => dataJSON({ summary: plan.summary, revision: plan.revision, head: input.head, items: entries }, 'Plan data');
  const slots: Record<string, string> = {
    round: String(input.round),
    plan_data_json: planData(items),
    issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title, body: input.issue.body, comments: input.issue.comments }, 'Issue data'),
    lessons_data_json: dataJSON(input.approvedLessons, 'Lessons'),
    earlier_problems_json: earlierData(input.earlierProblems),
  };
  const fill = (values: Record<string, string>, withEarlier: boolean) => template.replace(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/gu,
    (_, block: string) => withEarlier ? block : '')
    // One pass over the trusted template only: inserted data is never interpreted again.
    .replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
      if (!(key in values)) throw new Error(`Unknown template slot ${key}.`);
      return values[key]!;
    });
  const prompt = fill(slots, input.earlierProblems.length > 0);
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('Review prompt exceeds 32 KiB.');
  // Room for the next round's earlier problems, measured on the largest prompt the next round can have from the same
  // issue and lessons: its round number as long as the largest, every item listing all its declared paths as changed
  // (a fix stays in them; an edit outside them pauses the run), the section's own text and the largest problem list.
  if (!input.final) {
    const bound = items.map(item => ({ ...item, changed_files: [...new Set([...item.changed_files,
      ...item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])])])] }));
    const next = fill({ ...slots, round: String(MAX_REVIEW_ROUNDS), plan_data_json: planData(bound) }, false);
    if (Buffer.byteLength(next, 'utf8') + EARLIER_BLOCK_BYTES + MAX_ROUND_PROBLEM_BYTES > MAX_PROMPT_BYTES)
      throw new Error('The review prompt leaves no room for the next round\'s problems. Shorten the issue or the lessons, or split the plan.');
  }
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
      // Later prompts carry this text in data blocks, which refuse NUL and unpaired surrogates: refuse it here instead.
      if ([problem.summary, problem.detail, problem.check ?? ''].some(text => text.includes('\0') || !text.isWellFormed()))
        throw new Error('The review answer contains text with NUL or an unpaired surrogate.');
      if (!problem.summary.trim() || !problem.detail.trim()) throw new Error('The review answer has a problem with no summary or no detail.');
      // Split per item (design, "Review rounds" step 3), in plan order; a repeated ID files one copy. An item keeps the
      // check text only when it is one of that item's own `check:` entries.
      for (const item of plan.items) if (problem.items.includes(item.id)) {
        const check = problem.check !== null && item.acceptance.some(entry => entry.type === 'check' && entry.text === problem.check) ? problem.check : null;
        problems.push({ item: item.id, summary: problem.summary, detail: problem.detail, check });
      }
    }
    // Measured as the next round's data block encodes it (JSON, with <, > and & as six-byte escapes), without its
    // 32 KiB refusal, so an oversized answer gets this message.
    const bytes = Buffer.byteLength(JSON.stringify(problems.map(({ item, summary, detail, check }) => ({ round: request.round, item, summary, detail, check })))
      .replace(/[<>&]/gu, '\\u0000'), 'utf8');
    if (bytes > MAX_ROUND_PROBLEM_BYTES)
      throw new Error(`The review answer's problems take ${bytes} bytes, over the ${MAX_ROUND_PROBLEM_BYTES}-byte limit for one round.`);
    return problems;
  } });
}
/** The earlier-problems data block's contents, exactly as a prompt carries them. */
const earlierData = (problems: readonly EarlierProblem[]) =>
  dataJSON(problems.map(({ round, item, summary, detail, check }) => ({ round, item, summary, detail, check })), 'Earlier problems');
/** The earlier-problems section's own text, without its data. */
const EARLIER_BLOCK_BYTES = Buffer.byteLength(/\{\{#if earlier_problems\}\}([\s\S]*?)\{\{\/if\}\}/u.exec(template)![1]!.replace('{{earlier_problems_json}}', ''), 'utf8');

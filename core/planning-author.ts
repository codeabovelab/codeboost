import { readFileSync } from 'node:fs';
import { identityKey, type PlanIdentity } from './identity.ts';
import { parseV1 } from './parse-v1.ts';
import { applySuggestion, assertEditReply, importPlan, validatePlan, PlanError,
  type Diagnostic, type EditReply, type Plan, type PlanContext } from './plan.ts';
import registry from '../schema/versions.json' with { type: 'json' };

export const MAX_PROMPT_BYTES = 32 * 1024;
const template = readFileSync(new URL('../prompts/plan-author.md', import.meta.url), 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/u, '');

/** Trusted runner inputs. Text fields remain untrusted data, including approved lessons. */
export interface AuthorInput {
  context: PlanContext;
  requestId: string;
  revision: number;
  repo: { name: string; baseRef: string; baseSha: string; paths: readonly string[] };
  issue: { number: number; title: string; body: string; comments: readonly string[] };
  approvedLessons: readonly string[];
  feedback: string;
  previousPlan?: Plan;
}
export interface AuthorRequest {
  readonly mode: 'draft' | 'suggest';
  readonly phase: 'planning';
  readonly access: 'read-only';
  readonly identity: Readonly<PlanIdentity>;
  readonly requestId: string;
  readonly issue: number;
  readonly revision: number;
  readonly prompt: string;
  readonly schemaText: string;
}
/** Resolves/rejects only once the invocation and its children have terminated.
 * D's adapter enforces permissions, token/argv budgets and bounded envelope extraction.
 * Return the extracted JSON document, never an object or a vendor envelope. */
export interface AuthorProvider {
  invoke(request: AuthorRequest, signal: AbortSignal): Promise<string | Uint8Array>;
}
export interface PreparedAuthor<T> {
  readonly request: AuthorRequest;
  validate(source: string | Uint8Array): { value: T; warnings: Diagnostic[] };
}

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}
function boundedText(value: string, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed())
    throw new Error(`${label} must be valid text without NUL.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES) throw new Error(`${label} exceeds 32 KiB.`);
  return value;
}
/** Bound each field and the aggregate before serialization; never truncate source data. */
function dataJSON(value: unknown, label: string): string {
  let bytes = 0;
  function check(item: unknown, depth: number): void {
    if (depth > 50) throw new Error(`${label} is too deep.`);
    if (typeof item === 'string') bytes += Buffer.byteLength(boundedText(item, label));
    else if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error(`${label} contains an invalid integer.`);
      bytes += 24;
    } else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (Array.isArray(item)) {
      bytes += item.length + 2;
      if (bytes > MAX_PROMPT_BYTES) throw new Error(`${label} exceeds 32 KiB.`);
      for (const child of item) check(child, depth + 1);
    } else if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      for (const [key, child] of Object.entries(item)) { check(key, depth + 1); check(child, depth + 1); }
    } else throw new Error(`${label} is not JSON data.`);
    if (bytes > MAX_PROMPT_BYTES) throw new Error(`${label} exceeds 32 KiB.`);
  }
  check(value, 0);
  const encoded = JSON.stringify(value).replace(/[<>&]/gu, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]!);
  return boundedText(encoded, label);
}

export function prepareDraft(input: AuthorInput): PreparedAuthor<Plan> {
  return prepare(input, 'draft') as PreparedAuthor<Plan>;
}
export function prepareSuggestions(input: AuthorInput & { previousPlan: Plan }): PreparedAuthor<EditReply> {
  return prepare(input, 'suggest') as PreparedAuthor<EditReply>;
}
function prepare(input: AuthorInput, mode: AuthorRequest['mode']): PreparedAuthor<Plan | EditReply> {
  identityKey(input.context.identity);
  integer(input.revision, 'Revision'); integer(input.context.issue, 'Selected issue');
  boundedText(input.requestId, 'Request ID');
  if (!input.requestId) throw new Error('Request ID is required.');
  if (input.issue.number !== input.context.issue) throw new Error('Selected issue mismatch.');
  // Capture caller-owned mutable containers before asynchronous invocation.
  const context: PlanContext = { ...input.context, identity: { ...input.context.identity },
    baseEntries: structuredClone(input.context.baseEntries), allowedCommands: structuredClone(input.context.allowedCommands) };
  const previous = input.previousPlan ? structuredClone(input.previousPlan) : undefined;
  if (previous) {
    const result = validatePlan(previous, context);
    if (result.errors.length) throw new PlanError(result.errors);
    if (input.revision !== previous.revision + (mode === 'draft' ? 1 : 0)) throw new Error('Previous plan revision mismatch.');
  } else if (mode === 'suggest') throw new Error('Suggestions require a previous plan.');
  else if (input.revision !== 1) throw new Error('Initial draft must use revision one.');
  const schemaPath = registry.versions['1'][mode === 'draft' ? 'plan' : 'edit'];
  const schemaText = boundedText(readFileSync(new URL('../schema/' + schemaPath, import.meta.url), 'utf8'), 'Schema');
  const slots: Record<string, string> = {
    output_instruction: mode === 'draft'
      ? 'Return one JSON object matching the supplied plan schema.'
      : 'Return one JSON object matching the supplied plan-edit schema, with reply and edits. Each edit is an independent suggestion card applied to the unchanged previous plan. Do not return a full plan.',
    revision_instruction: mode === 'draft' ? `Write revision ${input.revision} of the plan.`
      : `Set base_revision to ${input.revision}. Do not increment it; the store increments the plan revision when a person applies one card.`,
    issue_number: String(context.issue), previous_revision: String(previous?.revision ?? 0),
    repo_data_json: dataJSON({ repo: input.repo.name, base_ref: input.repo.baseRef, base_sha: input.repo.baseSha,
      repo_tree: input.repo.paths, allowed_commands: context.allowedCommands }, 'Repository data'),
    issue_data_json: dataJSON({ number: input.issue.number, title: input.issue.title,
      body: input.issue.body, comments: input.issue.comments }, 'Issue data'),
    lessons_data_json: dataJSON(input.approvedLessons, 'Lessons'),
    feedback_data_json: dataJSON(input.feedback, 'Feedback'),
    previous_plan_json: dataJSON(previous ?? null, 'Previous plan'),
  };
  const conditional = template.replace(/\{\{#if previous_plan\}\}([\s\S]*?)\{\{\/if\}\}/gu, (_, block: string) => previous ? block : '');
  // One pass over trusted template only: inserted data is never interpreted again.
  const prompt = boundedText(conditional.replace(/\{\{([a-z_]+)\}\}/gu, (_, key: string) => {
    if (!(key in slots)) throw new Error(`Unknown template slot ${key}.`);
    return slots[key]!;
  }), 'Prompt');
  const request: AuthorRequest = Object.freeze({ mode, phase: 'planning', access: 'read-only',
    identity: Object.freeze({ ...context.identity }), requestId: input.requestId, issue: context.issue,
    revision: input.revision, prompt, schemaText });
  return Object.freeze({ request, validate(source: string | Uint8Array) {
    if (mode === 'draft') {
      // importPlan replaces a revision for user imports; provider output must match it first.
      const data = parseV1(source, 'json');
      if ((data as Plan | null)?.revision !== request.revision) throw new Error('Response revision mismatch.');
      const result = importPlan(source, 'json', context, request.revision);
      return { value: result.plan, warnings: result.warnings };
    }
    const reply = parseV1(source, 'json'); assertEditReply(reply);
    if (reply.base_revision !== request.revision) throw new Error('Response revision mismatch.');
    const warnings: Diagnostic[] = [];
    // Validate every independent card against the captured plan before exposing any card.
    for (let index = 0; index < reply.edits.length; index++) {
      const next = applySuggestion(previous!, reply, index, context, { identity: context.identity,
        schemaVersion: previous!.schema_version, baseRevision: request.revision, issue: context.issue });
      warnings.push(...validatePlan(next, context).warnings);
    }
    return { value: reply, warnings };
  } });
}

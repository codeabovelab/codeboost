import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import planSchema from '../schema/plan.schema.json' with { type: 'json' };
import editSchema from '../schema/plan-edit.schema.json' with { type: 'json' };

export interface PlanFile {
  path: string; kind: 'add' | 'edit' | 'delete' | 'rename';
  renamed_from: string | null; change: string;
}
export interface Check { type: 'cmd' | 'check'; text: string }
export interface PlanItem {
  id: string; title: string; intent: string; files: PlanFile[];
  acceptance: Check[]; depends_on: string[];
}
export interface Plan {
  schema_version: 1; issue: number; revision: number; summary: string;
  items: PlanItem[]; questions: string[];
}
export interface PlanEdit {
  op: 'add_item' | 'remove_item' | 'set_field' | 'add_file' | 'update_file' |
    'remove_file' | 'add_check' | 'remove_check' | 'set_depends';
  item: string; summary: string; reason: string;
  field: 'title' | 'intent' | null; value: string | null; file: PlanFile | null;
  check: Check | null; check_index: number | null;
  depends_on: string[] | null; new_item: PlanItem | null;
}
export interface EditReply {
  schema_version: 1; base_revision: number; reply: string; edits: PlanEdit[];
}
export interface Diagnostic { code: string; message: string; item?: string }
export interface PlanContext {
  /** Files at the immutable base commit, not the current working directory. */
  baseFiles: readonly string[];
  /** Exact executable + subcommand prefixes, already tokenized by Settings. */
  allowedCommands: readonly (readonly string[])[];
  issue?: number;
}
export interface Validation { errors: Diagnostic[]; warnings: Diagnostic[] }
export class PlanError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => `${d.item ? `${d.item}: ` : ''}${d.message}`).join('\n'));
    this.name = 'PlanError';
    this.diagnostics = diagnostics;
  }
}
const ajv = new Ajv2020({ allErrors: true, strict: true });
const planShape = ajv.compile<Plan>(planSchema);
const replyShape = ajv.compile<EditReply>(editSchema);

function fail(code: string, message: string): never { throw new PlanError([{ code, message }]); }
export function assertPlan(value: unknown): asserts value is Plan {
  if (!planShape(value)) throw new PlanError((planShape.errors ?? []).map(e => ({
    code: 'schema', message: `${e.instancePath || '/'} ${e.message}`,
  })));
}
export function assertEditReply(value: unknown): asserts value is EditReply {
  if (!replyShape(value)) throw new PlanError((replyShape.errors ?? []).map(e => ({
    code: 'edit-schema', message: `${e.instancePath || '/'} ${e.message}`,
  })));
}
/** Canonical paths make duplicate checks reliable and exclude Git metadata. */
export function isRepoPath(path: string): boolean {
  return path.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
      part.toLowerCase() !== '.git');
}

/** Small literal-argv grammar, deliberately not a shell parser. Never executes. */
export function commandArgv(command: string): string[] {
  if (/[\x00-\x1f\x7f]/u.test(command))
    fail('command-syntax', 'Commands must contain literal arguments, not shell syntax.');
  const argv: string[] = [];
  let word = '', quote = '', started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ''; else word += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === ' ') {
      if (started) { argv.push(word); word = ''; started = false; }
    } else {
      if (/[;&|<>`$\\*?{}~\[\]]/u.test(char)) fail('command-syntax', 'Shell syntax is not allowed.');
      word += char; started = true;
    }
  }
  if (quote) fail('command-syntax', 'Unclosed quote in command.');
  if (started) argv.push(word);
  if (!argv[0] || argv[0].includes('=') || argv[0].startsWith('-'))
    fail('command-syntax', 'A command must start with an executable.');
  return argv;
}
export function commandAllowed(argv: readonly string[], allowed: PlanContext['allowedCommands']): boolean {
  return allowed.some(prefix => prefix.length > 0 && prefix.every((part, i) => argv[i] === part));
}

export function validatePlan(value: unknown, context: PlanContext): Validation {
  try { assertPlan(value); } catch (error) {
    if (error instanceof PlanError) return { errors: error.diagnostics, warnings: [] };
    throw error;
  }
  const errors: Diagnostic[] = [], warnings: Diagnostic[] = [];
  const error = (code: string, message: string, item?: string) => errors.push({ code, message, item });
  if (context.issue !== undefined && value.issue !== context.issue)
    error('issue', 'Plan issue does not match the selected issue.');
  if (![value.issue, value.revision].every(Number.isSafeInteger)) error('integer-range', 'Issue and revision must be safe integers.');
  const paths = new Set(context.baseFiles);
  const producers = new Map<string, string>();
  const ancestry = new Map<string, Set<string>>();
  for (const item of value.items) {
    if (ancestry.has(item.id)) error('duplicate-id', `Duplicate item ID ${item.id}.`, item.id);
    const ancestors = new Set<string>();
    for (const dep of item.depends_on) {
      if (dep === item.id || !ancestry.has(dep)) error('dependency', `${dep} must be an earlier item.`, item.id);
      ancestors.add(dep);
      for (const ancestor of ancestry.get(dep) ?? []) ancestors.add(ancestor);
    }
    if (new Set(item.depends_on).size !== item.depends_on.length)
      error('dependency', 'Dependencies must be unique.', item.id);
    ancestry.set(item.id, ancestors);
    const touched = new Set<string>();
    const beforeErrors = errors.length;
    for (const file of item.files) {
      const involved = file.kind === 'rename' ? [file.path, file.renamed_from ?? ''] : [file.path];
      if ((file.kind === 'rename') !== (file.renamed_from !== null))
        error('rename-source', 'Only renames require renamed_from.', item.id);
      for (const path of involved) {
        if (!isRepoPath(path)) error('path', `Unsafe or non-canonical path: ${path}`, item.id);
        if (touched.has(path)) error('duplicate-path', `Path used twice in one item: ${path}`, item.id);
        if ([...touched].some(other => other.startsWith(`${path}/`) || path.startsWith(`${other}/`)))
          error('path-parent', `Overlapping file paths in one item: ${path}`, item.id);
        touched.add(path);
        // Parent entries (including symlinks and submodules) cannot be traversed.
        if (path.split('/').slice(0, -1).some((_, i, parts) => paths.has(parts.slice(0, i + 1).join('/'))))
          error('path-parent', `A file, symlink, or submodule blocks a parent of ${path}.`, item.id);
        const producer = producers.get(path);
        if (producer && !ancestors.has(producer))
          error('dependency', `${path} depends on ${producer}.`, item.id);
      }
      const source = file.kind === 'rename' ? file.renamed_from! : file.path;
      if (file.kind !== 'add' && !paths.has(source)) error('missing-file', `Missing source: ${source}`, item.id);
      if ((file.kind === 'add' || file.kind === 'rename') &&
          (paths.has(file.path) || [...paths].some(path => path.startsWith(`${file.path}/`))))
        error('existing-file', `Destination is occupied: ${file.path}`, item.id);
    }
    if (errors.length === beforeErrors) for (const file of item.files) {
      if (file.kind === 'delete' || file.kind === 'rename') {
        const source = file.kind === 'rename' ? file.renamed_from! : file.path;
        paths.delete(source); producers.set(source, item.id);
      }
      if (file.kind === 'add' || file.kind === 'rename') { paths.add(file.path); producers.set(file.path, item.id); }
    }
    if (!item.acceptance.some(check => check.type === 'cmd'))
      warnings.push({ code: 'no-test-command', message: 'No test command.', item: item.id });
    for (const check of item.acceptance.filter(check => check.type === 'cmd')) {
      try {
        const argv = commandArgv(check.text);
        if (!commandAllowed(argv, context.allowedCommands)) warnings.push({
          code: 'command-not-allowed', message: `Command cannot run until allowed: ${check.text}`, item: item.id,
        });
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
        errors.push(...err.diagnostics.map(d => ({ ...d, item: item.id })));
      }
    }
  }
  if (value.questions.length) warnings.push({ code: 'open-questions', message: 'The plan has unanswered questions.' });
  return { errors, warnings };
}

export function importPlan(source: string, format: 'json' | 'yaml', context: PlanContext, revision: number): { plan: Plan; warnings: Diagnostic[] } {
  if (!Number.isSafeInteger(revision) || revision < 1) fail('revision', 'Revision must be a positive safe integer.');
  if (source.length > 1_000_000) fail('input-size', 'Plan input exceeds 1 MB.');
  let data: unknown;
  try {
    if (format === 'json') data = JSON.parse(source);
    else {
      const doc = parseDocument(source, { uniqueKeys: true, version: '1.2' });
      if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map(e => e.message).join('; '));
      data = doc.toJS({ maxAliasCount: 0 });
    }
  } catch (error) { fail('parse', `Cannot parse plan: ${(error as Error).message}`); }
  assertPlan(data); // No migrations exist yet: only released v1 is accepted.
  const result = validatePlan(data, context);
  if (result.errors.length) throw new PlanError(result.errors);
  return { plan: { ...data, revision }, warnings: result.warnings };
}

const payloads = ['field', 'value', 'file', 'check', 'check_index', 'depends_on', 'new_item'] as const;
const used: Record<PlanEdit['op'], readonly typeof payloads[number][]> = {
  add_item: ['new_item'], remove_item: [], set_field: ['field', 'value'],
  add_file: ['file'], update_file: ['file'], remove_file: ['value'],
  add_check: ['check'], remove_check: ['check_index'], set_depends: ['depends_on'],
};
/** Pure transformation. The future store must compare-and-swap revision when persisting. */
export function applySuggestion(plan: Plan, reply: unknown, index: number, context: PlanContext): Plan {
  assertPlan(plan); assertEditReply(reply);
  if (reply.base_revision !== plan.revision) fail('stale-revision', 'Suggestion was drafted against a different revision.');
  if (!Number.isInteger(index) || !reply.edits[index]) fail('edit-index', 'Suggestion index is out of range.');
  const edit = reply.edits[index]!;
  for (const key of payloads) {
    if (used[edit.op].includes(key) ? edit[key] === null : edit[key] !== null)
      fail('edit-payload', `${edit.op} has an invalid ${key} payload.`);
  }
  const next = structuredClone(plan);
  const itemIndex = next.items.findIndex(item => item.id === edit.item);
  if (edit.op === 'add_item') {
    if (itemIndex !== -1 || edit.new_item!.id !== edit.item) fail('edit-item', 'New item ID must be unique and match item.');
    next.items.push(edit.new_item!);
  } else {
    if (itemIndex < 0) fail('edit-item', 'Target item does not exist.');
    const item = next.items[itemIndex]!;
    switch (edit.op) {
      case 'remove_item': next.items.splice(itemIndex, 1); break;
      case 'set_field': item[edit.field!] = edit.value!; break;
      case 'add_file': item.files.push(edit.file!); break;
      case 'update_file': {
        const i = item.files.findIndex(file => file.path === edit.file!.path);
        if (i < 0) fail('edit-file', 'File to update does not exist.');
        item.files[i] = edit.file!; break;
      }
      case 'remove_file': {
        const i = item.files.findIndex(file => file.path === edit.value);
        if (i < 0) fail('edit-file', 'File to remove does not exist.');
        item.files.splice(i, 1); break;
      }
      case 'add_check': item.acceptance.push(edit.check!); break;
      case 'remove_check':
        if (edit.check_index! >= item.acceptance.length) fail('edit-check', 'Check index is out of range.');
        item.acceptance.splice(edit.check_index!, 1); break;
      case 'set_depends': item.depends_on = edit.depends_on!; break;
    }
  }
  const result = validatePlan(next, context);
  if (result.errors.length) throw new PlanError(result.errors);
  if (!Number.isSafeInteger(next.revision + 1)) fail('revision', 'Revision limit reached.');
  next.revision++;
  return structuredClone(next);
}

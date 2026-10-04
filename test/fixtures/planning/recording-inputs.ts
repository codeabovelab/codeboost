import { createHash, randomUUID } from 'node:crypto';
import { captureInvocation } from '../../../agents/contract.ts';
import { createClaudeCommand, createPhasePolicy } from '../../../agents/policy.ts';
import type { Plan, PlanContext } from '../../../core/plan.ts';
import { prepareDraft, prepareSuggestions, type AuthorInput, type PreparedAuthor } from '../../../core/planning-author.ts';

// The one task Claude is recorded on. scripts/record-planning.ts commits these files to a scratch repository;
// test/planning-recorded.test.ts rebuilds the same request and refuses a recording whose prompt, schema, files or
// Claude command differs.
export const RECORDING_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': '{\n  "name": "example",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/example.ts': [
    'let calls = 0;',
    '',
    '/** Returns a label for the given value. */',
    'export function label(value: number): string {',
    '  calls += 1;',
    '  return calls % 2 === 0 ? `even call: ${value}` : `value ${value}`;',
    '}',
    '',
  ].join('\n'),
  'test/example.test.ts': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { label } from '../src/example.ts';",
    '',
    "test('labels a value', () => { assert.match(label(3), /3/); });",
    '',
  ].join('\n'),
});
export const RECORDING_ISSUE = Object.freeze({
  number: 412,
  title: 'label() returns different text for the same input',
  body: 'Calling `label(3)` twice returns `value 3` and then `even call: 3`. It should return the same text every time.'
    + ' Please add a test that calls it twice.',
  comments: Object.freeze(['The hidden call counter looks like leftover debugging code.']),
});
export const RECORDING_FEEDBACK = 'Split the test into its own item that depends on the fix, and name the exact assertion it adds.';

export function recordingContext(): PlanContext {
  return { identity: { repositoryId: 'recording-repo', taskId: 'recording-task', planId: 'recording-plan' },
    issue: RECORDING_ISSUE.number, pathKey: path => path, allowedCommands: [['npm', 'test']],
    baseEntries: Object.keys(RECORDING_FILES).map(path => ({ path, kind: 'file' as const })) };
}
/** The revision-one plan the suggestion recording revises. Written by hand; it is input, not vendor output. */
export function recordingPreviousPlan(): Plan {
  return { schema_version: 1, issue: RECORDING_ISSUE.number, revision: 1,
    summary: 'Make label() return the same text for the same input.',
    items: [{ id: 'P1', title: 'Remove the call counter from label()',
      intent: 'label(value) depends only on value.',
      files: [
        { path: 'src/example.ts', kind: 'edit', renamed_from: null, change: 'Delete `calls` and return `value ${value}` from label().' },
        { path: 'test/example.test.ts', kind: 'edit', renamed_from: null, change: 'Add a test that calls label(3) twice.' },
      ],
      acceptance: [{ type: 'cmd', text: 'npm test' }], depends_on: [] }],
    questions: [] } as Plan;
}
export function recordingInput(mode: 'draft' | 'suggest', baseSha: string, requestId: string): AuthorInput {
  return { context: recordingContext(), requestId, revision: 1,
    repo: { name: 'example', baseRef: 'main', baseSha, paths: Object.keys(RECORDING_FILES) },
    issue: { ...RECORDING_ISSUE, comments: [...RECORDING_ISSUE.comments] }, approvedLessons: [],
    feedback: mode === 'suggest' ? RECORDING_FEEDBACK : '',
    ...(mode === 'suggest' ? { previousPlan: recordingPreviousPlan() } : {}) };
}
export function prepareRecording(mode: 'draft' | 'suggest', baseSha: string, requestId: string): PreparedAuthor<unknown> {
  const input = recordingInput(mode, baseSha, requestId);
  return mode === 'draft' ? prepareDraft(input) : prepareSuggestions({ ...input, previousPlan: input.previousPlan! });
}
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The prompt names files and the commit, not their contents, so the contents are hashed on their own. */
export const recordingFilesSha256 = () => sha256(JSON.stringify(Object.entries(RECORDING_FILES).sort()));
/**
 * Hash of the exact argv lane D runs Claude with for this prompt and schema: its flags, tool sets and `--json-schema`.
 * A lane D change to any of them makes a recording stale even when the image tag, prompt and schema are unchanged.
 */
export function planningCommandSha256(prompt: string, schemaText: string): string {
  const head = '0'.repeat(40);
  // A captured invocation is single-use, so each call captures a fresh throwaway one; none of it reaches the argv.
  const invocation = captureInvocation({ clone: { id: 'fingerprint', taskId: 'fingerprint', directory: '/fingerprint', head },
    phase: 'planning', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: randomUUID(),
    runnerOwner: '0'.repeat(32), context: { snapshotId: 'fingerprint', planId: 'fingerprint', planRevision: 1,
      assignmentId: 'fingerprint', referencedCodeHash: head, stateVersion: 0 } });
  return sha256(JSON.stringify(createClaudeCommand(createPhasePolicy(invocation), prompt, schemaText).argv));
}

export const RECORDING_KIND = 'codeboost-planning-recording';
export interface PlanningRecording {
  readonly kind: typeof RECORDING_KIND;
  readonly version: 1;
  /** Codex is refused in every phase (#93), so only Claude is recorded. */
  readonly vendor: 'claude';
  readonly mode: 'draft' | 'suggest';
  readonly recordedAt: string;
  readonly provenance: {
    readonly image: string;
    readonly cliVersion: string;
    /** The adapters pass no model flag, so this names the CLI default rather than a pinned model. */
    readonly model: string;
    readonly phase: 'planning';
  };
  readonly request: {
    readonly requestId: string;
    readonly revision: number;
    readonly issue: number;
    readonly baseSha: string;
    readonly promptSha256: string;
    readonly schemaSha256: string;
    /** `recordingFilesSha256()` when recorded: the contents of the repository Claude read. */
    readonly filesSha256: string;
    /** `planningCommandSha256()` when recorded: the argv lane D ran Claude with. */
    readonly commandSha256: string;
  };
  /** D's extracted output exactly as returned: Claude's schema-validated `structured_output`, as JSON text. */
  readonly output: string;
}

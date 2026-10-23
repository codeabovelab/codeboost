import { createHash, randomUUID } from 'node:crypto';
import { captureInvocation } from '../../../agents/contract.ts';
import { createClaudeCommand, createPhasePolicy } from '../../../agents/policy.ts';
import type { Plan } from '../../../core/plan.ts';
import { prepareReview, type EarlierProblem, type PreparedReview, type ReviewInput } from '../../../core/review-prompt.ts';

// The one finished task the review agent is recorded on (#201). scripts/record-review.ts commits these files to a
// scratch repository; test/review-recorded.test.ts rebuilds the same request and refuses a recording whose prompt,
// schema, files or Claude command differs.
//
// The files are the code after both plan items below ran. P1 is done as planned. P2 is not: its test calls label(3)
// once, so it cannot catch the bug its intent and its check describe. A review that reads the code finds that.
export const REVIEW_RECORDING_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': '{\n  "name": "example",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/example.ts': [
    '/** Returns a label for the given value. */',
    'export function label(value: number): string {',
    '  return `value ${value}`;',
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
    "test('labels a value the same way every time', () => {",
    "  assert.equal(label(3), 'value 3');",
    '});',
    '',
  ].join('\n'),
});
export const REVIEW_RECORDING_ISSUE = Object.freeze({
  number: 412,
  title: 'label() returns different text for the same input',
  body: 'Calling `label(3)` twice returns `value 3` and then `even call: 3`. It should return the same text every time.'
    + ' Please add a test that calls it twice.',
  comments: Object.freeze(['The hidden call counter looks like leftover debugging code.']),
});
export const REVIEW_RECORDING_IDENTITY = Object.freeze({ repositoryId: 'recording-repo', taskId: 'recording-task', planId: 'recording-plan' });

/** The plan that ran. Written by hand; it is input, not vendor output. */
export function reviewRecordingPlan(): Plan {
  return { schema_version: 1, issue: REVIEW_RECORDING_ISSUE.number, revision: 1,
    summary: 'Make label() return the same text for the same input, and test it.',
    items: [
      { id: 'P1', title: 'Remove the call counter from label()', intent: 'label(value) depends only on value.',
        files: [{ path: 'src/example.ts', kind: 'edit', renamed_from: null, change: 'Delete `calls` and return `value ${value}` from label().' }],
        acceptance: [{ type: 'cmd', text: 'npm test' }, { type: 'check', text: 'label() keeps no state between calls.' }], depends_on: [] },
      { id: 'P2', title: 'Test that label() is stable', intent: 'A test fails if label() returns different text for the same input.',
        files: [{ path: 'test/example.test.ts', kind: 'edit', renamed_from: null, change: 'Add a test that calls label(3) twice and compares the results.' }],
        acceptance: [{ type: 'cmd', text: 'npm test' }, { type: 'check', text: 'The new test calls label(3) twice and asserts both results are equal.' }],
        depends_on: ['P1'] },
    ],
    questions: [] } as Plan;
}
/** The problem round 2 is told round 1 found and fixed. The files are unchanged, so it is still there. */
export const REVIEW_RECORDING_EARLIER: readonly EarlierProblem[] = Object.freeze([Object.freeze({
  round: 1, item: 'P2', summary: 'The new test calls label(3) only once, so it cannot show that label() is stable.',
  detail: 'test/example.test.ts, test "labels a value the same way every time": it calls label(3) once and compares it with a literal. Call it twice and compare the two results.',
  check: 'The new test calls label(3) twice and asserts both results are equal.' })]);

export type ReviewRecordingName = 'claude-review-round1' | 'claude-review-round2';
export const REVIEW_RECORDING_NAMES: readonly ReviewRecordingName[] = ['claude-review-round1', 'claude-review-round2'];
export function reviewRecordingInput(name: ReviewRecordingName, head: string, attemptId: string): ReviewInput {
  const round = name === 'claude-review-round1' ? 1 : 2;
  return { identity: { ...REVIEW_RECORDING_IDENTITY }, attemptId, round, plan: reviewRecordingPlan(), head,
    changes: { P1: ['src/example.ts'], P2: ['test/example.test.ts'] },
    issue: { ...REVIEW_RECORDING_ISSUE, comments: [...REVIEW_RECORDING_ISSUE.comments] }, approvedLessons: [],
    earlierProblems: round === 1 ? [] : REVIEW_RECORDING_EARLIER.map(problem => ({ ...problem })) };
}
export function prepareReviewRecording(name: ReviewRecordingName, head: string, attemptId: string): PreparedReview {
  return prepareReview(reviewRecordingInput(name, head, attemptId));
}
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The prompt names the commit, not file contents, so the contents are hashed on their own. */
export const reviewRecordingFilesSha256 = () => sha256(JSON.stringify(Object.entries(REVIEW_RECORDING_FILES).sort()));
/**
 * Hash of the exact argv lane D runs Claude with for this prompt and schema in the review phase. A lane D change to its
 * flags, tools or `--json-schema` handling makes a recording stale even when the image tag, prompt and schema are not.
 */
export function reviewCommandSha256(prompt: string, schemaText: string): string {
  const head = '0'.repeat(40);
  // A captured invocation is single-use, so each call captures a fresh throwaway one; none of it reaches the argv.
  const invocation = captureInvocation({ clone: { id: 'fingerprint', taskId: 'fingerprint', directory: '/fingerprint', head },
    phase: 'review', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: randomUUID(),
    runnerOwner: '0'.repeat(32), context: { snapshotId: 'fingerprint', planId: 'fingerprint', planRevision: 1,
      assignmentId: 'fingerprint', referencedCodeHash: head, stateVersion: 0 } });
  return sha256(JSON.stringify(createClaudeCommand(createPhasePolicy(invocation), prompt, schemaText).argv));
}

export const REVIEW_RECORDING_KIND = 'codeboost-review-recording';
export interface ReviewRecording {
  readonly kind: typeof REVIEW_RECORDING_KIND;
  readonly version: 1;
  /** Codex is refused in every phase (#93), so only Claude is recorded. */
  readonly vendor: 'claude';
  readonly name: ReviewRecordingName;
  readonly recordedAt: string;
  readonly provenance: {
    readonly image: string;
    readonly cliVersion: string;
    /** The adapters pass no model flag, so this names the CLI default rather than a pinned model. */
    readonly model: string;
    readonly phase: 'review';
  };
  readonly request: {
    readonly attemptId: string;
    readonly round: number;
    readonly revision: number;
    readonly head: string;
    readonly promptSha256: string;
    readonly schemaSha256: string;
    /** `reviewRecordingFilesSha256()` when recorded: the contents of the repository Claude read. */
    readonly filesSha256: string;
    /** `reviewCommandSha256()` when recorded: the argv lane D ran Claude with. */
    readonly commandSha256: string;
  };
  /** D's extracted output exactly as returned: Claude's schema-validated `structured_output`, as JSON text. */
  readonly output: string;
}

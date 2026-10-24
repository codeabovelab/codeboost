import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureInvocation } from '../../../agents/contract.ts';
import { createClaudeCommand, createPhasePolicy } from '../../../agents/policy.ts';
import type { Plan } from '../../../core/plan.ts';
import { reviewDiffs } from '../../../runner/review-diffs.ts';
import { prepareReview, type EarlierProblem, type PreparedReview, type ReviewDiff, type ReviewInput } from '../../../core/review-prompt.ts';

// The one finished task the review agent is recorded on (#201). scripts/record-review.ts commits these files to a
// scratch repository; test/review-recorded.test.ts rebuilds the same request and refuses a recording whose prompt,
// schema, files or Claude command differs.
//
// REVIEW_RECORDING_BASE_FILES are the code before the plan; REVIEW_RECORDING_FILES the code after both plan items
// below ran. P1 removes the call counter as planned, but its commit also weakens isLabelled(), which no item asked for:
// an unrelated edit inside a declared file, which only the review sees. P2 is not done as planned: its test calls
// label(3) once, so it cannot catch the bug its intent and its check describe. A review that reads the code and what
// changed finds both.
const PACKAGE_JSON = '{\n  "name": "example",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n';
export const REVIEW_RECORDING_BASE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': PACKAGE_JSON,
  'src/example.ts': [
    'let calls = 0;',
    '',
    '/** Returns a label for the given value. */',
    'export function label(value: number): string {',
    '  calls += 1;',
    '  return calls % 2 === 0 ? `even call: ${value}` : `value ${value}`;',
    '}',
    '',
    '/** Whether text is a label for a non-negative whole number. */',
    'export function isLabelled(text: string): boolean {',
    '  return /^value (0|[1-9][0-9]*)$/.test(text);',
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
export const REVIEW_RECORDING_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': PACKAGE_JSON,
  'src/example.ts': [
    '/** Returns a label for the given value. */',
    'export function label(value: number): string {',
    '  return `value ${value}`;',
    '}',
    '',
    '/** Whether text is a label for a non-negative whole number. */',
    'export function isLabelled(text: string): boolean {',
    '  return /^value /.test(text);',
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
/** The recording repository's two commits, and the diffs between them the review prompt carries. */
export interface ReviewRecordingCommits { readonly base: string; readonly head: string; readonly diffs: readonly ReviewDiff[] }
// A fixed author, committer and date give the same commits, and so the same prompt, on every run.
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'codeboost', GIT_AUTHOR_EMAIL: 'recording@codeboost.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'codeboost', GIT_COMMITTER_EMAIL: 'recording@codeboost.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/**
 * Make the recording repository in the empty directory `repository`: the base files as the first commit, then the
 * final files as the second. scripts/record-review.ts reviews it; test/review-recorded.test.ts makes it again to rebuild
 * the same request.
 */
export function buildReviewRecordingRepository(repository: string): ReviewRecordingCommits {
  const write = (files: Readonly<Record<string, string>>) => {
    for (const path of Object.keys(REVIEW_RECORDING_BASE_FILES)) rmSync(join(repository, path), { force: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
    git(repository, 'add', '--all');
  };
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '--quiet', '--initial-branch=main');
  write(REVIEW_RECORDING_BASE_FILES);
  git(repository, 'commit', '--quiet', '-m', 'Before the plan');
  const base = git(repository, 'rev-parse', 'HEAD');
  write(REVIEW_RECORDING_FILES);
  git(repository, 'commit', '--quiet', '-m', 'After the plan');
  const head = git(repository, 'rev-parse', 'HEAD');
  return { base, head, diffs: reviewDiffs(repository, base, head) };
}
export function reviewRecordingInput(name: ReviewRecordingName, commits: ReviewRecordingCommits, attemptId: string): ReviewInput {
  const round = name === 'claude-review-round1' ? 1 : 2;
  return { identity: { ...REVIEW_RECORDING_IDENTITY }, attemptId, round, plan: reviewRecordingPlan(), head: commits.head,
    base: commits.base, diffs: commits.diffs.map(entry => ({ ...entry })),
    issue: { ...REVIEW_RECORDING_ISSUE, comments: [...REVIEW_RECORDING_ISSUE.comments] }, approvedLessons: [],
    earlierProblems: round === 1 ? [] : REVIEW_RECORDING_EARLIER.map(problem => ({ ...problem })) };
}
export function prepareReviewRecording(name: ReviewRecordingName, commits: ReviewRecordingCommits, attemptId: string): PreparedReview {
  return prepareReview(reviewRecordingInput(name, commits, attemptId));
}
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The prompt names the commits and carries the diffs, not the files Claude read, so both versions are hashed. */
export const reviewRecordingFilesSha256 = () => sha256(JSON.stringify([Object.entries(REVIEW_RECORDING_BASE_FILES).sort(),
  Object.entries(REVIEW_RECORDING_FILES).sort()]));
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
    /** The commit the plan started from; the prompt carries the diffs from it to `head`. */
    readonly base: string;
    readonly promptSha256: string;
    readonly schemaSha256: string;
    /** `reviewRecordingFilesSha256()` when recorded: the base and final contents of the repository Claude read. */
    readonly filesSha256: string;
    /** `reviewCommandSha256()` when recorded: the argv lane D ran Claude with. */
    readonly commandSha256: string;
  };
  /** D's extracted output exactly as returned: Claude's schema-validated `structured_output`, as JSON text. */
  readonly output: string;
}

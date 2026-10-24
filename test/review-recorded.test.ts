import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_IMAGE, CLAUDE_VERSION } from '../agents/container/image.ts';
import { buildReviewRecordingRepository, prepareReviewRecording, type ReviewRecordingCommits, REVIEW_RECORDING_KIND, REVIEW_RECORDING_NAMES, reviewCommandSha256, reviewRecordingFilesSha256,
  reviewRecordingPlan, sha256, type ReviewRecording } from './fixtures/review/recording-inputs.ts';

// Real vendor output, captured by scripts/record-review.ts through lane D's review phase (#201). These tests replay it
// through the review answer's validation. They never edit the output: a rejected recording is a prompt or schema finding.
const directory = fileURLToPath(new URL('./fixtures/review/recorded/', import.meta.url));
const names = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort() : [];
const load = (name: string): ReviewRecording => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
// The recording repository made again: its fixed Git identity and dates give the same commits and diffs as recorded.
let made: { root: string; commits: ReviewRecordingCommits } | undefined;
beforeAll(async () => {
  if (!names.length) return;
  const root = mkdtempSync(join(tmpdir(), 'review-recorded-repo-'));
  made = { root, commits: await buildReviewRecordingRepository(join(root, 'repository')) };
});
const commits = () => made!.commits;
afterAll(() => { if (made) rmSync(made.root, { recursive: true, force: true }); });

it('has a Claude recording for each round', () => {
  // Fails until scripts/record-review.ts has been run with credentials. Synthetic fixtures do not satisfy it.
  expect(names).toEqual([...REVIEW_RECORDING_NAMES]);
});

describe.each(names)('recorded %s', name => {
  const recording = load(name);

  it('was captured by the current image, CLI and review phase', () => {
    expect(recording.name).toBe(name);
    expect(recording).toMatchObject({ kind: REVIEW_RECORDING_KIND, version: 1, vendor: 'claude' });
    expect(recording.provenance).toMatchObject({ image: AGENT_IMAGE, phase: 'review', cliVersion: CLAUDE_VERSION });
    expect(typeof recording.output).toBe('string');
  });

  it('answers the files, prompt, schema and Claude command used today', () => {
    // A changed prompt, template, schema, input file or lane D command makes the recording stale: record again
    // rather than replay it.
    const prepared = prepareReviewRecording(recording.name, commits(), recording.request.attemptId);
    expect(reviewRecordingFilesSha256()).toBe(recording.request.filesSha256);
    expect([commits().base, commits().head]).toEqual([recording.request.base, recording.request.head]);
    expect(sha256(prepared.request.prompt)).toBe(recording.request.promptSha256);
    expect(sha256(prepared.request.schemaText)).toBe(recording.request.schemaSha256);
    expect(reviewCommandSha256(prepared.request.prompt, prepared.request.schemaText)).toBe(recording.request.commandSha256);
    expect(prepared.request).toMatchObject({ round: recording.request.round, revision: recording.request.revision });
  });

  it('validates as problems filed against plan items', () => {
    const prepared = prepareReviewRecording(recording.name, commits(), recording.request.attemptId);
    const problems = prepared.validate(recording.output);
    const ids = reviewRecordingPlan().items.map(item => item.id);
    for (const problem of problems) {
      expect(ids).toContain(problem.item);
      expect(problem.summary.length).toBeGreaterThan(0);
      expect(problem.detail.length).toBeGreaterThan(0);
    }
    // The recorded code leaves P2's test calling label(3) once (see recording-inputs.ts), in both rounds. A review
    // that finds nothing there did not read the code.
    expect(problems.some(problem => problem.item === 'P2')).toBe(true);
    // P1's commit also weakened isLabelled(), which no item asked for. Only a review that reads what changed sees it.
    expect(problems.some(problem => problem.item === 'P1' && /isLabelled/.test(`${problem.summary} ${problem.detail}`))).toBe(true);
  });
});

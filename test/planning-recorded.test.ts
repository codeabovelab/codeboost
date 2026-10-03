import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_IMAGE, CLAUDE_VERSION } from '../agents/container/image.ts';
import type { AuthorRequest } from '../core/planning-author.ts';
import { SuggestionCoordinator } from '../core/planning-suggestions.ts';
import { Store } from '../runner/store.ts';
import { planningCommandSha256, prepareRecording, RECORDING_KIND, recordingContext, recordingFilesSha256, recordingInput,
  recordingPreviousPlan, sha256,
  type PlanningRecording } from './fixtures/planning/recording-inputs.ts';

// Real vendor output, captured by scripts/record-planning.ts through lane D's planning container. These tests replay
// it through E2 validation and E3/Store. They never edit the output: a rejected recording is a prompt or schema finding.
const directory = new URL('./fixtures/planning/recorded/', import.meta.url).pathname;
// Codex is refused in every phase (#93), so only Claude is recorded.
const expected = ['claude-draft', 'claude-suggest'];
const names = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort() : [];
const load = (name: string): PlanningRecording => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'planning-recorded-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const open = () => { const store = new Store(path); cleanup.push(() => store.close()); return store; };
  return { store: open(), open };
}

it('has a Claude recording for each mode', () => {
  // Fails until scripts/record-planning.ts has been run with credentials. Synthetic fixtures do not satisfy it.
  expect(names).toEqual(expected);
});

describe.each(names)('recorded %s', name => {
  const recording = load(name);

  it('was captured by the current image, CLI and planning phase', () => {
    expect(`${recording.vendor}-${recording.mode}`).toBe(name);
    expect(recording).toMatchObject({ kind: RECORDING_KIND, version: 1 });
    expect(recording.provenance).toMatchObject({ image: AGENT_IMAGE, phase: 'planning',
      cliVersion: CLAUDE_VERSION });
    expect(typeof recording.output).toBe('string');
  });

  it('answers the files, prompt, schema and Claude command used today', () => {
    // A changed prompt, template, schema, input file or lane D command makes the recording stale: record again
    // rather than replay it.
    const prepared = prepareRecording(recording.mode, recording.request.baseSha, recording.request.requestId);
    expect(recordingFilesSha256()).toBe(recording.request.filesSha256);
    expect(sha256(prepared.request.prompt)).toBe(recording.request.promptSha256);
    expect(sha256(prepared.request.schemaText)).toBe(recording.request.schemaSha256);
    expect(planningCommandSha256(prepared.request.prompt, prepared.request.schemaText)).toBe(recording.request.commandSha256);
    expect(prepared.request).toMatchObject({ revision: recording.request.revision, issue: recording.request.issue });
  });

  if (recording.mode === 'draft') {
    it('validates as a revision-one plan and persists unchanged across a reopen', () => {
      const { baseSha, requestId } = recording.request, context = recordingContext();
      const validated = prepareRecording('draft', baseSha, requestId).validate(recording.output);
      const f = storeFixture();
      // The Store parses the raw output again; it must agree with E2's validation.
      const created = f.store.createPlan(recording.output, 'json', context, baseSha, baseSha);
      expect(created).toEqual(validated.value);
      expect(created).toMatchObject({ revision: 1, issue: recording.request.issue });
      expect(created.items.length).toBeGreaterThan(0);
      expect(f.open().getPlan(context.identity)).toEqual(validated.value);
    });
  } else {
    it('publishes as independent cards through E3 and applies one after a reopen', async () => {
      const { baseSha } = recording.request, context = recordingContext(), f = storeFixture();
      f.store.createPlan(JSON.stringify(recordingPreviousPlan()), 'json', context, baseSha, baseSha);
      const calls: AuthorRequest[] = [];
      const coordinator = new SuggestionCoordinator(f.store,
        { async invoke(request) { calls.push(request); return recording.output; } });
      const input = recordingInput('suggest', baseSha, 'unused');
      const request = coordinator.start({ context, revision: 1, snapshotId: f.store.getSnapshot(context.identity).id,
        repo: input.repo, issue: input.issue, approvedLessons: input.approvedLessons, feedback: input.feedback });
      const result = await request.result;
      await coordinator.close();
      expect(result, 'reason' in result ? result.reason : undefined).toMatchObject({ state: 'completed' });
      // E3 sends the vendor the same prompt the recording answered.
      expect(sha256(calls[0]!.prompt)).toBe(recording.request.promptSha256);
      const reopened = f.open(), stored = reopened.getSuggestions(context.identity, request.id);
      expect(stored.state).toBe('ready');
      expect(stored.reply!.edits.length).toBeGreaterThan(0);
      const applied = reopened.applySuggestion(context.identity, request.id, 0, context);
      expect(applied.revision).toBe(2);
      expect(reopened.getPlan(context.identity, 1)).toEqual(recordingPreviousPlan());
      expect(() => f.store.applySuggestion(context.identity, request.id, 0, context)).toThrow(/unavailable/);
    });
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseClaudeOutput } from '../agents/adapters/claude.ts';
import { OUTPUT_LIMITS } from '../agents/adapters/supervisor.ts';
import { SuggestionCoordinator } from '../core/planning-suggestions.ts';
import { Store } from '../runner/store.ts';
import { recordingContext, recordingInput, recordingPreviousPlan } from './fixtures/planning/recording-inputs.ts';

// Planning runs Claude with `--json-schema` (#75). Lane D reads the `structured_output` object from Claude's envelope
// and returns it as JSON text; E2 parses at most 1 MiB of that text. These cases cross both boundaries with synthetic
// envelopes: they test the parsers, not what Claude returns.
const HEAD = 'a'.repeat(40), MIB = 1024 * 1024;
const reply = (text = 'Retitle P1.') => ({ schema_version: 1, base_revision: 1, reply: text, edits: [
  { op: 'set_field', item: 'P1', summary: 'Retitle', reason: 'Clearer.', field: 'title', value: 'Make label() pure',
    file: null, check: null, check_index: null, depends_on: null, new_item: null }] });
/**
 * A reply whose compact JSON is exactly `bytes` long, padded inside its `reply` text. The schema caps that text at
 * 4000 characters, so a padded reply is never valid: it shows which check rejects it, size or schema.
 */
function replyOfSize(bytes: number) {
  const base = Buffer.byteLength(JSON.stringify(reply('')));
  return reply('x'.repeat(bytes - base));
}
const envelope = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify({ type: 'result', is_error: false, ...fields }));
const structured = (answer: unknown) => envelope({ subtype: 'success', result: 'Here is the plan.', structured_output: answer });
const extract = (raw: Buffer) => parseClaudeOutput(raw, true);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** Send extracted text through E3 and the real Store; return the durable request and plan revision. */
async function publish(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'planning-extraction-')); dirs.push(dir);
  const store = new Store(join(dir, 'state.sqlite')), context = recordingContext();
  try {
    store.createPlan(JSON.stringify(recordingPreviousPlan()), 'json', context, HEAD, HEAD);
    const coordinator = new SuggestionCoordinator(store, { async invoke() { return text; } });
    const input = recordingInput('suggest', HEAD, 'unused');
    const request = coordinator.start({ context, revision: 1, snapshotId: store.getSnapshot(context.identity).id,
      repo: input.repo, issue: input.issue, approvedLessons: [], feedback: input.feedback });
    await request.result; await coordinator.close();
    return { stored: store.getSuggestions(context.identity, request.id), revision: store.getPlan(context.identity).revision };
  } finally { store.close(); }
}

it.each([
  ['no is_error field', Buffer.from('{"subtype":"success","structured_output":{}}')],
  ['a non-string result', envelope({ subtype: 'success', result: { schema_version: 1 }, structured_output: {} })],
  ['no subtype', envelope({ result: 'Done.', structured_output: reply() })],
  ['no structured_output', envelope({ subtype: 'success', result: JSON.stringify(reply()) })],
  ['a null structured_output', structured(null)],
  ['an array structured_output', structured([reply()])],
  ['a string structured_output', structured(JSON.stringify(reply()))],
  ['a truncated envelope', structured(reply()).subarray(0, 40)],
  ['an empty stream', Buffer.alloc(0)],
  ['invalid UTF-8', Buffer.concat([Buffer.from('{"result":"'), Buffer.from([0xc3, 0x28]),
    Buffer.from('","is_error":false,"subtype":"success","structured_output":{}}')])],
])('refuses a planning envelope with %s at the extraction boundary', (_, raw) => {
  expect(() => extract(raw)).toThrow();
});

it.each([
  ['is_error', envelope({ subtype: 'success', is_error: true, result: 'Credit balance is too low' })],
  ['a non-success subtype', envelope({ subtype: 'error_max_turns', result: 'Ran out of turns' })],
])('reports %s as a provider failure, not as plan text', (_, raw) => {
  expect(extract(raw)).toMatchObject({ providerFailed: true });
});

it('returns structured_output as JSON text and ignores Claude\'s prose result', () => {
  const answer = reply();
  expect(extract(structured(answer))).toEqual({ text: JSON.stringify(answer), providerFailed: false });
});

it('fits 1 MiB of structured output, E2\'s size limit, inside lane D\'s stdout limit', () => {
  const answer = replyOfSize(MIB), raw = structured(answer);
  expect(raw.byteLength).toBeGreaterThan(MIB);
  expect(raw.byteLength).toBeLessThanOrEqual(OUTPUT_LIMITS.stdoutBytes);
  expect(Buffer.byteLength(extract(raw).text)).toBe(MIB);
});

it('passes exactly 1 MiB of extracted text to schema validation, not the size limit', async () => {
  const { stored, revision } = await publish(extract(structured(replyOfSize(MIB))).text);
  expect(stored).toMatchObject({ state: 'failed', reply: null });
  expect(stored.reason).toMatch(/\/reply/);
  expect(stored.reason).not.toMatch(/exceeds 1 MiB/);
  expect(revision).toBe(1);
});

it('publishes a schema-valid reply extracted from an envelope', async () => {
  const { stored, revision } = await publish(extract(structured(reply())).text);
  expect(stored).toMatchObject({ state: 'ready', reason: null });
  expect(stored.reply!.edits).toHaveLength(1);
  expect(revision).toBe(1);
});

it.each([
  ['one byte over 1 MiB', replyOfSize(MIB + 1), /exceeds 1 MiB/],
  // Claude checks the schema too, but E2 must not trust that check.
  ['an empty object', {}, /must have required property 'schema_version'/],
  ['a reply for another revision', { ...reply(), base_revision: 2 }, /Response revision mismatch/],
  ['an extra field', { ...reply(), note: 'extra' }, /must NOT have additional properties/],
])('records %s as a durable failure without a new revision', async (_, answer, reason) => {
  const { stored, revision } = await publish(extract(structured(answer)).text);
  expect(stored).toMatchObject({ state: 'failed', reply: null, reason });
  expect(revision).toBe(1);
});

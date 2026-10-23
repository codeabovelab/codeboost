import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeClaudeAnswer, parseClaudeOutput, readAnswerSchema, startClaudeInvocation } from '../agents/adapters/claude.ts';
import { startCodexInvocation } from '../agents/adapters/codex.ts';
import { isInvocationActive, OUTPUT_LIMITS, retainSetupCleanup } from '../agents/adapters/supervisor.ts';
import { capAdapterInvocationBudget, createAdapterInvocationBudget, createInvocationBudget } from '../agents/adapters/types.ts';
import { captureInvocation } from '../agents/contract.ts';
import { MAX_PLANNING_INPUT_BYTES } from '../agents/policy.ts';
import { MAX_SOURCE_BYTES } from '../core/parse-v1.ts';
import { prepareDraft } from '../core/planning-author.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const SCHEMA_TEXT = '{"type":"object"}';

describe('production agent adapters', () => {
  const capturedInvocation = (attemptId: string, deadline: number, vendor: 'codex' | 'claude' = 'codex') =>
    captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'review', vendor, approvedArgv: [], deadline, attemptId,
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a',
        referencedCodeHash: 'c', stateVersion: 1 },
    }, deadline - 1);

  it('parses recorded Claude success and failure envelopes', () => {
    expect(parseClaudeOutput(Buffer.from('{"result":"planned","is_error":false}')))
      .toEqual({ text: 'planned', providerFailed: false });
    expect(parseClaudeOutput(Buffer.from('{"result":"login required","is_error":true}')))
      .toEqual({ text: 'login required', providerFailed: true });
    expect(() => parseClaudeOutput(Buffer.from('{"result":3,"is_error":false}'))).toThrow('malformed');
    expect(() => parseClaudeOutput(Buffer.from('not json'))).toThrow();
    expect(() => parseClaudeOutput(Buffer.from([0xff]))).toThrow();
  });

  it('reads planning and review answers from structured_output, and every other phase\'s from its result (#201)', () => {
    // Claude Code 2.1.281 wrote this shape for the planning recordings in test/fixtures/planning/recorded, which this
    // decoder read from the real envelope: `subtype` "success", `is_error` false, and the schema-checked answer object in
    // `structured_output`. Members the decoder does not read, such as usage and session_id, are left out. A run without
    // `--json-schema` has no `structured_output`; one envelope with both members checks that those phases ignore it.
    const envelope = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"prose","structured_output":{"round":1,"problems":[]}}');
    for (const phase of ['planning', 'review'] as const) expect(decodeClaudeAnswer(phase, envelope)).toEqual({ text: '{"round":1,"problems":[]}', providerFailed: false });
    for (const phase of ['questions', 'execute', 'fix'] as const) expect(decodeClaudeAnswer(phase, envelope)).toEqual({ text: 'prose', providerFailed: false });
  });

  it('returns schema-constrained Claude answers from structured_output, not the prose result', () => {
    const success = '{"type":"result","subtype":"success","is_error":false,"result":"Here is the plan.",'
      + '"structured_output":{"title":"Plan","items":[]}}';
    expect(parseClaudeOutput(Buffer.from(success), true))
      .toEqual({ text: '{"title":"Plan","items":[]}', providerFailed: false });
    // Without a schema the prose result is still the answer.
    expect(parseClaudeOutput(Buffer.from(success))).toEqual({ text: 'Here is the plan.', providerFailed: false });
    // A failed structured run can omit result; it is a provider failure, not malformed output, and its errors are
    // the text.
    expect(parseClaudeOutput(Buffer.from(
      '{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"errors":["x"]}'), true))
      .toEqual({ text: 'x', providerFailed: true });
    for (const missing of ['{"subtype":"success","result":"{\\"title\\":\\"Plan\\"}","is_error":false}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":null}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":[1]}',
      '{"subtype":"success","result":"","is_error":false,"structured_output":"text"}'])
      expect(() => parseClaudeOutput(Buffer.from(missing), true)).toThrow('no structured output');
    // A schema-constrained answer needs an explicit success subtype; plain text keeps accepting envelopes without one.
    expect(() => parseClaudeOutput(Buffer.from('{"is_error":false,"structured_output":{}}'), true)).toThrow('malformed');
    expect(parseClaudeOutput(Buffer.from('{"is_error":false,"result":"ok"}'))).toEqual({ text: 'ok', providerFailed: false });
    expect(() => parseClaudeOutput(Buffer.from('{"structured_output":{}}'), true)).toThrow('malformed');
  });

  it.each([false, true])('treats any non-success subtype as a provider failure (structured: %s)', structured => {
    for (const envelope of ['{"subtype":"error_max_turns","is_error":false,"structured_output":{"a":1}}',
      '{"subtype":"error_during_execution","is_error":true}',
      '{"subtype":"error_max_structured_output_retries","is_error":false,"result":"gave up"}',
      // What Claude Code 2.1.281 (macOS arm64 build) wrote, with exit status 1, when `--max-turns 1` stopped a real
      // run (#163): no result member, and an errors list. Members the parser does not read, such as usage, are left out.
      '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":2,"errors":["Reached maximum number of turns (1)"]}'])
      expect(parseClaudeOutput(Buffer.from(envelope), structured)).toMatchObject({ providerFailed: true });
    expect(parseClaudeOutput(Buffer.from('{"subtype":"error_max_turns","is_error":true,'
      + '"errors":["Reached maximum number of turns (50)",3]}'), structured))
      .toEqual({ text: 'Reached maximum number of turns (50)', providerFailed: true });
    expect(parseClaudeOutput(Buffer.from('{"subtype":"error_during_execution","is_error":true,"result":"r","errors":["e"]}'),
      structured)).toEqual({ text: 'r', providerFailed: true });
    expect(parseClaudeOutput(Buffer.from('{"subtype":"error_during_execution","is_error":true,"result":"","errors":["e"]}'),
      structured)).toEqual({ text: 'e', providerFailed: true });
    expect(() => parseClaudeOutput(Buffer.from('{"subtype":1,"is_error":false,"result":"x"}'), structured))
      .toThrow('malformed');
    expect(() => parseClaudeOutput(Buffer.from('{"subtype":"success","is_error":false,"result":3}'), structured))
      .toThrow('malformed');
  });

  it('reads the planning schema exactly, refusing links, FIFOs, oversized and invalid UTF-8 files', () => {
    const root = mkdtempSync(join(tmpdir(), 'planning-schema-'));
    try {
      const dir = (name: string, write: (file: string) => void) => {
        const directory = join(root, name); execFileSync('mkdir', [directory]); write(join(directory, 'schema.json'));
        return directory;
      };
      const text = '{"type":"object"}\n';
      // The reader returns the exact text; the command builder validates it.
      expect(readAnswerSchema(dir('valid', file => writeFileSync(file, text)), 'Planning schema')).toBe(text);
      const target = join(root, 'target.json'); writeFileSync(target, text);
      expect(() => readAnswerSchema(dir('link', file => symlinkSync(target, file)), 'Planning schema')).toThrow('not a link');
      // A FIFO with no writer would block a plain open forever.
      expect(() => readAnswerSchema(dir('fifo', file => execFileSync('mkfifo', [file])), 'Planning schema')).toThrow('regular file');
      expect(() => readAnswerSchema(dir('big', file => writeFileSync(file, `{"d":"${'x'.repeat(64 * 1024)}"}`)), 'Planning schema'))
        .toThrow('bounded');
      expect(() => readAnswerSchema(dir('binary', file => writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]))), 'Planning schema'))
        .toThrow('not valid');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads the answer schema before allocating anything, and only in planning and review', () => {
    const missing = { filesystems: {} as never, inputDirectory: '/nonexistent-codeboost-input',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() };
    const planning = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase: 'planning', vendor: 'claude', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: 'claude-schema',
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
    });
    expect(() => startClaudeInvocation({ ...missing, invocation: planning }, 'token')).toThrow('ENOENT');
    expect(isInvocationActive(planning.attemptId)).toBe(false);
    // An invalid schema is refused by the command builder, also before anything is allocated.
    const root = mkdtempSync(join(tmpdir(), 'planning-invalid-'));
    try {
      writeFileSync(join(root, 'schema.json'), '{"type":"array"}');
      const invalid = captureInvocation({ ...planning, attemptId: 'claude-invalid-schema' });
      expect(() => startClaudeInvocation({ ...missing, inputDirectory: root, invocation: invalid }, 'token'))
        .toThrow('"type": "object"');
      expect(isInvocationActive(invalid.attemptId)).toBe(false);
      // A request over the planning model budget is refused there too (#163).
      writeFileSync(join(root, 'schema.json'), SCHEMA_TEXT);
      const overBudget = captureInvocation({ ...planning, attemptId: 'claude-over-budget' });
      const prompt = 'p'.repeat(MAX_PLANNING_INPUT_BYTES - Buffer.byteLength(SCHEMA_TEXT) + 1);
      expect(() => startClaudeInvocation({ ...missing, prompt, inputDirectory: root, invocation: overBudget }, 'token'))
        .toThrow('model budget');
      expect(isInvocationActive(overBudget.attemptId)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(isInvocationActive(planning.attemptId)).toBe(false);
    // A Claude review returns its problems as JSON, so it reads the schema too (#201).
    const review = captureInvocation({ ...planning, phase: 'review', attemptId: 'claude-review-schema' });
    expect(() => startClaudeInvocation({ ...missing, invocation: review }, 'token')).toThrow('ENOENT');
    expect(isInvocationActive(review.attemptId)).toBe(false);
    // Questions carry no schema, so the same request gets past the schema read to the image check.
    const questions = captureInvocation({ ...planning, phase: 'questions', attemptId: 'claude-no-schema' });
    expect(() => startClaudeInvocation({ ...missing, invocation: questions }, 'token')).toThrow('Agent image');
  });

  it.each(['planning', 'questions', 'review', 'execute', 'fix'] as const)(
    'refuses a Codex %s invocation synchronously, allocating nothing (#93)',
    phase => {
      const invocation = captureInvocation({ runnerOwner: TEST_RUNNER_OWNER,
        clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
        phase, vendor: 'codex', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: `codex-${phase}`,
        context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
      });
      expect(() => startCodexInvocation({ invocation, filesystems: {} as never, inputDirectory: '/unused',
        imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() }, '/unused/auth.json'))
        .toThrow(`Codex cannot run the ${phase} phase`);
      expect(isInvocationActive(invocation.attemptId)).toBe(false);
    });

  // Fixtures at the two bounds a planning answer meets: the raw stdout ceiling and the 1 MiB plan parser limit.
  const structuredEnvelope = (answer: string, bytes: number) => {
    const head = '{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":', tail = '}';
    const padding = bytes - Buffer.byteLength(head + answer + tail);
    if (padding < 0) throw new Error('Fixture answer exceeds the envelope size.');
    // Insignificant whitespace pads the envelope without changing the decoded answer.
    return Buffer.from(head + ' '.repeat(padding) + answer + tail);
  };
  it('decodes a Claude envelope as large as the stdout ceiling into the same structured answer', () => {
    const answer = JSON.stringify({ summary: 'x'.repeat(4 * 1024 * 1024) });
    const raw = structuredEnvelope(answer, OUTPUT_LIMITS.stdoutBytes);
    expect(raw.length).toBe(OUTPUT_LIMITS.stdoutBytes);
    // Compared without a diff: on a mismatch, vitest would spend minutes diffing megabyte strings instead of failing.
    const decoded = parseClaudeOutput(raw, true);
    expect(decoded.providerFailed).toBe(false);
    expect(decoded.text.length).toBe(answer.length);
    expect(decoded.text === answer).toBe(true);
  });

  it('returns a structured answer as the exact text of structured_output in the envelope, whatever surrounds it', () => {
    // Spacing, escapes, number spellings and brackets inside strings all survive, and so do members on either side.
    const answer = '{ "summary" : "caf\\u00e9 } ] \\" \\\\", "n": [1e20, 1.0, -0E+0],\n "nested": {"a": [{}, []]} }';
    const raw = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"text with } and \\" in it",'
      + `"structured_output":\t${answer}\n, "usage": {"input_tokens": 1}, "end": null}`);
    expect(parseClaudeOutput(raw, true)).toEqual({ text: answer, providerFailed: false });
    expect(parseClaudeOutput(Buffer.from(`{"subtype":"success","is_error":false,"structured_output":${answer}}`), true).text)
      .toBe(answer);
  });

  // #166: re-encoding the answer once let a duplicate key or an inexact integer reach the plan parser already resolved.
  const validPlan = { schema_version: 1, issue: 1, revision: 1, summary: 'Plan', questions: [],
    items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }],
      acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
  const draft = () => prepareDraft({ context: { identity: { repositoryId: 'repo', taskId: 'task', planId: 'plan' }, issue: 1,
    baseEntries: [{ path: 'a', kind: 'file' }], pathKey: path => path, allowedCommands: [] }, requestId: 'request', revision: 1,
    repo: { name: 'repo', baseRef: 'main', baseSha: 'a'.repeat(40), paths: ['a'] },
    issue: { number: 1, title: 'Fix', body: '', comments: [] }, approvedLessons: [], feedback: '' });
  it.each([
    ['a duplicate key', JSON.stringify(validPlan).replace('"summary":"Plan"', '"summary":"Plan","summary":"Other"'), 'Duplicate key: summary'],
    ['an inexact integer', JSON.stringify(validPlan).replace('"revision":1', '"revision":1.0000000000000001'), 'Integer is not exactly representable.'],
  ])('lets draft validation refuse %s in a structured answer', (_case, answer, refusal) => {
    const { text } = parseClaudeOutput(structuredEnvelope(answer, answer.length + 256), true);
    // Compared without a diff, so a broken decoder fails at once rather than in a minutes-long diff of a large string.
    expect(text.length).toBe(answer.length);
    expect(text === answer).toBe(true);
    expect(() => draft().validate(text)).toThrow(refusal);
    // The same plan without the defect is accepted, so the refusal is the defect's.
    const valid = JSON.stringify(validPlan);
    expect(draft().validate(parseClaudeOutput(structuredEnvelope(valid, valid.length + 256), true).text).value).toEqual(validPlan);
  });

  it('refuses a structured envelope that repeats a top-level key, before reading what it reports', () => {
    for (const envelope of ['{"subtype":"success","is_error":false,"structured_output":{"a":1},"structured_output":{"a":2}}',
      '{"subtype":"success","is_error":true,"is_error":false,"structured_output":{"a":1}}',
      // The last is_error would otherwise make this a provider failure rather than a refusal.
      '{"subtype":"success","is_error":false,"is_error":true,"structured_output":{"a":1}}',
      // Keys are compared decoded, so another spelling of the same key is a repeat.
      '{"subtype":"success","is_error":false,"structured_output":{"a":1},"structured\\u005foutput":{"a":2}}'])
      expect(() => parseClaudeOutput(Buffer.from(envelope), true)).toThrow('malformed');
    // Without a schema the envelope is read as before.
    expect(parseClaudeOutput(Buffer.from('{"is_error":false,"result":"a","result":"b"}'))).toEqual({ text: 'b', providerFailed: false });
  });

  // The base refused these too. They guard the scanner's precondition: it is given only an object envelope.
  it.each(['[{"is_error":false}]', '[]', '"text"', 'true'])('refuses a structured envelope that is not an object: %s', envelope => {
    expect(() => parseClaudeOutput(Buffer.from(envelope), true)).toThrow('malformed');
  });

  it('finds structured_output however the envelope is spaced or its key is spelled', () => {
    for (const envelope of [' \r\n{ "subtype" : "success" , "is_error" : false , "structured_output" : {"a":1} } \n',
      '{"subtype":"success","is_error":false,"structured\\u005foutput":{"a":1}}'])
      expect(parseClaudeOutput(Buffer.from(envelope), true).text).toBe('{"a":1}');
  });

  it('applies the 1 MiB plan parser limit to the bytes of structured_output in the envelope, not to a re-encoding', () => {
    // Spacing inside the answer counts: re-encoded, this answer would be far below the limit.
    const answer = `{ "summary": "x" ${' '.repeat(MAX_SOURCE_BYTES)}}`;
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(answer)))).toBeLessThan(MAX_SOURCE_BYTES);
    const { text } = parseClaudeOutput(structuredEnvelope(answer, answer.length + 256), true);
    // Compared without a diff, so a broken decoder fails at once rather than in a minutes-long diff of a large string.
    expect(text.length).toBe(answer.length);
    expect(text === answer).toBe(true);
    expect(() => draft().validate(text)).toThrow('Input size exceeds 1 MiB.');
  });

  it('applies the 1 MiB plan parser limit to the decoded answer at the exact byte in draft validation', () => {
    const answerOf = (bytes: number) => JSON.stringify({ summary: 'x'.repeat(bytes - '{"summary":""}'.length) });
    for (const [bytes, accepted] of [[MAX_SOURCE_BYTES, true], [MAX_SOURCE_BYTES + 1, false]] as const) {
      const { text } = parseClaudeOutput(structuredEnvelope(answerOf(bytes), bytes + 1024), true);
      expect(Buffer.byteLength(text)).toBe(bytes);
      // At the limit the answer parses and fails only later, on its missing revision; one byte more fails in the parser.
      expect(() => draft().validate(text)).toThrow(accepted ? 'Response revision mismatch.' : 'Input size exceeds 1 MiB.');
    }
  });

  it('publishes immutable production output ceilings', () => {
    expect(OUTPUT_LIMITS).toEqual({ stdoutBytes: 16 * 1024 * 1024, stderrBytes: 4 * 1024 * 1024,
      combinedBytes: 20 * 1024 * 1024 });
    expect(Object.isFrozen(OUTPUT_LIMITS)).toBe(true);
  });

  it.each(['codex', 'claude'] as const)('rejects expired %s setup before allocating a network', vendor => {
    const invocation = capturedInvocation(`expired-${vendor}`, Date.now() - 1, vendor);
    const request = { invocation, filesystems: {} as never, inputDirectory: '/unused',
      imageId: `sha256:${'a'.repeat(64)}`, prompt: 'unused', networkAllocationId: randomUUID() };
    const start = () => vendor === 'codex'
      ? startCodexInvocation(request, '/unused/auth.json')
      : startClaudeInvocation(request, 'token');
    expect(start).toThrow('deadline expired during adapter setup');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('retains every colliding setup cleanup owner until all retries succeed', async () => {
    const invocation = capturedInvocation('setup-recovery', Date.now() + 60_000);
    let releaseFirst = false, releaseSecond = false;
    const first = retainSetupCleanup(invocation, () => {
      if (!releaseFirst) throw new Error('first still busy');
    }, new Error('startup failed'), new Error('cleanup failed'));
    const second = retainSetupCleanup(invocation, () => {
      if (!releaseSecond) throw new Error('second still busy');
    }, new Error('duplicate startup failed'), new Error('duplicate cleanup failed'));
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    releaseFirst = true;
    first.cancel('cancelled');
    await first.settled;
    expect(isInvocationActive(invocation.attemptId)).toBe(true);
    releaseSecond = true;
    second.cancel('cancelled');
    const result = await second.settled;
    expect(result.stopReason).toBe('cancelled');
    expect(result.stderr).toContain('[codeboost: cancelled:');
    expect(result.stderr).toContain('setup cleanup remains unsettled');
    expect(isInvocationActive(invocation.attemptId)).toBe(false);
  });

  it('does not extend an invocation budget when the wall clock moves backward', () => {
    const wall = Date.now();
    const invocation = capturedInvocation('monotonic-budget', wall + 5_000);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(wall).mockReturnValue(wall - 60_000);
    try {
      const remaining = createInvocationBudget(invocation, 1_000);
      expect(remaining()).toBeGreaterThan(0);
      expect(remaining()).toBeLessThanOrEqual(1_000);
    } finally { clock.mockRestore(); }
  });

  it('applies the configured timeout to the original adapter setup budget', () => {
    const invocation = capturedInvocation('configured-budget', Date.now() + 60_000);
    const remaining = createAdapterInvocationBudget(invocation, 250);
    expect(remaining()).toBeGreaterThan(0);
    expect(remaining()).toBeLessThanOrEqual(250);
    expect(() => createAdapterInvocationBudget(invocation, 10 * 60_000 + 1)).toThrow('ten-minute ceiling');
  });

  it('caps a carried monotonic budget without extending either deadline', () => {
    const carriedEnd = performance.now() + 60_000;
    const remaining = capAdapterInvocationBudget(() => Math.ceil(carriedEnd - performance.now()), 250);
    expect(remaining()).toBeGreaterThan(0);
    expect(remaining()).toBeLessThanOrEqual(250);
    expect(() => capAdapterInvocationBudget(() => 60_000, 10 * 60_000 + 1)).toThrow('ten-minute ceiling');
  });
});

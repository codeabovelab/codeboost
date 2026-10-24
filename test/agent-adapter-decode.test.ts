import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Phase } from '../agents/contract.ts';

// The Claude start call's own decoding (#201): with the setup and the supervisor stood in for, the decoder the start
// call hands the supervisor reads a planning or review answer from `structured_output`, and every other phase's answer
// from `result`. Nothing here runs Docker.
const seen = vi.hoisted(() => ({ decode: undefined as undefined | ((profile: unknown, raw: Buffer) => { text: string; providerFailed: boolean }) }));
vi.mock('../agents/adapters/setup.ts', () => ({
  setUpProfile: async (_request: unknown, _remaining: unknown, _signal: unknown, _options: unknown, start: (profile: unknown) => unknown) => start({}),
}));
vi.mock('../agents/adapters/supervisor.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/adapters/supervisor.ts')>(),
  launchInvocation: (invocation: { attemptId: string }, _budget: unknown,
    setup: (signal: AbortSignal, start: (profile: unknown, options: { decode: typeof seen.decode }) => unknown) => Promise<unknown>) => {
    void setup(new AbortController().signal, (_profile, options) => { seen.decode = options.decode; return {}; });
    return { attemptId: invocation.attemptId, settled: new Promise(() => undefined), cancel: () => undefined };
  },
}));
vi.mock('../agents/container/image.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../agents/container/image.ts')>(), assertBuiltAgentImage: () => {},
}));
const { startClaudeInvocation } = await import('../agents/adapters/claude.ts');
const { captureInvocation } = await import('../agents/contract.ts');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); seen.decode = undefined; });
// Claude Code 2.1.281 wrote this shape for the planning recordings in test/fixtures/planning/recorded, which this
// decoder read from the real envelope: `subtype` "success", `is_error` false, and the schema-checked answer object in
// `structured_output`. Members the decoder does not read, such as usage and session_id, are left out. A run without
// `--json-schema` has no `structured_output`; one envelope with both members checks that those phases ignore it.
const envelope = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"prose","structured_output":{"round":1,"problems":[]}}');

it.each([['planning', '{"round":1,"problems":[]}'], ['review', '{"round":1,"problems":[]}'], ['questions', 'prose'], ['execute', 'prose'], ['fix', 'prose']] as const)(
  'the %s start call decodes its answer from the right member', async (phase: Phase, text) => {
    const input = mkdtempSync(join(tmpdir(), 'codeboost-decode-')); dirs.push(input);
    writeFileSync(join(input, 'schema.json'), '{"type":"object"}');
    const invocation = captureInvocation({ runnerOwner: '0123456789abcdef0123456789abcdef',
      clone: { id: 'clone', taskId: 'task', directory: '/tmp/task', head: 'a'.repeat(40) },
      phase, vendor: 'claude', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: randomUUID(),
      context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 } });
    startClaudeInvocation({ invocation, filesystems: {} as never, inputDirectory: input, imageId: `sha256:${'a'.repeat(64)}`,
      prompt: 'Answer.', networkAllocationId: randomUUID() }, 'token');
    await vi.waitFor(() => expect(seen.decode).toBeTypeOf('function'));
    expect(seen.decode!({}, envelope)).toEqual({ text, providerFailed: false });
  });

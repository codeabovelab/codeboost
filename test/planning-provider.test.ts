import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems } from '../agents/container/storage.ts';
import { SuggestionCoordinator } from '../core/planning-suggestions.ts';
import { CODEX_PLANNING_REFUSED, createPlanningProvider, PlanningLeftovers, type PlanningDependencies } from '../runner/planning-provider.ts';
import { StopError } from '../runner/question-container.ts';
import { Store } from '../runner/store.ts';
import { prepareRecording, recordingContext, recordingInput, recordingPreviousPlan } from './fixtures/planning/recording-inputs.ts';

const HEAD = 'a'.repeat(40), OWNER = '0123456789abcdef0123456789abcdef';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Lane D stand-ins that record what the provider asked for. `result` settles the invocation unless it is held. */
function fakeDeps(result: Partial<InvocationResult> | 'hold' = {}, env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'token-1' }) {
  const events: string[] = [], captured: InvocationInput[] = [], cancels: StopReason[] = [];
  const started: { request: AgentAdapterRequest; credential: string; vendor: string; schema: string; inputFiles: string[]; inputWritable: boolean; schemaWritable: boolean }[] = [];
  let settle!: (value: Partial<InvocationResult>) => void;
  const filesystems = { keeper: 'keeper' } as unknown as TaskFilesystems;
  const start = (vendor: string) => (request: AgentAdapterRequest, credential: string): InvocationHandle => {
    events.push('start');
    started.push({ request, credential, vendor, schema: readFileSync(join(request.inputDirectory, 'schema.json'), 'utf8'),
      inputFiles: readdirSync(request.inputDirectory), inputWritable: (lstatSync(request.inputDirectory).mode & 0o222) !== 0,
      schemaWritable: (lstatSync(join(request.inputDirectory, 'schema.json')).mode & 0o222) !== 0 });
    const settled = new Promise<InvocationResult>(resolve => {
      settle = value => { events.push('settled'); resolve({ attemptId: request.invocation.attemptId,
        context: request.invocation.context, exitCode: 0, signal: null, stdout: '{}', stderr: '', ...value }); };
    });
    if (result !== 'hold') queueMicrotask(() => settle(result));
    return { attemptId: request.invocation.attemptId, settled, cancel: reason => { cancels.push(reason); } };
  };
  const deps: PlanningDependencies = {
    buildImage: () => { events.push('build'); return `sha256:${'b'.repeat(64)}`; },
    createClone: options => { events.push('clone'); return { id: 'clone', taskId: options.taskId, directory: options.parent, head: options.head }; },
    prepareFilesystems: () => { events.push('prepare'); return filesystems; },
    removeFilesystems: value => { expect(value).toBe(filesystems); events.push('remove'); },
    measureRepository: () => ({ checkoutBytes: 1_024, entries: 3, objectBytes: 2_048 }),
    capture: input => { captured.push(input); return Object.freeze(input); },
    startClaude: start('claude'), env,
  };
  return { deps, events, captured, started, cancels, settle: (value: Partial<InvocationResult>) => settle(value) };
}
const provider = (deps: PlanningDependencies, extra: { vendor?: 'claude' | 'codex'; retained?: PlanningLeftovers } = {}) =>
  createPlanningProvider({ vendor: extra.vendor ?? 'claude', repository: '/repo', head: HEAD, snapshotId: 'snapshot-1',
    runnerOwner: OWNER, deps, retained: extra.retained });
const draftRequest = (requestId = 'b3c1f3b2-6a55-4d7e-9a47-0c7c8f6f1a01') => prepareRecording('draft', HEAD, requestId).request;

it('runs a draft in the read-only planning phase with only the request schema mounted', async () => {
  const fake = fakeDeps({ stdout: '{"plan":true}\n' }), request = draftRequest();
  expect(await provider(fake.deps).invoke(request, new AbortController().signal)).toBe('{"plan":true}\n');
  expect(fake.captured[0]).toMatchObject({ phase: 'planning', vendor: 'claude', approvedArgv: [], runnerOwner: OWNER,
    attemptId: request.requestId, clone: { head: HEAD, taskId: `planning-${request.requestId}` },
    context: { snapshotId: 'snapshot-1', planId: 'recording-plan', planRevision: 1, referencedCodeHash: HEAD } });
  expect(fake.started[0]).toMatchObject({ vendor: 'claude', credential: 'token-1', inputFiles: ['schema.json'],
    inputWritable: false, schemaWritable: false, schema: request.schemaText });
  expect(fake.started[0]!.request.prompt).toBe(request.prompt);
  expect(JSON.stringify(fake.started[0]!.request)).not.toContain('token-1');
  expect(fake.events).toEqual(['build', 'clone', 'prepare', 'start', 'settled', 'remove']);
  expect(existsSync(fake.started[0]!.request.inputDirectory)).toBe(false);
});

it.each([
  ['a missing credential', {}, /CLAUDE_CODE_OAUTH_TOKEN/, draftRequest()],
  ['Codex, even when it is signed in (#93)', { CLAUDE_CODE_OAUTH_TOKEN: 'token-1', CODEX_HOME: '/codex' }, CODEX_PLANNING_REFUSED, draftRequest(), 'codex'],
  ['a request outside the planning phase', { CLAUDE_CODE_OAUTH_TOKEN: 'token-1' }, /read-only/, { ...draftRequest(), phase: 'execute' }, 'claude'],
  ['a writable request', { CLAUDE_CODE_OAUTH_TOKEN: 'token-1' }, /read-only/, { ...draftRequest(), access: 'read-write' }, 'claude'],
] as const)('refuses %s before any Docker or Git work', async (_, env, message, request, vendor = 'claude') => {
  const fake = fakeDeps({}, env);
  await expect(provider(fake.deps, { vendor }).invoke(request as never, new AbortController().signal)).rejects.toThrow(message);
  expect(fake.events).toEqual([]);
});

it.each([
  ['a capture failure', { stopReason: 'capture-failure' as const, exitCode: null }, 'Planning agent output could not be captured.'],
  ['an output-limit stop', { stopReason: 'output-limit' as const, exitCode: null }, 'Planning agent output exceeded its limit.'],
  ['a vendor error envelope', { exitCode: 1, stdout: 'Invalid API key' }, 'Claude could not write the plan. Check its sign-in and usage limits. Claude said: Invalid API key'],
  ['a missing exit code', { exitCode: null }, 'Claude stopped unexpectedly.'],
  ['a signal', { exitCode: null, signal: 'SIGKILL' }, 'Claude stopped unexpectedly (SIGKILL).'],
])('rejects %s instead of returning its output, after storage is released', async (_, result, message) => {
  const fake = fakeDeps({ stdout: '{"plan":true}', ...result });
  await expect(provider(fake.deps).invoke(draftRequest(), new AbortController().signal)).rejects.toThrow(message);
  expect(fake.events.slice(-2)).toEqual(['settled', 'remove']);
});

it.each([
  ['another attempt', (input: InvocationInput) => ({ attemptId: 'someone-else', context: input.context })],
  ['another plan revision', (input: InvocationInput) => ({ context: { ...input.context, planRevision: 2 } })],
  ['an extra context field', (input: InvocationInput) => ({ context: { ...input.context, extra: 1 } as never })],
])('rejects a result for %s', async (_, change) => {
  const fake = fakeDeps('hold'), pending = provider(fake.deps).invoke(draftRequest(), new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  fake.settle({ stdout: '{"plan":true}', ...change(fake.captured[0]!) });
  await expect(pending).rejects.toThrow('different attempt');
});

it('does no work for a request that is already aborted', async () => {
  const fake = fakeDeps(), controller = new AbortController();
  controller.abort(new Error('gone'));
  await expect(provider(fake.deps).invoke(draftRequest(), controller.signal)).rejects.toThrow('gone');
  expect(fake.events).toEqual([]);
});

it.each([
  [new StopError('Server stopped.', 'shutdown'), 'shutdown'],
  [new Error('Suggestion timed out.'), 'cancelled'],
] as const)('cancels lane D and settles only after the container does: %s', async (reason, stop) => {
  // Only a StopError carries a typed reason; any other abort, E3's own timeout included, reaches lane D as cancelled.
  const fake = fakeDeps('hold'), controller = new AbortController();
  let done = false;
  const pending = provider(fake.deps).invoke(draftRequest(), controller.signal).catch((error: Error) => error).finally(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(reason);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(fake.cancels).toEqual([stop]);
  expect(done).toBe(false);
  expect(fake.events).not.toContain('remove');
  fake.settle({ stopReason: stop, exitCode: null });
  expect(await pending).toBeInstanceOf(Error);
  expect(fake.events.slice(-2)).toEqual(['settled', 'remove']);
});

it('refuses later requests after lane D reports resources it could not release', async () => {
  const retained = new PlanningLeftovers(), fake = fakeDeps({ unreleased: [], stopReason: 'capture-failure', exitCode: null });
  await expect(provider(fake.deps, { retained }).invoke(draftRequest(), new AbortController().signal)).rejects.toThrow();
  const next = fakeDeps();
  await expect(provider(next.deps, { retained }).invoke(draftRequest('c4d2e4c3-7b66-4e8f-8b58-1d8d907f2b12'), new AbortController().signal))
    .rejects.toThrow(/cannot tell which Docker resources were left. Planning is off/);
  expect(next.events).toEqual([]);
});

it('marks an allocation lane D could not clean up as untracked, and refuses later requests', async () => {
  const retained = new PlanningLeftovers(), fake = fakeDeps();
  fake.deps.prepareFilesystems = () => { throw new AggregateError([new Error('docker rm failed')], 'setup cleanup'); };
  await expect(provider(fake.deps, { retained }).invoke(draftRequest(), new AbortController().signal)).rejects.toThrow('setup cleanup');
  expect(retained.storage.untracked).toBe(1);
  const next = fakeDeps();
  await expect(provider(next.deps, { retained }).invoke(draftRequest('d5e3f5d4-8c77-4f90-9c69-2e9ea18f3c23'), new AbortController().signal))
    .rejects.toThrow(/Planning is off until codeboost restarts/);
});

it('does not mark an ordinary setup failure as untracked', async () => {
  const retained = new PlanningLeftovers(), fake = fakeDeps();
  fake.deps.prepareFilesystems = () => { throw new Error('no space'); };
  await expect(provider(fake.deps, { retained }).invoke(draftRequest(), new AbortController().signal)).rejects.toThrow('no space');
  expect(retained.storage.untracked).toBe(0);
});

it('keeps storage Docker did not remove, refuses until it is removed, then runs again', async () => {
  const retained = new PlanningLeftovers(), fake = fakeDeps({ stdout: '{"plan":true}' });
  let removable = false;
  fake.deps.removeFilesystems = () => { if (!removable) throw new Error('docker volume rm failed'); };
  await expect(provider(fake.deps, { retained }).invoke(draftRequest(), new AbortController().signal))
    .rejects.toThrow('Planning container cleanup did not settle.');
  expect(retained.storage.size).toBe(1);
  await expect(provider(fake.deps, { retained }).invoke(draftRequest('e6f4a6e5-9d88-4a01-8d7a-3fafb2904d34'), new AbortController().signal))
    .rejects.toThrow(/Planning storage from an earlier request could not be removed \(1 allocation\)/);
  removable = true;
  expect(await provider(fake.deps, { retained }).invoke(draftRequest('f7a5b7f6-ae99-4b12-9e8b-4ab0c3a15e45'), new AbortController().signal))
    .toBe('{"plan":true}');
  expect(retained.storage.size).toBe(0);
});

it('never words a planning refusal as Ask', async () => {
  const retained = new PlanningLeftovers();
  retained.storage.retain({} as TaskFilesystems); retained.storage.markUntracked(); retained.retainRoot('/nonexistent-root');
  let message = '';
  try { retained.release(() => { throw new Error('still there'); }); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/Planning/);
  expect(message).not.toMatch(/Ask|question/);
});

it.each([
  ['a capture failure', { stopReason: 'capture-failure' as const, exitCode: null }, /could not be captured/],
  ['empty output', { stdout: '' }, /Invalid JSON value/],
  ['prose around the JSON', { stdout: 'Here is the plan:\n{"schema_version":1}' }, /Invalid JSON value/],
])('records %s as a durable failed suggestion without a new revision', async (_, result, reason) => {
  const dir = mkdtempSync(join(tmpdir(), 'planning-provider-store-')); roots.push(dir);
  const store = new Store(join(dir, 'state.sqlite')), context = recordingContext();
  try {
    store.createPlan(JSON.stringify(recordingPreviousPlan()), 'json', context, HEAD, HEAD);
    const fake = fakeDeps(result), coordinator = new SuggestionCoordinator(store, provider(fake.deps));
    const input = recordingInput('suggest', HEAD, 'unused');
    const request = coordinator.start({ context, revision: 1, snapshotId: store.getSnapshot(context.identity).id,
      repo: input.repo, issue: input.issue, approvedLessons: [], feedback: input.feedback });
    expect((await request.result).state).toBe('failed');
    await coordinator.close();
    expect(store.getSuggestions(context.identity, request.id)).toMatchObject({ state: 'failed', reply: null, reason });
    expect(store.getPlan(context.identity).revision).toBe(1);
    expect(fake.events.at(-1)).toBe('remove');
  } finally { store.close(); }
});

import { existsSync, lstatSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems } from '../agents/container/storage.ts';
import { askInContainer, type ContainerDependencies, type ContainerQuestion } from '../runner/question-container.ts';
import { QuestionWorker } from '../runner/question-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const question = (overrides: Partial<ContainerQuestion> = {}): ContainerQuestion => ({
  repository: '/repo', head: 'a'.repeat(40), snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 3, noteId: 'note-1',
  provider: 'claude', prompt: 'Why cap the retry delay?', attemptId: `attempt-${Math.random()}`, deadline: Date.now() + 60_000,
  ...overrides,
});

function fakeDeps(result: Partial<InvocationResult> = {}, env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'token-1' }) {
  const events: string[] = [];
  const captured: InvocationInput[] = [];
  const started: { request: AgentAdapterRequest; credential: string; vendor: string; inputFiles: string[]; inputWritable: boolean }[] = [];
  const cancels: StopReason[] = [];
  let settle!: (value: InvocationResult) => void;
  const filesystems = { keeper: 'keeper' } as unknown as TaskFilesystems;
  const start = (vendor: string) => (request: AgentAdapterRequest, credential: string): InvocationHandle => {
    events.push('start');
    started.push({ request, credential, vendor, inputFiles: readdirSync(request.inputDirectory),
      inputWritable: (lstatSync(request.inputDirectory).mode & 0o222) !== 0 });
    const settled = new Promise<InvocationResult>(resolve => { settle = value => { events.push('settled'); resolve(value); }; });
    if (result.stopReason === undefined) queueMicrotask(() => settle({ attemptId: request.invocation.attemptId,
      context: request.invocation.context, exitCode: 0, signal: null, stdout: 'The cap bounds latency.', stderr: '', ...result }));
    return { attemptId: request.invocation.attemptId, settled, cancel: reason => { cancels.push(reason); } };
  };
  const deps: ContainerDependencies = {
    buildImage: () => { events.push('build'); return `sha256:${'b'.repeat(64)}`; },
    createClone: options => { events.push('clone'); return { id: 'clone', taskId: options.taskId, directory: options.parent, head: options.head }; },
    prepareFilesystems: () => { events.push('prepare'); return filesystems; },
    removeFilesystems: value => { expect(value).toBe(filesystems); events.push('remove'); },
    capture: input => { captured.push(input); return Object.freeze(input); },
    startClaude: start('claude'), startCodex: start('codex'), env,
  };
  return { deps, events, captured, started, cancels, settle: (value: Partial<InvocationResult>) => settle({ attemptId: 'x',
    context: captured[0]!.context, exitCode: null, signal: null, stdout: '', stderr: '', ...value }) };
}

it('answers in the read-only questions phase against a clone of the reviewed head', async () => {
  const fake = fakeDeps();
  const answer = await askInContainer(question(), fake.deps, new AbortController().signal);
  expect(answer).toBe('The cap bounds latency.');
  const invocation = fake.captured[0]!;
  expect(invocation).toMatchObject({ phase: 'questions', vendor: 'claude', approvedArgv: [],
    clone: { head: 'a'.repeat(40), taskId: 'question-note-1' },
    context: { snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 3, assignmentId: 'note-1' } });
  expect(fake.started[0]).toMatchObject({ vendor: 'claude', credential: 'token-1', inputFiles: ['schema.json'], inputWritable: false });
  expect(fake.started[0]!.request.prompt).toBe('Why cap the retry delay?');
  expect(JSON.stringify(fake.started[0]!.request)).not.toContain('token-1');
  expect(fake.events).toEqual(['build', 'clone', 'prepare', 'start', 'settled', 'remove']);
  expect(existsSync(fake.started[0]!.request.inputDirectory)).toBe(false);
});

it('builds the agent image once per worker', async () => {
  const fake = fakeDeps(), image = {};
  await askInContainer(question(), fake.deps, new AbortController().signal, image);
  await askInContainer(question(), fake.deps, new AbortController().signal, image);
  expect(fake.events.filter(event => event === 'build')).toHaveLength(1);
});

it.each([['Agent timed out. Try again.', 'timeout'], ['Server stopped. Retry the question.', 'shutdown'], ['Anything else', 'cancelled']] as const)(
  'cancels the container with the matching reason and waits for it to settle: %s', async (message, reason) => {
    const fake = fakeDeps({ stopReason: reason });
    const controller = new AbortController();
    let done = false;
    const answer = askInContainer(question(), fake.deps, controller.signal).catch((error: Error) => error).finally(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new Error(message));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fake.cancels).toEqual([reason]);
    expect(done).toBe(false);
    expect(fake.events).not.toContain('remove');
    fake.settle({ stopReason: reason });
    expect(await answer).toBeInstanceOf(Error);
    expect(fake.events.slice(-2)).toEqual(['settled', 'remove']);
  });

it('reports a provider failure instead of its output', async () => {
  const fake = fakeDeps({ exitCode: 1, stdout: 'Invalid API key' });
  await expect(askInContainer(question(), fake.deps, new AbortController().signal)).rejects.toThrow('Claude could not answer. Check its sign-in and usage limits. Claude said: Invalid API key');
});

it('refuses to start without a Claude token, before any Docker or Git work', async () => {
  const fake = fakeDeps({}, {});
  await expect(askInContainer(question(), fake.deps, new AbortController().signal)).rejects.toThrow('CLAUDE_CODE_OAUTH_TOKEN');
  expect(fake.events).toEqual([]);
});

it('mounts the Codex auth file from CODEX_HOME and refuses when it is missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-')); roots.push(home);
  const missing = fakeDeps({}, { CODEX_HOME: home });
  await expect(askInContainer(question({ provider: 'codex' }), missing.deps, new AbortController().signal)).rejects.toThrow('auth.json');
  expect(missing.events).toEqual([]);
  writeFileSync(join(home, 'auth.json'), '{}');
  const present = fakeDeps({}, { CODEX_HOME: home });
  await askInContainer(question({ provider: 'codex' }), present.deps, new AbortController().signal);
  expect(present.started[0]).toMatchObject({ vendor: 'codex', credential: join(home, 'auth.json') });
});

it('releases storage when setup fails after allocation, and not before', async () => {
  const early = fakeDeps();
  early.deps.prepareFilesystems = () => { throw new Error('Repository exceeds its allocation.'); };
  await expect(askInContainer(question(), early.deps, new AbortController().signal)).rejects.toThrow('allocation');
  expect(early.events).not.toContain('remove');
  const late = fakeDeps();
  late.deps.capture = () => { throw new Error('capture refused'); };
  await expect(askInContainer(question(), late.deps, new AbortController().signal)).rejects.toThrow('capture refused');
  expect(late.events.at(-1)).toBe('remove');
});

it('stops before starting the container once the deadline has passed', async () => {
  const fake = fakeDeps();
  await expect(askInContainer(question({ deadline: Date.now() - 1 }), fake.deps, new AbortController().signal)).rejects.toThrow('timed out');
  expect(fake.events).not.toContain('start');
});

const scope = { repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n' };
const stubWorker = () => new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url));

it('returns the worker answer and forwards cancellation, settling only when the worker replies', async () => {
  const worker = stubWorker();
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope, 60_000)).toBe('claude:answer:n');
    const controller = new AbortController();
    let done = false;
    const pending = worker.agent('codex')('wait', controller.signal, scope, 60_000).catch((error: Error) => error).finally(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(done).toBe(false);
    controller.abort(new Error('Agent timed out. Try again.'));
    expect(((await pending) as Error).message).toBe('cancelled:Agent timed out. Try again.');
  } finally { await worker.close(); }
});

it('rejects pending questions when the worker crashes', async () => {
  const worker = stubWorker();
  try {
    await expect(worker.agent('claude')('crash', new AbortController().signal, scope, 60_000)).rejects.toThrow('worker stopped');
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope, 60_000)).toBe('claude:answer:n');
  } finally { await worker.close(); }
});

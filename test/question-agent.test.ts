import { fixtureGit } from './fixtures/git.ts';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { InvocationHandle, InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { TaskFilesystems } from '../agents/container/storage.ts';
import { askInContainer, CODEX_QUESTIONS_REFUSED, credentialEnvironment, measureGitRepository, RetainedStorage, StopError, workerEnvironment, type ContainerDependencies, type ContainerQuestion } from '../runner/question-container.ts';
import { dockerQueryEnvironment } from '../runner/question-leftovers.ts';
import { QuestionWorker } from '../runner/question-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const question = (overrides: Partial<ContainerQuestion> = {}): ContainerQuestion => ({
  repository: '/repo', head: 'a'.repeat(40), snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 3, noteId: 'note-1',
  provider: 'claude', prompt: 'Why cap the retry delay?', attemptId: `attempt-${Math.random()}`, contextId: 'c'.repeat(64),
  deadline: Date.now() + 60_000, runnerOwner: '0123456789abcdef0123456789abcdef',
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
    measureRepository: () => ({ checkoutBytes: 1_024, entries: 3, objectBytes: 2_048 }),
    capture: input => { captured.push(input); return Object.freeze(input); },
    startClaude: start('claude'), env,
  };
  return { deps, events, captured, started, cancels, settle: (value: Partial<InvocationResult>) => settle({ attemptId: captured[0]!.attemptId,
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

// The stop reason is read from the typed value; a message that merely mentions a timeout stays a cancellation.
it.each([
  [new StopError('Agent timed out. Try again.', 'timeout'), 'timeout'],
  [new StopError('Server stopped. Retry the question.', 'shutdown'), 'shutdown'],
  [new StopError('Please stop', 'cancelled'), 'cancelled'],
  [new Error('Agent timed out. Try again.'), 'cancelled'],
  [new Error('Server stopped. Retry the question.'), 'cancelled'],
] as const)(
  'cancels the container with the typed reason and waits for it to settle: %s', async (abortReason, reason) => {
    const fake = fakeDeps({ stopReason: reason });
    const controller = new AbortController();
    let done = false;
    const answer = askInContainer(question(), fake.deps, controller.signal).catch((error: Error) => error).finally(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(abortReason);
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

it('refuses Codex before any Docker work, even with a Codex sign-in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-')); roots.push(home);
  writeFileSync(join(home, 'auth.json'), '{}');
  const fake = fakeDeps({}, { CODEX_HOME: home, CODEBOOST_CODEX_AUTH_FILE: join(home, 'auth.json') });
  await expect(askInContainer(question({ provider: 'codex' }), fake.deps, new AbortController().signal))
    .rejects.toThrow(CODEX_QUESTIONS_REFUSED);
  expect(fake.events).toEqual([]);
  expect(fake.started).toEqual([]);
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

let attempts = 0;
const scope = () => ({ repository: '/repo', head: 'a'.repeat(40), snapshotId: 's', planId: 'p', planRevision: 1, noteId: 'n',
  attemptId: `attempt-${++attempts}`, contextId: 'c'.repeat(64) });
// The bridge checks sign-in before asking, so the stub needs the Claude credential.
const stubWorker = () => new QuestionWorker(new URL('./fixtures/question-worker-stub.ts', import.meta.url), undefined,
  { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });

it('returns the worker answer and forwards cancellation, settling only when the worker replies', async () => {
  const worker = stubWorker();
  try {
    expect(await worker.agent('claude')('answer', new AbortController().signal, scope(), 60_000)).toBe('claude:answer:n');
    // A review database that still names Codex is refused before the worker sees the question.
    await expect(worker.agent('codex')('answer', new AbortController().signal, scope(), 60_000))
      .rejects.toThrow(CODEX_QUESTIONS_REFUSED);
    const controller = new AbortController();
    let done = false;
    const pending = worker.agent('claude')('wait', controller.signal, scope(), 60_000).catch((error: Error) => error).finally(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(done).toBe(false);
    controller.abort(new StopError('Agent timed out. Try again.', 'timeout'));
    expect(((await pending) as Error).message).toBe('cancelled:timeout:Agent timed out. Try again.');
  } finally { await worker.close(); }
});

it('fails closed after the worker crashes instead of starting a replacement', async () => {
  const worker = stubWorker();
  try {
    await expect(worker.agent('claude')('crash', new AbortController().signal, scope(), 60_000)).rejects.toThrow('worker stopped');
    // The crashed worker's containers and storage may still exist, so no new worker may take their place.
    await expect(worker.agent('claude')('answer', new AbortController().signal, scope(), 60_000))
      .rejects.toThrow('Ask is off until codeboost restarts');
  } finally { await worker.close(); }
});

it('rejects a worker reply that carries another attempt identity', async () => {
  const worker = stubWorker();
  try {
    await expect(worker.agent('claude')('wrong-attempt', new AbortController().signal, scope(), 60_000))
      .rejects.toThrow('different question attempt');
  } finally { await worker.close(); }
});

it('binds the invocation to the persisted attempt and the assigned code hash', async () => {
  const fake = fakeDeps();
  await askInContainer(question({ attemptId: 'persisted-attempt', contextId: 'd'.repeat(64) }), fake.deps, new AbortController().signal);
  expect(fake.captured[0]).toMatchObject({ attemptId: 'persisted-attempt', context: { referencedCodeHash: 'd'.repeat(64) } });
});

it.each([
  ['another attempt', { attemptId: 'someone-else' }],
  ['another context', { context: { snapshotId: 'other', planId: 'plan-1', planRevision: 3, assignmentId: 'note-1', referencedCodeHash: 'c'.repeat(64), stateVersion: 0 } }],
] as const)('refuses an answer from %s', async (_label, override) => {
  const fake = fakeDeps(override as Partial<InvocationResult>);
  await expect(askInContainer(question(), fake.deps, new AbortController().signal)).rejects.toThrow('different question attempt');
});

it.each([
  ['no exit code', { exitCode: null }, 'Claude stopped unexpectedly. Try again.'],
  ['a signal', { exitCode: 0, signal: 'SIGKILL' }, 'Claude stopped unexpectedly (SIGKILL). Try again.'],
] as const)('refuses partial output after %s', async (_label, override, message) => {
  const fake = fakeDeps(override as Partial<InvocationResult>);
  await expect(askInContainer(question(), fake.deps, new AbortController().signal)).rejects.toThrow(message);
});

it.skipIf(process.getuid?.() === 0)('keeps a host copy of the code it could not delete and refuses Ask until it is gone', async () => {
  const retained = new RetainedStorage();
  // Stage inside a parent we control; making that parent read-only stops the staging directory from being removed.
  const parent = mkdtempSync(join(tmpdir(), 'ask-tmp-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  const fake = fakeDeps();
  const clone = fake.deps.createClone;
  fake.deps.createClone = options => { chmodSync(parent, 0o555); return clone(options); };
  try {
    await expect(askInContainer(question(), fake.deps, new AbortController().signal, {}, retained)).rejects.toThrow('cleanup did not settle');
    const [root] = retained.paths();
    expect(dirname(root!)).toBe(parent);
    expect(existsSync(root!)).toBe(true);
    const next = fakeDeps();
    await expect(askInContainer(question(), next.deps, new AbortController().signal, {}, retained)).rejects.toThrow('could not be deleted');
    expect(next.events).toEqual([]);
    chmodSync(parent, 0o700);
    expect(await askInContainer(question(), fakeDeps().deps, new AbortController().signal, {}, retained)).toBe('The cap bounds latency.');
    expect(existsSync(root!)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    chmodSync(parent, 0o700); rmSync(parent, { recursive: true, force: true });
  }
});

it('turns Ask off when D settles with resources it could not confirm removed', async () => {
  const retained = new RetainedStorage();
  const leaked = fakeDeps({ stopReason: 'capture-failure', exitCode: null,
    unreleased: [{ kind: 'container', name: 'codeboost-proxy-claude-x' }, { kind: 'directory', name: '/tmp/codeboost-auth-x' }] });
  const answer = askInContainer(question(), leaked.deps, new AbortController().signal, {}, retained);
  await vi.waitFor(() => expect(leaked.captured).toHaveLength(1));
  leaked.settle({ stopReason: 'capture-failure', unreleased: [{ kind: 'network', name: 'codeboost-egress-claude-x' }] });
  await expect(answer).rejects.toThrow();
  expect(retained.untracked).toBe(1);
  // No second invocation starts while those resources are unaccounted for.
  const next = fakeDeps();
  await expect(askInContainer(question(), next.deps, new AbortController().signal, {}, retained)).rejects.toThrow('cannot tell which Docker resources');
  expect(next.events).toEqual([]);
  // An empty list still means D stopped retrying before cleanup was confirmed.
  const empty = new RetainedStorage(), unnamed = fakeDeps({ stopReason: 'capture-failure' });
  const unnamedAnswer = askInContainer(question(), unnamed.deps, new AbortController().signal, {}, empty);
  await vi.waitFor(() => expect(unnamed.captured).toHaveLength(1));
  unnamed.settle({ stopReason: 'capture-failure', unreleased: [] });
  await expect(unnamedAnswer).rejects.toThrow();
  expect(empty.untracked).toBe(1);
  // A stop whose cleanup D confirmed leaves Ask on.
  const clean = new RetainedStorage(), stopped = fakeDeps({ stopReason: 'cancelled' });
  const stoppedAnswer = askInContainer(question(), stopped.deps, new AbortController().signal, {}, clean);
  await vi.waitFor(() => expect(stopped.captured).toHaveLength(1));
  stopped.settle({ stopReason: 'cancelled' });
  await expect(stoppedAnswer).rejects.toThrow();
  expect(clean.untracked).toBe(0);
});

it('turns Ask off when a failed setup leaves storage D cannot hand back', async () => {
  const retained = new RetainedStorage();
  const failed = fakeDeps();
  failed.deps.prepareFilesystems = () => { throw new AggregateError([new Error('seed failed'), new Error('remove failed')], 'Task allocation failed and cleanup did not settle.'); };
  await expect(askInContainer(question(), failed.deps, new AbortController().signal, {}, retained)).rejects.toThrow('cleanup did not settle');
  expect(retained.untracked).toBe(1);
  const next = fakeDeps();
  await expect(askInContainer(question(), next.deps, new AbortController().signal, {}, retained)).rejects.toThrow('cannot tell which Docker resources');
  expect(next.events).toEqual([]);
  // A setup failure whose cleanup D confirmed leaves nothing behind.
  const clean = new RetainedStorage(), plain = fakeDeps();
  plain.deps.prepareFilesystems = () => { throw new Error('Repository exceeds its allocation.'); };
  await expect(askInContainer(question(), plain.deps, new AbortController().signal, {}, clean)).rejects.toThrow('allocation');
  expect(clean.untracked).toBe(0);
});

it('keeps storage whose removal failed, refuses Ask until it is removed, then continues', async () => {
  const retained = new RetainedStorage();
  const first = fakeDeps();
  first.deps.removeFilesystems = () => { throw new Error('Docker did not confirm removal.'); };
  await expect(askInContainer(question(), first.deps, new AbortController().signal, {}, retained)).rejects.toThrow('cleanup did not settle');
  expect(retained.size).toBe(1);
  expect(retained.list().map(entry => entry.keeper)).toEqual(['keeper']);

  const blocked = fakeDeps();
  blocked.deps.removeFilesystems = () => { throw new Error('Docker is still down.'); };
  await expect(askInContainer(question(), blocked.deps, new AbortController().signal, {}, retained))
    .rejects.toThrow('could not be removed (1 allocation)');
  expect(blocked.events).toEqual([]);
  expect(retained.size).toBe(1);

  const recovered = fakeDeps();
  const removed: unknown[] = [];
  recovered.deps.removeFilesystems = value => { removed.push(value); };
  expect(await askInContainer(question(), recovered.deps, new AbortController().signal, {}, retained)).toBe('The cap bounds latency.');
  expect(retained.size).toBe(0);
  // The retained allocation from the first question, then this question's own.
  expect(removed).toHaveLength(2);
});

it('gives the worker an allowlisted environment and passes only the credential variables as data', () => {
  const env = { PATH: '/usr/bin', DOCKER_HOST: 'unix:///docker.sock', HOME: '/home/me', CLAUDE_CODE_OAUTH_TOKEN: 'secret-1',
    SSH_AUTH_SOCK: '/tmp/agent', AWS_ACCESS_KEY_ID: 'secret-2', DOCKER_CONFIG: '/home/me/.docker', CODEX_HOME: '/home/codex' };
  expect(workerEnvironment(env, '/tmp/codeboost-ask-abc123')).toEqual({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///docker.sock', TMPDIR: '/tmp/codeboost-ask-abc123' });
  expect(credentialEnvironment(env)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'secret-1' });
  expect(Object.keys(dockerQueryEnvironment()).sort()).toEqual(['DOCKER_HOST', 'PATH']);
});

it('starts the real bridge worker with exactly the allowlisted environment', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { SSH_AUTH_SOCK: '/tmp/agent', AWS_ACCESS_KEY_ID: 'secret', DOCKER_CONFIG: '/x' });
  const worker = stubWorker();
  try {
    const seen = JSON.parse(await worker.agent('claude')('env', new AbortController().signal, scope(), 60_000));
    expect(seen.env.filter((name: string) => !['PATH', 'DOCKER_HOST', 'TMPDIR'].includes(name))).toEqual([]);
    expect(seen.env).toContain('TMPDIR');
    expect(seen.credentials).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  } finally {
    await worker.close();
    for (const name of ['SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'DOCKER_CONFIG']) if (!(name in saved)) delete process.env[name];
  }
});

it.each([
  ['checkout bytes', { checkoutBytes: 513 * 1024 * 1024, entries: 1, objectBytes: 1 }],
  ['entries', { checkoutBytes: 1, entries: 131_073, objectBytes: 1 }],
  ['Git objects', { checkoutBytes: 1, entries: 1, objectBytes: 513 * 1024 * 1024 }],
] as const)('refuses a repository too large in %s before anything is copied to the host', async (_label, size) => {
  const fake = fakeDeps();
  fake.deps.measureRepository = () => size;
  await expect(askInContainer(question(), fake.deps, new AbortController().signal)).rejects.toThrow('too large for Ask');
  expect(fake.events).not.toContain('clone');
  expect(fake.events).not.toContain('prepare');
});

it('measures the checkout at the reviewed head and the object store with Git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'measure-')); roots.push(repo);
  const git = (...args: string[]) => fixtureGit(repo, ...args);
  git('init', '-q'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
  mkdirSync(join(repo, 'dir')); writeFileSync(join(repo, 'dir', 'a.txt'), 'x'.repeat(1000)); writeFileSync(join(repo, 'b.txt'), 'y'.repeat(24));
  git('add', '.'); git('commit', '-qm', 'base');
  const size = measureGitRepository(repo, git('rev-parse', 'HEAD'), 10_000);
  // Entries: dir, dir/a.txt and b.txt.
  expect(size).toMatchObject({ checkoutBytes: 1024, entries: 3 });
  expect(size.objectBytes).toBeGreaterThan(0);
  expect(() => measureGitRepository(repo, 'not-a-sha', 10_000)).toThrow('Invalid reviewed head');
});

it('does not start an Ask for a question whose request finishes arriving after shutdown began', async () => {
  const { createDemo } = await import('../scripts/demo.ts');
  const { startServer } = await import('../web/server.ts');
  const { request } = await import('node:http');
  const root = mkdtempSync(join(tmpdir(), 'ask-shutdown-')); roots.push(root);
  let asked = 0;
  const app = await startServer(createDemo(join(root, 'demo')), 0, async () => { asked++; return 'Answer'; });
  const view = app.service.load();
  const body = JSON.stringify({ action: 'note', item: view.items[0]!.id, kind: 'question', text: 'Why?', token: view.token });
  const completed = new Promise<number>((resolve, reject) => {
    const req = request(new URL('/api/action', app.url), { method: 'POST', headers: { 'x-codeboost-token': app.token,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.write(body.slice(0, 1));
    setTimeout(() => req.end(body.slice(1)), 50);
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  await Promise.all([app.close(), completed.catch(() => 0)]);
  expect(asked).toBe(0);
}, 30_000);

it('closes the review store even when Ask cleanup fails at shutdown', async () => {
  const { createDemo } = await import('../scripts/demo.ts');
  const { startServer } = await import('../web/server.ts');
  const { Questions } = await import('../runner/questions.ts');
  const root = mkdtempSync(join(tmpdir(), 'ask-close-')); roots.push(root);
  const app = await startServer(createDemo(join(root, 'demo')), 0);
  const closeQuestions = Questions.prototype.close;
  Questions.prototype.close = async () => { throw new Error('disk full'); };
  let storeClosed = false;
  const closeStore = app.service.close.bind(app.service);
  app.service.close = () => { storeClosed = true; closeStore(); };
  try { await expect(app.close()).rejects.toThrow('disk full'); }
  finally { Questions.prototype.close = closeQuestions; }
  expect(storeClosed).toBe(true);
}, 30_000);

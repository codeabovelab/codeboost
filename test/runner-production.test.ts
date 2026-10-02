import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { RUNNER_NOT_CONFIGURED, startServer } from '../web/server.ts';
import { claudeLauncher, dRecoveryDeps, ISSUE_REUSE_MS, parseRunnerConfig, RUNNER_CREDENTIAL_MISSING, setUpRunner } from '../runner/production.ts';
import type { RecoveryDeps } from '../runner/recovery.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { InvocationInput } from '../agents/contract.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import { exportTaskDiff, removeTaskFilesystemsAsync } from '../agents/container/storage.ts';
import { RunnerCoordinator, type RunnerDeps } from '../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../runner/execution.ts';

vi.mock('../agents/recovery.ts', async original => ({ ...await original<typeof import('../agents/recovery.ts')>(), recoverLeftovers: vi.fn() }));
const issueReads: number[] = [];
vi.mock('../github/issues.ts', async original => {
  const actual = await original<typeof import('../github/issues.ts')>();
  return { ...actual, GhIssueGateway: class extends actual.GhIssueGateway {
    override async issueText(number: number) { issueReads.push(number); return { number, title: 'T', body: 'B', comments: [] }; }
  } };
});
vi.mock('../agents/container/storage.ts', async original => ({ ...await original<typeof import('../agents/container/storage.ts')>(),
  exportTaskDiff: vi.fn(async () => ({ diff: Buffer.from('d'), truncated: false })), removeTaskFilesystemsAsync: vi.fn(async () => undefined) }));

vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const OWNER = 'c'.repeat(32), committer = { name: 'codeboost', email: 'runner@codeboost.invalid' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-production-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  const service = new ReviewService(demo);
  const issue = service.store.getPlan(demo.identity).issue;
  // A real review, not a demo: the runner needs a github block for the issue text.
  const config = { ...demo, demo: false, github: { repository: 'owner/repo', pullRequest: 1, issue } };
  service.config = config;
  cleanups.push(() => { try { service.close(); } catch { /* closed by the test */ } });
  return { root, service, config, demo };
}
const recovery = (calls: string[], over: Partial<RecoveryDeps> = {}): RecoveryDeps => ({
  recoverLeftovers: async () => { calls.push('recover'); return { storage: [], unowned: [] }; },
  exportTaskDiff: async () => ({ diff: Buffer.alloc(0), truncated: false }),
  removeTaskFilesystems: async () => undefined,
  ...over,
});
const lock = (calls: string[], fail = false) => ({ file: { dev: 1n, ino: 2n }, verify: () => { calls.push('verify'); if (fail) throw new Error('The database path changed while opening. Refusing to start.'); } });
const capability = { run: <T>(fn: () => T) => fn() };

describe('runner configuration', () => {
  it('accepts a complete block and refuses relative paths, bad committers and unknown limits', () => {
    expect(parseRunnerConfig({ root: '/r', committer, limits: { workBytes: 1024 } })).toMatchObject({ root: '/r', committer, limits: { workBytes: 1024 } });
    expect(() => parseRunnerConfig({ root: 'r', committer })).toThrow(/runner.root must be an absolute path/);
    expect(() => parseRunnerConfig({ root: '/r', diagnosticsDir: 'd', committer })).toThrow(/diagnosticsDir/);
    expect(() => parseRunnerConfig({ root: '/r', committer: { name: 'x', email: 'a<b>' } })).toThrow(/committer/);
    expect(() => parseRunnerConfig({ root: '/r', committer, limits: { bytes: 1 } })).toThrow(/runner.limits.bytes/);
    expect(() => parseRunnerConfig({ root: '/r', committer, limits: { workBytes: 0 } })).toThrow(/runner.limits.workBytes/);
    expect(() => parseRunnerConfig([])).toThrow(/must be an object/);
  });
});

describe('runner startup', () => {
  it('verifies the lock, recovers, then builds the image, before it assembles anything', async () => {
    const { root, service } = fixture(), calls: string[] = [];
    const assembly = await setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock(calls), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => { calls.push('image'); return 'sha256:x'; }, recovery: () => { calls.push('deps'); return recovery(calls); } });
    // D's recovery stops every leftover agent before the (possibly long) image build.
    expect(calls).toEqual(['verify', 'deps', 'recover', 'image']);
    expect(assembly.deps.kinds).toEqual(['execute']);
    // The token is the database's own, kept for this file identity.
    expect(assembly.deps.runnerOwner).toBe(service.store.runnerOwnerToken({ dev: 1n, ino: 2n }));
    // The review now reads runner commits from the repository the runner writes.
    const repositories = join(root, 'runner', assembly.deps.runnerOwner, 'repositories');
    expect(service.config.runnerRepository).toBe(join(repositories, readdirSync(repositories)[0]!));
    expect(statSync(join(root, 'runner', 'diagnostics')).mode & 0o777).toBe(0o700);
    expect(await assembly.sources.vendor(service.config.identity)).toBe('claude');
    expect(() => assembly.sources.planContext({ ...service.config.identity, planId: 'other' })).toThrow(/only its configured plan/);
  });
  it('reads the issue once for a run of items, and again once the reuse window has passed', async () => {
    const { root, service } = fixture();
    const { sources } = await setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock([]), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => 'x', recovery: () => recovery([]) });
    issueReads.length = 0;
    const signal = new AbortController().signal, identity = service.config.identity;
    await sources.issue(identity, signal); await sources.issue(identity, signal);
    expect(issueReads).toHaveLength(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + ISSUE_REUSE_MS + 1);
    await sources.issue(identity, signal);
    expect(issueReads).toHaveLength(2);
  });
  it('refuses before touching anything without a github block, a token, or with a demo', async () => {
    for (const [patch, env, message] of [[{ github: undefined }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, /github block/], [{}, {}, RUNNER_CREDENTIAL_MISSING], [{ demo: true }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, /Demos never/]] as const) {
      const { root, service, config } = fixture(), calls: string[] = [];
      service.config = { ...config, ...patch };
      await expect(setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock(calls), env,
        buildImage: () => { calls.push('image'); return 'x'; }, recovery: () => recovery(calls) })).rejects.toThrow(message);
      expect(calls).toEqual([]);
      expect(existsSync(join(root, 'runner'))).toBe(false);
    }
  });
  it('stops startup when the lock no longer names the database, or recovery fails, and admits nothing', async () => {
    const { root, service } = fixture(), calls: string[] = [];
    await expect(setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock(calls, true), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => { calls.push('image'); return 'x'; }, recovery: () => recovery(calls) })).rejects.toThrow(/path changed/);
    expect(calls).toEqual(['verify']);
    await expect(setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock([]), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => 'x', recovery: () => recovery([], { recoverLeftovers: async () => { throw new Error('docker down'); } }) })).rejects.toThrow(/docker down/);
  });
  it('refuses a configured runnerRepository that is not the runner\'s own', async () => {
    const { root, service, config } = fixture();
    service.config = { ...config, runnerRepository: join(root, 'elsewhere.git') };
    await expect(setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock([]), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => 'x', recovery: () => recovery([]) })).rejects.toThrow(/is not the runner's repository/);
  });
});

describe('server with a runner setup', () => {
  it('runs the setup before it listens, and closes the Store without listening when the setup fails', async () => {
    const { demo } = fixture();
    let closed = false;
    const setup = vi.fn(async (service: ReviewService) => {
      const close = service.store.close.bind(service.store);
      service.store.close = () => { closed = true; close(); };
      throw new Error('recovery blocked');
    });
    await expect(startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, setup)).rejects.toThrow(/recovery blocked/);
    expect(setup).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });
  /** A runner whose agent never runs: enough to drive the server's own wiring. */
  const assembly = (service: ReviewService) => {
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: ['execute'], prepare: async () => { throw new Error('no agent here'); },
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), issue: () => ({ number: 1, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
    return { deps, sources, findings: new SafetyFindings(service.store), recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  };
  it('closes the Store only after the plan runs in progress, and after a failing step', async () => {
    const { demo } = fixture();
    const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => assembly(service));
    const order: string[] = [];
    const executorClose = app.executor!.close.bind(app.executor);
    // A later failure must not hide the first one.
    app.executor!.close = async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('executor'); await executorClose(); throw new Error('executor close failed'); };
    const storeClose = app.service.store.close.bind(app.service.store);
    app.service.store.close = () => { order.push('store'); storeClose(); };
    vi.spyOn(app.runner as RunnerCoordinator, 'close').mockRejectedValueOnce(new Error('runner close failed'));
    await expect(app.close()).rejects.toThrow(/runner close failed/);
    // A failing step skips nothing after it: plan runs are still awaited before the Store closes.
    expect(order).toEqual(['executor', 'store']);
    // Without the failure: executor first, then the Store.
    const second = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => assembly(service));
    const order2: string[] = [];
    const close2 = second.executor!.close.bind(second.executor);
    second.executor!.close = async () => { await new Promise(resolve => setTimeout(resolve, 20)); order2.push('executor'); return close2(); };
    const store2 = second.service.store.close.bind(second.service.store);
    second.service.store.close = () => { order2.push('store'); store2(); };
    await second.close();
    expect(order2).toEqual(['executor', 'store']);
  });
  it('refuses to retry a plan item outside the executor', async () => {
    const { demo } = fixture();
    const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
      const store = service.store, identity = demo.identity;
      if (store.getTask(identity).status !== 'queued') store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
      const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: store.getPlan(identity).items[0]!.id,
        expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
      store.markRunning(identity, attempt.id);
      store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false });
      return assembly(service);
    });
    cleanups.push(() => app.close());
    const origin = new URL(app.url).origin, headers = { 'x-codeboost-token': app.token };
    const view = await (await fetch(`${origin}/api/runner`, { headers })).json() as { stateVersion: number; attempts: { id: string }[]; retryable: boolean };
    // The view must not offer what the action refuses.
    expect(view.retryable).toBe(false);
    const response = await fetch(`${origin}/api/runner`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry', attemptId: view.attempts[0]!.id, expectedStateVersion: view.stateVersion, actionId: randomUUID() }) });
    expect(await response.json()).toEqual({ error: expect.stringMatching(/Retrying a plan item on its own is not supported/) });
    expect(app.service.store.getAttempts(demo.identity)).toHaveLength(1);
  });
  it('reports a missing runner block on a runner action', async () => {
    const { demo } = fixture();
    const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000);
    cleanups.push(() => app.close());
    const task = await (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as { stateVersion: number; available: boolean };
    expect(task.available).toBe(false);
    const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry', attemptId: randomUUID(), expectedStateVersion: task.stateVersion, actionId: randomUUID() }) });
    expect(await response.json()).toEqual({ error: RUNNER_NOT_CONFIGURED });
  });
});

describe('D adapters', () => {
  it('passes D\'s own handles through, and turns every unowned object into the command that removes it', async () => {
    const handle = Object.freeze({ runnerOwner: OWNER, attemptId: randomUUID(), allocationId: randomUUID() });
    const spy = vi.mocked(recoverLeftovers).mockResolvedValue({ removed: [], storage: [handle], unowned: [
      { kind: 'volume', name: 'legacy', labels: {}, reason: 'no-runner-label' },
      { kind: 'container', name: 'ours', id: 'abc', labels: { 'io.codeboost.runner': OWNER }, reason: 'unknown-kind' },
    ] });
    const report = await dRecoveryDeps(() => 'sha256:x').recoverLeftovers(OWNER);
    // The daemon-wide search for unlabelled objects stays on (runner-lifecycle.md, "Unowned resources").
    expect(spy).toHaveBeenCalledWith(OWNER, 120_000);
    expect(report.storage[0]!.handle).toBe(handle);
    // Each line runs as it is in a shell; the reason is a comment.
    expect(report.unowned).toEqual(["docker volume rm 'legacy'  # no-runner-label", "docker container rm -f 'abc'  # unknown-kind"]);
  });
  it('builds the image before exporting, exports with the row\'s base and baseline, and removes D\'s own handle', async () => {
    let builds = 0;
    // Memoized, as setUpRunner passes it.
    let built: string | undefined;
    const deps = dRecoveryDeps(() => built ??= (builds++, 'sha256:x')), handle = { recovered: true }, signal = new AbortController().signal;
    vi.mocked(recoverLeftovers).mockResolvedValue({ removed: [], storage: [], unowned: [] });
    await deps.recoverLeftovers(OWNER);
    // Nothing to export: the build waits until recovery ends.
    expect(builds).toBe(0);
    // Storage to export: built before recoverStartup arms any export deadline.
    vi.mocked(recoverLeftovers).mockResolvedValue({ removed: [], storage: [Object.freeze({ runnerOwner: OWNER, attemptId: randomUUID(), allocationId: randomUUID() })], unowned: [] });
    await deps.recoverLeftovers(OWNER);
    expect(builds).toBe(1);
    await deps.exportTaskDiff(handle, { base: 'a'.repeat(40), metadataBaseline: 'b'.repeat(64) }, 1024, signal);
    expect(vi.mocked(exportTaskDiff)).toHaveBeenCalledWith(handle, { base: 'a'.repeat(40), metadataBaseline: 'b'.repeat(64), imageId: 'sha256:x', maxBytes: 1024, signal });
    expect(builds).toBe(1);
    await deps.removeTaskFilesystems(handle);
    expect(vi.mocked(removeTaskFilesystemsAsync).mock.calls[0]![0]).toBe(handle);
  });
  it('launches Claude with a schema-only input mount in the attempt directory and the workspace\'s storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-launch-')); roots.push(root);
    const attemptId = randomUUID(), attemptDir = join(root, OWNER, 'attempts', attemptId);
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    let seen: AgentAdapterRequest | undefined, token: string | undefined;
    const filesystems = { keeper: 'k' };
    // The schema must stay readable by the container user under any umask.
    const umask = process.umask(0o077);
    cleanups.push(() => { process.umask(umask); });
    const launch = claudeLauncher({ imageId: 'sha256:x', runnerRoot: root, runnerOwner: OWNER, token: 'secret',
      start: (request, t) => { seen = request; token = t; return { attemptId, settled: new Promise(() => undefined), cancel: () => undefined }; } });
    launch({ attemptId } as InvocationInput, 'the prompt', { clone: {} as never, storage: { filesystems } });
    expect(seen).toMatchObject({ prompt: 'the prompt', imageId: 'sha256:x', inputDirectory: join(attemptDir, 'input'), filesystems });
    expect(token).toBe('secret');
    expect(readdirSync(join(attemptDir, 'input'))).toEqual(['schema.json']);
    expect(JSON.parse(readFileSync(join(attemptDir, 'input', 'schema.json'), 'utf8'))).toMatchObject({ type: 'string' });
    expect(lstatSync(join(attemptDir, 'input')).mode & 0o005).toBe(0o005);
    expect(lstatSync(join(attemptDir, 'input', 'schema.json')).mode & 0o777).toBe(0o444);
    // The coordinator's preparation cleanup removes the attempt directory with it.
    rmSync(attemptDir, { recursive: true });
  });
});

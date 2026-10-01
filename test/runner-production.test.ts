import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { RUNNER_NOT_CONFIGURED, startServer } from '../web/server.ts';
import { claudeLauncher, dRecoveryDeps, parseRunnerConfig, RUNNER_CREDENTIAL_MISSING, setUpRunner } from '../runner/production.ts';
import type { RecoveryDeps } from '../runner/recovery.ts';
import type { AgentAdapterRequest } from '../agents/adapters/types.ts';
import type { InvocationInput } from '../agents/contract.ts';
import { recoverLeftovers } from '../agents/recovery.ts';

vi.mock('../agents/recovery.ts', async original => ({ ...await original<typeof import('../agents/recovery.ts')>(), recoverLeftovers: vi.fn() }));

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
  it('verifies the lock, builds the image, then recovers, before it assembles anything', async () => {
    const { root, service } = fixture(), calls: string[] = [];
    const assembly = await setUpRunner({ service, capability, config: { root: join(root, 'runner'), committer }, lock: lock(calls), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      buildImage: () => { calls.push('image'); return 'sha256:x'; }, recovery: imageId => { calls.push(`deps ${imageId}`); return recovery(calls); } });
    expect(calls).toEqual(['verify', 'image', 'deps sha256:x', 'recover']);
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
    const report = await dRecoveryDeps('sha256:x').recoverLeftovers(OWNER);
    // The daemon-wide search for unlabelled objects stays on (runner-lifecycle.md, "Unowned resources").
    expect(spy).toHaveBeenCalledWith(OWNER, 120_000);
    expect(report.storage[0]!.handle).toBe(handle);
    expect(report.unowned).toEqual(['docker volume rm legacy (no-runner-label)', 'docker container rm -f abc (unknown-kind)']);
  });
  it('launches Claude with a schema-only input mount in the attempt directory and the workspace\'s storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-launch-')); roots.push(root);
    const attemptId = randomUUID(), attemptDir = join(root, OWNER, 'attempts', attemptId);
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    let seen: AgentAdapterRequest | undefined, token: string | undefined;
    const filesystems = { keeper: 'k' };
    const launch = claudeLauncher({ imageId: 'sha256:x', runnerRoot: root, runnerOwner: OWNER, token: 'secret',
      start: (request, t) => { seen = request; token = t; return { attemptId, settled: new Promise(() => undefined), cancel: () => undefined }; } });
    launch({ attemptId } as InvocationInput, 'the prompt', { clone: {} as never, storage: { filesystems } });
    expect(seen).toMatchObject({ prompt: 'the prompt', imageId: 'sha256:x', inputDirectory: join(attemptDir, 'input'), filesystems });
    expect(token).toBe('secret');
    expect(readdirSync(join(attemptDir, 'input'))).toEqual(['schema.json']);
    expect(JSON.parse(readFileSync(join(attemptDir, 'input', 'schema.json'), 'utf8'))).toMatchObject({ type: 'string' });
    expect(lstatSync(join(attemptDir, 'input')).mode & 0o005).toBe(0o005);
    // The coordinator's preparation cleanup removes the attempt directory with it.
    rmSync(attemptDir, { recursive: true });
  });
});

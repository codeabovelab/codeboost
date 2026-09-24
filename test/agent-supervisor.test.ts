import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { readCodexOutput, startCodexInvocation } from '../agents/adapters/codex.ts';
import { isInvocationActive, startProfileInvocation } from '../agents/adapters/supervisor.ts';
import { captureInvocation, type InvocationInput } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { createContainerProfile, disposeContainerProfile, type ContainerProfile } from '../agents/container/profile.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createVendorNetwork } from '../agents/network/network.ts';
import { createIsolationProbeCommand, createPhasePolicy, type IsolationProbe } from '../agents/policy.ts';
import { createTaskClone } from '../git/clone.ts';

const roots: string[] = [], profiles: ContainerProfile[] = [];
const allocations: ReturnType<typeof prepareTaskFilesystems>[] = [];
let imageId = '';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-supervisor-')); roots.push(root);
  const source = join(root, 'source'), staging = join(root, 'staging'), input = join(root, 'input');
  mkdirSync(source); mkdirSync(staging); mkdirSync(input);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  writeFileSync(join(input, 'schema.json'), '{}\n'); chmodSync(join(input, 'schema.json'), 0o444); chmodSync(input, 0o555);
  const clone = createTaskClone({ source, parent: staging, taskId: 'supervisor', head: git(source, 'rev-parse', 'HEAD') });
  const filesystems = prepareTaskFilesystems(clone, {
    workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
  }, imageId); allocations.push(filesystems);
  const auth = join(root, 'auth.json'); writeFileSync(auth, '{}', { mode: 0o600 });
  return { root, input, clone, filesystems, auth };
}
function invocation(data: ReturnType<typeof fixture>, attemptId: string, deadlineMs = 2 * 60_000,
  vendor: 'codex' | 'claude' = 'codex'): InvocationInput {
  return captureInvocation({ clone: data.clone, phase: 'planning', vendor, approvedArgv: [],
    deadline: Date.now() + deadlineMs, attemptId,
    context: { snapshotId: 'snapshot', planId: 'plan', planRevision: 1, assignmentId: 'assignment',
      referencedCodeHash: 'code', stateVersion: 1 } });
}
function profile(data: ReturnType<typeof fixture>, probe: IsolationProbe, attemptId = `attempt-${Math.random()}`,
  deadlineMs = 2 * 60_000, deferredOutput = false) {
  const captured = invocation(data, attemptId, deadlineMs), policy = createPhasePolicy(captured);
  const network = createVendorNetwork(captured, imageId);
  const value = createContainerProfile({ invocation: captured, policy, network, filesystems: data.filesystems,
    inputDirectory: data.input, command: createIsolationProbeCommand(policy, probe), imageId, codexAuthFile: data.auth,
    deferredOutput });
  profiles.push(value); return value;
}

beforeAll(() => { imageId = buildAgentImage(); }, 10 * 60_000);
afterAll(() => {
  for (const profile of profiles) disposeContainerProfile(profile);
  for (const allocation of allocations.reverse()) removeTaskFilesystems(allocation);
  for (const root of roots.reverse()) {
    chmodSync(join(root, 'input'), 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 3 * 60_000);

describe('container invocation supervisor', () => {
  it('captures finite output and releases ownership only after cleanup', async () => {
    const current = profile(fixture(), 'finite-output', 'finite');
    const handle = startProfileInvocation(current);
    expect(isInvocationActive('finite')).toBe(true);
    const result = await handle.settled;
    expect(result).toMatchObject({ attemptId: 'finite', exitCode: 0, signal: null,
      stdout: 'stdout-marker', stderr: 'stderr-marker' });
    expect(result.stopReason).toBeUndefined();
    expect(isInvocationActive('finite')).toBe(false);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).not.toBe(0);
    expect(spawnSync('docker', ['network', 'inspect', current.network.name]).status).not.toBe(0);
  }, 60_000);

  it.each([
    ['infinite-stdout', { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 96 * 1024 }],
    ['infinite-stderr', { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 96 * 1024 }],
    ['infinite-mixed', { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, combinedBytes: 48 * 1024 }],
  ] as const)('terminates %s at bounded output limits', async (probe, limits) => {
    const attemptId = `limit-${probe}`, handle = startProfileInvocation(profile(fixture(), probe, attemptId), { limits });
    const result = await handle.settled;
    expect(result.stopReason).toBe('output-limit');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(limits.stdoutBytes);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limits.stderrBytes);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limits.combinedBytes);
    expect(isInvocationActive(attemptId)).toBe(false);
  }, 60_000);

  it('preserves the first cancellation reason until an ignored SIGTERM fully settles', async () => {
    const current = profile(fixture(), 'ignore-term', 'cancelled');
    const handle = startProfileInvocation(current, { timeoutMs: 30_000 });
    let settled = false; void handle.settled.then(() => { settled = true; });
    handle.cancel('cancelled'); handle.cancel('shutdown');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(isInvocationActive('cancelled')).toBe(true);
    const result = await handle.settled;
    expect(result.stopReason).toBe('cancelled');
    expect(result.stderr).toContain('[codeboost: cancelled]');
    expect(isInvocationActive('cancelled')).toBe(false);
  }, 60_000);

  it('enforces a finite wall deadline and force-settles the container', async () => {
    const started = Date.now();
    const handle = startProfileInvocation(profile(fixture(), 'ignore-term', 'timeout', 8_000), { timeoutMs: 30_000 });
    const result = await handle.settled;
    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(isInvocationActive('timeout')).toBe(false);
  }, 60_000);

  it('blocks a duplicate attempt while the original container remains active', async () => {
    const data = fixture(), first = startProfileInvocation(profile(data, 'ignore-term', 'duplicate'), { timeoutMs: 30_000 });
    expect(() => startProfileInvocation(profile(data, 'finite-output', 'duplicate'))).toThrow('still active');
    expect(isInvocationActive('duplicate')).toBe(true);
    first.cancel('shutdown');
    expect((await first.settled).stopReason).toBe('shutdown');
  }, 60_000);

  it('records decoder failure without publishing a successful result', async () => {
    const handle = startProfileInvocation(profile(fixture(), 'finite-output', 'capture-failure'), {
      decode: () => { throw new Error('simulated capture failure'); },
    });
    const result = await handle.settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).toContain('[codeboost: capture-failure');
    expect(isInvocationActive('capture-failure')).toBe(false);
  }, 60_000);

  it.each([
    ['symlink-output', 'capture-failure'],
    ['oversized-output', 'output-limit'],
  ] as const)('rejects unsafe Codex output from %s', async (probe, reason) => {
    const handle = startProfileInvocation(profile(fixture(), probe, `file-${probe}`, 2 * 60_000, true), {
      limits: { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, combinedBytes: 128 * 1024 },
      decode: (current, _raw, maximum) => readCodexOutput(current.name, maximum),
    });
    const result = await handle.settled;
    expect(result.stopReason, result.stderr).toBe(reason);
  }, 60_000);

  it('rejects limits above the production ceilings and cleans the unused profile', () => {
    const current = profile(fixture(), 'finite-output', 'invalid-limit');
    expect(() => startProfileInvocation(current, { limits: { stdoutBytes: 16 * 1024 * 1024 + 1 } }))
      .toThrow('production hard limits');
    expect(spawnSync('docker', ['network', 'inspect', current.network.name]).status).not.toBe(0);
  }, 60_000);

  if (process.env.CODEBOOST_RUN_AUTH_PROBES === '1') {
    it('runs the production Codex adapter and collects its bounded output file', async () => {
      const data = fixture(), authFile = process.env.CODEBOOST_CODEX_AUTH_FILE;
      if (!authFile) throw new Error('CODEBOOST_CODEX_AUTH_FILE is required.');
      const result = await startCodexInvocation({ invocation: invocation(data, 'live-codex', 6 * 60_000),
        filesystems: data.filesystems, inputDirectory: data.input, imageId,
        prompt: 'Reply only with this exact marker: codeboost-adapter-marker' }, authFile).settled;
      expect(result.stopReason).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('codeboost-adapter-marker');
    }, 8 * 60_000);

    it('runs the production Claude adapter and parses its bounded envelope', async () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const result = await startClaudeInvocation({ invocation: invocation(data, 'live-claude', 6 * 60_000, 'claude'),
        filesystems: data.filesystems, inputDirectory: data.input, imageId,
        prompt: 'Reply only with this exact marker: codeboost-adapter-marker' }, token).settled;
      expect(result.stopReason).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('codeboost-adapter-marker');
    }, 8 * 60_000);
  }
});

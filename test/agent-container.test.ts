import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { createVendorNetwork, removeVendorNetwork, type VendorNetwork } from '../agents/network/network.ts';
import { createClaudeCommand, createCodexCommand, createIsolationProbeCommand, createPhasePolicy,
  type AgentCommand, type IsolationProbe } from '../agents/policy.ts';

const roots: string[] = [];
const taskFilesystems: ReturnType<typeof prepareTaskFilesystems>[] = [];
const containers = new Set<string>();
const profiles: ReturnType<typeof createContainerProfile>[] = [];
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
  }, imageId);
  taskFilesystems.push(filesystems);
  const fakeAuth = join(root, 'auth.json'); writeFileSync(fakeAuth, '{}', { mode: 0o600 });
  return { root, source, input, clone, filesystems, fakeAuth };
}

function invocation(clone: ReturnType<typeof createTaskClone>, phase: Phase, vendor: 'codex' | 'claude' = 'codex',
  deadlineMs = 60_000): InvocationInput {
  return captureInvocation({ clone, phase, vendor, approvedArgv: phase === 'planning' || phase === 'questions' ? [] : [['git', 'status']],
    deadline: Date.now() + deadlineMs, attemptId: `${vendor}-${phase}-${Math.random().toString(16).slice(2)}`,
    context: { snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 1, assignmentId: 'assignment-1',
      referencedCodeHash: 'code-1', stateVersion: 1 } });
}
const governed = (captured: InvocationInput, probe: IsolationProbe = 'noop') => {
  const policy = createPhasePolicy(captured), network = createVendorNetwork(captured, imageId);
  vendorNetworks.push(network);
  return { invocation: captured, policy, network, command: createIsolationProbeCommand(policy, probe) };
};

function profile(data: ReturnType<typeof fixture>, phase: Phase,
  command: IsolationProbe | ((policy: ReturnType<typeof createPhasePolicy>) => AgentCommand), options: {
  vendor?: 'codex' | 'claude'; authProbe?: boolean; codexAuthFile?: string; claudeToken?: string; deadlineMs?: number;
} = {}) {
  const vendor = options.vendor ?? 'codex';
  const captured = invocation(data.clone, phase, vendor, options.deadlineMs);
  const policy = createPhasePolicy(captured), network = createVendorNetwork(captured, imageId);
  vendorNetworks.push(network);
  const trustedCommand = typeof command === 'string' ? createIsolationProbeCommand(policy, command) : command(policy);
  const base = createContainerProfile({ invocation: captured, policy, network, filesystems: data.filesystems,
    inputDirectory: data.input, command: trustedCommand, imageId,
    codexAuthFile: vendor === 'codex' ? (options.codexAuthFile ?? data.fakeAuth) : undefined,
    claudeToken: vendor === 'claude' ? options.claudeToken : undefined });
  profiles.push(base);
  return base;
}

beforeAll(() => {
  imageId = buildAgentImage();
}, 10 * 60_000);
afterEach(() => {
  for (const network of vendorNetworks.splice(0).reverse()) removeVendorNetwork(network);
}, 120_000);
afterAll(() => {
  for (const container of containers) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  for (const filesystems of taskFilesystems.reverse()) removeTaskFilesystems(filesystems);
  for (const profile of profiles) disposeContainerProfile(profile);
  for (const network of vendorNetworks.splice(0).reverse()) removeVendorNetwork(network);
  for (const root of roots.reverse()) {
    chmodSync(join(root, 'input'), 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 120_000);

describe('real Docker agent isolation', () => {
  it.each(['planning', 'questions', 'review', 'execute', 'fix'] as const)(
    '%s applies its enforced worktree access profile', phase => {
      const data = fixture();
      expect(runContainer(profile(data, phase, 'phase-worktree'))).toBe('');
    }, 60_000);

  it('removes the invocation proxy and network after the container settles', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    expect(runContainer(valid)).toBe('');
    expect(spawnSync('docker', ['container', 'inspect', valid.network.proxyContainer]).status).not.toBe(0);
    expect(spawnSync('docker', ['network', 'inspect', valid.network.name]).status).not.toBe(0);
  }, 60_000);

  it('runs read-only with no root capabilities, host paths, inherited secrets, or writable tools', () => {
    const data = fixture();
    process.env.HOST_SECRET_SENTINEL = 'must-not-reach-container';
    try {
      const output = runContainer(profile(data, 'planning', 'read-only-isolation'));
      expect(output).toBe('isolated');
    } finally { delete process.env.HOST_SECRET_SENTINEL; }
  }, 60_000);

  it('seeds Git history larger than the work allocation into the metadata volume only', () => {
    const data = fixture({ historyBytes: 4 * 1024 * 1024, limits: {
      workBytes: 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
    } });
    expect(runContainer(profile(data, 'execute', 'metadata'))).toBe('metadata-safe');
  }, 60_000);

  it('accepts byte limits that tmpfs rounds up to a whole page', () => {
    const data = fixture({ limits: {
      workBytes: 16 * 1024 * 1024 + 1, workInodes: 512, metadataBytes: 16 * 1024 * 1024 + 1, metadataInodes: 512,
    } });
    expect(runContainer(profile(data, 'execute', 'noop'))).toBe('');
  }, 60_000);

  it('requests private IPC and cgroup namespaces instead of relying on daemon defaults', () => {
    const args = profile(fixture(), 'planning', 'noop').args;
    expect(args).toContain('--ipc=private');
    expect(args).toContain('--cgroupns=private');
  }, 60_000);

  it.each(['planning', 'review', 'execute'] as const)(
    'keeps Git metadata unchanged under link, alias, truncation and replacement attempts during %s', phase => {
      expect(runContainer(profile(fixture(), phase, 'metadata-alias'))).toBe('metadata-unchanged');
    }, 60_000);

  it('enforces byte and inode ceilings on every Codex scratch area', () => {
    expect(runContainer(profile(fixture(), 'execute', 'scratch-capacity'))).toBe('scratch-bounded');
  }, 120_000);

  it('enforces byte and inode ceilings on every Claude scratch area', () => {
    const placeholder = 'offline-placeholder-token';
    const claude = profile(fixture(), 'execute', 'scratch-capacity', { vendor: 'claude', claudeToken: placeholder });
    expect(runContainer(claude, 60_000, { CLAUDE_CODE_OAUTH_TOKEN: placeholder })).toBe('scratch-bounded');
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
  ] as const)('refuses to seed a repository with %s, before any storage exists', (_label, hostile) => {
    const owned = () => [docker('volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation'),
      docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.allocation')].join('\n').split('\n').filter(Boolean);
    const before = new Set(owned());
    expect(() => fixture({ hostile })).toThrow('leaves the checkout');
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('refuses to seed a clone whose Git metadata contains a link, before any storage exists', () => {
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
    }, imageId)).toThrow('Git metadata contains a link');
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('seeds links that stay inside the checkout, including loops and not-yet-existing targets', () => {
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
    expect(runContainer(profile(data, 'planning', 'hostile-repo'))).toBe('hostile-repo-contained');
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('fails closed without leaving storage when a repository exceeds its allocation', () => {
    const owned = () => [docker('volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation'),
      docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.allocation')].join('\n').split('\n').filter(Boolean);
    const before = new Set(owned());
    expect(() => fixture({ historyBytes: 4 * 1024 * 1024, limits: {
      workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 1024 * 1024, metadataInodes: 512,
    } })).toThrow();
    expect(owned().filter(id => !before.has(id))).toEqual([]);
  }, 60_000);

  it('persists execution changes while replacing HOME and scratch for each invocation', () => {
    const data = fixture();
    expect(runContainer(profile(data, 'execute', 'persist-write'))).toBe('first');
    const output = runContainer(profile(data, 'execute', 'persist-read'));
    expect(output).toContain('?? generated.txt');
  }, 60_000);

  it('enforces work byte and inode ceilings before writes can exceed the allocation', () => {
    const data = fixture();
    const output = runContainer(profile(data, 'execute', 'capacity'));
    expect(output).toBe('bounded');
  }, 60_000);

  it('keeps Git metadata read-only, on another filesystem, and mounted against replacement', () => {
    const data = fixture();
    const output = runContainer(profile(data, 'execute', 'metadata'));
    expect(output).toBe('metadata-safe');
  }, 60_000);

  it('refuses a container missing read-only root before its command runs', () => {
    const data = fixture();
    const valid = profile(data, 'planning', 'must-not-run');
    const args = valid.args.filter(value => value !== '--read-only');
    docker(...args);
    containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    const result = spawnSync('docker', ['start', '--attach', valid.name], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).not.toBe(0);
    containers.delete(valid.name); docker('rm', '--force', valid.name);
  }, 60_000);

  it('rejects mixed credentials and unsupported command/profile inputs', () => {
    const data = fixture();
    expect(() => createContainerProfile({ ...governed(invocation(data.clone, 'planning', 'codex')),
      filesystems: data.filesystems, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      claudeToken: 'must-not-combine', imageId })).toThrow('only');
    expect(() => createContainerProfile({ ...governed(invocation(data.clone, 'planning', 'claude')),
      filesystems: data.filesystems, inputDirectory: data.input, imageId })).toThrow('OAuth');
    const claudeProfile = createContainerProfile({ ...governed(invocation(data.clone, 'planning', 'claude')),
      filesystems: data.filesystems, inputDirectory: data.input, imageId, claudeToken: 'serialization-sentinel' });
    expect(JSON.stringify(claudeProfile)).not.toContain('serialization-sentinel');
    expect(() => createValidatedContainer(claudeProfile)).toThrow('OAuth environment credential');
    const untrusted = governed(invocation(data.clone, 'planning'));
    expect(() => createContainerProfile({ ...untrusted, command: { argv: ['true'] }, filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId })).toThrow('not generated');
    expect(() => createContainerProfile({ ...governed(invocation(data.clone, 'planning')),
      filesystems: data.filesystems, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      imageId: AGENT_IMAGE })).toThrow('immutable built image ID');
    chmodSync(data.input, 0o755); writeFileSync(join(data.input, 'extra.json'), '{}'); chmodSync(data.input, 0o555);
    expect(() => profile(data, 'planning', 'noop')).toThrow('only one bounded');
  }, 60_000);

  it('rejects unexpected host mounts and unbounded task volumes after Docker resolves them', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const extraMountArgs = [...valid.args.slice(0, imageIndex), '--mount',
      'type=bind,source=/tmp,target=/unexpected,readonly', ...valid.args.slice(imageIndex)];
    docker(...extraMountArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('unexpected external mount');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const rogue = `codeboost-work-${randomUUID()}`; docker('volume', 'create', rogue);
    try {
      const rogueArgs = valid.args.map(value => value.replace(data.filesystems.workVolume, rogue));
      docker(...rogueArgs); containers.add(valid.name);
      expect(() => validateContainer(valid.name, valid)).toThrow('captured identity');
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    } finally { spawnSync('docker', ['volume', 'rm', '--force', rogue], { stdio: 'ignore' }); }
  }, 60_000);

  it('rejects cloned profiles while sealed snapshots ignore later host changes', () => {
    const data = fixture(), valid = profile(data, 'planning', 'input-marker');
    const forged = Object.freeze({ ...valid, inputDirectory: '/',
      args: Object.freeze(valid.args.map(value => value.includes(`source=${data.input},`)
        ? value.replace(`source=${data.input},`, 'source=/,') : value)) });
    expect(() => createValidatedContainer(forged)).toThrow('trusted profile builder');

    expect(() => createContainerProfile({ ...governed(invocation(data.clone, 'planning')),
      filesystems: { ...data.filesystems }, inputDirectory: data.input, codexAuthFile: data.fakeAuth,
      imageId })).toThrow('trusted allocator');

    const other = fixture();
    expect(() => createContainerProfile({ ...governed(invocation(other.clone, 'planning')),
      filesystems: data.filesystems, inputDirectory: other.input, codexAuthFile: other.fakeAuth,
      imageId })).toThrow('do not belong to the invocation clone');

    writeFileSync(data.fakeAuth, '{"changed":true}');
    expect(valid.codexAuthFile).not.toBe(data.fakeAuth);
    expect(readFileSync(valid.codexAuthFile!, 'utf8')).toBe('{}');
    expect(statSync(valid.codexAuthFile!).mode & 0o777).toBe(0o444);
    writeFileSync(data.fakeAuth, '{}');

    chmodSync(data.input, 0o755); chmodSync(join(data.input, 'schema.json'), 0o644);
    writeFileSync(join(data.input, 'schema.json'), '{"probe":"changed"}\n');
    writeFileSync(join(data.input, 'extra.json'), '{}');
    chmodSync(join(data.input, 'schema.json'), 0o444); chmodSync(data.input, 0o555);
    expect(runContainer(valid)).toBe('');
    chmodSync(data.input, 0o755); rmSync(join(data.input, 'extra.json')); chmodSync(data.input, 0o555);
  }, 60_000);

  it('rejects extra security policies and environment paths that can escape bounded storage', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const securityArgs = [...valid.args.slice(0, imageIndex), '--security-opt', 'seccomp=unconfined',
      ...valid.args.slice(imageIndex)];
    docker(...securityArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const pathArgs = [...valid.args.slice(0, imageIndex), '--env', 'PATH=/work', ...valid.args.slice(imageIndex)];
    docker(...pathArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow(/environment|PATH/);
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    for (const changedPath of ['npm_config_cache=/work/npm-cache', 'XDG_CACHE_HOME=/work/xdg-cache',
      'CODEX_HOME=/work', 'HTTPS_PROXY=http://example.com:3128']) {
      const changedArgs = [...valid.args.slice(0, imageIndex), '--env', changedPath, ...valid.args.slice(imageIndex)];
      docker(...changedArgs); containers.add(valid.name);
      expect(() => validateContainer(valid.name, valid)).toThrow(/isolation environment|Credential profiles/);
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    }
  }, 60_000);

  it('does not remove an active container when a duplicate attempt name collides', () => {
    const data = fixture(), captured = invocation(data.clone, 'planning');
    const first = createContainerProfile({ ...governed(captured), filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId });
    const duplicate = createContainerProfile({ ...governed(captured), filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId });
    profiles.push(first, duplicate);
    docker(...first.args); containers.add(first.name);
    expect(() => createValidatedContainer(duplicate)).toThrow('Container creation failed and cleanup did not settle.');
    expect(existsSync(duplicate.codexAuthFile!)).toBe(true);
    expect(isContainerProfileAuthentic(duplicate)).toBe(true);
    const state = JSON.parse(docker('container', 'inspect', first.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', first.name); containers.delete(first.name);
  }, 60_000);

  it('releases a killed create once its settle window passes with no container', () => {
    const data = fixture(), unsettled = profile(data, 'planning', 'noop');
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The create client hangs until its deadline kills it, so the daemon outcome stays unknown.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', 'if [ "$1" = create ]; then exec sleep 30; fi',
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    const started = performance.now();
    // The create path waits out the settle window, then treats absence as settled and releases the profile.
    try { expect(() => createValidatedContainer(unsettled, 3_000)).toThrow('ETIMEDOUT'); }
    finally { process.env.PATH = path; }
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(isContainerProfileAuthentic(unsettled)).toBe(false);
    expect(existsSync(unsettled.codexAuthFile!)).toBe(false);
  }, 60_000);

  it('keeps a killed create unsettled for later cleanup until its settle window passes', () => {
    const data = fixture(), unsettled = profile(data, 'planning', 'noop');
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
      expect(() => createValidatedContainer(unsettled, 3_000)).toThrow('cleanup did not settle');
      // A follow-up cleanup inside the window must not treat absence as proof and release the profile.
      expect(() => disposeValidatedContainer(unsettled)).toThrow('did not settle');
    } finally { process.env.PATH = path; }
    expect(isContainerProfileAuthentic(unsettled)).toBe(true);
    expect(existsSync(unsettled.codexAuthFile!)).toBe(true);
  }, 60_000);

  it('refuses to seed a clone whose staging directory was replaced after creation', () => {
    const data = fixture();
    const clone = createTaskClone({ source: data.source, parent: join(data.root, 'staging'), taskId: 'task-2',
      head: git(data.source, 'rev-parse', 'HEAD') });
    renameSync(clone.directory, `${clone.directory}-original`);
    mkdirSync(clone.directory); git(clone.directory, 'init');
    expect(() => prepareTaskFilesystems(clone, {
      workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
    }, imageId)).toThrow('replaced after it was created');
  }, 60_000);

  it('rejects a container that relies on the daemon default seccomp profile', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    docker(...valid.args.filter(arg => arg !== '--security-opt=seccomp=builtin')); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('startup probe refuses to exec when seccomp filtering is disabled', () => {
    const result = spawnSync('docker', ['run', '--rm', '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined', '--network=none', imageId, 'true'],
      { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('seccomp syscall filter must be enforced');
  }, 60_000);

  it('removes a keeper that lands in the daemon after its run client was killed', () => {
    const data = fixture();
    const clone = createTaskClone({ source: data.source, parent: join(data.root, 'staging'), taskId: 'task-late',
      head: git(data.source, 'rev-parse', 'HEAD') });
    const keepers = () => new Set(docker('ps', '--all', '--quiet', '--filter', 'label=io.codeboost.task-storage=keeper')
      .split('\n').filter(Boolean));
    const before = keepers();
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The keeper's run client hangs until killed, and the real run lands in the daemon afterwards.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh',
      `if [ "$1" = run ] && [ "$2" = --detach ]; then ( sleep 10; exec '${realDocker}' "$@" ) >/dev/null 2>&1 </dev/null & exec sleep 30; fi`,
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      expect(() => prepareTaskFilesystems(clone, {
        workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
      // A budget that tolerates a loaded daemon; the keeper still lands after its client is killed at ~8 s.
      }, imageId, 8_000)).toThrow();
    } finally { process.env.PATH = path; }
    execFileSync('sleep', ['3']);
    const orphans = [...keepers()].filter(id => !before.has(id));
    for (const id of orphans) docker('rm', '--force', id);
    expect(orphans).toEqual([]);
  }, 60_000);

  it('rejects a task keeper whose restart policy was changed', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    docker('update', '--restart=always', data.filesystems.keeper);
    try {
      docker(...valid.args); containers.add(valid.name);
      expect(() => validateContainer(valid.name, valid)).toThrow('trusted keeper');
    } finally { docker('update', '--restart=no', data.filesystems.keeper); }
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('bounds profile revalidation by the invocation deadline, even with the default budget', () => {
    const data = fixture(), captured = Date.now(), late = profile(data, 'planning', 'noop', { deadlineMs: 6_000 });
    execFileSync('sleep', [String(Math.max(0, captured + 6_500 - Date.now()) / 1000)]);
    expect(() => assertContainerProfile(late)).toThrow('deadline has passed');
  }, 60_000);

  it('refuses to launch once the captured invocation deadline has passed', () => {
    const data = fixture(), captured = Date.now(), late = profile(data, 'planning', 'noop', { deadlineMs: 6_000 });
    execFileSync('sleep', [String(Math.max(0, captured + 6_500 - Date.now()) / 1000)]);
    expect(() => runContainer(late, 60_000)).toThrow('deadline has passed');
  }, 60_000);

  it('refuses to build a profile once the invocation deadline has passed', () => {
    const data = fixture(), trusted = governed(invocation(data.clone, 'planning', 'codex', 5_000));
    const wait = Math.max(0, trusted.invocation.deadline - Date.now() + 500);
    execFileSync('sleep', [String(wait / 1000)]);
    const started = performance.now();
    expect(() => createContainerProfile({ ...trusted, filesystems: data.filesystems, inputDirectory: data.input,
      codexAuthFile: data.fakeAuth, imageId })).toThrow('deadline has passed');
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it('refuses an invocation copied from a captured request with a different phase', () => {
    const data = fixture(), trusted = governed(invocation(data.clone, 'review'));
    const forged = { ...trusted.invocation, phase: 'execute' as Phase };
    expect(() => createContainerProfile({ ...trusted, invocation: forged, filesystems: data.filesystems,
      inputDirectory: data.input, codexAuthFile: data.fakeAuth, imageId })).toThrow('captured');
  }, 60_000);

  it('removes the claimed vendor network when profile creation fails after the claim', () => {
    const data = fixture();
    expect(() => profile(data, 'planning', 'noop', { codexAuthFile: join(data.root, 'missing-auth.json') })).toThrow();
    const orphan = vendorNetworks.at(-1)!;
    expect(spawnSync('docker', ['network', 'inspect', orphan.name], { stdio: 'ignore' }).status).not.toBe(0);
    expect(spawnSync('docker', ['container', 'inspect', orphan.proxyContainer], { stdio: 'ignore' }).status).not.toBe(0);
  }, 60_000);

  it('does not let a copied profile start or remove the original container', () => {
    const data = fixture(), live = profile(data, 'planning', 'noop');
    expect(createValidatedContainer(live)).toBe(live.name); containers.add(live.name);
    const copy = Object.freeze({ ...live });
    expect(() => startValidatedContainer(copy)).toThrow('trusted profile builder');
    expect(() => runContainer(copy)).toThrow('trusted profile builder');
    expect(spawnSync('docker', ['container', 'inspect', live.name], { stdio: 'ignore' }).status).toBe(0);
    docker('rm', '--force', live.name); containers.delete(live.name);
  }, 60_000);

  it('refuses a Codex auth path that is a link without resolving it', () => {
    const data = fixture(), link = join(data.root, 'auth-link.json');
    symlinkSync(data.fakeAuth, link);
    expect(() => profile(data, 'planning', 'noop', { codexAuthFile: link })).toThrow('not a link');
  }, 60_000);

  it('rejects an alternate Docker runtime that may not honour the checked isolation', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    docker(...valid.args.map(arg => arg === '--runtime=runc' ? '--runtime=io.containerd.runc.v2' : arg));
    containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects a restart policy that could relaunch the agent after it exits', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    docker(...valid.args.slice(0, imageIndex), '--restart=always', ...valid.args.slice(imageIndex));
    containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects added capabilities and conflicting or duplicate filesystem options', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    const imageIndex = valid.args.indexOf(imageId);
    const args = [...valid.args.slice(0, imageIndex), '--cap-add=SYS_ADMIN', ...valid.args.slice(imageIndex)];
    docker(...args); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    const state = JSON.parse(docker('container', 'inspect', valid.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const expected = ['size=1024', 'nr_inodes=16', 'uid=10001', 'gid=10001', 'mode=0755', 'nosuid', 'nodev'];
    expect(hasExactOptions(expected.join(','), expected)).toBe(true);
    expect(hasExactOptions([...expected, 'size=2048'].join(','), expected)).toBe(false);
    expect(hasExactOptions([...expected, 'dev'].join(','), expected)).toBe(false);
    expect(hasExactOptions([...expected, 'nosuid'].join(','), expected)).toBe(false);
  }, 60_000);

  it('rejects an unauthorized network before the container can start', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    const args = valid.args.map(value => value.startsWith('--network=') ? '--network=bridge' : value);
    docker(...args); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    const state = JSON.parse(docker('container', 'inspect', valid.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const dnsArgs = valid.args.map(value => value === '--dns=127.0.0.1' ? '--dns=8.8.8.8' : value);
    docker(...dnsArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('DNS configuration');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    for (const extra of [['--add-host=api.openai.com:127.0.0.1'], ['--publish=127.0.0.1::3128']]) {
      const changedArgs = [...valid.args.slice(0, valid.args.indexOf(imageId)), ...extra,
        ...valid.args.slice(valid.args.indexOf(imageId))];
      docker(...changedArgs); containers.add(valid.name);
      expect(() => validateContainer(valid.name, valid)).toThrow('host or port configuration');
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    }

    const imageIndex = valid.args.indexOf(imageId);
    const namespaceArgs = [...valid.args.slice(0, imageIndex), '--uts=host', ...valid.args.slice(imageIndex)];
    docker(...namespaceArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const resourceArgs = [...valid.args.slice(0, imageIndex), '--memory-swap=-1', ...valid.args.slice(imageIndex)];
    docker(...resourceArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('rejects a new endpoint attached to the invocation network before launch', () => {
    const data = fixture(), valid = profile(data, 'planning', 'must-not-run');
    const rogue = `codeboost-rogue-${randomUUID()}`;
    try {
      docker('run', '--detach', '--name', rogue, `--network=${valid.network.name}`, '--entrypoint', 'node', imageId,
        '-e', 'setInterval(()=>{},1000)');
      expect(() => createValidatedContainer(valid)).toThrow('cleanup did not settle');
      const absent = spawnSync('docker', ['container', 'inspect', valid.name], { encoding: 'utf8' });
      expect(absent.status).not.toBe(0);
    } finally {
      spawnSync('docker', ['rm', '--force', rogue], { stdio: 'ignore' });
      disposeContainerProfile(valid);
    }
  }, 60_000);

  it('revalidates the agent attachment immediately before start', () => {
    const data = fixture(), valid = profile(data, 'planning', 'must-not-run');
    createValidatedContainer(valid); containers.add(valid.name);
    docker('network', 'disconnect', valid.network.name, valid.name);
    docker('network', 'connect', 'bridge', valid.name);
    expect(() => startValidatedContainer(valid)).toThrow(/network attachment|lockdown/);
    containers.delete(valid.name);
    expect(spawnSync('docker', ['container', 'inspect', valid.name]).status).not.toBe(0);
  }, 60_000);

  it('creates containers from the captured immutable image rather than its mutable tag', () => {
    const data = fixture(), valid = profile(data, 'planning', 'noop');
    expect(valid.expectedImage).toBe(imageId);
    expect(valid.args).toContain(imageId);
    expect(valid.args).not.toContain(AGENT_IMAGE);
    const untrustedDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => assertBuiltAgentImage(untrustedDigest)).toThrow('trusted validated builder');
    expect(() => prepareTaskFilesystems(data.clone, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, untrustedDigest)).toThrow('trusted validated builder');
    expect(() => prepareTaskFilesystems(data.clone, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, AGENT_IMAGE)).toThrow('immutable built image ID');
    expect(() => prepareTaskFilesystems({ ...data.clone }, {
      workBytes: 1024, workInodes: 16, metadataBytes: 1024, metadataInodes: 16,
    }, imageId)).toThrow('trusted clone builder');
  }, 60_000);

  if (process.env.CODEBOOST_RUN_AUTH_PROBES === '1') {
    it('runs the authenticated Codex startup path with isolated writable state', () => {
      const data = fixture(), authFile = process.env.CODEBOOST_CODEX_AUTH_FILE;
      if (!authFile) throw new Error('CODEBOOST_CODEX_AUTH_FILE is required.');
      const authProfile = profile(data, 'planning', policy => createCodexCommand(policy,
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, without quotes or Markdown formatting.'),
      { authProbe: true, codexAuthFile: authFile, deadlineMs: 5 * 60_000 });
      // The production launch path: create, validate, start and remove. Raw stdout can carry more than the final
      // message, so the value must appear as a complete line; the adapter probe checks the exact file channel.
      const output = runContainer(authProfile, 5 * 60_000);
      expect(output.split(/\r?\n/)).toContain('codeboost-schema-marker');
    }, 6 * 60_000);

    it('runs the authenticated Claude startup path with only its OAuth token', () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const authProfile = profile(data, 'planning', policy => createClaudeCommand(policy,
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, without quotes or Markdown formatting.'),
        { vendor: 'claude', authProbe: true, claudeToken: token, deadlineMs: 5 * 60_000 });
      // The production launch path, with the token passed only as the Claude profile's secret.
      const output = runContainer(authProfile, 5 * 60_000, { CLAUDE_CODE_OAUTH_TOKEN: token });
      const envelope = JSON.parse(output) as { result?: string; is_error?: boolean };
      expect(envelope.is_error).not.toBe(true);
      expect(envelope.result?.replace(/\r?\n$/, '')).toBe('codeboost-schema-marker');
    }, 6 * 60_000);
  }
});

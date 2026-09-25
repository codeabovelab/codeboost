import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureInvocation, type InvocationInput, type Phase } from '../agents/contract.ts';
import { AGENT_IMAGE, assertBuiltAgentImage, buildAgentImage } from '../agents/container/image.ts';
import { createContainerProfile, disposeContainerProfile } from '../agents/container/profile.ts';
import { createValidatedContainer, prepareTaskFilesystems, removeTaskFilesystems, runContainer, startValidatedContainer,
  hasExactOptions, validateContainer } from '../agents/container/run.ts';
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

function fixture(options: { limits?: Parameters<typeof prepareTaskFilesystems>[1]; historyBytes?: number } = {}) {
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
    const state = JSON.parse(docker('container', 'inspect', first.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', first.name); containers.delete(first.name);
  }, 60_000);

  it('retains credentials when a killed create cannot be proven absent', () => {
    const data = fixture(), unsettled = profile(data, 'planning', 'noop');
    const shim = join(data.root, 'docker-shim'); mkdirSync(shim);
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // The create client hangs until its deadline kills it, so the daemon outcome stays unknown.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', 'if [ "$1" = create ]; then exec sleep 30; fi',
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try { expect(() => createValidatedContainer(unsettled, 1_000)).toThrow('cleanup did not settle'); }
    finally { process.env.PATH = path; }
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
      `if [ "$1" = run ] && [ "$2" = --detach ]; then ( sleep 4; exec '${realDocker}' "$@" ) >/dev/null 2>&1 </dev/null & exec sleep 30; fi`,
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      expect(() => prepareTaskFilesystems(clone, {
        workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
      }, imageId, 2_000)).toThrow();
    } finally { process.env.PATH = path; }
    execFileSync('sleep', ['6']);
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

  it('refuses to launch once the captured invocation deadline has passed', () => {
    const data = fixture(), late = profile(data, 'planning', 'noop', { deadlineMs: 1_500 });
    execFileSync('sleep', ['2']);
    expect(() => runContainer(late, 60_000)).toThrow('deadline has passed');
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
        'Reply only with this exact marker: codeboost-schema-marker'),
      { authProbe: true, codexAuthFile: authFile });
      docker(...authProfile.args); containers.add(authProfile.name);
      const output = docker('start', '--attach', authProfile.name);
      docker('rm', '--force', authProfile.name); containers.delete(authProfile.name);
      expect(output).toContain('codeboost-schema-marker');
    }, 6 * 60_000);

    it('runs the authenticated Claude startup path with only its OAuth token', () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const authProfile = profile(data, 'planning', policy => createClaudeCommand(policy,
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field, without quotes or Markdown formatting.'),
        { vendor: 'claude', authProbe: true, claudeToken: token });
      const result = execFileSync('docker', authProfile.args, { encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, CLAUDE_CODE_OAUTH_TOKEN: token } });
      void result; containers.add(authProfile.name);
      const output = docker('start', '--attach', authProfile.name);
      docker('rm', '--force', authProfile.name); containers.delete(authProfile.name);
      const envelope = JSON.parse(output) as { result?: string; is_error?: boolean };
      expect(envelope.is_error).not.toBe(true);
      // Tolerate one wrapping pair of backticks or quotes, but nothing else around the value.
      const value = envelope.result?.trim().replace(/^(`+|"|')([^]*)\1$/, '$2').trim();
      expect(value).toBe('codeboost-schema-marker');
    }, 6 * 60_000);
  }
});

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureInvocation, type InvocationInput, type Phase } from '../agents/contract.ts';
import { AGENT_IMAGE, assertBuiltAgentImage, buildAgentImage } from '../agents/container/image.ts';
import { createContainerProfile, disposeContainerProfile } from '../agents/container/profile.ts';
import { createValidatedContainer, prepareTaskFilesystems, removeTaskFilesystems, runContainer,
  hasExactOptions, validateContainer } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';

const roots: string[] = [];
const taskFilesystems: ReturnType<typeof prepareTaskFilesystems>[] = [];
const containers = new Set<string>();
const profiles: ReturnType<typeof createContainerProfile>[] = [];
let imageId = '';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-container-')); roots.push(root);
  const source = join(root, 'source'), staging = join(root, 'staging'), input = join(root, 'input');
  mkdirSync(source); mkdirSync(staging); mkdirSync(input);
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file.txt'), 'trusted\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
  writeFileSync(join(input, 'schema.json'), '{"probe":"codeboost-schema-marker"}\n');
  chmodSync(join(input, 'schema.json'), 0o444); chmodSync(input, 0o555);
  const clone = createTaskClone({ source, parent: staging, taskId: 'task-1', head: git(source, 'rev-parse', 'HEAD') });
  const filesystems = prepareTaskFilesystems(clone, {
    workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512,
  }, imageId);
  taskFilesystems.push(filesystems);
  const fakeAuth = join(root, 'auth.json'); writeFileSync(fakeAuth, '{}', { mode: 0o600 });
  return { root, source, input, clone, filesystems, fakeAuth };
}

function invocation(clone: ReturnType<typeof createTaskClone>, phase: Phase, vendor: 'codex' | 'claude' = 'codex'): InvocationInput {
  return captureInvocation({ clone, phase, vendor, approvedArgv: phase === 'planning' || phase === 'questions' ? [] : [['git', 'status']],
    deadline: Date.now() + 60_000, attemptId: `${vendor}-${phase}-${Math.random().toString(16).slice(2)}`,
    context: { snapshotId: 'snapshot-1', planId: 'plan-1', planRevision: 1, assignmentId: 'assignment-1',
      referencedCodeHash: 'code-1', stateVersion: 1 } });
}

function profile(data: ReturnType<typeof fixture>, phase: Phase, command: string[], options: {
  vendor?: 'codex' | 'claude'; authProbe?: boolean; codexAuthFile?: string; claudeToken?: string;
} = {}) {
  const vendor = options.vendor ?? 'codex';
  const base = createContainerProfile({ invocation: invocation(data.clone, phase, vendor), filesystems: data.filesystems,
    inputDirectory: data.input, command,
    imageId,
    codexAuthFile: vendor === 'codex' ? (options.codexAuthFile ?? data.fakeAuth) : undefined,
    claudeToken: vendor === 'claude' ? options.claudeToken : undefined });
  profiles.push(base);
  return base;
}

beforeAll(() => { imageId = buildAgentImage(); }, 10 * 60_000);
afterAll(() => {
  for (const container of containers) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  for (const filesystems of taskFilesystems.reverse()) removeTaskFilesystems(filesystems);
  for (const profile of profiles) disposeContainerProfile(profile);
  for (const root of roots.reverse()) {
    chmodSync(join(root, 'input'), 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 120_000);

describe('real Docker agent isolation', () => {
  it('runs read-only with no root capabilities, host paths, inherited secrets, or writable tools', () => {
    const data = fixture();
    process.env.HOST_SECRET_SENTINEL = 'must-not-reach-container';
    try {
      const output = runContainer(profile(data, 'planning', ['sh', '-c', ['set -eu',
        'test "$(id -u)" = 10001',
        'test "$(git status --porcelain)" = ""',
        'test ! -e "$1"',
        'test -z "${HOST_SECRET_SENTINEL:-}"',
        '! touch /work/forbidden',
        '! touch /usr/bin/forbidden',
        'touch /tmp/allowed "$HOME/allowed"',
        'printf isolated',
      ].join('; '), 'probe', data.source]));
      expect(output).toBe('isolated');
    } finally { delete process.env.HOST_SECRET_SENTINEL; }
  }, 60_000);

  it('persists execution changes while replacing HOME and scratch for each invocation', () => {
    const data = fixture();
    expect(runContainer(profile(data, 'execute', ['sh', '-c',
      'set -eu; printf generated > /work/generated.txt; touch /tmp/old "$HOME/old"; printf first']))).toBe('first');
    const output = runContainer(profile(data, 'execute', ['sh', '-c',
      'set -eu; test -f /work/generated.txt; test ! -e /tmp/old; test ! -e "$HOME/old"; git status --porcelain']));
    expect(output).toContain('?? generated.txt');
  }, 60_000);

  it('enforces work byte and inode ceilings before writes can exceed the allocation', () => {
    const data = fixture();
    const output = runContainer(profile(data, 'execute', ['sh', '-c', ['set -eu',
      '! dd if=/dev/zero of=/work/overflow bs=1M count=32 2>/dev/null',
      'rm -f /work/overflow',
      'mkdir /work/many',
      'i=0; while touch "/work/many/$i" 2>/dev/null; do i=$((i+1)); test "$i" -lt 2000; done',
      'test "$i" -lt 2000',
      'test "$(find /work/many -type f | wc -l)" -eq "$i"',
      'rm -rf /work/many',
      'printf bounded',
    ].join('; ')]));
    expect(output).toBe('bounded');
  }, 60_000);

  it('keeps Git metadata read-only, on another filesystem, and mounted against replacement', () => {
    const data = fixture();
    const output = runContainer(profile(data, 'execute', ['sh', '-c', ['set -eu',
      '! touch /work/.git/forbidden 2>/dev/null',
      '! ln /work/.git/HEAD /work/metadata-link 2>/dev/null',
      '! mv /work/.git /work/replaced 2>/dev/null',
      'git status --porcelain',
      'printf metadata-safe',
    ].join('; ')]));
    expect(output).toBe('metadata-safe');
  }, 60_000);

  it('refuses a container missing read-only root before its command runs', () => {
    const data = fixture();
    const valid = profile(data, 'planning', ['sh', '-c', 'touch /tmp/command-ran']);
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
    expect(() => createContainerProfile({ invocation: invocation(data.clone, 'planning', 'codex'),
      filesystems: data.filesystems, inputDirectory: data.input, command: ['true'], codexAuthFile: data.fakeAuth,
      claudeToken: 'must-not-combine', imageId })).toThrow('only');
    expect(() => createContainerProfile({ invocation: invocation(data.clone, 'planning', 'claude'),
      filesystems: data.filesystems, inputDirectory: data.input, command: ['true'], imageId })).toThrow('OAuth');
    const claudeProfile = createContainerProfile({ invocation: invocation(data.clone, 'planning', 'claude'),
      filesystems: data.filesystems, inputDirectory: data.input, command: ['true'], imageId,
      claudeToken: 'serialization-sentinel' });
    expect(JSON.stringify(claudeProfile)).not.toContain('serialization-sentinel');
    expect(() => createValidatedContainer(claudeProfile)).toThrow('OAuth environment credential');
    expect(() => createContainerProfile({ invocation: invocation(data.clone, 'planning'),
      filesystems: data.filesystems, inputDirectory: data.input, command: [], imageId })).toThrow('argv');
    expect(() => createContainerProfile({ invocation: invocation(data.clone, 'planning'),
      filesystems: data.filesystems, inputDirectory: data.input, command: ['true'], codexAuthFile: data.fakeAuth,
      imageId: AGENT_IMAGE })).toThrow('immutable built image ID');
    chmodSync(data.input, 0o755); writeFileSync(join(data.input, 'extra.json'), '{}'); chmodSync(data.input, 0o555);
    expect(() => profile(data, 'planning', ['true'])).toThrow('only one bounded');
  });

  it('rejects unexpected host mounts and unbounded task volumes after Docker resolves them', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
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

  it('rejects cloned profiles and host inputs changed after capture', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
    const forged = Object.freeze({ ...valid, inputDirectory: '/',
      args: Object.freeze(valid.args.map(value => value.includes(`source=${data.input},`)
        ? value.replace(`source=${data.input},`, 'source=/,') : value)) });
    expect(() => createValidatedContainer(forged)).toThrow('trusted profile builder');

    expect(() => createContainerProfile({ invocation: invocation(data.clone, 'planning'),
      filesystems: { ...data.filesystems }, inputDirectory: data.input, command: ['true'], codexAuthFile: data.fakeAuth,
      imageId })).toThrow('trusted allocator');

    const other = fixture();
    expect(() => createContainerProfile({ invocation: invocation(other.clone, 'planning'),
      filesystems: data.filesystems, inputDirectory: other.input, command: ['true'], codexAuthFile: other.fakeAuth,
      imageId })).toThrow('do not belong to the invocation clone');

    writeFileSync(data.fakeAuth, '{"changed":true}');
    expect(valid.codexAuthFile).not.toBe(data.fakeAuth);
    expect(readFileSync(valid.codexAuthFile!, 'utf8')).toBe('{}');
    expect(statSync(valid.codexAuthFile!).mode & 0o777).toBe(0o444);
    writeFileSync(data.fakeAuth, '{}');

    chmodSync(data.input, 0o755); writeFileSync(join(data.input, 'extra.json'), '{}'); chmodSync(data.input, 0o555);
    expect(() => createValidatedContainer(valid)).toThrow('only one bounded');
    chmodSync(data.input, 0o755); rmSync(join(data.input, 'extra.json')); chmodSync(data.input, 0o555);
  }, 60_000);

  it('rejects extra security policies and environment paths that can escape bounded storage', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
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

    for (const changedCache of ['npm_config_cache=/work/npm-cache', 'XDG_CACHE_HOME=/work/xdg-cache']) {
      const cacheArgs = [...valid.args.slice(0, imageIndex), '--env', changedCache, ...valid.args.slice(imageIndex)];
      docker(...cacheArgs); containers.add(valid.name);
      expect(() => validateContainer(valid.name, valid)).toThrow('isolation environment');
      docker('rm', '--force', valid.name); containers.delete(valid.name);
    }
  }, 60_000);

  it('does not remove an active container when a duplicate attempt name collides', () => {
    const data = fixture(), captured = invocation(data.clone, 'planning');
    const first = createContainerProfile({ invocation: captured, filesystems: data.filesystems,
      inputDirectory: data.input, command: ['true'], codexAuthFile: data.fakeAuth, imageId });
    const duplicate = createContainerProfile({ invocation: captured, filesystems: data.filesystems,
      inputDirectory: data.input, command: ['true'], codexAuthFile: data.fakeAuth, imageId });
    profiles.push(first, duplicate);
    docker(...first.args); containers.add(first.name);
    expect(() => createValidatedContainer(duplicate)).toThrow();
    const state = JSON.parse(docker('container', 'inspect', first.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', first.name); containers.delete(first.name);
  }, 60_000);

  it('rejects added capabilities and conflicting or duplicate filesystem options', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
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

  it('rejects a caller-mutated network before the container can start', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
    const args = valid.args.map(value => value === '--network=none' ? '--network=bridge' : value);
    docker(...args); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    const state = JSON.parse(docker('container', 'inspect', valid.name))[0] as { State: { Status: string } };
    expect(state.State.Status).toBe('created');
    docker('rm', '--force', valid.name); containers.delete(valid.name);

    const imageIndex = valid.args.indexOf(imageId);
    const namespaceArgs = [...valid.args.slice(0, imageIndex), '--uts=host', ...valid.args.slice(imageIndex)];
    docker(...namespaceArgs); containers.add(valid.name);
    expect(() => validateContainer(valid.name, valid)).toThrow('lockdown');
    docker('rm', '--force', valid.name); containers.delete(valid.name);
  }, 60_000);

  it('creates containers from the captured immutable image rather than its mutable tag', () => {
    const data = fixture(), valid = profile(data, 'planning', ['true']);
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
  });

  if (process.env.CODEBOOST_RUN_AUTH_PROBES === '1') {
    it('runs the authenticated Codex startup path with isolated writable state', () => {
      const data = fixture(), authFile = process.env.CODEBOOST_CODEX_AUTH_FILE;
      if (!authFile) throw new Error('CODEBOOST_CODEX_AUTH_FILE is required.');
      const authProfile = profile(data, 'planning', ['sh', '-c', [
        "codex exec --sandbox read-only --skip-git-repo-check --output-last-message /tmp/codex-output.txt 'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field.' >/tmp/codex-events.jsonl",
        'grep -Fx codeboost-schema-marker /tmp/codex-output.txt',
      ].join('; ')], { authProbe: true, codexAuthFile: authFile });
      const args = authProfile.args.map(value => value === '--network=none' ? '--network=bridge' : value);
      docker(...args); containers.add(authProfile.name);
      const output = docker('start', '--attach', authProfile.name);
      docker('rm', '--force', authProfile.name); containers.delete(authProfile.name);
      expect(output).toBe('codeboost-schema-marker');
    }, 6 * 60_000);

    it('runs the authenticated Claude startup path with only its OAuth token', () => {
      const data = fixture(), token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required.');
      const authProfile = profile(data, 'planning', ['claude', '-p',
        'Read /run/codeboost-input/schema.json and reply only with the exact value of its probe field.',
        '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', 'Read', '--add-dir', '/run/codeboost-input',
      '--disallowedTools', 'WebFetch,WebSearch'], { vendor: 'claude', authProbe: true, claudeToken: token });
      const args = authProfile.args.map(value => value === '--network=none' ? '--network=bridge' : value);
      const result = execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, CLAUDE_CODE_OAUTH_TOKEN: token } });
      void result; containers.add(authProfile.name);
      const output = docker('start', '--attach', authProfile.name);
      docker('rm', '--force', authProfile.name); containers.delete(authProfile.name);
      const envelope = JSON.parse(output) as { result?: string; is_error?: boolean };
      expect(envelope.is_error).not.toBe(true);
      expect(envelope.result?.trim()).toBe('codeboost-schema-marker');
    }, 6 * 60_000);
  }
});

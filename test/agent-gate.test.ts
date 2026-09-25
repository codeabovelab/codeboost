import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureInvocation, type Phase } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { createIsolationProbeCommand, createPhasePolicy, type IsolationProbe } from '../agents/policy.ts';

// The gate is only meaningful if its probes fail when isolation breaks. Each case runs the exact production probe
// script in a container deliberately built without one protection, bypassing the profile and its validator, and
// requires the probe to report that breach instead of its success marker. The same probes pass under real profiles
// in agent-container.test.ts, so each failure here is caused by the injected breach.

let imageId = '', attempt = 0;
const probeScript = (phase: Phase, probe: IsolationProbe) => {
  const policy = createPhasePolicy(captureInvocation({
    clone: { id: 'gate-clone', taskId: 'gate-task', directory: '/tmp/gate', head: 'a'.repeat(40) },
    vendor: 'codex', phase, approvedArgv: ['planning', 'questions'].includes(phase) ? [] : [['git', 'status']],
    deadline: Date.now() + 60_000, attemptId: `gate-${phase}-${probe}-${++attempt}`,
    context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
  }));
  const argv = createIsolationProbeCommand(policy, probe).argv;
  expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
  return argv[2]!;
};
// A committed repository whose metadata lives on its own filesystem, as in a real task container.
const seedRepository = 'git init -q /work && git -C /work -c user.name=gate -c user.email=gate@example.com '
  + 'commit -q --allow-empty -m seed';
const runBroken = (mounts: readonly string[], script: string, env: readonly string[] = []) => spawnSync('docker', ['run',
  '--rm', '--network=none', '--user', '10001:10001', '--env', 'HOME=/home/codeboost', ...env, '--workdir', '/work', ...mounts,
  ...(mounts.some(mount => mount.startsWith('/home/codeboost:')) ? []
    : ['--tmpfs', '/home/codeboost:rw,size=1048576,nr_inodes=128,uid=10001,gid=10001,mode=0700']),
  '--entrypoint', 'sh', imageId, '-c', `${seedRepository} && ${script}`],
{ encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
const tmpfs = (target: string, options: string) => ['--tmpfs', `${target}:rw,uid=10001,gid=10001,${options}`];
const bounded = tmpfs('/work', 'size=16m,nr_inodes=512');
const writableMetadata = tmpfs('/work/.git', 'size=16m,nr_inodes=512');
const boundedScratch = tmpfs('/tmp', 'size=32m,nr_inodes=4096');

beforeAll(() => { imageId = buildAgentImage(); }, 10 * 60_000);

describe('isolation gate detects breaches', () => {
  it.each([
    ['writable Git metadata', 'execute', 'metadata', [...bounded, ...writableMetadata, ...boundedScratch],
      'isolation breach: touch /work/.git/forbidden'],
    ['writable Git metadata under alias attacks', 'execute', 'metadata-alias',
      [...bounded, ...writableMetadata, ...boundedScratch], 'isolation breach: sh -c printf x >> /tmp/config-alias'],
    ['a writable worktree in a read-only phase', 'planning', 'read-only-isolation',
      [...bounded, ...writableMetadata, ...boundedScratch], 'isolation breach: touch /work/forbidden'],
    ['a writable worktree for the phase probe', 'review', 'phase-worktree',
      [...bounded, ...writableMetadata, ...boundedScratch], 'isolation breach: touch /work/review.txt'],
    ['an unbounded task filesystem', 'execute', 'capacity',
      [...tmpfs('/work', 'size=256m'), ...writableMetadata, ...boundedScratch],
      'isolation breach: dd if=/dev/zero of=/work/overflow'],
    ['an unbounded HOME', 'execute', 'scratch-capacity',
      [...bounded, ...writableMetadata, ...boundedScratch, ...tmpfs('/home/codeboost', 'size=256m,mode=0700')],
      'isolation breach: dd if=/dev/zero of=/home/codeboost/overflow'],
    ['unbounded scratch', 'execute', 'scratch-capacity',
      [...bounded, ...writableMetadata, ...tmpfs('/tmp', 'size=256m')], 'isolation breach: dd if=/dev/zero of=/tmp/overflow'],
  ] as const)('fails the probe for %s', (_label, phase, probe, mounts, breach) => {
    const result = runBroken(mounts, probeScript(phase, probe));
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(breach);
  }, 180_000);

  it('fails the scratch probe for a Codex container whose Codex scratch areas are missing', () => {
    // Missing scratch areas must fail the probe, not skip their checks and report the container as bounded.
    const result = runBroken([...bounded, ...writableMetadata, ...boundedScratch],
      probeScript('execute', 'scratch-capacity'), ['--env', 'CODEBOOST_VENDOR=codex']);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).not.toContain('scratch-bounded');
  }, 120_000);

  it('fails the hostile-repository probe when a repository link resolves inside the container', () => {
    // A link that resolves is readable through the checkout, whatever it contains.
    const linked = 'ln -s /etc/hostname /work/escape && ln -s /nonexistent /work/escape-dir && git -C /work add -A '
      + '&& git -C /work -c user.name=gate -c user.email=gate@example.com commit -q -m links && ';
    const result = runBroken([...bounded, ...writableMetadata, ...boundedScratch],
      linked + probeScript('execute', 'hostile-repo'));
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('isolation breach: cat /work/escape');
  }, 120_000);

  it('fails the hostile-repository probe when secret content reaches the task filesystem', () => {
    // Stand-in for a seeder that followed a symlink: the secret text is committed into /work behind the link names.
    const leaked = 'printf codeboost-host-secret > /work/leak && ln -s /work/leak /work/escape && ln -s /tmp /work/escape-dir '
      + '&& git -C /work add -A && git -C /work -c user.name=gate -c user.email=gate@example.com commit -q -m leak && ';
    const result = runBroken([...bounded, ...writableMetadata, ...boundedScratch],
      leaked + probeScript('execute', 'hostile-repo'));
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('isolation breach: grep -rqs codeboost-host-secret');
  }, 120_000);
});

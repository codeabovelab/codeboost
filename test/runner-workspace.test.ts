import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentImage } from '../agents/container/image.ts';
import { pathIdentityProbeArgs, probeTaskStoragePathIdentity, type TaskFilesystems } from '../agents/container/storage.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SafetyFindings, executionDeps, type ExecutionSources } from '../runner/execution.ts';
import { attemptRef, openRunnerRepository } from '../runner/runner-repository.ts';
import { ReviewService } from '../runner/review.ts';
import { Store } from '../runner/store.ts';
import { createTaskWorkspace } from '../runner/workspace.ts';
import { removeRunnerObjects } from './fixtures/docker-sweep.ts';
import { fixtureGit as git } from './fixtures/git.ts';

// F2b against the real lane D (#87): each item runs in fresh task storage cloned from the runner-owned repository, an
// agent edits the work volume, and the runner's audited commit is taken into that repository for the next item.
// Each run has its own runner owner, so the sweep after this file removes only what this run left behind.
const RUNNER_OWNER = randomBytes(16).toString('hex');
const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 1, revision: 1, summary: 'Two items', questions: [], items: [
  { id: 'P1', title: 'First', intent: 'Change a', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'x' }], acceptance: [{ type: 'check', text: 'a' }], depends_on: [] },
  { id: 'P2', title: 'Second', intent: 'Change b', files: [{ path: 'b.ts', kind: 'edit', renamed_from: null, change: 'y' }], acceptance: [{ type: 'check', text: 'b' }], depends_on: ['P1'] },
] };
const LIMITS = { workBytes: 16 * 1024 * 1024, workInodes: 512, metadataBytes: 16 * 1024 * 1024, metadataInodes: 512 };
let imageId = '';
const roots: string[] = [], stores: Store[] = [];
beforeAll(() => { imageId = buildAgentImage(); }, 10 * 60_000);
afterAll(() => {
  try {
    for (const store of stores) store.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  } finally {
    // Then remove the task storage and path identity probes this run still owns, and every container that holds one of
    // their volumes or networks, even when a test failed or the cleanup above threw. It may not run before a hook
    // timeout. The hook's 7 minutes leave a minute and a half over this sweep's worst case (eleven calls of 30 s), for
    // the cleanup before it.
    removeRunnerObjects(RUNNER_OWNER);
  }
}, 7 * 60_000);
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function setup(agent: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'runner-workspace-')); roots.push(root);
  const source = join(root, 'source'), runnerRoot = join(root, 'runner');
  git(root, 'init', '-q', source); git(source, 'config', 'user.name', 'T'); git(source, 'config', 'user.email', 't@e');
  writeFileSync(join(source, '.gitignore'), '*.log\n'); writeFileSync(join(source, 'a.ts'), 'a\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'b.ts'), 'b\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'head');
  const head = git(source, 'rev-parse', 'HEAD'), sourceRefs = git(source, 'for-each-ref');
  const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.ts', kind: 'file' }, { path: 'b.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
  const store = new Store(join(root, 'state.sqlite')); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, base, head);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const repository = await openRunnerRepository({ runnerRoot, runnerOwner: RUNNER_OWNER, repositoryId: identity.repositoryId, source });
  const workspace = createTaskWorkspace({ store, runnerRoot, runnerOwner: RUNNER_OWNER, repository, imageId, limits: LIMITS,
    committer: { name: 'codeboost', email: 'runner@codeboost.invalid' }, now: () => 1_700_000_000_000 });
  const sources: ExecutionSources = { planContext: () => context, checkpointContext: (_identity, commit) => {
    const review = new ReviewService({ database: join(root, 'state.sqlite'), repository: source, runnerRepository: repository.path,
      identity, pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' } });
    try { return review.planContextAt(commit); } finally { review.close(); }
  }, issue: () => ({ text: { number: 1, title: 'Issue', body: 'Fix', comments: [] }, validate: () => undefined }),
    lessons: () => [], vendor: () => 'claude' };
  const findings = new SafetyFindings(store);
  // The agent: a container that edits the work volume, mounted as an agent container mounts it (metadata read-only).
  const deps = executionDeps(store, workspace, (input, _prompt, ws) => {
    const { workVolume, metadataVolume } = (ws.storage as { filesystems: TaskFilesystems }).filesystems;
    const item = store.getAttempt(identity, input.attemptId).item!;
    const settled = promisify(execFile)('docker', ['run', '--rm', '--network=none', '--user', '10001:10001', '--tmpfs', '/tmp',
      '--mount', `type=volume,source=${workVolume},target=/work`, '--mount', `type=volume,source=${metadataVolume},target=/work/.git,readonly`,
      '--entrypoint', 'bash', imageId, '-c', `set -e; cd /work; ${agent[item] ?? 'true'}`])
      .then(() => ({ attemptId: input.attemptId, context: input.context, exitCode: 0, signal: null, stdout: '', stderr: '' }));
    return { attemptId: input.attemptId, settled, cancel: () => undefined };
  }, sources, RUNNER_OWNER, findings);
  const runner = new RunnerCoordinator(store, deps);
  return { root, source, runnerRoot, repository, store, base, head, sourceRefs, runner,
    executor: new ItemExecutor(store, runner, sources, findings) };
}
// Task storage volumes still labelled with one of this task's attempts.
const leftovers = (store: Store) => store.getAttempts(identity).flatMap(attempt =>
  docker('volume', 'ls', '-q', '--filter', `label=io.codeboost.attempt=${attempt.id}`).split('\n').filter(Boolean));

describe('real task workspace (#87)', () => {
  it('runs each item in fresh storage from the runner-owned repository and chains the runner commits there', async () => {
    const s = await setup({ P1: 'printf "a2\\n" > a.ts', P2: 'test "$(cat a.ts)" = a2 && printf "b2\\n" > b.ts' });
    expect(await s.executor.runTask(identity)).toEqual({ kind: 'executed', items: ['P1', 'P2'], unchanged: [] });
    const [first, second] = s.store.getAttempts(identity);
    const one = (first!.result as { head: string }).head, two = (second!.result as { head: string }).head;
    // Each commit is in the runner-owned repository under its attempt, P2's on top of P1's, P1's on the recorded head.
    expect(git(s.repository.path, 'rev-parse', attemptRef(first!.id), attemptRef(second!.id))).toBe(`${one}\n${two}`);
    expect(git(s.repository.path, 'rev-list', '--parents', '-n', '1', two)).toBe(`${two} ${one}`);
    expect(git(s.repository.path, 'rev-list', '--parents', '-n', '1', one)).toBe(`${one} ${s.head}`);
    expect(git(s.repository.path, 'show', `${two}:a.ts`)).toBe('a2');
    expect(git(s.repository.path, 'show', `${two}:b.ts`)).toBe('b2');
    expect(git(s.repository.path, 'log', '-1', '--format=%an <%ae> %at%n%B', one)).toBe('codeboost <runner@codeboost.invalid> 1700000000\nP1: First\n\nPlan-Item: P1\nPlan-Revision: r1');
    expect(s.store.getSnapshot(identity).head).toBe(two);
    // The user's repository is untouched: no refs, and no runner commit.
    expect(git(s.source, 'for-each-ref')).toBe(s.sourceRefs);
    expect(() => git(s.source, 'cat-file', '-e', one)).toThrow();
    // Storage and the staging clones are gone once each attempt settled.
    expect(leftovers(s.store)).toEqual([]);
    expect(readdirSync(join(s.runnerRoot, RUNNER_OWNER, 'attempts'))).toEqual([]);
    // The review screen reads the runner commits from the runner-owned repository, each owned by its item, and keeps the
    // recorded head: the user's HEAD (still the old commit) would roll the task back.
    const review = new ReviewService({ database: join(s.root, 'state.sqlite'), repository: s.source, runnerRepository: s.repository.path,
      identity, pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' } });
    try {
      const view = await review.load();
      expect(view.snapshot.head).toBe(two);
      // a.ts's lines are P1's own runner commit's.
      expect(view.segments.filter(segment => segment.path === 'a.ts').map(segment => [segment.row, segment.operation]))
        .toEqual([['P1', '-'], ['P1', '+']]);
      expect(review.reviewRepository()).toEqual({ path: s.repository.path, runnerOwned: true });
    } finally { review.close(); }
    // Without the runner-owned repository it fails rather than read the user's.
    const unconfigured = new ReviewService({ database: join(s.root, 'state.sqlite'), repository: s.source, identity,
      pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' } });
    try { await expect(unconfigured.load()).rejects.toThrow('needs the runner-owned repository'); } finally { unconfigured.close(); }
  }, 600_000);

  it('sends a file the repository ignores to needs human, and keeps no commit of it', async () => {
    const s = await setup({ P1: 'printf "a2\\n" > a.ts && printf "secret\\n" > debug.log' });
    const outcome = await s.executor.runTask(identity);
    expect(outcome).toMatchObject({ kind: 'needs human', item: 'P1' });
    expect((outcome as { reason: string }).reason).toContain('"debug.log", which the repository ignores');
    expect(s.store.getTask(identity).status).toBe('needs human');
    // Nothing was committed: no ref in the runner-owned repository, and the snapshot is still the recorded head.
    expect(git(s.repository.path, 'for-each-ref')).toBe('');
    expect(s.store.getSnapshot(identity).head).toBe(s.head);
    expect(leftovers(s.store)).toEqual([]);
    expect(existsSync(join(s.runnerRoot, RUNNER_OWNER, 'attempts', s.store.getAttempts(identity)[0]!.id))).toBe(false);
  }, 600_000);

  it('keeps a scope pause approvable after the review loads it from the runner-owned repository', async () => {
    const s = await setup({ P1: 'printf "a2\\n" > a.ts && printf "extra\\n" > extra.ts' });
    const outcome = await s.executor.runTask(identity) as { kind: string; checkpointId: string };
    expect(outcome).toMatchObject({ kind: 'needs amendment', item: 'P1', outOfScope: ['extra.ts'] });
    const checkpoint = s.store.getCheckpoint(identity, outcome.checkpointId);
    expect(checkpoint.baseEntries).toContainEqual({ path: 'extra.ts', kind: 'file' });
    // The review load reads the runner commit at the recorded head: it does not replace the checkpoint's snapshot.
    const review = new ReviewService({ database: join(s.root, 'state.sqlite'), repository: s.source, runnerRepository: s.repository.path,
      identity, pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' } });
    expect((await review.load()).snapshot.id).toBe(checkpoint.snapshotId);
    // A person amends the plan to declare the extra file, then approves continuing from the audited checkpoint.
    const amended = { ...plan, items: [{ ...plan.items[0]!, files: [...plan.items[0]!.files, { path: 'extra.ts', kind: 'add' as const, renamed_from: null, change: 'z' }] }, plan.items[1]!] };
    s.store.importRevision(JSON.stringify(amended), 'json', { identity, issue: 1, pathKey: p => p, allowedCommands: [],
      baseEntries: [{ path: 'a.ts', kind: 'file' }, { path: 'b.ts', kind: 'file' }] }, 1);
    const revision = s.store.getPlan(identity).revision;
    expect(() => s.store.approveContinuation(identity, outcome.checkpointId, { revision, snapshotId: checkpoint.snapshotId,
      reviewVersion: s.store.reviewVersion(identity) }, review.planContextAt(s.store.getSnapshot(identity).head))).not.toThrow();
    expect(s.store.continuationRevision(identity, outcome.checkpointId)).toBe(revision);
    review.close();
  }, 600_000);
});

describe('task storage path identity (#162)', () => {
  // The probe names its container itself and gives it an anonymous volume. This test finds both from the name the probe
  // gave, not by the runner label they carry (#181): a shim on PATH records it, and the daemon's events give that
  // container's ID and the volumes mounted in it. Another probe on the daemon (another runner's startup, or this file
  // run from another checkout) or a container a dead runner left behind does not count.
  async function watchedProbe() {
    const shim = mkdtempSync(join(tmpdir(), 'docker-shim-')); roots.push(shim);
    const names = join(shim, 'names'), realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // Not a fake: it records the argument after each separate `--name` (the form the probe uses; if that changed, no name
    // is recorded and the test fails) and runs the real docker with the same arguments, so every exit status, stdout
    // and stderr the probe reads is Docker's own.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', 'prev=',
      `for arg; do if [ "$prev" = --name ]; then printf '%s\\n' "$arg" >> '${names}'; fi; prev="$arg"; done`,
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    // --since replays from the daemon's event buffer, so nothing between this call and the stream's start is lost. The
    // minute of margin covers a daemon clock behind this one; it is harmless, as events are matched by the probe's own
    // name and IDs.
    const events: { Type: string; Action: string; Actor: { ID: string; Attributes: Record<string, string> } }[] = [];
    const stream = spawn(realDocker, ['events', '--since', String(Math.floor(Date.now() / 1000) - 60), '--format',
      '{{json .}}', '--filter', 'type=container', '--filter', 'type=volume'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffered = '';
    stream.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (buffered + chunk).split('\n'); buffered = lines.pop()!;
      for (const line of lines) if (line) events.push(JSON.parse(line));
    });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      const identity = await probeTaskStoragePathIdentity(imageId, RUNNER_OWNER);
      const recorded = readFileSync(names, 'utf8').split('\n').filter(Boolean);
      expect(recorded).toEqual([expect.stringMatching(/^codeboost-path-identity-[0-9a-f-]{36}$/)]);
      const container = () => events.find(event => event.Type === 'container' && event.Action === 'create'
        && event.Actor.Attributes.name === recorded[0])?.Actor.ID;
      const volumes = () => [...new Set(events.filter(event => event.Type === 'volume' && event.Action === 'mount'
        && event.Actor.Attributes.container === container()).map(event => event.Actor.ID))];
      // Wait for the daemon to report the container and its volumes destroyed, for up to 10 s; absence is still
      // proved by inspect below, so a destroy that never comes fails there.
      const destroyed = (type: string, id: string | undefined) =>
        events.some(event => event.Type === type && event.Action === 'destroy' && event.Actor.ID === id);
      for (const until = performance.now() + 10_000; performance.now() < until;) {
        if (container() && volumes().length && destroyed('container', container())
          && volumes().every(volume => destroyed('volume', volume))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { identity, container: container(), volumes: volumes() };
    } finally { process.env.PATH = path; stream.kill(); }
  }
  it('measures the tmpfs the agent edits, whatever the host folds, and leaves no container or volume behind', async () => {
    const probe = await watchedProbe();
    // Task storage is a tmpfs in the daemon's Linux kernel: case-sensitive, and names are compared as bytes. A macOS
    // host folder would report the reverse, which is why the probe does not read the host.
    expect(probe.identity).toEqual({ caseSensitive: true, unicodeNormalization: 'none' });
    // The events found the probe's container and its one volume, so the absence checks below look at real objects.
    expect(probe.container).toMatch(/^[0-9a-f]{64}$/);
    expect(probe.volumes).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    // In any state: a container created but never started would outlive --rm.
    expect(() => docker('container', 'inspect', probe.container!)).toThrow(/No such container/);
    expect(() => docker('volume', 'inspect', probe.volumes[0]!)).toThrow(/no such volume/i);
  }, 120_000);
  // A probe container created but never started, as a killed client leaves it: the probe's own arguments, with `create`
  // in place of `run` (`--rm` stays). Returns its name and the anonymous volume its mount made.
  const leftoverProbe = (runnerOwner: string) => {
    const name = `codeboost-path-identity-${randomUUID()}`, args = pathIdentityProbeArgs(imageId, runnerOwner, name);
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    docker('create', ...args.slice(1));
    return { name, volume: docker('container', 'inspect', '--format', '{{range .Mounts}}{{.Name}}{{end}}', name) };
  };
  it('removes a never-started probe container and its volume with the cleanup\'s own rm', () => {
    // The failure path's claim: a container created but never started (a killed client) loses its anonymous volume to
    // `rm --force --volumes`. Made with the probe's exact arguments; removed with the exact command the cleanup runs.
    let probe: { name: string; volume: string } | undefined;
    try {
      probe = leftoverProbe(RUNNER_OWNER);
      expect(probe.volume).toMatch(/^[0-9a-f]{64}$/);
      expect(docker('volume', 'inspect', '--format', '{{json .Options}}', probe.volume)).toContain('size=1048576,nr_inodes=64,');
    } finally { if (probe) docker('rm', '--force', '--volumes', probe.name); }
    expect(() => docker('volume', 'inspect', probe.volume)).toThrow();
  }, 120_000);
  it('removes a probe a killed runner left, with its volume, in the next startup\'s recovery, and no other runner\'s (#181)', async () => {
    // Tokens of their own: recovery removes every agent container of its runner, and this file's may have some.
    const mine = randomBytes(16).toString('hex'), theirs = randomBytes(16).toString('hex');
    try {
      const left = leftoverProbe(mine), other = leftoverProbe(theirs);
      // Both parts carry the runner's token and the probe kind.
      for (const labels of [docker('container', 'inspect', '--format', '{{json .Config.Labels}}', left.name),
        docker('volume', 'inspect', '--format', '{{json .Labels}}', left.volume)])
        expect(JSON.parse(labels)).toMatchObject({ 'io.codeboost.runner': mine, 'io.codeboost.probe': 'path-identity' });
      // A container of this runner, named like a probe, without the probe kind label: reported, never removed.
      const unmarked = `codeboost-path-identity-${randomUUID()}`;
      docker('create', '--name', unmarked, '--label', `io.codeboost.runner=${mine}`, '--entrypoint', 'true', imageId);
      const report = await recoverLeftovers(mine, 120_000, { unowned: false });
      expect(report.removed.map(resource => resource.name).sort()).toEqual([left.name, left.volume].sort());
      expect(() => docker('container', 'inspect', left.name)).toThrow(/No such container/);
      expect(() => docker('volume', 'inspect', left.volume)).toThrow(/no such volume/i);
      expect(report.unowned).toEqual([expect.objectContaining({ name: unmarked, reason: 'unknown-kind' })]);
      for (const ref of [other.name, unmarked]) expect(docker('container', 'inspect', '--format', '{{.State.Status}}', ref)).toBe('created');
      expect(docker('volume', 'inspect', '--format', '{{.Name}}', other.volume)).toBe(other.volume);
    } finally {
      // Each sweep may take up to 5.5 minutes, which the test's budget allows for.
      removeRunnerObjects(mine, 'test');
      removeRunnerObjects(theirs, 'test');
    }
  }, 14 * 60_000);
  it('runs only the image the trusted builder produced', async () => {
    await expect(probeTaskStoragePathIdentity(`sha256:${'0'.repeat(64)}`, RUNNER_OWNER)).rejects.toThrow('Agent image was not produced by the trusted validated builder.');
    await expect(probeTaskStoragePathIdentity('alpine', RUNNER_OWNER)).rejects.toThrow('requires the immutable built image ID');
  });
});

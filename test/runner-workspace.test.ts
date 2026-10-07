import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentImage } from '../agents/container/image.ts';
import type { TaskFilesystems } from '../agents/container/storage.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { RunnerCoordinator } from '../runner/coordinator.ts';
import { ItemExecutor, SafetyFindings, executionDeps, type ExecutionSources } from '../runner/execution.ts';
import { attemptRef, openRunnerRepository } from '../runner/runner-repository.ts';
import { ReviewService } from '../runner/review.ts';
import { Store } from '../runner/store.ts';
import { createTaskWorkspace } from '../runner/workspace.ts';
import { fixtureGit as git } from './fixtures/git.ts';

// F2b against the real lane D (#87): each item runs in fresh task storage cloned from the runner-owned repository, an
// agent edits the work volume, and the runner's audited commit is taken into that repository for the next item.
const RUNNER_OWNER = '0123456789abcdef0123456789abcdef';
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
  for (const store of stores) store.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
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
      const view = review.load();
      expect(view.snapshot.head).toBe(two);
      // a.ts's lines are P1's own runner commit's.
      expect(view.segments.filter(segment => segment.path === 'a.ts').map(segment => [segment.row, segment.operation]))
        .toEqual([['P1', '-'], ['P1', '+']]);
      expect(review.reviewRepository()).toEqual({ path: s.repository.path, runnerOwned: true });
    } finally { review.close(); }
    // Without the runner-owned repository it fails rather than read the user's.
    const unconfigured = new ReviewService({ database: join(s.root, 'state.sqlite'), repository: s.source, identity,
      pathIdentity: { caseSensitive: true, unicodeNormalization: 'none' } });
    try { expect(() => unconfigured.load()).toThrow('needs the runner-owned repository'); } finally { unconfigured.close(); }
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
    expect(review.load().snapshot.id).toBe(checkpoint.snapshotId);
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

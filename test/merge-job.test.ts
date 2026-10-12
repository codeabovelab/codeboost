import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { MergeCoordinator, type PublishedTarget } from '../runner/merge.ts';
import { MergeJobCoordinator, withMergeJob, type MergeJobView } from '../runner/merge-job.ts';
import type { PreMergeCoordinator, PreMergeResult } from '../runner/pre-merge.ts';
import type { ReviewService } from '../runner/review.ts';
import { MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type RemoteMergeState, type RequiredCheck } from '../github/merge.ts';
import { openingMarker } from '../github/pull-requests.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { commandDigest } from '../runner/checks.ts';

// F6b of #22: the one-click merge job (docs/implementation/merge-handoff.md).
const oid = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 'repo', taskId: 'Task_42', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 12, revision: 1, summary: 'Stop the crash', questions: [], items: [
  { id: 'P1', title: 'Guard input', intent: 'Reject empty input', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'Check it' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
const context: PlanContext = { identity, issue: 12, baseEntries: [{ path: 'a.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const BRANCH = 'codeboost/issue-12-task-42-0123456789abcdef';
const PUBLISHED: PublishedTarget = { repository: 'owner/repo', baseBranch: 'main', requiresPreparation: true };
const TIMING = { checkWaitMs: 2_000, firstDelayMs: 5, maxDelayMs: 20 };
const stores: Store[] = [], jobs: MergeJobCoordinator[] = [];
afterEach(async () => { for (const job of jobs.splice(0)) await job.close(); for (const store of stores.splice(0)) store.close(); });

/** A task in review whose runner published PR 7 with head oid(2) over oid(1). */
function publishedTask(): Store {
  const store = new Store(':memory:'); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
  store.markRunning(identity, attempt.id);
  store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
  const check = store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
  const opening = store.beginPullRequest(identity, { checkId: check.id, repository: 'owner/repo', base: 'main', headBranch: BRANCH, headSha: oid(2), draft: false });
  expect(store.recordPullRequestOpened(identity, opening.openingId, { number: 7, url: 'https://github.com/owner/repo/pull/7', headSha: oid(2), draft: false }, true)).toBe('in review');
  return store;
}
function service(store: Store) {
  const view = () => {
    const snapshot = store.getSnapshot(identity);
    return {
      items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
      plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: snapshot.id, base: snapshot.base, head: snapshot.head }, token: 'review-token',
      expected: { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) },
    };
  };
  return { store, config: { identity }, load: vi.fn(view), commandPolicyDigest: () => commandDigest([]) } as unknown as ReviewService;
}
/** Preparation as F5/F6a end it: `ready` records exact readiness on the job's own prepare-merge action. */
function preparation(store: Store, result: (call: number) => PreMergeResult['state'] | Error = () => 'ready') {
  const calls: string[] = [];
  const fake = {
    assertStartable: () => undefined,
    start: vi.fn(async (expected: { actionId: string }) => {
      calls.push(expected.actionId);
      const outcome = result(calls.length), snapshot = store.getSnapshot(identity);
      if (outcome instanceof Error) throw outcome;
      const readiness = { stateVersion: store.getTask(identity).stateVersion, reviewVersion: store.reviewVersion(identity),
        snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head, commandPolicyDigest: commandDigest([]) };
      const settled = { state: outcome, base: snapshot.base, head: snapshot.head, checked: [], reason: outcome === 'ready' ? null : `preparation ${outcome}` };
      return store.settlePreMergeAction(identity, expected.actionId, settled, outcome === 'ready' ? readiness : null);
    }),
  };
  return { fake: fake as unknown as PreMergeCoordinator, calls };
}
/** GitHub showing PR 7 as published; `checks(n)` gives the required checks of the n-th inspection. */
function github(store: Store, options: { checks?: (n: number) => RequiredCheck[]; change?: (n: number) => Partial<RemoteMergeState>;
  merge?: (signal?: AbortSignal) => Promise<{ url: string }>; queue?: boolean; unreadable?: (n: number) => boolean } = {}) {
  let inspections = 0;
  const merged: string[] = [];
  const client: MergeGateway = {
    inspect: vi.fn(async request => {
      inspections++;
      if (options.unreadable?.(inspections)) throw new Error('GitHub returned HTTP 502');
      const record = store.taskPullRequests(identity).find(pr => pr.number === 7)!;
      const snapshot = store.getSnapshot(identity);
      return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true,
        mergeQueue: options.queue === true, requiredChecks: options.checks?.(inspections) ?? [], alreadyFixed: 'clear', pullRequest: 7, draft: false,
        ...(request?.target?.headBranch ? { published: { headBranch: request.target.headBranch, baseBranch: 'main', crossRepository: false,
          marker: openingMarker(record.openingId), branchOpen: [{ number: 7, base: 'main' }] } } : {}),
        ...options.change?.(inspections) } as RemoteMergeState;
    }),
    merge: vi.fn(async (head, request) => { merged.push(head); return options.merge ? options.merge(request?.signal) : { url: 'https://github.com/owner/repo/pull/7' }; }),
    ...(options.queue ? {
      queueWatermark: vi.fn(async () => 'CURSOR'),
      inspectQueue: vi.fn(async (head: string) => ({ state: 'queued' as const, reviewedHead: head, entryId: 'E', phase: 'QUEUED' as const, position: 0,
        enqueuedAt: '2026-10-11T00:00:00Z', queueHead: head })),
    } satisfies MergeQueueGateway : {}),
  };
  return { client, merged, inspections: () => inspections };
}
function setup(options: Parameters<typeof github>[1] & { prepare?: Parameters<typeof preparation>[1] } = {}) {
  const store = publishedTask(), review = service(store), gh = github(store, options);
  const merges = new MergeCoordinator(review, gh.client, undefined, undefined, PUBLISHED);
  const prep = preparation(store, options.prepare);
  const coordinator = new MergeJobCoordinator(review, prep.fake, merges, undefined, TIMING); jobs.push(coordinator);
  return { store, review, gh, merges, prep, coordinator };
}
const settled = async (coordinator: MergeJobCoordinator) => { await coordinator.current; return coordinator.latest()!; };
const pending = (context = 'ci'): RequiredCheck => ({ context, appId: null, state: 'pending' });
const passing = (context = 'ci'): RequiredCheck => ({ context, appId: null, state: 'success' });

it('merges at once when the required set was read and is empty', async () => {
  const f = setup();
  const started = f.coordinator.start('review-token', randomUUID());
  expect(started).toMatchObject({ state: 'running', step: 'preparing' });
  expect(started).not.toHaveProperty('token');
  expect(await settled(f.coordinator)).toMatchObject({ state: 'merged', step: null, url: 'https://github.com/owner/repo/pull/7' });
  expect(f.gh.merged).toEqual([oid(2)]);
  expect(f.prep.calls).toHaveLength(1);
  expect(f.store.getTask(identity).status).toBe('merged');
});

it('waits while a required check is pending, then merges once it passes', async () => {
  const seen: string[] = [];
  const f = setup({ checks: n => (n <= 2 ? [pending()] : [passing()]) });
  const job = f.coordinator.start('review-token', randomUUID());
  const poll = setInterval(() => { const latest = f.coordinator.latest(); if (latest?.checks.length) seen.push(`${latest.step}:${latest.checks[0]!.state}`); }, 1);
  const done = await settled(f.coordinator); clearInterval(poll);
  expect(done).toMatchObject({ id: job.id, state: 'merged' });
  expect(seen).toContain('checks:pending');
  expect(f.gh.merged).toEqual([oid(2)]);
});

it('ends approved, merge blocked when required checks do not pass in time', async () => {
  const f = setup({ checks: () => [pending('build'), { context: 'deploy', appId: null, state: 'missing' }] });
  f.coordinator.start('review-token', randomUUID());
  const done = await settled(f.coordinator);
  expect(done.state).toBe('blocked');
  expect(done.reason).toMatch(/did not pass within .*build is pending, deploy is missing/);
  expect(f.gh.merged).toEqual([]);
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('stops at once when a required check fails, without waiting for the time limit', async () => {
  const f = setup({ checks: () => [{ context: 'build', appId: null, state: 'failure' }] });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked', reason: 'Required check failed: build.' });
  expect(f.gh.inspections()).toBe(1);
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('ends failed, without merging, when GitHub cannot be read while waiting for checks', async () => {
  const f = setup({ checks: () => [pending()], unreadable: n => n === 2 });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/HTTP 502/) });
  expect(f.gh.inspections()).toBe(2);
  expect(f.gh.merged).toEqual([]);
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('waits while GitHub is still computing mergeability', async () => {
  const f = setup({ change: n => (n <= 2 ? { mergeable: 'UNKNOWN' } : {}) });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'merged' });
});

it('ends for review or as failed when preparation does, and merges nothing', async () => {
  for (const [outcome, state] of [['review-required', 'review-required'], ['failed', 'failed']] as const) {
    const f = setup({ prepare: () => outcome });
    f.coordinator.start('review-token', randomUUID());
    expect(await settled(f.coordinator)).toMatchObject({ state, reason: `preparation ${outcome}` });
    expect(f.gh.merged).toEqual([]);
    expect(f.store.getTask(identity).status).toBe('in review');
  }
});

it('ends as failed, for a person, when another blocker appears while waiting', async () => {
  const f = setup({ change: () => ({ base: oid(30) }) });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/base branch moved/) });
  expect(f.gh.merged).toEqual([]);
});

it('ends approved, merge blocked when GitHub refuses the merge', async () => {
  const f = setup({ merge: async () => { throw new MergeSubmissionError('Required status check "ci" is expected.', 'refused'); } });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge: .*expected/) });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('ends submitted when GitHub\'s merge outcome is unknown; the attempt stays in flight', async () => {
  const f = setup({ merge: async () => { throw new MergeSubmissionError('connection reset', 'unknown'); } });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'submitted' });
  expect(f.store.getMergeAttempt(identity)?.state).toBe('submitting');
});

it('stops waiting at once when the task is cancelled', async () => {
  const f = setup({ checks: () => [pending()] });
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  // As the cancel route does: the task's cancel commits first, then the job is told.
  expect(f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID())).toBe('closed');
  f.coordinator.cancel();
  expect(await settled(f.coordinator)).toMatchObject({ state: 'cancelled' });
  expect(f.gh.merged).toEqual([]);
});

it('keeps the readiness preparation recorded valid while the job records its progress', async () => {
  let readyAt: number | null = null;
  const f = setup({ checks: n => { if (n === 1) readyAt = f.store.getTask(identity).stateVersion; return n <= 3 ? [pending()] : [passing()]; } });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'merged' });
  // The guarded merge admitted the readiness bound at preparation: the job's own writes never advanced the task.
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'merged' });
  expect(readyAt).not.toBeNull();
});

it('replays a resent click, refuses a second click while a job runs, and replays a refusal for a stale token', async () => {
  const f = setup({ checks: () => [pending()] });
  const id = randomUUID(), stale = randomUUID();
  expect(() => f.coordinator.start('stale-token', stale)).toThrow(/Stale review state/);
  expect(f.store.getMergeJob(identity, stale)).toMatchObject({ state: 'failed', refused: true });
  expect(() => f.coordinator.start('stale-token', stale)).toThrow(/Stale review state/);
  const first = f.coordinator.start('review-token', id);
  expect(f.coordinator.start('review-token', id)).toMatchObject({ id: first.id, state: 'running' });
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  const second = randomUUID();
  expect(() => f.coordinator.start('review-token', second)).toThrow(/already running/);
  expect(f.store.getMergeJob(identity, second)).toMatchObject({ refused: true });
  // The saved refusal is that click's alone: the running job stays the task's job, and Merge PR stays withheld.
  expect(f.coordinator.latest()).toMatchObject({ id: first.id, state: 'running', step: 'checks' });
  const resolvable = { ready: false, action: null, blockers: [{ code: 'check', message: 'pending' }], remote: { mergeable: 'MERGEABLE' }, queue: null } as Parameters<typeof withMergeJob>[0];
  expect(withMergeJob(resolvable, f.coordinator.latest(), 'in review')).toMatchObject({ ready: false, action: null });
  expect(() => f.coordinator.start('other-token', id)).toThrow(/already used/);
  expect(f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID())).toBe('closed');
  f.coordinator.cancel(); await settled(f.coordinator);
  expect(f.prep.calls).toHaveLength(1);
});

it('resolves close only once the job has settled, so shutdown can await its last write', async () => {
  const f = setup();
  // Preparation that finishes its own work after the shutdown abort (as a push or command check settling does).
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prepared = f.prep.fake.start.bind(f.prep.fake);
  (f.prep.fake as unknown as { start: typeof prepared }).start = async expected => { await held; return prepared(expected); };
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()).toMatchObject({ state: 'running', step: 'preparing' }));
  let closed = false;
  const closing = f.coordinator.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(closed).toBe(false);
  release(); await closing;
  expect(f.coordinator.active).toBe(false);
  expect(f.gh.merged).toEqual([]);
});

it('leaves a job running on shutdown, and startup ends it as failed', async () => {
  const f = setup({ checks: () => [pending()] });
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  await f.coordinator.close();
  expect(f.coordinator.latest()).toMatchObject({ state: 'running' });
  f.store.settleInterruptedMergeJobs(identity);
  expect(f.coordinator.latest()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/server restarted/) });
  expect(() => f.coordinator.start('review-token', randomUUID())).toThrow(/shutting down/);
});

it('ends queued when the merge queue accepted the head', async () => {
  const f = setup({ queue: true });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'queued' });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ kind: 'queue', state: 'queued' });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('leaves the task approved, merge blocked when a retried job is queued', async () => {
  const f = setup({ queue: true, checks: n => (n === 1 ? [{ context: 'build', appId: null, state: 'failure' }] : []) });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked' });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'queued' });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('refuses a click while the runner or publisher is busy, and replays that refusal once it is idle', () => {
  const f = setup(), id = randomUUID();
  expect(() => f.coordinator.start('review-token', id, () => 'The runner is busy.')).toThrow('The runner is busy.');
  // The response was lost; the same click is resent after the runner became idle: it replays, starting nothing.
  expect(() => f.coordinator.start('review-token', id)).toThrow('The runner is busy.');
  expect(() => f.coordinator.start('other-token', id)).toThrow(/already used/);
  expect(f.store.getMergeJob(identity, id)).toMatchObject({ state: 'failed', refused: true, reason: 'The runner is busy.' });
  expect(f.coordinator.latest()).toBeNull();
  expect(f.coordinator.active).toBe(false);
  expect(f.prep.calls).toEqual([]);
});

it('saves nothing for a click refused because the server is shutting down, so it may be sent again', () => {
  const f = setup(), id = randomUUID();
  f.coordinator.stop();
  expect(() => f.coordinator.start('review-token', id)).toThrow(/shutting down/);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
});

it('ends cancelled when the task was cancelled while the job waited, even if the job was not told', async () => {
  const f = setup({ checks: () => [pending()] });
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  expect(f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID())).toBe('closed');
  expect(await settled(f.coordinator)).toMatchObject({ state: 'cancelled' });
});

it('ends cancelled when the task is cancelled during the guarded merge\'s validation', async () => {
  let cancelAt = Number.POSITIVE_INFINITY, coordinatorRef: MergeJobCoordinator | null = null, storeRef: Store | null = null;
  const f = setup({ change: n => {
    if (n === cancelAt) { storeRef!.cancelTask(identity, storeRef!.getTask(identity).stateVersion, randomUUID()); coordinatorRef!.cancel(); }
    return {};
  } });
  coordinatorRef = f.coordinator; storeRef = f.store;
  // Inspection 1 is the wait; inspections 2+ are the guarded merge's validation passes.
  cancelAt = 2;
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'cancelled' });
  expect(f.gh.merged).toEqual([]);
});

it('stops a guarded merge in flight on shutdown, so shutdown does not wait for GitHub', async () => {
  const f = setup({ merge: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.gh.merged).toHaveLength(1));
  const closing = Date.now();
  await f.coordinator.close();
  expect(Date.now() - closing).toBeLessThan(2_000);
  // GitHub was already asked, so its outcome is unknown: the job ends submitted and the attempt stays in flight.
  expect(f.coordinator.latest()).toMatchObject({ state: 'submitted' });
  expect(f.store.getMergeAttempt(identity)?.state).toBe('submitting');
});

it('offers Merge PR while only blockers the job resolves remain, and a retry after a blocked job', () => {
  const remote = { mergeable: 'MERGEABLE' };
  const status = (codes: string[], extra: Partial<{ queue: { state: string } | null; remote: { mergeable: string } | null }> = {}) =>
    ({ ready: false, action: null, blockers: codes.map(code => ({ code, message: code })), remote, queue: null, ...extra }) as Parameters<typeof withMergeJob>[0];
  const running = { state: 'running' } as MergeJobView, blocked = { state: 'blocked' } as MergeJobView;
  expect(withMergeJob(status(['preparation', 'base', 'acceptance', 'check']), null, 'in review')).toMatchObject({ ready: true, action: 'merge', job: null });
  expect(withMergeJob(status(['mergeable'], { remote: { mergeable: 'UNKNOWN' } }), null, 'in review')).toMatchObject({ ready: true });
  expect(withMergeJob(status(['mergeable']), null, 'in review')).toMatchObject({ ready: false, action: null });
  for (const code of ['approval', 'scope', 'unplanned', 'head', 'already-fixed', 'rules', 'base-guard', 'task'])
    expect(withMergeJob(status(['preparation', code]), null, 'in review')).toMatchObject({ ready: false, action: null });
  expect(withMergeJob(status([]), running, 'in review')).toMatchObject({ ready: false, job: running });
  expect(withMergeJob(status([], { queue: { state: 'submitting' } }), null, 'in review')).toMatchObject({ ready: false });
  expect(withMergeJob(status([], { remote: null }), null, 'in review')).toMatchObject({ ready: false });
  expect(withMergeJob(status(['preparation']), blocked, 'approved but merge blocked')).toMatchObject({ ready: true, action: 'retry', job: blocked });
  // A conflict after the base moved is the job's rebase to resolve; a conflict on its own is a person's.
  expect(withMergeJob(status(['base', 'mergeable'], { remote: { mergeable: 'CONFLICTING' } }), null, 'in review')).toMatchObject({ ready: true });
  expect(withMergeJob(status(['mergeable'], { remote: { mergeable: 'CONFLICTING' } }), null, 'in review')).toMatchObject({ ready: false });
});

it('ends as failed, not blocked, when checks fail on a head that moved while waiting', async () => {
  const f = setup({ checks: () => [{ context: 'build', appId: null, state: 'failure' }], change: () => ({ head: oid(40) }) });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/head moved/) });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('asks GitHub to merge nothing once stopped, even if the checks pass meanwhile', async () => {
  let passing = false;
  const f = setup({ checks: () => [passing ? { context: 'ci', appId: null, state: 'success' } : pending()] });
  f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  f.coordinator.stop(); passing = true;
  await f.coordinator.current;
  expect(f.gh.merged).toEqual([]);
  expect(f.coordinator.latest()).toMatchObject({ state: 'running' });
});

it('ends blocked when GitHub refuses the merge while shutdown stops the job', async () => {
  let coordinatorRef: MergeJobCoordinator | null = null;
  const f = setup({ merge: async () => { coordinatorRef!.stop(); throw new MergeSubmissionError('Base branch was modified.', 'refused'); } });
  coordinatorRef = f.coordinator;
  f.coordinator.start('review-token', randomUUID());
  await f.coordinator.current;
  expect(f.coordinator.latest()).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge/) });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('settles a job a crash left in its merge step from its merge attempt at startup', async () => {
  for (const [settle, expected, status] of [
    [() => undefined, 'submitted', 'in review'],
    [(store: Store, id: string) => store.finishMergeAttempt(identity, id, { state: 'merged', url: 'https://github.com/owner/repo/pull/7' }), 'merged', 'merged'],
    [(store: Store, id: string) => store.queueMergeAttempt(identity, id, 'https://github.com/owner/repo/pull/7'), 'queued', 'in review'],
    [(store: Store, id: string) => store.finishMergeAttempt(identity, id, { state: 'failed', reason: 'Base branch was modified.' }), 'blocked', 'approved but merge blocked'],
  ] as const) {
    // GitHub never answers: the job is in its merge step when the process "crashes".
    const f = setup({ merge: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    f.coordinator.start('review-token', randomUUID());
    await vi.waitFor(() => expect(f.gh.merged).toHaveLength(1));
    const job = f.store.runningMergeJob(identity)!, attempt = f.store.getMergeAttempt(identity)!;
    expect(job).toMatchObject({ step: 'merging', mergeActionId: attempt.actionId });
    settle(f.store, attempt.id);
    f.store.settleInterruptedMergeJobs(identity);
    expect(f.store.getMergeJob(identity, job.id)).toMatchObject({ state: expected });
    expect(f.store.getTask(identity).status).toBe(status);
  }
});

it('blocks the job and the task in one write, leaving a task that moved meanwhile as it is', () => {
  const store = publishedTask(), first = randomUUID(), second = randomUUID();
  store.beginMergeJob(identity, { actionId: first, token: 'review-token' });
  const before = store.getTask(identity).stateVersion;
  expect(store.blockMergeJob(identity, first, 'Required check failed: ci.')).toBe(true);
  // The status change advances the task state version, so the next merge prepares again from the start.
  expect(store.getTask(identity).stateVersion).toBe(before + 1);
  expect(store.getMergeJob(identity, first)).toMatchObject({ state: 'blocked', reason: 'Required check failed: ci.' });
  expect(store.getTask(identity).status).toBe('approved but merge blocked');
  store.beginMergeJob(identity, { actionId: second, token: 'review-token' });
  expect(store.cancelTask(identity, store.getTask(identity).stateVersion, randomUUID())).toBe('closed');
  expect(store.blockMergeJob(identity, second, 'late')).toBe(true);
  expect(store.getTask(identity).status).toBe('cancelled');
});

it('rolls the task back when ending a blocked job fails, and leaves the task alone for a job that already ended', () => {
  const store = publishedTask(), id = randomUUID();
  store.beginMergeJob(identity, { actionId: id, token: 'review-token' });
  const finish = store.finishMergeJob.bind(store);
  store.finishMergeJob = () => { throw new Error('disk full'); };
  expect(() => store.blockMergeJob(identity, id, 'Required check failed: ci.')).toThrow('disk full');
  // One transaction: the task did not move without its job.
  expect(store.getTask(identity).status).toBe('in review');
  store.finishMergeJob = finish;
  expect(store.finishMergeJob(identity, id, { state: 'failed', reason: 'The pull request moved.' })).toBe(true);
  const before = store.getTask(identity).stateVersion;
  expect(store.blockMergeJob(identity, id, 'late')).toBe(false);
  expect(store.getTask(identity)).toMatchObject({ status: 'in review', stateVersion: before });
  expect(store.getMergeJob(identity, id)).toMatchObject({ state: 'failed' });
});

it('decides a retried job only from its own merge attempt, never from an earlier refused one', async () => {
  // The first job's merge is refused: its attempt stays on record as failed.
  let refuse = true, conflictFrom = Number.POSITIVE_INFINITY;
  const f = setup({ merge: async () => { if (refuse) throw new MergeSubmissionError('Base branch was modified.', 'refused'); return { url: 'u' }; },
    change: n => (n >= conflictFrom ? { mergeable: 'CONFLICTING' } : {}) });
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked' });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'failed' });
  // Retry: the guarded merge's second validation pass now sees a conflict, so it refuses before asking GitHub.
  refuse = false; conflictFrom = f.gh.inspections() + 3;
  f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/merge conflicts/) });
  // At startup too: a job that saved its merge action ID but never got an attempt fails, whatever older attempts say.
  const crashed = randomUUID();
  f.store.beginMergeJob(identity, { actionId: crashed, token: 'review-token' });
  f.store.updateMergeJob(identity, crashed, { step: 'merging', mergeActionId: randomUUID() });
  f.store.settleInterruptedMergeJobs(identity);
  expect(f.store.getMergeJob(identity, crashed)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/server restarted/) });
});

it('refuses a click while a preparation is already running, and replays that refusal', () => {
  const f = setup(), id = randomUUID();
  (f.prep.fake as unknown as { assertStartable: () => void }).assertStartable = () => { throw new GuardRefusal('Pre-merge preparation is already running.'); };
  expect(() => f.coordinator.start('review-token', id)).toThrow('Pre-merge preparation is already running.');
  expect(f.store.getMergeJob(identity, id)).toMatchObject({ refused: true });
  expect(f.prep.calls).toEqual([]);
});

it('starts no inspection after the wait limit and stops one that runs into it', async () => {
  let inspections = 0, hang = false;
  const f = setup({ checks: () => [pending()] });
  const inspect = f.gh.client.inspect;
  f.gh.client.inspect = (async (request: Parameters<typeof inspect>[0]) => {
    inspections++;
    // From the second inspection on, GitHub does not answer; only the wait's limit (or a cancel) ends the read.
    if (hang && request?.signal) await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
    return inspect(request);
  }) as typeof inspect;
  const coordinator = new MergeJobCoordinator(f.review, f.prep.fake, f.merges, undefined, { checkWaitMs: 400, firstDelayMs: 5, maxDelayMs: 5 }); jobs.push(coordinator);
  coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(coordinator.latest()?.step).toBe('checks'));
  hang = true;
  const started = Date.now();
  await coordinator.current;
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(coordinator.latest()).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/did not pass within/) });
  const after = inspections;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(inspections).toBe(after);
  expect(f.gh.merged).toEqual([]);
});

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
  merge?: (signal?: AbortSignal) => Promise<{ url: string }>; queue?: boolean } = {}) {
  let inspections = 0;
  const merged: string[] = [];
  const client: MergeGateway = {
    inspect: vi.fn(async request => {
      inspections++;
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

it('replays a resent click, refuses a second click while a job runs, and saves nothing for a stale token', async () => {
  const f = setup({ checks: () => [pending()] });
  const id = randomUUID();
  expect(() => f.coordinator.start('stale-token', randomUUID())).toThrow(/Stale review state/);
  expect(f.coordinator.latest()).toBeNull();
  const first = f.coordinator.start('review-token', id);
  expect(f.coordinator.start('review-token', id)).toMatchObject({ id: first.id, state: 'running' });
  expect(() => f.coordinator.start('review-token', randomUUID())).toThrow(GuardRefusal);
  expect(() => f.coordinator.start('other-token', id)).toThrow(/already used/);
  f.coordinator.cancel(); await settled(f.coordinator);
  expect(f.prep.calls).toHaveLength(1);
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

it('refuses a click while the runner or publisher is busy, saving nothing', () => {
  const f = setup();
  expect(() => f.coordinator.start('review-token', randomUUID(), () => 'The runner is busy.')).toThrow('The runner is busy.');
  expect(f.coordinator.latest()).toBeNull();
  expect(f.prep.calls).toEqual([]);
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

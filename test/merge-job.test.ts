import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { GuardRefusal, ShuttingDownError } from '../runner/lifecycle.ts';
import { MergeCoordinator, type PublishedTarget } from '../runner/merge.ts';
import { JOB_RESOLVES, MergeJobCoordinator, SETTLED_BEFORE_JOB_MERGE, withMergeJob, type MergeJobView } from '../runner/merge-job.ts';
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
  // Asynchronous, as since #170 (the review load awaits a history worker).
  return { store, config: { identity }, view, load: vi.fn(async () => view()), commandPolicyDigest: () => commandDigest([]) } as unknown as ReviewService & { view: () => unknown };
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
  merge?: (signal?: AbortSignal) => Promise<{ url: string }>; queue?: boolean; unreadable?: (n: number) => boolean;
  during?: (n: number) => void } = {}) {
  let inspections = 0;
  const merged: string[] = [];
  const client: MergeGateway = {
    inspect: vi.fn(async request => {
      inspections++;
      if (options.unreadable?.(inspections)) throw new Error('GitHub returned HTTP 502');
      // Something that happens locally while GitHub's answer is on its way.
      options.during?.(inspections);
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
function setup(options: Parameters<typeof github>[1] & { prepare?: Parameters<typeof preparation>[1]; timing?: typeof TIMING } = {}) {
  const store = publishedTask(), review = service(store), gh = github(store, options);
  const merges = new MergeCoordinator(review, gh.client, undefined, undefined, PUBLISHED);
  const prep = preparation(store, options.prepare);
  const coordinator = new MergeJobCoordinator(review, prep.fake, merges, undefined, options.timing ?? TIMING); jobs.push(coordinator);
  return { store, review, gh, merges, prep, coordinator };
}
const settled = async (coordinator: MergeJobCoordinator) => { await coordinator.current; return coordinator.latest()!; };
/** Holds the next review load until released or failed; a load whose signal aborts rejects with the abort's reason. */
function holdNextLoad(review: ReviewService & { view: () => unknown }) {
  let release!: () => void, fail!: (error: Error) => void, started!: (signal?: AbortSignal) => void;
  const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const loading = new Promise<AbortSignal | undefined>(resolve => { started = resolve; });
  (review.load as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (options?: { signal?: AbortSignal }) => {
    started(options?.signal);
    await new Promise<void>((resolve, reject) => {
      gate.then(resolve, reject);
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    });
    return review.view();
  });
  return { release, fail, loading };
}
const pending = (context = 'ci'): RequiredCheck => ({ context, appId: null, state: 'pending' });
const passing = (context = 'ci'): RequiredCheck => ({ context, appId: null, state: 'success' });

it('merges at once when the required set was read and is empty', async () => {
  const f = setup();
  const started = await f.coordinator.start('review-token', randomUUID());
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
  const job = await f.coordinator.start('review-token', randomUUID());
  const poll = setInterval(() => { const latest = f.coordinator.latest(); if (latest?.checks.length) seen.push(`${latest.step}:${latest.checks[0]!.state}`); }, 1);
  const done = await settled(f.coordinator); clearInterval(poll);
  expect(done).toMatchObject({ id: job.id, state: 'merged' });
  expect(seen).toContain('checks:pending');
  expect(f.gh.merged).toEqual([oid(2)]);
});

it('ends approved, merge blocked when required checks do not pass in time', async () => {
  const f = setup({ checks: () => [pending('build'), { context: 'deploy', appId: null, state: 'missing' }] });
  await f.coordinator.start('review-token', randomUUID());
  const done = await settled(f.coordinator);
  expect(done.state).toBe('blocked');
  expect(done.reason).toMatch(/did not pass within .*build is pending, deploy is missing/);
  // Nothing failed, so the next step is to wait, not to fix anything (merge-handoff.md, Outcomes).
  expect(done.reason).toMatch(/deploy is missing\. Wait for the checks to pass, then Retry merge\.$/);
  expect(f.gh.merged).toEqual([]);
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('stops at once when a required check fails, without waiting for the time limit', async () => {
  const f = setup({ checks: () => [{ context: 'build', appId: null, state: 'failure' }] });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked', reason: 'Required check failed: build. Fix it, then Retry merge.' });
  expect(f.gh.inspections()).toBe(1);
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('ends failed, without merging, when GitHub cannot be read while waiting for checks', async () => {
  const f = setup({ checks: () => [pending()], unreadable: n => n === 2 });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/HTTP 502/) });
  expect(f.gh.inspections()).toBe(2);
  expect(f.gh.merged).toEqual([]);
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('ends failed, leaving the task in review, when GitHub refuses because the head changed', async () => {
  const f = setup({ merge: async () => { throw new MergeSubmissionError('Head branch was modified. Review and try the merge again.', 'refused'); } });
  await f.coordinator.start('review-token', randomUUID());
  // The page adds "Merge again when ready." to a failed job's reason, so the reason never says it too.
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/^GitHub refused the merge: Head branch was modified.*Review the new head first\.$/) });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'failed', requiresFreshReview: true });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('ends failed, leaving the task in review, when the review changed while GitHub was asked to merge and refused', async () => {
  let storeRef: Store | null = null;
  const f = setup({ merge: async () => {
    // A person adds a change request while the merge command is on its way; then GitHub refuses.
    const store = storeRef!, snapshot = store.getSnapshot(identity);
    store.addReviewNote(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, 'P1', 'change', 'Changed during the merge.');
    throw new MergeSubmissionError('Required status check "ci" is expected.', 'refused');
  } });
  storeRef = f.store;
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/review changed while GitHub was asked to merge; review it first\.$/) });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'failed' });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('ends failed, leaving the task in review, when a failing check arrives after the review changed', async () => {
  let storeRef: Store | null = null;
  const f = setup({ checks: () => [{ context: 'build', appId: null, state: 'failure' }], during: () => {
    // A person adds a change request while the job's inspection is reading GitHub.
    const store = storeRef!, snapshot = store.getSnapshot(identity);
    store.addReviewNote(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, 'P1', 'change', 'Changed during the wait.');
  } });
  storeRef = f.store;
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed while waiting for required checks; the preparation no longer applies\.$/) });
  expect(f.store.getTask(identity).status).toBe('in review');
  expect(f.gh.merged).toEqual([]);
});

it('waits while GitHub is still computing mergeability', async () => {
  const f = setup({ change: n => (n <= 2 ? { mergeable: 'UNKNOWN' } : {}) });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'merged' });
});

it('ends for review or as failed when preparation does, and merges nothing', async () => {
  for (const [outcome, state] of [['review-required', 'review-required'], ['failed', 'failed']] as const) {
    const f = setup({ prepare: () => outcome });
    await f.coordinator.start('review-token', randomUUID());
    expect(await settled(f.coordinator)).toMatchObject({ state, reason: `preparation ${outcome}` });
    expect(f.gh.merged).toEqual([]);
    expect(f.store.getTask(identity).status).toBe('in review');
  }
});

it('ends as failed, for a person, when another blocker appears while waiting', async () => {
  const f = setup({ change: () => ({ base: oid(30) }) });
  await f.coordinator.start('review-token', randomUUID());
  // Merge PR rebases and prepares itself, and this screen offers no Rebase: the reason says what merging again does.
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed',
    reason: 'The base branch moved; merging rebases onto it and prepares again, so the result may need review.' });
  expect(f.gh.merged).toEqual([]);
});

it('ends approved, merge blocked when GitHub refuses the merge', async () => {
  const f = setup({ merge: async () => { throw new MergeSubmissionError('Required status check "ci" is expected.', 'refused'); } });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge: .*expected\. Fix it, then Retry merge\.$/) });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('ends submitted when GitHub\'s merge outcome is unknown; the attempt stays in flight', async () => {
  const f = setup({ merge: async () => { throw new MergeSubmissionError('connection reset', 'unknown'); } });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'submitted' });
  expect(f.store.getMergeAttempt(identity)?.state).toBe('submitting');
});

it('stops waiting at once when the task is cancelled', async () => {
  // The first wait between inspections is far longer than this test may wait: only the job being told can end it.
  const f = setup({ checks: () => [pending()], timing: { checkWaitMs: 600_000, firstDelayMs: 300_000, maxDelayMs: 300_000 } });
  await f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.checks).toEqual([{ context: 'ci', state: 'pending' }]));
  const inspected = f.gh.inspections();
  // As the cancel route does: the task's cancel commits first, then the job is told.
  expect(f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID())).toBe('closed');
  f.coordinator.cancel();
  const late = new Promise<'still waiting'>(resolve => setTimeout(() => resolve('still waiting'), 500).unref());
  expect(await Promise.race([settled(f.coordinator), late])).toMatchObject({ state: 'cancelled' });
  expect(f.gh.inspections()).toBe(inspected);
  expect(f.gh.merged).toEqual([]);
});

it('keeps the readiness preparation recorded valid while the job records its progress', async () => {
  const versions: number[] = [];
  const f = setup({ checks: n => { versions.push(f.store.getTask(identity).stateVersion); return n <= 3 ? [pending()] : [passing()]; } });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'merged' });
  // Every inspection, from the one after preparation through the guarded merge's own, read the same task version:
  // the job's three progress writes between them never advanced the task, so the guarded merge admitted that readiness.
  expect(versions.length).toBeGreaterThanOrEqual(4);
  expect(new Set(versions).size).toBe(1);
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'merged' });
});

it('replays a resent click, refuses a second click while a job runs, and replays a refusal for a stale token', async () => {
  const f = setup({ checks: () => [pending()] });
  const id = randomUUID(), stale = randomUUID();
  await expect(f.coordinator.start('stale-token', stale)).rejects.toThrow(/Stale review state/);
  expect(f.store.getMergeJob(identity, stale)).toMatchObject({ state: 'failed', refused: true });
  await expect(f.coordinator.start('stale-token', stale)).rejects.toThrow(/Stale review state/);
  const first = await f.coordinator.start('review-token', id);
  expect(await f.coordinator.start('review-token', id)).toMatchObject({ id: first.id, state: 'running' });
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  const second = randomUUID();
  await expect(f.coordinator.start('review-token', second)).rejects.toThrow(/already running/);
  expect(f.store.getMergeJob(identity, second)).toMatchObject({ refused: true });
  // The saved refusal is that click's alone: the running job stays the task's job, and Merge PR stays withheld.
  expect(f.coordinator.latest()).toMatchObject({ id: first.id, state: 'running', step: 'checks' });
  const resolvable = { ready: false, action: null, blockers: [{ code: 'check', message: 'pending' }], remote: { mergeable: 'MERGEABLE' }, queue: null } as Parameters<typeof withMergeJob>[0];
  expect(withMergeJob(resolvable, f.coordinator.latest(), 'in review')).toMatchObject({ ready: false, action: null });
  await expect(f.coordinator.start('other-token', id)).rejects.toThrow(/already used/);
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
  await f.coordinator.start('review-token', randomUUID());
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
  await f.coordinator.start('review-token', randomUUID());
  await vi.waitFor(() => expect(f.coordinator.latest()?.step).toBe('checks'));
  await f.coordinator.close();
  expect(f.coordinator.latest()).toMatchObject({ state: 'running' });
  f.store.settleInterruptedMergeJobs(identity);
  expect(f.coordinator.latest()).toMatchObject({ state: 'failed', reason: 'The server restarted before the merge finished.' });
  // Not a definite refusal: the route answers 503 and the browser keeps the click's key (nothing was saved).
  const id = randomUUID();
  await expect(f.coordinator.start('review-token', id)).rejects.toThrow(ShuttingDownError);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
});

it('ends queued when the merge queue accepted the head', async () => {
  const f = setup({ queue: true });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'queued' });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ kind: 'queue', state: 'queued' });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it.each([false, true])('ends submitted, not merged or queued, when GitHub accepted the merge but saving its outcome failed (queue: %s)', async queue => {
  const f = setup({ queue });
  // MergeCoordinator resolves after GitHub accepted the command even when saving the outcome fails (test/merge.test.ts).
  const fail = vi.fn(() => { throw new Error('local refresh failed'); });
  if (queue) f.store.queueMergeAttempt = fail; else f.store.finishMergeAttempt = fail;
  await f.coordinator.start('review-token', randomUUID());
  const job = await settled(f.coordinator);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(f.gh.merged).toEqual([oid(2)]);
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ actionId: job.mergeActionId, state: 'submitting' });
  expect(job).toMatchObject({ state: 'submitted', reason: expect.stringContaining('reconciles from GitHub') });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it.each(['finish', 'block'] as const)('reports a job it could not end (%s), which stays running and refuses a new click until startup settles it', async kind => {
  const f = setup(kind === 'block' ? { checks: () => [{ context: 'build', appId: null, state: 'failure' }] } : {});
  const fail = vi.fn(() => { throw new Error('disk full'); });
  const { blockMergeJob, finishMergeJob } = f.store;
  // The finish case ends `submitted` (its attempt's outcome was not saved either), so the task stays in review and a new
  // click reaches the running-job check.
  if (kind === 'block') f.store.blockMergeJob = fail;
  else { f.store.finishMergeJob = fail; f.store.finishMergeAttempt = () => { throw new Error('local refresh failed'); }; }
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const started = await f.coordinator.start('review-token', randomUUID());
    await f.coordinator.current;
    expect(fail).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(`Could not end merge job ${started.id}; it shows as running until the server restarts: "disk full"`);
    expect(f.store.getMergeJob(identity, started.id)).toMatchObject({ state: 'running' });
    await expect(f.coordinator.start('review-token', randomUUID())).rejects.toThrow(/already running/);
    // The next start settles it (runner/production.ts), once the store writes again.
    Object.assign(f.store, { blockMergeJob, finishMergeJob });
    f.store.settleInterruptedMergeJobs(identity);
    expect(f.store.getMergeJob(identity, started.id)).toMatchObject({ state: kind === 'block' ? 'failed' : 'submitted' });
  } finally { logged.mockRestore(); }
});

it('keeps a job running and reports it when even reading the task fails after the job failed', async () => {
  const f = setup();
  const admission = holdNextLoad(f.review), run = holdNextLoad(f.review);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const getTask = f.store.getTask.bind(f.store);
  try {
    const starting = f.coordinator.start('review-token', randomUUID());
    await admission.loading; admission.release();
    const started = await starting;
    await run.loading;
    f.store.getTask = () => { throw new Error('database is locked'); };
    run.fail(new Error('History worker crashed.'));
    // The job's promise settles without rejecting, so `close()` and the server's `.finally` (whose callback catches its own
    // errors) see no rejection.
    await expect(f.coordinator.current).resolves.toBeUndefined();
    f.store.getTask = getTask;
    expect(logged).toHaveBeenCalledWith(`Could not end merge job ${started.id}; it shows as running until the server restarts: "database is locked"`);
    expect(f.store.getMergeJob(identity, started.id)).toMatchObject({ state: 'running' });
  } finally { f.store.getTask = getTask; logged.mockRestore(); }
});

it('leaves the task approved, merge blocked when a retried job is queued', async () => {
  const f = setup({ queue: true, checks: n => (n === 1 ? [{ context: 'build', appId: null, state: 'failure' }] : []) });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked' });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'queued' });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('refuses a click while the runner or publisher is busy, and replays that refusal once it is idle', async () => {
  const f = setup(), id = randomUUID();
  await expect(f.coordinator.start('review-token', id, () => 'The runner is busy.')).rejects.toThrow('The runner is busy.');
  // The response was lost; the same click is resent after the runner became idle: it replays, starting nothing.
  await expect(f.coordinator.start('review-token', id)).rejects.toThrow('The runner is busy.');
  await expect(f.coordinator.start('other-token', id)).rejects.toThrow(/already used/);
  expect(f.store.getMergeJob(identity, id)).toMatchObject({ state: 'failed', refused: true, reason: 'The runner is busy.' });
  expect(f.coordinator.latest()).toBeNull();
  expect(f.coordinator.active).toBe(false);
  expect(f.prep.calls).toEqual([]);
});

it('saves nothing for a click refused because the server is shutting down, so it may be sent again', async () => {
  const f = setup(), id = randomUUID();
  f.coordinator.stop();
  await expect(f.coordinator.start('review-token', id)).rejects.toThrow(/shutting down/);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
});

it('ends cancelled when the task was cancelled while the job waited, even if the job was not told', async () => {
  const f = setup({ checks: () => [pending()] });
  await f.coordinator.start('review-token', randomUUID());
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
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'cancelled' });
  expect(f.gh.merged).toEqual([]);
});

it('stops a guarded merge in flight on shutdown, so shutdown does not wait for GitHub', async () => {
  const f = setup({ merge: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await f.coordinator.start('review-token', randomUUID());
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
  // The blockers the job resolves read as what merging does: no Rebase or Prepare control is on the screen.
  expect(withMergeJob(status(['base', 'preparation', 'head']), null, 'in review').blockers).toEqual([
    { code: 'base', message: 'The base branch moved; merging rebases onto it and prepares again, so the result may need review.' },
    { code: 'preparation', message: 'The merge has not been prepared for the current review; merging prepares it.' },
    { code: 'head', message: 'head' }]);
  for (const code of ['approval', 'scope', 'unplanned', 'head', 'already-fixed', 'rules', 'base-guard', 'task'])
    expect(withMergeJob(status(['preparation', code]), null, 'in review')).toMatchObject({ ready: false, action: null });
  expect(withMergeJob(status([]), running, 'in review')).toMatchObject({ ready: false, job: running });
  expect(withMergeJob(status([], { queue: { state: 'submitting' } }), null, 'in review')).toMatchObject({ ready: false });
  expect(withMergeJob(status([], { remote: null }), null, 'in review')).toMatchObject({ ready: false });
  expect(withMergeJob(status(['preparation']), blocked, 'approved but merge blocked')).toMatchObject({ ready: true, action: 'retry', job: blocked });
  // The task's status, read after the inspection, wins: a task cancelled or merged meanwhile is never offered Merge PR.
  for (const closed of ['cancelled', 'merged', 'running'])
    expect(withMergeJob(status([]), null, closed)).toMatchObject({ ready: false, action: null });
  // A conflict after the base moved is the job's rebase to resolve; a conflict on its own is a person's.
  expect(withMergeJob(status(['base', 'mergeable'], { remote: { mergeable: 'CONFLICTING' } }), null, 'in review')).toMatchObject({ ready: true });
  expect(withMergeJob(status(['mergeable'], { remote: { mergeable: 'CONFLICTING' } }), null, 'in review')).toMatchObject({ ready: false });
});

it('sends the blockers a job settles before it merges: the ones it resolves, plus mergeability', () => {
  const status = (codes: string[], mergeable = 'MERGEABLE') =>
    ({ ready: false, action: null, blockers: codes.map(code => ({ code, message: code })), remote: { mergeable }, queue: null }) as Parameters<typeof withMergeJob>[0];
  const field = withMergeJob(status([]), null, 'in review').settledBeforeJobMerge;
  // Pinned to the job's own set: a code added to or removed from JOB_RESOLVES, or from the field, fails here.
  expect(field).toEqual(['preparation', 'base', 'acceptance', 'check', 'mergeable']);
  expect(field).toEqual([...JOB_RESOLVES, 'mergeable']);
  expect(SETTLED_BEFORE_JOB_MERGE).toBe(field);
  // Every code but mergeability is one Merge PR is offered over, because the job resolves it.
  for (const code of field.filter(code => code !== 'mergeable'))
    expect(withMergeJob(status([code]), null, 'in review')).toMatchObject({ ready: true, settledBeforeJobMerge: field });
});

it('ends as failed, not blocked, when checks fail on a head that moved while waiting', async () => {
  const f = setup({ checks: () => [{ context: 'build', appId: null, state: 'failure' }], change: () => ({ head: oid(40) }) });
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/head moved/) });
  expect(f.store.getTask(identity).status).toBe('in review');
});

it('asks GitHub to merge nothing once stopped, even if the checks pass meanwhile', async () => {
  let passing = false;
  const f = setup({ checks: () => [passing ? { context: 'ci', appId: null, state: 'success' } : pending()] });
  await f.coordinator.start('review-token', randomUUID());
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
  await f.coordinator.start('review-token', randomUUID());
  await f.coordinator.current;
  expect(f.coordinator.latest()).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge/) });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it.each(['submitted', 'blocked'] as const)('reports a job it could not end during shutdown (%s), after GitHub was asked to merge', async kind => {
  // Shutdown's first step (stop) has run, but GitHub was already asked, so the job still ends through its ending write.
  let coordinatorRef: MergeJobCoordinator | null = null;
  const f = setup({ merge: kind === 'blocked'
    ? async () => { coordinatorRef!.stop(); throw new MergeSubmissionError('Base branch was modified.', 'refused'); }
    : signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  coordinatorRef = f.coordinator;
  const fail = vi.fn(() => { throw new Error('disk full'); });
  const { blockMergeJob, finishMergeJob } = f.store;
  if (kind === 'blocked') f.store.blockMergeJob = fail; else f.store.finishMergeJob = fail;
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const started = await f.coordinator.start('review-token', randomUUID());
    if (kind === 'submitted') { await vi.waitFor(() => expect(f.gh.merged).toHaveLength(1)); await f.coordinator.close(); }
    else await f.coordinator.current;
    expect(fail).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(`Could not end merge job ${started.id}; it shows as running until the server restarts: "disk full"`);
    expect(f.store.getMergeJob(identity, started.id)).toMatchObject({ state: 'running' });
  } finally { Object.assign(f.store, { blockMergeJob, finishMergeJob }); logged.mockRestore(); }
});

it('settles a job a crash left in its merge step from its merge attempt at startup', async () => {
  for (const [settle, expected, status] of [
    [() => undefined, 'submitted', 'in review'],
    [(store: Store, id: string) => store.finishMergeAttempt(identity, id, { state: 'merged', url: 'https://github.com/owner/repo/pull/7' }), 'merged', 'merged'],
    [(store: Store, id: string) => store.queueMergeAttempt(identity, id, 'https://github.com/owner/repo/pull/7'), 'queued', 'in review'],
    [(store: Store, id: string) => store.finishMergeAttempt(identity, id, { state: 'failed', reason: 'Head branch was modified.', requiresFreshReview: true }), 'failed', 'in review'],
    // GitHub refused while a person changed the review: the refusal says nothing about the changed review.
    [(store: Store, id: string) => {
      const snapshot = store.getSnapshot(identity);
      store.addReviewNote(identity, { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, 'P1', 'change', 'Changed during the merge.');
      store.finishMergeAttempt(identity, id, { state: 'failed', reason: 'Base branch was modified.' });
    }, 'failed', 'in review'],
    [(store: Store, id: string) => store.finishMergeAttempt(identity, id, { state: 'failed', reason: 'Base branch was modified.' }), 'blocked', 'approved but merge blocked'],
  ] as const) {
    // GitHub never answers: the job is in its merge step when the process "crashes".
    const f = setup({ merge: signal => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    await f.coordinator.start('review-token', randomUUID());
    await vi.waitFor(() => expect(f.gh.merged).toHaveLength(1));
    const job = f.store.runningMergeJob(identity)!, attempt = f.store.getMergeAttempt(identity)!;
    expect(job).toMatchObject({ step: 'merging', mergeActionId: attempt.actionId });
    settle(f.store, attempt.id);
    f.store.settleInterruptedMergeJobs(identity);
    expect(f.store.getMergeJob(identity, job.id)).toMatchObject({ state: expected });
    expect(f.store.getTask(identity).status).toBe(status);
    // A blocked job's reason ends with its next step; a failed one's never says "merge again": the page adds that once.
    const reason = f.store.getMergeJob(identity, job.id)!.reason ?? '';
    if (expected === 'blocked') expect(reason).toBe('GitHub refused the merge: Base branch was modified. Fix it, then Retry merge.');
    if (expected === 'failed') expect(reason).not.toMatch(/merge again/i);
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
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'blocked' });
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ state: 'failed' });
  // Retry: the guarded merge's second validation pass now sees a conflict, so it refuses before asking GitHub.
  refuse = false; conflictFrom = f.gh.inspections() + 3;
  await f.coordinator.start('review-token', randomUUID());
  expect(await settled(f.coordinator)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/merge conflicts/) });
  // At startup too: a job that saved its merge action ID but never got an attempt fails, whatever older attempts say.
  const crashed = randomUUID();
  f.store.beginMergeJob(identity, { actionId: crashed, token: 'review-token' });
  f.store.updateMergeJob(identity, crashed, { step: 'merging', mergeActionId: randomUUID() });
  f.store.settleInterruptedMergeJobs(identity);
  expect(f.store.getMergeJob(identity, crashed)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/server restarted/) });
});

it('refuses, saves and replays a click on a task that is not mergeable or is being cancelled', async () => {
  const f = setup(), queued = randomUUID();
  f.store.transitionTask(identity, f.store.getTask(identity).stateVersion, 'queued');
  await expect(f.coordinator.start('review-token', queued)).rejects.toThrow('The task is queued; merge it from review.');
  expect(f.store.getMergeJob(identity, queued)).toMatchObject({ refused: true });
  f.store.transitionTask(identity, f.store.getTask(identity).stateVersion, 'in review');
  // A resend replays the refusal, even though the task is in review again.
  await expect(f.coordinator.start('review-token', queued)).rejects.toThrow('The task is queued; merge it from review.');
  // A cancel that waits for a push of the rewritten head to settle keeps the task in review, cancel requested.
  const snapshot = f.store.getSnapshot(identity), reviewed = { revision: 1, snapshotId: snapshot.id, reviewVersion: f.store.reviewVersion(identity) };
  f.store.recordRebase(identity, reviewed, oid(10), oid(12), [{ oldSha: oid(2), newSha: oid(12) }]);
  const after = f.store.getSnapshot(identity);
  f.store.beginPrePush(identity, { revision: 1, snapshotId: after.id, reviewVersion: f.store.reviewVersion(identity) }, f.store.getTask(identity).stateVersion,
    { branch: BRANCH, from: oid(2), to: oid(12) });
  expect(f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID())).toBe('stopping');
  const cancelling = randomUUID();
  await expect(f.coordinator.start('review-token', cancelling)).rejects.toThrow('The task is being cancelled.');
  expect(f.store.getMergeJob(identity, cancelling)).toMatchObject({ refused: true });
  expect(f.prep.calls).toEqual([]);
});

it('answers a preparation stopping for shutdown as not applied, saving nothing', async () => {
  const f = setup(), id = randomUUID();
  (f.prep.fake as unknown as { assertStartable: () => void }).assertStartable = () => { throw new GuardRefusal('The server is shutting down.'); };
  await expect(f.coordinator.start('review-token', id)).rejects.toThrow(ShuttingDownError);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
  expect(f.prep.calls).toEqual([]);
});

it('refuses a click while a preparation is already running, and replays that refusal', async () => {
  const f = setup(), id = randomUUID();
  (f.prep.fake as unknown as { assertStartable: () => void }).assertStartable = () => { throw new GuardRefusal('Pre-merge preparation is already running.'); };
  await expect(f.coordinator.start('review-token', id)).rejects.toThrow('Pre-merge preparation is already running.');
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
  await coordinator.start('review-token', randomUUID());
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

it('keeps a GitHub failure that came before the wait limit, even when the inspection settles after it', async () => {
  let inspections = 0, abortedFirst: unknown = null;
  const f = setup({ checks: () => [pending()] });
  const inspect = f.gh.client.inspect;
  f.gh.client.inspect = (async (request: Parameters<typeof inspect>[0]) => {
    if (++inspections < 2) return inspect(request);
    // A stage fails at once; its stopped peers settle only after the wait's limit, and the gateway then reports the
    // stage's own error (github/merge.ts inspect), not the abort.
    const failure = new Error('gh: HTTP 502 from the rules read');
    await new Promise(resolve => request!.signal!.addEventListener('abort', resolve, { once: true }));
    abortedFirst = request!.signal!.reason;
    throw failure;
  }) as typeof inspect;
  const coordinator = new MergeJobCoordinator(f.review, f.prep.fake, f.merges, undefined, { checkWaitMs: 300, firstDelayMs: 5, maxDelayMs: 5 }); jobs.push(coordinator);
  await coordinator.start('review-token', randomUUID());
  const done = await settled(coordinator);
  // The interleaving happened: the wait's limit (a timeout, not a cancel) fired before the failed inspection settled.
  expect((abortedFirst as Error | null)?.name).toBe('TimeoutError');
  expect(done).toMatchObject({ state: 'failed', reason: 'gh: HTTP 502 from the rules read' });
  expect(f.store.getTask(identity).status).toBe('in review');
  expect(f.gh.merged).toEqual([]);
});

it('numbers each job and refused click after the task\'s earlier ones, so the browser can order jobs without clocks', async () => {
  const f = setup({ prepare: () => 'failed' });
  const first = await f.coordinator.start('review-token', randomUUID());
  await settled(f.coordinator);
  const refusal = f.store.recordMergeJobRefusal(identity, { actionId: randomUUID(), token: 'review-token', reason: 'Refused.' });
  // A later click keeps a higher number even when the clock stepped back.
  const second = f.store.beginMergeJob(identity, { actionId: randomUUID(), token: 'review-token', now: '2000-01-01T00:00:00.000Z' }).job;
  expect([first.sequence, refusal.sequence, second.sequence]).toEqual([1, 2, 3]);
  expect(f.coordinator.latest()).toMatchObject({ id: second.id, sequence: 3 });
  f.store.finishMergeJob(identity, second.id, { state: 'failed' });
});

it('makes every saved change to a job a later revision, even when the clock ties or steps back', () => {
  const store = publishedTask();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const at = (time: string) => vi.setSystemTime(new Date(time));
    at('2026-10-11T00:00:00.000Z');
    const refusal = store.recordMergeJobRefusal(identity, { actionId: randomUUID(), token: 'review-token', reason: 'Refused.' });
    expect(refusal.revision).toBe(1);
    const id = randomUUID(), records = [store.beginMergeJob(identity, { actionId: id, token: 'review-token' }).job];
    // Same clock tick as admission, then the same tick again, then a clock step back, then the block that ends it.
    records.push(store.updateMergeJob(identity, id, { step: 'checks' })!);
    records.push(store.updateMergeJob(identity, id, { checks: [{ context: 'ci', state: 'pending' }] })!);
    at('2026-10-10T23:00:00.000Z');
    records.push(store.updateMergeJob(identity, id, { mergeActionId: randomUUID() })!);
    at('2026-10-10T22:00:00.000Z');
    expect(store.blockMergeJob(identity, id, 'Required check failed: ci.')).toBe(true);
    records.push(store.getMergeJob(identity, id)!);
    // The interleaving happened: update times tied and then stepped back.
    expect(records.map(job => job.updatedAt)).toEqual(['2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z',
      '2026-10-10T23:00:00.000Z', '2026-10-10T22:00:00.000Z']);
    expect(records.map(job => job.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(records.at(-1)!.state).toBe('blocked');
    // Startup settlement and finishing are saved changes too.
    const next = randomUUID();
    const begun = store.beginMergeJob(identity, { actionId: next, token: 'review-token' }).job;
    store.settleInterruptedMergeJobs(identity);
    const settledJob = store.getMergeJob(identity, next)!;
    expect(settledJob.updatedAt).toBe(begun.updatedAt);
    expect([begun.revision, settledJob.revision]).toEqual([1, 2]);
    // An ended job is left unchanged: no save, no new revision.
    expect(store.finishMergeJob(identity, next, { state: 'failed' })).toBe(false);
    expect(store.getMergeJob(identity, next)!.revision).toBe(2);
  } finally { vi.useRealTimers(); }
});

// Since #170 a click's admission awaits the review load; these pin what may happen while it does.
it('gives a resend of the same click, during the first send\'s review load, the same job', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never);
  const first = f.coordinator.start('review-token', id);
  await held.loading;
  const second = await f.coordinator.start('review-token', id); // Its own load is not held: it admits the job.
  held.release();
  const firstAnswer = await first;
  expect(firstAnswer.id).toBe(second.id);
  expect(f.store.getMergeJob(identity, id)?.refused).toBeFalsy(); // Not saved as an "already running" refusal.
  await settled(f.coordinator);
});

it('answers the resent click\'s job when the first send\'s admission load fails after the resend was admitted', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never);
  const first = f.coordinator.start('review-token', id);
  await held.loading;
  const second = await f.coordinator.start('review-token', id); // Its own load is not held: it admits the job.
  expect(f.store.getMergeJob(identity, id)).not.toBeNull();
  held.fail(new Error('History worker timed out.'));
  expect((await first).id).toBe(second.id);
  await settled(f.coordinator);
});

it('answers the resent click\'s job when shutdown stops the first send\'s admission load after the resend was admitted', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never), request = new AbortController();
  const first = f.coordinator.start('review-token', id, () => null, request.signal);
  await held.loading;
  const second = await f.coordinator.start('review-token', id);
  f.coordinator.stop();
  request.abort(new Error('Request cancelled during shutdown.'));
  expect((await first).id).toBe(second.id);
});

it('admits nothing and saves nothing when shutdown starts during the admission load', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never);
  const starting = f.coordinator.start('review-token', id);
  await held.loading;
  f.coordinator.stop();
  held.release();
  await expect(starting).rejects.toBeInstanceOf(ShuttingDownError);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
  expect(f.coordinator.current).toBeNull();
});

it('answers an admission load stopped by shutdown as not applied, saving nothing', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never), request = new AbortController();
  const starting = f.coordinator.start('review-token', id, () => null, request.signal);
  await held.loading;
  request.abort(new Error('Request cancelled during shutdown.'));
  await expect(starting).rejects.toBeInstanceOf(ShuttingDownError);
  expect(f.store.getMergeJob(identity, id)).toBeNull();
});

it('saves nothing when the admission load fails for another reason, so the click may be sent again', async () => {
  const f = setup(), id = randomUUID(), held = holdNextLoad(f.review as never);
  const starting = f.coordinator.start('review-token', id);
  await held.loading;
  held.fail(new Error('History worker timed out.'));
  await expect(starting).rejects.toThrow('History worker timed out.');
  expect(f.store.getMergeJob(identity, id)).toBeNull();
  // The same click, sent again, starts the job.
  expect(await f.coordinator.start('review-token', id)).toMatchObject({ state: 'running' });
  await settled(f.coordinator);
});

it('ends the job cancelled when the task is cancelled during the job\'s own review load', async () => {
  const f = setup(), id = randomUUID();
  // The admission's load passes; the job's own first load (its first step) is held.
  (f.review.load as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => (f.review as never as { view: () => unknown }).view());
  const held = holdNextLoad(f.review as never);
  await f.coordinator.start('review-token', id);
  await held.loading;
  // As the cancel route does: the task's cancel commits, then the job is told.
  f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID());
  f.coordinator.cancel();
  expect(await settled(f.coordinator)).toMatchObject({ state: 'cancelled', reason: 'Task cancelled.' });
  expect(f.gh.merged).toEqual([]);
});
it('doubles the wait between required-check inspections from the first delay up to the maximum', async () => {
  // Required checks stay pending long enough for the wait to reach its maximum; only the sleeps between inspections count.
  const f = setup({ checks: n => (n <= 6 ? [pending()] : [passing()]) });
  const coordinator = new MergeJobCoordinator(f.review, f.prep.fake, f.merges, undefined, { checkWaitMs: 60_000, firstDelayMs: 3, maxDelayMs: 20 }); jobs.push(coordinator);
  const waits: number[] = [];
  const timer = setTimeout, spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
    // Record the wait only while the job is between inspections of its required checks.
    if (coordinator.latest()?.step === 'checks') waits.push(ms ?? 0);
    return timer(handler, ms, ...args);
  }) as typeof setTimeout);
  try {
    await coordinator.start('review-token', randomUUID());
    expect(await settled(coordinator)).toMatchObject({ state: 'merged' });
  } finally { spy.mockRestore(); }
  expect(waits).toEqual([3, 6, 12, 20, 20, 20]);
});

it('words the guarded merge\'s refusal as what merging does when the base moves after the job\'s last ready inspection', async () => {
  // Inspection 1 is the job's wait (ready); a push to the base lands before inspection 2, the guarded merge's first.
  const f = setup({ change: n => (n >= 2 ? { base: oid(5) } : {}) });
  await f.coordinator.start('review-token', randomUUID());
  const done = await settled(f.coordinator);
  // The interleaving happened: the wait's one inspection was ready, and the guarded merge's first (the moved base) refused.
  expect(f.gh.inspections()).toBe(2);
  expect(f.store.getMergeAttempt(identity)).toBeNull();
  expect(done).toMatchObject({ state: 'failed',
    reason: 'The base branch moved; merging rebases onto it and prepares again, so the result may need review.' });
  expect(f.gh.merged).toEqual([]);
  expect(f.store.getTask(identity).status).toBe('in review');
  // The direct path keeps the guarded merge's own wording.
  await expect(f.merges.merge('review-token', randomUUID())).rejects.toThrow('The base branch moved. Rebase and review the resulting snapshot.');
});

it('keeps the unsettled push in the job\'s wording of the preparation blocker', async () => {
  const store = publishedTask(), gh = github(store);
  const reviewed = () => ({ revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) });
  // A preparation rebased and began pushing; the push's outcome is not known yet (as test/merge-task-pr.test.ts sets up).
  store.recordRebase(identity, reviewed(), oid(10), oid(12), [{ oldSha: oid(2), newSha: oid(12) }]);
  store.beginPrePush(identity, reviewed(), store.getTask(identity).stateVersion, { branch: BRANCH, from: oid(2), to: oid(12) });
  const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
  const status = await merges.status();
  expect(status.blockers.filter(blocker => blocker.code === 'preparation')).toEqual([{ code: 'preparation',
    message: 'A push of the rewritten head has not settled. Prepare the merge again to read its outcome.' }]);
  expect(withMergeJob(status as Parameters<typeof withMergeJob>[0], null, 'in review').blockers.filter(blocker => blocker.code === 'preparation')).toEqual([{ code: 'preparation',
    message: 'A push of the rewritten head has not settled; merging reads its outcome and prepares again.' }]);
});

it('ends the job cancelled when its own review load rejects only after the task was cancelled and shutdown began', async () => {
  const f = setup(), id = randomUUID();
  // The admission's load passes; the job's own first load is held, and rejects only when the test says so (not on abort).
  (f.review.load as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => (f.review as never as { view: () => unknown }).view());
  let reject!: (error: unknown) => void, started!: (signal?: AbortSignal) => void;
  const loading = new Promise<AbortSignal | undefined>(resolve => { started = resolve; });
  (f.review.load as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((options?: { signal?: AbortSignal }) => {
    started(options?.signal);
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  await f.coordinator.start('review-token', id);
  const signal = (await loading)!;
  // As the cancel route does: the task's cancel commits, then the job is told. Then shutdown begins.
  f.store.cancelTask(identity, f.store.getTask(identity).stateVersion, randomUUID());
  f.coordinator.cancel();
  f.coordinator.stop();
  // The interleaving happened: the cancel aborted the job first (shutdown's abort came second and changed nothing),
  // and the load is still pending when shutdown has begun.
  expect((signal.reason as { code?: string }).code).toBe('CANCELLED');
  expect(f.coordinator.latest()).toMatchObject({ state: 'running' });
  reject(signal.reason);
  await f.coordinator.close();
  expect(f.coordinator.latest()).toMatchObject({ state: 'cancelled', reason: 'Task cancelled.' });
  expect(f.gh.merged).toEqual([]);
});

it.each(['removed', 'failed'] as const)('ends the job from its attempt when a queue poll records %s after the merge queued and before the job resumed', async state => {
  const f = setup({ queue: true });
  const inspectQueue = f.gh.client as unknown as { inspectQueue: ReturnType<typeof vi.fn> };
  inspectQueue.inspectQueue.mockImplementationOnce(async (head: string) => state === 'removed'
    ? { state: 'removed', reviewedHead: head, removedAt: '2026-10-11T00:01:00Z', reason: 'The merge queue removed it: checks failed.' }
    : { state: 'failed', reviewedHead: head, entryId: 'E', reason: 'The merge queue failed it: checks failed.' });
  // The guarded merge settles (attempt saved queued); a queue poll then ends the attempt before the job resumes.
  const merge = f.merges.merge.bind(f.merges);
  let queuedBeforePoll: string | undefined;
  f.merges.merge = (async (...args: Parameters<typeof merge>) => {
    const result = await merge(...args);
    queuedBeforePoll = f.store.getMergeAttempt(identity)?.state;
    await f.merges.pollQueue();
    return result;
  }) as typeof merge;
  await f.coordinator.start('review-token', randomUUID());
  const done = await settled(f.coordinator);
  // The interleaving happened: the merge saved queued, and the poll ended this job's attempt before the job read it.
  expect(queuedBeforePoll).toBe('queued');
  expect(f.store.getMergeAttempt(identity)).toMatchObject({ actionId: done.mergeActionId, state, requiresFreshReview: false });
  expect(done).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/^GitHub refused the merge: The merge queue .* it: checks failed\. Fix it, then Retry merge\.$/) });
  expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
});

it('times out, without merging, when a ready inspection finishes after the wait limit before its timer runs', async () => {
  const f = setup({ checks: n => (n === 1 ? [pending()] : [passing()]) });
  let offset = 0, limitAbortedAtReady: boolean | null = null;
  const now = performance.now.bind(performance);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
  const inspect = f.gh.client.inspect;
  f.gh.client.inspect = (async (request: Parameters<typeof inspect>[0]) => {
    const status = await inspect(request);
    // The second inspection (all checks passing) ends after the limit: the clock crosses it, but the limit's timer has
    // not run (it counts real time, far from the limit).
    if ((inspect as ReturnType<typeof vi.fn>).mock.calls.length === 2) { offset += 120_000; limitAbortedAtReady = request?.signal?.aborted ?? null; }
    return status;
  }) as typeof inspect;
  const coordinator = new MergeJobCoordinator(f.review, f.prep.fake, f.merges, undefined, { checkWaitMs: 60_000, firstDelayMs: 5, maxDelayMs: 5 }); jobs.push(coordinator);
  try {
    await coordinator.start('review-token', randomUUID());
    const done = await settled(coordinator);
    // The interleaving happened: the ready inspection's signal had not been stopped by the limit when it answered.
    expect(limitAbortedAtReady).toBe(false);
    // GitHub reported the checks passing, so neither the reason nor the record names the earlier pending check.
    expect(done).toMatchObject({ state: 'blocked', reason: 'Required checks passed only after the 1-minute limit. Retry merge.', checks: [] });
    expect(f.gh.merged).toEqual([]);
    expect(f.store.getTask(identity).status).toBe('approved but merge blocked');
  } finally { clock.mockRestore(); }
});

it('keeps a failing check found by an inspection that finishes after the wait limit', async () => {
  const f = setup({ checks: n => (n === 1 ? [pending()] : [{ context: 'build', appId: null, state: 'failure' }]) });
  let offset = 0;
  const now = performance.now.bind(performance);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
  const inspect = f.gh.client.inspect;
  f.gh.client.inspect = (async (request: Parameters<typeof inspect>[0]) => {
    const status = await inspect(request);
    if ((inspect as ReturnType<typeof vi.fn>).mock.calls.length === 2) offset += 120_000;
    return status;
  }) as typeof inspect;
  const coordinator = new MergeJobCoordinator(f.review, f.prep.fake, f.merges, undefined, { checkWaitMs: 60_000, firstDelayMs: 5, maxDelayMs: 5 }); jobs.push(coordinator);
  try {
    await coordinator.start('review-token', randomUUID());
    expect(await settled(coordinator)).toMatchObject({ state: 'blocked', reason: 'Required check failed: build. Fix it, then Retry merge.' });
  } finally { clock.mockRestore(); }
});

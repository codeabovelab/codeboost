import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { MergeCoordinator, type PublishedTarget } from '../runner/merge.ts';
import type { ReviewService } from '../runner/review.ts';
import { GhMergeGateway, type MergeGateway, type MergeQueueGateway, type MergeTarget, type RemoteMergeState } from '../github/merge.ts';
import { openingMarker } from '../github/pull-requests.ts';
import type { AlreadyFixedGateway, AlreadyFixedInput } from '../github/already-fixed.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';

// #121: with a runner block, the merge gate targets the task's published PR, not github.pullRequest.
const oid = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 'repo', taskId: 'Task_42', planId: 'plan' };
const plan: Plan = { schema_version: 1, issue: 12, revision: 1, summary: 'Stop the crash', questions: [], items: [
  { id: 'P1', title: 'Guard input', intent: 'Reject empty input', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'Check it' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
const context: PlanContext = { identity, issue: 12, baseEntries: [{ path: 'a.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const BRANCH = 'codeboost/issue-12-task-42-0123456789abcdef';
const PUBLISHED: PublishedTarget = { repository: 'owner/repo', baseBranch: 'main' };
const PREPARED_PUBLISHED: PublishedTarget = { ...PUBLISHED, requiresPreparation: true };
const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;

const stores: Store[] = [], roots: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A running task with head `oid(2)` over `oid(1)`, its last attempt settled. */
function runningTask(): Store {
  const store = new Store(':memory:'); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, oid(1), oid(2), [{ sha: oid(2), owner: 'P1', origin: 'owned', sourceSha: null }]);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
  store.markRunning(identity, attempt.id);
  store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
  return store;
}
const clear = (store: Store) => store.recordAlreadyFixed(identity, store.getTask(identity).stateVersion, { snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
const begin = (store: Store, base = 'main') => store.beginPullRequest(identity, { checkId: clear(store).id, repository: 'owner/repo', base, headBranch: BRANCH, headSha: oid(2), draft: false });
const opened = (store: Store, openingId: string, number: number, mayReview = true) =>
  store.recordPullRequestOpened(identity, openingId, { number, url: url(number), headSha: oid(2), draft: false }, mayReview);
const toReview = (store: Store) => store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review');

/** The runner published PR 7 for the task, which is now in review. */
function published() {
  const store = runningTask();
  const opening = begin(store);
  expect(opened(store, opening.openingId, 7)).toBe('in review');
  return { store, opening };
}
function prepare(store: Store) {
  const actionId = randomUUID(), request = { expectedStateVersion: store.getTask(identity).stateVersion,
    expectedReviewVersion: store.reviewVersion(identity) };
  store.userAction(identity, { actionId, kind: 'prepare-merge', request }, () => ({ outcome: 'preparing' }));
  const snapshot = store.getSnapshot(identity);
  const readiness = { stateVersion: store.getTask(identity).stateVersion, reviewVersion: store.reviewVersion(identity),
    snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head };
  store.settlePreMergeAction(identity, actionId,
    { state: 'ready', base: snapshot.base, head: snapshot.head, checked: [], reason: null }, readiness);
  return readiness;
}
/**
 * PR 7 is opened and running; a later opening was abandoned, so a test can adopt it as PR 8 (newer than 7) at any point.
 * The task is then in review.
 */
function withLaterOpening() {
  const store = runningTask();
  const first = begin(store); opened(store, first.openingId, 7, false);
  const later = begin(store); store.abandonPullRequestOpening(identity, later.openingId);
  toReview(store);
  const adopt = () => store.adoptOpening(identity, later.openingId, { number: 8, url: url(8), draft: false }, { stateVersion: store.getTask(identity).stateVersion, reviewVersion: store.reviewVersion(identity) });
  return { store, first, later, adopt };
}

function service(store: Store) {
  const snapshot = store.getSnapshot(identity);
  const view = {
    items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
    plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: snapshot.id, base: oid(1), head: oid(2) }, token: 'review-token',
    expected: { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) },
  };
  return { store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService;
}

/**
 * GitHub as the published PR's record says it is: open, ready, from the task branch into main, with its marker, the only
 * open PR from the branch. `change` overrides what GitHub shows for a PR number.
 */
function github(store: Store, change: (number: number) => Partial<RemoteMergeState> = () => ({})) {
  const targets: Array<MergeTarget | undefined> = [], merged: Array<number | undefined> = [], queued: Array<number | undefined> = [];
  const client: MergeGateway & MergeQueueGateway & { before?: () => void } = {
    inspect: vi.fn(async options => {
      client.before?.();
      targets.push(options?.target);
      const number = options?.target?.pullRequest ?? 99;
      const record = store.taskPullRequests(identity).find(pr => pr.number === number);
      return { base: oid(1), head: oid(2), pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [],
        alreadyFixed: 'clear', pullRequest: number, draft: false,
        ...(options?.target?.headBranch ? { published: { headBranch: options.target.headBranch, baseBranch: 'main', crossRepository: false,
          marker: record ? openingMarker(record.openingId) : '', branchOpen: [{ number, base: 'main' }] } } : {}),
        ...change(number) } as RemoteMergeState;
    }),
    merge: vi.fn(async (_head, options) => { merged.push(options?.pullRequest); return { url: url(options?.pullRequest ?? 99) }; }),
    queueWatermark: vi.fn(async () => 'CURSOR'),
    inspectQueue: vi.fn(async (head, options) => { queued.push(options?.pullRequest); return { state: 'queued' as const, reviewedHead: head, entryId: 'E', phase: 'QUEUED' as const, position: 0, enqueuedAt: '2026-10-03T00:00:00Z', queueHead: head }; }),
  };
  return { client, targets, merged, queued };
}

describe('the merge gate with a runner block (#121)', () => {
  it('requires durable current preparation through the irreversible admission transaction', async () => {
    const { store } = published(), gh = github(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    expect((await merges.status()).blockers).toContainEqual({ code: 'preparation',
      message: 'Pre-merge preparation has not completed for the current review. Prepare the merge again.' });
    prepare(store);
    expect((await merges.status()).ready).toBe(true);

    let reads = 0;
    gh.client.before = () => {
      if (++reads !== 2) return;
      const task = store.getTask(identity);
      store.userAction(identity, { actionId: randomUUID(), kind: 'prepare-merge',
        request: { expectedStateVersion: task.stateVersion, expectedReviewVersion: store.reviewVersion(identity) } },
      () => ({ outcome: 'preparing' }));
    };
    await expect(merges.merge('review-token')).rejects.toThrow(/pre-merge preparation has not completed/i);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('reauthorizes issue trust immediately before irreversible admission', async () => {
    const { store } = published(), gh = github(store);
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    const calls: string[] = [];
    merges.setAuthorization(async () => {
      calls.push('capture');
      return { refresh: async () => { calls.push('revalidate'); throw new GuardRefusal('Issue trust was revoked.'); },
        validate: () => { calls.push('local'); } };
    });
    await expect(merges.merge('review-token')).rejects.toThrow('Issue trust was revoked.');
    expect(calls).toEqual(['capture', 'revalidate']);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('revalidates the pull request after the final authorization refresh', async () => {
    const { store } = published();
    let remoteBase = oid(1);
    const gh = github(store, () => ({ base: remoteBase }));
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    merges.setAuthorization(async () => ({ refresh: async () => { remoteBase = oid(3); }, validate: () => undefined }));
    await expect(merges.merge('review-token')).rejects.toThrow(/pull request changed during merge validation/i);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('revalidates authorization after the final pull request refresh', async () => {
    const { store } = published(), gh = github(store);
    let reads = 0, revoked = false;
    gh.client.before = () => { if (++reads === 3) revoked = true; };
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    merges.setAuthorization(async () => ({ refresh: async () => undefined, validate: () => {
      if (revoked) throw new GuardRefusal('Issue trust was revoked during the final pull request refresh.');
    } }));
    await expect(merges.merge('review-token')).rejects.toThrow(/trust was revoked during the final pull request refresh/i);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('captures the queue event boundary after the final authorization and pull request reads', async () => {
    const { store } = published(), gh = github(store, () => ({ mergeQueue: true }));
    let authorized = false;
    gh.client.queueWatermark = vi.fn(async () => authorized ? 'CURSOR_after_authorization' : 'CURSOR_before_authorization');
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    merges.setAuthorization(async () => ({ refresh: async () => { authorized = true; }, validate: () => undefined }));

    await merges.merge('review-token');

    expect(store.getMergeAttempt(identity)).toMatchObject({ queueWatermark: 'CURSOR_after_authorization' });
  });

  it('revalidates local authorization after the final queue event boundary', async () => {
    const { store } = published(), gh = github(store, () => ({ mergeQueue: true }));
    let authorized = false, revoked = false;
    gh.client.queueWatermark = vi.fn(async () => {
      if (authorized) revoked = true;
      return 'CURSOR';
    });
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    merges.setAuthorization(async () => ({ refresh: async () => { authorized = true; }, validate: () => {
      if (revoked) throw new GuardRefusal('Issue trust was revoked during the final queue read.');
    } }));

    await expect(merges.merge('review-token')).rejects.toThrow(/trust was revoked during the final queue read/i);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('completes the final external authorization read before validating merge-queue mode', async () => {
    const { store } = published();
    let mergeQueue = false, authorizationReads = 0;
    const gh = github(store, () => ({ mergeQueue }));
    prepare(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PREPARED_PUBLISHED);
    merges.setAuthorization(async () => ({ refresh: async () => { if (++authorizationReads === 1) mergeQueue = true; },
      validate: () => undefined }));
    await expect(merges.merge('review-token')).rejects.toThrow(/merge-queue|pull request changed/i);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('inspects and merges the task\'s published PR and pins it on the attempt', async () => {
    const { store } = published();
    const gh = github(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    const status = await merges.status();
    expect(status.blockers).toEqual([]);
    expect(gh.targets[0]).toEqual({ pullRequest: 7, ownPullRequests: [7], headBranch: BRANCH });
    await merges.merge('review-token');
    expect(gh.merged).toEqual([7]);
    expect(store.getMergeAttempt(identity)).toMatchObject({ pullRequest: 7, state: 'merged' });
  });

  it('refuses when github.pullRequest names another PR, and accepts it when it names the task\'s PR', async () => {
    const { store } = published();
    const gh = github(store);
    const wrong = new MergeCoordinator(service(store), gh.client, undefined, undefined, { ...PUBLISHED, configured: 5 });
    const shown = await wrong.displayStatus();
    expect(shown.ready).toBe(false);
    expect(shown.blockers).toEqual([{ code: 'pull-request', message: 'github.pullRequest is #5, but the task\'s pull request is #7. Remove github.pullRequest from the review configuration.' }]);
    const actionId = randomUUID();
    await expect(wrong.merge('review-token', actionId)).rejects.toThrow(/github.pullRequest is #5/);
    expect(gh.client.inspect).not.toHaveBeenCalled();
    const right = new MergeCoordinator(service(store), gh.client, undefined, undefined, { ...PUBLISHED, configured: 7 });
    expect((await right.status()).ready).toBe(true);
    // A definite refusal is saved: a resend replays it, even to a coordinator that would now merge.
    await expect(right.merge('review-token', actionId)).rejects.toThrow(/github.pullRequest is #5/);
    expect(gh.merged).toEqual([]);
  });

  it('blocks while the task has no PR into the configured base, or while one is being opened', async () => {
    const store = runningTask();
    const gh = github(store);
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    const opening = begin(store); toReview(store);
    expect((await merges.displayStatus()).blockers).toEqual([{ code: 'pull-request', message: 'The task\'s pull request is being opened or updated. Wait for publishing to finish, then refresh.' }]);
    store.abandonPullRequestOpening(identity, opening.openingId);
    expect((await merges.displayStatus()).blockers).toEqual([{ code: 'pull-request', message: 'The task has no published pull request into main.' }]);
    // A PR into another base is the task's, but not one the merge can target.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
    const other = runningTask(); const elsewhere = begin(other, 'release'); opened(other, elsewhere.openingId, 9);
    expect((await new MergeCoordinator(service(other), github(other).client, undefined, undefined, PUBLISHED).displayStatus()).blockers)
      .toEqual([{ code: 'pull-request', message: 'The task has no published pull request into main.' }]);
    expect(gh.client.inspect).not.toHaveBeenCalled();
  });

  const faults: Array<[string, (n: number, marker: string) => Partial<RemoteMergeState>, RegExp]> = [
    ['a draft', () => ({ draft: true }), /^Pull request #7 is a draft/],
    ['an edited first line', () => ({ published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: false, marker: 'Fixes #12', branchOpen: [{ number: 7, base: 'main' }] } }), /no longer starts with its codeboost marker/],
    ['a renamed branch', (_, marker) => ({ published: { headBranch: 'other', baseBranch: 'main', crossRepository: false, marker, branchOpen: [{ number: 7, base: 'main' }] } }), /no longer from codeboost\/.* into main/],
    ['a retargeted base', (_, marker) => ({ published: { headBranch: BRANCH, baseBranch: 'release', crossRepository: false, marker, branchOpen: [{ number: 7, base: 'release' }] } }), /no longer from .* into main/],
    ['a fork', (_, marker) => ({ published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: true, marker, branchOpen: [{ number: 7, base: 'main' }] } }), /no longer from/],
    ['another open PR from the branch', (_, marker) => ({ published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: false, marker, branchOpen: [{ number: 7, base: 'main' }, { number: 8, base: 'release' }] } }), /must be the only open pull request from .*Close #8 \(into release\)/],
    ['a list that does not show it yet', (_, marker) => ({ published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: false, marker, branchOpen: [] } }), /does not show #7 yet/],
    ['no published fields', () => ({ published: undefined }), /did not report pull request #7/],
  ];
  for (const [name, change, message] of faults) it(`blocks a published PR with ${name}`, async () => {
    const { store, opening } = published();
    const gh = github(store, n => change(n, openingMarker(opening.openingId)));
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    const status = await merges.status();
    expect(status.ready).toBe(false);
    expect(status.blockers.map(blocker => blocker.message)).toEqual([expect.stringMatching(message)]);
    await expect(merges.remotePair()).rejects.toThrow(message);
    await expect(merges.merge('review-token')).rejects.toThrow(message);
    expect(gh.merged).toEqual([]);
  });

  it('refuses pre-merge preparation for a pull request that is no longer open', async () => {
    const { store } = published();
    const gh = github(store, () => ({ pullRequestState: 'CLOSED' }));
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    await expect(merges.remotePair()).rejects.toThrow(/is closed; pre-merge preparation requires an open pull request/);
  });

  it('does not ask a merged PR to still be open on its branch', async () => {
    const { store, opening } = published();
    const gh = github(store, () => ({ pullRequestState: 'MERGED', published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: false, marker: openingMarker(opening.openingId), branchOpen: [] } }));
    const status = await new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED).status();
    expect(status.blockers.map(blocker => blocker.code)).toEqual(['pr-state']);
  });

  it('excludes every PR the task recorded in this repository from the already-fixed check', async () => {
    const { store, adopt } = withLaterOpening();
    adopt();
    // A PR in another repository has a number of that repository: never one of this repository's own PRs.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const settled = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    store.markRunning(identity, settled.id); store.settleAttempt(identity, settled.id, { firstReason: null, exitCode: 0, valid: true });
    const foreign = store.beginPullRequest(identity, { checkId: clear(store).id, repository: 'fork/repo', base: 'main', headBranch: BRANCH, headSha: oid(2), draft: false });
    opened(store, foreign.openingId, 3, false);
    toReview(store);
    const gh = github(store);
    await new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED).status();
    expect(gh.targets[0]).toEqual({ pullRequest: 8, ownPullRequests: [7, 8], headBranch: BRANCH });
  });

  it('refuses when the task\'s PR changes between the validation passes', async () => {
    const { store, adopt } = withLaterOpening();
    const gh = github(store);
    // Recorded during the first pass's GitHub read, so the second pass resolves the newer PR.
    let reads = 0;
    gh.client.before = () => { if (++reads === 1) adopt(); };
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    await expect(merges.merge('review-token')).rejects.toThrow('The pull request changed during merge validation. Refresh before merging.');
    expect(gh.targets.map(target => target?.pullRequest)).toEqual([7, 8]);
    expect(gh.merged).toEqual([]);
    expect(store.getMergeAttempt(identity)).toBeNull();
  });

  it('in queue mode, reads the watermark of the resolved PR and refuses a PR change found by the third pass', async () => {
    const { store, adopt } = withLaterOpening();
    const gh = github(store, () => ({ mergeQueue: true }));
    let reads = 0;
    gh.client.before = () => { if (++reads === 2) adopt(); };
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    await expect(merges.merge('review-token')).rejects.toThrow('Merge-queue requirements changed after queue correlation. Refresh before merging.');
    expect(gh.client.queueWatermark).toHaveBeenCalledWith(oid(2), expect.objectContaining({ pullRequest: 7 }));
    expect(gh.targets.map(target => target?.pullRequest)).toEqual([7, 7, 8]);
    expect(gh.merged).toEqual([]);
  });

  it('does not settle an attempt for another PR that was admitted while this status read was in flight', async () => {
    const { store } = published();
    const view = service(store).load();
    // No PR is pinned when the read starts; the attempt for PR 8 is admitted by another coordinator during the read.
    const gh = github(store, () => ({ pullRequest: 99, pullRequestState: 'MERGED' }));
    gh.client.before = () => { store.beginMergeAttempt(identity, view.expected as never, oid(2), null, 'direct', null, null, { pullRequest: 8, openingId: null }); };
    await new MergeCoordinator(service(store), gh.client).status();
    expect(store.getMergeAttempt(identity)).toMatchObject({ state: 'submitting', pullRequest: 8 });
  });

  it('blocks a draft without a runner block too', async () => {
    const { store } = published();
    const status = await new MergeCoordinator(service(store), github(store, () => ({ draft: true })).client).status();
    expect(status.blockers).toEqual([{ code: 'draft', message: 'Pull request #99 is a draft; GitHub does not merge a draft.' }]);
  });

  it('settles a direct attempt only from its own PR, even after a newer PR is recorded', async () => {
    const { store, first, adopt } = withLaterOpening();
    const view = service(store).load();
    const attempt = store.beginMergeAttempt(identity, view.expected as never, oid(2), null, 'direct', null, null, { pullRequest: 7, openingId: first.openingId });
    // A newer PR recorded while the attempt is in flight; the attempt keeps the PR it was started for.
    adopt();
    const gh = github(store, n => (n === 7 ? { pullRequestState: 'MERGED' } : {}));
    const merges = new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED);
    await merges.status();
    expect(gh.targets[0]).toEqual({ pullRequest: 7, ownPullRequests: [7, 8] });
    expect(store.getMergeAttempt(identity)).toMatchObject({ id: attempt.id, state: 'merged', pullRequest: 7 });
  });

  it('never settles an attempt from the state of another PR', async () => {
    const { store, opening: first } = published();
    const view = service(store).load();
    const attempt = store.beginMergeAttempt(identity, view.expected as never, oid(2), null, 'direct', null, null, { pullRequest: 7, openingId: first.openingId });
    const gh = github(store, () => ({ pullRequest: 8, pullRequestState: 'MERGED' }));
    const shown = await new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED).displayStatus();
    expect(shown.blockers[0]).toMatchObject({ code: 'github', message: expect.stringMatching(/different pull request/) });
    expect(store.getMergeAttempt(identity)).toMatchObject({ id: attempt.id, state: 'submitting' });
  });

  it('polls the queue for the attempt\'s own PR; an attempt saved without one uses github.pullRequest or reports why it cannot', async () => {
    const { store, opening: first } = published();
    const view = service(store).load();
    store.beginMergeAttempt(identity, view.expected as never, oid(2), 'CURSOR', 'queue', null, null, { pullRequest: 7, openingId: first.openingId });
    const gh = github(store);
    await new MergeCoordinator(service(store), gh.client, undefined, undefined, PUBLISHED).pollQueue();
    expect(gh.queued).toEqual([7]);

    const legacy = published();
    const legacyView = service(legacy.store).load();
    legacy.store.beginMergeAttempt(identity, legacyView.expected as never, oid(2), 'CURSOR', 'queue');
    expect(legacy.store.getMergeAttempt(identity)!.pullRequest).toBeNull();
    const old = github(legacy.store);
    const before = legacy.store.getMergeAttempt(identity);
    const unknown = await new MergeCoordinator(service(legacy.store), old.client, undefined, undefined, PUBLISHED).pollQueue();
    expect(unknown?.observationError).toMatch(/saved without its pull request/);
    expect(legacy.store.getMergeAttempt(identity)).toEqual(before);
    // The attempt on record is still shown first.
    expect((await new MergeCoordinator(service(legacy.store), old.client, undefined, undefined, PUBLISHED).displayStatus()).blockers).toEqual([
      { code: 'queue-active', message: 'The reviewed head is being submitted to the merge queue.' },
      { code: 'pull-request', message: expect.stringMatching(/saved without its pull request/) }]);
    expect(old.queued).toEqual([]);
    await new MergeCoordinator(service(legacy.store), old.client, undefined, undefined, { ...PUBLISHED, configured: 5 }).pollQueue();
    expect(old.queued).toEqual([5]);
  });

  it('shows the review\'s own blockers beside one that names no PR to inspect', async () => {
    const store = runningTask(); toReview(store);
    const reviewing = service(store);
    (reviewing.load() as unknown as { items: Array<{ state: string }> }).items[0]!.state = 'pending';
    const shown = await new MergeCoordinator(reviewing, github(store).client, undefined, undefined, PUBLISHED).displayStatus();
    expect(shown.blockers).toEqual([
      { code: 'pull-request', message: 'The task has no published pull request into main.' },
      { code: 'approval', message: 'P1 is pending.' }]);
  });

  it('keeps the configured PR without a runner block, and pins the PR GitHub reported', async () => {
    const { store } = published();
    const gh = github(store);
    const merges = new MergeCoordinator(service(store), gh.client);
    await merges.merge('review-token');
    expect(gh.targets).toEqual([undefined, undefined]);
    expect(gh.merged).toEqual([99]);
    expect(store.getMergeAttempt(identity)!.pullRequest).toBe(99);
  });
});

describe('admission re-reads the task\'s PR record (#121)', () => {
  const admit = (store: Store, target: { pullRequest: number; openingId: string | null }) =>
    store.beginMergeAttempt(identity, service(store).load().expected as never, oid(2), null, 'direct', null, null, target);
  it('refuses a PR that is no longer the task\'s latest, or another number', () => {
    const { store, first, later, adopt } = withLaterOpening();
    expect(() => admit(store, { pullRequest: 9, openingId: first.openingId })).toThrow(GuardRefusal);
    adopt();
    expect(() => admit(store, { pullRequest: 7, openingId: first.openingId })).toThrow('The task\'s pull request changed during merge validation. Refresh before merging.');
    expect(admit(store, { pullRequest: 8, openingId: later.openingId }).pullRequest).toBe(8);
  });
  it('refuses while an opening is in flight, or when the record was abandoned; a newer PR elsewhere does not refuse', () => {
    const { store, first, later } = withLaterOpening();
    // Another base and another repository are not this base's latest.
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const rerun = () => { const a = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
      store.markRunning(identity, a.id); store.settleAttempt(identity, a.id, { firstReason: null, exitCode: 0, valid: true }); };
    rerun(); opened(store, begin(store, 'release').openingId, 10, false);
    opened(store, store.beginPullRequest(identity, { checkId: clear(store).id, repository: 'fork/repo', base: 'main', headBranch: BRANCH, headSha: oid(2), draft: false }).openingId, 11, false);
    const inFlight = begin(store);
    toReview(store);
    expect(() => admit(store, { pullRequest: 7, openingId: first.openingId })).toThrow('The task\'s pull request is being opened or updated. Wait for publishing to finish, then refresh.');
    store.abandonPullRequestOpening(identity, inFlight.openingId);
    expect(() => admit(store, { pullRequest: 8, openingId: later.openingId })).toThrow('The task\'s pull request changed during merge validation. Refresh before merging.');
    expect(admit(store, { pullRequest: 7, openingId: first.openingId }).pullRequest).toBe(7);
  });
  it('refuses while an update of the task\'s PR is in flight', () => {
    const store = runningTask();
    const opening = begin(store); opened(store, opening.openingId, 7, false);
    store.beginRefresh(identity, { checkId: clear(store).id, openingId: opening.openingId, headSha: oid(2), draft: false });
    toReview(store);
    expect(() => admit(store, { pullRequest: 7, openingId: opening.openingId })).toThrow('The task\'s pull request is being opened or updated. Wait for publishing to finish, then refresh.');
  });
});

describe('GhMergeGateway with a target (#121)', () => {
  const marker = openingMarker('0f0e0d0c-0b0a-4908-8706-050403020100');
  function fake(over: { pull?: Record<string, unknown>; list?: unknown } = {}) {
    const calls: string[][] = [], checks: AlreadyFixedInput[] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]); const joined = args.join(' ');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: Number(args[2]), isDraft: false, baseRefName: 'main', baseRefOid: oid(1), headRefName: BRANCH, headRefOid: oid(2), state: 'OPEN',
        mergeable: 'MERGEABLE', statusCheckRollup: [], body: `${marker}\r\nFixes #12`, isCrossRepository: false, ...over.pull });
      if (joined.includes('/pulls?')) return JSON.stringify(over.list ?? [{ number: 7, head: { ref: BRANCH }, base: { ref: 'main' } }]);
      if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
      if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
      if (/\/branches\/[^/]+$/.test(joined)) return JSON.stringify({ protected: false });
      if (args[0] === 'pr' && args[1] === 'merge') return '';
      throw new Error(`Unexpected gh call: ${joined}`);
    };
    const check: AlreadyFixedGateway = { repository: 'owner/repo', check: async input => { checks.push(input); return { outcome: 'clear', baseHead: oid(9) }; } };
    return { calls, checks, client: new GhMergeGateway({ repository: 'owner/repo', issue: 12 }, run, check) };
  }
  const target: MergeTarget = { pullRequest: 7, ownPullRequests: [3], headBranch: BRANCH };

  it('reads where the published PR is, its first line and the open PRs from its branch', async () => {
    const { calls, checks, client } = fake();
    const state = await client.inspect({ target });
    expect(state).toMatchObject({ pullRequest: 7, draft: false, published: { headBranch: BRANCH, baseBranch: 'main', crossRepository: false, marker, branchOpen: [{ number: 7, base: 'main' }] } });
    expect(calls[0]).toEqual(['pr', 'view', '7', '--repo', 'owner/repo', '--json', 'number,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup,url,body,isCrossRepository']);
    expect(calls).toContainEqual(['api', '-H', 'Accept: application/vnd.github+json', `repos/owner/repo/pulls?state=open&head=owner%3A${encodeURIComponent(BRANCH)}&per_page=100`]);
    expect(checks[0]!.ownPullRequests).toEqual([7, 3]);
  });

  it('reads no description or branch list for a configured PR', async () => {
    const { calls, client } = fake();
    await expect(client.inspect()).rejects.toThrow(/No pull request to merge/);
    const state = await client.inspect({ target: { pullRequest: 7 } });
    expect(state.published).toBeUndefined();
    expect(calls.some(args => args.join(' ').includes('/pulls?'))).toBe(false);
    expect(calls.find(args => args[1] === 'view')!.at(-1)).toBe('number,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup,url');
  });

  const malformed: Array<[string, Parameters<typeof fake>[0], RegExp]> = [
    ['another PR number', { pull: { number: 8 } }, /different pull request/],
    ['no draft flag', { pull: { isDraft: undefined } }, /incomplete pull request state/],
    ['no description', { pull: { body: undefined } }, /incomplete pull request state/],
    ['no fork flag', { pull: { isCrossRepository: undefined } }, /incomplete pull request state/],
    ['a full page of PRs from the branch', { list: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, head: { ref: BRANCH }, base: { ref: 'main' } })) }, /100 or more/],
    ['a listed PR from another branch', { list: [{ number: 7, head: { ref: 'other' }, base: { ref: 'main' } }] }, /invalid pull request list/],
    ['a listed PR without a base', { list: [{ number: 7, head: { ref: BRANCH } }] }, /invalid pull request list/],
    ['a list that is not a list', { list: { message: 'Not Found' } }, /invalid pull request list/],
    ['a null list entry', { list: [null] }, /invalid pull request list/],
    ['a listed PR without a valid number', { list: [{ number: '7', head: { ref: BRANCH }, base: { ref: 'main' } }] }, /invalid pull request list/],
  ];
  for (const [name, over, message] of malformed) it(`fails closed on ${name}`, async () => {
    await expect(fake(over).client.inspect({ target })).rejects.toThrow(message);
  });

  it('stops and awaits the rule reads before rejecting when the branch list fails', async () => {
    let release!: () => void, stopped: AbortSignal | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const base = fake({ list: { message: 'not a list' } });
    const run = async (args: readonly string[], options?: { signal?: AbortSignal }) => {
      if (args.join(' ').includes('/rules/branches/')) { stopped = options?.signal; await held; throw new Error('stopped'); }
      return (base.client.run)(args, options);
    };
    const client = new GhMergeGateway({ repository: 'owner/repo', issue: 12 }, run, base.client.checks);
    let settled = false;
    const inspection = client.inspect({ target }).finally(() => { settled = true; });
    inspection.catch(() => {});
    await vi.waitFor(() => expect(stopped?.aborted).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(inspection).rejects.toThrow(/invalid pull request list/);
  });

  it('shares an inspection in flight only with a request for the same PR', async () => {
    const { calls, client } = fake();
    const [seven, again, eight] = await Promise.all([client.inspect({ target: { pullRequest: 7 } }), client.inspect({ target: { pullRequest: 7 } }), client.inspect({ target: { pullRequest: 8 } })]);
    expect([seven.pullRequest, again.pullRequest, eight.pullRequest]).toEqual([7, 7, 8]);
    expect(calls.filter(args => args[1] === 'view').map(args => args[2])).toEqual(['7', '8']);
  });

  it('reports a draft as GitHub shows it', async () => {
    expect((await fake({ pull: { isDraft: true } }).client.inspect({ target: { pullRequest: 7 } })).draft).toBe(true);
  });

  it('does not serve one PR\'s cached state for another', async () => {
    const { calls, client } = fake();
    await client.inspect({ target: { pullRequest: 7 } });
    const other = await client.inspect({ target: { pullRequest: 8 } });
    expect(other.pullRequest).toBe(8);
    expect(calls.filter(args => args[1] === 'view').map(args => args[2])).toEqual(['7', '8']);
  });

  it('merges and reads the queue of the PR it is given', async () => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => { calls.push([...args]); if (args[1] === 'graphql') throw new Error('stop'); return ''; };
    const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 5, issue: 12 }, run);
    await client.merge(oid(2), { pullRequest: 8 });
    expect(calls[0]).toEqual(['pr', 'merge', '8', '--repo', 'owner/repo', '--merge', '--match-head-commit', oid(2)]);
    await expect(client.queueWatermark(oid(2), { pullRequest: 8 })).rejects.toThrow('stop');
    await expect(client.inspectQueue(oid(2), { pullRequest: 8 })).rejects.toThrow('stop');
    expect(calls.slice(1).map(args => args.find(arg => arg.startsWith('number=')))).toEqual(['number=8', 'number=8']);
    await client.merge(oid(2));
    expect(calls.at(-1)![2]).toBe('5');
  });

  it('accepts a configuration without a PR, but not an invalid one', () => {
    expect(() => new GhMergeGateway({ repository: 'owner/repo', issue: 12 })).not.toThrow();
    expect(() => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 0, issue: 12 })).toThrow(/valid pull request number/);
  });
});

describe('the server chooses the merge target (#121)', { timeout: 60_000 }, () => {
  function demo() {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-merge-target-')); roots.push(root);
    const config = createDemo(join(root, 'demo'));
    const store = new Store(config.database); const issue = store.getPlan(config.identity).issue; store.close();
    return { config, issue };
  }
  it('requires github.pullRequest without a runner block', async () => {
    const { config, issue } = demo();
    await expect(startServer({ ...config, demo: false, github: { repository: 'owner/repo', issue } }, 0)).rejects.toThrow(/Add github.pullRequest/);
  });
  it('requires github.baseBranch with a runner block', async () => {
    const { config, issue } = demo();
    await expect(startServer({ ...config, demo: false, runner: {}, github: { repository: 'owner/repo', issue } }, 0)).rejects.toThrow(/github.baseBranch/);
  });
  it('targets the task\'s published PR with a runner block, without github.pullRequest', async () => {
    const { config, issue } = demo();
    const app = await startServer({ ...config, demo: false, runner: {}, github: { repository: 'owner/repo', issue, baseBranch: 'main' } }, 0);
    try {
      const response = await fetch(`${new URL(app.url).origin}/api/review`, { headers: { 'x-codeboost-token': app.token } });
      const view = await response.json() as { merge: { blockers: unknown[] } };
      expect(view.merge.blockers[0]).toEqual({ code: 'pull-request', message: 'The task has no published pull request into main.' });
    } finally { await app.close(); }
  });
  it('blocks when github.pullRequest names another PR than the task\'s published one', async () => {
    const { config, issue } = demo();
    // The demo task runs every item and publishes PR 7.
    const store = new Store(config.database), id = config.identity;
    try {
      store.transitionTask(id, store.getTask(id).stateVersion, 'queued');
      for (const { id: item } of store.getPlan(id).items) {
        const attempt = store.admitAttempt(id, { expectedStateVersion: store.getTask(id).stateVersion, kind: 'execute', item, expectedContext: store.currentContext(id), deadline: Date.now() + 60_000 });
        store.markRunning(id, attempt.id); store.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true });
      }
      const check = store.recordAlreadyFixed(id, store.getTask(id).stateVersion, { snapshotId: store.getSnapshot(id).id, reviewVersion: store.reviewVersion(id), draft: false, result: { outcome: 'clear', baseHead: oid(9) } });
      const head = store.getSnapshot(id).head;
      const opening = store.beginPullRequest(id, { checkId: check.id, repository: 'owner/repo', base: 'main', headBranch: BRANCH, headSha: head, draft: false });
      expect(store.recordPullRequestOpened(id, opening.openingId, { number: 7, url: url(7), headSha: head, draft: false }, true)).toBe('in review');
    } finally { store.close(); }
    const app = await startServer({ ...config, demo: false, runner: {}, github: { repository: 'owner/repo', issue, baseBranch: 'main', pullRequest: 5 } }, 0);
    try {
      const response = await fetch(`${new URL(app.url).origin}/api/review`, { headers: { 'x-codeboost-token': app.token } });
      const view = await response.json() as { merge: { blockers: unknown[] } };
      expect(view.merge.blockers[0]).toEqual({ code: 'pull-request', message: 'github.pullRequest is #5, but the task\'s pull request is #7. Remove github.pullRequest from the review configuration.' });
    } finally { await app.close(); }
  });
});

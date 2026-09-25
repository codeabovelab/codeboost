import { expect, it, vi } from 'vitest';
import { ReviewService } from '../runner/review.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { GhMergeGateway, MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type MergeQueueObservation, type RemoteMergeState } from '../github/merge.ts';
import { Store } from '../runner/store.ts';

type ReviewView = ReturnType<ReviewService['load']>;
const sha = (digit: string) => digit.repeat(40);
function readyView(): ReviewView {
  return {
    items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
    plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: 'snapshot', base: sha('a'), head: sha('b') }, token: 'review-token',
  } as unknown as ReviewView;
}
function serviceFor(view: ReviewView): ReviewService { return { load: vi.fn(() => view) } as unknown as ReviewService; }

function remote(view: ReviewView, change: Partial<RemoteMergeState> = {}): RemoteMergeState {
  return { base: view.snapshot.base, head: view.snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', ...change };
}

function gateway(states: RemoteMergeState[]): MergeGateway & { heads: string[] } {
  const heads: string[] = [];
  return { heads, inspect: vi.fn(async () => states.shift() ?? states.at(-1)!), merge: vi.fn(async head => { heads.push(head); return { url: 'https://github.example/pr/1' }; }) };
}

function queueHarness(observations: Array<MergeQueueObservation | Error>) {
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Queue', questions: [], items: [{ id: 'P1', title: 'Queue', intent: 'Queue safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  const context = { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] };
  store.createPlan(JSON.stringify(plan), 'json', context, sha('a'), sha('b'));
  let view = { ...readyView(), expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) } } as ReviewView;
  const service = { store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService;
  const merges: string[] = [];
  const client: MergeGateway & MergeQueueGateway = {
    inspect: vi.fn(async () => remote(view, { mergeQueue: true })),
    queueWatermark: vi.fn(async () => 'CURSOR_before'),
    merge: vi.fn(async head => { merges.push(head); return { url: 'https://github.example/pr/1' }; }),
    inspectQueue: vi.fn(async () => { const next = observations.shift(); if (next instanceof Error) throw next; if (!next) throw new Error('No queue observation.'); return next; }),
  };
  return { store, identity, service, client, merges, coordinator: new MergeCoordinator(service, client), view: () => view, amendPlan() {
    const amended = store.importRevision(JSON.stringify({ ...plan, summary: 'Amended queue plan' }), 'json', context, 1);
    view = { ...view, plan: amended, expected: { revision: amended.revision, snapshotId: view.expected.snapshotId, reviewVersion: store.reviewVersion(identity) }, token: 'review-amended-plan' } as ReviewView;
  }, replaceHead(head: string) {
    const expected = view.expected;
    const snapshot = store.recordHistory(identity, expected, sha('a'), head, []);
    view = { ...view, snapshot, expected: { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, token: `review-${head}` } as ReviewView;
  }, changeToken(token: string) { view = { ...view, token } as ReviewView; } };
}

it('lists every local review blocker before merge', async () => {
  const view = { ...readyView(), items: [{ ...readyView().items[0]!, state: 'stale', outside: ['undeclared.ts'] }], segments: [{ row: 'Unplanned' }], notes: [{ kind: 'change', revision: 1, snapshotId: 'snapshot' }] } as unknown as ReviewView;
  const service = serviceFor(view);
  const status = await new MergeCoordinator(service, gateway([remote(view)])).status(view);
  expect(new Set(status.blockers.map(blocker => blocker.code))).toEqual(new Set(['approval', 'scope', 'unplanned', 'changes']));
});

it('keeps review available when GitHub merge state cannot be read', async () => {
  const view = readyView(), service = serviceFor(view);
  const client: MergeGateway = { inspect: async () => { throw new Error('login required'); }, merge: async () => ({ url: '' }) };
  const status = await new MergeCoordinator(service, client).displayStatus(view);
  expect(status).toMatchObject({ ready: false, remote: null, blockers: [{ code: 'github', message: 'Could not read GitHub merge state. login required' }] });
});

it.each([
  ['base', (_view: ReviewView) => ({ base: sha('c') })],
  ['head', (_view: ReviewView) => ({ head: sha('c') })],
  ['pr-state', (_view: ReviewView) => ({ pullRequestState: 'CLOSED' as const })],
  ['mergeable', (_view: ReviewView) => ({ mergeable: 'CONFLICTING' as const })],
  ['rules', (_view: ReviewView) => ({ rulesKnown: false })],
  ['base-guard', (_view: ReviewView) => ({ atomicBaseGuard: false })],
  ['merge-queue', (_view: ReviewView) => ({ mergeQueue: true })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'pending-test', appId: null, state: 'pending' as const }] })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'failed-test', appId: null, state: 'failure' as const }] })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'missing-test', appId: null, state: 'missing' as const }] })],
  ['already-fixed', (_view: ReviewView) => ({ alreadyFixed: 'found' as const })],
])('blocks the %s remote condition', async (code, change) => {
  const view = readyView(), service = serviceFor(view);
  const status = await new MergeCoordinator(service, gateway([remote(view, change(view))])).status(view);
  expect(status.blockers.map(blocker => blocker.code)).toContain(code);
});

it('blocks command acceptance that has no current passing runner result', async () => {
  const view = readyView();
  const changed = { ...view, items: view.items.map((item, index) => index ? item : { ...item, acceptance: [{ type: 'cmd' as const, text: 'npm test' }] }) };
  const fakeService = { load: () => changed } as unknown as ReviewService;
  const status = await new MergeCoordinator(fakeService, gateway([remote(view)])).status(changed);
  expect(status.blockers.map(blocker => blocker.code)).toContain('acceptance');
});

it('rechecks the exact base and head, then invokes the guarded head merge', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view)]);
  const merged = await new MergeCoordinator(service, client).merge(view.token);
  expect(client.heads).toEqual([view.snapshot.head]);
  expect(merged.result.url).toContain('/pr/1');
});

it('enforces one deadline across every merge validation stage', async () => {
  const h = queueHarness([]);
  h.client.inspect = vi.fn(async value => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      const signal = (value as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return remote(h.view(), { mergeQueue: true });
  });
  try {
    const started = Date.now();
    await expect(new MergeCoordinator(h.service, h.client, 250).merge(h.view().token)).rejects.toThrow(/deadline/i);
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.client.merge).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it('refuses a base or head race after the initial validation', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view, { head: 'c'.repeat(40) })]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/changed during merge validation/);
  expect(client.heads).toEqual([]);
});

it('refuses a requirement that changes after the initial validation', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view, { mergeable: 'CONFLICTING' })]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/requirements changed.*merge conflicts/i);
  expect(client.heads).toEqual([]);
});

it('revalidates the store generation after the final asynchronous status check', async () => {
  const view = readyView(), changed = { ...view, token: 'new-review-token' };
  let loads = 0;
  const service = { load: vi.fn(() => ++loads < 3 ? view : changed) } as unknown as ReviewService;
  const client = gateway([remote(view), remote(view)]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/Review changed during merge validation/);
  expect(client.heads).toEqual([]);
});

it('preserves the GitHub merge refusal', async () => {
  const view = readyView(), service = serviceFor(view), state = remote(view);
  const client: MergeGateway = { inspect: vi.fn(async () => state), merge: async () => { throw new Error('Required review is missing.'); } };
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow('Required review is missing.');
});

it('aborts and awaits an active merge command during shutdown', async () => {
  const view = readyView(), service = serviceFor(view);
  let commandStarted!: () => void, commandSettled = false;
  const started = new Promise<void>(resolve => { commandStarted = resolve; });
  const client: MergeGateway = {
    inspect: vi.fn(async () => remote(view)),
    merge: vi.fn(async (_head, options) => new Promise<never>((_resolve, reject) => {
      commandStarted();
      options?.signal?.addEventListener('abort', () => { commandSettled = true; reject(options.signal?.reason); }, { once: true });
    })),
  };
  const coordinator = new MergeCoordinator(service, client);
  const merging = coordinator.merge(view.token);
  await started;
  await coordinator.close();
  await expect(merging).rejects.toThrow(/shutdown/i);
  expect(commandSettled).toBe(true);
  await expect(coordinator.merge(view.token)).rejects.toThrow(/shutting down/i);
});

it('persists enqueue success as queued and waits for a separate confirmed merge', async () => {
  const h = queueHarness([
    { state: 'queued', reviewedHead: sha('b'), entryId: 'MQE_1', phase: 'AWAITING_CHECKS', position: 2, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: sha('b') },
    { state: 'merged', reviewedHead: sha('b'), mergedAt: '2026-09-24T08:10:00Z' },
  ]);
  try {
    await h.coordinator.merge(h.view().token);
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'queued', reviewedHead: sha('b') });
    expect((await h.coordinator.pollQueue())).toMatchObject({ state: 'queued', phase: 'AWAITING_CHECKS', position: 2 });
    expect(h.client.inspectQueue).toHaveBeenCalledWith(sha('b'), expect.objectContaining({ afterCursor: 'CURSOR_before' }));
    expect((await h.coordinator.pollQueue())).toMatchObject({ state: 'merged', occurredAt: '2026-09-24T08:10:00Z', retryable: false });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('keeps an externally successful enqueue committed when the queued-state refresh fails', async () => {
  const h = queueHarness([{ state: 'queued', reviewedHead: sha('b'), entryId: 'MQE_1', phase: 'QUEUED', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: sha('b') }]);
  const queue = h.store.queueMergeAttempt.bind(h.store);
  h.store.queueMergeAttempt = vi.fn(() => { throw new Error('local refresh failed'); });
  try {
    await expect(h.coordinator.merge(h.view().token)).resolves.toMatchObject({ result: { url: 'https://github.example/pr/1' } });
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting', reviewedHead: sha('b') });
    h.store.queueMergeAttempt = queue;
    expect(await h.coordinator.pollQueue()).toMatchObject({ state: 'queued', phase: 'QUEUED' });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it.each([
  [{ state: 'removed', reviewedHead: sha('b'), removedAt: '2026-09-24T08:05:00Z', reason: 'Checks failed.' } as const, 'removed', 'Checks failed.'],
  [{ state: 'failed', reviewedHead: sha('b'), entryId: 'MQE_1', reason: 'GitHub reported the merge queue entry as unmergeable.' } as const, 'failed', 'GitHub reported the merge queue entry as unmergeable.'],
])('persists a terminal %s queue result and safely enables retry', async (observation, state, reason) => {
  const h = queueHarness([observation]);
  try {
    await h.coordinator.merge(h.view().token);
    expect(await h.coordinator.pollQueue()).toMatchObject({ state, reason, retryable: true });
    expect((await h.coordinator.status(h.view())).action).toBe('retry');
    await h.coordinator.merge(h.view().token);
    expect(h.merges).toEqual([sha('b'), sha('b')]);
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'queued', reviewedHead: sha('b') });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('requires current-snapshot approvals after an ordinary queue removal and force-push', async () => {
  const h = queueHarness([{ state: 'removed', reviewedHead: sha('b'), removedAt: '2026-09-24T08:05:00Z', reason: 'Checks failed.' }]);
  try {
    await h.coordinator.merge(h.view().token);
    await h.coordinator.pollQueue();
    h.replaceHead(sha('c'));
    expect((await h.coordinator.status(h.view())).action).toBeNull();
    h.store.saveReview(h.identity, h.view().expected, [{ item: 'P1', fingerprint: 'replacement-review' }], []);
    expect((await h.coordinator.status(h.view())).action).toBe('merge');
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('requires current-revision approvals after a same-snapshot plan amendment', async () => {
  const h = queueHarness([{ state: 'removed', reviewedHead: sha('b'), removedAt: '2026-09-24T08:05:00Z', reason: 'Checks failed.' }]);
  try {
    await h.coordinator.merge(h.view().token);
    await h.coordinator.pollQueue();
    h.amendPlan();
    expect((await h.coordinator.status(h.view())).action).toBeNull();
    h.store.saveReview(h.identity, h.view().expected, [{ item: 'P1', fingerprint: 'amended-plan-review' }], []);
    expect((await h.coordinator.status(h.view())).action).toBe('merge');
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('requires a fresh review after the queued head is replaced', async () => {
  const h = queueHarness([new Error('The pull request head changed after review.')]);
  try {
    await h.coordinator.merge(h.view().token);
    expect(await h.coordinator.pollQueue()).toMatchObject({ state: 'failed', retryable: false, reason: 'The pull request head changed after review.' });
    expect((await h.coordinator.status(h.view())).action).toBeNull();
    h.replaceHead(sha('c'));
    expect((await h.coordinator.status(h.view())).action).toBeNull();
    h.store.saveReview(h.identity, h.view().expected, [{ item: 'P1', fingerprint: 'fresh-review' }], []);
    expect((await h.coordinator.status(h.view())).action).toBe('merge');
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('accepts a fully re-reviewed replacement snapshot restored to the original head', async () => {
  const h = queueHarness([new Error('The pull request head changed after review.')]);
  try {
    await h.coordinator.merge(h.view().token);
    await h.coordinator.pollQueue();
    h.replaceHead(sha('c'));
    h.replaceHead(sha('b'));
    h.store.saveReview(h.identity, h.view().expected, [{ item: 'P1', fingerprint: 'restored-head-review' }], []);
    expect((await h.coordinator.status(h.view())).action).toBe('merge');
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('refuses a merge-queue mode change between validation passes', async () => {
  const h = queueHarness([]);
  h.client.inspect = vi.fn()
    .mockResolvedValueOnce(remote(h.view(), { mergeQueue: false }))
    .mockResolvedValueOnce(remote(h.view(), { mergeQueue: true }));
  try {
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow(/queue|requirements changed/i);
    expect(h.merges).toEqual([]);
    expect(h.store.getMergeAttempt(h.identity)).toBeNull();
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('revalidates the review generation after reading the queue watermark', async () => {
  const h = queueHarness([]);
  h.client.queueWatermark = vi.fn(async () => { h.changeToken('new-review-token'); return 'CURSOR_before'; });
  try {
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow(/review changed during merge validation/i);
    expect(h.merges).toEqual([]);
    expect(h.store.getMergeAttempt(h.identity)).toBeNull();
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('refuses a queue-mode change observed after reading the queue watermark', async () => {
  const h = queueHarness([]);
  h.client.inspect = vi.fn()
    .mockResolvedValueOnce(remote(h.view(), { mergeQueue: true }))
    .mockResolvedValueOnce(remote(h.view(), { mergeQueue: true }))
    .mockResolvedValueOnce(remote(h.view(), { mergeQueue: false }));
  try {
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow(/queue|requirements changed/i);
    expect(h.merges).toEqual([]);
    expect(h.store.getMergeAttempt(h.identity)).toBeNull();
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('keeps retry disabled while a prior queue attempt is active', async () => {
  const h = queueHarness([]);
  try {
    await h.coordinator.merge(h.view().token);
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow(/queued|active/i);
    expect(h.merges).toEqual([sha('b')]);
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('aborts and awaits an active queue inspection during shutdown', async () => {
  const h = queueHarness([]);
  let settled = false;
  h.client.inspectQueue = vi.fn(async (_head, options) => new Promise<never>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { settled = true; reject(options.signal?.reason); }, { once: true });
  }));
  try {
    await h.coordinator.merge(h.view().token);
    const polling = h.coordinator.pollQueue();
    await h.coordinator.close();
    await expect(polling).rejects.toThrow(/shutdown/i);
    expect(settled).toBe(true);
  } finally { h.store.close(); }
});

it('keeps an aborted enqueue submitting until queue inspection recovers its outcome', async () => {
  const h = queueHarness([{ state: 'queued', reviewedHead: sha('b'), entryId: 'MQE_1', phase: 'QUEUED', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: sha('b') }]);
  let started!: () => void;
  const commandStarted = new Promise<void>(resolve => { started = resolve; });
  h.client.merge = vi.fn(async (_head, options) => new Promise<never>((_resolve, reject) => {
    started(); options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  const merging = h.coordinator.merge(h.view().token);
  await commandStarted;
  await h.coordinator.close();
  await expect(merging).rejects.toThrow(/shutdown/i);
  expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting', reviewedHead: sha('b') });
  const recovered = new MergeCoordinator(h.service, h.client);
  try { expect(await recovered.pollQueue()).toMatchObject({ state: 'queued', phase: 'QUEUED', retryable: false }); }
  finally { await recovered.close(); h.store.close(); }
});

it('records only a confirmed enqueue refusal as retryable failure', async () => {
  const h = queueHarness([]);
  h.client.merge = vi.fn(async () => { throw new MergeSubmissionError('Required review is missing.', 'refused'); });
  try {
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow('Required review is missing.');
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'failed', reason: 'Required review is missing.' });
    expect(await h.coordinator.status()).toMatchObject({ ready: true, action: 'retry', queue: { state: 'failed', retryable: true } });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('keeps an unknown enqueue failure submitting until external reconciliation', async () => {
  const h = queueHarness([]);
  h.client.merge = vi.fn(async () => { throw new MergeSubmissionError('GitHub merge submission timed out.', 'unknown'); });
  try {
    await expect(h.coordinator.merge(h.view().token)).rejects.toThrow(/timed out/i);
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting', reason: 'GitHub merge submission timed out.' });
    expect(await h.coordinator.status()).toMatchObject({ ready: false, action: null, queue: { state: 'submitting', retryable: false, reason: 'GitHub merge submission timed out.' } });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('classifies only explicit GitHub merge refusals as confirmed', async () => {
  const config = { repository: 'owner/repo', pullRequest: 7, issue: 24 };
  const refusal = new GhMergeGateway(config, async () => { throw new Error('Required review is missing.'); });
  const unknown = new GhMergeGateway(config, async () => { throw new Error('request timed out'); });
  await expect(refusal.merge(sha('b'))).rejects.toMatchObject({ name: 'MergeSubmissionError', outcome: 'refused' });
  await expect(unknown.merge(sha('b'))).rejects.toMatchObject({ name: 'MergeSubmissionError', outcome: 'unknown' });
});

it('parses required checks from both rule sources and pins the gh merge head', async () => {
  const calls: string[][] = [];
  let pullReads = 0;
  const run = async (args: readonly string[]) => {
    calls.push([...args]); const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) { pullReads++; return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', app: { databaseId: 10 } },
      { name: 'race', status: 'IN_PROGRESS', conclusion: 'SUCCESS' },
      { context: 'lint', state: 'SUCCESS' },
    ] }); }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test', integration_id: 10 }, { context: 'race', integration_id: null }] } }]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.includes('/protection')) return JSON.stringify({ required_status_checks: { strict: false, checks: [{ context: 'lint', app_id: null }] } });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    if (joined.startsWith('pr merge 7')) return '';
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
  const state = await client.inspect();
  expect(state.atomicBaseGuard).toBe(true);
  expect(state.mergeQueue).toBe(true);
  expect(state.requiredChecks).toEqual([
    { context: 'test', appId: 10, state: 'success' },
    { context: 'race', appId: null, state: 'pending' },
    { context: 'lint', appId: null, state: 'success' },
  ]);
  await client.merge(sha('b'));
  expect(calls.at(-1)).toEqual(['pr','merge','7','--repo','owner/repo','--merge','--match-head-commit',sha('b')]);
  await client.inspect();
  expect(pullReads).toBe(2);
});

it('rejects an unsupported runtime merge method', () => {
  expect(() => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21, method: 'typo' as 'merge' })).toThrow(/merge method/i);
});

const queueFixture = (pullRequest: Record<string, unknown>) => {
  const timeline = pullRequest.timelineItems as { nodes?: unknown[] } | undefined;
  const normalized = timeline && Array.isArray(timeline.nodes) ? {
    ...pullRequest,
    timelineItems: {
      edges: timeline.nodes.map((node, index) => ({
        cursor: node && typeof node === 'object' && !Array.isArray(node) && typeof (node as { cursor?: unknown }).cursor === 'string'
          ? (node as { cursor: string }).cursor : `CURSOR_${index}`,
        node,
      })),
      pageInfo: { hasNextPage: false, endCursor: timeline.nodes.length ? `CURSOR_${timeline.nodes.length - 1}` : null },
    },
  } : pullRequest;
  return JSON.stringify({ data: { repository: { pullRequest: { number: 7, headRefOid: sha('b'), ...normalized } } } });
};

it('captures the stable queue timeline cursor before enqueue', async () => {
  const run = async () => queueFixture({ timelineItems: { nodes: [{ id: 'MQEV_before', cursor: 'CURSOR_before' }] } });
  await expect(new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).queueWatermark(sha('b'))).resolves.toBe('CURSOR_before');
});

it.each([
  ['QUEUED', 'queued'],
  ['AWAITING_CHECKS', 'queued'],
  ['LOCKED', 'queued'],
  ['MERGEABLE', 'queued'],
] as const)('maps the recorded %s merge-queue entry to %s', async (entryState, expectedState) => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, timelineItems: { nodes: [{ id: 'MQEV_1', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T08:00:00Z' }] },
    mergeQueueEntry: { id: 'MQE_1', state: entryState, position: 2, enqueuedAt: '2026-09-24T08:00:00Z', headCommit: { oid: sha('b') }, pullRequest: { number: 7, headRefOid: sha('b') } },
  });
  const observation = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'));
  expect(observation).toEqual({ state: expectedState, reviewedHead: sha('b'), entryId: 'MQE_1', phase: entryState, position: 2, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: sha('b') });
});

it('maps a recorded unmergeable queue entry to a failed terminal state', async () => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, timelineItems: { nodes: [{ id: 'MQEV_1', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T08:00:00Z' }] },
    mergeQueueEntry: { id: 'MQE_1', state: 'UNMERGEABLE', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', headCommit: { oid: sha('b') }, pullRequest: { number: 7, headRefOid: sha('b') } },
  });
  await expect(new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'))).resolves.toEqual({
    state: 'failed', reviewedHead: sha('b'), entryId: 'MQE_1', reason: 'GitHub reported the merge queue entry as unmergeable.',
  });
});

it('preserves the recorded reason when GitHub removes a pull request from the merge queue', async () => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [
      { id: 'MQEV_1', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T08:00:00Z' },
      { id: 'MQEV_2', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T08:05:00Z', reason: 'Checks failed', beforeCommit: { oid: sha('b') } },
    ] },
  });
  await expect(new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'))).resolves.toEqual({
    state: 'removed', reviewedHead: sha('b'), removedAt: '2026-09-24T08:05:00Z', reason: 'Checks failed',
  });
});

it('rejects a removal event at the pre-enqueue timeline cursor', async () => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [] },
  });
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run);
  await expect(client.inspectQueue(sha('b'), { afterCursor: 'CURSOR_removed_old' })).rejects.toThrow(/current attempt/i);
});

it('recovers terminal state after the stored cursor falls outside the recent event window', async () => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [
      { id: 'MQEV_added_current', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T09:00:00Z' },
      { id: 'MQEV_removed_current', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T09:05:00Z', reason: 'Current attempt failed', beforeCommit: { oid: sha('b') } },
    ] },
  });
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run);
  await expect(client.inspectQueue(sha('b'), { afterCursor: 'CURSOR_before_outside_window' })).resolves.toMatchObject({
    state: 'removed', reason: 'Current attempt failed', removedAt: '2026-09-24T09:05:00Z',
  });
});

it('paginates forward from the stored cursor to the terminal event', async () => {
  let calls = 0;
  const response = (edge: Record<string, unknown>, hasNextPage: boolean, endCursor: string | null) => JSON.stringify({ data: { repository: { pullRequest: {
    number: 7, headRefOid: sha('b'), state: 'OPEN', mergedAt: null, mergeQueueEntry: null,
    timelineItems: { edges: [edge], pageInfo: { hasNextPage, endCursor } },
  } } } });
  const run = async (args: readonly string[]) => {
    calls++;
    if (calls === 1) {
      expect(args).toContain('after=CURSOR_before');
      return response({ cursor: 'CURSOR_added', node: { id: 'MQEV_added', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T09:00:00Z' } }, true, 'CURSOR_added');
    }
    expect(args).toContain('after=CURSOR_added');
    return response({ cursor: 'CURSOR_removed', node: { id: 'MQEV_removed', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T09:05:00Z', reason: 'Checks failed', beforeCommit: { oid: sha('b') } } }, false, 'CURSOR_removed');
  };
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run);
  await expect(client.inspectQueue(sha('b'), { afterCursor: 'CURSOR_before' })).resolves.toMatchObject({ state: 'removed', reason: 'Checks failed' });
  expect(calls).toBe(2);
});

it('fails closed when multiple enqueue sequences follow the stored cursor', async () => {
  const run = async () => queueFixture({
    state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [
      { id: 'MQEV_add_1', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T09:00:00Z' },
      { id: 'MQEV_remove_1', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T09:01:00Z', reason: 'First removal', beforeCommit: { oid: sha('b') } },
      { id: 'MQEV_add_2', __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-24T09:02:00Z' },
      { id: 'MQEV_remove_2', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T09:03:00Z', reason: 'Second removal', beforeCommit: { oid: sha('b') } },
    ] },
  });
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run);
  await expect(client.inspectQueue(sha('b'), { afterCursor: 'CURSOR_before' })).rejects.toThrow(/multiple|current enqueue attempt/i);
});

it('reports merged only when GitHub confirms the reviewed head was merged', async () => {
  let call: readonly string[] = [];
  const run = async (args: readonly string[]) => {
    call = args;
    return queueFixture({ state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', mergeQueueEntry: null, timelineItems: { nodes: [] } });
  };
  await expect(new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'))).resolves.toEqual({
    state: 'merged', reviewedHead: sha('b'), mergedAt: '2026-09-24T08:10:00Z',
  });
  expect(call).toEqual([
    'api', 'graphql', '-f',
    'query=query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid state mergedAt mergeQueueEntry{id state position enqueuedAt headCommit{oid} pullRequest{number headRefOid}} timelineItems(first:100,after:$after,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){edges{cursor node{id __typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason beforeCommit{oid}}}} pageInfo{hasNextPage endCursor}}}}}',
    '-f', 'owner=owner', '-f', 'name=repo', '-F', 'number=7',
  ]);
});

it.each([
  ['a replaced reviewed head', queueFixture({ state: 'OPEN', mergedAt: null, headRefOid: sha('d'), mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', headCommit: { oid: sha('d') }, pullRequest: { number: 7, headRefOid: sha('d') } }, timelineItems: { nodes: [] } })],
  ['a queue entry for another head', queueFixture({ state: 'OPEN', mergedAt: null, mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', headCommit: { oid: sha('d') }, pullRequest: { number: 7, headRefOid: sha('b') } }, timelineItems: { nodes: [] } })],
  ['a stale removal from another head', queueFixture({ state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [{ id: 'MQEV_1', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T08:05:00Z', reason: 'Checks failed', beforeCommit: { oid: sha('d') } }] } })],
  ['an absent queue entry without a removal event', queueFixture({ state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [] } })],
  ['a removal without a reason', queueFixture({ state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [{ id: 'MQEV_1', __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-24T08:05:00Z', reason: null, beforeCommit: { oid: sha('b') } }] } })],
  ['an omitted mergeQueueEntry field', queueFixture({ state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', timelineItems: { nodes: [] } })],
  ['an omitted timelineItems field', queueFixture({ state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', mergeQueueEntry: null })],
  ['a malformed timeline node on a merged response', queueFixture({ state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', mergeQueueEntry: null, timelineItems: { nodes: [null] } })],
  ['GraphQL errors alongside data', JSON.stringify({ data: { repository: { pullRequest: { number: 7, headRefOid: sha('b'), state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', mergeQueueEntry: null, timelineItems: { nodes: [] } } } }, errors: [{ message: 'partial' }] })],
] as const)('fails closed for %s', async (_case, fixture) => {
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, async () => fixture);
  await expect(client.inspectQueue(sha('b'))).rejects.toThrow();
});

it('bounds merge-queue reads with one overall deadline', async () => {
  vi.useFakeTimers();
  try {
    let aborts = 0;
    const run = async (_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { aborts++; reject(options.signal?.reason); }, { once: true });
    });
    const pending = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'), { timeoutMs: 25 });
    const outcome = pending.catch(error => error);
    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toMatchObject({ message: 'GitHub merge-queue inspection timed out.' });
    expect(aborts).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('preserves caller cancellation while reading merge-queue state', async () => {
  const controller = new AbortController();
  const run = async (_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('generic runner abort')), { once: true });
  });
  const pending = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, run).inspectQueue(sha('b'), { signal: controller.signal });
  controller.abort(new Error('closing queue watcher'));
  await expect(pending).rejects.toThrow('closing queue watcher');
});

it('discards a GraphQL response that resolves after caller cancellation', async () => {
  let release!: (value: string) => void;
  const response = new Promise<string>(resolve => { release = resolve; });
  const controller = new AbortController();
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 24 }, async () => response);
  const pending = client.inspectQueue(sha('b'), { signal: controller.signal });
  controller.abort(new Error('closing queue watcher'));
  release(queueFixture({ state: 'MERGED', mergedAt: '2026-09-24T08:10:00Z', mergeQueueEntry: null, timelineItems: { nodes: [] } }));
  await expect(pending).rejects.toThrow('closing queue watcher');
});

it.each([
  ['ruleset', [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test', integration_id: '10' }] } }], { strict: false, checks: [] }],
  ['classic', [], { strict: true, checks: [{ context: 'test' }] }],
] as const)('fails closed for an invalid %s check app identity', async (_source, rules, requiredStatusChecks) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', app: { databaseId: 10 } }] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([rules]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('aborts one shared status inspection at its overall deadline', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0, aborts = 0;
    const run = async (_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      calls++;
      options?.signal?.addEventListener('abort', () => { aborts++; reject(options.signal?.reason); }, { once: true });
    });
    const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
    const first = client.inspect(), second = client.inspect();
    const resultsPromise = Promise.allSettled([first, second]);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    const results = await resultsPromise;
    expect(results.every(result => result.status === 'rejected' && /timed out/i.test(String(result.reason)))).toBe(true);
    expect(aborts).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('preserves caller cancellation while reading merge status', async () => {
  const controller = new AbortController();
  const run = async (_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('generic runner abort')), { once: true });
  });
  const pending = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect({ fresh: true, signal: controller.signal });
  controller.abort(new Error('merge request deadline exceeded'));
  await expect(pending).rejects.toThrow('merge request deadline exceeded');
});

it.each([[false, true], [true, false]])('treats a protection 404 with protected=%s as rulesKnown=%s', async (protectedBranch, expectedKnown) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: protectedBranch });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(expectedKnown);
  expect(state.requiredChecks).toEqual([]);
});

it.each([['feature', 'found'], ['other-branch', 'found']] as const)('classifies a referenced PR on %s as %s', async (referencedBranch, expected) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) return JSON.stringify({ data: { repository: { p0: { state: 'OPEN', mergedAt: null, headRefName: referencedBranch } } } });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 7, pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }, { source: { issue: { number: 8, pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe(expected);
});

it('fails closed for a pull request reference from another repository', async () => {
  let graphReads = 0;
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) { graphReads++; return JSON.stringify({ data: { repository: {} } }); }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 7, pull_request: {}, repository_url: 'https://api.github.com/repos/other/repo' } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
  expect(graphReads).toBe(0);
});

it.each([{}, { state: 'CLOSED' }, { state: 'BOGUS', mergedAt: null }, { state: 'CLOSED', mergedAt: 42 }, { state: 'MERGED', mergedAt: null }, { state: 'OPEN', mergedAt: '2026-01-01' }, { state: 'CLOSED', mergedAt: '2026-01-01' }])('fails closed for malformed referenced PR data: %j', async referencedPull => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) return JSON.stringify({ data: { repository: { p0: referencedPull } } });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 8, pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it.each([false, 'required', []])('fails closed for malformed classic protection metadata: %j', async requiredStatusChecks => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('fails closed for a ruleset entry without a type', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{}]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: { strict: true, checks: [] } });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('does not treat empty strict check policies as an atomic base guard', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: { strict: true, checks: [], contexts: [] } });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state).toMatchObject({ rulesKnown: true, atomicBaseGuard: false, requiredChecks: [] });
});

it('fails closed when GraphQL returns referenced PR data with errors', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) return JSON.stringify({ data: { repository: { p0: { state: 'CLOSED', mergedAt: null } } }, errors: [{ message: 'partial' }] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 8, pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('does not let an inspection started before merge repopulate the cache', async () => {
  let pullReads = 0, releaseTimeline!: (value: string) => void, markTimelineStarted!: () => void;
  const timelineStarted = new Promise<void>(resolve => { markTimelineStarted = resolve; });
  const delayedTimeline = new Promise<string>(resolve => { releaseTimeline = resolve; });
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) { pullReads++; return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] }); }
    if (joined.startsWith('pr merge')) return '';
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline') && pullReads === 1) { markTimelineStarted(); return delayedTimeline; }
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
  const staleInspection = client.inspect();
  await timelineStarted;
  await client.merge(sha('b'));
  releaseTimeline(JSON.stringify([[]]));
  await staleInspection;
  await client.inspect();
  expect(pullReads).toBe(2);
});

it('blocks the already-fixed check instead of truncating more than 100 references', async () => {
  const references = Array.from({ length: 101 }, (_, index) => ({ source: { issue: { number: index + 8, pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }));
  let referencedViews = 0;
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('pr view')) { referencedViews++; return JSON.stringify({ state: 'CLOSED', mergedAt: null, headRefName: 'other' }); }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([references]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
  expect(referencedViews).toBe(0);
});

it('fails closed when a paginated timeline contains a malformed page', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([{ source: { issue: { number: 8, pull_request: {} } } }]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('fails closed when a timeline pull request reference has no valid number', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: '8', pull_request: {}, repository_url: 'https://api.github.com/repos/owner/repo' } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('fails closed when a timeline contains a non-object event', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[null]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('fails closed when a timeline contains an array event', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[[]]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it.each([
  { strict: true, checks: 'bad', contexts: [] },
  { strict: true, checks: [], contexts: ['test'] },
  { strict: true, checks: [{ context: 'test', app_id: null }], contexts: [] },
  { strict: 'true', checks: [], contexts: [] },
])('fails closed for inconsistent classic protection fields: %j', async requiredStatusChecks => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

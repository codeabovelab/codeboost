import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ReviewService } from '../runner/review.ts';
import { MergeCoordinator, MergeOutcomeUnknown } from '../runner/merge.ts';
import { MergeSubmissionError, type MergeGateway, type MergeQueueGateway, type MergeQueueObservation, type MergeResult, type RemoteMergeState } from '../github/merge.ts';
import { Store } from '../runner/store.ts';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import { fixtureGit } from './fixtures/git.ts';
import { RemoteTimeout } from '../github/timeout.ts';
import { CommandFailed } from '../github/run-with-input.ts';

// Issue #48: a queue inspection that started before a newer lifecycle transition must not have its result (or its
// failure) reported as the attempt's current state after that transition. Also: a refusal or timeout keeps its own
// reason across a later shutdown, a merge click's answer is inactive after a submission, and a timed-out trust read
// answers 503.

type ReviewView = ReturnType<ReviewService['load']>;
const sha = (digit: string) => digit.repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
  const store = new Store(':memory:');
  const plan = { schema_version: 1 as const, revision: 1, issue: 24, summary: 'Queue', questions: [], items: [{ id: 'P1', title: 'Queue', intent: 'Queue safely', files: [{ path: 'a', kind: 'edit' as const, renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check' as const, text: 'Works' }], depends_on: [] }] };
  const context = { identity, issue: 24, baseEntries: [{ path: 'a', kind: 'file' as const }], pathKey: (path: string) => path, allowedCommands: [] };
  store.createPlan(JSON.stringify(plan), 'json', context, sha('a'), sha('b'));
  const view = {
    items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
    plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: store.getSnapshot(identity).id, base: sha('a'), head: sha('b') }, token: 'review-token',
    expected: { revision: 1, snapshotId: store.getSnapshot(identity).id, reviewVersion: store.reviewVersion(identity) },
  } as unknown as ReviewView;
  const service = { store, config: { identity }, load: vi.fn(() => view) } as unknown as ReviewService;
  const remote = (): RemoteMergeState => ({ base: sha('a'), head: sha('b'), pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true,
    mergeQueue: true, requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false });
  // Each enqueue command and each queue inspection is held until the test settles it.
  const commands: Array<ReturnType<typeof deferred<MergeResult>>> = [];
  const inspections: Array<ReturnType<typeof deferred<MergeQueueObservation>>> = [];
  const signals: Array<AbortSignal | undefined> = [];
  let commandStarted = deferred<void>(), inspectionStarted = deferred<void>();
  const client: MergeGateway & MergeQueueGateway = {
    inspect: vi.fn(async () => remote()),
    queueWatermark: vi.fn(async () => 'CURSOR_before'),
    merge: vi.fn((_head: string, options?: { signal?: AbortSignal }) => {
      const command = deferred<MergeResult>(); commands.push(command); signals.push(options?.signal); commandStarted.resolve(); return command.promise;
    }),
    inspectQueue: vi.fn(() => { const inspection = deferred<MergeQueueObservation>(); inspections.push(inspection); inspectionStarted.resolve(); return inspection.promise; }),
  };
  return {
    store, identity, view, client, commands, inspections, signals, coordinator: new MergeCoordinator(service, client),
    async commandRunning() { await commandStarted.promise; commandStarted = deferred<void>(); },
    async inspectionRunning() { await inspectionStarted.promise; inspectionStarted = deferred<void>(); },
  };
}

it('reports the durable queued state when an inspection started during enqueue fails after the enqueue settled', async () => {
  const h = harness();
  try {
    const clickId = randomUUID();
    const merging = h.coordinator.merge(h.view.token, clickId);
    await h.commandRunning();
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting', actionId: clickId });

    // A poll (another tab, or the browser after a reload) starts its inspection while the enqueue is in flight.
    const earlyPoll = h.coordinator.pollQueue();
    await h.inspectionRunning();

    // The enqueue command completes: the attempt is durably queued.
    h.commands[0]!.resolve({ url: 'https://github.example/pr/7' });
    await merging;
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'queued', url: 'https://github.example/pr/7' });

    // A poll that arrives after the transition joins the inspection that started before it.
    const latePoll = h.coordinator.pollQueue();
    h.inspections[0]!.reject(new Error('GitHub queue status unavailable.'));

    const durable = h.store.getMergeAttempt(h.identity)!;
    expect(durable.state).toBe('queued');
    // Neither answer may regress the attempt to the pre-transition "submitting" snapshot the inspection captured.
    expect(await latePoll).toMatchObject({ state: durable.state, url: durable.url, observationError: 'GitHub queue status unavailable.' });
    expect(await earlyPoll).toMatchObject({ state: durable.state, url: durable.url });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('reports the retry attempt, not the superseded attempt, when an inspection started before the retry fails', async () => {
  const h = harness();
  try {
    const firstClick = randomUUID(), retryClick = randomUUID();
    const first = h.coordinator.merge(h.view.token, firstClick);
    await h.commandRunning();

    // An inspection for the first attempt starts while its enqueue command is in flight.
    const earlyPoll = h.coordinator.pollQueue();
    await h.inspectionRunning();

    // GitHub definitely refuses the first enqueue: the attempt fails and a retry becomes available.
    h.commands[0]!.reject(new MergeSubmissionError('Required review is missing.', 'refused',
      { cause: new CommandFailed('gh failed (exit 1): Required review is missing.', 'Required review is missing.', '') }));
    await expect(first).rejects.toThrow('Required review is missing.');
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'failed', actionId: firstClick });
    expect((await h.coordinator.status(h.view)).action).toBe('retry');

    // The retry starts a new attempt and GitHub accepts it.
    const retry = h.coordinator.merge(h.view.token, retryClick);
    await h.commandRunning();
    h.commands[1]!.resolve({ url: 'https://github.example/pr/7' });
    await retry;
    const current = h.store.getMergeAttempt(h.identity)!;
    expect(current).toMatchObject({ state: 'queued', actionId: retryClick });

    // A poll after the retry joins the first attempt's still-running inspection, which then fails.
    const latePoll = h.coordinator.pollQueue();
    h.inspections[0]!.reject(new Error('GitHub queue status unavailable.'));

    // The answer must describe the current attempt, not resurrect the superseded one as "submitting".
    // The failed read was of the superseded attempt, so its error is not attached to the retry.
    for (const answer of [await latePoll, await earlyPoll]) {
      expect(answer).toMatchObject({ state: 'queued', actionId: retryClick });
      expect(answer).not.toHaveProperty('observationError');
    }
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('control: a successful inspection started before the retry does not write to or report the superseded attempt', async () => {
  const h = harness();
  try {
    const firstClick = randomUUID(), retryClick = randomUUID();
    const first = h.coordinator.merge(h.view.token, firstClick);
    await h.commandRunning();
    const earlyPoll = h.coordinator.pollQueue();
    await h.inspectionRunning();
    h.commands[0]!.reject(new MergeSubmissionError('Required review is missing.', 'refused',
      { cause: new CommandFailed('gh failed (exit 1): Required review is missing.', 'Required review is missing.', '') }));
    await expect(first).rejects.toThrow();
    const retry = h.coordinator.merge(h.view.token, retryClick);
    await h.commandRunning();
    h.commands[1]!.resolve({ url: 'https://github.example/pr/7' });
    await retry;
    // The old inspection reports a removal; the store's id/state compare-and-set must refuse it for the new attempt.
    h.inspections[0]!.resolve({ state: 'removed', reviewedHead: sha('b'), removedAt: '2026-09-24T08:05:00Z', reason: 'Old removal.' });
    expect(await earlyPoll).toMatchObject({ state: 'queued', actionId: retryClick, reason: null });
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'queued', actionId: retryClick, reason: null });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('answers a refusal that gh printed before a later shutdown with GitHub\'s reason, as the attempt records', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID()).then(() => null, (error: unknown) => error as Error);
    await h.commandRunning();
    const closing = h.coordinator.close(); // Shutdown aborts after gh has already answered.
    h.commands[0]!.reject(new MergeSubmissionError('GraphQL: Head branch was modified. Review and try the merge again.', 'refused',
      { cause: new CommandFailed('gh failed (exit 1): GraphQL: Head branch was modified. Review and try the merge again.', '', '') }));
    const error = await merging;
    await closing;
    expect(error?.message).toMatch(/Head branch was modified/);
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/Head branch was modified/) });
  } finally { h.store.close(); }
});

it('answers a gh failure after admission that came before a later shutdown with gh\'s text, as an unknown outcome', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID()).then(() => null, (error: unknown) => error as Error);
    await h.commandRunning();
    const closing = h.coordinator.close();
    // gh exited with a failure that is not a refusal; its answer is delivered after the shutdown abort.
    h.commands[0]!.reject(new MergeSubmissionError('gh failed (exit 1): HTTP 502: Bad Gateway', 'unknown',
      { cause: new CommandFailed('gh failed (exit 1): HTTP 502: Bad Gateway', '', '') }));
    const error = await merging;
    await closing;
    expect(error).toBeInstanceOf(MergeOutcomeUnknown);
    expect(error?.message).toBe('gh failed (exit 1): HTTP 502: Bad Gateway');
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting' });
  } finally { h.store.close(); }
});

// Control: the old code also reported the abort here. It fails if GitHub's refusal exception is widened to every error.
it('reports the shutdown that stopped an admitted gh command, as an unknown outcome', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID()).then(() => null, (error: unknown) => error as Error);
    await h.commandRunning();
    const closing = h.coordinator.close();
    // gh was stopped by the coordinator's own abort and failed without a refusal: the abort is reported, not gh's text.
    // The message is synthetic on purpose: the real gateway would carry the abort's own text, which could not tell the two apart.
    h.commands[0]!.reject(new MergeSubmissionError('gh was stopped.', 'unknown', { cause: h.signals[0]!.reason }));
    const error = await merging;
    await closing;
    expect(error).toBeInstanceOf(MergeOutcomeUnknown);
    expect(error?.message).toBe('Merge cancelled during shutdown.');
    expect(h.store.getMergeAttempt(h.identity)).toMatchObject({ state: 'submitting' });
  } finally { h.store.close(); }
});

it('answers an unsaved refusal that gh printed before a later shutdown with GitHub\'s text, as an unknown outcome', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID()).then(() => null, (error: unknown) => error as Error);
    await h.commandRunning();
    vi.spyOn(h.store, 'finishMergeAttempt').mockImplementation(() => { throw new Error('disk full'); });
    const closing = h.coordinator.close();
    h.commands[0]!.reject(new MergeSubmissionError('GraphQL: Head branch was modified. Review and try the merge again.', 'refused',
      { cause: new CommandFailed('gh failed (exit 1): GraphQL: Head branch was modified. Review and try the merge again.', '', '') }));
    const error = await merging;
    await closing;
    // Not saved, so not definite: the attempt stays in flight, but the answer carries what GitHub said.
    expect(error).toBeInstanceOf(MergeOutcomeUnknown);
    expect(error?.message).toMatch(/Head branch was modified/);
  } finally { vi.restoreAllMocks(); h.store.close(); }
});

it('passes an unavailable status through a merge click\'s answer unchanged', () => {
  const h = harness();
  try {
    const unavailable = { available: true as const, ready: false as const, action: null, remote: null, queue: null,
      blockers: [{ code: 'refresh', message: 'Merge was submitted. Refresh to confirm GitHub state.' }] };
    expect(h.coordinator.statusAfterMerge(unavailable)).toBe(unavailable);
  } finally { h.store.close(); }
});

it('a queue read that gh answered keeps that answer when shutdown aborts it while the answer is delivered', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID());
    await h.commandRunning();
    h.commands[0]!.resolve({ url: 'https://github.example/pr/7' });
    await merging;
    const poll = h.coordinator.pollQueue().then(value => ({ value }), (error: unknown) => ({ error }));
    await h.inspectionRunning();
    const closing = h.coordinator.close();
    h.inspections[0]!.reject(new CommandFailed('gh failed (exit 1): HTTP 502: Bad Gateway', '', ''));
    const outcome = await poll;
    await closing;
    expect(outcome).toMatchObject({ value: { state: 'queued', observationError: 'gh failed (exit 1): HTTP 502: Bad Gateway' } });
  } finally { await h.coordinator.close(); h.store.close(); }
});

it('a queue read that timed out keeps its own reason when shutdown aborts it while gh stops', async () => {
  const h = harness();
  try {
    const merging = h.coordinator.merge(h.view.token, randomUUID());
    await h.commandRunning();
    h.commands[0]!.resolve({ url: 'https://github.example/pr/7' });
    await merging;
    const poll = h.coordinator.pollQueue().then(value => ({ value }), (error: unknown) => ({ error }));
    await h.inspectionRunning();
    // Shutdown aborts the poll; the inspection had already timed out and settles with its own reason afterwards.
    const closing = h.coordinator.close();
    h.inspections[0]!.reject(new RemoteTimeout('GitHub merge-queue inspection timed out.'));
    const outcome = await poll;
    await closing;
    expect(outcome).toMatchObject({ value: { state: 'queued', observationError: 'GitHub merge-queue inspection timed out.' } });
  } finally { await h.coordinator.close(); h.store.close(); }
});

/** A server over the demo task with every item approved, and one merge click ready to send (and resend). */
async function serveApproved(gateway: (app: () => Awaited<ReturnType<typeof startServer>>) => MergeGateway, options: { github?: boolean; issues?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-merge-'));
  const config = { ...createDemo(join(root, 'demo')), demo: false, ...options.github ? { github: { repository: 'owner/repo', issue: 3, pullRequest: 7 } } : {} };
  chmodSync(join(config.repository, 'run.sh'), 0o644); fixtureGit(config.repository, 'commit', '-am', 'Restore declared scope');
  let app!: Awaited<ReturnType<typeof startServer>>;
  app = await startServer(config, 0, undefined, gateway(() => app), undefined, options.issues as never);
  let view = app.service.load();
  for (const segment of view.segments.filter(value => value.row === 'Unplanned' || value.row === 'Ambiguous')) view = app.service.act({ action: 'accept', key: segment.key, token: view.token });
  for (const item of view.items) view = app.service.act({ action: 'approve', item: item.id, confirmNoChange: item.count === 0, token: view.token });
  const click = JSON.stringify({ action: 'merge', token: view.token, actionId: randomUUID() });
  const send = () => fetch(new URL('/api/action', app.url), { method: 'POST', headers: { 'x-codeboost-token': app.token, 'Content-Type': 'application/json' }, body: click });
  return { app, send, remove: () => rmSync(root, { recursive: true, force: true }) };
}
const remoteFor = (app: Awaited<ReturnType<typeof startServer>>, mergeQueue: boolean): RemoteMergeState => {
  const snapshot = app.service.load().snapshot;
  return { base: snapshot.base, head: snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue,
    requiredChecks: [], alreadyFixed: 'clear', pullRequest: 7, draft: false };
};

// Copilot's fifth concern ("Return inactive lifecycle status after successful enqueue", web/server.ts; fix 6 in the docs):
// a successful merge response reports the pre-command readiness next to the now-active attempt.
it.each([['queue enqueue', true, 'queued'], ['direct merge', false, 'merged']] as const)('answers a successful %s with an inactive lifecycle status', async (_kind, mergeQueue, state) => {
  const { app, send, remove } = await serveApproved(app => ({
    inspect: async () => remoteFor(app(), mergeQueue),
    queueWatermark: async () => null,
    merge: async () => ({ url: 'https://github.com/example/repo/pull/24' }),
    inspectQueue: async (head: string) => ({ state: 'queued', reviewedHead: head, entryId: 'MQE_1', phase: 'QUEUED', position: 1, enqueuedAt: '2026-09-24T08:00:00Z', queueHead: head }),
  }) as MergeGateway & MergeQueueGateway);
  try {
    type Body = { merge: { ready: boolean; action: string | null; blockers: Array<{ code: string }>; queue: { state: string } | null }; mergeQueue: { state: string } | null };
    const attemptBlockers = (body: Body) => body.merge.blockers.filter(blocker => ['queue-active', 'queue-merged', 'queue-head'].includes(blocker.code));
    const response = await send();
    const body = await response.json() as Body;
    expect(response.status).toBe(200);
    expect(body.mergeQueue?.state).toBe(state);
    expect(body.merge.queue?.state).toBe(state);
    // The attempt is active or merged: the same response must not also offer another merge.
    expect({ ready: body.merge.ready, action: body.merge.action }).toEqual({ ready: false, action: null });
    expect(attemptBlockers(body)).toHaveLength(1);
    // Control: a replay already answered from the current status before #48. It stays inactive, and the attempt's
    // blocker appears once (the filter in statusAfterMerge keeps it from appearing twice).
    const replay = await send();
    const again = await replay.json() as Body;
    expect(replay.status).toBe(200);
    expect({ ready: again.merge.ready, action: again.merge.action }).toEqual({ ready: false, action: null });
    expect(attemptBlockers(again)).toHaveLength(1);
  } finally { await app.close(); remove(); }
}, 60_000);

// The click's 14 s deadline aborts the trust refresh just before admission (here the first trust read answers at once; in
// production it settles within 12.75 s of its start); gh had already answered, and the read surfaces that answer after the abort.
it('answers a merge click whose issue-trust read gh answered before the merge deadline with that answer, saved', async () => {
  let readStarted!: () => void, reads = 0, slowNext = false;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const issues = {
    repository: 'owner/repo',
    async fetch() { return { repository: 'owner/repo', retrievedAt: new Date().toISOString(), issues: [] }; },
    // gh answered; the answer surfaces only after the caller's abort (the merge deadline).
    async issueAccess(number: number, options: { signal?: AbortSignal } = {}) {
      // The first read admits the click; the refresh before admission is held until the deadline aborts it.
      if (++reads === 1) { slowNext = true; return { number, authorLogin: 'member', collaborator: true }; }
      readStarted(); await new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true }));
      throw new CommandFailed('gh failed (exit 1): HTTP 404: Not Found', '', '');
    },
    async issueText(number: number) { return { number, title: '', body: '', comments: [] }; },
  };
  const { app, send, remove } = await serveApproved(app => ({
    // The first inspection after the click's first trust read takes 2.5 s, so the refresh starts late enough that its own
    // 12 s would end after the 14 s deadline: the deadline is what stops it, after gh had answered.
    inspect: async () => { if (slowNext) { slowNext = false; await new Promise(resolve => setTimeout(resolve, 2_500)); } return remoteFor(app(), false); },
    merge: async () => { throw new Error('The merge command must not run.'); },
  }), { github: true, issues });
  try {
    const answer = async (response: Response) => ({ status: response.status, error: (await response.json() as { error: string }).error });
    const expected = { status: 502, error: 'Issue trust could not be verified: gh failed (exit 1): HTTP 404: Not Found' };
    expect(await answer(await send())).toEqual(expected);
    await reading;
    // Saved: resending the same click replays the answer without reading trust again.
    expect(await answer(await send())).toEqual(expected);
    expect(reads).toBe(2);
  } finally { await app.close(); remove(); }
}, 60_000);

// The merge path reads the issue's trust before admission. A read that runs out of time is wrapped as an upstream
// failure; it must still answer "resend" (503) and leave nothing saved under the click's key.
it.each(['alone', 'before the merge deadline'] as const)('answers a merge click whose issue-trust read timed out (%s) with a resendable 503', async when => {
  let readStarted!: () => void, reads = 0, slowNext = false;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const issues = {
    repository: 'owner/repo',
    async fetch() { return { repository: 'owner/repo', retrievedAt: new Date().toISOString(), issues: [] }; },
    // Alone: the first read times out. Deadline case: the first read admits the click, and the refresh before admission
    // timed out on its own; that surfaces only after the click's 14 s deadline abort.
    async issueAccess(number: number, options: { signal?: AbortSignal } = {}) {
      if (when === 'before the merge deadline') {
        if (++reads % 2 === 1) { slowNext = true; return { number, authorLogin: 'member', collaborator: true }; }
        readStarted(); await new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true }));
      }
      throw new RemoteTimeout('Issue retrieval timed out.');
    },
    async issueText(number: number) { return { number, title: '', body: '', comments: [] }; },
  };
  const { app, send, remove } = await serveApproved(app => ({
    // In the deadline case the first inspection after each click's first trust read takes 1.6 s, so the refresh's own 12 s
    // ends at about 13.6 s, before the 14 s deadline, while gh is still stopping when the deadline fires.
    inspect: async () => {
      if (slowNext) { slowNext = false; await new Promise(resolve => setTimeout(resolve, 1_600)); }
      return remoteFor(app(), false);
    },
    merge: async () => { throw new Error('The merge command must not run.'); },
  }), { github: true, issues });
  try {
    const expected = { status: 503, error: 'Issue trust could not be verified: Issue retrieval timed out.' };
    const answer = async (response: Response) => ({ status: response.status, error: (await response.json() as { error: string }).error });
    for (const response of [await send(), await send()]) expect(await answer(response)).toEqual(expected);
    if (when !== 'alone') await reading;
  } finally { await app.close(); remove(); }
}, 60_000);

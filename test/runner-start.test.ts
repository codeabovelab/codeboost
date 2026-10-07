import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import { Store } from '../runner/store.ts';
import type { ReviewService } from '../runner/review.ts';
import type { RunnerDeps } from '../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../runner/execution.ts';
import type { AttemptKind } from '../runner/lifecycle.ts';
import { approveItem } from '../core/approvals.ts';
import type { IssueTrustGateway } from '../github/issues.ts';

vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const OWNER = 'c'.repeat(32);
type App = Awaited<ReturnType<typeof startServer>>;
/**
 * A server with a runner whose preparation always fails: an admitted item ends `failed` without an agent, which is
 * enough to see what start and resume admit. `before` shapes the Store before the runner exists, as recovery would.
 */
async function serve(options: { kinds?: AttemptKind[]; approve?: boolean; before?: (service: ReviewService) => void; findings?: (findings: SafetyFindings, service: ReviewService) => void;
  issueGateway?: IssueTrustGateway } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-start-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  const config = options.issueGateway ? { ...demo, demo: false, github: { repository: options.issueGateway.repository, issue: 3, pullRequest: 1 } } : demo;
  const app = await startServer(config, 0, undefined, undefined, 2_000, options.issueGateway, undefined, undefined, async service => {
    if (options.approve !== false) approvePlan(service);
    options.before?.(service);
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: options.kinds ?? ['execute'], prepare: async () => { throw new Error('no agent here'); },
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), checkpointContext: () => service.planContext(),
      issue: () => ({ number: 1, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
    const findings = new SafetyFindings(service.store);
    options.findings?.(findings, service);
    return { deps, sources, findings, recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  cleanups.push(close);
  return { app, close, database: demo.database, identity: demo.identity, store: app.service.store, items: app.service.store.getPlan(demo.identity).items.map(item => item.id) };
}
const view = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
async function act(app: App, action: string, request: { expectedStateVersion?: number; expectedReviewVersion?: number; actionId?: string } = {}) {
  const { stateVersion, reviewVersion } = await view(app);
  const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, expectedStateVersion: request.expectedStateVersion ?? stateVersion,
      expectedReviewVersion: request.expectedReviewVersion ?? reviewVersion, actionId: request.actionId ?? randomUUID() }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function approvePlan(service: ReviewService) {
  const view = service.load();
  service.store.saveReview(service.config.identity, view.expected,
    view.items.map(item => approveItem(view.plan, view.segments, item.id, service.config.identity, item.count === 0)), []);
}
function trustGateway(read: () => { authorLogin: string | null; collaborator: boolean } | Error): IssueTrustGateway {
  return {
    repository: 'owner/repo',
    async fetch() { return { repository: 'owner/repo', retrievedAt: new Date().toISOString(), issues: [] }; },
    async issueAccess(number) { const value = read(); if (value instanceof Error) throw value; return { number, ...value }; },
    async issueText(number) { return { number, title: '', body: '', comments: [] }; },
  };
}

/** Before the runner exists: queue the task and leave one execute attempt of its first item, failed. */
function failedFirstItem(service: ReviewService, budgetMs?: number) {
  const s = service.store, id = service.config.identity;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
    expectedContext: s.currentContext(id), deadline: Date.now() + 60_000, ...(budgetMs ? { budgetMs } : {}) });
  s.markRunning(id, attempt.id);
  s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 1, valid: false });
  return attempt;
}

/** Before the runner exists: as failedFirstItem, but the first item completed and made a runner commit. */
function committedFirstItem(service: ReviewService, unchanged = false, outOfScope: string[] = [], kind: AttemptKind = 'execute') {
  const s = service.store, id = service.config.identity;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  const item = s.getPlan(id).items[0]!.id, snapshot = s.getSnapshot(id), head = 'f'.repeat(40);
  const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind, item,
    expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
  s.markRunning(id, attempt.id);
  // As finish() returns it: an unchanged item makes no commit, so it has no history.
  if (unchanged) s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head: snapshot.head, unchanged: true, inScope: [], outOfScope: [] } });
  else s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head, unchanged: false, inScope: [], outOfScope },
    history: { base: snapshot.base, head, entries: [{ sha: head, owner: item, origin: 'owned', sourceSha: null }] } });
  return attempt.id;
}
/** Save a new plan revision, as a person editing the plan does. */
function revise(service: ReviewService) {
  const s = service.store, id = service.config.identity, plan = s.getPlan(id);
  s.importRevision(JSON.stringify({ ...plan, revision: plan.revision + 1, summary: `${plan.summary} (revised)` }), 'json', service.planContext(), plan.revision);
  const revised = s.getPlan(id), snapshot = s.getSnapshot(id);
  s.saveReview(id, { revision: revised.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
    revised.items.map(item => approveItem(revised, [], item.id, id, true)), []);
}

describe('start (#91 part 2)', () => {
  it('refuses an outside-authored issue until matching repository-scoped trust is recorded', async () => {
    const gateway = trustGateway(() => ({ authorLogin: 'outside', collaborator: false }));
    const { app, identity, store } = await serve({ issueGateway: gateway });
    expect((await act(app, 'start')).body.error).toMatch(/not trusted for its current author/i);
    expect(store.getAttempts(identity)).toEqual([]);
    store.setIssueTrust({ repository: 'owner/repo', issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    expect((await act(app, 'start')).body.result).toMatchObject({ outcome: 'started', item: 'P1' });
  });
  it('records and replays a failed or incomplete collaborator read as a definite upstream failure', async () => {
    let result: ReturnType<Parameters<typeof trustGateway>[0]> = new Error('incomplete collaborator page');
    const { app, identity, store } = await serve({ issueGateway: trustGateway(() => result) });
    const actionId = randomUUID();
    expect(await act(app, 'start', { actionId })).toMatchObject({ status: 502,
      body: { error: expect.stringMatching(/could not be verified.*incomplete collaborator page/i) } });
    result = { authorLogin: 'member', collaborator: true };
    expect(await act(app, 'start', { actionId })).toMatchObject({ status: 502,
      body: { error: expect.stringMatching(/could not be verified.*incomplete collaborator page/i) } });
    expect(store.getAttempts(identity)).toEqual([]);
  });
  it('returns the first durable success when an identical concurrent access read fails later', async () => {
    const secondStarted = Promise.withResolvers<void>(), releaseFailure = Promise.withResolvers<void>();
    let reads = 0;
    const gateway: IssueTrustGateway = {
      repository: 'owner/repo',
      async fetch() { return { repository: 'owner/repo', retrievedAt: new Date().toISOString(), issues: [] }; },
      async issueAccess(number) {
        if (++reads === 1) { await secondStarted.promise; return { number, authorLogin: 'member', collaborator: true }; }
        secondStarted.resolve(); await releaseFailure.promise; throw new Error('later GitHub failure');
      },
      async issueText(number) { return { number, title: '', body: '', comments: [] }; },
    };
    const { app, identity, store } = await serve({ issueGateway: gateway });
    const actionId = randomUUID(), first = act(app, 'start', { actionId });
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = act(app, 'start', { actionId });
    const accepted = await first;
    expect(accepted).toMatchObject({ status: 200, body: { result: { outcome: 'started', item: 'P1' } } });
    releaseFailure.resolve();
    expect(await second).toMatchObject({ status: 200, body: { result: accepted.body.result } });
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('requires every item of the current plan revision to be approved before start', async () => {
    const { app, identity, store } = await serve({ approve: false });
    expect(await view(app)).toMatchObject({ startable: false });
    expect((await act(app, 'start')).body.error).toMatch(/approve every plan item/i);
    expect(store.getAttempts(identity)).toEqual([]);
  });
  it('requires fresh current-snapshot approvals when the head moves before start', async () => {
    const { app, identity, store } = await serve();
    const snapshot = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: store.getPlan(identity).revision, snapshotId: snapshot.id,
      reviewVersion: store.reviewVersion(identity) }, snapshot.base, 'e'.repeat(40), []);
    expect(await view(app)).toMatchObject({ startable: false });
    expect((await act(app, 'start')).body.error).toMatch(/approve every plan item/i);
    expect(store.getAttempts(identity)).toEqual([]);
  });
  it('requires approvals recorded after a later attribution choice', async () => {
    const { app, identity, store } = await serve();
    const plan = store.getPlan(identity), snapshot = store.getSnapshot(identity);
    store.saveReview(identity, { revision: plan.revision, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) }, [],
      [{ key: 'later-choice', action: 'assign', item: plan.items[0]!.id }]);
    expect(await view(app)).toMatchObject({ startable: false });
    approvePlan(app.service);
    expect(await view(app)).toMatchObject({ startable: true });
  });
  it('moves a task in review to queued and admits its first item, in one action', async () => {
    const { app, identity, store, items } = await serve();
    expect(store.getTask(identity).status).toBe('in review');
    expect(await view(app)).toMatchObject({ startable: true, resumable: false });
    const started = await act(app, 'start');
    expect(started.body.result).toMatchObject({ outcome: 'started', item: items[0] });
    const [attempt] = store.getAttempts(identity);
    expect(attempt).toMatchObject({ id: started.body.result.attemptId, kind: 'execute', item: items[0] });
    await app.executor!.close();
    // The run ended with its first item (preparation fails here); nothing after it was started.
    expect(store.getAttempts(identity)).toHaveLength(1);
    expect(await view(app)).toMatchObject({ startable: false });
  });
  it('rolls the move to queued back when admission refuses the first item, and records the refusal', async () => {
    // Only earlier-revision attempts, the budget spent, and back in review: runChoice passes, so the action moves the
    // task to queued and admission itself refuses.
    const { app, identity, store } = await serve({ before: service => {
      failedFirstItem(service, 1); revise(service);
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'in review');
    } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const before = store.getTask(identity), attempts = store.getAttempts(identity).length, actionId = randomUUID();
    const queue = vi.spyOn(store, 'transitionTask');
    const refused = await act(app, 'start', { actionId });
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/time budget has run out/) } });
    expect(queue).toHaveBeenCalledWith(identity, before.stateVersion, 'queued');
    // The move rolled back with the refusal, so the budget's effect (idle running or queued only) left it in review.
    expect(store.getTask(identity)).toMatchObject({ status: 'in review', stateVersion: before.stateVersion });
    expect(store.getAttempts(identity)).toHaveLength(attempts);
    // Recorded: the same action ID replays the refusal.
    expect(await act(app, 'start', { actionId, expectedStateVersion: before.stateVersion })).toMatchObject({ status: 409, body: refused.body });
  });
  it('is refused once the plan has started, and resume runs a first item that failed again', async () => {
    const { app, identity, store, items } = await serve();
    await act(app, 'start'); await app.executor!.close();
    expect(store.getAttempts(identity)[0]!.state).toBe('failed');
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    expect((await act(app, 'start')).body.error).toMatch(/resume the task instead/);
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[0] });
  });
});

describe('status polling (#91 part 2)', () => {
  it('reads progress once per poll with a targeted query, never the full attempt history', async () => {
    const { app, store } = await serve({ before: service => { failedFirstItem(service); } });
    const history = vi.spyOn(store, 'getAttempts'), progress = vi.spyOn(store, 'executeProgress');
    expect(await view(app)).toMatchObject({ resumable: true });
    expect(history).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(1);
  });
});

describe('resume (#91 part 2)', () => {
  it('refuses an untrusted current author before resuming', async () => {
    const { app, identity, store } = await serve({ issueGateway: trustGateway(() => ({ authorLogin: 'outside', collaborator: false })),
      before: service => { failedFirstItem(service); } });
    expect((await act(app, 'resume')).body.error).toMatch(/not trusted for its current author/i);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('claims the requeue recovery left and continues from the first unfinished item', async () => {
    let interrupted = '';
    const { app, identity, store, items } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id);
      // What startup recovery does to an attempt a crash interrupted: failed "Interrupted", task requeued.
      s.recoverInterrupted(Date.now());
      interrupted = attempt.id;
    } });
    expect(store.getTask(identity).requeuePending).toBe(true);
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    const resumed = await act(app, 'resume');
    expect(resumed.body.result).toMatchObject({ outcome: 'started', item: items[0] });
    expect(store.getTask(identity).requeuePending).toBe(false);
    expect(store.getAttempts(identity).map(row => row.id)).toEqual([interrupted, resumed.body.result.attemptId]);
  });
  it('continues a task that stopped between items from the next item', async () => {
    const { app, identity, store, items } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id);
      // What a completed, unchanged item leaves (no commit, so no history).
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head: s.getSnapshot(id).head, unchanged: true, inScope: [], outOfScope: [] } });
    } });
    expect(store.getTask(identity).status).toBe('running');
    expect(await view(app)).toMatchObject({ resumable: true, startable: false });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[1] });
  });
  it('is refused when no item has run, which start handles instead', async () => {
    const { app } = await serve();
    expect((await act(app, 'resume')).body.error).toMatch(/start the task instead/);
  });
});

describe('start and resume refusals and races (#91 part 2)', () => {
  it('retains current-revision approvals over completed continuation items and starts the next suffix item', async () => {
    const { app, identity, store, items } = await serve({ before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id), itemIds = s.getPlan(id).items.map(item => item.id);
      const entries = [...service.planContext().baseEntries, { path: 'other.ts', kind: 'file' as const }];
      const checkpoint = s.recordCheckpoint(id, { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: itemIds[0]!, completedItems: [itemIds[0]!], outOfScopePaths: ['other.ts'], baseEntries: entries,
      });
      const amended = s.getPlan(id);
      amended.items[0]!.files.push({ path: 'other.ts', kind: 'add', renamed_from: null, change: 'Declare the observed file' });
      const context = { ...service.planContext(), baseEntries: entries };
      s.importRevision(JSON.stringify(amended), 'json', service.planContext(), 1);
      const next = s.getPlan(id);
      s.saveReview(id, { revision: next.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
        next.items.map(item => approveItem(next, [], item.id, id, true)), []);
      service.planContextAt = () => context;
      s.approveContinuation(id, checkpoint.id, { revision: next.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, context);
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: itemIds[1]!,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id);
      const committedHead = 'd'.repeat(40);
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
        result: { head: committedHead, unchanged: false, inScope: [], outOfScope: [] },
        history: { base: snapshot.base, head: committedHead, entries: [{ sha: committedHead, owner: itemIds[1]!, origin: 'owned', sourceSha: null }] } });
    } });
    expect(store.unapprovedExecutionItems(identity, store.getPlan(identity).revision)).toEqual([]);
    expect(await view(app)).toMatchObject({ resumable: true, continuation: { completedItems: [items[0], items[1]], next: items[2], approved: true } });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[2] });
    expect(store.getAttempts(identity).at(-1)?.item).toBe(items[2]);
  });
  it('does not skip a completed continuation item edited without changing its ID', async () => {
    let baseContext: ReturnType<ReviewService['planContext']> | undefined;
    const { identity, store } = await serve({ before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id), itemIds = s.getPlan(id).items.map(item => item.id);
      baseContext = service.planContext();
      // Keep the import context so the regression can restore the executed definition with different object-key order.
      const entries = [...baseContext.baseEntries, { path: 'other.ts', kind: 'file' as const }];
      const checkpoint = s.recordCheckpoint(id, { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: itemIds[0]!, completedItems: [itemIds[0]!], outOfScopePaths: ['other.ts'], baseEntries: entries,
      });
      const amended = s.getPlan(id);
      amended.items[0]!.files.push({ path: 'other.ts', kind: 'add', renamed_from: null, change: 'Declare the observed file' });
      const context = { ...service.planContext(), baseEntries: entries };
      s.importRevision(JSON.stringify(amended), 'json', baseContext, 1);
      const next = s.getPlan(id);
      s.saveReview(id, { revision: next.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
        next.items.map(item => approveItem(next, [], item.id, id, true)), []);
      service.planContextAt = () => context;
      s.approveContinuation(id, checkpoint.id, { revision: next.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, context);
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: itemIds[1]!,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id);
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
        result: { head: snapshot.head, unchanged: true, inScope: [], outOfScope: [] } });
      const changed = s.getPlan(id);
      changed.items[1]!.intent += ' (revised after execution)';
      expect(() => s.importRevision(JSON.stringify(changed), 'json', baseContext!, next.revision))
        .toThrow(/Completed item P2 changed after it ran/);
      expect(s.getPlan(id).revision).toBe(next.revision);
    } });
    const restored = store.getPlan(identity), item = restored.items[1]!;
    restored.items[1] = { acceptance: item.acceptance, files: item.files, id: item.id, title: item.title, intent: item.intent, depends_on: item.depends_on };
    store.importRevision(JSON.stringify(restored), 'json', baseContext!, store.getPlan(identity).revision);
    expect(store.continuationProgress(identity)).toMatchObject({ completed: ['P1', 'P2'], next: 'P3' });
  });
  it('requires explicit continuation approval and resumes at the audited suffix through the API', async () => {
    const gateway = trustGateway(() => ({ authorLogin: 'outside', collaborator: false }));
    const { app, identity, store, items } = await serve({ issueGateway: gateway, before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id);
      const entries = [...service.planContext().baseEntries, { path: 'other.ts', kind: 'file' as const }];
      s.pauseForAmendment(id, { revision: 1, snapshotId: snapshot.id }, {
        item: s.getPlan(id).items[0]!.id, completedItems: [s.getPlan(id).items[0]!.id], outOfScopePaths: ['other.ts'], baseEntries: entries,
      });
      const amended = s.getPlan(id);
      amended.items[0]!.files.push({ path: 'other.ts', kind: 'add', renamed_from: null, change: 'Declare the observed file' });
      s.importRevision(JSON.stringify(amended), 'json', service.planContext(), 1);
      const next = s.getPlan(id);
      s.saveReview(id, { revision: next.revision, snapshotId: s.getSnapshot(id).id, reviewVersion: s.reviewVersion(id) },
        next.items.map(item => approveItem(next, [], item.id, id, true)), []);
      const baseContext = service.planContext();
      service.planContextAt = () => ({ ...baseContext, baseEntries: entries });
      s.setIssueTrust({ repository: gateway.repository, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    } });
    expect(await view(app)).toMatchObject({ resumable: false, startable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/Approve the amended plan continuation/);
    store.setIssueTrust({ repository: gateway.repository, issue: 3, authorLogin: 'outside', trusted: false, trustedBy: 'local user' });
    expect((await act(app, 'approve-continuation')).body.error).toMatch(/not trusted/);
    store.setIssueTrust({ repository: gateway.repository, issue: 3, authorLogin: 'outside', trusted: true, trustedBy: 'local user' });
    const approved = await act(app, 'approve-continuation');
    expect(approved).toMatchObject({ status: 200, body: { result: { outcome: 'approved', next: items[1] } } });
    expect(store.getTask(identity).status).toBe('queued');
    expect(await view(app)).toMatchObject({ resumable: true, startable: false });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[1] });
    expect(store.getAttempts(identity).map(row => row.item)).toEqual([items[0], items[1]]);
  });
  it('guards start with the review version as well as the task state version', async () => {
    const { app, identity, store } = await serve();
    const before = await view(app);
    store.addReviewNote(identity, { revision: store.getPlan(identity).revision, snapshotId: store.getSnapshot(identity).id,
      reviewVersion: before.reviewVersion }, store.getPlan(identity).items[0]!.id, 'question', 'Changed after the runner view.');
    expect((await act(app, 'start', { expectedStateVersion: before.stateVersion, expectedReviewVersion: before.reviewVersion })).body.error)
      .toMatch(/Stale review state/);
    expect(store.getAttempts(identity)).toEqual([]);
  });
  it('resumes a revised plan from its first item when the earlier revision committed nothing', async () => {
    const { app, identity, store, items } = await serve({ before: service => { failedFirstItem(service); revise(service); } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[0] });
    expect(store.getAttempts(identity).at(-1)!.context.planRevision).toBe(store.getPlan(identity).revision);
  });
  it('does not count an earlier item that completed unchanged as a commit, and reruns it at the new revision', async () => {
    const { app, identity, store, items } = await serve({ before: service => { committedFirstItem(service, true); revise(service); } });
    expect(await view(app)).toMatchObject({ resumable: true, startable: false });
    // Completed at the earlier revision only: the new revision still starts at its first item.
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[0] });
    expect(store.getAttempts(identity).at(-1)!.context.planRevision).toBe(store.getPlan(identity).revision);
  });
  it('lets a task whose only attempts were at an earlier, uncommitted revision start again from review', async () => {
    const { app, identity, store, items } = await serve({ before: service => {
      failedFirstItem(service); revise(service);
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'in review');
    } });
    expect(await view(app)).toMatchObject({ startable: true, resumable: false });
    expect((await act(app, 'start')).body.result).toMatchObject({ outcome: 'started', item: items[0] });
    expect(store.getAttempts(identity).at(-1)!.context.planRevision).toBe(store.getPlan(identity).revision);
  });
  it('offers a queued task with only earlier-revision attempts both actions, which run the same item', async () => {
    for (const action of ['start', 'resume']) {
      const { app, items } = await serve({ before: service => {
        failedFirstItem(service); revise(service);
        const s = service.store, id = service.config.identity;
        s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      } });
      expect(await view(app)).toMatchObject({ startable: true, resumable: true });
      expect((await act(app, action)).body.result).toMatchObject({ outcome: 'started', item: items[0] });
    }
  });
  it('refuses both, in the view and the action alike, once an earlier revision left commits (#88)', async () => {
    const { app } = await serve({ before: service => { committedFirstItem(service); revise(service); } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/plan changed after runner commits without a scope checkpoint/);
    expect((await act(app, 'start')).body.error).toMatch(/plan changed after runner commits without a scope checkpoint/);
  });
  it('counts a fix attempt\'s commit at an earlier revision too (#88)', async () => {
    const { app } = await serve({ before: service => { committedFirstItem(service, false, [], 'fix'); revise(service); } });
    expect((await act(app, 'start')).body.error).toMatch(/plan changed after runner commits without a scope checkpoint/);
  });
  it('lets admission refuse a spent budget, which moves the idle task to needs human; the view offers nothing', async () => {
    const { app, identity, store } = await serve({ before: service => { failedFirstItem(service, 1); } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await view(app)).toMatchObject({ resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/time budget has run out/);
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('points start to resume for a running task whose only attempts were at an earlier revision', async () => {
    const { app } = await serve({ before: service => { failedFirstItem(service); revise(service); } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    expect((await act(app, 'start')).body.error).toMatch(/resume the task instead/);
  });
  it('names the status when a task that never ran is not running or queued, rather than pointing to start', async () => {
    const { app } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
    } });
    expect((await act(app, 'resume')).body.error).toMatch(/The task is needs human; resume continues a task that is running or queued/);
    expect((await act(app, 'start')).body.error).toMatch(/The task is needs human; start runs a task that is in review or queued/);
  });
  it('does not point start to resume once every item has run', async () => {
    const { app } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      for (const { id: item } of s.getPlan(id).items) {
        const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item,
          expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
        s.markRunning(id, attempt.id);
        s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head: s.getSnapshot(id).head, unchanged: true, inScope: [], outOfScope: [] } });
      }
    } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: false });
    expect((await act(app, 'start')).body.error).toMatch(/The task is running; start runs a task that is in review or queued/);
    expect((await act(app, 'resume')).body.error).toMatch(/Every item of this plan has run/);
  });
  it('clears a recovery requeue when an amended suffix removes the interrupted final item', async () => {
    const { app, identity, store } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      const plan = s.getPlan(id), firstTwo = plan.items.slice(0, 2).map(item => item.id), firstSnapshot = s.getSnapshot(id);
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      for (const item of plan.items.slice(0, 2)) {
        const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: item.id,
          expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
        s.markRunning(id, attempt.id);
        const last = item.id === firstTwo[0];
        s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true,
          result: { head: firstSnapshot.head, unchanged: true, inScope: [], outOfScope: last ? ['extra.ts'] : [] } });
        if (last) {
          const entries = [...service.planContext().baseEntries, { path: 'extra.ts', kind: 'file' as const }];
          const checkpoint = s.recordCheckpoint(id, { revision: plan.revision, snapshotId: firstSnapshot.id, reviewVersion: s.reviewVersion(id) }, {
            item: item.id, completedItems: [item.id], outOfScopePaths: ['extra.ts'], baseEntries: entries,
          });
          const amended = s.getPlan(id);
          amended.items[0]!.files.push({ path: 'extra.ts', kind: 'add', renamed_from: null, change: 'Declare observed output' });
          s.importRevision(JSON.stringify({ ...amended, revision: amended.revision + 1 }), 'json', service.planContext(), amended.revision);
          const current = s.getPlan(id), snapshot = s.getSnapshot(id);
          approvePlan(service);
          const checkpointContext = { ...service.planContext(), baseEntries: checkpoint.baseEntries };
          service.planContextAt = () => ({ ...checkpointContext, baseEntries: entries });
          s.approveContinuation(id, checkpoint.id, { revision: current.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
            { ...checkpointContext, baseEntries: entries });
        } else if (item.id === firstTwo[1]) {
          // The preceding checkpoint is approved; this is continuation work P2.
        }
      }
      const p3 = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: 'P3',
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, p3.id); s.recoverInterrupted(Date.now());
      const checkpoint = s.latestCheckpoint(id)!, amended = s.getPlan(id);
      amended.items = amended.items.slice(0, 2);
      s.importRevision(JSON.stringify({ ...amended, revision: amended.revision + 1 }), 'json', service.planContext(), amended.revision);
      const current = s.getPlan(id), snapshot = s.getSnapshot(id);
      approvePlan(service);
      const entries = checkpoint.baseEntries;
      const checkpointContext = { ...service.planContext(), baseEntries: checkpoint.baseEntries };
      service.planContextAt = () => ({ ...checkpointContext, baseEntries: entries });
      s.approveContinuation(id, checkpoint.id, { revision: current.revision, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) },
        { ...checkpointContext, baseEntries: entries });
    } });
    expect(store.getTask(identity).requeuePending).toBe(false);
    expect((await act(app, 'resume')).body.error).toMatch(/Every item of this plan has run/);
  });
  it('neither offers nor admits start or resume while a run of the task is still finishing between items', async () => {
    const { app, identity, store } = await serve({ before: service => { failedFirstItem(service); } });
    expect(await view(app)).toMatchObject({ resumable: true });
    // Between two items no attempt is active; only the executor knows its run is still going.
    vi.spyOn(app.executor!, 'busy').mockReturnValue(true);
    expect(app.runner!.isActive(identity)).toBe(false);
    expect(await view(app)).toMatchObject({ startable: false, resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/still finishing; try again when that run has ended/);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('points resume to start for a task in review whose only attempts were at an earlier, uncommitted revision', async () => {
    const { app } = await serve({ before: service => {
      failedFirstItem(service); revise(service);
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'in review');
    } });
    expect((await act(app, 'resume')).body.error).toMatch(/start the task instead/);
  });
  it('names the status, not resume, when start is refused for a task resume cannot run either', async () => {
    const { app } = await serve({ before: service => {
      failedFirstItem(service);
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
    } });
    expect((await act(app, 'start')).body.error).toMatch(/The task is needs human; start runs a task that is in review or queued/);
  });
  it('does not offer start when the runner cannot run execute attempts', async () => {
    const { app } = await serve({ kinds: ['review'] });
    expect(await view(app)).toMatchObject({ startable: false });
  });
  it('acts on a safety finding owed from an earlier run instead of admitting, and reports it settled', async () => {
    let earlier = '', held!: SafetyFindings;
    const { app, identity, store } = await serve({ before: service => { earlier = failedFirstItem(service).id; },
      findings: (findings, service) => {
        held = findings;
        // The durable save failed, so the finding is held only in memory: the executor owes the move to needs human.
        const save = service.store.recordSafetyFinding;
        service.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
        findings.record(earlier, 'Safety violation: test');
        service.store.recordSafetyFinding = save;
      } });
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toHaveLength(1);
    // The escalation committed, so the finding is no longer owed.
    expect(held.get(earlier)).toBeUndefined();
  });
  it('acts on owed safety work before a scope-pause refusal', async () => {
    let earlier = '';
    const { app, identity, store } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      committedFirstItem(service, false, ['other.ts']);
      const attempt = s.getAttempts(id)[0]!;
      s.pauseForAmendment(id, { revision: attempt.context.planRevision, snapshotId: s.getSnapshot(id).id }, {
        item: attempt.item!, completedItems: [attempt.item!], baseEntries: [], outOfScopePaths: ['other.ts'],
      });
      earlier = attempt.id;
    }, findings: (findings, service) => {
      const save = service.store.recordSafetyFinding;
      service.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
      findings.record(earlier, 'Safety violation: held after the pause');
      service.store.recordSafetyFinding = save;
    } });
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(store.getAttempt(identity, earlier).safetyFinding).toMatch(/held after the pause/);
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs human');
  });
  it('persists owed safety work before active-merge and pending-cancel refusals', async () => {
    for (const blocker of ['merge', 'cancel'] as const) {
      let earlier = '';
      const { app, identity, store } = await serve({ before: service => {
        const s = service.store, id = service.config.identity;
        if (blocker === 'merge') {
          earlier = failedFirstItem(service).id;
          s.transitionTask(id, s.getTask(id).stateVersion, 'in review');
          const snapshot = s.getSnapshot(id);
          s.beginMergeAttempt(id, { revision: s.getPlan(id).revision, snapshotId: snapshot.id,
            reviewVersion: s.reviewVersion(id) }, snapshot.head, null, 'direct');
        } else {
          s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
          const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
            expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
          s.markRunning(id, attempt.id); s.cancelTask(id, s.getTask(id).stateVersion, randomUUID()); earlier = attempt.id;
        }
      }, findings: (findings, service) => {
        const save = service.store.recordSafetyFinding;
        service.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
        findings.record(earlier, `Safety violation: ${blocker}`); service.store.recordSafetyFinding = save;
      } });
      expect((await act(app, blocker === 'merge' ? 'start' : 'resume')).body.result).toEqual({ outcome: 'settled' });
      expect(store.getAttempt(identity, earlier).safetyFinding).toMatch(new RegExp(blocker));
    }
  });
  it('clears a recovery requeue when owed work settles without admitting an attempt', async () => {
    let interrupted = '';
    const { app, identity, store } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
      const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item: s.getPlan(id).items[0]!.id,
        expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, attempt.id); s.recoverInterrupted(Date.now()); interrupted = attempt.id;
    }, findings: (findings, service) => {
      const save = service.store.recordSafetyFinding;
      service.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
      findings.record(interrupted, 'Safety violation: recovered'); service.store.recordSafetyFinding = save;
    } });
    expect(store.getTask(identity).requeuePending).toBe(true);
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    expect((await act(app, 'start')).body.error).toMatch(/recovery left this task to requeue/i);
    expect(store.getTask(identity).requeuePending).toBe(true);
    expect(store.getAttempt(identity, interrupted).safetyFinding).toBeNull();
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity)).toMatchObject({ status: 'needs human', requeuePending: false });
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('refuses resume when the completed prefix no longer ends at the current task head', async () => {
    const { app, identity, store } = await serve({ before: service => { committedFirstItem(service); } });
    const snapshot = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: store.getPlan(identity).revision, snapshotId: snapshot.id,
      reviewVersion: store.reviewVersion(identity) }, snapshot.base, 'e'.repeat(40), []);
    expect(await view(app)).toMatchObject({ resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/completed plan prefix.*current task head/i);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('inherits approvals only from snapshots used by the completed execution prefix', async () => {
    const inherited = await serve({ before: service => { committedFirstItem(service); } });
    expect(await view(inherited.app)).toMatchObject({ resumable: true });

    const returned = await serve({ before: service => { committedFirstItem(service, true); } });
    const { app, identity, store } = returned, atA = store.getSnapshot(identity);
    store.recordHistory(identity, { revision: 1, snapshotId: atA.id, reviewVersion: store.reviewVersion(identity) },
      atA.base, 'e'.repeat(40), []);
    const atB = store.getSnapshot(identity);
    expect(atB.head).toBe('e'.repeat(40));
    const approvals = store.getReview(identity).approvals.map(({ item, fingerprint }) => ({ item, fingerprint }));
    store.saveReview(identity, { revision: 1, snapshotId: atB.id, reviewVersion: store.reviewVersion(identity) }, approvals, []);
    expect(store.getReview(identity).approvals).toHaveLength(store.getPlan(identity).items.length);
    expect(store.getReview(identity).approvals.every(approval => approval.snapshotId === atB.id)).toBe(true);
    store.recordHistory(identity, { revision: 1, snapshotId: atB.id, reviewVersion: store.reviewVersion(identity) },
      atA.base, atA.head, []);
    expect(await view(app)).toMatchObject({ resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/approve every plan item/i);
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('pauses for an amendment owed from an earlier run instead of admitting, and reports it settled', async () => {
    const { app, identity, store } = await serve({ before: service => { committedFirstItem(service, false, ['other.ts']); } });
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(store.latestCheckpoint(identity)).toMatchObject({ item: store.getPlan(identity).items[0]!.id });
    expect(store.getAttempts(identity)).toHaveLength(1);
    expect(await view(app)).toMatchObject({ startable: false, resumable: false });
  });
  it('does not offer scope-only owed work from a state where the pause cannot be recorded', async () => {
    for (const blocker of ['human', 'merge'] as const) {
      const { app, identity, store } = await serve({ before: service => {
        committedFirstItem(service, false, ['other.ts']);
        const s = service.store, id = service.config.identity;
        s.transitionTask(id, s.getTask(id).stateVersion, blocker === 'human' ? 'needs human' : 'in review');
        if (blocker === 'merge') {
          const snapshot = s.getSnapshot(id);
          s.beginMergeAttempt(id, { revision: s.getPlan(id).revision, snapshotId: snapshot.id,
            reviewVersion: s.reviewVersion(id) }, snapshot.head, null, 'direct');
        }
      } });
      expect(await view(app), blocker).toMatchObject({ startable: false, resumable: false });
      expect((await act(app, 'resume')).status, blocker).toBe(409);
      expect(store.latestCheckpoint(identity), blocker).toBeNull();
    }
  });
  it('acts on an owed safety finding before moving a task in review to queued', async () => {
    let earlier = '';
    const { app, identity, store } = await serve({ before: service => {
      earlier = failedFirstItem(service).id; revise(service);
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'in review');
    }, findings: (findings, service) => {
      const save = service.store.recordSafetyFinding;
      service.store.recordSafetyFinding = () => { throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }); };
      findings.record(earlier, 'Safety violation: test');
      service.store.recordSafetyFinding = save;
    } });
    const before = store.getTask(identity).stateVersion, moves = vi.spyOn(store, 'transitionTask');
    expect((await act(app, 'start')).body.result).toEqual({ outcome: 'settled' });
    expect(moves).not.toHaveBeenCalled();
    expect(store.getTask(identity)).toMatchObject({ status: 'needs human', stateVersion: before + 1 });
    expect(store.getAttempts(identity)).toHaveLength(1);
  });
  it('settles owed safety evidence before continuation reconciliation can refuse resume', async () => {
    let earlier = '';
    const { app, identity, store } = await serve({ before: service => {
      earlier = committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id), plan = s.getPlan(id);
      s.recordCheckpoint(id, { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: plan.items[0]!.id, completedItems: [plan.items[0]!.id], outOfScopePaths: ['other.ts'],
        baseEntries: [...service.planContext().baseEntries, { path: 'other.ts', kind: 'file' }],
      });
    }, findings: findings => findings.record(earlier, 'Safety violation: checkpoint reconciliation regression') });
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)[0]!.safetyFinding).toMatch(/checkpoint reconciliation regression/);
  });
  it('records an owed later scope pause before continuation reconciliation', async () => {
    const { app, identity, store, items } = await serve({ before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, firstSnapshot = s.getSnapshot(id), baseContext = service.planContext();
      const entries = [...baseContext.baseEntries, { path: 'other.ts', kind: 'file' as const }];
      const firstItem = s.getPlan(id).items[0]!.id;
      const checkpoint = s.recordCheckpoint(id, { revision: 1, snapshotId: firstSnapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: firstItem, completedItems: [firstItem], outOfScopePaths: ['other.ts'], baseEntries: entries,
      });
      const amended = s.getPlan(id);
      amended.items[0]!.files.push({ path: 'other.ts', kind: 'add', renamed_from: null, change: 'Declare the first observed path' });
      s.importRevision(JSON.stringify(amended), 'json', baseContext, 1);
      const current = s.getPlan(id), reviewSnapshot = s.getSnapshot(id);
      s.saveReview(id, { revision: current.revision, snapshotId: reviewSnapshot.id, reviewVersion: s.reviewVersion(id) },
        current.items.map(item => approveItem(current, [], item.id, id, true)), []);
      service.planContextAt = () => ({ ...baseContext, baseEntries: entries });
      s.approveContinuation(id, checkpoint.id, { revision: current.revision, snapshotId: reviewSnapshot.id, reviewVersion: s.reviewVersion(id) },
        { ...baseContext, baseEntries: entries });
      const before = s.getSnapshot(id), second = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute',
        item: current.items[1]!.id, expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
      s.markRunning(id, second.id);
      const head = 'd'.repeat(40);
      s.settleAttempt(id, second.id, { firstReason: null, exitCode: 0, valid: true,
        result: { head, unchanged: false, inScope: [], outOfScope: ['later.ts'] },
        history: { base: before.base, head, entries: [{ sha: head, owner: current.items[1]!.id, origin: 'owned', sourceSha: null }] } });
    } });
    expect((await act(app, 'resume')).body.result).toEqual({ outcome: 'settled' });
    expect(store.getTask(identity).status).toBe('needs amendment');
    expect(store.latestCheckpoint(identity)).toMatchObject({ item: items[1], completedItems: items.slice(0, 2), outOfScopePaths: ['later.ts'] });
  });
  it('replays an action ID, and refuses a second resume made against the old state', async () => {
    const { app, identity, store } = await serve({ before: service => { failedFirstItem(service); } });
    const { stateVersion } = await view(app), actionId = randomUUID();
    const first = await act(app, 'resume', { expectedStateVersion: stateVersion, actionId });
    // The saved outcome comes back; the runner view beside it is current, so it is not compared.
    expect((await act(app, 'resume', { expectedStateVersion: stateVersion, actionId })).body.result).toEqual(first.body.result);
    expect((await act(app, 'resume', { expectedStateVersion: stateVersion })).body.error).toMatch(/Stale task state/);
    expect(store.getAttempts(identity)).toHaveLength(2);
  });
  it('replays a pre-review-version action, but never creates a new action without the review version', async () => {
    const actionId = randomUUID(); let stateVersion = 0;
    const { app, identity, store } = await serve({ before: service => {
      const s = service.store, id = service.config.identity; stateVersion = s.getTask(id).stateVersion;
      s.userAction(id, { actionId, kind: 'start', request: { attemptId: undefined, expectedStateVersion: stateVersion } },
        () => ({ outcome: 'settled' }));
    } });
    const post = async (id: string) => {
      const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST',
        headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', expectedStateVersion: stateVersion, actionId: id }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    expect(await post(actionId)).toMatchObject({ status: 200, body: { result: { outcome: 'settled' } } });
    expect(await post(randomUUID())).toMatchObject({ status: 400, body: { error: expect.stringMatching(/expectedReviewVersion/) } });
    expect(store.getAttempts(identity)).toEqual([]);
  });
  it('answers 503 to a start whose body finishes arriving after shutdown began, before any refusal, and records nothing', async () => {
    // A task start would refuse: during shutdown the 503 still comes first, so no refusal is saved under the action ID.
    const { app, close, database, identity } = await serve({ before: service => {
      const s = service.store, id = service.config.identity;
      s.transitionTask(id, s.getTask(id).stateVersion, 'needs human');
    } });
    const { stateVersion, reviewVersion } = await view(app), actionId = randomUUID(), url = new URL(app.url);
    const text = JSON.stringify({ action: 'start', expectedStateVersion: stateVersion, expectedReviewVersion: reviewVersion, actionId });
    let finish!: () => void;
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/runner', method: 'POST',
        headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write(text.slice(0, 5));
      finish = () => req.end(text.slice(5));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = close();
    await new Promise(resolve => setTimeout(resolve, 20));
    finish();
    expect(await response).toBe(503);
    await closing;
    const store = new Store(database); cleanups.push(() => store.close());
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempts(identity)).toEqual([]);
    expect(store.savedAction(identity, { actionId, kind: 'start', request: { attemptId: undefined, expectedStateVersion: stateVersion,
      expectedReviewVersion: reviewVersion } })).toBeUndefined();
  });
  it('answers 503 to a start once the runner stopped admission, and leaves the task in review', async () => {
    const { app, identity, store } = await serve();
    // Shutdown step 1 for the runner, with the HTTP server still open: the request reaches the action itself.
    app.runner!.rejectAdmission();
    const actionId = randomUUID();
    const refused = await act(app, 'start', { actionId });
    expect(refused.status).toBe(503);
    expect(store.getTask(identity).status).toBe('in review');
    expect(store.getAttempts(identity)).toEqual([]);
    // Not recorded: the same action ID is refused afresh (503 again), never replayed as a saved refusal.
    expect((await act(app, 'start', { actionId })).status).toBe(503);
  });
  it('keeps continuation approval retryable once the runner stopped admission', async () => {
    const { app, identity, store } = await serve({ before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id);
      s.recordCheckpoint(id, { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: s.getPlan(id).items[0]!.id, completedItems: [s.getPlan(id).items[0]!.id], outOfScopePaths: ['other.ts'],
        baseEntries: [...service.planContext().baseEntries, { path: 'other.ts', kind: 'file' }],
      });
    } });
    const { stateVersion, reviewVersion } = await view(app), actionId = randomUUID();
    app.runner!.rejectAdmission();
    expect(await act(app, 'approve-continuation', { actionId })).toMatchObject({ status: 503 });
    expect(store.savedAction(identity, { actionId, kind: 'approve-continuation', request: {
      attemptId: undefined, expectedStateVersion: stateVersion, expectedReviewVersion: reviewVersion,
    } })).toBeUndefined();
  });
  it('answers 503 to a stale continuation approval whose body finishes arriving after shutdown began, without saving the action refusal', async () => {
    const { app, close, database, identity } = await serve({ before: service => {
      committedFirstItem(service, false, ['other.ts']);
      const s = service.store, id = service.config.identity, snapshot = s.getSnapshot(id);
      s.recordCheckpoint(id, { revision: 1, snapshotId: snapshot.id, reviewVersion: s.reviewVersion(id) }, {
        item: s.getPlan(id).items[0]!.id, completedItems: [s.getPlan(id).items[0]!.id], outOfScopePaths: ['other.ts'],
        baseEntries: [...service.planContext().baseEntries, { path: 'other.ts', kind: 'file' }],
      });
    } });
    const current = await view(app), stateVersion = current.stateVersion - 1, reviewVersion = current.reviewVersion - 1;
    const actionId = randomUUID(), url = new URL(app.url);
    const text = JSON.stringify({ action: 'approve-continuation', expectedStateVersion: stateVersion, expectedReviewVersion: reviewVersion, actionId });
    let finish!: () => void;
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/runner', method: 'POST',
        headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write(text.slice(0, 5));
      finish = () => req.end(text.slice(5));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = close();
    await new Promise(resolve => setTimeout(resolve, 20));
    finish();
    expect(await response).toBe(503);
    await closing;
    const store = new Store(database); cleanups.push(() => store.close());
    expect(store.savedAction(identity, { actionId, kind: 'approve-continuation', request: {
      attemptId: undefined, expectedStateVersion: stateVersion, expectedReviewVersion: reviewVersion,
    } })).toBeUndefined();
  });
  it('keeps a continuation approval retryable during shutdown when no runner is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-no-runner-')); roots.push(root);
    const demo = createDemo(join(root, 'demo'));
    const app = await startServer({ ...demo, demo: false }, 0, undefined, undefined, 2_000);
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    cleanups.push(close);
    const { stateVersion, reviewVersion } = await view(app), actionId = randomUUID(), url = new URL(app.url);
    const text = JSON.stringify({ action: 'approve-continuation', expectedStateVersion: stateVersion,
      expectedReviewVersion: reviewVersion, actionId });
    let finish!: () => void;
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/runner', method: 'POST',
        headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write(text.slice(0, 5));
      finish = () => req.end(text.slice(5));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = close();
    await new Promise(resolve => setTimeout(resolve, 20));
    finish();
    expect(await response).toBe(503);
    await closing;
    const store = new Store(demo.database); cleanups.push(() => store.close());
    expect(store.savedAction(demo.identity, { actionId, kind: 'approve-continuation', request: {
      attemptId: undefined, expectedStateVersion: stateVersion, expectedReviewVersion: reviewVersion,
    } })).toBeUndefined();
  });
});

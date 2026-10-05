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
async function serve(options: { kinds?: AttemptKind[]; approve?: boolean; before?: (service: ReviewService) => void; findings?: (findings: SafetyFindings, service: ReviewService) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-start-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
    if (options.approve !== false) approvePlan(service);
    options.before?.(service);
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: options.kinds ?? ['execute'], prepare: async () => { throw new Error('no agent here'); },
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), issue: () => ({ number: 1, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
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
    expect((await act(app, 'resume')).body.error).toMatch(/revised after items of it were committed.*#88/);
    expect((await act(app, 'start')).body.error).toMatch(/revised after items of it were committed.*#88/);
  });
  it('counts a fix attempt\'s commit at an earlier revision too (#88)', async () => {
    const { app } = await serve({ before: service => { committedFirstItem(service, false, [], 'fix'); revise(service); } });
    expect((await act(app, 'start')).body.error).toMatch(/revised after items of it were committed.*#88/);
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
    expect(store.getTask(identity).status).toBe('needs human');
    expect(store.getAttempt(identity, earlier).safetyFinding).toMatch(/held after the pause/);
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
});

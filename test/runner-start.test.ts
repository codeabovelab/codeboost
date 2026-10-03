import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { startServer } from '../web/server.ts';
import type { ReviewService } from '../runner/review.ts';
import type { RunnerDeps } from '../runner/coordinator.ts';
import { SafetyFindings, type ExecutionSources } from '../runner/execution.ts';
import type { AttemptKind } from '../runner/lifecycle.ts';

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
async function serve(options: { kinds?: AttemptKind[]; before?: (service: ReviewService) => void; findings?: (findings: SafetyFindings, service: ReviewService) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-start-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
    options.before?.(service);
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: options.kinds ?? ['execute'], prepare: async () => { throw new Error('no agent here'); },
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), issue: () => ({ number: 1, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
    const findings = new SafetyFindings(service.store);
    options.findings?.(findings, service);
    return { deps, sources, findings, recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  });
  cleanups.push(() => app.close());
  return { app, identity: demo.identity, store: app.service.store, items: app.service.store.getPlan(demo.identity).items.map(item => item.id) };
}
const view = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
async function act(app: App, action: string, request: { expectedStateVersion?: number; actionId?: string } = {}) {
  const { stateVersion } = await view(app);
  const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, expectedStateVersion: request.expectedStateVersion ?? stateVersion, actionId: request.actionId ?? randomUUID() }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
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
function committedFirstItem(service: ReviewService) {
  const s = service.store, id = service.config.identity;
  s.transitionTask(id, s.getTask(id).stateVersion, 'queued');
  const item = s.getPlan(id).items[0]!.id, snapshot = s.getSnapshot(id), head = 'f'.repeat(40);
  const attempt = s.admitAttempt(id, { expectedStateVersion: s.getTask(id).stateVersion, kind: 'execute', item,
    expectedContext: s.currentContext(id), deadline: Date.now() + 60_000 });
  s.markRunning(id, attempt.id);
  s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, result: { head, unchanged: false, inScope: [], outOfScope: [] },
    history: { base: snapshot.base, head, entries: [{ sha: head, owner: item, origin: 'owned', sourceSha: null }] } });
}
/** Save a new plan revision, as a person editing the plan does. */
function revise(service: ReviewService) {
  const s = service.store, id = service.config.identity, plan = s.getPlan(id);
  s.importRevision(JSON.stringify({ ...plan, revision: plan.revision + 1, summary: `${plan.summary} (revised)` }), 'json', service.planContext(), plan.revision);
}

describe('start (#91 part 2)', () => {
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
  it('rolls the move to queued back when the first item is refused, and records the refusal', async () => {
    const { app, identity, store } = await serve({ kinds: ['review'] });
    const before = store.getTask(identity);
    const refused = await act(app, 'start');
    expect(refused).toMatchObject({ status: 409, body: { error: 'The runner cannot run execute attempts yet.' } });
    expect(store.getTask(identity)).toMatchObject({ status: 'in review', stateVersion: before.stateVersion });
    expect(store.getAttempts(identity)).toEqual([]);
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
  it('resumes a revised plan from its first item when the earlier revision committed nothing', async () => {
    const { app, identity, store, items } = await serve({ before: service => { failedFirstItem(service); revise(service); } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: true });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[0] });
    expect(store.getAttempts(identity).at(-1)!.context.planRevision).toBe(store.getPlan(identity).revision);
  });
  it('refuses both, in the view and the action alike, once an earlier revision left commits (#88)', async () => {
    const { app } = await serve({ before: service => { committedFirstItem(service); revise(service); } });
    expect(await view(app)).toMatchObject({ startable: false, resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/revised after items of it were committed.*#88/);
    expect((await act(app, 'start')).body.error).toMatch(/revised after items of it were committed.*#88/);
  });
  it('lets admission refuse a spent budget, which moves the idle task to needs human; the view offers nothing', async () => {
    const { app, identity, store } = await serve({ before: service => { failedFirstItem(service, 1); } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await view(app)).toMatchObject({ resumable: false });
    expect((await act(app, 'resume')).body.error).toMatch(/time budget has run out/);
    expect(store.getTask(identity).status).toBe('needs human');
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
  it('replays an action ID, and refuses a second resume made against the old state', async () => {
    const { app, identity, store } = await serve({ before: service => { failedFirstItem(service); } });
    const { stateVersion } = await view(app), actionId = randomUUID();
    const first = await act(app, 'resume', { expectedStateVersion: stateVersion, actionId });
    // The saved outcome comes back; the runner view beside it is current, so it is not compared.
    expect((await act(app, 'resume', { expectedStateVersion: stateVersion, actionId })).body.result).toEqual(first.body.result);
    expect((await act(app, 'resume', { expectedStateVersion: stateVersion })).body.error).toMatch(/Stale task state/);
    expect(store.getAttempts(identity)).toHaveLength(2);
  });
  it('answers 503 to a start admitted after the runner stopped admission, and rolls the queue move back', async () => {
    const { app, identity, store } = await serve();
    // Shutdown step 1 for the runner, with the HTTP server still open: the request reaches the action itself.
    app.runner!.rejectAdmission();
    const refused = await act(app, 'start');
    expect(refused.status).toBe(503);
    expect(store.getTask(identity).status).toBe('in review');
    expect(store.getAttempts(identity)).toEqual([]);
  });
});

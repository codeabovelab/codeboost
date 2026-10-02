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
async function serve(options: { kinds?: AttemptKind[]; before?: (service: ReviewService) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-start-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  const app = await startServer({ ...demo }, 0, undefined, undefined, 2_000, undefined, undefined, undefined, async service => {
    options.before?.(service);
    const deps: RunnerDeps = { runnerOwner: OWNER, kinds: options.kinds ?? ['execute'], prepare: async () => { throw new Error('no agent here'); },
      cleanupPreparation: async () => undefined, start: () => { throw new Error('no agent here'); }, validate: () => null };
    const sources: ExecutionSources = { planContext: () => service.planContext(), issue: () => ({ number: 1, title: '', body: '', comments: [] }), lessons: () => [], vendor: () => 'claude' };
    return { deps, sources, findings: new SafetyFindings(service.store), recovery: { finalized: [], requeue: [], removedDirectories: [], unknownEntries: [], unmatchedStorage: [], repairedMerges: [] } };
  });
  cleanups.push(() => app.close());
  return { app, identity: demo.identity, store: app.service.store, items: app.service.store.getPlan(demo.identity).items.map(item => item.id) };
}
const view = async (app: App) => (await fetch(`${new URL(app.url).origin}/api/runner`, { headers: { 'x-codeboost-token': app.token } })).json() as Promise<Record<string, any>>;
async function act(app: App, action: string) {
  const { stateVersion } = await view(app);
  const response = await fetch(`${new URL(app.url).origin}/api/runner`, { method: 'POST', headers: { 'x-codeboost-token': app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, expectedStateVersion: stateVersion, actionId: randomUUID() }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
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
      s.settleAttempt(id, attempt.id, { firstReason: null, exitCode: 0, valid: true, value: { head: s.getSnapshot(id).head, unchanged: true, inScope: [], outOfScope: [] } } as never);
    } });
    if (items.length < 2) return expect((await act(app, 'resume')).body.error).toMatch(/Every item/);
    expect(store.getTask(identity).status).toBe('running');
    expect(await view(app)).toMatchObject({ resumable: true, startable: false });
    expect((await act(app, 'resume')).body.result).toMatchObject({ outcome: 'started', item: items[1] });
  });
  it('is refused when no item has run, which start handles instead', async () => {
    const { app } = await serve();
    expect((await act(app, 'resume')).body.error).toMatch(/start the task instead/);
  });
});

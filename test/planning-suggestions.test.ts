import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../runner/store.ts';
import { SuggestionCoordinator, type SuggestionInput } from '../core/planning-suggestions.ts';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import type { EditReply, Plan } from '../core/plan.ts';

const plan = (): Plan => ({ schema_version: 1, issue: 1, revision: 1, summary: 'Example', questions: [],
  items: [{ id: 'P1', title: 'Change', intent: 'Improve', files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'Change' }],
    acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] });
const input = (): SuggestionInput => ({ context: { identity: { repositoryId: 'repo', taskId: 'task', planId: 'plan' },
  issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] },
  revision: 1, repo: { name: 'repo', baseRef: 'main', baseSha: 'a'.repeat(40), paths: ['a'] },
  issue: { number: 1, title: 'Fix', body: '', comments: [] }, approvedLessons: [], feedback: '' });
const reply = (): EditReply => ({ schema_version: 1, base_revision: 1, reply: 'Suggestion', edits: [{ op: 'set_field',
  item: 'P1', summary: 'Rename', reason: 'Clearer', field: 'title', value: 'Updated', file: null, check: null,
  check_index: null, depends_on: null, new_item: null }] });
function deferred() {
  let resolve!: (value: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture(provider?: AuthorProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'planning-suggestions-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.sqlite')); cleanup.push(() => store.close());
  const value = input(), identity = value.context.identity;
  store.createPlan(JSON.stringify(plan()), 'json', value.context, value.repo.baseSha, 'b'.repeat(40));
  const pending = deferred(), calls: { request: AuthorRequest; signal: AbortSignal }[] = [];
  const coordinator = new SuggestionCoordinator(store, provider ?? { invoke(request, signal) { calls.push({ request, signal }); return pending.promise; } }, 100);
  return { store, value, identity, pending, calls, coordinator };
}
it('binds the store request before invocation and publishes only valid replies', async () => {
  const f = fixture(); const handle = f.coordinator.start(f.value);
  expect(f.store.getSuggestions(f.identity, handle.id).state).toBe('pending');
  await Promise.resolve(); expect(f.calls[0]!.request.requestId).toBe(handle.id);
  expect(f.calls[0]!.request.identity).toEqual(f.identity);
  f.pending.resolve(JSON.stringify(reply()));
  expect(await handle.result).toMatchObject({ state: 'completed' });
  expect(f.store.getSuggestions(f.identity, handle.id).state).toBe('ready');
  handle.cancel(); expect(f.store.getSuggestions(f.identity, handle.id).state).toBe('ready');
  expect(f.store.applySuggestion(f.identity, handle.id, 0, f.value.context).revision).toBe(2);
  expect(() => f.store.applySuggestion(f.identity, handle.id, 0, f.value.context)).toThrow(/unavailable/);
  await f.coordinator.close();
});
it('rejects late completion after import in both outcome and durable state', async () => {
  const f = fixture(), handle = f.coordinator.start(f.value); await Promise.resolve();
  f.store.importRevision(JSON.stringify({ ...plan(), summary: 'New user draft' }), 'json', f.value.context, 1);
  f.pending.resolve(JSON.stringify(reply()));
  expect(await handle.result).toMatchObject({ state: 'stale' });
  expect(f.store.getSuggestions(f.identity, handle.id)).toMatchObject({ state: 'invalidated', reply: null });
  expect(f.store.getPlan(f.identity)).toMatchObject({ revision: 2, summary: 'New user draft' });
  await f.coordinator.close();
});
it('rejects a changed snapshot even if the plan revision is unchanged', async () => {
  const f = fixture(), handle = f.coordinator.start(f.value); await Promise.resolve();
  f.store.recordHistory(f.identity, { revision: 1, snapshotId: f.store.getSnapshot(f.identity).id }, 'a'.repeat(40), 'c'.repeat(40), []);
  f.pending.resolve(JSON.stringify(reply()));
  expect(await handle.result).toMatchObject({ state: 'stale' });
  expect(f.store.getSuggestions(f.identity, handle.id)).toMatchObject({ state: 'cancelled', reply: null });
  expect(f.store.getPlan(f.identity).revision).toBe(1);
  await f.coordinator.close();
});
it('retains ownership after timeout until provider termination, even across clock jumps', async () => {
  vi.useFakeTimers(); const f = fixture(), handle = f.coordinator.start(f.value); await Promise.resolve();
  let settled = false; void handle.result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.calls[0]!.signal.aborted).toBe(true);
  expect(f.calls[0]!.signal.reason.message).toBe('Suggestion invocation timed out.');
  expect(f.store.getSuggestions(f.identity, handle.id).state).toBe('cancelled');
  expect(settled).toBe(false);
  vi.setSystemTime(new Date('2099-01-01'));
  expect(() => f.coordinator.start(f.value)).toThrow(/still active/);
  handle.cancel('Later user cancellation');
  f.pending.reject(new Error('Generic abort'));
  expect(await handle.result).toMatchObject({ state: 'failed', reason: 'Suggestion invocation timed out.' });
  expect(f.store.getSuggestions(f.identity, handle.id).reply).toBeNull();
  await f.coordinator.close();
});
it('keeps a cancelled invocation active and preserves its first reason', async () => {
  const f = fixture(), handle = f.coordinator.start(f.value); await Promise.resolve();
  handle.cancel('Stop this request'); handle.cancel('Ignored reason');
  expect(() => f.coordinator.start(f.value)).toThrow(/still active/);
  f.pending.resolve(JSON.stringify(reply()));
  expect(await handle.result).toMatchObject({ state: 'cancelled', reason: 'Stop this request' });
  expect(f.store.getSuggestions(f.identity, handle.id)).toMatchObject({ state: 'cancelled', reply: null });
  const retry = f.coordinator.start(f.value);
  expect(retry.id).not.toBe(handle.id); expect((await retry.result).state).toBe('completed');
  await f.coordinator.close();
});
it('closes admission first, aborts all jobs and waits for unsettled providers before closing Store', async () => {
  const f = fixture(), first = f.coordinator.start(f.value);
  const other = input(); other.context.identity.planId = 'other';
  f.store.createPlan(JSON.stringify(plan()), 'json', other.context, 'a'.repeat(40), 'b'.repeat(40));
  const second = f.coordinator.start(other); await Promise.resolve();
  let closed = false; const closing = f.coordinator.close(); void closing.then(() => { closed = true; });
  expect(f.coordinator.close()).toBe(closing);
  expect(() => f.coordinator.start(f.value)).toThrow(/closing/);
  expect(f.calls.every(call => call.signal.aborted)).toBe(true);
  await Promise.resolve(); expect(closed).toBe(false);
  f.pending.reject(new Error('Provider abort'));
  for (const job of [first, second]) expect(await job.result).toMatchObject({ state: 'cancelled', reason: 'Suggestion coordinator is closing.' });
  await closing; expect(closed).toBe(true);
  expect(f.store.getSuggestions(f.identity, first.id).state).toBe('cancelled');
  expect(f.store.getSuggestions(other.context.identity, second.id).state).toBe('cancelled');
});
it('cancels before launch without invoking the provider', async () => {
  const f = fixture(), handle = f.coordinator.start(f.value); handle.cancel();
  expect((await handle.result).state).toBe('cancelled'); expect(f.calls).toHaveLength(0);
  expect(f.store.getSuggestions(f.identity, handle.id).state).toBe('cancelled');
  await f.coordinator.close();
});
it('does not publish externally cancelled requests', async () => {
  const f = fixture(), handle = f.coordinator.start(f.value); await Promise.resolve();
  f.store.cancelSuggestions(f.identity, handle.id); f.pending.resolve(JSON.stringify(reply()));
  expect((await handle.result).state).toBe('cancelled');
  expect(f.store.getSuggestions(f.identity, handle.id).reply).toBeNull();
  await f.coordinator.close();
});
it.each(['{}', '{"schema_version":1,"base_revision":2,"reply":"late","edits":[]}'])('fails malformed or stale output without making it applicable: %s', async output => {
  const f = fixture(), handle = f.coordinator.start(f.value); f.pending.resolve(output);
  expect((await handle.result).state).toBe('failed');
  expect(f.store.getSuggestions(f.identity, handle.id)).toMatchObject({ state: 'cancelled', reply: null });
  expect(f.store.getPlan(f.identity).revision).toBe(1); await f.coordinator.close();
});
it('captures caller input before edits or navigation and cannot target another plan', async () => {
  const f = fixture(), identity = { ...f.identity }, handle = f.coordinator.start(f.value);
  f.value.context.identity.planId = 'other'; f.value.revision = 2; f.value.issue.body = 'edited composer';
  f.value.context.baseEntries = []; f.pending.resolve(JSON.stringify(reply()));
  expect((await handle.result).state).toBe('completed');
  expect(f.calls[0]!.request.identity).toEqual(identity);
  expect(f.calls[0]!.request.prompt).not.toContain('edited composer');
  expect(f.store.getSuggestions(identity, handle.id).state).toBe('ready');
  expect(() => f.store.getSuggestions(f.value.context.identity, handle.id)).toThrow(/Unknown/);
  await f.coordinator.close();
});
it('preserves provider errors and permits a new attempt only after rejection settles', async () => {
  const f = fixture({ invoke() { throw new Error('Vendor quota exhausted'); } });
  const first = f.coordinator.start(f.value);
  expect(await first.result).toMatchObject({ state: 'failed', reason: 'Vendor quota exhausted' });
  expect(f.store.getSuggestions(f.identity, first.id).state).toBe('cancelled');
  const second = f.coordinator.start(f.value); expect(second.id).not.toBe(first.id);
  await second.result; await f.coordinator.close();
});
it('rejects invalid admission before allocating a request or calling the provider', async () => {
  const f = fixture(); const begin = vi.spyOn(f.store, 'beginSuggestions');
  expect(() => f.coordinator.start({ ...f.value, revision: 2 })).toThrow(/Stale/);
  f.value.repo.baseSha = 'c'.repeat(40); expect(() => f.coordinator.start(f.value)).toThrow(/snapshot/);
  f.value.repo.baseSha = 'a'.repeat(40); f.value.feedback = '\0';
  expect(() => f.coordinator.start(f.value)).toThrow(/NUL/);
  expect(begin).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); await f.coordinator.close();
});

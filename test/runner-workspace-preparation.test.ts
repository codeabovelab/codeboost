import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Plan, PlanContext } from '../core/plan.ts';

// Every spawn throws synchronously, as Node does for ENOMEM: no child, so no process group is ever recorded.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (() => { throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' }); }) as typeof actual.spawn };
});
const { Store } = await import('../runner/store.ts');
const { createTaskWorkspace } = await import('../runner/workspace.ts');

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'S', questions: [], items: [{ id: 'P1', title: 'T', intent: 'I',
  files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'x' }], acceptance: [{ type: 'check', text: 'ok' }], depends_on: [] }] };
const oid = (n: number) => n.toString(16).padStart(40, '0');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('clears the preparation marker when no subprocess ever started, so the next startup is not blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-prep-')); dirs.push(dir);
  const store = new Store(join(dir, 'state.sqlite'));
  try {
    store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
      expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    const workspace = createTaskWorkspace({ store, runnerRoot: join(dir, 'runner'), runnerOwner: '0123456789abcdef0123456789abcdef',
      repository: { path: join(dir, 'repo.git'), source: join(dir, 'source') }, imageId: `sha256:${'a'.repeat(64)}`,
      limits: { workBytes: 1, workInodes: 1, metadataBytes: 1, metadataInodes: 1 }, committer: { name: 'c', email: 'c@e' } });
    await expect(workspace.materialize(attempt, oid(2), new AbortController().signal)).rejects.toThrow();
    // Neither "starting" nor a group: startup recovery has nothing to ask a person about.
    expect(store.unownedPreparations()).toEqual([]);
    expect(store.interruptedAttempts()[0]).toMatchObject({ preparationStartedAt: null, preparationPgid: null });
  } finally { store.close(); }
});

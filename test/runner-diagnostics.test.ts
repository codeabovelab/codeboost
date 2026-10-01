import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plan, PlanContext } from '../core/plan.ts';
import { retain, saveDiagnostic } from '../runner/diagnostics.ts';
import { Store } from '../runner/store.ts';

const identity = { repositoryId: 'repo', taskId: 'task', planId: 'plan' };
const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
const plan: Plan = { schema_version: 1, revision: 1, issue: 1, summary: 'S', questions: [], items: [{ id: 'P1', title: 'T', intent: 'I',
  files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'x' }], acceptance: [{ type: 'check', text: 'ok' }], depends_on: [] }] };
const oid = (n: number) => n.toString(16).padStart(40, '0');
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'diagnostics-')); dirs.push(root);
  const store = new Store(join(root, 'state.sqlite')); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, oid(1), oid(2));
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const directory = join(root, 'diagnostics'); mkdirSync(directory, { mode: 0o700 });
  /** A settled failed attempt that references `bytes` as its partial output, written `age` seconds ago. */
  const failed = (bytes: number, age: number) => {
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1',
      expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    store.markRunning(identity, attempt.id);
    const path = saveDiagnostic(store, directory, attempt.id, Buffer.alloc(bytes), 1e9);
    const when = Date.now() / 1000 - age; utimesSync(path, when, when);
    store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false, detail: 'crashed', diagnosticRef: path });
    return { id: attempt.id, path };
  };
  return { store, directory, failed };
}

describe('partial-output retention', () => {
  it('writes owner-only through a temporary file, leaving only the named file', () => {
    const { directory, failed } = setup();
    const { path } = failed(10, 0);
    expect(readdirSync(directory)).toEqual([path.split('/').at(-1)]);
  });

  it('deletes unreferenced files first, oldest first, and never one a row still references', () => {
    const { store, directory, failed } = setup();
    const kept = failed(40, 300);
    const orphan = join(directory, '0b6d3e2a-1c4f-4a7e-9b2d-5f8e6c1a3b9d.diff'); writeFileSync(orphan, Buffer.alloc(40));
    const old = Date.now() / 1000 - 600; utimesSync(orphan, old, old);
    retain(store, directory, 50);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    expect(store.getAttempt(identity, kept.id).diagnosticRef).toBe(kept.path);
  });

  it('past the cap, clears the oldest reference and notes it before deleting its file', () => {
    const { store, directory, failed } = setup();
    const first = failed(40, 300), second = failed(40, 100);
    retain(store, directory, 50);
    expect(existsSync(first.path)).toBe(false);
    expect(store.getAttempt(identity, first.id)).toMatchObject({ diagnosticRef: null, diagnostic: 'crashed (partial output removed by retention)' });
    // The newer one fits under the cap and keeps its reference.
    expect(existsSync(second.path)).toBe(true);
    expect(store.getAttempt(identity, second.id).diagnosticRef).toBe(second.path);
    // No row points at a missing file.
    for (const ref of store.referencedDiagnostics()) expect(existsSync(ref)).toBe(true);
  });

  it('never removes the file it just saved, even over the cap', () => {
    const { store, directory } = setup();
    const id = 'c3a1b2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const path = saveDiagnostic(store, directory, id, Buffer.alloc(100), 10);
    expect(existsSync(path)).toBe(true);
  });
});

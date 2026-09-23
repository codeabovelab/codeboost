import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { importPlan, applySuggestion, assertEditReply, type Plan, type PlanContext, type EditReply } from '../core/plan.ts';
import type { Approval, SegmentChoice } from '../core/approvals.ts';

export function requireSupportedNode(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if (!major || major < 26 || (major === 26 && (minor ?? 0) < 7))
    throw new Error('codeboost requires Node 26.7.0 or later. Upgrade Node before opening the store.');
}
export interface Snapshot { id: string; base: string; head: string }
export interface ReviewState { revision: number; snapshotId: string }
export interface LedgerEntry { sha: string; owner: string | null; origin: 'owned' | 'foreign'; sourceSha: string | null }
export interface Checkpoint {
  id: string; revision: number; snapshotId: string; item: string;
  /** Runner-audited actual tree, retained separately from the declared plan. */
  baseEntries: PlanContext['baseEntries']; completedItems: string[]; outOfScopePaths: string[];
}
const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(value: unknown): T => JSON.parse(value as string) as T;
function sha(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Expected a full Git object ID.');
}

/** Trusted runner API, not a web/model API. The database handle never escapes this module.
 * Callers supply audited Git data and actual checkout path identity; no audit is inferred here.
 */
export class Store {
  #db: DatabaseSync;
  constructor(path: string) {
    requireSupportedNode();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#transaction(() => {
        const version = this.#get('PRAGMA user_version')!.user_version;
        if (version !== 0 && version !== 1) throw new Error('Unsupported store schema version.');
        if (version === 1) return;
        this.#db.exec(`
          CREATE TABLE plans (key TEXT PRIMARY KEY, issue INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_id TEXT);
          CREATE TABLE revisions (key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,revision));
          CREATE TABLE snapshots (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          CREATE TABLE requests (id TEXT PRIMARY KEY, key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, state TEXT NOT NULL, reply TEXT);
          CREATE TABLE ledger (key TEXT NOT NULL REFERENCES plans(key), sha TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,sha));
          CREATE TABLE rewrites (key TEXT NOT NULL REFERENCES plans(key), snapshot_id TEXT NOT NULL, old_sha TEXT NOT NULL, new_sha TEXT NOT NULL, PRIMARY KEY(key,snapshot_id,old_sha));
          CREATE TABLE approvals (key TEXT NOT NULL REFERENCES plans(key), item TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,item));
          CREATE TABLE choices (key TEXT NOT NULL REFERENCES plans(key), choice_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,choice_key));
          CREATE TABLE checkpoints (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          CREATE TABLE continuations (key TEXT NOT NULL REFERENCES plans(key), checkpoint_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(key,checkpoint_id));
          PRAGMA user_version=1;
        `);
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  #get(sql: string, ...args: SQLInputValue[]) { return this.#db.prepare(sql).get(...args); }
  #run(sql: string, ...args: SQLInputValue[]) { return this.#db.prepare(sql).run(...args); }
  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #current(key: string) {
    const row = this.#get('SELECT * FROM plans WHERE key=?', key);
    if (!row) throw new Error('Unknown plan identity.');
    return row;
  }
  #expect(key: string, expected: ReviewState): void {
    const row = this.#current(key);
    if (row.revision !== expected.revision || row.snapshot_id !== expected.snapshotId) throw new Error('Stale review state. Reload before writing.');
  }
  #context(key: string, context: PlanContext): void {
    if (identityKey(context.identity) !== key || context.issue !== this.#current(key).issue) throw new Error('Plan context identity/issue mismatch.');
  }
  #savePlan(key: string, plan: Plan, expected: number): void {
    if (this.#run('UPDATE plans SET revision=? WHERE key=? AND revision=?', plan.revision, key, expected).changes !== 1) throw new Error('Stale plan revision.');
    this.#run('INSERT INTO revisions VALUES (?,?,?)', key, plan.revision, encode(plan));
    this.#run("UPDATE requests SET state='invalidated' WHERE key=? AND state IN ('pending','ready')", key);
  }
  createPlan(source: string | Uint8Array, format: 'json' | 'yaml', context: PlanContext, base: string, head: string): Plan {
    sha(base); sha(head);
    const key = identityKey(context.identity), plan = importPlan(source, format, context, 1).plan;
    return this.#transaction(() => {
      this.#run('INSERT INTO plans VALUES (?,?,?,NULL)', key, plan.issue, 0);
      this.#savePlan(key, plan, 0);
      this.#snapshot(key, base, head);
      return plan;
    });
  }
  getPlan(identity: PlanIdentity, revision?: number): Plan {
    const key = identityKey(identity), current = this.#current(key);
    const row = this.#get('SELECT data FROM revisions WHERE key=? AND revision=?', key, revision ?? current.revision!);
    if (!row) throw new Error('Unknown plan revision.');
    return decode<Plan>(row.data);
  }
  importRevision(source: string | Uint8Array, format: 'json' | 'yaml', context: PlanContext, expected: number): Plan {
    const key = identityKey(context.identity);
    return this.#transaction(() => {
      this.#context(key, context);
      if (this.#current(key).revision !== expected) throw new Error('Stale plan revision.');
      const plan = importPlan(source, format, context, expected + 1).plan;
      this.#savePlan(key, plan, expected); return plan;
    });
  }
  #snapshot(key: string, base: string, head: string): Snapshot {
    sha(base); sha(head);
    const snapshot = { id: randomUUID(), base, head };
    this.#run('INSERT INTO snapshots VALUES (?,?,?)', key, snapshot.id, encode(snapshot));
    this.#run('UPDATE plans SET snapshot_id=? WHERE key=?', snapshot.id, key);
    return snapshot;
  }
  getSnapshot(identity: PlanIdentity, id?: string): Snapshot {
    const key = identityKey(identity);
    const row = this.#get('SELECT data FROM snapshots WHERE key=? AND id=?', key, id ?? this.#current(key).snapshot_id!);
    if (!row) throw new Error('Unknown snapshot.');
    return decode<Snapshot>(row.data);
  }
  beginSuggestions(identity: PlanIdentity, expectedRevision: number): string {
    const key = identityKey(identity);
    return this.#transaction(() => {
      if (this.#current(key).revision !== expectedRevision) throw new Error('Stale plan revision.');
      const id = randomUUID();
      this.#run("INSERT INTO requests VALUES (?,?,?,'pending',NULL)", id, key, expectedRevision); return id;
    });
  }
  completeSuggestions(identity: PlanIdentity, id: string, reply: unknown): void {
    assertEditReply(reply);
    const key = identityKey(identity);
    this.#transaction(() => {
      const current = this.#current(key);
      if (reply.base_revision !== current.revision || this.#run("UPDATE requests SET state='ready',reply=? WHERE id=? AND key=? AND revision=? AND state='pending'", encode(reply), id, key, current.revision!).changes !== 1)
        throw new Error('Suggestion request is stale, cancelled, or complete.');
    });
  }
  cancelSuggestions(identity: PlanIdentity, id: string): void {
    this.#run("UPDATE requests SET state='cancelled' WHERE id=? AND key=? AND state IN ('pending','ready')", id, identityKey(identity));
  }
  getSuggestions(identity: PlanIdentity, id: string): { state: string; revision: number; reply: EditReply | null } {
    const row = this.#get('SELECT * FROM requests WHERE key=? AND id=?', identityKey(identity), id);
    if (!row) throw new Error('Unknown suggestion request.');
    return { state: row.state as string, revision: row.revision as number, reply: row.reply === null ? null : decode<EditReply>(row.reply) };
  }
  applySuggestion(identity: PlanIdentity, id: string, index: number, context: PlanContext): Plan {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#context(key, context);
      const request = this.#get("SELECT * FROM requests WHERE id=? AND key=? AND state='ready'", id, key);
      if (!request) throw new Error('Suggestion is unavailable.');
      const plan = this.getPlan(identity);
      const next = applySuggestion(plan, decode<EditReply>(request.reply), index, context, {
        identity, schemaVersion: plan.schema_version, baseRevision: request.revision as number, issue: plan.issue,
      });
      this.#savePlan(key, next, request.revision as number);
      this.#run("UPDATE requests SET state='consumed' WHERE id=?", id); return next;
    });
  }
  #entry(key: string, entry: LedgerEntry): void {
    sha(entry.sha); if (entry.sourceSha !== null) sha(entry.sourceSha);
    if ((entry.origin === 'foreign' && entry.owner !== null) || (entry.origin === 'owned' && !entry.owner) || !['foreign', 'owned'].includes(entry.origin)) throw new Error('Invalid ledger ownership.');
    const existing = this.#get('SELECT data FROM ledger WHERE key=? AND sha=?', key, entry.sha);
    if (existing) {
      const prior = decode<LedgerEntry>(existing.data);
      if (prior.sha !== entry.sha || prior.owner !== entry.owner || prior.origin !== entry.origin || prior.sourceSha !== entry.sourceSha)
        throw new Error('Cannot overwrite immutable ledger ownership.');
      return;
    }
    this.#run('INSERT INTO ledger VALUES (?,?,?)', key, entry.sha, encode(entry));
  }
  /** Trusted runner records commits and updates the observed pair in one transaction. */
  recordHistory(identity: PlanIdentity, expected: ReviewState, base: string, head: string, entries: readonly LedgerEntry[]): Snapshot {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const plan = this.getPlan(identity);
      for (const entry of entries) {
        const existing = this.#get('SELECT sha FROM ledger WHERE key=? AND sha=?', key, entry.sha);
        if (!existing && entry.owner !== null && !plan.items.some(item => item.id === entry.owner)) throw new Error('Unknown ledger owner.');
        this.#entry(key, entry);
      }
      return this.#snapshot(key, base, head);
    });
  }
  getLedger(identity: PlanIdentity): LedgerEntry[] {
    const key = identityKey(identity); this.#current(key);
    return this.#db.prepare('SELECT data FROM ledger WHERE key=? ORDER BY sha').all(key).map(row => decode<LedgerEntry>(row.data));
  }
  ownership(identity: PlanIdentity): ReadonlyMap<string, string | null> {
    return new Map(this.getLedger(identity).map(entry => [entry.sha, entry.owner]));
  }
  recordRebase(identity: PlanIdentity, expected: ReviewState, base: string, head: string, mappings: readonly { oldSha: string; newSha: string }[]): Snapshot {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const ledger = new Map(this.getLedger(identity).map(entry => [entry.sha, entry]));
      const snapshot = this.#snapshot(key, base, head);
      const destinations = new Set<string>();
      for (const { oldSha, newSha } of mappings) {
        sha(oldSha); sha(newSha);
        if (destinations.has(newSha)) throw new Error('Rebase mappings must be one-to-one.');
        destinations.add(newSha);
        const source = ledger.get(oldSha);
        if (oldSha !== newSha) this.#entry(key, { sha: newSha, owner: source?.owner ?? null, origin: source?.origin ?? 'foreign', sourceSha: oldSha });
        this.#run('INSERT INTO rewrites VALUES (?,?,?,?)', key, snapshot.id, oldSha, newSha);
      }
      return snapshot;
    });
  }
  getRewrites(identity: PlanIdentity, snapshotId: string): { oldSha: string; newSha: string }[] {
    this.getSnapshot(identity, snapshotId);
    return this.#db.prepare('SELECT old_sha,new_sha FROM rewrites WHERE key=? AND snapshot_id=? ORDER BY old_sha').all(identityKey(identity), snapshotId).map(row => ({ oldSha: row.old_sha as string, newSha: row.new_sha as string }));
  }
  /** Values must be computed by the runner from this exact revision/snapshot, never supplied by a browser. */
  saveReview(identity: PlanIdentity, expected: ReviewState, approvals: readonly Approval[], choices: readonly SegmentChoice[]): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      this.#expect(key, expected); const plan = this.getPlan(identity);
      for (const approval of approvals) {
        if (!plan.items.some(item => item.id === approval.item) || !approval.fingerprint) throw new Error('Invalid approval.');
        this.#run('INSERT OR REPLACE INTO approvals VALUES (?,?,?)', key, approval.item, encode({ ...approval, ...expected }));
      }
      for (const choice of choices) {
        if (!choice.key || !['assign','accept'].includes(choice.action) || (choice.action === 'assign' ? !plan.items.some(item => item.id === choice.item) : choice.item !== null)) throw new Error('Invalid segment choice.');
        this.#run('INSERT OR REPLACE INTO choices VALUES (?,?,?)', key, choice.key, encode({ ...choice, ...expected }));
      }
    });
  }
  getReview(identity: PlanIdentity): { approvals: (Approval & ReviewState)[]; choices: (SegmentChoice & ReviewState)[] } {
    const key = identityKey(identity); this.#current(key);
    return {
      approvals: this.#db.prepare('SELECT data FROM approvals WHERE key=? ORDER BY item').all(key).map(row => decode<Approval & ReviewState>(row.data)),
      choices: this.#db.prepare('SELECT data FROM choices WHERE key=? ORDER BY choice_key').all(key).map(row => decode<SegmentChoice & ReviewState>(row.data)),
    };
  }
  /** Records evidence from an already completed safety audit; does not authorize execution. */
  recordCheckpoint(identity: PlanIdentity, expected: ReviewState, evidence: Omit<Checkpoint, 'id' | 'revision' | 'snapshotId'>): Checkpoint {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const plan = this.getPlan(identity), ids = plan.items.map(item => item.id);
      if (!ids.includes(evidence.item) || evidence.completedItems.at(-1) !== evidence.item || new Set(evidence.completedItems).size !== evidence.completedItems.length || evidence.completedItems.some((item, i) => item !== ids[i])) throw new Error('Checkpoint must describe the executed plan prefix.');
      const checkpoint = { ...evidence, ...expected, id: randomUUID() };
      this.#run('INSERT INTO checkpoints VALUES (?,?,?)', key, checkpoint.id, encode(checkpoint)); return checkpoint;
    });
  }
  getCheckpoint(identity: PlanIdentity, id: string): Checkpoint {
    const row = this.#get('SELECT data FROM checkpoints WHERE key=? AND id=?', identityKey(identity), id);
    if (!row) throw new Error('Unknown checkpoint.'); return decode<Checkpoint>(row.data);
  }
  /** Persist a person's approval only after the runner reconciles the prefix and validates the suffix. */
  approveContinuation(identity: PlanIdentity, checkpointId: string, expected: ReviewState): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      this.#expect(key, expected); const checkpoint = this.getCheckpoint(identity, checkpointId);
      if (!checkpoint.outOfScopePaths.length || checkpoint.snapshotId !== expected.snapshotId || expected.revision <= checkpoint.revision) throw new Error('Continuation requires an amended plan at the audited checkpoint.');
      this.#run('INSERT INTO continuations VALUES (?,?,?)', key, checkpointId, expected.revision);
    });
  }
  continuationRevision(identity: PlanIdentity, checkpointId: string): number | null {
    this.getCheckpoint(identity, checkpointId);
    return (this.#get('SELECT revision FROM continuations WHERE key=? AND checkpoint_id=?', identityKey(identity), checkpointId)?.revision as number | undefined) ?? null;
  }
}

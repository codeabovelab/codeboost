import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { importPlan, applySuggestion, assertEditReply, type Plan, type PlanContext, type EditReply } from '../core/plan.ts';
import type { Approval, SegmentChoice } from '../core/approvals.ts';
import type { InvocationContext, StopReason } from '../agents/contract.ts';
import {
  ATTEMPT_PHASES, BadRequest, CLOSED_STATUSES, ShuttingDownError, type ShutdownCapability, DEFAULT_TASK_BUDGET_MS, FIRST_REASONS, GuardRefusal, ActionIdReused, MAX_RESULT_BYTES, TASK_STATUSES, TERMINAL_STATES,
  assertUuidV4, bounded, classifySettlement, requestHash, sameContext,
  type AttemptKind, type AttemptState, type Classification, type FirstReason, type Settlement, type TaskStatus,
} from './lifecycle.ts';

export function requireSupportedNode(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if (!major || major < 26 || (major === 26 && (minor ?? 0) < 7))
    throw new Error('codeboost requires Node 26.7.0 or later. Upgrade Node before opening the store.');
}
export interface Snapshot { id: string; base: string; head: string }
export interface ReviewState { revision: number; snapshotId: string; reviewVersion?: number }
export type SuggestionState = 'pending' | 'ready' | 'failed' | 'cancelled' | 'invalidated' | 'consumed';
export interface SuggestionRequest { state: SuggestionState; revision: number; snapshotId: string | null; reply: EditReply | null; reason: string | null }
export interface SnippetReference { key: string; path: string; side: 'old' | 'new'; start: number; end: number; text: string; head: string; base: string }
export interface QuestionAnswer { provider?: 'claude' | 'codex'; attempt: string; contextId?: string; status: 'pending' | 'complete' | 'failed'; expiresAt: number; text?: string; error?: string }
export interface ReviewNote { id: string; item: string; kind: 'question' | 'change'; text: string; reference?: SnippetReference; answer?: QuestionAnswer; createdAt: string; revision: number; snapshotId: string }
export type MergeAttemptState = 'submitting' | 'queued' | 'merged' | 'removed' | 'failed';
export interface MergeAttempt {
  id: string; kind: 'queue' | 'direct'; state: MergeAttemptState; revision: number; snapshotId: string; reviewVersion: number; reviewedHead: string;
  queueWatermark?: string | null;
  url: string | null; reason: string | null; requiresFreshReview: boolean; entryId: string | null;
  phase: 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED' | null; position: number | null;
  occurredAt: string | null; createdAt: string; updatedAt: string;
}
export interface TaskRecord {
  planKey: string; status: TaskStatus; stateVersion: number; contextGeneration: number; assignmentId: string; referencedCodeHash: string;
  currentAttemptId: string | null; requeuePending: boolean; cancelRequested: string | null; rebaseInProgress: unknown; budgetDeadline: number | null;
  createdAt: string; updatedAt: string;
}
export interface AttemptRecord {
  id: string; kind: AttemptKind; phase: string; item: string | null; state: AttemptState; context: InvocationContext; deadline: number;
  firstReason: FirstReason | null; stopReason: StopReason | null; exitCode: number | null; signal: string | null; result: unknown;
  diagnostic: string | null; diagnosticRef: string | null; createdAt: string; startedAt: string | null; settledAt: string | null;
}
export type FeedbackKind = 'reject' | 'change-request' | 'segment-accept' | 'segment-assign' | 'finding-accept' | 'needs-human-guidance' | 'task-closed';
const FEEDBACK_KINDS: readonly FeedbackKind[] = ['reject', 'change-request', 'segment-accept', 'segment-assign', 'finding-accept', 'needs-human-guidance', 'task-closed'];
export interface FeedbackEvent {
  id: string; planKey: string; actionId: string; planRevision: number; snapshotId: string | null; item: string | null;
  kind: FeedbackKind; text: string | null; sourceRef: string; supersedes: string | null; createdAt: string;
}
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
        const version = this.#get('PRAGMA user_version')!.user_version as number;
        if (![0, 1, 2, 3, 4, 5, 6].includes(version)) throw new Error('Unsupported store schema version.');
        if (version === 6) return;
        if (version === 0) this.#db.exec(`
          CREATE TABLE plans (key TEXT PRIMARY KEY, issue INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_id TEXT);
          CREATE TABLE revisions (key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,revision));
          CREATE TABLE snapshots (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          CREATE TABLE requests (id TEXT PRIMARY KEY, key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, state TEXT NOT NULL, reply TEXT);
          CREATE TABLE ledger (key TEXT NOT NULL REFERENCES plans(key), sha TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,sha));
          CREATE TABLE rewrites (key TEXT NOT NULL REFERENCES plans(key), snapshot_id TEXT NOT NULL, old_sha TEXT NOT NULL, new_sha TEXT NOT NULL, PRIMARY KEY(key,snapshot_id,old_sha));
          CREATE TABLE approvals (key TEXT NOT NULL REFERENCES plans(key), item TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,item));
          CREATE TABLE choices (key TEXT NOT NULL REFERENCES plans(key), choice_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,choice_key));
          CREATE TABLE checkpoints (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          CREATE TABLE continuations (key TEXT NOT NULL REFERENCES plans(key), checkpoint_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(key,checkpoint_id,revision));
          PRAGMA user_version=1;
        `);
        if (version < 2) this.#db.exec(`ALTER TABLE plans ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE review_notes (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          PRAGMA user_version=2;`);
        if (version < 3) this.#db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=3;");
        if (version < 4) this.#db.exec(`ALTER TABLE requests ADD COLUMN snapshot_id TEXT;
            ALTER TABLE requests ADD COLUMN reason TEXT;
            UPDATE requests SET state='invalidated', reason='Request predates snapshot binding.' WHERE state IN ('pending','ready');
            PRAGMA user_version=4;`);
        if (version < 5) this.#db.exec(`CREATE TABLE IF NOT EXISTS merge_attempts (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL REFERENCES plans(key),
            data TEXT NOT NULL
          );
          PRAGMA user_version=5;`);
        if (version < 6) this.#migrateV6();
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  questionProvider(): 'claude' | 'codex' | null {
    const value=this.#get("SELECT value FROM app_settings WHERE key='question_provider'")?.value;
    return value==='claude'||value==='codex'?value:null;
  }
  setQuestionProvider(value: unknown): void {
    if(value!==null&&value!=='claude'&&value!=='codex') throw new Error('Choose Claude Code or Codex.');
    this.#run("INSERT INTO app_settings VALUES ('question_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value??'');
  }
  close(): void { this.#db.close(); }
  #get(sql: string, ...args: SQLInputValue[]) { return this.#db.prepare(sql).get(...args); }
  #run(sql: string, ...args: SQLInputValue[]) { this.#checkWrite(); return this.#db.prepare(sql).run(...args); }
  // Shutdown write gate (runner-lifecycle.md, "Shutdown" step 1).
  #gateClosed = false; #privileged = 0; #capabilityIssued = false;
  #checkWrite(): void { if (this.#gateClosed && this.#privileged === 0) throw new ShuttingDownError(); }
  /** Issued once, to the server, which hands it only to coordinators' settlement and close code. */
  shutdownCapability(): ShutdownCapability {
    if (this.#capabilityIssued) throw new Error('The shutdown capability was already issued.');
    this.#capabilityIssued = true;
    return Object.freeze({ run: <T>(fn: () => T): T => { this.#privileged++; try { return fn(); } finally { this.#privileged--; } } });
  }
  /** Shutdown step 1: from now on, every write without the capability throws ShuttingDownError. Reads still work. */
  closeWrites(): void { this.#gateClosed = true; }
  get writesClosed(): boolean { return this.#gateClosed; }
  #depth = 0;
  /** Nested calls join the outer transaction, so a user action can wrap existing Store methods atomically. */
  #transaction<T>(fn: () => T): T {
    if (this.#depth > 0) { this.#depth++; try { return fn(); } finally { this.#depth--; } }
    this.#checkWrite();
    this.#db.exec('BEGIN IMMEDIATE'); this.#depth = 1;
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#depth = 0; }
  }
  #current(key: string) {
    const row = this.#get('SELECT * FROM plans WHERE key=?', key);
    if (!row) throw new Error('Unknown plan identity.');
    return row;
  }
  #expect(key: string, expected: ReviewState): void {
    const row = this.#current(key);
    if (row.revision !== expected.revision || row.snapshot_id !== expected.snapshotId ||
        (expected.reviewVersion !== undefined && row.review_version !== expected.reviewVersion)) throw new Error('Stale review state. Reload before writing.');
  }
  #context(key: string, context: PlanContext): void {
    if (identityKey(context.identity) !== key || context.issue !== this.#current(key).issue) throw new Error('Plan context identity/issue mismatch.');
  }
  #savePlan(key: string, plan: Plan, expected: number): void {
    if (this.#run('UPDATE plans SET revision=? WHERE key=? AND revision=?', plan.revision, key, expected).changes !== 1) throw new Error('Stale plan revision.');
    this.#run('INSERT INTO revisions VALUES (?,?,?)', key, plan.revision, encode(plan));
    this.#bumpContext(key);
    this.#run("UPDATE requests SET state='invalidated',reason='Plan revision changed.' WHERE key=? AND state IN ('pending','ready')", key);
    const items = new Set(plan.items.map(item => item.id));
    for (const row of this.#db.prepare('SELECT item FROM approvals WHERE key=?').all(key)) {
      if (!items.has(row.item as string)) this.#run('DELETE FROM approvals WHERE key=? AND item=?', key, row.item!);
    }
    for (const row of this.#db.prepare('SELECT choice_key,data FROM choices WHERE key=?').all(key)) {
      const choice = decode<SegmentChoice>(row.data);
      if (choice.action === 'assign' && !items.has(choice.item!))
        this.#run('DELETE FROM choices WHERE key=? AND choice_key=?', key, row.choice_key!);
    }
  }
  createPlan(source: string | Uint8Array, format: 'json' | 'yaml', context: PlanContext, base: string, head: string): Plan {
    sha(base); sha(head);
    const key = identityKey(context.identity), plan = importPlan(source, format, context, 1).plan;
    return this.#transaction(() => {
      this.#run('INSERT INTO plans (key,issue,revision,snapshot_id) VALUES (?,?,?,NULL)', key, plan.issue, 0);
      this.#savePlan(key, plan, 0);
      this.#snapshot(key, base, head);
      const now = new Date().toISOString();
      this.#run(`INSERT INTO tasks (plan_key,status,state_version,context_generation,assignment_id,referenced_code_hash,created_at,updated_at)
        VALUES (?,'in review',0,0,'unassigned',?,?,?)`, key, head, now, now);
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
    this.#bumpContext(key);
    this.#run("UPDATE requests SET state='invalidated',reason='Repository snapshot changed.' WHERE key=? AND state IN ('pending','ready')", key);
    return snapshot;
  }
  getSnapshot(identity: PlanIdentity, id?: string): Snapshot {
    const key = identityKey(identity);
    const row = this.#get('SELECT data FROM snapshots WHERE key=? AND id=?', key, id ?? this.#current(key).snapshot_id!);
    if (!row) throw new Error('Unknown snapshot.');
    return decode<Snapshot>(row.data);
  }
  beginSuggestions(identity: PlanIdentity, expected: ReviewState): string {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const id = randomUUID();
      this.#run("INSERT INTO requests (id,key,revision,state,reply,snapshot_id,reason) VALUES (?,?,?,'pending',NULL,?,NULL)", id, key, expected.revision, expected.snapshotId); return id;
    });
  }
  completeSuggestions(identity: PlanIdentity, id: string, reply: unknown): void {
    assertEditReply(reply);
    const key = identityKey(identity);
    this.#transaction(() => {
      const current = this.#current(key);
      if (reply.base_revision !== current.revision || this.#run("UPDATE requests SET state='ready',reply=?,reason=NULL WHERE id=? AND key=? AND revision=? AND snapshot_id=? AND state='pending'", encode(reply), id, key, current.revision!, current.snapshot_id!).changes !== 1)
        throw new Error('Suggestion request is stale, cancelled, or complete.');
    });
  }
  settleSuggestion(identity: PlanIdentity, id: string, expected: ReviewState, outcome: { state: 'failed' | 'cancelled' | 'invalidated'; reason: string }): boolean {
    if (!['failed', 'cancelled', 'invalidated'].includes(outcome.state) || typeof outcome.reason !== 'string' || !outcome.reason.trim() || outcome.reason.length > 4000) throw new Error('Invalid suggestion outcome.');
    const key = identityKey(identity);
    return this.#transaction(() => this.#run(`UPDATE requests SET state=?,reason=?
      WHERE id=? AND key=? AND revision=? AND snapshot_id=? AND state='pending'
      AND EXISTS (SELECT 1 FROM plans WHERE key=? AND revision=? AND snapshot_id=?)`,
      outcome.state, outcome.reason.trim(), id, key, expected.revision, expected.snapshotId, key, expected.revision, expected.snapshotId).changes === 1);
  }
  cancelSuggestions(identity: PlanIdentity, id: string, reason = 'Suggestion cancelled.'): void {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw new Error('Invalid cancellation reason.');
    this.#run("UPDATE requests SET state='cancelled',reason=? WHERE id=? AND key=? AND state IN ('pending','ready')", reason.trim(), id, identityKey(identity));
  }
  beginMergeAttempt(identity: PlanIdentity, expected: ReviewState & { reviewVersion: number }, reviewedHead: string, queueWatermark: string | null = null, kind: MergeAttempt['kind'] = 'queue'): MergeAttempt {
    sha(reviewedHead);
    if (!['queue','direct'].includes(kind)) throw new Error('Invalid merge attempt kind.');
    if (queueWatermark !== null && (typeof queueWatermark !== 'string' || !queueWatermark || queueWatermark.length > 512)) throw new Error('Invalid merge-queue event cursor.');
    if (!Number.isSafeInteger(expected.reviewVersion) || expected.reviewVersion < 0) throw new Error('A current review version is required for merging.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const current = this.getMergeAttempt(identity);
      if (current?.state === 'submitting' || current?.state === 'queued') throw new Error('A merge-queue attempt is already active.');
      if (current?.state === 'merged') throw new Error('The reviewed pull request is already merged.');
      const now = new Date().toISOString();
      const attempt: MergeAttempt = {
        id: randomUUID(), kind, state: 'submitting', revision: expected.revision, snapshotId: expected.snapshotId,
        reviewVersion: expected.reviewVersion, reviewedHead, queueWatermark, url: null, reason: null, requiresFreshReview: false,
        entryId: null, phase: null, position: null, occurredAt: null, createdAt: now, updatedAt: now,
      };
      this.#run('INSERT INTO merge_attempts VALUES (?,?,?)', attempt.id, key, encode(attempt));
      return attempt;
    });
  }
  #changeMergeAttempt(identity: PlanIdentity, id: string, allowed: readonly MergeAttemptState[], change: (attempt: MergeAttempt) => MergeAttempt): boolean {
    const key = identityKey(identity);
    return this.#transaction(() => {
      const latest = this.#get('SELECT id,data FROM merge_attempts WHERE key=? ORDER BY rowid DESC LIMIT 1', key);
      if (!latest || latest.id !== id) return false;
      const attempt = decode<MergeAttempt>(latest.data);
      if (!allowed.includes(attempt.state)) return false;
      const next = change(attempt);
      return this.#run('UPDATE merge_attempts SET data=? WHERE id=? AND key=?', encode({ ...next, updatedAt: new Date().toISOString() }), id, key).changes === 1;
    });
  }
  queueMergeAttempt(identity: PlanIdentity, id: string, url: string): boolean {
    if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//.test(url)) throw new Error('Invalid merge result URL.');
    return this.#changeMergeAttempt(identity, id, ['submitting'], attempt => ({ ...attempt, state: 'queued', url, reason: null }));
  }
  recordMergeAttemptDiagnostic(identity: PlanIdentity, id: string, reason: string): boolean {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw new Error('A bounded merge diagnostic is required.');
    return this.#changeMergeAttempt(identity, id, ['submitting'], attempt => ({ ...attempt, reason: reason.trim() }));
  }
  observeQueuedMerge(identity: PlanIdentity, id: string, observation: { entryId: string; phase: MergeAttempt['phase']; position: number }): boolean {
    if (typeof observation.entryId !== 'string' || !observation.entryId || observation.entryId.length > 512 ||
        !['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED'].includes(String(observation.phase)) ||
        !Number.isSafeInteger(observation.position) || observation.position < 0) throw new Error('Invalid merge-queue observation.');
    return this.#changeMergeAttempt(identity, id, ['submitting','queued'], attempt => ({
      ...attempt, state: 'queued', reason: null, entryId: observation.entryId, phase: observation.phase, position: observation.position,
    }));
  }
  finishMergeAttempt(identity: PlanIdentity, id: string, outcome: {
    state: 'merged' | 'removed' | 'failed'; reason?: string; occurredAt?: string; requiresFreshReview?: boolean;
  }): boolean {
    if (!['merged','removed','failed'].includes(outcome.state)) throw new Error('Invalid merge-queue outcome.');
    if (outcome.state !== 'merged' && (typeof outcome.reason !== 'string' || !outcome.reason.trim() || outcome.reason.length > 4000)) throw new Error('A bounded terminal merge reason is required.');
    if (outcome.occurredAt !== undefined && (!Number.isFinite(Date.parse(outcome.occurredAt)) || outcome.occurredAt.length > 64)) throw new Error('Invalid merge-queue timestamp.');
    // A confirmed merge closes the task and records task-closed in the same transaction (feedback-event rule 2).
    return this.#transaction(() => {
      const changed = this.#changeMergeAttempt(identity, id, ['submitting','queued'], attempt => ({
        ...attempt, state: outcome.state, reason: outcome.state === 'merged' ? null : outcome.reason!.trim(),
        occurredAt: outcome.occurredAt ?? null, requiresFreshReview: outcome.requiresFreshReview === true,
      }));
      if (changed && outcome.state === 'merged') this.#closeTask(identityKey(identity), 'merged', id);
      return changed;
    });
  }
  getMergeAttempt(identity: PlanIdentity): MergeAttempt | null {
    this.#current(identityKey(identity));
    const row = this.#get('SELECT data FROM merge_attempts WHERE key=? ORDER BY rowid DESC LIMIT 1', identityKey(identity));
    if (!row) return null;
    const attempt = decode<MergeAttempt>(row.data);
    return { ...attempt, kind: attempt.kind ?? 'queue' };
  }
  getSuggestions(identity: PlanIdentity, id: string): SuggestionRequest {
    const row = this.#get('SELECT * FROM requests WHERE key=? AND id=?', identityKey(identity), id);
    if (!row) throw new Error('Unknown suggestion request.');
    return { state: row.state as SuggestionState, revision: row.revision as number, snapshotId: row.snapshot_id as string | null, reply: row.reply === null ? null : decode<EditReply>(row.reply), reason: row.reason as string | null };
  }
  applySuggestion(identity: PlanIdentity, id: string, index: number, context: PlanContext): Plan {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#context(key, context);
      const request = this.#get("SELECT * FROM requests WHERE id=? AND key=? AND state='ready'", id, key);
      if (!request) throw new Error('Suggestion is unavailable.');
      const current = this.#current(key);
      if (request.revision !== current.revision || request.snapshot_id !== current.snapshot_id) throw new Error('Suggestion is unavailable.');
      const plan = this.getPlan(identity);
      const next = applySuggestion(plan, decode<EditReply>(request.reply), index, context, {
        identity, schemaVersion: plan.schema_version, baseRevision: request.revision as number, issue: plan.issue,
      });
      this.#savePlan(key, next, request.revision as number);
      this.#run("UPDATE requests SET state='consumed',reason=NULL WHERE id=?", id); return next;
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
  /** Link a selected revision conservatively; the raw ledger retains historical owners. */
  ownership(identity: PlanIdentity, revision?: number): ReadonlyMap<string, string | null> {
    const items = new Set(this.getPlan(identity, revision).items.map(item => item.id));
    return new Map(this.getLedger(identity).map(entry => [entry.sha, entry.owner !== null && items.has(entry.owner) ? entry.owner : null]));
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
        else if (!source) this.#entry(key, { sha: newSha, owner: null, origin: 'foreign', sourceSha: null });
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
      this.#run('UPDATE plans SET review_version=review_version+1 WHERE key=?', key);
    });
  }
  reviewVersion(identity: PlanIdentity): number { return this.#current(identityKey(identity)).review_version as number; }
  addReviewNote(identity: PlanIdentity, expected: ReviewState, item: string, kind: ReviewNote['kind'], text: string, reference?: SnippetReference): ReviewNote {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      if (!this.getPlan(identity).items.some(entry => entry.id === item) || !['question', 'change'].includes(kind) || typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Invalid review note.');
      const note = { id: randomUUID(), item, kind, text: text.trim(), ...(reference ? { reference } : {}), createdAt: new Date().toISOString(), revision: expected.revision, snapshotId: expected.snapshotId };
      this.#run('INSERT INTO review_notes VALUES (?,?,?)', key, note.id, encode(note));
      this.#run('UPDATE plans SET review_version=review_version+1 WHERE key=?', key);
      return note;
    });
  }
  beginAnswer(identity: PlanIdentity, id: string, attempt: string, provider?: 'claude' | 'codex', contextId?: string): void {
    const key=identityKey(identity);
    this.#transaction(()=>{
      const row=this.#get('SELECT data FROM review_notes WHERE key=? AND id=?',key,id);
      if(!row) throw new Error('Question not found.');
      const note=decode<ReviewNote>(row.data);
      if(note.kind!=='question' || note.answer?.status==='complete') throw new Error('Question already answered.');
      if(note.answer?.status==='pending' && note.answer.expiresAt>Date.now()) throw new Error('Agent is already answering this question.');
      note.answer={attempt,status:'pending',expiresAt:Date.now()+125000,...(provider?{provider}:{}),...(contextId?{contextId}:{})};
      this.#run('UPDATE review_notes SET data=? WHERE key=? AND id=?',encode(note),key,id);
    });
  }
  finishAnswer(identity: PlanIdentity, id: string, attempt: string, result: {status:'complete'|'failed';text?:string;error?:string}): void {
    const key=identityKey(identity);
    this.#transaction(()=>{
      const row=this.#get('SELECT data FROM review_notes WHERE key=? AND id=?',key,id);
      if(!row) return;
      const note=decode<ReviewNote>(row.data);
      if(note.answer?.attempt!==attempt || note.answer.status!=='pending') return;
      note.answer={...note.answer,...result};
      this.#run('UPDATE review_notes SET data=? WHERE key=? AND id=?',encode(note),key,id);
    });
  }
  getReviewNotes(identity: PlanIdentity): ReviewNote[] {
    return this.#db.prepare('SELECT data FROM review_notes WHERE key=? ORDER BY rowid').all(identityKey(identity)).map(row => decode<ReviewNote>(row.data));
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
      this.#run('INSERT INTO continuations VALUES (?,?,?) ON CONFLICT(key,checkpoint_id,revision) DO NOTHING', key, checkpointId, expected.revision);
    });
  }
  continuationRevision(identity: PlanIdentity, checkpointId: string): number | null {
    this.getCheckpoint(identity, checkpointId);
    return (this.#get('SELECT MAX(revision) AS revision FROM continuations WHERE key=? AND checkpoint_id=?', identityKey(identity), checkpointId)?.revision as number | null) ?? null;
  }
  // ---- F1 runner lifecycle (docs/implementation/runner-lifecycle.md) ----
  #migrateV6(): void {
    const list = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        plan_key TEXT PRIMARY KEY REFERENCES plans(key),
        status TEXT NOT NULL CHECK (status IN (${list(TASK_STATUSES)})),
        state_version INTEGER NOT NULL DEFAULT 0, context_generation INTEGER NOT NULL DEFAULT 0,
        assignment_id TEXT NOT NULL, referenced_code_hash TEXT NOT NULL,
        current_attempt_id TEXT, requeue_pending INTEGER NOT NULL DEFAULT 0, cancel_requested TEXT, rebase_in_progress TEXT,
        budget_deadline INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (plan_key, current_attempt_id) REFERENCES attempts(plan_key, id));
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, plan_key TEXT NOT NULL REFERENCES tasks(plan_key),
        kind TEXT NOT NULL, phase TEXT NOT NULL, item TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending','running','completed','failed','cancelled','stale')),
        context TEXT NOT NULL, deadline INTEGER NOT NULL,
        first_reason TEXT CHECK (first_reason IS NULL OR first_reason IN (${list(FIRST_REASONS)})),
        stop_reason TEXT, exit_code INTEGER, signal TEXT, result TEXT, diagnostic TEXT, diagnostic_ref TEXT,
        preparation_pgid INTEGER, preparation_started_at INTEGER, allocation_id TEXT,
        created_at TEXT NOT NULL, started_at TEXT, settled_at TEXT, UNIQUE (plan_key, id));
      CREATE TABLE IF NOT EXISTS user_actions (
        plan_key TEXT NOT NULL REFERENCES plans(key), action_id TEXT NOT NULL, kind TEXT NOT NULL,
        request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (plan_key, action_id));
      CREATE TABLE IF NOT EXISTS feedback_events (
        id TEXT PRIMARY KEY, plan_key TEXT NOT NULL REFERENCES plans(key), action_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL, snapshot_id TEXT, item TEXT,
        kind TEXT NOT NULL CHECK (kind IN (${list(FEEDBACK_KINDS)})), text TEXT, source_ref TEXT NOT NULL,
        supersedes TEXT REFERENCES feedback_events(id), created_at TEXT NOT NULL, UNIQUE (plan_key, kind, action_id));`);
    // Backfill: one task per existing plan; a merged plan also gets its task-closed event.
    const now = new Date().toISOString();
    const latestMerge = (column: string) => `(SELECT ${column} FROM merge_attempts m WHERE m.key=p.key ORDER BY m.rowid DESC LIMIT 1)`;
    this.#run(`INSERT OR IGNORE INTO tasks (plan_key,status,state_version,context_generation,assignment_id,referenced_code_hash,created_at,updated_at)
      SELECT p.key, CASE WHEN ${latestMerge("json_extract(m.data,'$.state')")}='merged' THEN 'merged' ELSE 'in review' END, 0, 0, 'unassigned',
        COALESCE((SELECT json_extract(s.data,'$.head') FROM snapshots s WHERE s.key=p.key AND s.id=p.snapshot_id),'none'), ?, ?
      FROM plans p`, now, now);
    this.#run(`INSERT INTO feedback_events (id,plan_key,action_id,plan_revision,snapshot_id,item,kind,text,source_ref,supersedes,created_at)
      SELECT lower(hex(randomblob(16))), p.key, ${latestMerge('m.id')}, p.revision, p.snapshot_id, NULL, 'task-closed', NULL, p.key, NULL, ?
      FROM plans p JOIN tasks t ON t.plan_key=p.key WHERE t.status='merged'
        AND NOT EXISTS (SELECT 1 FROM feedback_events e WHERE e.plan_key=p.key AND e.kind='task-closed')`, now);
    this.#db.exec('PRAGMA user_version=6;');
  }
  #task(key: string) {
    const row = this.#get('SELECT * FROM tasks WHERE plan_key=?', key);
    if (!row) throw new Error('Unknown task.');
    return row;
  }
  #taskRecord(row: Record<string, SQLOutputValue>): TaskRecord {
    return {
      planKey: row.plan_key as string, status: row.status as TaskStatus, stateVersion: row.state_version as number,
      contextGeneration: row.context_generation as number, assignmentId: row.assignment_id as string,
      referencedCodeHash: row.referenced_code_hash as string, currentAttemptId: row.current_attempt_id as string | null,
      requeuePending: row.requeue_pending === 1, cancelRequested: row.cancel_requested as string | null,
      rebaseInProgress: row.rebase_in_progress === null ? null : decode(row.rebase_in_progress),
      budgetDeadline: row.budget_deadline as number | null, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    };
  }
  #attemptRecord(row: Record<string, SQLOutputValue>): AttemptRecord {
    return {
      id: row.id as string, kind: row.kind as AttemptKind, phase: row.phase as string, item: row.item as string | null,
      state: row.state as AttemptState, context: decode<InvocationContext>(row.context), deadline: row.deadline as number,
      firstReason: row.first_reason as FirstReason | null, stopReason: row.stop_reason as StopReason | null,
      exitCode: row.exit_code as number | null, signal: row.signal as string | null,
      result: row.result === null ? null : decode(row.result), diagnostic: row.diagnostic as string | null,
      diagnosticRef: row.diagnostic_ref as string | null, createdAt: row.created_at as string,
      startedAt: row.started_at as string | null, settledAt: row.settled_at as string | null,
    };
  }
  /** Every durable change to a task or its attempts increases the state version. */
  #touch(key: string): void {
    this.#run('UPDATE tasks SET state_version=state_version+1, updated_at=? WHERE plan_key=?', new Date().toISOString(), key);
  }
  /** A change an attempt depends on increases both counters in the caller's transaction. */
  #bumpContext(key: string): void {
    this.#run('UPDATE tasks SET context_generation=context_generation+1, state_version=state_version+1, updated_at=? WHERE plan_key=?', new Date().toISOString(), key);
  }
  #contextOf(key: string): InvocationContext {
    const plan = this.#current(key), task = this.#task(key);
    return {
      snapshotId: plan.snapshot_id as string, planId: (JSON.parse(key) as string[])[2]!, planRevision: plan.revision as number,
      assignmentId: task.assignment_id as string, referencedCodeHash: task.referenced_code_hash as string,
      stateVersion: task.context_generation as number,
    };
  }
  #closed(status: unknown): boolean { return CLOSED_STATUSES.includes(status as TaskStatus); }
  #closeTask(key: string, status: 'merged' | 'cancelled', actionId: string): void {
    const plan = this.#current(key);
    this.#run('UPDATE tasks SET status=?, cancel_requested=NULL WHERE plan_key=?', status, key);
    this.#run(`INSERT INTO feedback_events (id,plan_key,action_id,plan_revision,snapshot_id,item,kind,text,source_ref,supersedes,created_at)
      VALUES (?,?,?,?,?,NULL,'task-closed',NULL,?,NULL,?) ON CONFLICT(plan_key,kind,action_id) DO NOTHING`,
      randomUUID(), key, actionId, plan.revision!, plan.snapshot_id ?? null, key, new Date().toISOString());
    this.#touch(key);
  }
  getTask(identity: PlanIdentity): TaskRecord { return this.#taskRecord(this.#task(identityKey(identity))); }
  currentContext(identity: PlanIdentity): InvocationContext { return this.#contextOf(identityKey(identity)); }
  getAttempt(identity: PlanIdentity, id: string): AttemptRecord {
    const row = this.#get('SELECT * FROM attempts WHERE plan_key=? AND id=?', identityKey(identity), id);
    if (!row) throw new Error('Unknown attempt.');
    return this.#attemptRecord(row);
  }
  getAttempts(identity: PlanIdentity): AttemptRecord[] {
    return this.#db.prepare('SELECT * FROM attempts WHERE plan_key=? ORDER BY rowid').all(identityKey(identity)).map(row => this.#attemptRecord(row));
  }
  /** Reassigning work or changing referenced code makes older attempts non-current. */
  setAssignment(identity: PlanIdentity, expectedStateVersion: number, assignmentId: string, referencedCodeHash: string): void {
    if (![assignmentId, referencedCodeHash].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200))
      throw new GuardRefusal('Invalid assignment.');
    const key = identityKey(identity);
    this.#transaction(() => {
      if (this.#task(key).state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      this.#run('UPDATE tasks SET assignment_id=?, referenced_code_hash=? WHERE plan_key=?', assignmentId, referencedCodeHash, key);
      this.#bumpContext(key);
    });
  }
  /** Status changes other than closing and admission. Closing uses cancelTask or a confirmed merge; running comes from admission. */
  transitionTask(identity: PlanIdentity, expectedStateVersion: number, to: TaskStatus): void {
    if (!TASK_STATUSES.includes(to) || this.#closed(to) || to === 'running') throw new GuardRefusal('Invalid task status change.');
    const key = identityKey(identity);
    this.#transaction(() => {
      const task = this.#task(key);
      if (task.state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (this.#closed(task.status)) throw new GuardRefusal('A closed task never changes.');
      if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is still active for this task.');
      this.#run('UPDATE tasks SET status=? WHERE plan_key=?', to, key);
      this.#touch(key);
    });
  }
  #activeAttempt(key: string) {
    return this.#get("SELECT * FROM attempts WHERE plan_key=? AND state IN ('pending','running')", key);
  }
  /** Admission, including retry: status, state version, requeue claim, active attempt and captured context are checked in one transaction. */
  admitAttempt(identity: PlanIdentity, input: {
    expectedStateVersion: number; kind: AttemptKind; item?: string | null; expectedContext: InvocationContext;
    deadline: number; budgetMs?: number; retryOf?: string; now?: number; claimRequeue?: boolean;
  }): AttemptRecord {
    const now = input.now ?? Date.now(), budgetMs = input.budgetMs ?? DEFAULT_TASK_BUDGET_MS;
    if (!(input.kind in ATTEMPT_PHASES)) throw new GuardRefusal('Unknown attempt kind.');
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= now) throw new GuardRefusal('An attempt needs a finite future deadline.');
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new GuardRefusal('Invalid task budget.');
    if (input.retryOf !== undefined) assertUuidV4(input.retryOf, 'Retried attempt ID');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const task = this.#task(key);
      if (task.status !== 'running' && task.status !== 'queued') throw new GuardRefusal(`The task is ${task.status}; it cannot start work.`);
      if (task.state_version !== input.expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      // Requeue claim: exactly one path (I3's requeue, or the user's Resume) clears it, by CAS in this admitting transaction.
      if (task.requeue_pending === 1 && !input.claimRequeue) throw new GuardRefusal('Recovery is requeueing this task.');
      if (input.claimRequeue && task.requeue_pending !== 1) throw new GuardRefusal('The requeue was already claimed.');
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is being cancelled.');
      if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is already active for this task.');
      const current = this.#contextOf(key);
      if (!sameContext(input.expectedContext, current)) throw new GuardRefusal('The plan, snapshot, assignment or referenced code changed. Reload before starting.');
      if (input.retryOf !== undefined) {
        const last = task.current_attempt_id === input.retryOf ? this.#get('SELECT * FROM attempts WHERE plan_key=? AND id=?', key, input.retryOf) : undefined;
        if (!last || (last.state !== 'failed' && last.state !== 'cancelled')) throw new GuardRefusal('Only the latest failed or cancelled attempt can be retried.');
        if (!sameContext(decode<InvocationContext>(last.context), current)) throw new GuardRefusal('The retried attempt is out of date. Start a new request on the current code.');
      }
      if (input.item !== undefined && input.item !== null && !this.getPlan(identity).items.some(entry => entry.id === input.item))
        throw new GuardRefusal('Unknown plan item.');
      const id = randomUUID(), created = new Date(now).toISOString();
      this.#run(`INSERT INTO attempts (id,plan_key,kind,phase,item,state,context,deadline,created_at) VALUES (?,?,?,?,?,'pending',?,?,?)`,
        id, key, input.kind, ATTEMPT_PHASES[input.kind], input.item ?? null, encode(current), input.deadline, created);
      this.#run(`UPDATE tasks SET current_attempt_id=?, status='running', requeue_pending=0, budget_deadline=COALESCE(budget_deadline, ?) WHERE plan_key=?`, id, now + budgetMs, key);
      this.#touch(key);
      return this.getAttempt(identity, id);
    });
  }
  /** The "Stopping" transition: sets the first reason once, keeps the state. */
  recordFirstReason(identity: PlanIdentity, id: string, reason: FirstReason): boolean {
    if (!FIRST_REASONS.includes(reason)) throw new GuardRefusal('Unknown stop reason.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET first_reason=? WHERE plan_key=? AND id=? AND state IN ('pending','running') AND first_reason IS NULL`, reason, key, id).changes === 1;
      if (changed) this.#touch(key);
      return changed;
    });
  }
  /** pending -> running after D returns a handle. Refused once a first reason is recorded. */
  markRunning(identity: PlanIdentity, id: string): boolean {
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET state='running', started_at=? WHERE plan_key=? AND id=? AND state='pending' AND first_reason IS NULL
        AND id=(SELECT current_attempt_id FROM tasks WHERE plan_key=?)`, new Date().toISOString(), key, id, key).changes === 1;
      if (changed) this.#touch(key);
      return changed;
    });
  }
  /**
   * Terminal write. The Store, not the caller, chooses the terminal state from the durable first reason
   * (or the caller's in-memory one if its write failed), D's result and whether the captured context is still current.
   */
  settleAttempt(identity: PlanIdentity, id: string, settlement: Omit<Settlement, 'contextCurrent'> & {
    signal?: string | null; result?: unknown; diagnosticRef?: string | null;
  }): Classification {
    if (settlement.firstReason !== null && !FIRST_REASONS.includes(settlement.firstReason)) throw new GuardRefusal('Unknown stop reason.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const task = this.#task(key), row = this.#get('SELECT * FROM attempts WHERE plan_key=? AND id=?', key, id);
      if (!row || task.current_attempt_id !== id || (row.state !== 'pending' && row.state !== 'running')) throw new GuardRefusal('Attempt is not the active attempt.');
      const firstReason = (row.first_reason as FirstReason | null) ?? settlement.firstReason;
      const contextCurrent = sameContext(decode<InvocationContext>(row.context), this.#contextOf(key));
      let outcome = classifySettlement({ ...settlement, firstReason, contextCurrent });
      if (outcome.state === 'completed' && row.state !== 'running') throw new GuardRefusal('Only a running attempt can complete.');
      // The task must still be running; a task never leaves running while an attempt is active, so this is a second safeguard.
      if (outcome.state === 'completed' && (task.status !== 'running' || task.cancel_requested !== null))
        outcome = { state: 'cancelled', reason: this.#closed(task.status) || task.cancel_requested !== null
          ? 'The task was closed before the result was saved.' : 'The task left the running state before the result was saved.', timeLimit: false };
      let result: string | null = null;
      if (outcome.state === 'completed') {
        result = encode(settlement.result ?? null);
        if (Buffer.byteLength(result) > MAX_RESULT_BYTES) outcome = { state: 'failed', reason: 'The result exceeds 1 MiB.', timeLimit: false }, result = null;
      }
      this.#run(`UPDATE attempts SET state=?, first_reason=?, stop_reason=?, exit_code=?, signal=?, result=?, diagnostic=?, diagnostic_ref=?, settled_at=? WHERE id=?`,
        outcome.state, firstReason, settlement.stopReason ?? null, settlement.exitCode, settlement.signal ?? null, result,
        outcome.reason, settlement.diagnosticRef ?? null, new Date().toISOString(), id);
      // A pending cancel task wins over everything, including the time limit.
      if (task.cancel_requested !== null && !this.#closed(task.status)) this.#closeTask(key, 'cancelled', task.cancel_requested as string);
      else {
        if (outcome.timeLimit && !this.#closed(task.status)) this.#run(`UPDATE tasks SET status='needs human' WHERE plan_key=?`, key);
        this.#touch(key);
      }
      return outcome;
    });
  }
  /** Cancel task: closes now, or, with an active attempt, stops it first and closes when it settles. */
  cancelTask(identity: PlanIdentity, expectedStateVersion: number, actionId: string): 'closed' | 'stopping' {
    assertUuidV4(actionId, 'Action ID');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const task = this.#task(key);
      if (task.state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (this.#closed(task.status)) throw new GuardRefusal('The task is already closed.');
      const merge = this.getMergeAttempt(identity);
      if (merge && (merge.state === 'submitting' || merge.state === 'queued'))
        throw new GuardRefusal('A merge is in progress. Cancel the task after it finishes or fails.');
      const active = this.#activeAttempt(key);
      if (!active) { this.#closeTask(key, 'cancelled', actionId); return 'closed'; }
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is already being cancelled.');
      this.#run(`UPDATE attempts SET first_reason='cancelled' WHERE id=? AND first_reason IS NULL`, active.id!);
      this.#run('UPDATE tasks SET cancel_requested=? WHERE plan_key=?', actionId, key);
      this.#touch(key);
      return 'stopping';
    });
  }
  /**
   * Exact replay for writing user actions. The first definite outcome is recorded, including a guard refusal.
   * Storage errors are not recorded, so the UI may resend. The response must be JSON.
   */
  userAction<T>(identity: PlanIdentity, action: { actionId: string; kind: string; request: unknown }, apply: () => T): { response: T; replayed: boolean } {
    assertUuidV4(action.actionId, 'Action ID');
    if (typeof action.kind !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(action.kind)) throw new GuardRefusal('Invalid action kind.');
    const key = identityKey(identity), hash = requestHash(action.kind, action.request);
    const saved = () => {
      const row = this.#get('SELECT * FROM user_actions WHERE plan_key=? AND action_id=?', key, action.actionId);
      if (!row) return undefined;
      if (row.request_hash !== hash) throw new ActionIdReused('Action ID already used for a different request.');
      const outcome = decode<{ ok: boolean; value?: T; error?: string }>(row.response);
      if (!outcome.ok) throw new GuardRefusal(outcome.error!);
      return { response: outcome.value as T, replayed: true };
    };
    const record = (outcome: object) => {
      const response = encode(outcome);
      if (response.length > 65536) throw new Error('Action response is too large to record.');
      this.#run('INSERT INTO user_actions VALUES (?,?,?,?,?,?)', key, action.actionId, action.kind, hash, response, new Date().toISOString());
    };
    let replaying = false;
    try {
      return this.#transaction(() => {
        const prior = saved(); if (prior) { replaying = true; return prior; }
        const value = apply();
        record({ ok: true, value });
        return { response: value, replayed: false };
      });
    } catch (error) {
      const storage = (error as { code?: string }).code === 'ERR_SQLITE_ERROR' || error instanceof ShuttingDownError;
      if (!replaying && !storage && !(error instanceof ActionIdReused) && !(error instanceof BadRequest) && this.#depth === 0) {
        const message = error instanceof Error ? bounded(error.message) : 'Refused.';
        this.#transaction(() => { if (!this.#get('SELECT 1 FROM user_actions WHERE plan_key=? AND action_id=?', key, action.actionId)) record({ ok: false, error: message }); });
      }
      throw error;
    }
  }
  /** Append one feedback event. Call inside userAction so the event and its action share one transaction. */
  recordFeedback(identity: PlanIdentity, actionId: string, event: { kind: Exclude<FeedbackKind, 'task-closed'>; item?: string | null; text?: string | null; sourceRef: string; supersedes?: string | null; supersedeLatest?: boolean }): FeedbackEvent {
    assertUuidV4(actionId, 'Action ID');
    if (this.#depth === 0) throw new Error('Feedback events are written inside their user action.');
    if (!FEEDBACK_KINDS.includes(event.kind) || event.kind === ('task-closed' as FeedbackKind)) throw new GuardRefusal('Invalid feedback kind.');
    if (event.text != null && (typeof event.text !== 'string' || event.text.length > 4000)) throw new GuardRefusal('Feedback text is limited to 4000 characters.');
    if (typeof event.sourceRef !== 'string' || !event.sourceRef || event.sourceRef.length > 200) throw new GuardRefusal('Invalid feedback source.');
    const key = identityKey(identity), plan = this.#current(key);
    // A changed segment choice links to the latest earlier event for the same choice key.
    if (event.supersedeLatest && event.supersedes == null)
      event = { ...event, supersedes: (this.#get("SELECT id FROM feedback_events WHERE plan_key=? AND source_ref=? AND kind IN ('segment-accept','segment-assign') ORDER BY rowid DESC LIMIT 1", key, event.sourceRef)?.id as string | undefined) ?? null };
    if (event.supersedes != null && !this.#get('SELECT 1 FROM feedback_events WHERE plan_key=? AND id=? AND source_ref=?', key, event.supersedes, event.sourceRef))
      throw new GuardRefusal('A superseded event must belong to the same source.');
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.#run(`INSERT INTO feedback_events (id,plan_key,action_id,plan_revision,snapshot_id,item,kind,text,source_ref,supersedes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, key, actionId, plan.revision!, plan.snapshot_id ?? null, event.item ?? null, event.kind, event.text ?? null, event.sourceRef, event.supersedes ?? null, createdAt);
    return { id, planKey: key, actionId, planRevision: plan.revision as number, snapshotId: plan.snapshot_id as string | null, item: event.item ?? null,
      kind: event.kind, text: event.text ?? null, sourceRef: event.sourceRef, supersedes: event.supersedes ?? null, createdAt };
  }
  /** Lane J's only read path: available once the task has closed. */
  feedbackEvents(identity: PlanIdentity): FeedbackEvent[] {
    const key = identityKey(identity); this.#task(key);
    if (!this.#get("SELECT 1 FROM feedback_events WHERE plan_key=? AND kind='task-closed'", key)) throw new GuardRefusal('Feedback is available after the task closes.');
    return this.#db.prepare('SELECT * FROM feedback_events WHERE plan_key=? ORDER BY rowid').all(key).map(row => ({
      id: row.id as string, planKey: row.plan_key as string, actionId: row.action_id as string, planRevision: row.plan_revision as number,
      snapshotId: row.snapshot_id as string | null, item: row.item as string | null, kind: row.kind as FeedbackKind, text: row.text as string | null,
      sourceRef: row.source_ref as string, supersedes: row.supersedes as string | null, createdAt: row.created_at as string,
    }));
  }

  // ---- F1d: startup recovery (runner-lifecycle.md, "Startup recovery") ----
  /**
   * The per-database runner owner token, tied to the database file's device and inode.
   * A stored value that is malformed is refused; a copied database (different file identity) gets a new token.
   */
  runnerOwnerToken(file: { dev: number | bigint; ino: number | bigint }): string {
    const identity = { dev: String(file.dev), ino: String(file.ino) };
    return this.#transaction(() => {
      const row = this.#get("SELECT value FROM app_settings WHERE key='runner_owner'");
      if (row) {
        let stored: { token?: unknown; dev?: unknown; ino?: unknown };
        try { stored = decode(row.value); } catch { throw new Error('Stored runner owner token is malformed. Refusing to start.'); }
        if (typeof stored.token !== 'string' || !/^[0-9a-f]{32}$/.test(stored.token)) throw new Error('Stored runner owner token is malformed. Refusing to start.');
        if (stored.dev === identity.dev && stored.ino === identity.ino) return stored.token;
      }
      const token = randomUUID().replace(/-/g, '');
      this.#run("INSERT INTO app_settings VALUES ('runner_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encode({ token, ...identity }));
      return token;
    });
  }
  /** "Preparation starting": saved before any preparation subprocess is spawned. */
  markPreparationStarting(identity: PlanIdentity, id: string, startedAt: number): void {
    const key = identityKey(identity);
    if (this.#run(`UPDATE attempts SET preparation_started_at=? WHERE plan_key=? AND id=? AND state='pending'`, startedAt, key, id).changes !== 1)
      throw new GuardRefusal('Only a pending attempt can start preparation.');
  }
  /** The spawn failed synchronously: no child exists, so the "starting" marker must not block the next startup. */
  cancelPreparationStart(identity: PlanIdentity, id: string): void {
    this.#run(`UPDATE attempts SET preparation_started_at=NULL WHERE plan_key=? AND id=? AND preparation_pgid IS NULL AND state='pending'`, identityKey(identity), id);
  }
  /** Saved in the same synchronous turn as the spawn. */
  recordPreparationGroup(identity: PlanIdentity, id: string, pgid: number): void {
    if (!Number.isSafeInteger(pgid) || pgid < 2) throw new GuardRefusal('Invalid process group.');
    if (this.#run(`UPDATE attempts SET preparation_pgid=? WHERE plan_key=? AND id=? AND preparation_started_at IS NOT NULL`, pgid, identityKey(identity), id).changes !== 1)
      throw new GuardRefusal('Preparation was not marked as starting.');
  }
  /** F chooses the allocation ID and saves it before the asynchronous allocation starts. */
  recordAllocation(identity: PlanIdentity, id: string, allocationId: string): void {
    assertUuidV4(allocationId, 'Allocation ID');
    if (this.#run(`UPDATE attempts SET allocation_id=? WHERE plan_key=? AND id=? AND state='pending' AND allocation_id IS NULL`, allocationId, identityKey(identity), id).changes !== 1)
      throw new GuardRefusal('Allocation can be recorded once, for a pending attempt.');
  }
  /** Every non-terminal attempt, across all plans, with the fields recovery needs. */
  interruptedAttempts(): (AttemptRecord & { planKey: string; preparationPgid: number | null; preparationStartedAt: number | null; allocationId: string | null })[] {
    return this.#db.prepare("SELECT * FROM attempts WHERE state IN ('pending','running') ORDER BY rowid").all().map(row => ({
      ...this.#attemptRecord(row), planKey: row.plan_key as string, preparationPgid: row.preparation_pgid as number | null,
      preparationStartedAt: row.preparation_started_at as number | null, allocationId: row.allocation_id as string | null,
    }));
  }
  /**
   * Startup recovery step 3, finalization phase: one transaction. Applies the settlement precedence to every
   * leftover attempt, keeps the closed-task and pending-cancel guards, and sets the requeue claim.
   */
  recoverInterrupted(now: number, exports: Readonly<Record<string, { diagnosticRef?: string; failure?: string }>> = {}): { attemptId: string; planKey: string; state: string; requeued: boolean }[] {
    const gated = ['needs human', 'needs amendment', 'needs approval', 'possibly already fixed'];
    return this.#transaction(() => this.#db.prepare("SELECT * FROM attempts WHERE state IN ('pending','running') ORDER BY rowid").all().map(row => {
      const key = row.plan_key as string, task = this.#task(key);
      const contextCurrent = sameContext(decode<InvocationContext>(row.context), this.#contextOf(key));
      let firstReason = row.first_reason as FirstReason | null;
      if (firstReason === null && contextCurrent && task.budget_deadline !== null && now >= (task.budget_deadline as number)) firstReason = 'time-limit';
      const deadlinePassed = firstReason === null && now >= (row.deadline as number);
      const outcome = classifySettlement({
        firstReason, contextCurrent, exitCode: null, valid: false,
        stopReason: (row.stop_reason as StopReason | null) ?? (deadlinePassed ? 'timeout' : undefined),
        detail: 'Interrupted: codeboost stopped while this was running',
      });
      const exported = exports[row.id as string];
      const diagnostic = exported?.failure ? `${outcome.reason ?? ''} Partial output could not be exported: ${exported.failure}`.trim() : outcome.reason;
      this.#run(`UPDATE attempts SET state=?, first_reason=?, diagnostic=?, diagnostic_ref=COALESCE(?, diagnostic_ref), settled_at=? WHERE id=?`,
        outcome.state, firstReason, bounded(diagnostic ?? ''), exported?.diagnosticRef ?? null, new Date(now).toISOString(), row.id!);
      let requeued = false;
      if (task.cancel_requested !== null && !this.#closed(task.status)) this.#closeTask(key, 'cancelled', task.cancel_requested as string);
      else {
        if (outcome.timeLimit && !this.#closed(task.status)) this.#run(`UPDATE tasks SET status='needs human' WHERE plan_key=?`, key);
        const status = this.#task(key).status as string;
        const interrupted = outcome.state === 'failed' && (outcome.reason ?? '').startsWith('Interrupted');
        const shutdown = outcome.state === 'cancelled' && firstReason === 'shutdown';
        if (!this.#closed(status) && !gated.includes(status) && (interrupted || shutdown)) {
          this.#run('UPDATE tasks SET requeue_pending=1 WHERE plan_key=?', key); requeued = true;
        }
        this.#touch(key);
      }
      return { attemptId: row.id as string, planKey: key, state: outcome.state, requeued };
    }));
  }
  /** Tasks whose confirmed merge lacks its closed status or task-closed event (recovery step 5). */
  reconcileMergedTasks(): string[] {
    return this.#transaction(() => {
      const repaired: string[] = [];
      for (const task of this.#db.prepare('SELECT plan_key, status FROM tasks').all()) {
        const key = task.plan_key as string;
        const latest = this.#get('SELECT id,data FROM merge_attempts WHERE key=? ORDER BY rowid DESC LIMIT 1', key);
        if (!latest || decode<MergeAttempt>(latest.data).state !== 'merged') continue;
        const hasEvent = this.#get("SELECT 1 FROM feedback_events WHERE plan_key=? AND kind='task-closed'", key);
        if (task.status === 'merged' && hasEvent) continue;
        this.#closeTask(key, 'merged', latest.id as string); repaired.push(key);
      }
      return repaired;
    });
  }

  /** Which plan owns an attempt ID, across all plans; null if none. */
  attemptOwner(attemptId: string): string | null {
    return (this.#get('SELECT plan_key FROM attempts WHERE id=?', attemptId)?.plan_key as string | undefined) ?? null;
  }
  /** Interrupted rebases recorded by F3 (none exist before F3). */
  rebasesInProgress(): { planKey: string; marker: unknown }[] {
    return this.#db.prepare('SELECT plan_key, rebase_in_progress FROM tasks WHERE rebase_in_progress IS NOT NULL').all()
      .map(row => ({ planKey: row.plan_key as string, marker: decode(row.rebase_in_progress) }));
  }
  /** After --release-preparation verified the directory is unused: clear the "starting" marker of a terminal attempt. */
  clearPreparationMarker(attemptId: string): boolean {
    return this.#run(`UPDATE attempts SET preparation_started_at=NULL WHERE id=? AND preparation_pgid IS NULL AND state NOT IN ('pending','running')`, attemptId).changes === 1;
  }
  /** Terminal attempts whose preparation started but whose process group was never saved. */
  unownedPreparations(): string[] {
    return this.#db.prepare(`SELECT id FROM attempts WHERE preparation_started_at IS NOT NULL AND preparation_pgid IS NULL AND state NOT IN ('pending','running')`).all().map(row => row.id as string);
  }

}

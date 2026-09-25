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
export interface ReviewState { revision: number; snapshotId: string; reviewVersion?: number }
export type SuggestionState = 'pending' | 'ready' | 'failed' | 'cancelled' | 'invalidated' | 'consumed';
export interface SuggestionRequest { state: SuggestionState; revision: number; snapshotId: string | null; reply: EditReply | null; reason: string | null }
export interface SnippetReference { key: string; path: string; side: 'old' | 'new'; start: number; end: number; text: string; head: string; base: string }
export interface QuestionAnswer { provider?: 'claude' | 'codex'; attempt: string; contextId?: string; status: 'pending' | 'complete' | 'failed'; expiresAt: number; text?: string; error?: string }
export interface ReviewNote { id: string; item: string; kind: 'question' | 'change'; text: string; reference?: SnippetReference; answer?: QuestionAnswer; createdAt: string; revision: number; snapshotId: string }
export type MergeAttemptState = 'submitting' | 'queued' | 'merged' | 'removed' | 'failed';
export interface MergeAttempt {
  id: string; state: MergeAttemptState; revision: number; snapshotId: string; reviewVersion: number; reviewedHead: string;
  queueWatermark?: string | null;
  url: string | null; reason: string | null; requiresFreshReview: boolean; entryId: string | null;
  phase: 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED' | null; position: number | null;
  occurredAt: string | null; createdAt: string; updatedAt: string;
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
        const version = this.#get('PRAGMA user_version')!.user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('Unsupported store schema version.');
        if (version === 5) return;
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
    if (row.revision !== expected.revision || row.snapshot_id !== expected.snapshotId ||
        (expected.reviewVersion !== undefined && row.review_version !== expected.reviewVersion)) throw new Error('Stale review state. Reload before writing.');
  }
  #context(key: string, context: PlanContext): void {
    if (identityKey(context.identity) !== key || context.issue !== this.#current(key).issue) throw new Error('Plan context identity/issue mismatch.');
  }
  #savePlan(key: string, plan: Plan, expected: number): void {
    if (this.#run('UPDATE plans SET revision=? WHERE key=? AND revision=?', plan.revision, key, expected).changes !== 1) throw new Error('Stale plan revision.');
    this.#run('INSERT INTO revisions VALUES (?,?,?)', key, plan.revision, encode(plan));
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
  beginMergeAttempt(identity: PlanIdentity, expected: ReviewState & { reviewVersion: number }, reviewedHead: string, queueWatermark: string | null = null): MergeAttempt {
    sha(reviewedHead);
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
        id: randomUUID(), state: 'submitting', revision: expected.revision, snapshotId: expected.snapshotId,
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
    return this.#changeMergeAttempt(identity, id, ['submitting','queued'], attempt => ({
      ...attempt, state: outcome.state, reason: outcome.state === 'merged' ? null : outcome.reason!.trim(),
      occurredAt: outcome.occurredAt ?? null, requiresFreshReview: outcome.requiresFreshReview === true,
    }));
  }
  getMergeAttempt(identity: PlanIdentity): MergeAttempt | null {
    this.#current(identityKey(identity));
    const row = this.#get('SELECT data FROM merge_attempts WHERE key=? ORDER BY rowid DESC LIMIT 1', identityKey(identity));
    return row ? decode<MergeAttempt>(row.data) : null;
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
}

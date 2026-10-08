import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { importPlan, applySuggestion, assertEditReply, assertPlan, isRepoPath, validateContinuationPlan, type ContinuationBinding, type Plan, type PlanContext, type PlanItem, type EditReply } from '../core/plan.ts';
import { stable } from '../core/approvals.ts';
import type { PlanningMode } from '../core/planning-suggestions.ts';
import type { Approval, SegmentChoice } from '../core/approvals.ts';
import type { InvocationContext, StopReason } from '../agents/contract.ts';
import type { AlreadyFixedResult } from '../github/already-fixed.ts';
import {
  ATTEMPT_PHASES, BadRequest, CLOSED_STATUSES, HUMAN_GATES, MERGEABLE_STATUSES, ShuttingDownError, type ShutdownCapability, DEFAULT_TASK_BUDGET_MS, FIRST_REASONS, GuardRefusal, UpstreamFailure, ActionIdReused, RefusalWithEffect, MAX_RESULT_BYTES, TASK_STATUSES, TERMINAL_STATES,
  WRITABLE_KINDS, assertUuidV4, bounded, classifySettlement, requestHash, sameContext,
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
export type { PlanningMode } from '../core/planning-suggestions.ts';
/** `reply` is the suggestion cards; for a draft it is always null here (read it with `getDraft`). */
export interface SuggestionRequest { mode: PlanningMode; state: SuggestionState; revision: number; snapshotId: string | null; reply: EditReply | null; reason: string | null }
/** A draft request: `revision` is the plan revision it was drafted against; `plan` would become revision + 1. */
export interface DraftRequest { state: SuggestionState; revision: number; snapshotId: string | null; plan: Plan | null; reason: string | null }
export interface SnippetReference { key: string; path: string; side: 'old' | 'new'; start: number; end: number; text: string; head: string; base: string }
export interface QuestionAnswer { provider?: 'claude' | 'codex'; attempt: string; contextId?: string; status: 'pending' | 'complete' | 'failed'; expiresAt: number; text?: string; error?: string }
export interface ReviewNote { id: string; item: string; kind: 'question' | 'change'; text: string; reference?: SnippetReference; answer?: QuestionAnswer; createdAt: string; revision: number; snapshotId: string }
/** A PR codeboost opened (or is opening) for a task. `opening` means the outcome of the GitHub call is not yet known. */
export interface TaskPullRequest {
  openingId: string; repository: string; base: string; headBranch: string; headSha: string; draft: boolean;
  state: 'opening' | 'opened' | 'abandoned'; number: number | null; url: string | null; createdAt: string;
  /** The task state version this opening owns; only a response for that exact version may change the task status. */
  ownerVersion: number;
  /** The plan's review version this opening owns: review input (approvals, choices, notes) since then makes it stale. */
  ownerReviewVersion: number;
  /** An update of this open PR that started and has not been confirmed; the PR may already show it. */
  refresh: { head: string; draft: boolean; stateVersion: number } | null;
}
export interface AlreadyFixedCheck { id: string; snapshotId: string; result: AlreadyFixedResult; stateVersion: number; reviewVersion: number; checkedAt: string }
export type MergeAttemptState = 'submitting' | 'queued' | 'merged' | 'removed' | 'failed';
export interface MergeAttempt {
  id: string; kind: 'queue' | 'direct'; state: MergeAttemptState; revision: number; snapshotId: string; reviewVersion: number; reviewedHead: string;
  queueWatermark?: string | null;
  url: string | null; reason: string | null; requiresFreshReview: boolean; entryId: string | null;
  phase: 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED' | null; position: number | null;
  occurredAt: string | null; createdAt: string; updatedAt: string;
  /** The user action that started this attempt; its saved replay response follows the attempt. */
  actionId?: string | null;
  /**
   * The PR this attempt merges (#121). Reconciliation and queue polls read this PR, never one resolved again. Attempts saved
   * before #121 have none: they targeted the configured `github.pullRequest`.
   */
  pullRequest?: number | null;
}
/** Saved replay response for the user action that started a merge; refreshed on every attempt change. */
export function mergeActionResponse(attempt: MergeAttempt) {
  return { attemptId: attempt.id, state: attempt.state, reason: attempt.reason, url: attempt.url };
}
/**
 * The last publish of a task (#103), as GET /api/runner shows it. `outcome` is the publisher's outcome kind, or `refused`
 * (a guard or GitHub refusal a person acts on), `failed` (anything else) or `stopped` (shutdown). `stateVersion` is the
 * task's state version when it was recorded: a publish owed since then has not run yet.
 */
export interface PublishRecord {
  outcome: string; draft: boolean; message: string; stateVersion: number; at: string; number?: number; url?: string;
  /** `close`: the record is a cancelled task's PR close (#111), whose settled outcome is `closed`. Absent: a publish. */
  action?: 'close';
  /** An `opened` outcome that left the PR or the task not where the publish meant them: still owed (#103). */
  reconcile?: boolean;
}
/** What the publish action replays once its publish has settled: the outcome, as `publish.last` shows it. */
export function publishActionResponse(record: PublishRecord) {
  return { outcome: record.outcome, draft: record.draft, message: record.message, ...(record.action ? { action: record.action } : {}), ...(record.reconcile ? { reconcile: true } : {}), ...(record.number === undefined ? {} : { number: record.number }),
    ...(record.url === undefined ? {} : { url: record.url }) };
}
export interface PreMergeActionResult {
  state: 'ready' | 'review-required' | 'failed';
  base: string; head: string; checked: readonly string[]; reason: string | null;
}
export interface PreMergeReadiness {
  stateVersion: number; reviewVersion: number; snapshotId: string; base: string; head: string;
}
export const MAX_REWRITE_LINEAGE_ROWS = 1_000;
/** What a completed `prepare-merge` action replays after its background coordinator settles. */
export function preMergeActionResponse(result: PreMergeActionResult) {
  return { outcome: result.state, base: result.base, head: result.head, checked: result.checked, reason: result.reason };
}
export interface TaskRecord {
  planKey: string; status: TaskStatus; stateVersion: number; contextGeneration: number; assignmentId: string; referencedCodeHash: string;
  currentAttemptId: string | null; requeuePending: boolean; cancelRequested: string | null; rebaseInProgress: unknown; budgetDeadline: number | null;
  createdAt: string; updatedAt: string;
}
export interface RebaseMarker {
  attemptId: string;
  oldBase: string;
  oldHead: string;
  onto: string;
  oldHistory: string[] | null;
  startedAt: number;
  resultState: 'none' | 'prepared' | 'uncertain' | 'refused' | 'ready';
  resultHead: string | null;
  resultMappings: { oldSha: string; newSha: string }[] | null;
  /** Source commits whose foreign conflicts were resolved by the sandboxed F4 agent. */
  resolvedConflicts: string[];
  /** The one sandboxed child whose Docker/storage resources the parent rebase currently owns. */
  conflict: { attemptId: string; allocationId: string; networkAllocationId: string; source: string } | null;
  processGroup: { pgid: number; startedAt: number; identity: string | null } | 'spawning' | 'unsettled' | null;
}
export interface AttemptRecord {
  id: string; kind: AttemptKind; phase: string; item: string | null; state: AttemptState; context: InvocationContext; deadline: number;
  firstReason: FirstReason | null; stopReason: StopReason | null; exitCode: number | null; signal: string | null; result: unknown;
  diagnostic: string | null; diagnosticRef: string | null; createdAt: string; startedAt: string | null; settledAt: string | null;
  /**
   * The runner's own audit found a safety violation (#87 item 3): its text, kept whatever outcome the attempt settled
   * with. The terminal write (or startup recovery) acted on it: the task went to needs human, unless it was closed.
   */
  safetyFinding: string | null;
  /** Digest and count of the exact issue comments carried by this attempt's prompt. */
  promptComments: { count: number; digest: string; state: 'prepared' | 'delivered' } | null;
}
export interface IssueTrustRecord {
  repository: string; issue: number; authorLogin: string | null; trustedBy: string; trustedAt: string; revokedAt: string | null;
}
/** A non-terminal attempt at startup, with what recovery needs to stop its preparation and export its storage. */
export interface InterruptedAttempt extends AttemptRecord {
  planKey: string; preparationPgid: number | null; preparationStartedAt: number | null; preparationIdentity: string | null;
  allocationId: string | null;
  /** Saved after D's allocation returned (#91); null when it never did. */
  metadataBaseline: string | null; storageBase: string | null;
}
export type FeedbackKind = 'reject' | 'change-request' | 'segment-accept' | 'segment-assign' | 'finding-accept' | 'needs-human-guidance' | 'task-closed';
const FEEDBACK_KINDS: readonly FeedbackKind[] = ['reject', 'change-request', 'segment-accept', 'segment-assign', 'finding-accept', 'needs-human-guidance', 'task-closed'];
export interface FeedbackEvent {
  id: string; planKey: string; actionId: string; planRevision: number; snapshotId: string | null; item: string | null;
  kind: FeedbackKind; text: string | null; sourceRef: string; supersedes: string | null; createdAt: string;
}
export interface LedgerEntry {
  sha: string; owner: string | null; origin: 'owned' | 'foreign'; sourceSha: string | null;
  /** True only on a rewritten foreign commit whose conflict a sandboxed agent resolved. */
  conflictResolved?: boolean;
}
export interface Checkpoint {
  id: string; revision: number; snapshotId: string; item: string;
  /** Runner-audited actual tree, retained separately from the declared plan. */
  baseEntries: PlanContext['baseEntries']; completedItems: string[]; outOfScopePaths: string[];
  /** Present on new checkpoints; absent on pre-continuation rows whose saved tree was only the original base tree. */
  treeHead?: string;
}
type ExecutionResultLike = { head?: unknown; unchanged?: unknown };
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
  #pathKey: (path: string) => string;
  #assertValidItemPaths(item: PlanItem): void {
    const paths: string[] = [];
    for (const file of item.files) {
      if ((file.kind === 'rename') !== (file.renamed_from !== null))
        throw new GuardRefusal(`Completed checkpoint item ${item.id} has invalid or overlapping file declarations.`);
      for (const path of file.kind === 'rename' ? [file.path, file.renamed_from!] : [file.path]) {
        if (!isRepoPath(path))
          throw new GuardRefusal(`Completed checkpoint item ${item.id} has invalid or overlapping file declarations.`);
        const key = this.#pathKey(path);
        if (paths.some(other => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`)))
          throw new GuardRefusal(`Completed checkpoint item ${item.id} has invalid or overlapping file declarations.`);
        paths.push(key);
      }
    }
  }
  constructor(path: string, pathKey: (path: string) => string = value => value) {
    requireSupportedNode();
    this.#pathKey = pathKey;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#transaction(() => {
        const version = this.#get('PRAGMA user_version')!.user_version as number;
        if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].includes(version)) throw new Error('Unsupported store schema version.');
        if (version === 17) return;
        if (version === 0) this.#db.exec(`
          CREATE TABLE plans (key TEXT PRIMARY KEY, issue INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_id TEXT);
          CREATE TABLE revisions (key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,revision));
          CREATE TABLE snapshots (key TEXT NOT NULL REFERENCES plans(key), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,id));
          CREATE TABLE requests (id TEXT PRIMARY KEY, key TEXT NOT NULL REFERENCES plans(key), revision INTEGER NOT NULL, state TEXT NOT NULL, reply TEXT, continuation TEXT);
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
        if (version < 7) this.#migrateV7();
        // A safety finding outlives the process that found it (#87 item 3).
        // Idempotent, like the v7 tables: a database moved back to an older version keeps the column.
        if (version < 8) {
          if (!this.#db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'safety_finding'))
            this.#db.exec('ALTER TABLE attempts ADD COLUMN safety_finding TEXT');
          this.#db.exec('PRAGMA user_version=8');
        }
        // What startup recovery needs to export a recovered task storage (#91): D's metadata baseline and the commit the
        // storage was seeded from. Idempotent, like v8.
        if (version < 9) {
          const columns = this.#db.prepare('PRAGMA table_info(attempts)').all().map(column => column.name);
          if (!columns.includes('metadata_baseline')) this.#db.exec('ALTER TABLE attempts ADD COLUMN metadata_baseline TEXT');
          if (!columns.includes('storage_base')) this.#db.exec('ALTER TABLE attempts ADD COLUMN storage_base TEXT');
          this.#db.exec('PRAGMA user_version=9');
        }
        // The last publish of each task (#103): what GET /api/runner shows, kept across restarts so a refusal stays visible.
        // A task already running or in needs human reached that status before codeboost published anything: it is recorded as
        // not published, at its current state version, so the first start after the upgrade opens no PR a person did not ask
        // for. The publish action publishes it.
        if (version < 10) {
          this.#db.exec('CREATE TABLE IF NOT EXISTS publish_outcomes (plan_key TEXT PRIMARY KEY REFERENCES tasks(plan_key), data TEXT NOT NULL)');
          this.#run(`INSERT OR IGNORE INTO publish_outcomes (plan_key,data) SELECT plan_key, json_object('outcome','not published','draft',json('false'),
            'message','This task reached its status before codeboost published pull requests. Use the publish action to publish it.',
            'stateVersion',state_version,'at',?) FROM tasks WHERE status IN ('running','needs human')`, new Date().toISOString());
          this.#db.exec('PRAGMA user_version=10');
        }
        // Planning requests carry their mode (#124): every earlier request is a suggestion. Idempotent, like v8.
        if (version < 11) {
          if (!this.#db.prepare('PRAGMA table_info(requests)').all().some(column => column.name === 'mode'))
            this.#db.exec("ALTER TABLE requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'suggest'");
          this.#db.exec('PRAGMA user_version=11');
        }
        // Choices written before review-version ordering existed must not become an infinite threshold. Give every
        // legacy choice the review version at upgrade. Legacy approvals are already invalid for execution, so remove
        // them too: the review UI then renders those items unreviewed and permits the fresh approvals that must follow.
        if (version < 12) {
          const changed = new Set<string>();
          for (const row of this.#db.prepare('SELECT key,choice_key,data FROM choices').all()) {
            const choice = decode<SegmentChoice & ReviewState>(row.data);
            if (Number.isSafeInteger(choice.reviewVersion) && choice.reviewVersion! >= 0) continue;
            const boundary = this.#current(row.key as string).review_version as number;
            this.#run('UPDATE choices SET data=? WHERE key=? AND choice_key=?', encode({ ...choice, reviewVersion: boundary }), row.key!, row.choice_key!);
            changed.add(row.key as string);
          }
          for (const row of this.#db.prepare('SELECT key,item,data FROM approvals').all()) {
            const approval = decode<Approval & ReviewState>(row.data);
            if (Number.isSafeInteger(approval.reviewVersion) && approval.reviewVersion! >= 0) continue;
            this.#run('DELETE FROM approvals WHERE key=? AND item=?', row.key!, row.item!);
            changed.add(row.key as string);
          }
          for (const key of changed) this.#run('UPDATE plans SET review_version=review_version+1 WHERE key=?', key);
          this.#db.exec('PRAGMA user_version=12');
        }
        // A finding persisted behind a human gate still owes its escalation after restart.
        if (version < 13) {
          if (!this.#db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'safety_owed'))
            this.#db.exec('ALTER TABLE attempts ADD COLUMN safety_owed INTEGER NOT NULL DEFAULT 0 CHECK (safety_owed IN (0,1))');
          this.#db.exec('PRAGMA user_version=13');
        }
        // Bind a continuation decision to the reviewed snapshot. Old rows had no such binding and cannot admit work.
        if (version < 14) {
          if (!this.#db.prepare('PRAGMA table_info(continuations)').all().some(column => column.name === 'snapshot_id'))
            this.#db.exec('ALTER TABLE continuations ADD COLUMN snapshot_id TEXT');
          this.#db.exec('PRAGMA user_version=14');
        }
        // Planning output is bound to the checkpoint tree/prefix used to validate it.
        if (version < 15) {
          if (!this.#db.prepare('PRAGMA table_info(requests)').all().some(column => column.name === 'continuation'))
            this.#db.exec('ALTER TABLE requests ADD COLUMN continuation TEXT');
          this.#db.exec('PRAGMA user_version=15');
        }
        // A process group can be signalled after a crash only when its exact kernel identity still matches.
        if (version < 16) {
          if (!this.#db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'preparation_identity'))
            this.#db.exec('ALTER TABLE attempts ADD COLUMN preparation_identity TEXT');
          this.#db.exec('PRAGMA user_version=16');
        }
        // Repository-scoped issue trust and the exact comment-set evidence carried by execute prompts (#108).
        if (version < 17) {
          this.#db.exec(`CREATE TABLE IF NOT EXISTS issue_trust (
            repository TEXT NOT NULL, issue INTEGER NOT NULL, author_login TEXT, trusted_by TEXT NOT NULL,
            trusted_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY(repository,issue));`);
          if (!this.#db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'prompt_comments'))
            this.#db.exec('ALTER TABLE attempts ADD COLUMN prompt_comments TEXT');
          this.#db.exec('PRAGMA user_version=17');
        }
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  questionProvider(): 'claude' | 'codex' | null {
    const value=this.#get("SELECT value FROM app_settings WHERE key='question_provider'")?.value;
    return value==='claude'||value==='codex'?value:null;
  }
  setQuestionProvider(value: unknown): void {
    // Codex cannot answer questions yet (#75). A database that already names it reads back as Codex, and Ask refuses it.
    if(value==='codex') throw new Error('Codex cannot answer questions yet. Choose Claude Code.');
    if(value!==null&&value!=='claude') throw new Error('Choose Claude Code.');
    this.#run("INSERT INTO app_settings VALUES ('question_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value??'');
  }
  close(): void { this.#db.close(); }
  #get(sql: string, ...args: SQLInputValue[]) { return this.#db.prepare(sql).get(...args); }
  #run(sql: string, ...args: SQLInputValue[]) {
    this.#checkWrite();
    // Some errors (for example a full disk) make SQLite roll back on its own. If the caller caught one, a later write must
    // not autocommit on its own while the rest of the transaction is lost.
    if (this.#depth > 0 && !this.#db.isTransaction)
      throw Object.assign(new Error('SQLite rolled back the transaction after an earlier error.'), { code: 'ERR_SQLITE_ERROR' });
    return this.#db.prepare(sql).run(...args);
  }
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
  /** The user action whose transaction is open, so its events can prove they belong to it. */
  #action: { key: string; actionId: string } | null = null;
  /** Callbacks waiting for the outermost transaction to end, in the order they were registered. */
  #pending: { commit: () => void; rollback?: () => void }[] = [];
  /** Nested calls join the outer transaction, so a user action can wrap existing Store methods atomically. */
  #transaction<T>(fn: () => T): T {
    if (this.#depth > 0) { this.#depth++; try { return fn(); } finally { this.#depth--; } }
    this.#checkWrite();
    this.#db.exec('BEGIN IMMEDIATE'); this.#depth = 1;
    let result: T, committed = false;
    try { result = fn(); this.#db.exec('COMMIT'); committed = true; }
    // A failed COMMIT may already have rolled back (for example a full disk); ROLLBACK would then hide the real error.
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    finally {
      this.#depth = 0;
      if (this.#pending.length) {
        const pending = this.#pending; this.#pending = [];
        for (const entry of pending) Store.#callback(committed ? entry.commit : entry.rollback);
      }
    }
    return result;
  }
  /** A callback runs after the transaction has ended; a throw must not make a committed write look failed. */
  static #callback(fn: (() => void) | undefined): void {
    if (!fn) return;
    try { fn(); } catch (error) { console.error(`A transaction callback failed: ${JSON.stringify(bounded(error instanceof Error ? error.message : String(error)))}`); }
  }
  /**
   * Run `commit` once the writes made so far are durable: at once outside a transaction (a throw then reaches the
   * caller), otherwise after the outermost transaction commits (a throw is logged). If it rolls back instead, including
   * when COMMIT itself fails, `commit` is dropped and `rollback` runs. Lets a caller apply an in-memory effect that cannot
   * be undone only once the write that records it has committed (#79).
   */
  afterCommit(commit: () => void, rollback?: () => void): void {
    if (this.#depth === 0) commit();
    else this.#pending.push({ commit, rollback });
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
    // A plan edit must not land while GitHub may still merge the head reviewed against the current revision.
    if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    if (this.#taskClosed(key)) throw new GuardRefusal('A closed task never changes.');
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
      const progress = this.continuationBasis(context.identity);
      const plan = importPlan(source, format, context, expected + 1, progress?.completed).plan;
      if (progress) this.continuationProgress(context.identity, plan);
      this.#savePlan(key, plan, expected); return plan;
    });
  }
  #snapshot(key: string, base: string, head: string): Snapshot {
    sha(base); sha(head);
    const snapshot = { id: randomUUID(), base, head };
    this.#run('INSERT INTO snapshots VALUES (?,?,?)', key, snapshot.id, encode(snapshot));
    this.#run('UPDATE plans SET snapshot_id=? WHERE key=?', snapshot.id, key);
    // HEAD is still observed after a task closes (the review screen reads it), but a closed task never changes.
    if (!this.#taskClosed(key)) this.#bumpContext(key);
    this.#run("UPDATE requests SET state='invalidated',reason='Repository snapshot changed.' WHERE key=? AND state IN ('pending','ready')", key);
    return snapshot;
  }
  getSnapshot(identity: PlanIdentity, id?: string): Snapshot {
    const key = identityKey(identity);
    const row = this.#get('SELECT data FROM snapshots WHERE key=? AND id=?', key, id ?? this.#current(key).snapshot_id!);
    if (!row) throw new Error('Unknown snapshot.');
    return decode<Snapshot>(row.data);
  }
  /** `mode` is required, so a caller cannot record a draft as a suggestion by leaving it out (#124). */
  beginSuggestions(identity: PlanIdentity, expected: ReviewState, mode: PlanningMode, continuation: ContinuationBinding | null = null): string {
    if (mode !== 'suggest' && mode !== 'draft') throw new Error('Invalid planning request mode.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const basis = this.continuationBasis(identity), currentBinding = basis ? { checkpointId: basis.checkpoint.id, head: basis.head, completedItems: basis.completed } : null;
      if (stable(continuation) !== stable(currentBinding)) throw new Error('Stale continuation context. Reload before requesting planning.');
      const id = randomUUID();
      this.#run("INSERT INTO requests (id,key,revision,state,reply,snapshot_id,reason,mode,continuation) VALUES (?,?,?,'pending',NULL,?,NULL,?,?)",
        id, key, expected.revision, expected.snapshotId, mode, continuation === null ? null : encode(continuation)); return id;
    });
  }
  /**
   * Publish a request's validated reply, by the request's own mode: suggestion cards against the current revision, or
   * a draft plan of the next revision for the plan's issue. The full plan checks run again when a draft is applied.
   */
  completeSuggestions(identity: PlanIdentity, id: string, reply: unknown, candidatePlans?: Plan[]): boolean {
    const key = identityKey(identity);
    return this.#transaction(() => {
      const current = this.#current(key);
      const row = this.#get('SELECT mode,continuation FROM requests WHERE id=? AND key=? AND state=\'pending\'', id, key);
      if (!row) throw new Error('Planning request is stale, cancelled, or complete.');
      const binding = row.continuation === null ? null : decode<ContinuationBinding>(row.continuation);
      const basis = this.continuationBasis(identity), currentBinding = basis ? { checkpointId: basis.checkpoint.id, head: basis.head, completedItems: basis.completed } : null;
      if (stable(binding) !== stable(currentBinding)) {
        this.#run("UPDATE requests SET state='invalidated',reason='Checkpoint continuation changed during authoring.' WHERE id=? AND key=? AND state='pending'", id, key);
        return false;
      }
      if (binding !== null) {
        const candidates = candidatePlans ?? [];
        const expectedCount = row.mode === 'draft' ? 1 : (assertEditReply(reply), reply.edits.length);
        if (candidates.length !== expectedCount) throw new Error('Validated continuation candidates are required before publishing this reply.');
        for (const candidate of candidates) this.continuationProgress(identity, candidate);
      }
      const fits = row?.mode === 'draft' ? (assertPlan(reply), reply.revision === (current.revision as number) + 1 && reply.issue === current.issue)
        : (assertEditReply(reply), reply.base_revision === current.revision);
      if (!fits || this.#run("UPDATE requests SET state='ready',reply=?,reason=NULL WHERE id=? AND key=? AND revision=? AND snapshot_id=? AND state='pending'", encode(reply), id, key, current.revision!, current.snapshot_id!).changes !== 1)
        throw new Error(`${row?.mode === 'draft' ? 'Draft' : 'Suggestion'} request is stale, cancelled, or complete.`);
      return true;
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
  /**
   * `target`: the PR the attempt merges. With an `openingId` (the task's published PR, #121), that opening must still be
   * the task's opened record in its base whose opening began last, with that number, and no opening or update of the
   * task's PRs may be in flight.
   */
  beginMergeAttempt(identity: PlanIdentity, expected: ReviewState & { reviewVersion: number }, reviewedHead: string, queueWatermark: string | null = null, kind: MergeAttempt['kind'] = 'queue', actionId: string | null = null, expectedTaskStateVersion: number | null = null,
    target: { pullRequest: number; openingId: string | null } | null = null, requirePreparation = false): MergeAttempt {
    sha(reviewedHead);
    if (target !== null && (!Number.isSafeInteger(target.pullRequest) || target.pullRequest < 1 || (target.openingId !== null && typeof target.openingId !== 'string')))
      throw new Error('Invalid merge target.');
    if (actionId !== null) assertUuidV4(actionId, 'Action ID');
    if (!['queue','direct'].includes(kind)) throw new Error('Invalid merge attempt kind.');
    if (queueWatermark !== null && (typeof queueWatermark !== 'string' || !queueWatermark || queueWatermark.length > 512)) throw new Error('Invalid merge-queue event cursor.');
    if (!Number.isSafeInteger(expected.reviewVersion) || expected.reviewVersion < 0) throw new Error('A current review version is required for merging.');
    const key = identityKey(identity);
    if (expectedTaskStateVersion !== null && (!Number.isSafeInteger(expectedTaskStateVersion) || expectedTaskStateVersion < 0))
      throw new Error('Invalid expected task state version.');
    return this.#transaction(() => {
      this.#expect(key, expected);
      // A merge is irreversible: a closed task, a pending cancel or any task change since the click refuses it.
      const task = this.#task(key);
      if (this.#closed(task.status as TaskStatus)) throw new GuardRefusal(`The task is ${task.status}; it cannot be merged.`);
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is being cancelled; it cannot be merged.');
      if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is in progress for this task.');
      if (!MERGEABLE_STATUSES.includes(task.status as TaskStatus)) throw new GuardRefusal(`The task is ${task.status}; merge it from review.`);
      if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is still active for this task; it cannot be merged.');
      if (expectedTaskStateVersion !== null && task.state_version !== expectedTaskStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (requirePreparation && !this.preMergeReady(identity, {
        stateVersion: task.state_version as number, reviewVersion: expected.reviewVersion,
        snapshotId: expected.snapshotId, base: this.getSnapshot(identity).base, head: reviewedHead,
      })) throw new GuardRefusal('Pre-merge preparation has not completed for the current review. Prepare the merge again.');
      const current = this.getMergeAttempt(identity);
      if (current?.state === 'submitting' || current?.state === 'queued') throw new Error('A merge-queue attempt is already active.');
      if (current?.state === 'merged') throw new Error('The reviewed pull request is already merged.');
      if (target?.openingId) {
        if (this.#get("SELECT 1 FROM task_pull_requests WHERE plan_key=? AND (state='opening' OR refresh_head IS NOT NULL)", key))
          throw new GuardRefusal('The task\'s pull request is being opened or updated. Wait for publishing to finish, then refresh.');
        const row = this.#get('SELECT rowid, state, number, base, repository FROM task_pull_requests WHERE plan_key=? AND opening_id=?', key, target.openingId);
        const newer = row && this.#get("SELECT 1 FROM task_pull_requests WHERE plan_key=? AND state='opened' AND rowid>? AND base=? AND lower(repository)=lower(?)",
          key, row.rowid as number, row.base as string, row.repository as string);
        if (row?.state !== 'opened' || row.number !== target.pullRequest || newer) throw new GuardRefusal('The task\'s pull request changed during merge validation. Refresh before merging.');
      }
      const now = new Date().toISOString();
      const attempt: MergeAttempt = {
        id: randomUUID(), kind, state: 'submitting', revision: expected.revision, snapshotId: expected.snapshotId,
        reviewVersion: expected.reviewVersion, reviewedHead, queueWatermark, url: null, reason: null, requiresFreshReview: false,
        entryId: null, phase: null, position: null, occurredAt: null, createdAt: now, updatedAt: now, actionId, pullRequest: target?.pullRequest ?? null,
      };
      this.#run('INSERT INTO merge_attempts VALUES (?,?,?)', attempt.id, key, encode(attempt));
      this.#touch(key);
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
      const next = { ...change(attempt), updatedAt: new Date().toISOString() };
      if (this.#run('UPDATE merge_attempts SET data=? WHERE id=? AND key=?', encode(next), id, key).changes !== 1) return false;
      // A merge attempt change is a durable task change: bump the state version, not the context generation.
      this.#touch(key);
      // The same transaction refreshes the starting action's replay, so a resent merge click reports this outcome.
      if (next.actionId) this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND action_id=? AND json_extract(response,'$.ok')=1`,
        encode({ ok: true, value: mergeActionResponse(next) }), key, next.actionId);
      return true;
    });
  }
  queueMergeAttempt(identity: PlanIdentity, id: string, url: string): boolean {
    if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//.test(url)) throw new Error('Invalid merge result URL.');
    // Idempotent from 'queued': a poll may have observed the queue entry first, and the URL must still be saved.
    return this.#changeMergeAttempt(identity, id, ['submitting', 'queued'], attempt => ({ ...attempt, state: 'queued', url, reason: null }));
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
    state: 'merged' | 'removed' | 'failed'; reason?: string; occurredAt?: string; requiresFreshReview?: boolean; url?: string;
  }): boolean {
    if (outcome.url !== undefined && (typeof outcome.url !== 'string' || outcome.url.length > 2048 || !/^https:\/\//.test(outcome.url))) throw new Error('Invalid merge result URL.');
    if (!['merged','removed','failed'].includes(outcome.state)) throw new Error('Invalid merge-queue outcome.');
    if (outcome.state !== 'merged' && (typeof outcome.reason !== 'string' || !outcome.reason.trim() || outcome.reason.length > 4000)) throw new Error('A bounded terminal merge reason is required.');
    if (outcome.occurredAt !== undefined && (!Number.isFinite(Date.parse(outcome.occurredAt)) || outcome.occurredAt.length > 64)) throw new Error('Invalid merge-queue timestamp.');
    // A confirmed merge closes the task and records task-closed in the same transaction (feedback-event rule 2).
    return this.#transaction(() => {
      const changed = this.#changeMergeAttempt(identity, id, ['submitting','queued'], attempt => ({
        ...attempt, state: outcome.state, reason: outcome.state === 'merged' ? null : outcome.reason!.trim(),
        occurredAt: outcome.occurredAt ?? null, requiresFreshReview: outcome.requiresFreshReview === true,
        ...(outcome.url !== undefined ? { url: outcome.url } : {}),
      }));
      if (changed && outcome.state === 'merged') {
        const merged = this.getMergeAttempt(identity)!;
        this.#closeTask(identityKey(identity), 'merged', id, { revision: merged.revision, snapshotId: merged.snapshotId });
      }
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
    const mode = row.mode as PlanningMode;
    return { mode, state: row.state as SuggestionState, revision: row.revision as number, snapshotId: row.snapshot_id as string | null,
      reply: row.reply === null || mode === 'draft' ? null : decode<EditReply>(row.reply), reason: row.reason as string | null };
  }
  /**
   * Fail every request still pending from an earlier process. Call once at startup, under the single-runner lock, before
   * any request starts: a pending request's provider ran in that process's planning worker, so nothing can complete it.
   * Returns how many were settled.
   */
  settleInterruptedRequests(): number {
    return this.#run("UPDATE requests SET state='failed', reason=? WHERE state='pending'",
      'The server stopped before this request finished. Ask again.').changes as number;
  }
  /** The mode of a planning request, or undefined when there is no such request for this plan. */
  requestMode(identity: PlanIdentity, id: string): PlanningMode | undefined {
    return this.#get('SELECT mode FROM requests WHERE key=? AND id=?', identityKey(identity), id)?.mode as PlanningMode | undefined;
  }
  /** A draft request (#124). Refuses a suggestion request's ID. */
  getDraft(identity: PlanIdentity, id: string): DraftRequest {
    const row = this.#get("SELECT * FROM requests WHERE key=? AND id=? AND mode='draft'", identityKey(identity), id);
    if (!row) throw new Error('Unknown draft request.');
    return { state: row.state as SuggestionState, revision: row.revision as number, snapshotId: row.snapshot_id as string | null,
      plan: row.reply === null ? null : decode<Plan>(row.reply), reason: row.reason as string | null };
  }
  /**
   * Apply a ready draft as the next revision (#124): the draft must still be bound to the current revision and
   * snapshot, and it passes every check an import does. The request is then consumed, so a replay is refused.
   */
  applyDraft(identity: PlanIdentity, id: string, context: PlanContext): Plan {
    const key = identityKey(identity);
    let applied: Plan | null;
    try { applied = this.#transaction(() => {
      this.#context(key, context);
      const request = this.#get("SELECT * FROM requests WHERE id=? AND key=? AND state='ready' AND mode='draft'", id, key);
      if (!request) throw new Error('Draft is unavailable.');
      const current = this.#current(key);
      if (request.revision !== current.revision || request.snapshot_id !== current.snapshot_id) throw new Error('Draft is unavailable.');
      const progress = this.continuationBasis(identity), currentBinding = progress ? { checkpointId: progress.checkpoint.id, head: progress.head, completedItems: progress.completed } : null;
      const requestBinding = request.continuation === null ? null : decode<ContinuationBinding>(request.continuation);
      if (stable(requestBinding) !== stable(currentBinding)) {
        const invalidate = () => this.#run("UPDATE requests SET state='invalidated',reason='Checkpoint continuation changed before application.' WHERE id=? AND key=? AND state='ready'", id, key);
        throw new RefusalWithEffect('Draft is unavailable.', invalidate);
      }
      const revision = current.revision as number;
      const plan = importPlan(request.reply as string, 'json', context, revision + 1, progress?.completed).plan;
      if (progress) this.continuationProgress(identity, plan);
      this.#savePlan(key, plan, revision);
      this.#run("UPDATE requests SET state='consumed',reason=NULL WHERE id=?", id); return plan;
    }); } catch (error) {
      if (error instanceof RefusalWithEffect && this.#depth === 0) this.#transaction(error.effect);
      throw error;
    }
    if (!applied) throw new Error('Draft is unavailable.');
    return applied;
  }
  applySuggestion(identity: PlanIdentity, id: string, index: number, context: PlanContext): Plan {
    const key = identityKey(identity);
    let applied: Plan | null;
    try { applied = this.#transaction(() => {
      this.#context(key, context);
      const request = this.#get("SELECT * FROM requests WHERE id=? AND key=? AND state='ready' AND mode='suggest'", id, key);
      if (!request) throw new Error('Suggestion is unavailable.');
      const current = this.#current(key);
      if (request.revision !== current.revision || request.snapshot_id !== current.snapshot_id) throw new Error('Suggestion is unavailable.');
      const plan = this.getPlan(identity);
      const progress = this.continuationBasis(identity);
      const currentBinding = progress ? { checkpointId: progress.checkpoint.id, head: progress.head, completedItems: progress.completed } : null;
      const requestBinding = request.continuation === null ? null : decode<ContinuationBinding>(request.continuation);
      if (stable(requestBinding) !== stable(currentBinding)) {
        const invalidate = () => this.#run("UPDATE requests SET state='invalidated',reason='Checkpoint continuation changed before application.' WHERE id=? AND key=? AND state='ready'", id, key);
        throw new RefusalWithEffect('Suggestion is unavailable.', invalidate);
      }
      const next = applySuggestion(plan, decode<EditReply>(request.reply), index, context, {
        identity, schemaVersion: plan.schema_version, baseRevision: request.revision as number, issue: plan.issue,
      }, progress?.completed);
      if (progress) this.continuationProgress(identity, next);
      this.#savePlan(key, next, request.revision as number);
      this.#run("UPDATE requests SET state='consumed',reason=NULL WHERE id=?", id); return next;
    }); } catch (error) {
      if (error instanceof RefusalWithEffect && this.#depth === 0) this.#transaction(error.effect);
      throw error;
    }
    if (!applied) throw new Error('Suggestion is unavailable.');
    return applied;
  }
  #entry(key: string, entry: LedgerEntry): void {
    sha(entry.sha); if (entry.sourceSha !== null) sha(entry.sourceSha);
    if ((entry.origin === 'foreign' && entry.owner !== null) || (entry.origin === 'owned' && !entry.owner) || !['foreign', 'owned'].includes(entry.origin)) throw new Error('Invalid ledger ownership.');
    if (entry.conflictResolved !== undefined && entry.conflictResolved !== true) throw new Error('Invalid conflict-resolution provenance.');
    if (entry.conflictResolved && entry.origin !== 'foreign') throw new Error('Only a foreign ledger entry can carry conflict-resolution provenance.');
    const existing = this.#get('SELECT data FROM ledger WHERE key=? AND sha=?', key, entry.sha);
    if (existing) {
      const prior = decode<LedgerEntry>(existing.data);
      if (prior.sha !== entry.sha || prior.owner !== entry.owner || prior.origin !== entry.origin || prior.sourceSha !== entry.sourceSha ||
          !!prior.conflictResolved !== !!entry.conflictResolved)
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
      // Only the review screen's HEAD observation (no ledger entries) may run during a merge or after closing.
      if (entries.length) this.#assertContextWritable(key);
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
      this.#assertContextWritable(key);
      if (this.#task(key).rebase_in_progress !== null) throw new GuardRefusal('A claimed rebase is in progress; wait for it to settle.');
      return this.#applyRebase(identity, key, base, head, mappings);
    });
  }
  /** Claim the pre-merge rebase before its first Git process starts. */
  beginRebase(identity: PlanIdentity, expected: ReviewState & { reviewVersion: number }, expectedTaskStateVersion: number,
    input: { oldBase: string; oldHead: string; onto: string; oldHistory: readonly string[]; attemptId?: string; startedAt?: number }): RebaseMarker {
    sha(input.oldBase); sha(input.oldHead); sha(input.onto);
    if (input.oldHistory.length > 500) throw new Error('Rebase history exceeds 500 commits.');
    const oldHistory = [...input.oldHistory];
    for (const value of oldHistory) sha(value);
    if (new Set(oldHistory).size !== oldHistory.length ||
        (input.oldHead === input.oldBase ? oldHistory.length !== 0 : oldHistory.at(-1) !== input.oldHead))
      throw new Error('The rebase history must be complete, ordered, and end at the captured head.');
    if (!Number.isSafeInteger(expected.reviewVersion) || expected.reviewVersion < 0) throw new Error('A current review version is required for rebasing.');
    if (!Number.isSafeInteger(expectedTaskStateVersion) || expectedTaskStateVersion < 0) throw new Error('Invalid expected task state version.');
    const attemptId = input.attemptId ?? randomUUID(), startedAt = input.startedAt ?? Date.now();
    assertUuidV4(attemptId, 'Rebase attempt ID');
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('Invalid rebase start time.');
    const marker: RebaseMarker = { attemptId, oldBase: input.oldBase, oldHead: input.oldHead, onto: input.onto, oldHistory, startedAt,
      resultState: 'none', resultHead: null, resultMappings: null, resolvedConflicts: [], conflict: null, processGroup: null };
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const task = this.#task(key);
      if (task.state_version !== expectedTaskStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (this.#closed(task.status as TaskStatus)) throw new GuardRefusal(`The task is ${task.status}; it cannot be rebased.`);
      if (!MERGEABLE_STATUSES.includes(task.status as TaskStatus)) throw new GuardRefusal(`The task is ${task.status}; rebase it from review.`);
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is being cancelled; it cannot be rebased.');
      if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is still active for this task; it cannot be rebased.');
      if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
      if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is already in progress for this task.');
      const snapshot = this.getSnapshot(identity);
      if (snapshot.base !== input.oldBase || snapshot.head !== input.oldHead)
        throw new GuardRefusal('The reviewed base or head changed before the rebase started.');
      this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=?', encode(marker), key);
      this.#touch(key);
      return marker;
    });
  }
  /** Claim the exact child identity before its first clone, storage, network or container write. */
  beginRebaseConflict(planKey: string, attemptId: string,
    input: { attemptId: string; allocationId: string; networkAllocationId: string; source: string }): void {
    assertUuidV4(attemptId, 'Rebase attempt ID');
    assertUuidV4(input.attemptId, 'Conflict attempt ID');
    assertUuidV4(input.allocationId, 'Conflict allocation ID');
    assertUuidV4(input.networkAllocationId, 'Conflict network allocation ID');
    sha(input.source);
    if (input.attemptId === attemptId) throw new Error('A conflict child needs its own attempt identity.');
    if (input.allocationId === input.networkAllocationId)
      throw new Error('Conflict storage and network need distinct allocation identities.');
    this.#transaction(() => {
      if (this.#get('SELECT 1 FROM attempts WHERE id=?', input.attemptId))
        throw new GuardRefusal('An existing runner attempt owns this conflict child identity.');
      if (this.#get('SELECT 1 FROM attempts WHERE allocation_id IN (?,?)', input.allocationId, input.networkAllocationId))
        throw new GuardRefusal('An existing runner attempt owns this conflict child allocation.');
      // A child identity or allocation is never allowed to name resources of another active rebase.
      for (const row of this.#db.prepare('SELECT plan_key, rebase_in_progress FROM tasks WHERE rebase_in_progress IS NOT NULL').all()) {
        const active = decode<Partial<RebaseMarker>>(row.rebase_in_progress);
        if (row.plan_key !== planKey && active.conflict &&
            (active.conflict.attemptId === input.attemptId ||
             [active.conflict.allocationId, active.conflict.networkAllocationId].includes(input.allocationId) ||
             [active.conflict.allocationId, active.conflict.networkAllocationId].includes(input.networkAllocationId)))
          throw new GuardRefusal('Another rebase already owns this conflict child identity.');
      }
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId) throw new GuardRefusal('This rebase attempt no longer owns the task.');
      if (marker.processGroup !== null) throw new GuardRefusal('The rebase Git process has not settled.');
      if (marker.conflict) throw new GuardRefusal('A conflict child is already active for this rebase.');
      if (marker.resultState !== 'none' || marker.oldHistory === null || !marker.oldHistory.includes(input.source)
          || marker.resolvedConflicts.includes(input.source))
        throw new GuardRefusal('This conflict does not belong to the active rebase.');
      if (this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=? AND rebase_in_progress=?',
        encode({ ...marker, conflict: { ...input } }), planKey, task.rebase_in_progress as string).changes !== 1)
        throw new GuardRefusal('This rebase attempt no longer owns the task.');
    });
  }
  /** Release a child only after its invocation, storage and staging files have all settled. */
  clearRebaseConflict(planKey: string, attemptId: string, conflictAttemptId: string): void {
    assertUuidV4(attemptId, 'Rebase attempt ID'); assertUuidV4(conflictAttemptId, 'Conflict attempt ID');
    this.#transaction(() => {
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId || marker.conflict?.attemptId !== conflictAttemptId)
        throw new GuardRefusal('This conflict child no longer owns the rebase.');
      if (marker.processGroup !== null)
        throw new GuardRefusal('The conflict child process has not settled.');
      if (this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=? AND rebase_in_progress=?',
        encode({ ...marker, conflict: null }), planKey, task.rebase_in_progress as string).changes !== 1)
        throw new GuardRefusal('This conflict child no longer owns the rebase.');
    });
  }
  /** Record or clear the exact Git process group currently owned by a rebase. This does not advance task context. */
  setRebaseProcessGroup(planKey: string, attemptId: string,
    expected: RebaseMarker['processGroup'], group: RebaseMarker['processGroup']): void {
    assertUuidV4(attemptId, 'Rebase attempt ID');
    for (const value of [expected, group]) if (value && value !== 'spawning' && value !== 'unsettled' &&
        (!Number.isSafeInteger(value.pgid) || value.pgid <= 1 || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
          (value.identity !== null && !/^linux:[0-9a-f-]{36}:\d+$/.test(value.identity))))
      throw new Error('Invalid rebase process group.');
    this.#transaction(() => {
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId) throw new GuardRefusal('This rebase attempt no longer owns the task.');
      if (stable(marker.processGroup) !== stable(expected)) throw new GuardRefusal('Another Git process owns this rebase.');
      if (this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=? AND rebase_in_progress=?',
        encode({ ...marker, processGroup: group }), planKey, task.rebase_in_progress as string).changes !== 1)
        throw new GuardRefusal('This rebase attempt no longer owns the task.');
    });
  }
  /** Persist the complete intended result before the rebaser's first ref write. */
  prepareRebaseResult(planKey: string, attemptId: string, head: string | null, rewrittenHistory: readonly string[],
    resolvedConflicts: readonly string[] = []): void {
    assertUuidV4(attemptId, 'Rebase attempt ID'); if (head !== null) sha(head);
    if (rewrittenHistory.length > 500) throw new Error('Rebase history exceeds 500 commits.');
    for (const value of rewrittenHistory) sha(value);
    if (new Set(rewrittenHistory).size !== rewrittenHistory.length) throw new Error('Rebase history must not repeat a commit.');
    for (const value of resolvedConflicts) sha(value);
    if (new Set(resolvedConflicts).size !== resolvedConflicts.length) throw new Error('Resolved conflicts must not repeat a commit.');
    this.#transaction(() => {
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId) throw new GuardRefusal('This rebase attempt no longer owns the task.');
      if (marker.processGroup !== null) throw new GuardRefusal('The rebase Git process has not settled.');
      if (marker.conflict) throw new GuardRefusal('The conflict child has not settled.');
      if (marker.oldHistory === null || rewrittenHistory.length !== marker.oldHistory.length)
        throw new GuardRefusal('The rebase result does not cover the complete captured history.');
      if (resolvedConflicts.some(value => !marker.oldHistory!.includes(value)))
        throw new GuardRefusal('A resolved conflict is outside the captured history.');
      if ((marker.onto === marker.oldBase) !== (head === null)) throw new GuardRefusal('The retained rebase result does not match its target.');
      const rewrittenHead = rewrittenHistory.at(-1);
      if (marker.oldHead === marker.oldBase ? rewrittenHistory.length !== 0 :
          (head === null ? stable(rewrittenHistory) !== stable(marker.oldHistory) : rewrittenHead !== head))
        throw new GuardRefusal('The retained rebase history does not end at its captured head.');
      if (marker.oldHead === marker.oldBase && head !== (marker.onto === marker.oldBase ? null : marker.onto))
        throw new GuardRefusal('An empty rebase history must resolve exactly to its target base.');
      const mappings = marker.oldHistory.map((oldSha, index) => ({ oldSha, newSha: rewrittenHistory[index]! }));
      const ledger = new Map(this.#db.prepare('SELECT data FROM ledger WHERE key=?').all(planKey)
        .map(row => decode<LedgerEntry>(row.data)).map(entry => [entry.sha, entry]));
      for (const source of resolvedConflicts) {
        const mapping = mappings.find(value => value.oldSha === source)!;
        if (mapping.oldSha === mapping.newSha)
          throw new GuardRefusal('A resolved conflict must rewrite its source commit.');
        if (ledger.get(source)?.origin === 'owned')
          throw new GuardRefusal('An owned commit cannot be prepared as a foreign conflict resolution.');
      }
      if (marker.resultState !== 'none') {
        if (marker.resultHead !== head || stable(marker.resultMappings) !== stable(mappings) ||
            stable(marker.resolvedConflicts ?? []) !== stable(resolvedConflicts))
          throw new GuardRefusal('Another result owns this rebase.');
        return;
      }
      if (this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=? AND rebase_in_progress=?',
        encode({ ...marker, resultState: 'prepared', resultHead: head, resultMappings: [...mappings], resolvedConflicts: [...resolvedConflicts] }),
        planKey, task.rebase_in_progress as string).changes !== 1)
        throw new GuardRefusal('This rebase attempt no longer owns the task.');
    });
  }
  /** Record the external ref-write outcome before live cleanup or recovery can interpret the prepared intent. */
  setRebaseResultState(planKey: string, attemptId: string, state: 'uncertain' | 'refused' | 'ready'): void {
    assertUuidV4(attemptId, 'Rebase attempt ID');
    this.#transaction(() => {
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId) throw new GuardRefusal('This rebase attempt no longer owns the task.');
      if (marker.processGroup !== null) throw new GuardRefusal('The rebase Git process has not settled.');
      if (marker.conflict) throw new GuardRefusal('The conflict child has not settled.');
      if (marker.resultState === state) return;
      if (marker.resultState !== 'prepared' || marker.resultMappings === null)
        throw new GuardRefusal('The rebase result was not prepared before its ref write.');
      if (this.#run('UPDATE tasks SET rebase_in_progress=? WHERE plan_key=? AND rebase_in_progress=?',
        encode({ ...marker, resultState: state }), planKey, task.rebase_in_progress as string).changes !== 1)
        throw new GuardRefusal('This rebase attempt no longer owns the task.');
    });
  }
  /** Confirm that the prepared result's ref write succeeded (or that the no-op needs no ref). */
  completeRebaseResult(planKey: string, attemptId: string): void {
    this.setRebaseResultState(planKey, attemptId, 'ready');
  }
  /** Publish a rebase only while every review and task counter captured by its attempt is still current. */
  finishRebase(identity: PlanIdentity, expected: ReviewState & { reviewVersion: number }, expectedTaskStateVersion: number,
    attemptId: string, base: string, head: string, mappings: readonly { oldSha: string; newSha: string }[]): Snapshot {
    assertUuidV4(attemptId, 'Rebase attempt ID');
    if (!Number.isSafeInteger(expected.reviewVersion) || expected.reviewVersion < 0) throw new Error('A current review version is required for rebasing.');
    if (!Number.isSafeInteger(expectedTaskStateVersion) || expectedTaskStateVersion < 0) throw new Error('Invalid expected task state version.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const task = this.#task(key), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      // beginRebase itself advances the task version once; nothing else may have advanced it before this result lands.
      if (task.state_version !== expectedTaskStateVersion + 1) throw new GuardRefusal('The task changed during the rebase. Discard its result.');
      if (marker?.attemptId !== attemptId) throw new GuardRefusal('This rebase attempt no longer owns the task.');
      if (marker.processGroup !== null) throw new GuardRefusal('The rebase Git process has not settled.');
      if (marker.conflict) throw new GuardRefusal('The conflict child has not settled.');
      if (marker.resultState !== 'ready' || marker.resultMappings === null ||
          (marker.onto === marker.oldBase ? marker.resultHead !== null : marker.resultHead !== head))
        throw new GuardRefusal('The rebase result does not own its retained ref.');
      const captured = this.getSnapshot(identity);
      if (marker.oldBase !== captured.base || marker.oldHead !== captured.head || marker.onto !== base)
        throw new GuardRefusal('The rebase result does not match its captured base and head.');
      const endpoint = mappings.at(-1);
      if (marker.oldHead === marker.oldBase
        ? mappings.length !== 0 || head !== base
        : !endpoint || endpoint.oldSha !== marker.oldHead || endpoint.newSha !== head || stable(mappings) !== stable(marker.resultMappings))
        throw new GuardRefusal('The rebase mapping does not end at the captured and rewritten heads.');
      this.#assertContextWritable(key);
      const snapshot = this.#applyRebase(identity, key, base, head, mappings, marker.resolvedConflicts ?? []);
      this.#run('UPDATE tasks SET rebase_in_progress=NULL WHERE plan_key=?', key);
      return snapshot;
    });
  }
  /** Clear only the matching rebase, after the live operation settles or recovery removes its resources. */
  abortRebase(planKey: string, attemptId: string): boolean {
    assertUuidV4(attemptId, 'Rebase attempt ID');
    return this.#transaction(() => {
      const task = this.#task(planKey), marker = task.rebase_in_progress === null ? null : decode<RebaseMarker>(task.rebase_in_progress);
      if (marker?.attemptId !== attemptId) return false;
      if (marker.processGroup !== null) return false;
      if (marker.conflict) return false;
      const encoded = task.rebase_in_progress as string;
      if (this.#run('UPDATE tasks SET rebase_in_progress=NULL WHERE plan_key=? AND rebase_in_progress=?', planKey, encoded).changes !== 1) return false;
      if (task.cancel_requested !== null && !this.#closed(task.status as TaskStatus)) this.#closeTask(planKey, 'cancelled', task.cancel_requested as string);
      else this.#touch(planKey);
      return true;
    });
  }
  #applyRebase(identity: PlanIdentity, key: string, base: string, head: string,
    mappings: readonly { oldSha: string; newSha: string }[], resolvedConflicts: readonly string[] = []): Snapshot {
    const ledger = new Map(this.getLedger(identity).map(entry => [entry.sha, entry]));
    const sources = new Set<string>(), destinations = new Set<string>();
    // Validate the complete response before the snapshot or ledger changes.
    for (const { oldSha, newSha } of mappings) {
      sha(oldSha); sha(newSha);
      if (sources.has(oldSha) || destinations.has(newSha)) throw new Error('Rebase mappings must be one-to-one.');
      sources.add(oldSha); destinations.add(newSha);
    }
    const snapshot = this.#snapshot(key, base, head);
    const resolved = new Set(resolvedConflicts);
    for (const { oldSha, newSha } of mappings) {
      const source = ledger.get(oldSha);
      if (resolved.has(oldSha) && source?.origin === 'owned') throw new Error('An owned commit cannot be published as a foreign conflict resolution.');
      if (oldSha !== newSha) this.#entry(key, { sha: newSha, owner: source?.owner ?? null, origin: source?.origin ?? 'foreign', sourceSha: oldSha,
        ...(resolved.has(oldSha) || source?.conflictResolved ? { conflictResolved: true } : {}) });
      else if (!source) this.#entry(key, { sha: newSha, owner: null, origin: 'foreign', sourceSha: null });
      this.#run('INSERT INTO rewrites VALUES (?,?,?,?)', key, snapshot.id, oldSha, newSha);
    }
    return snapshot;
  }
  getRewrites(identity: PlanIdentity, snapshotId: string): { oldSha: string; newSha: string }[] {
    this.getSnapshot(identity, snapshotId);
    return this.#db.prepare('SELECT old_sha,new_sha FROM rewrites WHERE key=? AND snapshot_id=? ORDER BY old_sha').all(identityKey(identity), snapshotId).map(row => ({ oldSha: row.old_sha as string, newSha: row.new_sha as string }));
  }
  /** Whether `descendant` was produced by one or more durable rebase mappings from `ancestor`. */
  isRewrittenHead(identity: PlanIdentity, ancestor: string, descendant: string): boolean {
    sha(ancestor); sha(descendant);
    const reverse = new Map<string, Set<string>>();
    for (const row of this.#rewriteLineage(identity)) {
      const prior = reverse.get(row.new_sha as string) ?? new Set<string>();
      prior.add(row.old_sha as string); reverse.set(row.new_sha as string, prior);
    }
    const pending = [descendant], seen = new Set(pending);
    while (pending.length) for (const prior of reverse.get(pending.pop()!) ?? []) {
      if (prior === ancestor) return true;
      if (!seen.has(prior)) { seen.add(prior); pending.push(prior); }
    }
    return false;
  }
  /** Durable predecessors of a rewritten commit, nearest first, across every retained rebase mapping. */
  rewrittenAncestors(identity: PlanIdentity, descendant: string): string[] {
    sha(descendant);
    const reverse = new Map<string, Set<string>>();
    for (const row of this.#rewriteLineage(identity)) {
      const prior = reverse.get(row.new_sha as string) ?? new Set<string>();
      prior.add(row.old_sha as string); reverse.set(row.new_sha as string, prior);
    }
    const answer: string[] = [], pending = [descendant], seen = new Set(pending);
    for (let index = 0; index < pending.length; index++) for (const prior of reverse.get(pending[index]!) ?? []) if (!seen.has(prior)) {
      seen.add(prior); answer.push(prior); pending.push(prior);
    }
    return answer;
  }
  /** A bounded safety scan: truncating rewrite evidence could misclassify a remote head as safe. */
  #rewriteLineage(identity: PlanIdentity): { old_sha: string; new_sha: string }[] {
    const rows = this.#db.prepare('SELECT old_sha,new_sha FROM rewrites WHERE key=? ORDER BY rowid DESC LIMIT ?')
      .all(identityKey(identity), MAX_REWRITE_LINEAGE_ROWS + 1);
    if (rows.length > MAX_REWRITE_LINEAGE_ROWS)
      throw new GuardRefusal(`Rewrite lineage exceeds the ${MAX_REWRITE_LINEAGE_ROWS}-row safety limit; start a fresh review before preparing a merge.`);
    return rows as { old_sha: string; new_sha: string }[];
  }
  /** Values must be computed by the runner from this exact revision/snapshot, never supplied by a browser. */
  saveReview(identity: PlanIdentity, expected: ReviewState, approvals: readonly Approval[], choices: readonly SegmentChoice[]): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      this.#expect(key, expected);
      if (this.#taskClosed(key)) throw new GuardRefusal('A closed task never changes.');
      // Approvals and choices must not change the reviewed state while GitHub may still merge it.
      if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
      const plan = this.getPlan(identity), reviewVersion = this.reviewVersion(identity);
      for (const approval of approvals) {
        if (!plan.items.some(item => item.id === approval.item) || !approval.fingerprint) throw new Error('Invalid approval.');
        this.#run('INSERT OR REPLACE INTO approvals VALUES (?,?,?)', key, approval.item, encode({ ...approval, ...expected, reviewVersion }));
      }
      for (const choice of choices) {
        if (!choice.key || !['assign','accept'].includes(choice.action) || (choice.action === 'assign' ? !plan.items.some(item => item.id === choice.item) : choice.item !== null)) throw new Error('Invalid segment choice.');
        this.#run('INSERT OR REPLACE INTO choices VALUES (?,?,?)', key, choice.key, encode({ ...choice, ...expected, reviewVersion }));
      }
      this.#run('UPDATE plans SET review_version=review_version+1 WHERE key=?', key);
    });
  }
  reviewVersion(identity: PlanIdentity): number { return this.#current(identityKey(identity)).review_version as number; }
  addReviewNote(identity: PlanIdentity, expected: ReviewState, item: string, kind: ReviewNote['kind'], text: string, reference?: SnippetReference): ReviewNote {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      if (this.#taskClosed(key)) throw new GuardRefusal('A closed task never changes.');
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
  /** Before execution, approvals belong to the current snapshot; after a completed item, this revision's approvals survive its own commits. */
  unapprovedExecutionItems(identity: PlanIdentity, revision: number): string[] {
    const key = identityKey(identity), plan = this.getPlan(identity, revision);
    const snapshotId = this.getSnapshot(identity).id, review = this.getReview(identity);
    // An approval inherited across runner commits must come from the context of the completed prefix, not merely from
    // this revision. Otherwise A -> unrelated B approval -> A could reuse B's approval when the prefix-head guard passes.
    const completedAt: Record<string, string> = Object.create(null);
    for (const row of this.#db.prepare(`SELECT item,context FROM attempts WHERE plan_key=? AND kind='execute' AND state='completed'
      AND json_extract(context,'$.planRevision')=? ORDER BY rowid`).all(key, revision)) {
      const context = decode<InvocationContext>(row.context);
      if (typeof row.item === 'string' && typeof context.snapshotId === 'string') completedAt[row.item] = context.snapshotId;
    }
    const prefixSnapshots = new Set<string>();
    for (const item of plan.items) {
      const completedSnapshot = completedAt[item.id];
      if (!completedSnapshot) break;
      prefixSnapshots.add(completedSnapshot);
    }
    // A continuation approval starts a new reviewed ancestry at its audited snapshot. The checkpoint's completed
    // prefix belongs to earlier plan revisions, so those attempts cannot identify the snapshots its approvals survive.
    const checkpoint = this.latestCheckpoint(identity), continuation = checkpoint ? this.continuationProgress(identity) : null;
    if (continuation && this.continuationApproved(identity, continuation)) {
      const approvalSnapshot = this.continuationApproval(identity, checkpoint!.id, revision);
      if (approvalSnapshot) {
        prefixSnapshots.add(approvalSnapshot);
        const afterCheckpoint = new Set(continuation.completed.slice(checkpoint!.completedItems.length));
        for (const row of this.#db.prepare(`SELECT item,context FROM attempts WHERE plan_key=? AND kind='execute' AND state='completed'
          AND json_extract(context,'$.planRevision')=? ORDER BY rowid`).all(key, revision)) {
          const context = decode<InvocationContext>(row.context);
          if (typeof row.item === 'string' && afterCheckpoint.has(row.item) && typeof context.snapshotId === 'string')
            prefixSnapshots.add(context.snapshotId);
        }
      }
    }
    const reviewedExecutionSnapshot = (value: ReviewState) => value.snapshotId === snapshotId || prefixSnapshots.has(value.snapshotId);
    // A later attribution choice changes the material reviewed by at least one item. Without rebuilding Git history on a
    // status poll, conservatively require approvals recorded after the latest such choice for this execution context.
    let latestChoiceVersion = -1;
    for (const choice of review.choices) if (choice.revision === revision && (prefixSnapshots.size > 0 || choice.snapshotId === snapshotId)) {
      if (choice.reviewVersion === undefined) latestChoiceVersion = Number.MAX_SAFE_INTEGER;
      else if (choice.reviewVersion > latestChoiceVersion) latestChoiceVersion = choice.reviewVersion;
    }
    const approved = new Set(review.approvals.filter(value => value.revision === revision && reviewedExecutionSnapshot(value)
      && (value.reviewVersion ?? -1) > latestChoiceVersion).map(value => value.item));
    return plan.items.filter(item => !approved.has(item.id)).map(item => item.id);
  }
  /** Records evidence from an already completed safety audit; does not authorize execution. */
  recordCheckpoint(identity: PlanIdentity, expected: ReviewState, evidence: Omit<Checkpoint, 'id' | 'revision' | 'snapshotId'>): Checkpoint {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#expect(key, expected);
      const plan = this.getPlan(identity), ids = plan.items.map(item => item.id);
      if (!ids.includes(evidence.item) || evidence.completedItems.at(-1) !== evidence.item || new Set(evidence.completedItems).size !== evidence.completedItems.length || evidence.completedItems.some((item, i) => item !== ids[i])) throw new Error('Checkpoint must describe the executed plan prefix.');
      const checkpoint = { ...evidence, ...expected, treeHead: this.getSnapshot(identity, expected.snapshotId).head, id: randomUUID() };
      this.#run('INSERT INTO checkpoints VALUES (?,?,?)', key, checkpoint.id, encode(checkpoint)); return checkpoint;
    });
  }
  /**
   * F2's scope pause. `ranAt` is where the item actually ran: its plan revision and the snapshot its own commit
   * created, not whatever is current, so a revision or HEAD observation saved since cannot erase the scope finding
   * (plan-format.md, "After each run"). The checkpoint and the move to needs amendment commit together, so a refused
   * status change (a closed task, an active attempt or merge) records no checkpoint either.
   */
  pauseForAmendment(identity: PlanIdentity, ranAt: ReviewState, evidence: Omit<Checkpoint, 'id' | 'revision' | 'snapshotId'>, options: { owed?: boolean } = {}): Checkpoint {
    const key = identityKey(identity);
    return this.#transaction(() => {
      if (!this.#get('SELECT 1 FROM snapshots WHERE key=? AND id=?', key, ranAt.snapshotId)) throw new Error('Unknown snapshot.');
      const ids = this.getPlan(identity, ranAt.revision).items.map(item => item.id);
      if (!ids.includes(evidence.item) || evidence.completedItems.at(-1) !== evidence.item || new Set(evidence.completedItems).size !== evidence.completedItems.length || evidence.completedItems.some((item, i) => item !== ids[i]))
        throw new Error('Checkpoint must describe the executed plan prefix.');
      // Only the executor's own task pauses. In the run that found it, that is a running task, or a review status someone
      // set since (a merge must not go past the finding); a queued status set since is kept, and the next run pays the
      // pause from there. A human gate is kept too. A pause owed from an earlier run is paid from queued as well.
      const status = this.#task(key).status;
      const pausable = status === 'running' || status === 'in review' || status === 'approved but merge blocked' || (options.owed === true && status === 'queued');
      if (!pausable) throw new GuardRefusal(`The task is ${status}, so it was not paused for amendment.`);
      this.transitionTask(identity, this.#task(key).state_version as number, 'needs amendment');
      const checkpoint = { ...evidence, revision: ranAt.revision, snapshotId: ranAt.snapshotId,
        treeHead: this.getSnapshot(identity, ranAt.snapshotId).head, id: randomUUID() };
      this.#run('INSERT INTO checkpoints VALUES (?,?,?)', key, checkpoint.id, encode(checkpoint));
      return checkpoint;
    });
  }
  /**
   * The scope checkpoint recorded for a runner commit, found by the commit's head (not by the latest snapshot, which a
   * later snapshot with the same head would shadow), or null if its pause was never recorded.
   */
  checkpointAtHead(identity: PlanIdentity, head: string): Checkpoint | null {
    for (const row of this.#db.prepare('SELECT data FROM checkpoints WHERE key=? ORDER BY rowid DESC').all(identityKey(identity))) {
      const checkpoint = decode<Checkpoint>(row.data);
      if (this.getSnapshot(identity, checkpoint.snapshotId).head === head) return checkpoint;
    }
    return null;
  }
  /** The most recent scope checkpoint of this plan, or null. */
  latestCheckpoint(identity: PlanIdentity): Checkpoint | null {
    const row = this.#get('SELECT data FROM checkpoints WHERE key=? ORDER BY rowid DESC LIMIT 1', identityKey(identity));
    return row ? decode<Checkpoint>(row.data) : null;
  }
  /** The latest snapshot of this plan whose head is `head` (the one a runner commit created), or null. */
  snapshotWithHead(identity: PlanIdentity, head: string): string | null {
    for (const row of this.#db.prepare('SELECT id, data FROM snapshots WHERE key=? ORDER BY rowid DESC').all(identityKey(identity)))
      if (decode<Snapshot>(row.data).head === head) return row.id as string;
    return null;
  }
  getCheckpoint(identity: PlanIdentity, id: string): Checkpoint {
    const row = this.#get('SELECT data FROM checkpoints WHERE key=? AND id=?', identityKey(identity), id);
    if (!row) throw new Error('Unknown checkpoint.'); return decode<Checkpoint>(row.data);
  }
  /** Derive audited completion from the checkpoint and attempt chain without trusting the editable current plan. */
  continuationBasis(identity: PlanIdentity): { checkpoint: Checkpoint; completed: string[]; completedDefinitions: PlanItem[]; head: string } | null {
    const checkpoint = this.latestCheckpoint(identity);
    if (!checkpoint) return null;
    const checkpointPlan = this.getPlan(identity, checkpoint.revision);
    const completed = [...checkpoint.completedItems], completedDefinitions = checkpointPlan.items.slice(0, completed.length);
    if (completedDefinitions.length !== completed.length || completedDefinitions.some((item, index) => item.id !== completed[index]))
      throw new GuardRefusal('The checkpoint does not match its saved plan revision.');
    let head = this.getSnapshot(identity, checkpoint.snapshotId).head;
    const key = identityKey(identity);
    const origin = this.#get(`SELECT rowid FROM attempts WHERE plan_key=? AND kind='execute' AND state='completed' AND item=?
      AND json_extract(context,'$.planRevision')=? AND json_extract(result,'$.head')=? ORDER BY rowid DESC LIMIT 1`,
      key, checkpoint.item, checkpoint.revision, head)?.rowid as number | undefined;
    if (origin === undefined && this.#get('SELECT 1 AS found FROM attempts WHERE plan_key=? LIMIT 1', key))
      throw new GuardRefusal('The checkpoint has no completed execute attempt at its audited head.');
    const later = origin === undefined ? [] : this.#db.prepare(`SELECT * FROM attempts WHERE plan_key=? AND rowid>?
      AND state='completed' AND kind IN (${WRITABLE_KINDS.map(() => '?').join(',')}) ORDER BY rowid LIMIT 10001`)
      .all(key, origin, ...WRITABLE_KINDS);
    if (later.length > 10000) throw new GuardRefusal('Too many completed attempts follow the checkpoint to reconcile safely.');
    for (const stored of later) {
      const row = this.#attemptRecord(stored);
      const result = row.result as ExecutionResultLike | null;
      const executedPlan = this.getPlan(identity, row.context.planRevision);
      if (row.kind !== 'execute' || !result || typeof result.head !== 'string' || !row.item ||
        this.getSnapshot(identity, row.context.snapshotId).head !== head ||
        executedPlan.items.slice(0, completed.length).some((item, index) => item.id !== completed[index]) ||
        executedPlan.items[completed.length]?.id !== row.item ||
        !this.continuationApproval(identity, checkpoint.id, row.context.planRevision))
        throw new GuardRefusal('Work after the checkpoint cannot be reconciled with the amended plan.');
      const executedItem = executedPlan.items[completed.length];
      if (!executedItem || executedItem.id !== row.item) throw new GuardRefusal(`Completed item ${row.item} is absent from its execution revision.`);
      completedDefinitions.push(executedItem);
      head = result.head;
      completed.push(row.item);
    }
    if (head !== this.getSnapshot(identity).head)
      throw new GuardRefusal('The task head no longer ends at the audited completed prefix.');
    return { checkpoint, completed, completedDefinitions, head };
  }
  /** Reconcile audited completion against the current or proposed plan definition. */
  continuationProgress(identity: PlanIdentity, candidate?: Plan): { checkpoint: Checkpoint; completed: string[]; next: string | null; head: string } | null {
    const basis = this.continuationBasis(identity);
    if (!basis) return null;
    const plan = candidate ?? this.getPlan(identity), { checkpoint, completed, completedDefinitions } = basis;
    const prefix = plan.items.slice(0, completed.length);
    if (prefix.length !== completed.length || prefix.some((item, index) => item.id !== completed[index]))
      throw new GuardRefusal('The amended plan changed the completed checkpoint prefix.');
    const checkpointPlan = this.getPlan(identity, checkpoint.revision);
    for (let index = 0; index < checkpoint.completedItems.length; index++) {
      const before = checkpointPlan.items[index], current = plan.items[index];
      if (!before || !current) throw new GuardRefusal(`Completed item ${checkpoint.completedItems[index]} changed before the audited checkpoint.`);
      if (index < checkpoint.completedItems.length - 1) {
        if (stable(before) !== stable(current))
          throw new GuardRefusal(`Completed item ${checkpoint.completedItems[index]} changed before the audited checkpoint.`);
        continue;
      }
      const observed = new Set(checkpoint.outOfScopePaths.map(this.#pathKey));
      const existingFiles = current.files.slice(0, before.files.length);
      const addedFiles = current.files.slice(before.files.length);
      this.#assertValidItemPaths(current);
      if (stable({ ...current, files: existingFiles }) !== stable(before) ||
          addedFiles.some(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])].some(path => !observed.has(this.#pathKey(path)))))
        throw new GuardRefusal(`Completed checkpoint item ${checkpoint.completedItems[index]} changed beyond its scope declaration.`);
    }
    for (let index = checkpoint.completedItems.length; index < completed.length; index++) {
      if (stable(plan.items[index]) !== stable(completedDefinitions[index]))
        throw new GuardRefusal(`Completed item ${completed[index]} changed after it ran; review and rerun it before continuing.`);
    }
    return { checkpoint, completed, next: plan.items[completed.length]?.id ?? null, head: basis.head };
  }
  continuationApproval(identity: PlanIdentity, checkpointId: string, revision: number): string | null {
    const row = this.#get('SELECT snapshot_id FROM continuations WHERE key=? AND checkpoint_id=? AND revision=?', identityKey(identity), checkpointId, revision);
    return typeof row?.snapshot_id === 'string' ? row.snapshot_id : null;
  }
  /** An approval still covers this head only when its own revision's completed attempts connect it to the current head. */
  continuationApproved(identity: PlanIdentity, progress: NonNullable<ReturnType<Store['continuationProgress']>>): boolean {
    const revision = this.getPlan(identity).revision;
    const snapshotId = this.continuationApproval(identity, progress.checkpoint.id, revision);
    if (!snapshotId) return false;
    if (snapshotId === this.getSnapshot(identity).id) return true;
    let head = this.getSnapshot(identity, snapshotId).head, advanced = false;
    const key = identityKey(identity), origin = this.#get(`SELECT rowid FROM attempts WHERE plan_key=? AND kind='execute' AND state='completed'
      AND item=? AND json_extract(context,'$.planRevision')=? AND json_extract(result,'$.head')=? ORDER BY rowid DESC LIMIT 1`,
      key, progress.checkpoint.item, progress.checkpoint.revision, this.getSnapshot(identity, progress.checkpoint.snapshotId).head)?.rowid as number | undefined;
    if (origin === undefined) return false;
    const attempts = this.#db.prepare(`SELECT * FROM attempts WHERE plan_key=? AND rowid>? AND kind='execute' AND state='completed'
      AND json_extract(context,'$.planRevision')=? ORDER BY rowid LIMIT 10001`).all(key, origin, revision);
    if (attempts.length > 10000) return false;
    for (const stored of attempts) {
      const row = this.#attemptRecord(stored);
      if (this.getSnapshot(identity, row.context.snapshotId).head !== head) continue;
      const result = row.result as ExecutionResultLike | null;
      if (!result || typeof result.head !== 'string') return false;
      head = result.head; advanced = true;
    }
    return advanced && head === progress.head;
  }
  /** Persist a person's approval after reconciling the prefix and validating the suffix at its actual tree. */
  approveContinuation(identity: PlanIdentity, checkpointId: string, expected: ReviewState, context: PlanContext): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      this.#expect(key, expected); const checkpoint = this.getCheckpoint(identity, checkpointId);
      this.#context(key, context);
      const progress = this.continuationProgress(identity);
      if (!progress || progress.checkpoint.id !== checkpointId || !checkpoint.outOfScopePaths.length || expected.revision <= checkpoint.revision)
        throw new GuardRefusal('Continuation requires an amended plan at the audited checkpoint.');
      if (this.getSnapshot(identity).head !== progress.head ||
          (progress.completed.length === checkpoint.completedItems.length && checkpoint.snapshotId !== expected.snapshotId))
        throw new GuardRefusal('The audited checkpoint tree or snapshot changed; review it before continuing.');
      // New checkpoint rows bind the saved entries to their immutable commit tree. Legacy rows saved the original base
      // tree instead; the caller re-reads the actual tree at progress.head, so comparing it to that old evidence rejects
      // valid amendments and is not an integrity check.
      if (checkpoint.treeHead === progress.head && JSON.stringify(context.baseEntries) !== JSON.stringify(checkpoint.baseEntries))
        throw new GuardRefusal('The audited checkpoint tree changed; review it before continuing.');
      const amendedItem = this.getPlan(identity).items[checkpoint.completedItems.length - 1]!;
      const declared = new Set(amendedItem.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]).map(context.pathKey));
      if (checkpoint.outOfScopePaths.some(path => !declared.has(context.pathKey(path))))
        throw new GuardRefusal('The amended checkpoint item must declare every out-of-scope path it changed.');
      if (progress.next) {
        const validation = validateContinuationPlan(this.getPlan(identity), context, progress.completed);
        if (validation.errors.length) throw new GuardRefusal(`The remaining plan is invalid at the audited head: ${validation.errors.map(error => error.message).join(' ')}`);
      }
      const status = this.getTask(identity).status;
      if (!['needs amendment', 'queued', 'running'].includes(status)) throw new GuardRefusal(`The task is ${status}; continuation cannot be approved.`);
      const task = this.#task(key);
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is being cancelled.');
      if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is still active for this task.');
      if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
      if (status === 'needs amendment' && progress.next) this.transitionTask(identity, this.getTask(identity).stateVersion, 'queued');
      else if (!progress.next && status !== 'running') {
        this.#run("UPDATE tasks SET status='running' WHERE plan_key=?", key);
        this.#touch(key);
      }
      if (!progress.next && task.requeue_pending === 1) {
        this.#run('UPDATE tasks SET requeue_pending=0 WHERE plan_key=?', key);
        this.#touch(key);
      }
      this.#run(`INSERT INTO continuations (key,checkpoint_id,revision,snapshot_id) VALUES (?,?,?,?)
        ON CONFLICT(key,checkpoint_id,revision) DO UPDATE SET snapshot_id=excluded.snapshot_id`, key, checkpointId, expected.revision, expected.snapshotId);
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
      SELECT lower(hex(randomblob(16))), p.key, ${latestMerge('m.id')},
        COALESCE(${latestMerge("json_extract(m.data,'$.revision')")}, p.revision),
        COALESCE(${latestMerge("json_extract(m.data,'$.snapshotId')")}, p.snapshot_id), NULL, 'task-closed', NULL, p.key, NULL, ?
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
      safetyFinding: row.safety_finding as string | null,
      promptComments: row.prompt_comments === null || row.prompt_comments === undefined ? null : decode(row.prompt_comments),
    };
  }
  issueTrust(repository: string, issue: number): IssueTrustRecord | null {
    const row = this.#get('SELECT * FROM issue_trust WHERE repository=? AND issue=?', repository.toLocaleLowerCase('en-US'), issue);
    if (!row) return null;
    return { repository: row.repository as string, issue: row.issue as number, authorLogin: row.author_login as string | null,
      trustedBy: row.trusted_by as string, trustedAt: row.trusted_at as string, revokedAt: row.revoked_at as string | null };
  }
  setIssueTrust(input: { repository: string; issue: number; authorLogin: string | null; trusted: boolean; trustedBy: string }): IssueTrustRecord {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !Number.isSafeInteger(input.issue) || input.issue < 1)
      throw new GuardRefusal('Invalid issue trust target.');
    if (input.authorLogin !== null && (typeof input.authorLogin !== 'string' || !input.authorLogin || input.authorLogin.length > 100 || /[\s\u0000-\u001f\u007f]/u.test(input.authorLogin)))
      throw new GuardRefusal('Invalid issue author.');
    if (typeof input.trustedBy !== 'string' || !input.trustedBy || input.trustedBy.length > 100) throw new GuardRefusal('Invalid trust decision owner.');
    const repository = input.repository.toLocaleLowerCase('en-US');
    return this.#transaction(() => {
      const existing = this.issueTrust(repository, input.issue);
      // Strictly order decisions even when two clients act in the same wall-clock millisecond. Browser responses use
      // this timestamp as their CAS version, so an older response can never overwrite a newer same-author decision.
      const previous = existing ? Date.parse(existing.revokedAt ?? existing.trustedAt) : -1;
      const now = new Date(Math.max(Date.now(), previous + 1)).toISOString();
      if (input.trusted) {
        if (existing?.revokedAt === null && existing.authorLogin === input.authorLogin) return existing;
        this.#run(`INSERT INTO issue_trust(repository,issue,author_login,trusted_by,trusted_at,revoked_at) VALUES (?,?,?,?,?,NULL)
          ON CONFLICT(repository,issue) DO UPDATE SET author_login=excluded.author_login,trusted_by=excluded.trusted_by,trusted_at=excluded.trusted_at,revoked_at=NULL`,
        repository, input.issue, input.authorLogin, input.trustedBy, now);
      } else {
        if (existing && existing.revokedAt !== null && existing.authorLogin === input.authorLogin) return existing;
        if (!existing || existing.authorLogin !== input.authorLogin)
          throw new GuardRefusal('This issue is not trusted for its current author.');
        this.#run('UPDATE issue_trust SET revoked_at=? WHERE repository=? AND issue=?', now, repository, input.issue);
      }
      return this.issueTrust(repository, input.issue)!;
    });
  }
  recordAttemptComments(identity: PlanIdentity, id: string, evidence: { count: number; digest: string }): void {
    if (!Number.isSafeInteger(evidence.count) || evidence.count < 0 || !/^[a-f0-9]{64}$/.test(evidence.digest))
      throw new GuardRefusal('Invalid prompt comment evidence.');
    const key = identityKey(identity);
    this.#transaction(() => {
      const row = this.#get('SELECT state,prompt_comments FROM attempts WHERE plan_key=? AND id=?', key, id);
      if (!row || (row.state !== 'pending' && row.state !== 'running')) throw new GuardRefusal('The attempt is no longer active.');
      const value = encode({ ...evidence, state: 'prepared' });
      if (row.prompt_comments !== null && row.prompt_comments !== value) throw new GuardRefusal('The attempt already records different prompt comments.');
      if (row.prompt_comments === null) { this.#run('UPDATE attempts SET prompt_comments=? WHERE plan_key=? AND id=?', value, key, id); this.#touch(key); }
    });
  }
  markAttemptCommentsDelivered(identity: PlanIdentity, id: string): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      const row = this.#get('SELECT state,prompt_comments FROM attempts WHERE plan_key=? AND id=?', key, id);
      if (!row || (row.state !== 'pending' && row.state !== 'running')) throw new GuardRefusal('The attempt is no longer active.');
      if (row.prompt_comments === null) throw new GuardRefusal('The attempt has no prepared prompt comment evidence.');
      const evidence = decode(row.prompt_comments) as { count?: unknown; digest?: unknown; state?: unknown };
      if (evidence.state === 'delivered') return;
      if (evidence.state !== 'prepared' || !Number.isSafeInteger(evidence.count) || (evidence.count as number) < 0
        || typeof evidence.digest !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.digest))
        throw new GuardRefusal('The attempt has invalid prompt comment evidence.');
      this.#run('UPDATE attempts SET prompt_comments=? WHERE plan_key=? AND id=?',
        encode({ count: evidence.count, digest: evidence.digest, state: 'delivered' }), key, id);
      this.#touch(key);
    });
  }
  /**
   * A safety finding sends the task to needs human (plan-format.md, "After each run"), in the transaction that settles
   * its attempt. A task cannot change status while it has an active attempt, so it is still running here: no human gate
   * can hold the finding back.
   */
  #actOnFinding(key: string): void {
    if (!this.#closed(this.#task(key).status as TaskStatus)) this.#run(`UPDATE tasks SET status='needs human' WHERE plan_key=?`, key);
  }
  /**
   * Record the runner's own safety finding on an active attempt (#87 item 3), before its terminal write, like the first
   * reason. The first finding is kept. The terminal write acts on it: never only memory, so a crash, a failed write or
   * a start through another caller cannot lose it.
   */
  recordSafetyFinding(identity: PlanIdentity, id: string, finding: string): boolean {
    if (typeof finding !== 'string' || !finding.trim()) throw new GuardRefusal('A safety finding needs its reason.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET safety_finding=? WHERE plan_key=? AND id=? AND state IN ('pending','running') AND safety_finding IS NULL`,
        bounded(finding), key, id).changes === 1;
      if (changed) this.#touch(key);
      return changed;
    });
  }
  /** Retry a finding whose original durable save failed. False keeps its escalation owed behind a human gate. */
  recordOwedSafetyFinding(identity: PlanIdentity, id: string, finding: string, options: { deferAction?: boolean } = {}): boolean {
    if (typeof finding !== 'string' || !finding.trim()) throw new GuardRefusal('A safety finding needs its reason.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const row = this.#get('SELECT state,safety_finding,safety_owed FROM attempts WHERE plan_key=? AND id=?', key, id);
      if (!row) return false;
      let changed = false;
      if (row.safety_finding === null) {
        this.#run('UPDATE attempts SET safety_finding=? WHERE plan_key=? AND id=?', bounded(finding), key, id);
        changed = true;
      }
      const before = this.#task(key).status as TaskStatus;
      const terminal = TERMINAL_STATES.includes(row.state as AttemptState);
      // A run that has just settled first makes the evidence durable, then lets the executor apply every current-state
      // precondition (including an active merge) before it clears the debt. Recovery and later runs may act here.
      const acted = !terminal || (!options.deferAction && !HUMAN_GATES.includes(before));
      const owed = terminal && !acted ? 1 : 0;
      if (row.safety_owed !== owed) {
        this.#run('UPDATE attempts SET safety_owed=? WHERE plan_key=? AND id=?', owed, key, id);
        changed = true;
      }
      if (terminal && acted && !options.deferAction) this.#actOnFinding(key);
      if (changed || this.#task(key).status !== before) this.#touch(key);
      return acted;
    });
  }
  /** Clear a durable escalation debt only in the same write that successfully acts on it. */
  settleOwedSafetyFinding(identity: PlanIdentity, id: string): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      if (this.#run('UPDATE attempts SET safety_owed=0 WHERE plan_key=? AND id=? AND safety_owed=1', key, id).changes === 1) this.#touch(key);
    });
  }
  /** Terminal findings whose evidence is durable but whose escalation is still blocked by a human gate. */
  owedSafetyFindings(): { attemptId: string; finding: string }[] {
    return this.#db.prepare('SELECT id,safety_finding FROM attempts WHERE safety_owed=1 AND safety_finding IS NOT NULL ORDER BY rowid').all()
      .map(row => ({ attemptId: row.id as string, finding: row.safety_finding as string }));
  }

  /** Every durable change to a task or its attempts increases the state version. */
  #touch(key: string): void {
    this.#run('UPDATE tasks SET state_version=state_version+1, updated_at=? WHERE plan_key=?', new Date().toISOString(), key);
  }
  /** A change an attempt depends on increases both counters in the caller's transaction. */
  /** Runner writes that change the reviewed context (rebase, ledger owners) wait for a merge and never follow a close. */
  #assertContextWritable(key: string): void {
    if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    if (this.#taskClosed(key)) throw new GuardRefusal('A closed task never changes.');
  }
  /** Whether the task is merged or cancelled. False before createPlan has inserted the task row. */
  #taskClosed(key: string): boolean {
    const row = this.#get('SELECT status FROM tasks WHERE plan_key=?', key);
    return !!row && this.#closed(row.status as TaskStatus);
  }
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
  #closeTask(key: string, status: 'merged' | 'cancelled', actionId: string, context?: { revision: number; snapshotId: string }): void {
    // A merge closes the task in the context it merged, even if HEAD was observed to move during the merge.
    const current = this.#current(key);
    const plan = context ? { ...current, revision: context.revision, snapshot_id: context.snapshotId } : current;
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
  /** The latest attempts, oldest first, for status views: results are flagged, not read. */
  recentAttempts(identity: PlanIdentity, limit: number): (Omit<AttemptRecord, 'result'> & { hasResult: boolean })[] {
    return this.#db.prepare(`SELECT * FROM (SELECT id, kind, phase, item, state, context, deadline, first_reason, stop_reason, exit_code, signal,
      NULL AS result, result IS NOT NULL AS has_result, diagnostic, diagnostic_ref, prompt_comments, created_at, started_at, settled_at, rowid AS row_order
      FROM attempts WHERE plan_key=? ORDER BY rowid DESC LIMIT ?) ORDER BY row_order`).all(identityKey(identity), limit)
      .map(row => { const { result: _result, ...attempt } = this.#attemptRecord(row); return { ...attempt, hasResult: row.has_result === 1 }; });
  }
  /** What `ItemExecutor.progress` needs about execute attempts. It decodes only completed results' small head field. */
  executeProgress(identity: PlanIdentity, revision: number): { started: boolean; begun: boolean; earlierCommits: boolean; finished: string[]; finishedHeads: Record<string, string | null> } {
    const key = identityKey(identity), rev = "json_extract(context,'$.planRevision')";
    const row = this.#get(`SELECT COUNT(*) > 0 AS started, COALESCE(SUM(${rev} = ?), 0) > 0 AS begun
      FROM attempts WHERE plan_key=? AND kind='execute' AND item IS NOT NULL`, revision, key)!;
    // Any writable kind's commit counts, as for hasRunnerCommit. Unlike it, a completed result that does not say it is unchanged
    // (not valid JSON, or no `unchanged` field) counts as a commit: this check refuses a run, so it fails closed.
    const earlier = this.#get(`SELECT 1 AS found FROM attempts WHERE plan_key=? AND kind IN (${WRITABLE_KINDS.map(() => '?').join(',')})
      AND state='completed' AND ${rev} != ? AND (NOT json_valid(result) OR COALESCE(json_extract(result,'$.unchanged'), 0) = 0) LIMIT 1`,
      key, ...WRITABLE_KINDS, revision);
    const finishedRows = this.#db.prepare(`SELECT item,CASE WHEN json_valid(result)
      THEN CASE WHEN json_type(result,'$.head')='text' THEN json_extract(result,'$.head') ELSE NULL END ELSE NULL END AS head
      FROM attempts WHERE plan_key=? AND kind='execute' AND item IS NOT NULL
      AND state='completed' AND ${rev} = ? ORDER BY rowid`).all(key, revision);
    const finishedHeads: Record<string, string | null> = Object.create(null);
    for (const entry of finishedRows) {
      const head = typeof entry.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.head) ? entry.head : null;
      finishedHeads[entry.item as string] = head;
    }
    return { started: row.started === 1, begun: row.begun === 1, earlierCommits: !!earlier,
      finished: Object.keys(finishedHeads), finishedHeads };
  }
  /** Claim recovery when a user's Resume settles owed work instead of admitting a replacement attempt. */
  claimRequeue(identity: PlanIdentity, expectedStateVersion: number): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      const task = this.#task(key);
      if (task.state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (task.requeue_pending !== 1) throw new GuardRefusal('The requeue was already claimed.');
      this.#run('UPDATE tasks SET requeue_pending=0 WHERE plan_key=?', key); this.#touch(key);
    });
  }
  /** The heads of completed execute attempts that changed files outside their plan item, oldest first. */
  scopeFindingHeads(identity: PlanIdentity): string[] {
    return this.#db.prepare(`SELECT json_extract(result,'$.head') AS head FROM attempts WHERE plan_key=? AND kind='execute' AND state='completed'
      AND json_valid(result) AND json_array_length(json_extract(result,'$.outOfScope')) > 0 ORDER BY rowid`).all(identityKey(identity)).map(row => row.head as string);
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
      const task = this.#task(key);
      if (task.state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (this.#closed(task.status as TaskStatus)) throw new GuardRefusal('A closed task never changes.');
      if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
      if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is in progress for this task.');
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
      if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
      if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is in progress for this task.');
      this.#run('UPDATE tasks SET status=? WHERE plan_key=?', to, key);
      this.#touch(key);
    });
  }
  /** GitHub may still merge the reviewed head while the latest merge attempt is submitting or queued. */
  #activeMerge(key: string): boolean {
    const row = this.#get('SELECT data FROM merge_attempts WHERE key=? ORDER BY rowid DESC LIMIT 1', key);
    return !!row && ['submitting', 'queued'].includes(decode<MergeAttempt>(row.data).state);
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
    // Re-checked when committed: only a still-open, idle task whose budget has passed moves to needs human.
    const expire = () => {
      const task = this.#task(key);
      if ((task.status !== 'running' && task.status !== 'queued') || task.budget_deadline === null
        || (task.budget_deadline as number) > now || this.#activeAttempt(key)) return;
      this.#run("UPDATE tasks SET status='needs human' WHERE plan_key=?", key);
      this.#touch(key);
    };
    try {
      return this.#transaction((): AttemptRecord => {
        const task = this.#task(key);
        const reviewCheck = input.kind === 'check' && MERGEABLE_STATUSES.includes(task.status as TaskStatus);
        if (!reviewCheck && task.status !== 'running' && task.status !== 'queued') throw new GuardRefusal(`The task is ${task.status}; it cannot start work.`);
        if (task.state_version !== input.expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
        // Requeue claim: exactly one path (I3's requeue, or the user's Resume) clears it, by CAS in this admitting transaction.
        if (task.requeue_pending === 1 && !input.claimRequeue) throw new GuardRefusal('Recovery is requeueing this task.');
        if (input.claimRequeue && task.requeue_pending !== 1) throw new GuardRefusal('The requeue was already claimed.');
        if (task.cancel_requested !== null) throw new GuardRefusal('The task is being cancelled.');
        if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is already active for this task.');
        if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
        if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is in progress for this task.');
        // The code-writing task budget (null until execution starts) ends execution admission. Review checks have their
        // own exact-head deadline and must remain runnable after implementation ends.
        if (!reviewCheck && task.budget_deadline !== null && (task.budget_deadline as number) <= now)
          throw new RefusalWithEffect('The task time budget has run out; it needs a person.', expire);
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
        if (reviewCheck) this.#run('UPDATE tasks SET current_attempt_id=? WHERE plan_key=?', id, key);
        else this.#run(`UPDATE tasks SET current_attempt_id=?, status='running', requeue_pending=0, budget_deadline=COALESCE(budget_deadline, ?) WHERE plan_key=?`, id, now + budgetMs, key);
        this.#touch(key);
        return this.getAttempt(identity, id);
      });
    } catch (error) {
      // Inside userAction the effect commits with the saved refusal instead (depth > 0 here).
      if (error instanceof RefusalWithEffect && this.#depth === 0) this.#transaction(error.effect);
      throw error;
    }
  }
  /** The "Stopping" transition: sets the first reason once, keeps the state. */
  recordFirstReason(identity: PlanIdentity, id: string, reason: FirstReason): boolean {
    if (!FIRST_REASONS.includes(reason)) throw new GuardRefusal('Unknown stop reason.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET first_reason=? WHERE plan_key=? AND id=?
        AND state IN ('pending','running') AND first_reason IS NULL AND stop_reason IS NULL`, reason, key, id).changes === 1;
      if (changed) this.#touch(key);
      return changed;
    });
  }
  /** Persist an invocation-owned timeout without recasting it as a user, shutdown, stale, or task-budget stop. */
  recordAttemptTimeout(identity: PlanIdentity, id: string): boolean {
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET stop_reason='timeout' WHERE plan_key=? AND id=?
        AND state IN ('pending','running') AND first_reason IS NULL AND stop_reason IS NULL`, key, id).changes === 1;
      if (changed) this.#touch(key);
      return changed;
    });
  }
  /** pending -> running after D returns a handle. Refused once a first reason is recorded. */
  markRunning(identity: PlanIdentity, id: string): boolean {
    const key = identityKey(identity);
    return this.#transaction(() => {
      const changed = this.#run(`UPDATE attempts SET state='running', started_at=? WHERE plan_key=? AND id=? AND state='pending'
        AND first_reason IS NULL AND stop_reason IS NULL
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
    /** Writable attempts: the runner's commit, recorded with `completed` in this same transaction. */
    history?: { base: string; head: string; entries: readonly LedgerEntry[] };
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
      const reviewCheck = row.kind === 'check' && MERGEABLE_STATUSES.includes(task.status as TaskStatus);
      if (outcome.state === 'completed' && ((!reviewCheck && task.status !== 'running') || task.cancel_requested !== null))
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
      // The guards above ran first; recording history now advances the context without invalidating this attempt.
      if (outcome.state === 'completed' && settlement.history) {
        const context = decode<InvocationContext>(row.context);
        this.recordHistory(identity, { revision: context.planRevision, snapshotId: context.snapshotId }, settlement.history.base, settlement.history.head, settlement.history.entries);
      }
      // A pending cancel task wins over everything, including the time limit and a safety finding.
      if (task.cancel_requested !== null && !this.#closed(task.status)) {
        this.#closeTask(key, 'cancelled', task.cancel_requested as string);
      } else {
        if (outcome.timeLimit && !this.#closed(task.status)) this.#run(`UPDATE tasks SET status='needs human' WHERE plan_key=?`, key);
        // The runner's safety finding wins over the outcome: a stop or a stale context does not undo what the agent did.
        if (row.safety_finding !== null) this.#actOnFinding(key);
        this.#touch(key);
      }
      return outcome;
    });
  }
  /** Passing evidence for exactly this item, head and command list. Interrupted, failed, stale and older-head rows do not count. */
  commandChecksPassed(identity: PlanIdentity, item: string, head: string, commandsDigest: string): boolean {
    sha(head);
    if (!/^[a-f0-9]{64}$/.test(commandsDigest)) throw new Error('Invalid command-check digest.');
    // The latest attempt for this item and materialized head is authoritative. A later failure, cancellation or
    // interruption must invalidate an older pass even though terminal failures deliberately carry no result payload.
    const row = this.#get(`SELECT a.state, a.result FROM attempts a JOIN snapshots s
      ON s.key=a.plan_key AND s.id=json_extract(a.context,'$.snapshotId')
      WHERE a.plan_key=? AND a.kind='check' AND a.item=? AND json_extract(s.data,'$.head')=?
      ORDER BY a.rowid DESC LIMIT 1`, identityKey(identity), item, head);
    if (!row || row.state !== 'completed' || typeof row.result !== 'string') return false;
    const result = decode<Record<string, unknown>>(row.result);
    return result.passed === true && result.head === head && result.commandsDigest === commandsDigest;
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
      if (task.rebase_in_progress !== null) {
        if (task.cancel_requested !== null) throw new GuardRefusal('The task is already being cancelled.');
        this.#run('UPDATE tasks SET cancel_requested=? WHERE plan_key=?', actionId, key);
        this.#touch(key);
        return 'stopping';
      }
      if (!active) { this.#closeTask(key, 'cancelled', actionId); return 'closed'; }
      if (task.cancel_requested !== null) throw new GuardRefusal('The task is already being cancelled.');
      this.#run(`UPDATE attempts SET first_reason='cancelled' WHERE id=? AND first_reason IS NULL AND stop_reason IS NULL`, active.id!);
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
    const saved = () => this.savedAction<T>(identity, action);
    const record = (outcome: object) => {
      const response = encode(outcome);
      if (response.length > 65536) throw new Error('Action response is too large to record.');
      this.#run('INSERT INTO user_actions VALUES (?,?,?,?,?,?)', key, action.actionId, action.kind, hash, response, new Date().toISOString());
    };
    let replaying = false;
    let restarting = false;
    try {
      return this.#transaction(() => {
        const prior = saved(); if (prior) { replaying = true; return prior; }
        // A background storage failure leaves a tombstone: it blocks older preparation readiness while validation is
        // retried, and is replaced atomically by this same request rather than exposed as a replay.
        restarting = this.#run(`DELETE FROM user_actions WHERE plan_key=? AND action_id=? AND kind='prepare-merge'
          AND request_hash=? AND json_extract(response,'$.ok')=1
          AND json_extract(response,'$.value.outcome')='resendable'`, key, action.actionId, hash).changes === 1;
        const outer = this.#action;
        this.#action = { key, actionId: action.actionId };
        let value: T;
        try { value = apply(); } finally { this.#action = outer; }
        record({ ok: true, value });
        return { response: value, replayed: false };
      });
    } catch (error) {
      const storage = (error as { code?: string }).code === 'ERR_SQLITE_ERROR' || error instanceof ShuttingDownError;
      if (!replaying && !storage && !(error instanceof ActionIdReused) && !(error instanceof BadRequest) && this.#depth === 0) {
        const message = error instanceof Error ? bounded(error.message) : 'Refused.';
        this.#transaction(() => {
          if (restarting) this.#run(`DELETE FROM user_actions WHERE plan_key=? AND action_id=? AND kind='prepare-merge'
            AND request_hash=? AND json_extract(response,'$.ok')=1
            AND json_extract(response,'$.value.outcome')='resendable'`, key, action.actionId, hash);
          if (!this.#get('SELECT 1 FROM user_actions WHERE plan_key=? AND action_id=?', key, action.actionId))
            record({ ok: false, error: message, ...(error instanceof UpstreamFailure ? { kind: 'upstream' } : {}) });
          if (error instanceof RefusalWithEffect) error.effect();
        });
      }
      throw error;
    }
  }
  /**
   * The saved outcome of a user action, or undefined if it has none. Lets a caller replay before slow validation.
   * Throws ActionIdReused for a different request under the same ID, and the saved refusal for a refused action.
   */
  savedAction<T>(identity: PlanIdentity, action: { actionId: string; kind: string; request: unknown }): { response: T; replayed: true } | undefined {
    assertUuidV4(action.actionId, 'Action ID');
    const row = this.#get('SELECT * FROM user_actions WHERE plan_key=? AND action_id=?', identityKey(identity), action.actionId);
    if (!row) return undefined;
    if (row.request_hash !== requestHash(action.kind, action.request)) throw new ActionIdReused('Action ID already used for a different request.');
    const outcome = decode<{ ok: boolean; value?: T & { outcome?: unknown }; error?: string; kind?: string }>(row.response);
    if (row.kind === 'prepare-merge' && outcome.ok && outcome.value?.outcome === 'resendable') return undefined;
    if (!outcome.ok) throw outcome.kind === 'upstream' ? new UpstreamFailure(outcome.error!) : new GuardRefusal(outcome.error!);
    return { response: outcome.value as T, replayed: true };
  }
  /** Settle the exact admitted pre-merge action so retry/restart replay never remains at `preparing`. */
  settlePreMergeAction(identity: PlanIdentity, actionId: string, result: PreMergeActionResult,
    readiness: PreMergeReadiness | null = null): PreMergeActionResult {
    assertUuidV4(actionId, 'Action ID');
    const key = identityKey(identity);
    return this.#transaction(() => {
      let effective = result;
      if (result.state === 'ready') {
        const task = this.#task(key), current = this.#current(key), snapshot = this.getSnapshot(identity);
        if (!readiness || task.state_version !== readiness.stateVersion || current.review_version !== readiness.reviewVersion
          || current.snapshot_id !== readiness.snapshotId || snapshot.base !== readiness.base || snapshot.head !== readiness.head
          || result.base !== readiness.base || result.head !== readiness.head) {
          effective = { ...result, state: 'review-required', reason: 'The task or review changed before preparation readiness was recorded. Prepare the merge again.' };
          readiness = null;
        }
      }
      const response = encode({ ok: true, value: preMergeActionResponse(effective), ...(readiness ? { preMergeReadiness: readiness } : {}) });
      if (response.length > 65536) throw new Error('Action response is too large to record.');
      const changed = this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND action_id=? AND kind='prepare-merge'
        AND json_extract(response,'$.ok')=1 AND json_extract(response,'$.value.outcome')='preparing'`,
        response, key, actionId).changes;
      if (changed !== 1) throw new Error('The pre-merge action no longer owns settlement.');
      return effective;
    });
  }
  /**
   * A background preparation whose terminal write failed applied no durable readiness. Replace only its still-pending
   * placeholder with a tombstone so the same key can be resent without revealing an older ready preparation.
   */
  makePreMergeActionResendable(identity: PlanIdentity, actionId: string): boolean {
    assertUuidV4(actionId, 'Action ID');
    return this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND action_id=? AND kind='prepare-merge'
      AND json_extract(response,'$.ok')=1 AND json_extract(response,'$.value.outcome')='preparing'`,
      encode({ ok: true, value: { outcome: 'resendable' } }), identityKey(identity), actionId).changes === 1;
  }
  /** The latest preparation action is authoritative and must match every current local generation and the exact pair. */
  preMergeReady(identity: PlanIdentity, readiness: PreMergeReadiness): boolean {
    const row = this.#get("SELECT response FROM user_actions WHERE plan_key=? AND kind='prepare-merge' ORDER BY rowid DESC LIMIT 1",
      identityKey(identity));
    if (!row) return false;
    const saved = decode<{ ok?: unknown; value?: { outcome?: unknown }; preMergeReadiness?: PreMergeReadiness }>(row.response);
    return saved.ok === true && saved.value?.outcome === 'ready' && stable(saved.preMergeReadiness) === stable(readiness);
  }
  /** Startup recovery makes an interrupted preparation definite and replayable before new work is admitted. */
  settleInterruptedPreMergeActions(identity: PlanIdentity): void {
    const snapshot = this.getSnapshot(identity);
    const result: PreMergeActionResult = { state: 'failed', base: snapshot.base, head: snapshot.head, checked: [],
      reason: 'The server restarted before pre-merge preparation completed. Start a new preparation.' };
    this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND kind='prepare-merge'
      AND json_extract(response,'$.ok')=1 AND json_extract(response,'$.value.outcome')='preparing'`,
      encode({ ok: true, value: preMergeActionResponse(result) }), identityKey(identity));
  }
  /** Append one feedback event. Call inside userAction so the event and its action share one transaction. */
  recordFeedback(identity: PlanIdentity, actionId: string, event: { kind: Exclude<FeedbackKind, 'task-closed'>; item?: string | null; text?: string | null; sourceRef: string; supersedes?: string | null; supersedeLatest?: boolean }): FeedbackEvent {
    assertUuidV4(actionId, 'Action ID');
    if (this.#depth === 0 || this.#action?.key !== identityKey(identity) || this.#action.actionId !== actionId)
      throw new Error('Feedback events are written inside their user action, with its action ID.');
    // task-closed is the last event: J reads a task's feedback once, when it closes.
    if (this.#taskClosed(identityKey(identity))) throw new GuardRefusal('A closed task never changes.');
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

  // ---- F2d: the pre-PR already-fixed check and PR opening ----
  #migrateV7(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS already_fixed_checks (
        id TEXT PRIMARY KEY, plan_key TEXT NOT NULL REFERENCES tasks(plan_key), snapshot_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('clear','found','unknown')), result TEXT NOT NULL,
        state_version INTEGER NOT NULL, review_version INTEGER NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_pull_requests (
        opening_id TEXT PRIMARY KEY, plan_key TEXT NOT NULL REFERENCES tasks(plan_key), repository TEXT NOT NULL, base TEXT NOT NULL,
        head_branch TEXT NOT NULL, head_sha TEXT NOT NULL, draft INTEGER NOT NULL, owner_version INTEGER NOT NULL, owner_review_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('opening','opened','abandoned')), number INTEGER, url TEXT,
        refresh_head TEXT, refresh_draft INTEGER, refresh_version INTEGER, refresh_review_version INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK ((state = 'opened') = (number IS NOT NULL AND url IS NOT NULL)));
      CREATE UNIQUE INDEX IF NOT EXISTS task_pull_requests_number ON task_pull_requests (lower(repository), number) WHERE number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS task_pull_requests_opening ON task_pull_requests (plan_key) WHERE state = 'opening';
      CREATE INDEX IF NOT EXISTS already_fixed_checks_task ON already_fixed_checks (plan_key);
      CREATE INDEX IF NOT EXISTS task_pull_requests_task ON task_pull_requests (plan_key);
      PRAGMA user_version=7;`);
  }
  #pullRequestRecord(row: Record<string, SQLOutputValue>): TaskPullRequest {
    return {
      openingId: row.opening_id as string, repository: row.repository as string, base: row.base as string, headBranch: row.head_branch as string,
      headSha: row.head_sha as string, draft: row.draft === 1, state: row.state as TaskPullRequest['state'],
      number: row.number as number | null, url: row.url as string | null, createdAt: row.created_at as string,
      ownerVersion: row.owner_version as number, ownerReviewVersion: row.owner_review_version as number,
      refresh: row.refresh_head === null ? null : { head: row.refresh_head as string, draft: row.refresh_draft === 1, stateVersion: row.refresh_version as number },
    };
  }
  /** Every PR codeboost opened or started to open for the task, oldest first. */
  taskPullRequests(identity: PlanIdentity): TaskPullRequest[] {
    const key = identityKey(identity); this.#task(key);
    return this.#db.prepare('SELECT * FROM task_pull_requests WHERE plan_key=? ORDER BY rowid').all(key).map(row => this.#pullRequestRecord(row));
  }
  latestAlreadyFixed(identity: PlanIdentity): AlreadyFixedCheck | null {
    const key = identityKey(identity); this.#task(key);
    const row = this.#get('SELECT * FROM already_fixed_checks WHERE plan_key=? ORDER BY rowid DESC LIMIT 1', key);
    return row ? { id: row.id as string, snapshotId: row.snapshot_id as string, result: decode<AlreadyFixedResult>(row.result), stateVersion: row.state_version as number, reviewVersion: row.review_version as number, checkedAt: row.checked_at as string } : null;
  }
  /** Publishing runs after the task's last attempt settled, while the task is running, or in needs human for a draft PR. */
  #assertPublishable(identity: PlanIdentity, task: Record<string, SQLOutputValue>, expectedStateVersion: number, draft: boolean): void {
    const key = identityKey(identity);
    if (task.state_version !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
    if (task.status !== (draft ? 'needs human' : 'running')) throw new GuardRefusal(`A ${draft ? 'draft ' : ''}pull request cannot be opened while the task is ${task.status}.`);
    if (this.#activeAttempt(key)) throw new GuardRefusal('An attempt is still active for this task.');
    if (this.#activeMerge(key)) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    // Interrupted work waiting to be requeued, or a rebase in progress, is not finished work to publish.
    if (task.requeue_pending === 1) throw new GuardRefusal('The task has interrupted work waiting to be requeued.');
    if (task.rebase_in_progress !== null) throw new GuardRefusal('A rebase is in progress for this task.');
    // A ready PR is finished work: every item of the current plan revision has a completed execute attempt. Checked here,
    // at every guarded publish write, so a plan revision that adds an item while a publish awaits GitHub refuses it.
    if (!draft) {
      const current = this.#current(key), revision = current.revision as number;
      const items = decode<Plan>(this.#get('SELECT data FROM revisions WHERE key=? AND revision=?', key, revision)!.data).items;
      const finished = new Set(this.#db.prepare(`SELECT DISTINCT item FROM attempts WHERE plan_key=? AND kind='execute' AND item IS NOT NULL
        AND state='completed' AND json_extract(context,'$.planRevision') = ?`).all(key, revision).map(entry => entry.item as string));
      const checkpoint = this.latestCheckpoint(identity), continuation = checkpoint ? this.continuationProgress(identity) : null;
      if (continuation) {
        if (!this.continuationApproved(identity, continuation)) throw new GuardRefusal('The current continuation revision is not approved for publishing.');
        for (const item of continuation.completed) finished.add(item);
      }
      const unrun = items.find(item => !finished.has(item.id));
      if (unrun) throw new GuardRefusal(`${unrun.id} has not run yet; publish once every plan item has run.`);
    }
  }
  /**
   * Records a pre-PR check. A match, or a check that could not be completed, moves a running task to possibly already
   * fixed in the same transaction. A needs-human task keeps its status; its draft PR is not opened.
   */
  recordAlreadyFixed(identity: PlanIdentity, expectedStateVersion: number, input: { snapshotId: string; reviewVersion: number; draft: boolean; result: AlreadyFixedResult }): AlreadyFixedCheck {
    if (!['clear', 'found', 'unknown'].includes(input.result?.outcome)) throw new Error('Invalid already-fixed result.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      const task = this.#task(key);
      this.#assertPublishable(identity, task, expectedStateVersion, input.draft);
      if (this.#current(key).snapshot_id !== input.snapshotId) throw new GuardRefusal('The task head changed during the check.');
      if (input.result.outcome !== 'clear' && !input.draft) this.#run("UPDATE tasks SET status='possibly already fixed' WHERE plan_key=?", key);
      this.#touch(key);
      const id = randomUUID(), checkedAt = new Date().toISOString(), stateVersion = this.#task(key).state_version as number;
      // Review input (approvals, choices, notes) advances review_version without touching the task; bind the check to both,
      // and refuse a result the publish obtained before a review change (it would move the task on stale review state).
      const reviewVersion = this.#current(key).review_version as number;
      if (reviewVersion !== input.reviewVersion) throw new GuardRefusal('The review changed during the check. Reload before writing.');
      this.#run('INSERT INTO already_fixed_checks (id,plan_key,snapshot_id,outcome,result,state_version,review_version,checked_at) VALUES (?,?,?,?,?,?,?,?)',
        id, key, input.snapshotId, input.result.outcome, encode(input.result), stateVersion, reviewVersion, checkedAt);
      return { id, snapshotId: input.snapshotId, result: input.result, stateVersion, reviewVersion, checkedAt };
    });
  }
  /**
   * Records the intent to open a PR, immediately before the GitHub call. It requires a clear check with no task change
   * since it was recorded, so the check and the PR bind to the same head (AGENTS.md: re-read before an irreversible action).
   */
  beginPullRequest(identity: PlanIdentity, input: { checkId: string; repository: string; base: string; headBranch: string; headSha: string; draft: boolean }): TaskPullRequest {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#assertCheckedHead(identity, input);
      if (this.#get("SELECT 1 FROM task_pull_requests WHERE plan_key=? AND state='opening'", key)) throw new GuardRefusal('A pull request is already being opened; recover it first.');
      const openingId = randomUUID(), now = new Date().toISOString();
      this.#touch(key);
      this.#run(`INSERT INTO task_pull_requests (opening_id,plan_key,repository,base,head_branch,head_sha,draft,owner_version,owner_review_version,state,number,url,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'opening',NULL,NULL,?,?)`, openingId, key, input.repository, input.base, input.headBranch, input.headSha, input.draft ? 1 : 0,
        this.#task(key).state_version as number, this.#current(key).review_version as number, now, now);
      return this.taskPullRequests(identity).find(pr => pr.openingId === openingId)!;
    });
  }
  /**
   * Records an update of the task's open PR before it starts, under the same guard as an opening. The PATCH and the
   * draft change may land even if their confirmation is lost; the record keeps that visible until the update is
   * confirmed or abandoned. Returns the state version the update owns.
   */
  beginRefresh(identity: PlanIdentity, input: { checkId: string; openingId: string; headSha: string; draft: boolean }): number {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#assertCheckedHead(identity, input);
      // Only an opened PR is refreshed; an abandoned opening's PR is adopted first, by adoptOpening, when publish sees it.
      const row = this.#get('SELECT state FROM task_pull_requests WHERE plan_key=? AND opening_id=?', key, input.openingId);
      if (row?.state !== 'opened') throw new GuardRefusal('Unknown pull request.');
      this.#touch(key);
      const version = this.#task(key).state_version as number;
      this.#run('UPDATE task_pull_requests SET refresh_head=?, refresh_draft=?, refresh_version=?, refresh_review_version=?, updated_at=? WHERE opening_id=?',
        input.headSha, input.draft ? 1 : 0, version, this.#current(key).review_version as number, new Date().toISOString(), input.openingId);
      return version;
    });
  }
  /**
   * Settles an update whose confirmation was lost. What GitHub shows now (`observed`, or null when the PR is no longer
   * open) replaces the recorded draft flag and head, so a change that landed is not forgotten; then the in-flight record
   * is cleared. The next publish checks again and repeats the update (it is idempotent).
   */
  settleUnconfirmedRefresh(identity: PlanIdentity, openingId: string, observed: { number: number; draft: boolean; headSha: string } | null): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      const row = this.#get("SELECT number FROM task_pull_requests WHERE plan_key=? AND opening_id=? AND refresh_head IS NOT NULL", key, openingId);
      if (!row) throw new GuardRefusal('No update of this pull request is in flight.');
      if (observed && observed.number === row.number)
        this.#run('UPDATE task_pull_requests SET draft=?, head_sha=? WHERE opening_id=?', observed.draft ? 1 : 0, observed.headSha, openingId);
      this.#run("UPDATE task_pull_requests SET refresh_head=NULL, refresh_draft=NULL, refresh_version=NULL, refresh_review_version=NULL, updated_at=? WHERE opening_id=?",
        new Date().toISOString(), openingId);
      this.#touch(key);
    });
  }
  /**
   * Right before an update's GitHub calls, after the push's await: the task and its review are still exactly as the
   * update recorded them, and the task is still publishable. A change during the push leaves the update in flight.
   */
  assertRefreshCurrent(identity: PlanIdentity, openingId: string, draft: boolean): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      const row = this.#get("SELECT refresh_version, refresh_review_version FROM task_pull_requests WHERE plan_key=? AND opening_id=? AND refresh_head IS NOT NULL", key, openingId);
      if (!row) throw new GuardRefusal('No update of this pull request is in flight.');
      this.#assertPublishable(identity, this.#task(key), row.refresh_version as number, draft);
      if (this.#current(key).review_version !== row.refresh_review_version) throw new GuardRefusal('The review changed after the check. Reload before writing.');
    });
  }
  #assertVersions(key: string, expected: { stateVersion: number; reviewVersion: number }): void {
    if (this.#task(key).state_version !== expected.stateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
    if (this.#current(key).review_version !== expected.reviewVersion) throw new GuardRefusal('The review changed. Reload before writing.');
  }
  #assertCheckedHead(identity: PlanIdentity, input: { checkId: string; headSha: string; draft: boolean }): void {
    const key = identityKey(identity), task = this.#task(key), check = this.latestAlreadyFixed(identity);
    if (!check || check.id !== input.checkId || check.result.outcome !== 'clear') throw new GuardRefusal('A clear already-fixed check must come right before opening a pull request.');
    this.#assertPublishable(identity, task, check.stateVersion, input.draft);
    if (this.#current(key).review_version !== check.reviewVersion) throw new GuardRefusal('The review changed after the check. Reload before writing.');
    const snapshot = this.getSnapshot(identity);
    if (snapshot.id !== check.snapshotId || snapshot.head !== input.headSha) throw new GuardRefusal('The task head changed after the check.');
  }
  /**
   * An opening's PR exists. The record is kept whatever happened to the task meanwhile, so the PR can still be found and
   * closed. The task status changes only when the task is unchanged since the opening began (its owned state version),
   * and only when `mayReview`: recovery passes false for a PR the main path would refuse (in another base than the
   * configured one, or with another of the task's PRs open), so such a PR is recorded but never puts the task in review.
   */
  recordPullRequestOpened(identity: PlanIdentity, openingId: string, pr: { number: number; url: string; headSha: string; draft: boolean }, mayReview = true): TaskStatus {
    const key = identityKey(identity);
    return this.#confirmPullRequest(key, pr, mayReview, () =>
      this.#get("SELECT * FROM task_pull_requests WHERE plan_key=? AND opening_id=? AND state='opening'", key, openingId),
      row => ({ head: row.head_sha as string, owned: row.owner_version as number, ownedReview: row.owner_review_version as number }), openingId, 'No pull request is being opened with this ID.');
  }
  /** A refresh of the task's open PR landed, for the head and state version beginRefresh recorded. Same status rule. */
  recordRefreshConfirmed(identity: PlanIdentity, openingId: string, pr: { number: number; url: string; headSha: string; draft: boolean },
    refresh: { head: string; stateVersion: number }): TaskStatus {
    const key = identityKey(identity);
    return this.#confirmPullRequest(key, pr, true, () =>
      this.#get("SELECT * FROM task_pull_requests WHERE plan_key=? AND opening_id=? AND state='opened' AND number=? AND refresh_head=? AND refresh_version=?",
        key, openingId, pr.number, refresh.head, refresh.stateVersion),
      row => ({ head: refresh.head, owned: refresh.stateVersion, ownedReview: row.refresh_review_version as number }), openingId, 'No update of this pull request is in flight.');
  }
  #confirmPullRequest(key: string, pr: { number: number; url: string; headSha: string; draft: boolean }, mayReview: boolean, find: () => Record<string, SQLOutputValue> | undefined,
    expected: (row: Record<string, SQLOutputValue>) => { head: string; owned: number; ownedReview: number }, openingId: string, missing: string): TaskStatus {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.url !== 'string') throw new Error('Invalid pull request.');
    return this.#transaction(() => {
      const row = find();
      if (!row) throw new GuardRefusal(missing);
      const { head, owned, ownedReview } = expected(row);
      // The record keeps the head GitHub reports, which may differ from the head that was pushed.
      this.#run("UPDATE task_pull_requests SET state='opened', number=?, url=?, draft=?, head_sha=?, refresh_head=NULL, refresh_draft=NULL, refresh_version=NULL, refresh_review_version=NULL, updated_at=? WHERE opening_id=?",
        pr.number, pr.url, pr.draft ? 1 : 0, pr.headSha, new Date().toISOString(), openingId);
      const task = this.#task(key);
      // Every status change and every admission increases the state version, so an unchanged version means the task is
      // still in the status the opening or refresh was guarded for with no attempt active. Review input advances only the
      // review version, so that must be unchanged too. A needs-human task stays there whatever the PR looks like; only a
      // running task can move to in review, and only with a ready PR at the head it pushed. A PR showing another head
      // (GitHub has not caught up, or someone else pushed) leaves the task running; the publisher makes it a draft and
      // the next publish reconciles it.
      if (mayReview && task.state_version === owned && this.#current(key).review_version === ownedReview && task.status === 'running'
        && pr.headSha === head && !pr.draft) {
        this.#run("UPDATE tasks SET status='in review' WHERE plan_key=?", key);
      }
      this.#touch(key);
      return this.#task(key).status as TaskStatus;
    });
  }
  /**
   * An abandoned opening whose PR became visible is the task's PR after all: record its number, URL and draft state so
   * it can be reused, closed or cleaned up. The task status does not change. Guarded by the state version the caller
   * read; returns the new state version.
   */
  adoptOpening(identity: PlanIdentity, openingId: string, pr: { number: number; url: string; draft: boolean }, expected: { stateVersion: number; reviewVersion: number }): number {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.url !== 'string') throw new Error('Invalid pull request.');
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#assertVersions(key, expected);
      if (this.#run("UPDATE task_pull_requests SET state='opened', number=?, url=?, draft=?, updated_at=? WHERE plan_key=? AND opening_id=? AND state='abandoned'",
        pr.number, pr.url, pr.draft ? 1 : 0, new Date().toISOString(), key, openingId).changes !== 1) throw new GuardRefusal('No abandoned opening with this ID.');
      this.#touch(key);
      return this.#task(key).state_version as number;
    });
  }
  /**
   * Record a publish's outcome. An observation, not a task change: the task's state version does not move, so a refused
   * publish leaves the task exactly as it was. Settlement writes go through the shutdown capability.
   */
  recordPublish(identity: PlanIdentity, record: Omit<PublishRecord, 'stateVersion' | 'at'>, actionId?: string, seenVersion?: number): PublishRecord {
    const key = identityKey(identity);
    return this.#transaction(() => {
      // The version the publish last saw, when it reported one (#114); otherwise the current one, which it ended on.
      const current = this.#task(key).state_version as number;
      if (seenVersion !== undefined && (!Number.isSafeInteger(seenVersion) || seenVersion > current)) throw new Error('Invalid seen state version.');
      const saved: PublishRecord = { ...record, message: record.message.slice(0, 2000), stateVersion: seenVersion ?? current, at: new Date().toISOString() };
      this.#run('INSERT INTO publish_outcomes (plan_key,data) VALUES (?,?) ON CONFLICT(plan_key) DO UPDATE SET data=excluded.data', key, encode(saved));
      // The same transaction refreshes the publish action's replay, as for a merge, so a resent click reports this outcome.
      // A reply still saying `publishing` or `closing` is an action whose job never recorded an outcome: its process stopped
      // (a crash) before it could. One publish or close runs per task, so this outcome is that action's continuation and
      // settles it too; otherwise its replay would say `publishing` or `closing` for ever.
      this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND kind IN ('publish','close-pull-requests') AND json_extract(response,'$.ok')=1
        AND (action_id=? OR json_extract(response,'$.value.outcome') IN ('publishing','closing'))`, encode({ ok: true, value: publishActionResponse(saved) }), key, actionId ?? null);
      return saved;
    });
  }
  /** Settle every publish or close action reply still saying `publishing` or `closing` with `record`, the outcome on record, unchanged. */
  settleUnsettledPublishReplies(identity: PlanIdentity, record: PublishRecord): void {
    this.#run(`UPDATE user_actions SET response=? WHERE plan_key=? AND kind IN ('publish','close-pull-requests') AND json_extract(response,'$.ok')=1
      AND json_extract(response,'$.value.outcome') IN ('publishing','closing')`, encode({ ok: true, value: publishActionResponse(record) }), identityKey(identity));
  }
  /** Whether a publish or close action's saved reply still says `publishing` or `closing`: its job has not recorded an outcome yet. */
  hasUnsettledPublishAction(identity: PlanIdentity): boolean {
    return !!this.#get(`SELECT 1 FROM user_actions WHERE plan_key=? AND kind IN ('publish','close-pull-requests') AND json_extract(response,'$.ok')=1
      AND json_extract(response,'$.value.outcome') IN ('publishing','closing') LIMIT 1`, identityKey(identity));
  }
  lastPublish(identity: PlanIdentity): PublishRecord | null {
    const key = identityKey(identity); this.#task(key);
    const row = this.#get('SELECT data FROM publish_outcomes WHERE plan_key=?', key);
    return row ? decode<PublishRecord>(row.data) : null;
  }
  /** Whether the task can be published in this mode right now (status, no attempt, merge, requeue or rebase). */
  canPublish(identity: PlanIdentity, draft: boolean): boolean {
    const key = identityKey(identity), task = this.#task(key);
    try { this.#assertPublishable(identity, task, task.state_version as number, draft); return true; }
    catch (error) { if (error instanceof GuardRefusal) return false; throw error; }
  }
  /** The full publish guard at the current state version, before any GitHub call: refuse early, with its reason. */
  assertPublishableNow(identity: PlanIdentity, draft: boolean): void {
    const key = identityKey(identity), task = this.#task(key);
    this.#assertPublishable(identity, task, task.state_version as number, draft);
  }
  /** The task, its review and its head are exactly as a publish read them before its last await. */
  assertUnchangedSince(identity: PlanIdentity, input: { stateVersion: number; reviewVersion: number; snapshotId: string; draft: boolean }): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      this.#assertPublishable(identity, this.#task(key), input.stateVersion, input.draft);
      const plan = this.#current(key);
      if (plan.review_version !== input.reviewVersion) throw new GuardRefusal('The review changed after the check. Reload before writing.');
      if (plan.snapshot_id !== input.snapshotId) throw new GuardRefusal('The task head changed during the check.');
    });
  }
  /**
   * Records the draft state GitHub shows for the task's open PR. It also repairs a record whose draft change landed on
   * GitHub but was never recorded (a crash or cancel right after the call). Guarded by the state version the caller
   * read, so a task change is still noticed; returns the new state version.
   */
  recordPullRequestDraft(identity: PlanIdentity, openingId: string, number: number, draft: boolean, expected: { stateVersion: number; reviewVersion: number }): number {
    const key = identityKey(identity);
    return this.#transaction(() => {
      this.#assertVersions(key, expected);
      if (this.#run("UPDATE task_pull_requests SET draft=?, updated_at=? WHERE plan_key=? AND opening_id=? AND state='opened' AND number=?",
        draft ? 1 : 0, new Date().toISOString(), key, openingId, number).changes !== 1) throw new GuardRefusal('Unknown pull request.');
      this.#touch(key);
      return this.#task(key).state_version as number;
    });
  }
  /** Recovery found no PR for an opening whose outcome was lost; a new check and opening follow. */
  abandonPullRequestOpening(identity: PlanIdentity, openingId: string): void {
    const key = identityKey(identity);
    this.#transaction(() => {
      if (this.#run("UPDATE task_pull_requests SET state='abandoned', updated_at=? WHERE plan_key=? AND opening_id=? AND state='opening'", new Date().toISOString(), key, openingId).changes !== 1)
        throw new GuardRefusal('No pull request is being opened with this ID.');
      this.#touch(key);
    });
  }

  // ---- F1d: startup recovery (runner-lifecycle.md, "Startup recovery") ----
  /**
   * The per-database runner owner token, tied to the database file's device and inode.
   * A stored value that is malformed is refused; a copied database (different file identity) gets a new token.
   */
  runnerOwnerToken(file: { dev: number | bigint; ino: number | bigint }): string {
    return this.#ownerToken('runner_owner', 'Stored runner owner token is malformed. Refusing to start.', file);
  }
  /**
   * The per-database owner token Ask writes as `io.codeboost.runner` (#65). It is separate from the runner's token, so
   * Ask's recovery never removes the runner's live agents and the runner's recovery never sees Ask's storage. Same
   * rules as `runnerOwnerToken`.
   */
  askOwnerToken(file: { dev: number | bigint; ino: number | bigint }): string {
    return this.#ownerToken('ask_owner', "Ask is off: the stored Ask owner token is malformed. Remove the 'ask_owner' row from app_settings in the review database, then retry.", file);
  }
  /**
   * The per-database owner token planning writes as `io.codeboost.runner` (#117). It is separate from Ask's and the
   * runner's, so planning's recovery never removes their agents and theirs never see planning's storage. Same rules as
   * `runnerOwnerToken`.
   */
  planningOwnerToken(file: { dev: number | bigint; ino: number | bigint }): string {
    return this.#ownerToken('planning_owner', "Planning is off: the stored planning owner token is malformed. Remove the 'planning_owner' row from app_settings in the review database, then retry.", file);
  }
  #ownerToken(key: string, malformed: string, file: { dev: number | bigint; ino: number | bigint }): string {
    const identity = { dev: String(file.dev), ino: String(file.ino) };
    return this.#transaction(() => {
      const row = this.#get('SELECT value FROM app_settings WHERE key=?', key);
      if (row) {
        let stored: { token?: unknown; dev?: unknown; ino?: unknown };
        try { stored = decode(row.value); } catch { throw new Error(malformed); }
        if (typeof stored.token !== 'string' || !/^[0-9a-f]{32}$/.test(stored.token)) throw new Error(malformed);
        if (stored.dev === identity.dev && stored.ino === identity.ino) return stored.token;
      }
      const token = randomUUID().replace(/-/g, '');
      this.#run('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, encode({ token, ...identity }));
      return token;
    });
  }
  /**
   * Whether the runner has committed for this task (#87): a completed writable attempt whose result made a commit. Only
   * then do the task's commits live in the runner-owned repository. One indexed lookup, for every review load.
   */
  hasRunnerCommit(identity: PlanIdentity): boolean {
    return !!this.#get(`SELECT 1 AS found FROM attempts WHERE plan_key=? AND kind IN (${WRITABLE_KINDS.map(() => '?').join(',')}) AND state='completed'
      AND json_valid(result) AND json_extract(result, '$.unchanged') = 0 LIMIT 1`, identityKey(identity), ...WRITABLE_KINDS);
  }
  /** Every partial-output file an attempt row references (`diagnostic_ref`). Retention never deletes one of these. */
  referencedDiagnostics(): string[] {
    return this.#db.prepare('SELECT diagnostic_ref FROM attempts WHERE diagnostic_ref IS NOT NULL').all().map(row => row.diagnostic_ref as string);
  }
  /**
   * Retention, over its cap: stop referencing this file, in one transaction that also notes the removal in the row's
   * diagnostic. Only after it commits may the file be deleted, so no row ever points at a missing file.
   */
  forgetDiagnostic(ref: string): boolean {
    return this.#transaction(() => {
      const rows = this.#db.prepare('SELECT id, plan_key FROM attempts WHERE diagnostic_ref=?').all(ref);
      for (const row of rows) {
        this.#run(`UPDATE attempts SET diagnostic_ref=NULL, diagnostic=TRIM(COALESCE(diagnostic,'') || ' (partial output removed by retention)') WHERE id=?`, row.id!);
        this.#touch(row.plan_key as string);
      }
      return rows.length > 0;
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
  /**
   * Saved in the same synchronous turn as the spawn. Preparation can run several subprocesses in turn: each one replaces
   * the last, with its own start time and kernel identity when given, so startup recovery can prove that the numeric ID
   * still names the group it recorded.
   */
  recordPreparationGroup(identity: PlanIdentity, id: string, pgid: number, startedAt?: number, processIdentity: string | null = null): void {
    if (!Number.isSafeInteger(pgid) || pgid < 2) throw new GuardRefusal('Invalid process group.');
    if (startedAt !== undefined && !Number.isSafeInteger(startedAt)) throw new GuardRefusal('Invalid process start time.');
    if (processIdentity !== null && !/^linux:[0-9a-f-]{36}:\d+$/.test(processIdentity))
      throw new GuardRefusal('Invalid process identity.');
    if (this.#run(`UPDATE attempts SET preparation_pgid=?, preparation_started_at=COALESCE(?, preparation_started_at), preparation_identity=? WHERE plan_key=? AND id=? AND preparation_started_at IS NOT NULL`,
      pgid, startedAt ?? null, processIdentity, identityKey(identity), id).changes !== 1)
      throw new GuardRefusal('Preparation was not marked as starting.');
  }
  /** F chooses the allocation ID and saves it before the asynchronous allocation starts. */
  recordAllocation(identity: PlanIdentity, id: string, allocationId: string): void {
    assertUuidV4(allocationId, 'Allocation ID');
    if (this.#run(`UPDATE attempts SET allocation_id=? WHERE plan_key=? AND id=? AND state='pending' AND allocation_id IS NULL`, allocationId, identityKey(identity), id).changes !== 1)
      throw new GuardRefusal('Allocation can be recorded once, for a pending attempt.');
  }
  /**
   * Saved once D's allocation returns, for the allocation recorded before it: startup recovery passes both to D's export
   * of a recovered storage, which refuses without the baseline. A crash before this write leaves them null, and that
   * export then fails closed.
   */
  recordAllocationBaseline(identity: PlanIdentity, id: string, allocationId: string, metadataBaseline: string, base: string): void {
    if (!/^[0-9a-f]{64}$/.test(metadataBaseline)) throw new GuardRefusal('Invalid metadata baseline.');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw new GuardRefusal('Invalid storage base commit.');
    if (this.#run(`UPDATE attempts SET metadata_baseline=?, storage_base=? WHERE plan_key=? AND id=? AND state='pending' AND allocation_id=? AND metadata_baseline IS NULL`,
      metadataBaseline, base, identityKey(identity), id, allocationId).changes !== 1)
      throw new GuardRefusal('The allocation baseline can be recorded once, for the pending attempt\'s own allocation.');
  }
  /** Every non-terminal attempt, across all plans, with the fields recovery needs. */
  interruptedAttempts(): InterruptedAttempt[] {
    return this.#db.prepare("SELECT * FROM attempts WHERE state IN ('pending','running') ORDER BY rowid").all().map(row => ({
      ...this.#attemptRecord(row), planKey: row.plan_key as string, preparationPgid: row.preparation_pgid as number | null,
      preparationStartedAt: row.preparation_started_at as number | null, preparationIdentity: row.preparation_identity as string | null,
      allocationId: row.allocation_id as string | null,
      metadataBaseline: row.metadata_baseline as string | null, storageBase: row.storage_base as string | null,
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
      if (row.kind !== 'check' && firstReason === null && contextCurrent && task.budget_deadline !== null && now >= (task.budget_deadline as number)) firstReason = 'time-limit';
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
      if (task.cancel_requested !== null && !this.#closed(task.status)) {
        this.#closeTask(key, 'cancelled', task.cancel_requested as string);
      } else {
        if (outcome.timeLimit && !this.#closed(task.status)) this.#run(`UPDATE tasks SET status='needs human' WHERE plan_key=?`, key);
        // A finding the process recorded before it stopped still sends the task to a person, and nothing requeues it.
        if (row.safety_finding !== null) this.#actOnFinding(key);
        const status = this.#task(key).status as string;
        const interrupted = outcome.state === 'failed' && (outcome.reason ?? '').startsWith('Interrupted');
        const shutdown = outcome.state === 'cancelled' && firstReason === 'shutdown';
        if (row.kind !== 'check' && !this.#closed(status) && !gated.includes(status) && (interrupted || shutdown)) {
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
  /** The allocation ID F saved for an attempt, across all plans; null if none (or no such attempt). */
  attemptAllocation(attemptId: string): string | null {
    return (this.#get('SELECT allocation_id FROM attempts WHERE id=?', attemptId)?.allocation_id as string | null | undefined) ?? null;
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

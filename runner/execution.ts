import { identityKey, type PlanIdentity } from '../core/identity.ts';
import type { PlanContext } from '../core/plan.ts';
import type { InvocationContext, InvocationHandle, InvocationInput, TaskClone } from '../agents/contract.ts';
import { prepareExecution } from '../core/execution-prompt.ts';
import { neutralizeMentions, neutralizeReferences } from '../core/pull-request-body.ts';
import { auditRun, type ChangeManifest } from '../core/run-audit.ts';
import { TaskTreeRefused, type DeclaredLinkSnapshot, type DeclaredOperation, type TaskTreeCheck } from '../agents/container/changes.ts';
import { assertCodexPhase } from '../agents/policy.ts';
import type { IssueText } from '../github/issues.ts';
import { partialOutput, saveDiagnostic } from './diagnostics.ts';
import { ownerOnlyDirectory } from './runner-repository.ts';
import { FinishFailure, NEEDS_RESTART, PreparationFailure, type PreparedAttempt, type RunnerCoordinator, type RunnerDeps } from './coordinator.ts';
import type { AttemptRecord, Store } from './store.ts';
import { CLOSED_STATUSES, GuardRefusal, HUMAN_GATES, ShuttingDownError, bounded, sameContext, settleWith, type ShutdownCapability } from './lifecycle.ts';

/**
 * F2b: per-item execution and the runner's commit step (design, "How codeboost runs a plan"; plan-format.md, "After
 * each run"). The workspace operations are D's (#66); until they exist this module is exercised with a fake.
 */
export interface WorkspaceRef { readonly clone: TaskClone; readonly storage: unknown }
export interface TaskWorkspace {
  /** A fresh task filesystem from the recorded trusted head; never a reset of a used one. Abortable; settles only when its work stopped. */
  materialize(attempt: AttemptRecord, head: string, signal: AbortSignal): Promise<WorkspaceRef>;
  /**
   * No-follow snapshot, taken before launch, of every declared path that is a symlink in this workspace. F passes every
   * path the item declares: an earlier item may have renamed or added links, so only D sees the actual entries.
   */
  snapshotDeclaredLinks(workspace: WorkspaceRef, paths: readonly string[], signal: AbortSignal): Promise<DeclaredLinkSnapshot>;
  /**
   * D's pre-launch tree check (#81, `checkTaskTree`), the last step before launch: the work tree is exactly the tree of
   * `baseHead` and the item's operations fit it. It rejects with `TaskTreeRefused` when they do not. The result is the
   * capability the agent's profile needs to mount every gitlink empty and read-only; it serves one launch.
   */
  checkTree(workspace: WorkspaceRef, input: { baseHead: string; operations: readonly DeclaredOperation[] }, signal: AbortSignal): Promise<TaskTreeCheck>;
  /** D's change manifest after the agent settled (`TaskChangeManifest`), with the digest the commit step must match. */
  inspectChanges(workspace: WorkspaceRef, input: { baseHead: string; linkSnapshot: DeclaredLinkSnapshot }, signal: AbortSignal): Promise<ChangeManifest & { digest: string }>;
  /**
   * The runner's commit (#66, `commitTaskChanges`): `baseHead` plus exactly the changes of the manifest whose digest is
   * `digest`, with hooks off, refused if the work tree no longer matches it. Returns the new head, which is then in the
   * runner-owned repository (#87), so the next item's `materialize` and the push find it. Agent commits are never
   * undone: a manifest with any is a safety violation and never gets here (#66).
   */
  commit(workspace: WorkspaceRef, input: { baseHead: string; linkSnapshot: DeclaredLinkSnapshot; message: string;
    trailers: Readonly<Record<string, string>>; digest: string }, signal: AbortSignal): Promise<string>;
  /** After the terminal write: remove task storage, and drop the commit of an attempt that did not complete. */
  release(workspace: WorkspaceRef): Promise<void>;
  /**
   * A stopped attempt's partial output (#87 item 1): the diff of what the agent left against `baseHead`, bounded by D.
   * Read before the terminal write, while the task storage is still there.
   */
  exportPartial?(workspace: WorkspaceRef, input: { baseHead: string }, signal: AbortSignal): Promise<{ diff: Buffer; truncated: boolean }>;
  /** Remove host-side preparation files (the staging clone). Called before the terminal write when D never ran, after it otherwise. */
  cleanupPreparation?(attempt: AttemptRecord): Promise<void>;
}
/** D's start call for an execute/fix phase with this prompt and the tree check made for it; returns at once (see #51). */
export type AgentLauncher = (input: InvocationInput, prompt: string, workspace: WorkspaceRef, treeCheck: TaskTreeCheck) => InvocationHandle;
/** Trusted runner-side sources for a task. Issue text and lessons are untrusted data inside the prompt. */
export interface ExecutionSources {
  planContext(identity: PlanIdentity): PlanContext;
  /** The issue text the prompt carries; fetched per attempt, so it may await (and must stop on abort). */
  issue(identity: PlanIdentity, signal: AbortSignal): IssueText | Promise<IssueText>;
  lessons(identity: PlanIdentity): readonly string[];
  vendor(identity: PlanIdentity): 'claude' | 'codex';
}
/** Prefix of the diagnostic for an audit safety violation. For people only: the executor never reads it back. */
export const SAFETY_VIOLATION = 'Safety violation:';
/**
 * Safety violations the runner's own audit found, by attempt ID. executionDeps records them and ItemExecutor takes
 * them, so agent output (stderr) can never be mistaken for one, and a violation survives a later stale or stop outcome.
 * They are durable (#87 item 3): each is saved on its attempt before the terminal write, which then sends the task to
 * needs human in the same transaction, however the attempt was started; startup recovery does the same for an attempt
 * a crash interrupted. Only a finding whose save failed is held here, in memory, owed until the executor acts on it.
 */
export class SafetyFindings {
  #store: Store; #write: <T>(fn: () => T) => T;
  #unsaved = new Map<string, string>();
  /** `capability` is the coordinator's: the save is a settlement write, so it still lands after the write gate closes. */
  constructor(store: Store, capability?: ShutdownCapability) { this.#store = store; this.#write = settleWith(capability); }
  #row(attemptId: string): AttemptRecord | undefined {
    const key = this.#store.attemptOwner(attemptId);
    return key ? this.#store.getAttempt(findIdentity(this.#store, { id: attemptId } as AttemptRecord), attemptId) : undefined;
  }
  record(attemptId: string, reason: string): void {
    try {
      const identity = findIdentity(this.#store, { id: attemptId } as AttemptRecord);
      // False only when the attempt already holds a finding (the first is kept) or is no longer active.
      if (this.#write(() => this.#store.recordSafetyFinding(identity, attemptId, reason)) || this.#row(attemptId)?.safetyFinding) return;
    } catch { /* not saved: held here instead */ }
    this.#unsaved.set(attemptId, reason);
  }
  /** The finding still owed: one whose save failed, so nothing but the executor will act on it. */
  get(attemptId: string): string | undefined { return this.#unsaved.get(attemptId); }
  /** The attempt's finding, owed or already acted on by the terminal write. */
  finding(attemptId: string): string | undefined { return this.#unsaved.get(attemptId) ?? this.#row(attemptId)?.safetyFinding ?? undefined; }
  /** Whether the finding is only in memory: the Store knows nothing of it, so the executor must act on it itself. */
  unsaved(attemptId: string): boolean { return this.#unsaved.has(attemptId); }
  settle(attemptId: string): void { this.#unsaved.delete(attemptId); }
  /** Retry the durable save after the attempt may already have settled. */
  persist(attemptId: string): boolean {
    const finding = this.#unsaved.get(attemptId);
    if (!finding) return true;
    const identity = findIdentity(this.#store, { id: attemptId } as AttemptRecord);
    if (!this.#store.recordOwedSafetyFinding(identity, attemptId, finding) && !this.#row(attemptId)?.safetyFinding) return false;
    this.#unsaved.delete(attemptId);
    // A strict begin usually runs inside userAction's outer transaction. Restore the in-memory debt if that rolls back.
    this.#store.afterCommit(() => undefined, () => this.#unsaved.set(attemptId, finding));
    return true;
  }
  /** The attempts whose finding is owed (only in memory). Usually none, so a check over them costs nothing. */
  owedAttempts(): string[] { return [...this.#unsaved.keys()]; }
}
export interface ExecutionResult { head: string; unchanged: boolean; inScope: string[]; outOfScope: string[] }
interface Private { workspace: WorkspaceRef; prompt: string; baseHead: string; linkSnapshot: DeclaredLinkSnapshot | undefined;
  treeCheck: TaskTreeCheck | undefined }

/**
 * RunnerDeps for execute attempts: fresh workspace, prompt, agent, then audit and the runner's own commit.
 * `runnerOwner` is the database's runner token (`Store.runnerOwnerToken`); `workspace` must allocate task storage under it.
 */
export function executionDeps(store: Store, workspace: TaskWorkspace, launch: AgentLauncher, sources: ExecutionSources, runnerOwner: string,
  findings: SafetyFindings, options: { diagnostics?: { directory: string; capBytes?: number }; exportDeadlineMs?: number } = {}): RunnerDeps {
  const identityOf = (attempt: AttemptRecord): PlanIdentity => findIdentity(store, attempt);
  /**
   * Inspect what the agent left and audit it against the item: a violation, or an inspection or audit that refuses, is
   * recorded as a safety finding and thrown as a FinishFailure. Only the stop's own abort comes back as itself.
   */
  const audit = async (attempt: AttemptRecord, prepared: PreparedAttempt, signal: AbortSignal) => {
    const data = prepared.private as Private, identity = identityOf(attempt);
    const item = store.getPlan(identity, attempt.context.planRevision).items.find(entry => entry.id === attempt.item)!;
    const violation = (reason: string): never => {
      const text = bounded(`${SAFETY_VIOLATION} ${reason}`);
      findings.record(attempt.id, text);
      throw new FinishFailure(text);
    };
    let manifest: ChangeManifest & { digest: string };
    try { manifest = await workspace.inspectChanges(data.workspace, { baseHead: data.baseHead, linkSnapshot: data.linkSnapshot! }, signal); }
    catch (error) {
      // Only the stop's own abort error is the stop. Any other refusal is a finding, even if a stop is also pending.
      if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw error;
      // Contract (Publishing step 2): an inspection that refuses sends the task to needs human.
      return violation(`The change inspection refused: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
    // The commit step refuses a tree that no longer matches this digest; without one that guard has nothing to check.
    if (typeof manifest?.digest !== 'string' || !manifest.digest) return violation('The change report has no digest.');
    let outcome: ReturnType<typeof auditRun>;
    try { outcome = auditRun(item, manifest, sources.planContext(identity).pathKey); }
    catch (error) { return violation(`The change report could not be audited: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
    if (outcome.kind === 'violation') return violation(outcome.violations.join(' '));
    return { manifest, outcome };
  };
  return {
    runnerOwner,
    // Only execute attempts have deps yet; admission refuses the rest before any row is written (#91).
    kinds: ['execute'],
    async prepare(attempt, signal) {
      if (attempt.kind !== 'execute' || !attempt.item) throw new Error('Execution deps run execute attempts for one plan item.');
      const identity = identityOf(attempt), plan = store.getPlan(identity, attempt.context.planRevision);
      const item = plan.items.find(entry => entry.id === attempt.item)!;
      const context = sources.planContext(identity);
      const baseHead = store.getSnapshot(identity, attempt.context.snapshotId).head;
      const vendor = sources.vendor(identity);
      // D refuses Codex in phases it cannot work in (#93); refuse here too, before any GitHub call or task storage.
      if (vendor === 'codex') assertCodexPhase('execute');
      const issue = await sources.issue(identity, signal);
      signal.throwIfAborted();
      const request = prepareExecution({ identity, attemptId: attempt.id, mode: 'execute', plan, itemId: item.id,
        issue, approvedLessons: sources.lessons(identity), allowedCommands: context.allowedCommands });
      const declaredPaths = [...new Set(item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]))];
      const ws = await workspace.materialize(attempt, baseHead, signal);
      // From here task storage exists: a failure hands it to the coordinator, which removes it after the terminal write.
      const data: Private = { workspace: ws, prompt: request.prompt, baseHead, linkSnapshot: undefined, treeCheck: undefined };
      const prepared = { clone: ws.clone, vendor, approvedArgv: request.approvedArgv, private: data };
      try { data.linkSnapshot = await workspace.snapshotDeclaredLinks(ws, declaredPaths, signal); }
      catch (error) { throw new PreparationFailure(error, prepared); }
      // A declared link whose way, or target, goes through another link is never launched (plan-format.md: a target never
      // goes through another link): a write through it would land somewhere its snapshot does not watch. It is a safety
      // finding, so the task goes to a person rather than retrying.
      const through = data.linkSnapshot.links.filter(link => link.status === 'through-link').map(link => JSON.stringify(link.link));
      if (through.length) {
        const text = bounded(`${SAFETY_VIOLATION} A declared link goes through another link, so a write through it would land outside its target: ${through.slice(0, 5).join(', ')}${through.length > 5 ? ` and ${through.length - 5} more` : ''}.`);
        findings.record(attempt.id, text);
        throw new PreparationFailure(new Error(text), prepared);
      }
      // Last, just before launch (plan-format.md, "Clean invocation state"): no agent runs until the actual tree is the
      // head's and the item's operations fit it. A refusal (a tree that is not a clean copy, an operation the head does
      // not allow, a gitlink that cannot be mounted) gives the same answer on retry, so it goes to a person.
      const operations = item.files.map(file => ({ kind: file.kind, path: file.path, renamedFrom: file.renamed_from }));
      try { data.treeCheck = await workspace.checkTree(ws, { baseHead, operations }, signal); }
      catch (error) {
        if (!(error instanceof TaskTreeRefused)) throw new PreparationFailure(error, prepared);
        // The differences name agent-reachable paths: D quotes each one.
        const text = bounded(`${SAFETY_VIOLATION} ${error.message}`);
        findings.record(attempt.id, text);
        throw new PreparationFailure(new Error(text), prepared);
      }
      return prepared;
    },
    // Host-side files only (the staging clone); task storage waits for release.
    async cleanupPreparation(attempt) { await workspace.cleanupPreparation?.(attempt); },
    start(input, prepared) { const data = prepared.private as Private; return launch(input, data.prompt, data.workspace, data.treeCheck!); },
    validate() { throw new Error('Execute attempts publish through finish().'); },
    async finish(attempt, _result, prepared, signal) {
      const data = prepared.private as Private, identity = identityOf(attempt);
      const plan = store.getPlan(identity, attempt.context.planRevision), item = plan.items.find(entry => entry.id === attempt.item)!;
      const { manifest, outcome } = await audit(attempt, prepared, signal);
      if (outcome.unchanged) return { value: { head: data.baseHead, unchanged: true, inScope: [], outOfScope: [] } satisfies ExecutionResult };
      // Last check before the commit, after the last await: a stop, shutdown or context change makes nothing.
      if (signal.aborted) throw signal.reason;
      if (!sameContext(attempt.context, store.currentContext(identity))) throw new FinishFailure('The plan, snapshot or assignment changed during the audit; nothing was committed.');
      let head: string;
      try { head = await workspace.commit(data.workspace, {
        // Every change is in or out of scope here, and the commit holds all of them: exactly the manifest audited.
        baseHead: data.baseHead, linkSnapshot: data.linkSnapshot!, digest: manifest.digest,
        // The title is plan text: on one line with no control or bidi/format characters, it cannot open a trailer block
        // that forges Plan-Item or Plan-Revision, put terminal escapes into git log, or reorder how git log shows it. Its
        // issue references and mentions are neutralised (AGENTS.md): on the default branch, "Fixes #12" would close #12.
        message: `${item.id}: ${neutralizeMentions(neutralizeReferences(item.title.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, ' ').replace(/ {2,}/g, ' ').trim()))}`, trailers: { 'Plan-Item': item.id, 'Plan-Revision': `r${plan.revision}` },
      }, signal); }
      catch (error) {
        // D's refusal text can name agent-chosen paths: quote it (AGENTS.md). A stop records its first reason before it
        // aborts, so a stopped commit still ends as that stop, whatever this text says.
        throw new FinishFailure(`The runner commit was refused: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
      }
      // The ID goes into the ledger inside the terminal write; a malformed one must fail the attempt, not that write.
      if (typeof head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new FinishFailure('The workspace returned an invalid commit ID; nothing was published.');
      if (head === data.baseHead) throw new FinishFailure('The workspace made no new commit for a changed item; nothing was published.');
      const snapshot = store.getSnapshot(identity, attempt.context.snapshotId);
      return {
        value: { head, unchanged: false, inScope: outcome.inScope, outOfScope: outcome.outOfScope } satisfies ExecutionResult,
        history: { base: snapshot.base, head, entries: [{ sha: head, owner: item.id, origin: 'owned', sourceSha: null }] },
      };
    },
    // The partial output of an attempt that did not complete (#87 item 1), saved where the attempt row will reference it.
    // It has its own deadline: a stop must not cut it short, and nothing waits on it past that.
    async exportPartial(attempt, prepared) {
      const data = prepared.private as Private;
      if (!workspace.exportPartial || !options.diagnostics) return {};
      const signal = AbortSignal.timeout(options.exportDeadlineMs ?? 60_000);
      try {
        const { diff, truncated } = await workspace.exportPartial(data.workspace, { baseHead: data.baseHead }, signal);
        // Only the current user may write where diagnostics are kept.
        ownerOnlyDirectory(options.diagnostics.directory);
        return { diagnosticRef: saveDiagnostic(store, options.diagnostics.directory, attempt.id, partialOutput(diff, truncated), options.diagnostics.capBytes) };
      } catch (error) {
        return { failure: signal.aborted ? 'the export did not finish within its deadline' : (error instanceof Error ? error.message : String(error)) };
      }
    },
    // A failed run's work is audited too (#87 item 2): what it found is saved, so the terminal write sends the task to a
    // person. Nothing is committed, and the attempt fails whatever this finds.
    async auditFailed(attempt, prepared, signal) {
      if ((prepared.private as Private).linkSnapshot === undefined) return;
      try { await audit(attempt, prepared, signal); }
      catch (error) { if (!(error instanceof FinishFailure)) throw error; }
    },
    async release(_attempt, prepared) {
      const data = prepared.private as Private;
      await workspace.release(data.workspace);
    },
  };
}
/** The plan identity that owns an attempt; attempts are stored per plan key. */
export function findIdentity(store: Store, attempt: AttemptRecord): PlanIdentity {
  const key = store.attemptOwner(attempt.id);
  if (!key) throw new Error('Unknown attempt.');
  const [repositoryId, taskId, planId] = JSON.parse(key) as string[];
  return { repositoryId: repositoryId!, taskId: taskId!, planId: planId! };
}

/**
 * `completed` lists the items this run finished before it ended. A thrown error (storage or a bug) carries no list;
 * the finished items are still recorded durably, as completed attempts and ledger entries.
 */
export type ExecutionOutcome =
  | { kind: 'executed'; items: string[]; unchanged: string[] }
  | { kind: 'needs amendment'; item: string; outOfScope: string[]; checkpointId: string; completed: string[] }
  | { kind: 'needs human'; item: string; reason: string; completed: string[] }
  | { kind: 'stopped'; item: string; state: string; reason: string | null; completed: string[] };
/** A run in progress: its plan, the item it is on and that item's attempt, and what it finished. */
interface Run {
  plan: ReturnType<Store['getPlan']>; index: number; attempt: AttemptRecord; done: string[]; unchanged: string[];
  reviewVersion?: number;
  stopped: (item: string, state: string, reason: string | null) => ExecutionOutcome;
}
const refusal = (error: unknown) => error instanceof GuardRefusal || error instanceof ShuttingDownError;
/** A write outside settlement: no shutdown capability. */
const direct = <T>(fn: () => T): T => fn();

/**
 * Runs a task's plan items in order, one execute attempt each. Stops at the first item that does not complete cleanly:
 * out-of-scope files pause the task in needs amendment with a checkpoint; a safety violation moves it to needs human.
 * The run stops too if the plan gets a new revision while it runs: every item runs against the revision it started on.
 */
export class ItemExecutor {
  #store: Store; #runner: RunnerCoordinator; #sources: ExecutionSources; #findings: SafetyFindings;
  #deadlineMs: number;
  /** F2's status changes after an attempt settles are settlement writes: they still land after the shutdown gate closes. */
  #write: <T>(fn: () => T) => T;
  constructor(store: Store, runner: RunnerCoordinator, sources: ExecutionSources, findings: SafetyFindings,
    options: { deadlineMs?: number; capability?: ShutdownCapability } = {}) {
    this.#store = store; this.#runner = runner; this.#sources = sources; this.#findings = findings;
    this.#deadlineMs = options.deadlineMs ?? 10 * 60_000; this.#write = settleWith(options.capability);
  }
  /**
   * Tasks with a run (runTask or begin) in progress here, from its start to its return: a second one waits for none of its steps.
   * The guard is per instance, so the server must keep one ItemExecutor per Store (as it keeps one coordinator).
   */
  #inFlight = new Map<string, Promise<unknown>>();
  async runTask(identity: PlanIdentity, options: { fromItem?: string } = {}): Promise<ExecutionOutcome> {
    const key = identityKey(identity);
    // Held for the whole run, so a second run can never pay this run's pause or finding, even in the microtasks between
    // the coordinator dropping the job and this run resuming.
    if (this.#inFlight.has(key)) return { kind: 'stopped', item: options.fromItem ?? this.#store.getPlan(identity).items[0]!.id, state: 'not started',
      reason: 'An earlier run of this task is still finishing; try again when that run has ended.', completed: [] };
    const begun = this.#begin(identity, options, false);
    return this.#track(key, 'outcome' in begun ? Promise.resolve(begun.outcome) : this.#continue(identity, begun));
  }
  /**
   * Start or resume a run from inside the caller's user action (#91 part 2). Everything up to the first item's admission
   * is synchronous, so it all happens in the caller's transaction: anything that keeps the first item from being admitted
   * throws (the refusal itself where admission refused), and the caller's own writes roll back with it. A finding or scope
   * pause owed from an earlier run is acted on instead, as the run's whole outcome, and admits nothing (`attemptId` null).
   */
  begin(identity: PlanIdentity, options: { fromItem?: string; claimRequeue?: boolean; expectedReviewVersion?: number } = {}): { attemptId: string | null; outcome: Promise<ExecutionOutcome> } {
    const key = identityKey(identity);
    if (this.#inFlight.has(key)) throw new GuardRefusal('An earlier run of this task is still finishing; try again when that run has ended.');
    const begun = this.#begin(identity, options, true);
    if ('outcome' in begun) return { attemptId: null, outcome: this.#track(key, Promise.resolve(begun.outcome)) };
    return { attemptId: begun.attempt.id, outcome: this.#track(key, this.#continue(identity, begun)) };
  }
  /**
   * Where a run of the task stands (#91 part 2): whether any item was ever attempted (`started`, at any revision) or was
   * attempted at the current revision (`begun`), whether an earlier revision left runner commits a revised plan must be
   * reconciled with (#88), the items an execute attempt completed at the current revision, and the first item none did
   * (null when every item has run).
   */
  progress(identity: PlanIdentity): { started: boolean; begun: boolean; earlierCommits: boolean; completed: string[]; prefixHead: string | null; next: string | null } {
    const plan = this.#store.getPlan(identity), { started, begun, earlierCommits, finished, finishedHeads } = this.#store.executeProgress(identity, plan.revision);
    const done = new Set(finished);
    let prefixHead: string | null = null;
    for (const item of plan.items) { if (!done.has(item.id)) break; prefixHead = finishedHeads[item.id] ?? null; }
    return { started, begun, earlierCommits, completed: plan.items.filter(item => done.has(item.id)).map(item => item.id),
      prefixHead, next: plan.items.find(item => !done.has(item.id))?.id ?? null };
  }
  /** Whether a run of this task is still in progress here (its last write may still be to come). */
  busy(identity: PlanIdentity): boolean { return this.#inFlight.has(identityKey(identity)); }
  /**
   * Whether an earlier run left work owed that the next run pays before any item: a safety finding not yet acted on, or
   * a scope pause never recorded (a failed write, the write gate, a crash). Reads only.
   */
  owes(identity: PlanIdentity, options: { scope?: boolean } = {}): boolean {
    // Cheap enough for a poll: owed findings are in memory (usually none), and only completed attempts that changed files
    // outside their items are read, not every attempt with its result.
    const key = identityKey(identity);
    if (this.#findings.owedAttempts().some(id => this.#store.attemptOwner(id) === key)) return true;
    if (options.scope === false) return false;
    return this.#store.scopeFindingHeads(identity).some(head => !this.#store.checkpointAtHead(identity, head));
  }
  /**
   * Pay what an earlier run owes, outside a run, as a run would before its first item (#103: a task that owes a pause or
   * an escalation must not be published as finished). Null when nothing is owed, or a run of the task is in progress
   * (it pays its own); otherwise the outcome: needs human, needs amendment, or stopped when it could not be written.
   * `scope: false` pays only an owed safety finding (a task in needs human cannot record a pause).
   */
  payOwed(identity: PlanIdentity, options: { scope?: boolean } = {}): ExecutionOutcome | null {
    if (this.#runner.closing || this.#runner.isActive(identity) || this.busy(identity)) return null;
    const stopped = (item: string, state: string, reason: string | null): ExecutionOutcome => ({ kind: 'stopped', item, state, reason, completed: [] });
    for (const earlier of this.#store.getAttempts(identity)) {
      const finding = this.#findings.get(earlier.id);
      if (finding) return this.#escalate(identity, earlier, finding, stopped, [], true);
    }
    if (options.scope === false) return null;
    const owed = this.#unpausedScopeFinding(identity);
    return owed ? this.#pause(identity, owed.row, owed.result, stopped, [], true) : null;
  }
  /** Held in #inFlight from its start to its return, so close() can await it. */
  #track(key: string, run: Promise<ExecutionOutcome>): Promise<ExecutionOutcome> {
    this.#inFlight.set(key, run.catch(() => undefined));
    return run.finally(() => this.#inFlight.delete(key));
  }
  /**
   * Shutdown, after the coordinator's close: await every run in progress. A run's pause or escalation after its last
   * attempt settles is a settlement write, so the Store must stay open until each run has returned (#91). Admission is
   * already closed, so no run starts another item.
   */
  async close(): Promise<void> {
    while (this.#inFlight.size) await Promise.all([...this.#inFlight.values()]);
  }
  /**
   * The synchronous start of a run: owed work first, then the first item's admission. With `strict`, a run that cannot
   * admit its first item throws instead of returning a stopped outcome.
   */
  #begin(identity: PlanIdentity, options: { fromItem?: string; claimRequeue?: boolean; expectedReviewVersion?: number }, strict: boolean): { outcome: ExecutionOutcome } | Run {
    const plan = this.#store.getPlan(identity);
    const start = options.fromItem ? plan.items.findIndex(item => item.id === options.fromItem) : 0;
    if (start < 0) throw new Error('Unknown plan item.');
    const run: Run = { plan, index: start, attempt: undefined!, done: [], unchanged: [], stopped: undefined!,
      ...(options.expectedReviewVersion === undefined ? {} : { reviewVersion: options.expectedReviewVersion }) };
    run.stopped = (item, state, reason) => ({ kind: 'stopped', item, state, reason, completed: [...run.done] });
    const notStarted = (reason: string, error?: unknown): { outcome: ExecutionOutcome } => {
      if (strict) throw error ?? new GuardRefusal(reason);
      return { outcome: run.stopped(options.fromItem ?? plan.items[start]!.id, 'not started', reason) };
    };
    // Shutdown began (admission is closed): pay nothing owed and start nothing; the next run after restart does.
    if (this.#runner.closing) return notStarted('The review server is shutting down.', new ShuttingDownError());
    // An earlier run of this task that is still finishing (its storage release) settles its own findings and pause.
    if (this.#runner.isActive(identity)) return notStarted('An earlier run of this task is still finishing; try again when that run has ended.');
    // A safety finding not yet acted on (a failed write, a human gate at the time) goes to needs human first.
    for (const earlier of this.#store.getAttempts(identity)) {
      const finding = this.#findings.get(earlier.id);
      if (finding) {
        if (options.claimRequeue) this.#store.claimRequeue(identity, this.#store.getTask(identity).stateVersion);
        const persisted = !strict || this.#findings.persist(earlier.id), current = this.#store.getAttempt(identity, earlier.id);
        // A pending cancel can leave the original attempt active. Saving the finding is the durable work owed; its
        // terminal write will apply the cancellation (which wins) without losing the safety evidence.
        if (persisted && (current.state === 'pending' || current.state === 'running'))
          return { outcome: run.stopped(current.item!, 'not started', `${finding} The finding is saved and waits for the active attempt to settle.`) };
        return this.#settledOrRefused(this.#escalate(identity, current, finding, run.stopped, [], true), strict);
      }
    }
    // A scope finding whose pause was never recorded (a failed write, the write gate, a crash) pauses now, before any item.
    const owed = this.#unpausedScopeFinding(identity);
    if (owed) {
      if (options.claimRequeue) this.#store.claimRequeue(identity, this.#store.getTask(identity).stateVersion);
      return this.#settledOrRefused(this.#pause(identity, owed.row, owed.result, run.stopped, [], true), strict);
    }
    // Continuing after a scope pause (plan-format.md: reconcile the executed prefix with the audited head, validate the
    // remaining items from that checkpoint) is not built yet (#88), so a paused task runs no further items: fail closed.
    const checkpoint = this.#store.latestCheckpoint(identity);
    if (checkpoint)
      return notStarted(`${checkpoint.item} changed files outside its plan item. Continuing after a scope pause is not supported yet (#88), so this task runs no further items.`);
    const admitted = this.#admit(identity, run, null, options.claimRequeue === true, strict);
    if (!('id' in admitted)) return { outcome: admitted };
    run.attempt = admitted;
    return run;
  }
  /** An owed escalation or pause: its outcome stands; one that could not be written refuses a strict start. */
  #settledOrRefused(outcome: ExecutionOutcome, strict: boolean): { outcome: ExecutionOutcome } {
    if (strict && outcome.kind === 'stopped') throw new GuardRefusal(outcome.reason ?? 'The task cannot start.');
    return { outcome };
  }
  /**
   * Admit `run.plan.items[run.index]`. `expected` is the context the previous item left (null for the first). A refusal
   * ends the run as not started, or, with `strict`, is thrown as it is, for the caller's user action to record.
   */
  #admit(identity: PlanIdentity, run: Run, expected: InvocationContext | null, claimRequeue: boolean, strict: boolean): AttemptRecord | ExecutionOutcome {
    const item = run.plan.items[run.index]!;
    // Admission reads the context in this same turn, so it cannot notice a change saved during an earlier item.
    const current = this.#store.currentContext(identity);
    // After an item, the task is still running unless someone changed its status meanwhile: then the run stops.
    if (expected && this.#store.getTask(identity).status !== 'running')
      return run.stopped(item.id, 'not started', `The task's status changed to ${this.#store.getTask(identity).status} during the run; ${item.id} was not started.`);
    if (this.#store.getPlan(identity).revision !== run.plan.revision) {
      const reason = `The plan changed to a new revision during the run; review it before running ${item.id}.`;
      // A strict begin reads the plan in this same turn, so this cannot fire there; if it ever did, it must refuse, not settle.
      if (strict) throw new GuardRefusal(reason);
      return run.stopped(item.id, 'not started', reason);
    }
    if (expected && !sameContext(current, expected))
      return run.stopped(item.id, 'not started', `The task's snapshot or assignment changed during the run; review it before running ${item.id}.`);
    if (run.reviewVersion !== undefined) {
      const changed = this.#store.reviewVersion(identity) !== run.reviewVersion;
      const unapproved = changed ? [] : this.#store.unapprovedExecutionItems(identity, run.plan.revision);
      if (changed || unapproved.length) {
        const reason = changed ? `The review changed during the run; review it before running ${item.id}.`
          : `Approve every plan item before running ${item.id}. Waiting for: ${unapproved.join(', ')}.`;
        if (strict) throw new GuardRefusal(reason);
        return run.stopped(item.id, 'not started', reason);
      }
    }
    try {
      return this.#runner.start(identity, {
        expectedStateVersion: this.#store.getTask(identity).stateVersion, kind: 'execute', item: item.id,
        expectedContext: current, deadline: Date.now() + this.#deadlineMs, ...(claimRequeue ? { claimRequeue } : {}),
      });
    } catch (error) {
      if (!refusal(error) || strict) throw error;
      return run.stopped(item.id, 'not started', error instanceof Error ? error.message : String(error));
    }
  }
  /** The rest of a run once its first item is admitted: each item settles, then the next is admitted. */
  async #continue(identity: PlanIdentity, run: Run): Promise<ExecutionOutcome> {
    const { done, unchanged, stopped } = run;
    for (;;) {
      const item = run.plan.items[run.index]!, attempt = run.attempt;
      await this.#runner.settled(identity);
      const row = this.#store.getAttempt(identity, attempt.id);
      // Only the runner's own audit records a finding; it wins over any later stale or stop outcome. The terminal write
      // has usually acted on it already, so this reads it whether or not it is still owed.
      const violation = this.#findings.finding(attempt.id);
      if (violation) return this.#escalate(identity, row, violation, stopped, done);
      if (row.state !== 'completed') {
        // Still pending or running: the terminal write failed and the slot is held until restart.
        const unresolved = this.#runner.status(identity).unresolved;
        return stopped(item.id, row.state, row.state === 'pending' || row.state === 'running'
          ? (unresolved ? NEEDS_RESTART[unresolved.reason] : `Needs restart: the outcome of ${item.id} could not be saved.`) : row.diagnostic);
      }
      const result = row.result as ExecutionResult;
      done.push(item.id);
      if (result.unchanged) unchanged.push(item.id);
      if (result.outOfScope.length) return this.#pause(identity, row, result, stopped, done);
      const snapshotId = result.unchanged ? row.context.snapshotId : this.#store.snapshotWithHead(identity, result.head);
      if (!snapshotId) throw new Error(`The snapshot of ${item.id}'s commit is missing.`);
      if (++run.index >= run.plan.items.length) return { kind: 'executed', items: done, unchanged };
      // The item's own commit (recordHistory) raised the context generation by exactly one; any other change is not ours.
      const expected = { ...row.context, snapshotId, stateVersion: row.context.stateVersion + (result.unchanged ? 0 : 1) };
      const next = this.#admit(identity, run, expected, false, false);
      if (!('id' in next)) return next;
      run.attempt = next;
    }
  }
  /**
   * A safety finding sends the task to needs human (plan-format.md, "After each run"). From running, queued or a review
   * status it moves now. A human gate is kept, because leaving it needs its own user action (runner-lifecycle.md), and
   * the finding stays owed: the task's next run escalates it before anything else. A closed task needs nothing.
   * The finding is settled only once acted on, so a failed write leaves it owed too.
   */
  #escalate(identity: PlanIdentity, row: AttemptRecord, violation: string,
    stopped: (item: string, state: string, reason: string | null) => ExecutionOutcome, done: string[], owed = false): ExecutionOutcome {
    const item = row.item!, task = this.#store.getTask(identity);
    // The terminal write failed: the attempt still counts as active, so the move waits for restart; keep the finding owed.
    if (row.state === 'pending' || row.state === 'running') {
      const unresolved = this.#runner.status(identity).unresolved;
      return stopped(item, owed ? 'not started' : row.state, `${violation} ${unresolved ? NEEDS_RESTART[unresolved.reason] : 'Needs restart: the attempt\'s outcome could not be saved.'}`);
    }
    // A saved finding: the terminal write acted on it, so the task went to needs human then (or was closed by a pending
    // cancel), and where it is now is a person's doing.
    if (!this.#findings.unsaved(row.id)) {
      return CLOSED_STATUSES.includes(task.status) ? stopped(item, row.state, `${violation} The task is ${task.status}, so it was not moved to needs human.`)
        : { kind: 'needs human', item, reason: violation, completed: [...done] };
    }
    if (CLOSED_STATUSES.includes(task.status)) {
      this.#findings.settle(row.id);
      return stopped(item, owed ? 'not started' : row.state, `${violation} The task is ${task.status}, so it was not moved to needs human.`);
    }
    // Already where the finding sends it: nothing is owed.
    if (task.status === 'needs human') {
      this.#findings.settle(row.id);
      return { kind: 'needs human', item, reason: violation, completed: [...done] };
    }
    if (HUMAN_GATES.includes(task.status))
      return stopped(item, owed ? 'not started' : row.state, `${violation} The task is ${task.status}; it moves to needs human when it next runs.`);
    // Settling this run's own attempt writes through the shutdown capability; paying an owed finding at the start of a
    // new run is that run's decision, so it does not, and the closed write gate refuses it like any other.
    try { (owed ? direct : this.#write)(() => this.#store.transitionTask(identity, task.stateVersion, 'needs human')); }
    catch (error) {
      if (!(error instanceof GuardRefusal) && !(owed && error instanceof ShuttingDownError)) throw error;
      return stopped(item, owed ? 'not started' : row.state, `${violation} The task could not be moved to needs human yet: ${(error as Error).message}`);
    }
    // Inside a caller's transaction (begin, #91 part 2) the move can still roll back; the finding stays owed until it commits.
    this.#store.afterCommit(() => this.#findings.settle(row.id));
    return { kind: 'needs human', item, reason: violation, completed: [...done] };
  }
  /** The earliest completed execute attempt whose out-of-scope files have no checkpoint yet (its pause was lost). */
  #unpausedScopeFinding(identity: PlanIdentity): { row: AttemptRecord; result: ExecutionResult } | null {
    // Every completed execute attempt, not only the latest: a later clean one must not hide an earlier owed pause.
    for (const row of this.#store.getAttempts(identity)) {
      const result = row.result as ExecutionResult | undefined;
      if (row.kind !== 'execute' || row.state !== 'completed' || !result?.outOfScope?.length) continue;
      if (!this.#store.checkpointAtHead(identity, result.head)) return { row, result };
    }
    return null;
  }
  /**
   * The scope pause. The checkpoint names the revision the item ran against and the snapshot its own commit created, so
   * a revision or HEAD observation saved since cannot erase the finding. Only a refused pause (the task is closed or no
   * longer running) returns stopped; anything else is thrown, and the next run pauses first.
   */
  #pause(identity: PlanIdentity, row: AttemptRecord, result: ExecutionResult,
    stopped: (item: string, state: string, reason: string | null) => ExecutionOutcome, done: string[], owed = false): ExecutionOutcome {
    const item = row.item!;
    const snapshotId = this.#store.snapshotWithHead(identity, result.head);
    if (!snapshotId) throw new Error(`The snapshot of ${item}'s commit is missing.`);
    const items = this.#store.getPlan(identity, row.context.planRevision).items;
    let checkpointId: string;
    try {
      checkpointId = (owed ? direct : this.#write)(() => this.#store.pauseForAmendment(identity, { revision: row.context.planRevision, snapshotId }, {
        item, baseEntries: this.#sources.planContext(identity).baseEntries,
        completedItems: items.slice(0, items.findIndex(entry => entry.id === item) + 1).map(entry => entry.id), outOfScopePaths: result.outOfScope,
      }, { owed })).id;
    } catch (error) {
      if (!(error instanceof GuardRefusal) && !(owed && error instanceof ShuttingDownError)) throw error;
      return stopped(item, owed ? 'not started' : row.state, `${item} changed files outside its plan item, but the task could not pause for amendment: ${(error as Error).message}`);
    }
    return { kind: 'needs amendment', item, outOfScope: result.outOfScope, checkpointId, completed: [...done] };
  }
}

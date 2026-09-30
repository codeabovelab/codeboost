import type { PlanIdentity } from '../core/identity.ts';
import type { PlanContext } from '../core/plan.ts';
import type { InvocationHandle, InvocationInput, TaskClone } from '../agents/contract.ts';
import { prepareExecution } from '../core/execution-prompt.ts';
import { auditRun, type ChangeManifest } from '../core/run-audit.ts';
import { FinishFailure, NEEDS_RESTART, PreparationFailure, type PreparedAttempt, type RunnerCoordinator, type RunnerDeps } from './coordinator.ts';
import type { AttemptRecord, Store } from './store.ts';
import { CLOSED_STATUSES, GuardRefusal, ShuttingDownError, bounded, sameContext, settleWith, type ShutdownCapability } from './lifecycle.ts';

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
  snapshotDeclaredLinks(workspace: WorkspaceRef, paths: readonly string[], signal: AbortSignal): Promise<unknown>;
  /** The change manifest after the agent settled, plus a digest the commit step must match. */
  inspectChanges(workspace: WorkspaceRef, input: { baseHead: string; linkSnapshot: unknown }, signal: AbortSignal): Promise<ChangeManifest & { digest: string }>;
  /**
   * Commit exactly `paths` (both sides of every rename) on top of `baseHead` with hooks off; refuse if the tree no longer
   * matches `digest`. Agent commits are never undone: a manifest with any is a safety violation and never gets here (#66).
   */
  commit(workspace: WorkspaceRef, input: { baseHead: string; paths: readonly string[]; message: string; trailers: Readonly<Record<string, string>>; digest: string }, signal: AbortSignal): Promise<string>;
  release(workspace: WorkspaceRef): Promise<void>;
}
/** D's start call for an execute/fix phase with this prompt; returns at once (see #51). */
export type AgentLauncher = (input: InvocationInput, prompt: string, workspace: WorkspaceRef) => InvocationHandle;
/** Trusted runner-side sources for a task. Issue text and lessons are untrusted data inside the prompt. */
export interface ExecutionSources {
  planContext(identity: PlanIdentity): PlanContext;
  issue(identity: PlanIdentity): { number: number; title: string; body: string; comments: readonly string[] };
  lessons(identity: PlanIdentity): readonly string[];
  vendor(identity: PlanIdentity): 'claude' | 'codex';
}
/** Prefix of the diagnostic for an audit safety violation. For people only: the executor never reads it back. */
export const SAFETY_VIOLATION = 'Safety violation:';
/**
 * Safety violations the runner's own audit found, by attempt ID. executionDeps records them and ItemExecutor takes
 * them, so agent output (stderr) can never be mistaken for one, and a violation survives a later stale or stop outcome.
 */
export class SafetyFindings {
  #found = new Map<string, string>();
  record(attemptId: string, reason: string): void { this.#found.set(attemptId, reason); }
  /** A finding stays owed until its task has been moved to needs human (or closed); only then is it settled. */
  get(attemptId: string): string | undefined { return this.#found.get(attemptId); }
  settle(attemptId: string): void { this.#found.delete(attemptId); }
}
export interface ExecutionResult { head: string; unchanged: boolean; inScope: string[]; outOfScope: string[] }
interface Private { workspace: WorkspaceRef; prompt: string; baseHead: string; linkSnapshot: unknown }

/**
 * RunnerDeps for execute attempts: fresh workspace, prompt, agent, then audit and the runner's own commit.
 * `runnerOwner` is the database's runner token (`Store.runnerOwnerToken`); `workspace` must allocate task storage under it.
 */
export function executionDeps(store: Store, workspace: TaskWorkspace, launch: AgentLauncher, sources: ExecutionSources, runnerOwner: string,
  findings: SafetyFindings): RunnerDeps {
  const identityOf = (attempt: AttemptRecord): PlanIdentity => findIdentity(store, attempt);
  return {
    runnerOwner,
    async prepare(attempt, signal) {
      if (attempt.kind !== 'execute' || !attempt.item) throw new Error('Execution deps run execute attempts for one plan item.');
      const identity = identityOf(attempt), plan = store.getPlan(identity, attempt.context.planRevision);
      const item = plan.items.find(entry => entry.id === attempt.item)!;
      const context = sources.planContext(identity);
      const baseHead = store.getSnapshot(identity, attempt.context.snapshotId).head;
      const request = prepareExecution({ identity, attemptId: attempt.id, mode: 'execute', plan, itemId: item.id,
        issue: sources.issue(identity), approvedLessons: sources.lessons(identity), allowedCommands: context.allowedCommands });
      const vendor = sources.vendor(identity);
      const declaredPaths = [...new Set(item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]))];
      const ws = await workspace.materialize(attempt, baseHead, signal);
      // From here task storage exists: a failure hands it to the coordinator, which removes it after the terminal write.
      const data: Private = { workspace: ws, prompt: request.prompt, baseHead, linkSnapshot: undefined };
      const prepared = { clone: ws.clone, vendor, approvedArgv: request.approvedArgv, private: data };
      try { data.linkSnapshot = await workspace.snapshotDeclaredLinks(ws, declaredPaths, signal); }
      // D's text can name paths an earlier item's agent created: quote it (AGENTS.md).
      catch (error) { throw new PreparationFailure(new Error(JSON.stringify(error instanceof Error ? error.message : String(error)), { cause: error }), prepared); }
      return prepared;
    },
    async cleanupPreparation() { /* host-side files belong to D's materialize; task storage waits for release */ },
    start(input, prepared) { const data = prepared.private as Private; return launch(input, data.prompt, data.workspace); },
    validate() { throw new Error('Execute attempts publish through finish().'); },
    async finish(attempt, _result, prepared, signal) {
      const data = prepared.private as Private, identity = identityOf(attempt);
      const plan = store.getPlan(identity, attempt.context.planRevision), item = plan.items.find(entry => entry.id === attempt.item)!;
      const violation = (reason: string): never => {
        const text = bounded(`${SAFETY_VIOLATION} ${reason}`);
        findings.record(attempt.id, text);
        throw new FinishFailure(text);
      };
      let manifest: ChangeManifest & { digest: string };
      try { manifest = await workspace.inspectChanges(data.workspace, { baseHead: data.baseHead, linkSnapshot: data.linkSnapshot }, signal); }
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
      if (outcome.unchanged) return { value: { head: data.baseHead, unchanged: true, inScope: [], outOfScope: [] } satisfies ExecutionResult };
      // Last check before the commit, after the last await: a stop, shutdown or context change makes nothing.
      if (signal.aborted) throw signal.reason;
      if (!sameContext(attempt.context, store.currentContext(identity))) throw new FinishFailure('The plan, snapshot or assignment changed during the audit; nothing was committed.');
      // Every change is in or out of scope here; a rename stages both its old and its new path.
      const paths = [...new Set(manifest.changes.flatMap(entry => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]))];
      let head: string;
      try { head = await workspace.commit(data.workspace, {
        baseHead: data.baseHead, paths, digest: manifest.digest,
        // The title is plan text: on one line, it cannot open a trailer block that forges Plan-Item or Plan-Revision.
        message: `${item.id}: ${item.title.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()}`, trailers: { 'Plan-Item': item.id, 'Plan-Revision': `r${plan.revision}` },
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
    async release(_attempt, prepared) {
      const data = prepared.private as Private;
      await workspace.release(data.workspace);
    },
  };
}
/** The plan identity that owns an attempt; attempts are stored per plan key. */
function findIdentity(store: Store, attempt: AttemptRecord): PlanIdentity {
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
const refusal = (error: unknown) => error instanceof GuardRefusal || error instanceof ShuttingDownError;
/**
 * Statuses that wait for a person; leaving one needs its own user action (runner-lifecycle.md), so a safety finding is
 * owed there instead. Review statuses are not gates: a finding moves them to needs human, so the task cannot be merged.
 */
const HUMAN_GATES: readonly string[] = ['needs amendment', 'needs approval', 'possibly already fixed'];

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
  async runTask(identity: PlanIdentity, options: { fromItem?: string } = {}): Promise<ExecutionOutcome> {
    const plan = this.#store.getPlan(identity);
    const start = options.fromItem ? plan.items.findIndex(item => item.id === options.fromItem) : 0;
    if (start < 0) throw new Error('Unknown plan item.');
    const done: string[] = [], unchanged: string[] = [];
    const stopped = (item: string, state: string, reason: string | null): ExecutionOutcome => ({ kind: 'stopped', item, state, reason, completed: [...done] });
    // A safety finding not yet acted on (a failed write, a human gate at the time) goes to needs human first.
    for (const earlier of this.#store.getAttempts(identity)) {
      const finding = this.#findings.get(earlier.id);
      if (finding) return this.#escalate(identity, earlier, finding, stopped, []);
    }
    // A scope finding whose pause was never recorded (a failed write, the write gate, a crash) pauses now, before any item.
    const owed = this.#unpausedScopeFinding(identity);
    if (owed) return this.#pause(identity, owed.row, owed.result, stopped, [], true);
    // Continuing after a scope pause (plan-format.md: reconcile the executed prefix with the audited head, validate the
    // remaining items from that checkpoint) is not built yet (#88), so a paused task runs no further items: fail closed.
    const checkpoint = this.#store.latestCheckpoint(identity);
    if (checkpoint)
      return stopped(options.fromItem ?? plan.items[start]!.id, 'not started',
        `${checkpoint.item} changed files outside its plan item. Continuing after a scope pause is not supported yet (#88), so this task runs no further items.`);
    /** Where the next item must start: the context the previous item left, or the current one for the first item. */
    let expected: { snapshotId: string; assignmentId: string; referencedCodeHash: string } | null = null;
    for (const item of plan.items.slice(start)) {
      // Admission reads the context in this same turn, so it cannot notice a change saved during an earlier item.
      const current = this.#store.currentContext(identity);
      // After an item, the task is still running unless someone changed its status meanwhile: then the run stops.
      if (expected && this.#store.getTask(identity).status !== 'running')
        return stopped(item.id, 'not started', `The task's status changed to ${this.#store.getTask(identity).status} during the run; ${item.id} was not started.`);
      if (this.#store.getPlan(identity).revision !== plan.revision)
        return stopped(item.id, 'not started', `The plan changed to a new revision during the run; review it before running ${item.id}.`);
      if (expected && (current.snapshotId !== expected.snapshotId || current.assignmentId !== expected.assignmentId || current.referencedCodeHash !== expected.referencedCodeHash))
        return stopped(item.id, 'not started', `The task's snapshot or assignment changed during the run; review it before running ${item.id}.`);
      let attempt: AttemptRecord;
      try {
        attempt = this.#runner.start(identity, {
          expectedStateVersion: this.#store.getTask(identity).stateVersion, kind: 'execute', item: item.id,
          expectedContext: current, deadline: Date.now() + this.#deadlineMs,
        });
      } catch (error) {
        if (!refusal(error)) throw error;
        return stopped(item.id, 'not started', error instanceof Error ? error.message : String(error));
      }
      await this.#runner.settled(identity);
      const row = this.#store.getAttempt(identity, attempt.id);
      // Only the runner's own audit records a finding; it wins over any later stale or stop outcome.
      const violation = this.#findings.get(attempt.id);
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
      expected = { snapshotId, assignmentId: row.context.assignmentId, referencedCodeHash: row.context.referencedCodeHash };
    }
    return { kind: 'executed', items: done, unchanged };
  }
  /**
   * A safety finding sends the task to needs human (plan-format.md, "After each run"). From running, queued or a review
   * status it moves now. A human gate is kept, because leaving it needs its own user action (runner-lifecycle.md), and
   * the finding stays owed: the task's next run escalates it before anything else. A closed task needs nothing.
   * The finding is settled only once acted on, so a failed write leaves it owed too.
   */
  #escalate(identity: PlanIdentity, row: AttemptRecord, violation: string,
    stopped: (item: string, state: string, reason: string | null) => ExecutionOutcome, done: string[]): ExecutionOutcome {
    const item = row.item!, task = this.#store.getTask(identity);
    if (CLOSED_STATUSES.includes(task.status)) {
      this.#findings.settle(row.id);
      return stopped(item, row.state, `${violation} The task is ${task.status}, so it was not moved to needs human.`);
    }
    // Already where the finding sends it: nothing is owed.
    if (task.status === 'needs human') {
      this.#findings.settle(row.id);
      return { kind: 'needs human', item, reason: violation, completed: [...done] };
    }
    if (HUMAN_GATES.includes(task.status))
      return stopped(item, row.state, `${violation} The task is ${task.status}; it moves to needs human when it next runs.`);
    try { this.#write(() => this.#store.transitionTask(identity, task.stateVersion, 'needs human')); }
    catch (error) {
      if (!(error instanceof GuardRefusal)) throw error;
      return stopped(item, row.state, `${violation} The task could not be moved to needs human yet: ${error.message}`);
    }
    this.#findings.settle(row.id);
    return { kind: 'needs human', item, reason: violation, completed: [...done] };
  }
  /** The latest completed execute attempt, if its out-of-scope files have no checkpoint yet (its pause was lost). */
  #unpausedScopeFinding(identity: PlanIdentity): { row: AttemptRecord; result: ExecutionResult } | null {
    const row = this.#store.getAttempts(identity).filter(entry => entry.kind === 'execute' && entry.state === 'completed').at(-1);
    const result = row?.result as ExecutionResult | undefined;
    if (!row || !result?.outOfScope?.length) return null;
    return this.#store.checkpointAtHead(identity, result.head) ? null : { row, result };
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
      checkpointId = this.#write(() => this.#store.pauseForAmendment(identity, { revision: row.context.planRevision, snapshotId }, {
        item, baseEntries: this.#sources.planContext(identity).baseEntries,
        completedItems: items.slice(0, items.findIndex(entry => entry.id === item) + 1).map(entry => entry.id), outOfScopePaths: result.outOfScope,
      }, { owed })).id;
    } catch (error) {
      if (!(error instanceof GuardRefusal)) throw error;
      return stopped(item, row.state, `${item} changed files outside its plan item, but the task could not pause for amendment: ${error.message}`);
    }
    return { kind: 'needs amendment', item, outOfScope: result.outOfScope, checkpointId, completed: [...done] };
  }
}

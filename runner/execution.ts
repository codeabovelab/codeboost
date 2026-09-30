import type { PlanIdentity } from '../core/identity.ts';
import type { PlanContext } from '../core/plan.ts';
import type { InvocationHandle, InvocationInput, TaskClone } from '../agents/contract.ts';
import { prepareExecution } from '../core/execution-prompt.ts';
import { auditRun, type ChangeManifest } from '../core/run-audit.ts';
import { FinishFailure, PreparationFailure, type PreparedAttempt, type RunnerCoordinator, type RunnerDeps } from './coordinator.ts';
import type { AttemptRecord, Store } from './store.ts';
import { GuardRefusal, ShuttingDownError, settleWith, type ShutdownCapability } from './lifecycle.ts';

/**
 * F2b: per-item execution and the runner's commit step (design, "How codeboost runs a plan"; plan-format.md, "After
 * each run"). The workspace operations are D's (#66); until they exist this module is exercised with a fake.
 */
export interface WorkspaceRef { readonly clone: TaskClone; readonly storage: unknown }
export interface TaskWorkspace {
  /** A fresh task filesystem from the recorded trusted head; never a reset of a used one. Abortable; settles only when its work stopped. */
  materialize(attempt: AttemptRecord, head: string, signal: AbortSignal): Promise<WorkspaceRef>;
  /** No-follow snapshot of every declared symlink target, taken before launch. */
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
  take(attemptId: string): string | undefined { const reason = this.#found.get(attemptId); this.#found.delete(attemptId); return reason; }
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
      const declaredLinks = item.files.map(file => file.path).filter(path => context.baseEntries.some(entry => entry.kind === 'symlink' && context.pathKey(entry.path) === context.pathKey(path)));
      const ws = await workspace.materialize(attempt, baseHead, signal);
      // From here task storage exists: a failure hands it to the coordinator, which removes it after the terminal write.
      const data: Private = { workspace: ws, prompt: request.prompt, baseHead, linkSnapshot: undefined };
      const prepared = { clone: ws.clone, vendor, approvedArgv: request.approvedArgv, private: data };
      try { data.linkSnapshot = await workspace.snapshotDeclaredLinks(ws, declaredLinks, signal); }
      catch (error) { throw new PreparationFailure(error, prepared); }
      return prepared;
    },
    async cleanupPreparation() { /* host-side files belong to D's materialize; task storage waits for release */ },
    start(input, prepared) { const data = prepared.private as Private; return launch(input, data.prompt, data.workspace); },
    validate() { throw new Error('Execute attempts publish through finish().'); },
    async finish(attempt, _result, prepared, signal) {
      const data = prepared.private as Private, identity = identityOf(attempt);
      const plan = store.getPlan(identity, attempt.context.planRevision), item = plan.items.find(entry => entry.id === attempt.item)!;
      const violation = (reason: string): never => {
        const text = `${SAFETY_VIOLATION} ${reason}`;
        findings.record(attempt.id, text);
        throw new FinishFailure(text);
      };
      let manifest: ChangeManifest & { digest: string };
      try { manifest = await workspace.inspectChanges(data.workspace, { baseHead: data.baseHead, linkSnapshot: data.linkSnapshot }, signal); }
      catch (error) {
        // A stop aborted the inspection; that is the stop, not a finding.
        if (signal.aborted) throw error;
        // Contract (Publishing step 2): an inspection that refuses sends the task to needs human.
        return violation(`The change inspection refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      const outcome = auditRun(item, manifest, sources.planContext(identity).pathKey);
      if (outcome.kind === 'violation') return violation(outcome.violations.join(' '));
      if (outcome.unchanged) return { value: { head: data.baseHead, unchanged: true, inScope: [], outOfScope: [] } satisfies ExecutionResult };
      // Every change is in or out of scope here; a rename stages both its old and its new path.
      const paths = [...new Set(manifest.changes.flatMap(entry => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]))];
      const head = await workspace.commit(data.workspace, {
        baseHead: data.baseHead, paths, digest: manifest.digest,
        message: `${item.id}: ${item.title}`, trailers: { 'Plan-Item': item.id, 'Plan-Revision': `r${plan.revision}` },
      }, signal);
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

/** `completed` lists the items this run finished before it ended, so a caller never loses them. */
export type ExecutionOutcome =
  | { kind: 'executed'; items: string[]; unchanged: string[] }
  | { kind: 'needs amendment'; item: string; outOfScope: string[]; checkpointId: string; completed: string[] }
  | { kind: 'needs human'; item: string; reason: string; completed: string[] }
  | { kind: 'stopped'; item: string; state: string; reason: string | null; completed: string[] };
const refusal = (error: unknown) => error instanceof GuardRefusal || error instanceof ShuttingDownError;

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
    for (const item of plan.items.slice(start)) {
      // Admission reads the context in this same turn, so it cannot notice a revision saved during an earlier item.
      if (this.#store.getPlan(identity).revision !== plan.revision)
        return stopped(item.id, 'not started', `The plan changed to a new revision during the run; review it before running ${item.id}.`);
      let attempt: AttemptRecord;
      try {
        attempt = this.#runner.start(identity, {
          expectedStateVersion: this.#store.getTask(identity).stateVersion, kind: 'execute', item: item.id,
          expectedContext: this.#store.currentContext(identity), deadline: Date.now() + this.#deadlineMs,
        });
      } catch (error) {
        if (!refusal(error)) throw error;
        return stopped(item.id, 'not started', error instanceof Error ? error.message : String(error));
      }
      await this.#runner.settled(identity);
      const row = this.#store.getAttempt(identity, attempt.id);
      // Only the runner's own audit records a finding; it wins over any later stale or stop outcome.
      const violation = this.#findings.take(attempt.id);
      if (violation) {
        try { this.#write(() => this.#store.transitionTask(identity, this.#store.getTask(identity).stateVersion, 'needs human')); }
        catch (error) {
          if (!refusal(error)) throw error;
          return stopped(item.id, row.state, `${violation} The task could not be moved to needs human: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { kind: 'needs human', item: item.id, reason: violation, completed: [...done] };
      }
      if (row.state !== 'completed') {
        // Still pending or running: the terminal write failed and the slot is held until restart.
        const unresolved = this.#runner.status(identity).unresolved;
        return stopped(item.id, row.state, row.state === 'pending' || row.state === 'running'
          ? `Needs restart: the result of ${item.id} could not be saved.${unresolved ? ` (${unresolved.reason})` : ''}` : row.diagnostic);
      }
      const result = row.result as ExecutionResult;
      done.push(item.id);
      if (result.unchanged) unchanged.push(item.id);
      if (result.outOfScope.length) {
        // The checkpoint names the revision the item ran against; the snapshot is the one its own commit created.
        const view = { revision: row.context.planRevision, snapshotId: this.#store.getSnapshot(identity).id };
        let checkpointId: string;
        try {
          checkpointId = this.#write(() => this.#store.pauseForAmendment(identity, view, {
            item: item.id, baseEntries: this.#sources.planContext(identity).baseEntries,
            completedItems: plan.items.slice(0, plan.items.indexOf(item) + 1).map(entry => entry.id), outOfScopePaths: result.outOfScope,
          })).id;
        } catch (error) {
          if (!refusal(error) && !(error instanceof Error && /review state|executed plan prefix/i.test(error.message))) throw error;
          return stopped(item.id, row.state, `${item.id} changed files outside its plan item, but the task could not pause for amendment: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { kind: 'needs amendment', item: item.id, outOfScope: result.outOfScope, checkpointId, completed: [...done] };
      }
    }
    return { kind: 'executed', items: done, unchanged };
  }
}

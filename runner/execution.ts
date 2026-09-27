import type { PlanIdentity } from '../core/identity.ts';
import type { PlanContext } from '../core/plan.ts';
import type { InvocationHandle, InvocationInput, TaskClone } from '../agents/contract.ts';
import { prepareExecution } from '../core/execution-prompt.ts';
import { auditRun, type ChangeManifest } from '../core/run-audit.ts';
import { FinishFailure, type PreparedAttempt, type RunnerCoordinator, type RunnerDeps } from './coordinator.ts';
import type { AttemptRecord, Store } from './store.ts';

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
  /** Undo agent commits (keeping changes), stage exactly `paths`, commit with hooks off; refuse if the tree no longer matches `digest`. */
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
/** Prefix of the diagnostic for an audit safety violation; the executor moves the task to needs human on it. */
export const SAFETY_VIOLATION = 'Safety violation:';
export interface ExecutionResult { head: string; unchanged: boolean; inScope: string[]; outOfScope: string[] }
interface Private { workspace: WorkspaceRef; prompt: string; baseHead: string; linkSnapshot: unknown }

/** RunnerDeps for execute attempts: fresh workspace, prompt, agent, then audit and the runner's own commit. */
export function executionDeps(store: Store, workspace: TaskWorkspace, launch: AgentLauncher, sources: ExecutionSources): RunnerDeps {
  const identityOf = (attempt: AttemptRecord): PlanIdentity => findIdentity(store, attempt);
  return {
    async prepare(attempt, signal) {
      if (attempt.kind !== 'execute' || !attempt.item) throw new Error('Execution deps run execute attempts for one plan item.');
      const identity = identityOf(attempt), plan = store.getPlan(identity, attempt.context.planRevision);
      const item = plan.items.find(entry => entry.id === attempt.item)!;
      const context = sources.planContext(identity);
      const baseHead = store.getSnapshot(identity, attempt.context.snapshotId).head;
      const request = prepareExecution({ identity, attemptId: attempt.id, mode: 'execute', plan, itemId: item.id,
        issue: sources.issue(identity), approvedLessons: sources.lessons(identity), allowedCommands: context.allowedCommands });
      const ws = await workspace.materialize(attempt, baseHead, signal);
      const declaredLinks = item.files.map(file => file.path).filter(path => context.baseEntries.some(entry => entry.kind === 'symlink' && context.pathKey(entry.path) === context.pathKey(path)));
      const linkSnapshot = await workspace.snapshotDeclaredLinks(ws, declaredLinks, signal);
      const data: Private = { workspace: ws, prompt: request.prompt, baseHead, linkSnapshot };
      return { clone: ws.clone, vendor: sources.vendor(identity), approvedArgv: request.approvedArgv, private: data };
    },
    async cleanupPreparation() { /* host-side files belong to D's materialize; task storage waits for release */ },
    start(input, prepared) { const data = prepared.private as Private; return launch(input, data.prompt, data.workspace); },
    validate() { throw new Error('Execute attempts publish through finish().'); },
    async finish(attempt, _result, prepared, signal) {
      const data = prepared.private as Private, identity = identityOf(attempt);
      const plan = store.getPlan(identity, attempt.context.planRevision), item = plan.items.find(entry => entry.id === attempt.item)!;
      const manifest = await workspace.inspectChanges(data.workspace, { baseHead: data.baseHead, linkSnapshot: data.linkSnapshot }, signal);
      const outcome = auditRun(item, manifest, sources.planContext(identity).pathKey);
      if (outcome.kind === 'violation') throw new FinishFailure(`${SAFETY_VIOLATION} ${outcome.violations.join(' ')}`);
      if (outcome.unchanged) return { value: { head: data.baseHead, unchanged: true, inScope: [], outOfScope: [] } satisfies ExecutionResult };
      const head = await workspace.commit(data.workspace, {
        baseHead: data.baseHead, paths: [...outcome.inScope, ...outcome.outOfScope], digest: manifest.digest,
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

export type ExecutionOutcome =
  | { kind: 'executed'; items: string[]; unchanged: string[] }
  | { kind: 'needs amendment'; item: string; outOfScope: string[]; checkpointId: string }
  | { kind: 'needs human'; item: string; reason: string }
  | { kind: 'stopped'; item: string; state: string; reason: string | null };

/**
 * Runs a task's plan items in order, one execute attempt each. Stops at the first item that does not complete cleanly:
 * out-of-scope files pause the task in needs amendment with a checkpoint; a safety violation moves it to needs human.
 */
export class ItemExecutor {
  #store: Store; #runner: RunnerCoordinator; #sources: ExecutionSources;
  #deadlineMs: number;
  constructor(store: Store, runner: RunnerCoordinator, sources: ExecutionSources, deadlineMs = 10 * 60_000) {
    this.#store = store; this.#runner = runner; this.#sources = sources; this.#deadlineMs = deadlineMs;
  }
  async runTask(identity: PlanIdentity, options: { fromItem?: string } = {}): Promise<ExecutionOutcome> {
    const plan = this.#store.getPlan(identity);
    const start = options.fromItem ? plan.items.findIndex(item => item.id === options.fromItem) : 0;
    if (start < 0) throw new Error('Unknown plan item.');
    const done: string[] = [], unchanged: string[] = [];
    for (const item of plan.items.slice(start)) {
      const attempt = this.#runner.start(identity, {
        expectedStateVersion: this.#store.getTask(identity).stateVersion, kind: 'execute', item: item.id,
        expectedContext: this.#store.currentContext(identity), deadline: Date.now() + this.#deadlineMs,
      });
      await this.#runner.settled(identity);
      const row = this.#store.getAttempt(identity, attempt.id);
      if (row.state !== 'completed') {
        if (row.state === 'failed' && row.diagnostic?.startsWith(SAFETY_VIOLATION)) {
          this.#store.transitionTask(identity, this.#store.getTask(identity).stateVersion, 'needs human');
          return { kind: 'needs human', item: item.id, reason: row.diagnostic };
        }
        return { kind: 'stopped', item: item.id, state: row.state, reason: row.diagnostic };
      }
      const result = row.result as ExecutionResult;
      done.push(item.id);
      if (result.unchanged) unchanged.push(item.id);
      if (result.outOfScope.length) {
        const view = { revision: this.#store.getPlan(identity).revision, snapshotId: this.#store.getSnapshot(identity).id };
        const checkpoint = this.#store.recordCheckpoint(identity, view, {
          item: item.id, baseEntries: this.#sources.planContext(identity).baseEntries,
          completedItems: plan.items.slice(0, plan.items.indexOf(item) + 1).map(entry => entry.id), outOfScopePaths: result.outOfScope,
        });
        this.#store.transitionTask(identity, this.#store.getTask(identity).stateVersion, 'needs amendment');
        return { kind: 'needs amendment', item: item.id, outOfScope: result.outOfScope, checkpointId: checkpoint.id };
      }
    }
    return { kind: 'executed', items: done, unchanged };
  }
}

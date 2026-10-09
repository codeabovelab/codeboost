import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlanIdentity } from '../core/identity.ts';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { Questions, type QuestionAgent } from '../runner/questions.ts';
import { GhMergeGateway, type MergeGateway } from '../github/merge.ts';
import { MERGE_OPERATION_TIMEOUT_MS, MergeCoordinator, MergeNotApplied, MergeOutcomeUnknown } from '../runner/merge.ts';
import { RunnerCoordinator, type RunnerDeps } from '../runner/coordinator.ts';
import { ItemExecutor } from '../runner/execution.ts';
import { OWED_REFUSAL, TaskPublishing } from '../runner/publishing.ts';
import type { RunnerAssembly } from '../runner/production.ts';
import { baseBranch } from '../github/validate.ts';
import type { ShutdownCapability } from '../runner/lifecycle.ts';
import { ActionIdReused, BadRequest, GuardRefusal, ShuttingDownError, UpstreamFailure, assertUuidV4, isUuidV4, sameContext } from '../runner/lifecycle.ts';
import { GhIssueGateway, type IssueGateway, type IssueAccess, type IssueTrustGateway } from '../github/issues.ts';
import { demoIssueGateway } from '../scripts/demo-issues.ts';
import { IssueBoard } from './issues.ts';
import { SuggestionCoordinator, type PlanningMode, type SuggestionHandle, type SuggestionInput, type SuggestionStore } from '../core/planning-suggestions.ts';
import type { AuthorProvider } from '../core/planning-author.ts';
import { PLANNING_BUDGET_MS } from '../runner/planning-provider.ts';
import type { PreMergeCoordinator } from '../runner/pre-merge.ts';
export type PlanningDescription = Pick<SuggestionInput, 'issue' | 'approvedLessons'> & {
  repo: { name: string; baseRef: string };
  /** Revalidates any mutable authority carried by this description at the synchronous prompt-construction boundary. */
  validate(): void;
};
/** Live planning runs only through D (G4 after #51, #117). Until a provider is injected, starting a suggestion is refused. */
export interface PlanningDeps {
  provider: AuthorProvider;
  /**
   * Trusted repository, issue and approved-lesson inputs for a suggestion request. Production reads the issue from
   * GitHub, so it may wait; `signal` ends with the HTTP request.
   */
  describe(signal: AbortSignal): PlanningDescription | Promise<PlanningDescription>;
  /** Releases what the provider owns at shutdown, after every suggestion has settled. */
  close?(): Promise<void>;
}
/** Start, cancel or apply a suggestion or a draft (#124): `/api/plan/<kind>` or `/api/plan/<kind>/<id>/<action>`. */
const PLANNING_REQUEST = /^\/api\/plan\/(suggestions|drafts)(?:\/([0-9a-f-]{36})\/(cancel|apply))?$/;
/** How long a planning request may take to settle after shutdown aborts it, before its worker is abandoned (Ask's grace). */
export const PLANNING_SHUTDOWN_GRACE_MS = 20_000;
/** Production planning is built after the Store opens, from the review it serves (see web/cli.ts). */
export type PlanningSetup = (service: ReviewService) => PlanningDeps;
const publicRoot = new URL('./public/', import.meta.url);
/** The longest shutdown waits for admitted requests to finish before aborting them; below the 15 s request timeout. */
export const MAX_SHUTDOWN_DRAIN_MS = 14_500;
/**
 * The production runner's startup (#91, `setUpRunner`): run after the Store opens and before the server listens, so
 * startup recovery finishes before anything is admitted. A rejection stops startup.
 */
export type RunnerSetup = (service: ReviewService, capability: ShutdownCapability) => Promise<RunnerAssembly>;
export const RUNNER_NOT_CONFIGURED = 'The runner is not configured. Add a runner block to the review configuration and restart codeboost.';
/** Demos never run the runner, whatever their configuration says. */
export const RUNNER_NOT_IN_DEMO = 'Demos do not run the runner. Use a review configuration with a runner block.';
export interface ServerTestHooks {
  /** Test-only gate for forcing a response lifecycle transition before the Issues wait is armed. */
  beforeIssueRefreshWait?(): Promise<void> | void;
}
export async function startServer(config: ReviewConfig, port = 4318, questionAgent?: QuestionAgent, mergeGateway?: MergeGateway, shutdownDrainMs = MAX_SHUTDOWN_DRAIN_MS, issueGateway?: IssueGateway, runnerDeps?: RunnerDeps, planningInput?: PlanningDeps | PlanningSetup, runnerSetup?: RunnerSetup, testHooks: ServerTestHooks = {}) {
  if (!Number.isSafeInteger(shutdownDrainMs) || shutdownDrainMs < 1 || shutdownDrainMs > MAX_SHUTDOWN_DRAIN_MS) throw new Error('Invalid shutdown drain deadline.');
  const service = new ReviewService(config), token = randomBytes(32).toString('hex');
  let questions: Questions, merges: MergeCoordinator | null, issues: IssueBoard, runner: RunnerCoordinator | null, suggestions: SuggestionCoordinator | null;
  let preMerge: PreMergeCoordinator | null = null;
  let planning: PlanningDeps | undefined, issueSource: IssueGateway | null;
  /** Runs a task's plan items; one per Store, like the coordinator. Only the production runner has one. */
  let executor: ItemExecutor | null = null;
  /** Publishes the task's pull request (#103); only a production runner whose setup built a publisher has one. */
  let publishing: TaskPublishing | null = null;
  /** Installed after the issue gateway and trust helpers exist; every publish attempt, including retries, calls it. */
  let authorizePublish: ((identity: PlanIdentity, signal: AbortSignal) => Promise<() => Promise<void>>) | undefined;
  // Only coordinators' settlement and close code receive this; HTTP handlers never do.
  const capability = service.store.shutdownCapability();
  try {
    if (!config.demo && config.github && config.github.issue !== service.store.getPlan(config.identity).issue) throw new Error('The GitHub merge issue must match the stored plan issue.');
    questions=new Questions(service,questionAgent,capability);
    // Issue retrieval is read-only, so demos may show it; they use a local fixture and never contact GitHub.
    issueSource = issueGateway ?? (config.demo ? demoIssueGateway() : config.github ? new GhIssueGateway(config.github.repository) : null);
    issues = new IssueBoard(issueSource,
      'Issue ranking needs a GitHub repository. Add a github block with a repository to the review configuration.', undefined,
      (repository, issue) => service.store.issueTrust(repository, issue));
    // With a runner block the merge targets the task's published PR (#121); without one, github.pullRequest is required.
    const published = !config.demo && config.runner !== undefined && config.github
      ? { repository: config.github.repository, baseBranch: baseBranch(config.github), requiresPreparation: true,
        ...(config.github.pullRequest !== undefined ? { configured: config.github.pullRequest } : {}) } : undefined;
    if (!config.demo && config.github && !published && !mergeGateway && config.github.pullRequest === undefined)
      throw new Error('Add github.pullRequest, the pull request to merge, to the review configuration, or add a runner block so codeboost publishes its own.');
    merges = !config.demo && (mergeGateway || config.github) ? new MergeCoordinator(service, mergeGateway ?? new GhMergeGateway(config.github!), MERGE_OPERATION_TIMEOUT_MS, capability, published) : null;
    if (runnerDeps && runnerSetup) throw new Error('Pass runner deps or a runner setup, not both.');
    // Without a runner (no runner block, or a demo), runner actions report that it is not configured.
    runner = runnerDeps ? new RunnerCoordinator(service.store, runnerDeps, undefined, capability) : null;
    // E3's settlement writes (completeSuggestions, settleSuggestion in close()) run with the shutdown capability.
    const store = service.store;
    const suggestionStore: SuggestionStore = {
      getPlan: identity => store.getPlan(identity), getSnapshot: identity => store.getSnapshot(identity),
      beginSuggestions: (identity, expected, mode, continuation) => store.beginSuggestions(identity, expected, mode, continuation),
      completeSuggestions: (identity, id, reply, candidatePlans) => capability.run(() => store.completeSuggestions(identity, id, reply, candidatePlans)),
      settleSuggestion: (identity, id, expected, outcome) => capability.run(() => store.settleSuggestion(identity, id, expected, outcome)),
      getSuggestions: (identity, id) => store.getSuggestions(identity, id),
    };
    planning = typeof planningInput === 'function' ? planningInput(service) : planningInput;
    // One budget for a suggestion, setup included: lane D's cap, which the provider's own deadline stays inside (#117).
    suggestions = planning ? new SuggestionCoordinator(suggestionStore, planning.provider, PLANNING_BUDGET_MS) : null;
  } catch (error) { service.close(); throw error; }
  if (runnerSetup) {
    // Startup recovery runs here, before listen: nothing is admitted until it has finished.
    try {
      const assembly = await runnerSetup(service, capability);
      runner = new RunnerCoordinator(service.store, assembly.deps, undefined, capability);
      if (assembly.preMerge && merges) preMerge = assembly.preMerge(runner, signal => merges!.remotePair(signal), async signal => {
        let access = await readIssueAccess(signal);
        requireTrustedIssue(access);
        return {
          refresh: async () => { access = await readIssueAccess(signal); requireTrustedIssue(access); },
          validate: () => requireTrustedIssue(access),
        };
      });
      executor = new ItemExecutor(service.store, runner, assembly.sources, assembly.findings, { capability });
      // A demo never publishes, whatever its github block or an injected setup provides (setUpRunner refuses demos too).
      if (assembly.publisher && !config.demo) { const coordinator = runner; publishing = new TaskPublishing(service.store, assembly.publisher(() => coordinator.closing), runner, executor, capability, assembly.env, {
        ...(assembly.shortRetryMs !== undefined ? { shortRetryMs: assembly.shortRetryMs } : {}),
        ...(config.github ? { authorizePublish: (publishIdentity: PlanIdentity, signal: AbortSignal) => {
          if (!authorizePublish) throw new GuardRefusal('Issue trust admission is not configured.');
          return authorizePublish(publishIdentity, signal);
        } } : {}),
      }); }
    } catch (error) { service.close(); throw error; }
  }
  const loadReview=()=>{const view=service.load();return {...view,notes:view.notes.map(note=>({...note,answerActive:questions.isRunning(note.id)}))};};
  const load=async(signal?:AbortSignal)=>{const view=loadReview();return {...view,merge:merges?await merges.displayStatus(view,signal):{available:false}};};
  const answerStatuses=()=>service.store.getReviewNotes(config.identity)
    .filter(note=>note.kind==='question')
    .map(note=>({id:note.id,answer:note.answer,answerActive:questions.isRunning(note.id)}));
  const identity = config.identity;
  const trustGateway = issueSource && 'issueAccess' in issueSource ? issueSource as IssueTrustGateway : null;
  const requireTrustedIssue = (access: IssueAccess): void => {
    if (access.collaborator) return;
    const repository = trustGateway!.repository;
    const trust = service.store.issueTrust(repository, access.number);
    if (!trust || trust.revokedAt !== null || trust.authorLogin !== access.authorLogin)
      throw new GuardRefusal(`Issue #${access.number} is not trusted for its current author.`);
  };
  const readIssueAccess = async (signal: AbortSignal): Promise<IssueAccess> => {
    if (!trustGateway || !config.github) throw new GuardRefusal('Issue trust admission is not configured.');
    try { return await trustGateway.issueAccess(config.github.issue, { signal, timeoutMs: 12_000 }); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new UpstreamFailure(`Issue trust could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  authorizePublish = async (_publishIdentity, signal) => {
    const access = await readIssueAccess(signal);
    requireTrustedIssue(access);
    return async () => requireTrustedIssue(await readIssueAccess(signal));
  };
  if (config.github) merges?.setAuthorization(async signal => {
    let access = await readIssueAccess(signal);
    requireTrustedIssue(access);
    return {
      refresh: async () => { access = await readIssueAccess(signal); requireTrustedIssue(access); },
      validate: () => requireTrustedIssue(access),
    };
  });
  /**
   * What `start` or `resume` would run (#91 part 2), or the local refusal. It writes nothing, so the view asks it too.
   * The view also suppresses controls when the latest complete issue board says trust is blocked; every action still
   * performs a fresh external admission check because collaborator status and authorship can change afterward. `start`
   * runs a task that is in review or queued and has attempted no item of its
   * current plan revision; `resume` continues a running or queued task that attempted an item at any revision (or that
   * recovery left to requeue), from the first item the current revision has not completed, whether its last item
   * completed, failed or was stopped. A queued task with only earlier-revision attempts may take either; both run the
   * same items.
   */
  const runChoice = (action: 'start' | 'resume', forView = false, progress = executor?.progress(identity)) => {
    if (!executor || !progress) throw new GuardRefusal(config.demo ? RUNNER_NOT_IN_DEMO : RUNNER_NOT_CONFIGURED);
    // Shutdown began: answer 503 before any refusal, so nothing is recorded under the action ID and the UI may resend.
    if (!forView && runner!.closing) throw new ShuttingDownError();
    const task = service.store.getTask(identity), { started, begun, earlierCommits } = progress;
    // Safety evidence must settle before reconciliation can refuse on a stale prefix or head.
    const safetyOwed = executor.owes(identity, { scope: false });
    const anyFindingOwed = executor.owes(identity);
    const continuation = anyFindingOwed ? null : service.store.continuationProgress(identity);
    const completed = continuation?.completed ?? progress.completed;
    const prefixHead = continuation?.head ?? progress.prefixHead;
    const next = continuation ? continuation.next : progress.next;
    // Checked in the order a person can act on: a closed task first, then what admission would refuse.
    if (task.status === 'merged' || task.status === 'cancelled') throw new GuardRefusal(`The task is ${task.status}.`);
    if (!runner!.runs('execute')) throw new GuardRefusal('The runner cannot run execute attempts yet.');
    if (runner!.isActive(identity)) throw new GuardRefusal('An attempt is already active for this task.');
    // Between two items no attempt is active, but the run that admits the next one is still going.
    if (executor.busy(identity)) throw new GuardRefusal('An earlier run of this task is still finishing; try again when that run has ended.');
    // A publish reads the task head and pushes it; a new item must not move it meanwhile.
    if (publishing?.busy(identity)) throw new GuardRefusal('A pull request is being published for this task; try again when it has finished.');
    // Recovery owns this claim for Resume even when owed work will settle instead of admitting an item. Start must not
    // consume it and strand the task behind the resulting human gate.
    if (action === 'start' && task.requeuePending) throw new GuardRefusal('Recovery left this task to requeue; it cannot start until Resume resolves that claim.');
    // A failed durable save must not let an ordinary refusal strand an in-memory safety finding until restart loses it.
    if (safetyOwed) return { fromItem: next ?? service.store.getPlan(identity).items[0]!.id,
      claimRequeue: task.requeuePending, queue: false, owed: true };
    const merge = service.store.getMergeAttempt(identity);
    const activeMerge = !!merge && (merge.state === 'submitting' || merge.state === 'queued');
    // Scope-only debt is actionable only where pauseForAmendment can commit it. Otherwise expose the ordinary refusal;
    // unlike a safety finding, repeatedly offering an impossible pause cannot preserve or improve durable evidence.
    const scopePausable = ['running', 'in review', 'approved but merge blocked', 'queued'].includes(task.status)
      && task.cancelRequested === null && !activeMerge;
    if (scopePausable && executor.owes(identity)) return { fromItem: next ?? service.store.getPlan(identity).items[0]!.id,
      claimRequeue: task.requeuePending, queue: false, owed: true };
    if (task.cancelRequested !== null) throw new GuardRefusal('The task is being cancelled.');
    if (activeMerge) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    // Only the view stops here: the action lets admission refuse, because its refusal also moves the idle task to needs
    // human (the time-limit mapping), and nothing else would.
    if (forView && task.budgetDeadline !== null && task.budgetDeadline <= Date.now()) throw new GuardRefusal('The task time budget has run out; it needs a person.');
    if (continuation && !service.store.continuationApproved(identity, continuation))
      throw new GuardRefusal('Approve the amended plan continuation before resuming the task.');
    // Commits from another revision without a scope checkpoint have no audited continuation prefix to reconcile; rerunning
    // the plan on top of them could redo or contradict that work. Earlier attempts that committed nothing leave none.
    if (!continuation && !begun && earlierCommits) throw new GuardRefusal('The plan changed after runner commits without a scope checkpoint; those commits cannot be reconciled safely.');
    if (action === 'start') {
      if (continuation) throw new GuardRefusal('This task has a scope checkpoint; resume it after approving the amended continuation.');
      // Point to resume wherever resume could run (a running task that ran any revision too); any other status is named as it is.
      const ran = begun || task.requeuePending;
      if (next !== null && ((ran && task.status === 'queued') || (task.status === 'running' && (started || task.requeuePending))))
        throw new GuardRefusal('This plan has already started running; resume the task instead.');
      if (task.status !== 'in review' && task.status !== 'queued') throw new GuardRefusal(`The task is ${task.status}; start runs a task that is in review or queued.`);
      if (ran) throw new GuardRefusal(begun ? `This plan revision has already run; the task is ${task.status}.` : 'Recovery left this task to requeue; it cannot start until that is resolved.');
      const unapproved = service.store.unapprovedExecutionItems(identity, service.store.getPlan(identity).revision);
      if (unapproved.length) throw new GuardRefusal(`Approve every plan item before running it. Waiting for: ${unapproved.join(', ')}.`);
      return { fromItem: next!, claimRequeue: false, queue: task.status === 'in review' };
    }
    // As for start: point to start only where start's own checks pass.
    const startWould = (task.status === 'in review' || task.status === 'queued') && !begun && !task.requeuePending;
    const toStart = 'This plan revision has not started running yet; start the task instead.';
    if (task.status !== 'running' && task.status !== 'queued') {
      if (startWould) throw new GuardRefusal(toStart);
      throw new GuardRefusal(`The task is ${task.status}; resume continues a task that is running or queued.`);
    }
    if (!started && !task.requeuePending) throw new GuardRefusal(startWould ? toStart : 'No item of this plan has run yet, so there is nothing to resume.');
    if (!next) throw new GuardRefusal('Every item of this plan has run.');
    if (completed.length && prefixHead !== service.store.getSnapshot(identity).head)
      throw new GuardRefusal('The completed plan prefix no longer ends at the current task head; review the changed head before resuming.');
    const unapproved = service.store.unapprovedExecutionItems(identity, service.store.getPlan(identity).revision);
    if (unapproved.length) throw new GuardRefusal(`Approve every plan item before running it. Waiting for: ${unapproved.join(', ')}.`);
    return { fromItem: next, claimRequeue: task.requeuePending, queue: false };
  };
  const offered = (action: 'start' | 'resume', progress: ReturnType<ItemExecutor['progress']>) => {
    try { runChoice(action, true, progress); return true; }
    catch (error) { if (error instanceof GuardRefusal) return false; throw error; }
  };
  /** Reads only task and attempt rows; never rebuilds history or the review. */
  const runnerView = () => {
    const task = service.store.getTask(identity), attempts = service.store.recentAttempts(identity, 20);
    const status = runner?.status(identity) ?? { active: false, stopRequested: null, unresolved: null };
    const last = attempts.find(attempt => attempt.id === task.currentAttemptId);
    const retryable = !!runner && !!last && (last.state === 'failed' || last.state === 'cancelled')
      && (task.status === 'running' || task.status === 'queued') && !task.requeuePending && task.cancelRequested === null
      && !status.active && !status.unresolved && !runner.unreleased && runner.runs(last.kind)
      && sameContext(last.context, service.store.currentContext(identity))
      // A plan item runs again only by resuming its task; the retry action refuses it.
      && !(executor && last.kind === 'execute');
    const free = !!runner && !runner.closing && !status.unresolved && !runner.unreleased;
    // One progress read per poll, shared by both flags.
    const progress = free && executor ? executor.progress(identity) : undefined;
    const checkpoint = service.store.latestCheckpoint(identity);
    let continuation: Record<string, unknown> | null = null;
    if (checkpoint) {
      try {
        const current = service.store.continuationProgress(identity)!;
        continuation = { checkpointId: checkpoint.id, item: checkpoint.item, completedItems: current.completed,
          outOfScopePaths: checkpoint.outOfScopePaths, next: current.next, approved: service.store.continuationApproved(identity, current) };
      } catch (error) {
        continuation = { checkpointId: checkpoint.id, item: checkpoint.item, completedItems: checkpoint.completedItems,
          outOfScopePaths: checkpoint.outOfScopePaths, next: null, approved: false,
          reason: error instanceof Error ? error.message : String(error) };
      }
    }
    const trustBlocked = !!config.github && issues.trustStatus(config.github.issue) === 'blocked';
    return { available: !!runner, task, attempts, startable: !trustBlocked && !!progress && offered('start', progress), resumable: !trustBlocked && !!progress && offered('resume', progress),
      stateVersion: task.stateVersion, reviewVersion: service.store.reviewVersion(identity), retryable, stopRequested: status.stopRequested,
      unresolved: status.unresolved, continuation, publish: publishView(progress, trustBlocked),
      preMerge: { available: !!preMerge, active: preMerge?.active ?? false, last: preMerge?.last ?? null } };
  };
  /** The task's publishing (#103): in progress, offered (what the publish action would run), and the last outcome. */
  const publishView = (progress: ReturnType<ItemExecutor['progress']> | undefined, trustBlocked: boolean) => {
    if (!publishing) return { available: false, active: false, publishable: false, closable: false, draft: false, last: null };
    let job: ReturnType<TaskPublishing['mode']> | null = null;
    try { job = publishing.mode(identity, progress); } catch (error) { if (!(error instanceof GuardRefusal) && !(error instanceof ShuttingDownError)) throw error; }
    // `closable`: the task is cancelled and a close of its PRs is owed (#111): not after one that closed them.
    const last = publishing.lastOutcome(identity);
    return { available: true, active: publishing.busy(identity), publishable: !trustBlocked && job?.kind === 'publish', closable: job?.kind === 'close' && last?.outcome !== 'closed',
      draft: job?.kind === 'publish' && job.draft, last };
  };
  /** A run's outcome is in the task and attempt rows; once it ends, the task's status decides whether a publish is owed. */
  const afterRun = (outcome: Promise<unknown>) => void outcome
    .catch(error => console.error(`Runner run failed: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`))
    .finally(() => {
      if (!publishing || stopping) return;
      publishing.actIfOwed(identity);
    });
  /** A preparation can finish the delayed half of task cancellation; close its PRs only after that settlement. */
  const afterPreMerge = (outcome: Promise<unknown>) => void outcome
    .catch(error => console.error(`Pre-merge preparation failed: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`))
    .finally(() => {
      if (!publishing || stopping || service.store.getTask(identity).status !== 'cancelled') return;
      publishing.taskCancelled(identity);
    });
  const runnerAction = async (input: Record<string, unknown>, signal: AbortSignal) => {
    const { action, attemptId, expectedStateVersion, expectedReviewVersion, actionId } = input;
    // Malformed requests are refused before userAction, so nothing is recorded under their action ID (HTTP 400).
    if (!['cancel-attempt', 'retry', 'cancel-task', 'start', 'resume', 'approve-continuation', 'publish', 'close-pull-requests', 'prepare-merge'].includes(action as string)) throw new BadRequest('Unsupported runner action.');
    if (!Number.isSafeInteger(expectedStateVersion)) throw new BadRequest('expectedStateVersion must be an integer.');
    if ((action === 'start' || action === 'resume' || action === 'approve-continuation' || action === 'prepare-merge') && !Number.isSafeInteger(expectedReviewVersion)) {
      // Actions saved before #107 had no review version in their request hash. They remain replayable, but this shape
      // can never create a new action now: a miss falls through to the new-field validation below.
      const legacy = service.store.savedAction<unknown>(identity, { actionId: actionId as string, kind: action as string,
        request: { attemptId, expectedStateVersion } });
      if (legacy) return legacy.response;
      throw new BadRequest('expectedReviewVersion must be an integer for start, resume, preparation and continuation approval.');
    }
    if (action === 'cancel-attempt' || action === 'retry') assertUuidV4(attemptId, 'Attempt ID');
    const request = { attemptId, expectedStateVersion, ...((action === 'start' || action === 'resume' || action === 'approve-continuation' || action === 'prepare-merge') ? { expectedReviewVersion } : {}) };
    let access: IssueAccess | undefined;
    const trustGated = !!config.github &&
      (((action === 'start' || action === 'resume') && !!executor) ||
        (action === 'approve-continuation' && !!executor) || (action === 'publish' && !!publishing) || (action === 'prepare-merge' && !!preMerge));
    if (trustGated) {
      const replay = service.store.savedAction<unknown>(identity, { actionId: actionId as string, kind: action as string, request });
      if (replay) return replay.response;
      if (stopping || runner?.closing) throw new ShuttingDownError();
      try { access = await readIssueAccess(signal); }
      catch (error) {
        if (stopping || runner?.closing || signal.aborted) throw new ShuttingDownError();
        return service.store.userAction<unknown>(identity, { actionId: actionId as string, kind: action as string, request }, () => { throw error; }).response;
      }
    }
    // A refused start or resume can still move the task to needs human (an expired budget is committed with the refusal),
    // and a task that moves there is owed a draft PR (#103). Only that move publishes: a person who pressed resume on a
    // task already in needs human asked for no publish.
    if (action === 'start' || action === 'resume') {
      const before = service.store.getTask(identity).status;
      try { return act(); } finally { if (service.store.getTask(identity).status !== before) publishing?.actIfOwed(identity, { personAsked: true }); }
    }
    // A final-item scope amendment can finish the plan without another runner attempt; its approval moves the task to
    // running, after which the ordinary publishing gate can open the ready pull request.
    if (action === 'approve-continuation') {
      // A recovered run may already have left the task running. In that case approving removal of its interrupted last
      // item does not change task status, but it does make a ready publish newly possible. Publish only for a newly
      // committed action: a replay or refusal must not restart external work.
      let committed = false;
      try {
        const result = actWithReplayState();
        committed = !result.replayed;
        return result.response;
      } finally {
        if (committed) {
          const task = service.store.getTask(identity);
          const progress = task.status === 'running' ? service.store.continuationProgress(identity) : null;
          if (progress?.next === null && service.store.continuationApproved(identity, progress))
            publishing?.actIfOwed(identity, { personAsked: true });
        }
      }
    }
    // A cancel that closed the task stops its publish in progress and closes its PRs (#111). A cancel that is still
    // stopping an attempt closes the task when the attempt settles; the execution or pre-merge run's end then closes
    // them (afterRun).
    // Only this action's own cancel: a replayed or refused one (the task already closed) starts nothing.
    if (action === 'cancel-task') {
      const before = service.store.getTask(identity).status;
      try { return act(); } finally { if (before !== 'cancelled' && service.store.getTask(identity).status === 'cancelled') publishing?.taskCancelled(identity); }
    }
    // A publish refused because an earlier run owes a pause or an escalation pays it here, outside the refused transaction
    // (AGENTS.md: a refusal's durable change is committed outside it); a task it sends to needs human then gets its draft.
    // Only this action's own refusal for owed work: one for a stale view or a busy task, and any replay (which applies
    // nothing, AGENTS.md), starts nothing.
    if (action === 'publish') {
      let replay: boolean;
      try { replay = !!service.store.savedAction(identity, { actionId: actionId as string, kind: 'publish', request: { attemptId, expectedStateVersion } }); }
      catch { replay = true; }
      try { return act(); }
      catch (error) { if (!replay && error instanceof GuardRefusal && error.message === OWED_REFUSAL) publishing?.actIfOwed(identity, { personAsked: true }); throw error; }
    }
    return act();
    function act() { return actWithReplayState().response; }
    function actWithReplayState() { return service.store.userAction(identity, { actionId: actionId as string, kind: action as string, request }, () => {
      // A saved replay is returned by userAction before this callback. A new continuation approval admitted before
      // shutdown but parsed during the drain must remain retryable, even when no runner exists or its supplied versions
      // are stale.
      if ((action === 'approve-continuation' || action === 'prepare-merge') && (stopping || runner?.closing)) throw new ShuttingDownError();
      if (service.store.getTask(identity).stateVersion !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if ((action === 'start' || action === 'resume' || action === 'approve-continuation' || action === 'prepare-merge') && service.store.reviewVersion(identity) !== expectedReviewVersion)
        throw new GuardRefusal('Stale review state. Reload before writing.');
      if (action === 'cancel-task') {
        const outcome = preMerge?.active
          ? preMerge.cancelTask(expectedStateVersion as number, actionId as string)
          : runner ? runner.cancelTask(identity, expectedStateVersion as number, actionId as string)
            : service.store.cancelTask(identity, expectedStateVersion as number, actionId as string);
        // A push of a rewritten head whose outcome is still unknown holds this cancel at 'stopping'. With no preparation
        // to settle it, read its branch now; clearing the marker closes the task, and then its PRs.
        if (outcome === 'stopping' && preMerge && !preMerge.active && !stopping && service.store.getTask(identity).pushInProgress !== null)
          service.store.afterCommit(() => afterPreMerge(preMerge!.settlePendingPush()));
        return { outcome };
      }
      if (!runner) throw new GuardRefusal(config.demo ? RUNNER_NOT_IN_DEMO : RUNNER_NOT_CONFIGURED);
      if (action === 'prepare-merge') {
        if (access) requireTrustedIssue(access);
        if (!preMerge) throw new GuardRefusal('Pre-merge preparation is not configured.');
        if (runner.isActive(identity) || executor?.busy(identity) || publishing?.busy(identity))
          throw new GuardRefusal('The runner or publisher is busy; pre-merge preparation cannot start yet.');
        preMerge.assertStartable();
        const snapshot = service.store.getSnapshot(identity);
        service.store.afterCommit(() => { afterPreMerge(preMerge!.start({ stateVersion: expectedStateVersion as number,
          reviewVersion: expectedReviewVersion as number, snapshotId: snapshot.id, base: snapshot.base, head: snapshot.head,
          actionId: actionId as string })); });
        return { outcome: 'preparing' };
      }
      if (action === 'approve-continuation') {
        if (access) requireTrustedIssue(access);
        if (!executor || runner.isActive(identity) || executor.busy(identity) || publishing?.busy(identity))
          throw new GuardRefusal('The runner is busy or closing; continuation cannot be approved yet.');
        const progress = service.store.continuationProgress(identity);
        if (!progress) throw new GuardRefusal('This task has no scope checkpoint.');
        if (executor.owes(identity)) throw new GuardRefusal('A scope or safety finding must settle before continuation approval.');
        const task = service.store.getTask(identity), merge = service.store.getMergeAttempt(identity);
        if (!['needs amendment', 'queued', 'running'].includes(task.status) || task.cancelRequested !== null ||
            (merge && (merge.state === 'submitting' || merge.state === 'queued')))
          throw new GuardRefusal('The task status, cancellation or merge state prevents continuation approval.');
        const context = service.planContextAt(progress.head);
        service.store.approveContinuation(identity, progress.checkpoint.id, {
          revision: service.store.getPlan(identity).revision, snapshotId: service.store.getSnapshot(identity).id,
          reviewVersion: expectedReviewVersion as number,
        }, context);
        return { outcome: 'approved', checkpointId: progress.checkpoint.id, next: progress.next };
      }
      if (action === 'start' || action === 'resume') {
        if (access) requireTrustedIssue(access);
        const choice = runChoice(action);
        // In this transaction with the admission: a refused admission rolls the move to queued back with it.
        if (choice.queue) service.store.transitionTask(identity, expectedStateVersion as number, 'queued');
        const begun = executor!.begin(identity, { fromItem: choice.fromItem, claimRequeue: choice.claimRequeue,
          expectedReviewVersion: expectedReviewVersion as number });
        // The run goes on after this request; its outcome is in the task and attempt rows. An error the run throws (storage,
        // a missing snapshot) is only logged, and the next start or resume derives what is owed again. Once it ends, the
        // task's PR is published if the task is finished or needs a person (#103).
        afterRun(begun.outcome);
        return begun.attemptId ? { outcome: 'started', attemptId: begun.attemptId, item: choice.fromItem } : { outcome: 'settled' };
      }
      if (action === 'publish') {
        if (access) requireTrustedIssue(access);
        // Retries a publish that failed or was refused (#103); it runs after this action commits, in the background.
        if (!publishing) throw new GuardRefusal(config.demo ? 'Demos never publish pull requests.' : 'This runner does not publish pull requests.');
        // Replaced by the publish's outcome once it settles (recordPublish), so a replay reports that.
        const job = publishing.request(identity, 'publish', actionId as string);
        return { outcome: 'publishing', draft: job.kind === 'publish' && job.draft };
      }
      if (action === 'close-pull-requests') {
        // Retries closing a cancelled task's PRs (#111) after a failure, a refusal or a stop; in the background, like publish.
        if (!publishing) throw new GuardRefusal(config.demo ? 'Demos never publish pull requests.' : 'This runner does not publish pull requests.');
        publishing.request(identity, 'close', actionId as string);
        return { outcome: 'closing' };
      }
      if (action === 'cancel-attempt') {
        if (!runner.stop(identity, attemptId as string, 'cancelled')) throw new GuardRefusal('That attempt is not running.');
        return { outcome: 'stopping' };
      }
      const last = service.store.getAttempt(identity, attemptId as string);
      // A plan item runs only through the executor, which pauses or escalates after it; a bare retry would skip both.
      if (executor && last.kind === 'execute') throw new GuardRefusal('A plan item is run again by resuming the task, not by retrying its attempt.');
      // Exact-head command checks belong to pre-merge preparation, which refreshes the remote pair, review state and
      // issue authorization before every launch. A bare retry would bypass all of those guards.
      if (last.kind === 'check') throw new GuardRefusal('Command checks are run again by preparing the merge, not by retrying their attempt.');
      const retry = runner.retry(identity, attemptId as string, { expectedStateVersion: expectedStateVersion as number, kind: last.kind, item: last.item,
        expectedContext: service.store.currentContext(identity), deadline: Date.now() + 10 * 60_000 });
      // A cancel that stops this attempt closes the task when it settles; its PRs are closed then (#111), as after a run.
      // Only then: any other settlement asked for no publish, so an owed (refused) one is not started again here.
      void runner.settled(identity).then(() => { if (service.store.getTask(identity).status === 'cancelled') publishing?.actIfOwed(identity); })
        .catch(error => console.error(`Could not start closing pull requests: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`));
      return { outcome: 'started', attemptId: retry.id };
    }); }
  };
  /** Handles of suggestion requests started by this process, removed once their outcome settles. */
  const suggestionHandles = new Map<string, SuggestionHandle>();
  const requireAction = (input: Record<string, unknown>) => { if (input.actionId === undefined) throw new BadRequest('actionId is required for this action.'); return input.actionId as string; };
  const planningAction = async (path: string, input: Record<string, unknown>, signal: AbortSignal) => {
    const actionId = requireAction(input), { actionId: _omit, ...body } = input;
    // Suggestions are edit cards for the current plan; a draft is a whole next revision (#124). They share one lifecycle.
    const imported = path === '/api/plan/import', route = PLANNING_REQUEST.exec(path);
    // The recorded request names the planning request the path acts on, so one action ID cannot replay across two.
    const request = route?.[2] ? { ...body, requestId: route[2] } : body;
    const mode: PlanningMode = route?.[1] === 'drafts' ? 'draft' : 'suggest', noun = mode === 'draft' ? 'draft' : 'suggestion';
    const started = !imported && !route![2];
    const kind = imported ? 'plan-import' : started ? `${noun}-start` : `${noun}-${route![3]}`;
    if (route?.[2]) {
      // Replay first (AGENTS.md): the saved outcome, or saved refusal, under this request's hash.
      try { const saved = service.store.savedAction<unknown>(identity, { actionId, kind, request }); if (saved) return saved.response; }
      catch (error) {
        // A suggestion cancel or apply recorded before #124 hashed the body alone; its replay still returns its outcome.
        // A body carrying a request ID never takes this path, so an older record cannot be aimed at another request.
        if (!(error instanceof ActionIdReused) || mode !== 'suggest' || 'requestId' in body) throw error;
        const legacy = service.store.savedAction<unknown>(identity, { actionId, kind, request: body });
        if (!legacy) throw error;
        return legacy.response;
      }
      // Only the path names the request.
      if ('requestId' in body) throw new BadRequest('The request ID comes from the path, not the body.');
    }
    // The issue comes from GitHub (#117), so it is read before the recorded action, which runs synchronously. A replay
    // returns its saved outcome without reading GitHub again, and a start the recorded action would refuse anyway (no
    // planning, shutdown, stale revision or snapshot) does not read it at all.
    let described: PlanningDescription | undefined;
    if (started) {
      const saved = service.store.savedAction<unknown>(identity, { actionId, kind, request });
      if (saved) return saved.response;
      const plan = service.store.getPlan(identity), snapshot = service.store.getSnapshot(identity);
      if (planning && suggestions && !stopping && input.expectedRevision === plan.revision && input.snapshotId === snapshot.id) {
        try { described = await planning.describe(signal); }
        catch (error) {
          if (stopping) throw new ShuttingDownError();
          const outcome = error instanceof GuardRefusal ? error
            : new UpstreamFailure(`The issue could not be read from GitHub: ${error instanceof Error ? error.message : String(error)}`);
          return service.store.userAction<unknown>(identity, { actionId, kind, request }, () => { throw outcome; }).response;
        }
      }
    }
    return service.store.userAction(identity, { actionId, kind, request }, () => {
      if (imported) {
        if (typeof input.source !== 'string' || !['json', 'yaml'].includes(input.format as string) || !Number.isSafeInteger(input.expectedRevision)) throw new BadRequest('source, format and expectedRevision are required.');
        return { revision: service.store.importRevision(input.source, input.format as 'json' | 'yaml', service.planContextForAmendment(), input.expectedRevision as number).revision };
      }
      if (started) {
        // Like Ask and the runner, no new agent starts once shutdown began; 503 is not recorded, so the UI may resend.
        if (stopping) throw new ShuttingDownError();
        if (!suggestions || !planning) throw new GuardRefusal('Planning agent not available yet.');
        const plan = service.store.getPlan(identity), snapshot = service.store.getSnapshot(identity);
        if (input.expectedRevision !== plan.revision || input.snapshotId !== snapshot.id) throw new GuardRefusal(`Stale plan revision or snapshot. Reload before asking for ${mode === 'draft' ? 'a draft' : 'suggestions'}.`);
        if (typeof input.feedback !== 'string' || input.feedback.length > 4000) throw new BadRequest('feedback must be text of 4000 characters or fewer.');
        // Read above whenever the checks before this line pass; they cannot change across the synchronous action.
        if (!described) throw new GuardRefusal('Planning agent not available yet.');
        const amendment = service.planningContextForAmendment(), context = amendment.context;
        described.validate();
        const handle = suggestions.start({ context, completedItems: amendment.completedItems, continuationBinding: amendment.continuation,
          continuationContext: amendment.continuationContext,
          revision: plan.revision, snapshotId: snapshot.id, issue: described.issue, approvedLessons: described.approvedLessons, feedback: input.feedback,
          repo: { ...described.repo, baseSha: snapshot.base, paths: context.baseEntries.map(entry => entry.path) } }, mode);
        suggestionHandles.set(handle.id, handle);
        void handle.result.finally(() => suggestionHandles.delete(handle.id));
        return { requestId: handle.id };
      }
      const id = route![2]!;
      // An ID is used only on its own kind's routes; an unknown one is named by the route's kind. A storage error is not
      // a refusal, so it is never turned into one (it would be recorded under the action ID).
      if (service.store.requestMode(identity, id) !== mode) throw new Error(`Unknown ${noun} request.`);
      const current = service.store.getSuggestions(identity, id);
      if (route![3] === 'cancel') {
        const handle = suggestionHandles.get(id);
        if (current.state === 'pending' && handle) { handle.cancel('Cancelled by the user.'); return { state: 'cancelling' }; }
        // No handle in this process: the request belonged to a process that ended, and its container's output had no
        // route back to the Store (planning runs only through D, in that process's worker; runner-lifecycle.md).
        service.store.cancelSuggestions(identity, id, 'Cancelled by the user.');
        return { state: service.store.getSuggestions(identity, id).state };
      }
      if (mode === 'draft') return { revision: service.store.applyDraft(identity, id, service.planContextForAmendment()).revision };
      if (!Number.isSafeInteger(input.index)) throw new BadRequest('index is required.');
      return { revision: service.store.applySuggestion(identity, id, input.index as number, service.planContextForAmendment()).revision };
    }).response;
  };
  let stopping = false;
  const activeRequests=new Set<{abort:AbortController;request:IncomingMessage;readingBody:boolean}>();
  const server = createServer(async (req, res) => {
    const requestAbort=new AbortController(),activeRequest={abort:requestAbort,request:req,readingBody:false};activeRequests.add(activeRequest);
    const address = server.address(); const actualPort = address && typeof address !== 'string' ? address.port : port;
    const origin = `http://127.0.0.1:${actualPort}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== `127.0.0.1:${actualPort}` || (req.headers.origin && req.headers.origin !== origin)) { json(403, { error: 'Local origin required.' }); return; }
      const path = new URL(req.url ?? '/', origin).pathname;
      if (path.startsWith('/api/')) {
        const supplied = req.headers['x-codeboost-token'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(403, { error: 'Open the private local URL printed by the CLI.' }); return; }
        if (stopping) { json(503, { error: 'The review server is shutting down.' }); return; }
        if (req.method === 'GET' && path === '/api/settings') { json(200,{questionProvider:service.store.questionProvider()});return; }
        if (req.method === 'GET' && path === '/api/questions') { json(200,{notes:answerStatuses()});return; }
        if (req.method === 'GET' && path === '/api/merge') { if(!merges)throw new Error('Merging is not configured for this review.');json(200,{queue:await merges.pollQueue()});return; }
        if (req.method === 'GET' && path === '/api/issues') { json(200, issues.view()); return; }
        if (req.method === 'GET' && path === '/api/review') { json(200, await load(requestAbort.signal)); return; }
        if (req.method === 'GET' && path === '/api/runner') { json(200, runnerView()); return; }
        const planningRead = /^\/api\/plan\/(suggestions|drafts)\/([0-9a-f-]{36})$/.exec(path);
        if (req.method === 'GET' && planningRead) {
          const id = planningRead[2]!;
          if (planningRead[1] === 'drafts') { json(200, service.store.getDraft(identity, id)); return; }
          const request = service.store.getSuggestions(identity, id);
          if (request.mode !== 'suggest') throw new Error('Unknown suggestion request.');
          json(200, request); return;
        }
        const planningPath = path === '/api/plan/import' || PLANNING_REQUEST.test(path);
        if (req.method !== 'POST' || !(['/api/action','/api/settings','/api/issues','/api/runner'].includes(path) || planningPath) || req.headers['content-type'] !== 'application/json') { json(405, { error: 'Unsupported request.' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        activeRequest.readingBody=true;
        try { for await (const chunk of req) { size += chunk.length; if (size > 16384) { json(413, { error: 'Request too large.' }); return; } chunks.push(chunk); } }
        finally { activeRequest.readingBody=false; }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const input=JSON.parse(body);
        // Admitted requests drain normally (AGENTS.md); only the irreversible merge boundary rechecks the flag.
        if (stopping && input.action === 'merge') { json(503, { error: 'The review server is shutting down.' }); return; }
        if(path==='/api/issues') {
          if (input?.action === 'trust' || input?.action === 'untrust') {
            if (!trustGateway) throw new GuardRefusal('Issue trust actions are not configured.');
            if (!isUuidV4(input.actionId)) throw new BadRequest('An issue trust action needs a UUID v4 actionId.');
            if (!Number.isSafeInteger(input.number) || (input.number as number) < 1) throw new BadRequest('An issue trust action needs a positive issue number.');
            if (input.authorLogin !== null && (typeof input.authorLogin !== 'string' || !(input.authorLogin as string)))
              throw new BadRequest('An issue trust action needs the current author login or null.');
            const kind = `issue-${input.action}`, request = { repository: trustGateway.repository, number: input.number,
              authorLogin: input.authorLogin, action: input.action };
            const saved = service.store.savedAction<unknown>(identity, { actionId: input.actionId, kind, request });
            if (saved) { json(200, issues.view()); return; }
            let access: IssueAccess;
            try { access = await trustGateway.issueAccess(input.number as number, { signal: requestAbort.signal, timeoutMs: 12_000 }); }
            catch (error) {
              if (stopping || requestAbort.signal.aborted) throw new ShuttingDownError();
              const failure = new UpstreamFailure(`The issue author could not be read from GitHub: ${error instanceof Error ? error.message : String(error)}`);
              service.store.userAction(identity, { actionId: input.actionId, kind, request }, () => { throw failure; });
              json(200, issues.view()); return;
            }
            service.store.userAction(identity, { actionId: input.actionId, kind, request }, () => {
              if (access.authorLogin !== input.authorLogin) throw new GuardRefusal('The issue author changed. Refresh before changing trust.');
              service.store.setIssueTrust({ repository: trustGateway.repository, issue: access.number, authorLogin: access.authorLogin,
                trusted: input.action === 'trust', trustedBy: 'local user' });
              return { outcome: input.action === 'trust' ? 'trusted' : 'untrusted', number: access.number };
            });
            json(200, issues.view()); return;
          }
          if(input?.action!=='refresh')throw new Error('Unsupported issue action.');
          await testHooks.beforeIssueRefreshWait?.();
          // A departing browser stops waiting; the board keeps the shared refresh for other callers.
          const departed=new AbortController();
          const depart=()=>{if(!res.writableEnded)departed.abort(new Error('Client disconnected.'));};
          res.once('close',depart);
          // `close` may have fired while the request body was being read, before this listener existed.
          if(res.closed||res.destroyed)depart();
          try { json(200,await issues.refresh(AbortSignal.any([requestAbort.signal,departed.signal]))); }
          finally { res.removeListener('close',depart); }
          return;
        }
        if(path==='/api/runner') { json(200, { result: await runnerAction(input, requestAbort.signal), runner: runnerView() }); return; }
        if(planningPath) { json(200, { result: await planningAction(path, input, requestAbort.signal) }); return; }
        if(path==='/api/settings') {service.store.setQuestionProvider(input.questionProvider);json(200,{questionProvider:service.store.questionProvider()});return;}
        if(input.action==='retry-question') {
          const view=service.load();if(input.token!==view.token)throw new Error('Stale review state. Refresh and retry.');
          questions.start(input.id,view);json(200,await load(requestAbort.signal));return;
        }
        if(input.action==='merge') {
          // Every merge click carries its idempotency key; a request without one would bypass replay.
          if(!isUuidV4(input.actionId)) { json(400,{error:'A merge request needs a UUID v4 actionId.'}); return; }
          if(!merges)throw new Error('Merging is not configured for this review.');
          let merged: Awaited<ReturnType<MergeCoordinator['merge']>>;
          // A merge stopped for a passing reason applied nothing, so answer 503 and the browser resends the same key.
          try { merged=await merges.merge(input.token,input.actionId); }
          catch (error) {
            if (error instanceof MergeNotApplied) { json(503,{error:error.message}); return; }
            // Admitted but unresolved: the browser keeps its key until the attempt ends.
            if (error instanceof MergeOutcomeUnknown) { json(409,{error:error.message,outcomeUnknown:true}); return; }
            throw error;
          }
          try { const mergeQueue=merges.queueSnapshot();json(200,{...loadReview(),merge:{...merged.status,queue:mergeQueue},mergeResult:merged.result,mergeQueue,mergeRefreshRequired:false}); }
          catch { json(200,{mergeResult:merged.result,mergeQueue:null,mergeRefreshRequired:true}); }
          return;
        }
        // Feedback-producing actions need an actionId: the action and its feedback event share one transaction.
        const feedback = input.action==='accept' || input.action==='assign' || (input.action==='note' && input.kind==='change');
        if (feedback) requireAction(input);
        let view: ReturnType<typeof service.act>, replayed = false;
        if (input.actionId !== undefined) {
          const { actionId, ...request } = input;
          const outcome = service.store.userAction(identity, { actionId, kind: `review-${String(input.action).replace(/[^a-z-]/g, '')}`, request }, () => {
            const acted = service.act(input, actionId); return { createdNoteId: acted.createdNoteId ?? null };
          });
          replayed = outcome.replayed;
          view = { ...service.load(), createdNoteId: outcome.response.createdNoteId ?? undefined };
        } else view=service.act(input);
        if(view.createdNoteId && input.kind==='question' && !replayed) {
          try {questions.start(view.createdNoteId,view);} catch(error) {
            // The saved question remains visible and retryable when capacity is reached. If shutdown began while this
            // request was arriving, no agent starts; the question gets a retryable "Server stopped" answer instead.
            if (questions.stopping) questions.markStopped(view.createdNoteId,service.load());
          }
        }
        json(200,await load(requestAbort.signal));return;
      }
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[path];
      if (file) { res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(readFileSync(new URL(file[0], publicRoot))); return; }
      const font = /^\/fonts\/(ibm-plex-(?:sans|mono)-latin-(?:400|500|600)-normal\.woff2)$/.exec(path);
      if (font) {
        const family = font[1]!.startsWith('ibm-plex-sans') ? 'ibm-plex-sans' : 'ibm-plex-mono';
        res.writeHead(200, { 'Content-Type': 'font/woff2' }); res.end(readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/${family}/files/${font[1]}`, import.meta.url)))); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof ShuttingDownError) { json(503, { error: error.message }); return; }
      if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') {
        json(503, { error: error instanceof Error ? error.message : 'Storage failed.', outcomeUnknown: true }); return;
      }
      if (error instanceof BadRequest) { json(400, { error: error.message }); return; }
      if (error instanceof UpstreamFailure) { json(502, { error: error.message }); return; }
      json(409, { error: error instanceof Error ? error.message : 'Review failed.' });
    }
    finally {
      activeRequests.delete(activeRequest);
      // During shutdown a finished request's keep-alive socket would hold server.close() open until its timeout.
      if (stopping) setImmediate(() => server.closeIdleConnections());
    }
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }).catch(error => { service.close(); throw error; });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot determine local address.');
  return { server, service, token, runner, executor, publishing,
    /**
     * Startup (#103): a publish an earlier process owed (a lost opening, a run that ended before its publish completed)
     * runs once, in the background; recovery finds a lost opening by its marker. A publish pushes, so `verifyLock`
     * (the runner lock still names the database) runs first, here: if it throws, nothing starts and its error is thrown.
     * Under the same lock, a push of a rewritten head left unsettled by a crash or shutdown (F6a of #22) is settled by a
     * read of its branch. That can close a task cancelled meanwhile, so it ends like a preparation: its PRs are closed.
     */
    publishOwed: (verifyLock: () => void): void | Promise<void> => {
      verifyLock();
      if (preMerge && !stopping) afterPreMerge(preMerge.settlePendingPush());
      if (!publishing) return;
      publishing.startup(identity);
    },
    url: `http://127.0.0.1:${address.port}/#${token}`, close: async () => {
    // Step 1, one synchronous turn: reject new API requests and new runner work. Admitted requests drain (step 2).
    stopping = true;
    // Same turn as the admission flag: a request already reading its body must not start a new Ask worker.
    questions.stopAdmission();
    runner?.rejectAdmission();
    // Publishes are aborted at once (the publisher already refuses every later push and opening, through the
    // coordinator's flag) and awaited before the write gate closes, so their last records still land (#103).
    const publishingClosed = publishing?.close().then(() => undefined, (error: unknown) => error);
    server.closeIdleConnections();
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closing, new Promise<void>(resolve => { timer=setTimeout(resolve,shutdownDrainMs); })]);
    if(timer)clearTimeout(timer);
    for(const active of activeRequests) {
      const reason=new Error('Request cancelled during shutdown.');
      active.abort.abort(reason);
      if(active.readingBody)active.request.destroy(reason);
    }
    const publishingFailure = await publishingClosed;
    // A conflict resolver records and clears child process ownership directly through the Store. Abort and await the
    // whole pre-merge lifecycle before the write gate closes, so those settlement writes cannot be refused.
    const failures: unknown[] = publishingFailure === undefined ? [] : [publishingFailure];
    const step = async (run: () => Promise<unknown> | unknown) => { try { await run(); } catch (error) { failures.push(error); } };
    await step(() => preMerge?.close());
    // Step 3: after the drain, close the Store write gate. A request-path write still pending after the abort
    // (for example merge reconciliation after a GitHub await) now fails with 503; settling coordinators keep the capability.
    service.store.closeWrites();
    server.closeIdleConnections();
    // Abort the issue refresh now; its close settles without rejecting, so it is always awaited.
    const issuesClosed=issues.close();
    // Every step runs even when an earlier one fails: agents are still stopped, plan runs awaited and the Store closed
    // last. The first failure is reported; a later one never hides it.
    await step(() => merges?.close());
    await step(() => issuesClosed);
    // Step 4: stop runner jobs (shutdown reason only where none is set) and await settlement; no timer abandons a job.
    await step(() => runner?.close());
    // Then every plan run in progress: its pause or escalation after the last attempt is a settlement write (#91).
    await step(() => executor?.close());
    await step(() => closing);
    await step(() => questions.close());
    // E3 aborts every suggestion at once and waits for each to settle. A planning request gets Ask's grace to settle
    // after its abort; then the worker is closed, which abandons one stuck in a synchronous Docker call and so ends it.
    await step(async () => {
      const settled = suggestions?.close();
      if (planning?.close) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (settled) await Promise.race([settled, new Promise(done => { timer = setTimeout(done, PLANNING_SHUTDOWN_GRACE_MS); })]);
        clearTimeout(timer);
        await planning.close();
      }
      await settled;
    });
    await step(() => service.close());
    // Each later failure is still reported, so none is lost behind the first.
    for (const later of failures.slice(1)) console.error(`Shutdown step also failed: ${later instanceof Error ? later.message : String(later)}`);
    if (failures.length) throw failures[0];
  } };
}

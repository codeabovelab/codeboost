import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { Questions, type QuestionAgent } from '../runner/questions.ts';
import { GhMergeGateway, type MergeGateway } from '../github/merge.ts';
import { MERGE_OPERATION_TIMEOUT_MS, MergeCoordinator, MergeNotApplied, MergeOutcomeUnknown } from '../runner/merge.ts';
import { RunnerCoordinator, type RunnerDeps } from '../runner/coordinator.ts';
import { ItemExecutor } from '../runner/execution.ts';
import type { RunnerAssembly } from '../runner/production.ts';
import type { ShutdownCapability } from '../runner/lifecycle.ts';
import { BadRequest, GuardRefusal, ShuttingDownError, assertUuidV4, isUuidV4, sameContext } from '../runner/lifecycle.ts';
import { GhIssueGateway, type IssueGateway } from '../github/issues.ts';
import { demoIssueGateway } from '../scripts/demo-issues.ts';
import { IssueBoard } from './issues.ts';
import { SuggestionCoordinator, type PlanningMode, type SuggestionHandle, type SuggestionInput, type SuggestionStore } from '../core/planning-suggestions.ts';
import type { AuthorProvider } from '../core/planning-author.ts';
import { PLANNING_BUDGET_MS } from '../runner/planning-provider.ts';
export type PlanningDescription = Pick<SuggestionInput, 'issue' | 'approvedLessons'> & { repo: { name: string; baseRef: string } };
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
/** A dependency the server reads from (GitHub) failed: 502, not recorded. */
class UpstreamFailure extends Error {}
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
export async function startServer(config: ReviewConfig, port = 4318, questionAgent?: QuestionAgent, mergeGateway?: MergeGateway, shutdownDrainMs = MAX_SHUTDOWN_DRAIN_MS, issueGateway?: IssueGateway, runnerDeps?: RunnerDeps, planningInput?: PlanningDeps | PlanningSetup, runnerSetup?: RunnerSetup) {
  if (!Number.isSafeInteger(shutdownDrainMs) || shutdownDrainMs < 1 || shutdownDrainMs > MAX_SHUTDOWN_DRAIN_MS) throw new Error('Invalid shutdown drain deadline.');
  const service = new ReviewService(config), token = randomBytes(32).toString('hex');
  let questions: Questions, merges: MergeCoordinator | null, issues: IssueBoard, runner: RunnerCoordinator | null, suggestions: SuggestionCoordinator | null;
  let planning: PlanningDeps | undefined;
  /** Runs a task's plan items; one per Store, like the coordinator. Only the production runner has one. */
  let executor: ItemExecutor | null = null;
  // Only coordinators' settlement and close code receive this; HTTP handlers never do.
  const capability = service.store.shutdownCapability();
  try {
    if (!config.demo && config.github && config.github.issue !== service.store.getPlan(config.identity).issue) throw new Error('The GitHub merge issue must match the stored plan issue.');
    questions=new Questions(service,questionAgent,capability);
    // Issue retrieval is read-only, so demos may show it; they use a local fixture and never contact GitHub.
    issues = new IssueBoard(issueGateway ?? (config.demo ? demoIssueGateway() : config.github ? new GhIssueGateway(config.github.repository) : null),
      'Issue ranking needs a GitHub repository. Add a github block with a repository to the review configuration.');
    merges = !config.demo && (mergeGateway || config.github) ? new MergeCoordinator(service, mergeGateway ?? new GhMergeGateway(config.github!), MERGE_OPERATION_TIMEOUT_MS, capability) : null;
    if (runnerDeps && runnerSetup) throw new Error('Pass runner deps or a runner setup, not both.');
    // Without a runner (no runner block, or a demo), runner actions report that it is not configured.
    runner = runnerDeps ? new RunnerCoordinator(service.store, runnerDeps, undefined, capability) : null;
    // E3's settlement writes (completeSuggestions, settleSuggestion in close()) run with the shutdown capability.
    const store = service.store;
    const suggestionStore: SuggestionStore = {
      getPlan: identity => store.getPlan(identity), getSnapshot: identity => store.getSnapshot(identity),
      beginSuggestions: (identity, expected, mode) => store.beginSuggestions(identity, expected, mode),
      completeSuggestions: (identity, id, reply) => capability.run(() => store.completeSuggestions(identity, id, reply)),
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
      executor = new ItemExecutor(service.store, runner, assembly.sources, assembly.findings, { capability });
    } catch (error) { service.close(); throw error; }
  }
  const loadReview=()=>{const view=service.load();return {...view,notes:view.notes.map(note=>({...note,answerActive:questions.isRunning(note.id)}))};};
  const load=async(signal?:AbortSignal)=>{const view=loadReview();return {...view,merge:merges?await merges.displayStatus(view,signal):{available:false}};};
  const answerStatuses=()=>service.store.getReviewNotes(config.identity)
    .filter(note=>note.kind==='question')
    .map(note=>({id:note.id,answer:note.answer,answerActive:questions.isRunning(note.id)}));
  const identity = config.identity;
  /**
   * What `start` or `resume` would run (#91 part 2), or the refusal. It writes nothing, so the view asks it too and never
   * offers what the action would refuse. `start` runs a task that is in review or queued and has attempted no item of its
   * current plan revision; `resume` continues a running or queued task that attempted an item at any revision (or that
   * recovery left to requeue), from the first item the current revision has not completed, whether its last item
   * completed, failed or was stopped. A queued task with only earlier-revision attempts may take either; both run the
   * same items.
   */
  const runChoice = (action: 'start' | 'resume', forView = false, progress = executor?.progress(identity)) => {
    if (!executor || !progress) throw new GuardRefusal(config.demo ? RUNNER_NOT_IN_DEMO : RUNNER_NOT_CONFIGURED);
    // Shutdown began: answer 503 before any refusal, so nothing is recorded under the action ID and the UI may resend.
    if (!forView && runner!.closing) throw new ShuttingDownError();
    const task = service.store.getTask(identity), { started, begun, earlierCommits, next } = progress;
    // Checked in the order a person can act on: a closed task first, then what admission would refuse.
    if (task.status === 'merged' || task.status === 'cancelled') throw new GuardRefusal(`The task is ${task.status}.`);
    if (task.cancelRequested !== null) throw new GuardRefusal('The task is being cancelled.');
    if (!runner!.runs('execute')) throw new GuardRefusal('The runner cannot run execute attempts yet.');
    if (runner!.isActive(identity)) throw new GuardRefusal('An attempt is already active for this task.');
    // Between two items no attempt is active, but the run that admits the next one is still going.
    if (executor.busy(identity)) throw new GuardRefusal('An earlier run of this task is still finishing; try again when that run has ended.');
    const merge = service.store.getMergeAttempt(identity);
    if (merge && (merge.state === 'submitting' || merge.state === 'queued')) throw new GuardRefusal('A merge is in progress; wait for its outcome.');
    // Only the view stops here: the action lets admission refuse, because its refusal also moves the idle task to needs
    // human (the time-limit mapping), and nothing else would.
    if (forView && task.budgetDeadline !== null && task.budgetDeadline <= Date.now()) throw new GuardRefusal('The task time budget has run out; it needs a person.');
    if (service.store.latestCheckpoint(identity)) throw new GuardRefusal('The task paused for a scope amendment; continuing after one is not supported yet (#88).');
    // Commits an earlier revision's items made have not been reconciled with the revised plan (plan-format.md): rerunning
    // the plan on top of them could redo or contradict that work, so it waits for #88 rather than guessing. Earlier
    // attempts that committed nothing (failed, stopped, stale or unchanged) leave nothing to reconcile.
    if (!begun && earlierCommits) throw new GuardRefusal('The plan was revised after items of it were committed; running a revised plan on top of those commits is not supported yet (#88).');
    if (action === 'start') {
      // Point to resume wherever resume could run (a running task that ran any revision too); any other status is named as it is.
      const ran = begun || task.requeuePending;
      if (next !== null && ((ran && task.status === 'queued') || (task.status === 'running' && (started || task.requeuePending))))
        throw new GuardRefusal('This plan has already started running; resume the task instead.');
      if (task.status !== 'in review' && task.status !== 'queued') throw new GuardRefusal(`The task is ${task.status}; start runs a task that is in review or queued.`);
      if (ran) throw new GuardRefusal(begun ? `This plan revision has already run; the task is ${task.status}.` : 'Recovery left this task to requeue; it cannot start until that is resolved.');
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
    return { available: !!runner, task, attempts, startable: !!progress && offered('start', progress), resumable: !!progress && offered('resume', progress),
      stateVersion: task.stateVersion, retryable, stopRequested: status.stopRequested, unresolved: status.unresolved };
  };
  const runnerAction = (input: Record<string, unknown>) => {
    const { action, attemptId, expectedStateVersion, actionId } = input;
    // Malformed requests are refused before userAction, so nothing is recorded under their action ID (HTTP 400).
    if (!['cancel-attempt', 'retry', 'cancel-task', 'start', 'resume'].includes(action as string)) throw new BadRequest('Unsupported runner action.');
    if (!Number.isSafeInteger(expectedStateVersion)) throw new BadRequest('expectedStateVersion must be an integer.');
    if (action === 'cancel-attempt' || action === 'retry') assertUuidV4(attemptId, 'Attempt ID');
    return service.store.userAction(identity, { actionId: actionId as string, kind: action as string, request: { attemptId, expectedStateVersion } }, () => {
      if (service.store.getTask(identity).stateVersion !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (action === 'cancel-task') return { outcome: runner ? runner.cancelTask(identity, expectedStateVersion as number, actionId as string) : service.store.cancelTask(identity, expectedStateVersion as number, actionId as string) };
      if (!runner) throw new GuardRefusal(config.demo ? RUNNER_NOT_IN_DEMO : RUNNER_NOT_CONFIGURED);
      if (action === 'start' || action === 'resume') {
        const choice = runChoice(action);
        // In this transaction with the admission: a refused admission rolls the move to queued back with it.
        if (choice.queue) service.store.transitionTask(identity, expectedStateVersion as number, 'queued');
        const begun = executor!.begin(identity, { fromItem: choice.fromItem, claimRequeue: choice.claimRequeue });
        // The run goes on after this request; its outcome is in the task and attempt rows. An error the run throws (storage,
        // a missing snapshot) is only logged, and the next start or resume derives what is owed again.
        void begun.outcome.catch(error => console.error(`Runner run failed: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`));
        return begun.attemptId ? { outcome: 'started', attemptId: begun.attemptId, item: choice.fromItem } : { outcome: 'settled' };
      }
      if (action === 'cancel-attempt') {
        if (!runner.stop(identity, attemptId as string, 'cancelled')) throw new GuardRefusal('That attempt is not running.');
        return { outcome: 'stopping' };
      }
      const last = service.store.getAttempt(identity, attemptId as string);
      // A plan item runs only through the executor, which pauses or escalates after it; a bare retry would skip both.
      if (executor && last.kind === 'execute') throw new GuardRefusal('A plan item is run again by resuming the task, not by retrying its attempt.');
      const retry = runner.retry(identity, attemptId as string, { expectedStateVersion: expectedStateVersion as number, kind: last.kind, item: last.item,
        expectedContext: service.store.currentContext(identity), deadline: Date.now() + 10 * 60_000 });
      return { outcome: 'started', attemptId: retry.id };
    }).response;
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
          throw new UpstreamFailure(`The issue could not be read from GitHub: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return service.store.userAction(identity, { actionId, kind, request }, () => {
      if (imported) {
        if (typeof input.source !== 'string' || !['json', 'yaml'].includes(input.format as string) || !Number.isSafeInteger(input.expectedRevision)) throw new BadRequest('source, format and expectedRevision are required.');
        return { revision: service.store.importRevision(input.source, input.format as 'json' | 'yaml', service.planContext(), input.expectedRevision as number).revision };
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
        const context = service.planContext();
        const handle = suggestions.start({ context, revision: plan.revision, snapshotId: snapshot.id, issue: described.issue, approvedLessons: described.approvedLessons, feedback: input.feedback,
          repo: { ...described.repo, baseSha: snapshot.base, paths: context.baseEntries.map(entry => entry.path) } }, mode);
        suggestionHandles.set(handle.id, handle);
        void handle.result.finally(() => suggestionHandles.delete(handle.id));
        return { requestId: handle.id };
      }
      const id = route![2]!;
      // An ID is used only on its own kind's routes; an unknown one is named by the route's kind.
      let current: ReturnType<typeof service.store.getSuggestions>;
      try { current = service.store.getSuggestions(identity, id); } catch { throw new Error(`Unknown ${noun} request.`); }
      if (current.mode !== mode) throw new Error(`Unknown ${noun} request.`);
      if (route![3] === 'cancel') {
        const handle = suggestionHandles.get(id);
        if (current.state === 'pending' && handle) { handle.cancel('Cancelled by the user.'); return { state: 'cancelling' }; }
        // No handle in this process: the request belonged to a process that ended, and its container's output had no
        // route back to the Store (planning runs only through D, in that process's worker; runner-lifecycle.md).
        service.store.cancelSuggestions(identity, id, 'Cancelled by the user.');
        return { state: service.store.getSuggestions(identity, id).state };
      }
      if (mode === 'draft') return { revision: service.store.applyDraft(identity, id, service.planContext()).revision };
      if (!Number.isSafeInteger(input.index)) throw new BadRequest('index is required.');
      return { revision: service.store.applySuggestion(identity, id, input.index as number, service.planContext()).revision };
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
          if(input?.action!=='refresh')throw new Error('Unsupported issue action.');
          // A departing browser stops waiting; the board keeps the shared refresh for other callers.
          const departed=new AbortController();
          const depart=()=>{if(!res.writableEnded)departed.abort(new Error('Client disconnected.'));};
          res.once('close',depart);
          try { json(200,await issues.refresh(AbortSignal.any([requestAbort.signal,departed.signal]))); }
          finally { res.removeListener('close',depart); }
          return;
        }
        if(path==='/api/runner') { json(200, { result: runnerAction(input), runner: runnerView() }); return; }
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
  return { server, service, token, runner, executor, url: `http://127.0.0.1:${address.port}/#${token}`, close: async () => {
    // Step 1, one synchronous turn: reject new API requests and new runner work. Admitted requests drain (step 2).
    stopping = true;
    // Same turn as the admission flag: a request already reading its body must not start a new Ask worker.
    questions.stopAdmission();
    runner?.rejectAdmission();
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
    // Step 3: after the drain, close the Store write gate. A request-path write still pending after the abort
    // (for example merge reconciliation after a GitHub await) now fails with 503; settling coordinators keep the capability.
    service.store.closeWrites();
    server.closeIdleConnections();
    // Abort the issue refresh now; its close settles without rejecting, so it is always awaited.
    const issuesClosed=issues.close();
    // Every step runs even when an earlier one fails: agents are still stopped, plan runs awaited and the Store closed
    // last. The first failure is reported; a later one never hides it.
    const failures: unknown[] = [];
    const step = async (run: () => Promise<unknown> | unknown) => { try { await run(); } catch (error) { failures.push(error); } };
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

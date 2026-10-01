import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { Questions, type QuestionAgent } from '../runner/questions.ts';
import { GhMergeGateway, type MergeGateway } from '../github/merge.ts';
import { MERGE_OPERATION_TIMEOUT_MS, MergeCoordinator, MergeNotApplied, MergeOutcomeUnknown } from '../runner/merge.ts';
import { RunnerCoordinator, type RunnerDeps } from '../runner/coordinator.ts';
import { BadRequest, GuardRefusal, ShuttingDownError, assertUuidV4, isUuidV4, sameContext } from '../runner/lifecycle.ts';
import { GhIssueGateway, type IssueGateway } from '../github/issues.ts';
import { demoIssueGateway } from '../scripts/demo-issues.ts';
import { IssueBoard } from './issues.ts';
import { SuggestionCoordinator, type SuggestionHandle, type SuggestionInput, type SuggestionStore } from '../core/planning-suggestions.ts';
import type { AuthorProvider } from '../core/planning-author.ts';
/** Live planning runs only through D (G4 after #51). Until a provider is injected, starting a suggestion is refused. */
export interface PlanningDeps {
  provider: AuthorProvider;
  /** Trusted repository, issue and approved-lesson inputs for a suggestion request. */
  describe(): Pick<SuggestionInput, 'issue' | 'approvedLessons'> & { repo: { name: string; baseRef: string } };
}
const publicRoot = new URL('./public/', import.meta.url);
/** The longest shutdown waits for admitted requests to finish before aborting them; below the 15 s request timeout. */
export const MAX_SHUTDOWN_DRAIN_MS = 14_500;
export async function startServer(config: ReviewConfig, port = 4318, questionAgent?: QuestionAgent, mergeGateway?: MergeGateway, shutdownDrainMs = MAX_SHUTDOWN_DRAIN_MS, issueGateway?: IssueGateway, runnerDeps?: RunnerDeps, planning?: PlanningDeps) {
  if (!Number.isSafeInteger(shutdownDrainMs) || shutdownDrainMs < 1 || shutdownDrainMs > MAX_SHUTDOWN_DRAIN_MS) throw new Error('Invalid shutdown drain deadline.');
  const service = new ReviewService(config), token = randomBytes(32).toString('hex');
  let questions: Questions, merges: MergeCoordinator | null, issues: IssueBoard, runner: RunnerCoordinator | null, suggestions: SuggestionCoordinator | null;
  // Only coordinators' settlement and close code receive this; HTTP handlers never do.
  const capability = service.store.shutdownCapability();
  try {
    if (!config.demo && config.github && config.github.issue !== service.store.getPlan(config.identity).issue) throw new Error('The GitHub merge issue must match the stored plan issue.');
    questions=new Questions(service,questionAgent,capability);
    // Issue retrieval is read-only, so demos may show it; they use a local fixture and never contact GitHub.
    issues = new IssueBoard(issueGateway ?? (config.demo ? demoIssueGateway() : config.github ? new GhIssueGateway(config.github.repository) : null),
      'Issue ranking needs a GitHub repository. Add a github block with a repository to the review configuration.');
    merges = !config.demo && (mergeGateway || config.github) ? new MergeCoordinator(service, mergeGateway ?? new GhMergeGateway(config.github!), MERGE_OPERATION_TIMEOUT_MS, capability) : null;
    // The runner starts only with an injected D; until #51 lands, runner actions report that it is unavailable.
    runner = runnerDeps ? new RunnerCoordinator(service.store, runnerDeps, undefined, capability) : null;
    // E3's settlement writes (completeSuggestions, settleSuggestion in close()) run with the shutdown capability.
    const store = service.store;
    const suggestionStore: SuggestionStore = {
      getPlan: identity => store.getPlan(identity), getSnapshot: identity => store.getSnapshot(identity),
      beginSuggestions: (identity, expected) => store.beginSuggestions(identity, expected),
      completeSuggestions: (identity, id, reply) => capability.run(() => store.completeSuggestions(identity, id, reply)),
      settleSuggestion: (identity, id, expected, outcome) => capability.run(() => store.settleSuggestion(identity, id, expected, outcome)),
      getSuggestions: (identity, id) => store.getSuggestions(identity, id),
    };
    suggestions = planning ? new SuggestionCoordinator(suggestionStore, planning.provider) : null;
  } catch (error) { service.close(); throw error; }
  const loadReview=()=>{const view=service.load();return {...view,notes:view.notes.map(note=>({...note,answerActive:questions.isRunning(note.id)}))};};
  const load=async(signal?:AbortSignal)=>{const view=loadReview();return {...view,merge:merges?await merges.displayStatus(view,signal):{available:false}};};
  const answerStatuses=()=>service.store.getReviewNotes(config.identity)
    .filter(note=>note.kind==='question')
    .map(note=>({id:note.id,answer:note.answer,answerActive:questions.isRunning(note.id)}));
  const identity = config.identity;
  /** Reads only task and attempt rows; never rebuilds history or the review. */
  const runnerView = () => {
    const task = service.store.getTask(identity), attempts = service.store.recentAttempts(identity, 20);
    const status = runner?.status(identity) ?? { active: false, stopRequested: null, unresolved: null };
    const last = attempts.find(attempt => attempt.id === task.currentAttemptId);
    const retryable = !!runner && !!last && (last.state === 'failed' || last.state === 'cancelled')
      && (task.status === 'running' || task.status === 'queued') && !task.requeuePending && task.cancelRequested === null
      && !status.active && !status.unresolved && sameContext(last.context, service.store.currentContext(identity));
    return { available: !!runner, task, attempts,
      stateVersion: task.stateVersion, retryable, stopRequested: status.stopRequested, unresolved: status.unresolved };
  };
  const runnerAction = (input: Record<string, unknown>) => {
    const { action, attemptId, expectedStateVersion, actionId } = input;
    // Malformed requests are refused before userAction, so nothing is recorded under their action ID (HTTP 400).
    if (!['cancel-attempt', 'retry', 'cancel-task'].includes(action as string)) throw new BadRequest('Unsupported runner action.');
    if (!Number.isSafeInteger(expectedStateVersion)) throw new BadRequest('expectedStateVersion must be an integer.');
    if (action !== 'cancel-task') assertUuidV4(attemptId, 'Attempt ID');
    return service.store.userAction(identity, { actionId: actionId as string, kind: action as string, request: { attemptId, expectedStateVersion } }, () => {
      if (service.store.getTask(identity).stateVersion !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (action === 'cancel-task') return { outcome: runner ? runner.cancelTask(identity, expectedStateVersion as number, actionId as string) : service.store.cancelTask(identity, expectedStateVersion as number, actionId as string) };
      if (!runner) throw new GuardRefusal('The runner is not available yet.');
      if (action === 'cancel-attempt') {
        if (!runner.stop(identity, attemptId as string, 'cancelled')) throw new GuardRefusal('That attempt is not running.');
        return { outcome: 'stopping' };
      }
      const last = service.store.getAttempt(identity, attemptId as string);
      const retry = runner.retry(identity, attemptId as string, { expectedStateVersion: expectedStateVersion as number, kind: last.kind, item: last.item,
        expectedContext: service.store.currentContext(identity), deadline: Date.now() + 10 * 60_000 });
      return { outcome: 'started', attemptId: retry.id };
    }).response;
  };
  /** Handles of suggestion requests started by this process, removed once their outcome settles. */
  const suggestionHandles = new Map<string, SuggestionHandle>();
  const requireAction = (input: Record<string, unknown>) => { if (input.actionId === undefined) throw new BadRequest('actionId is required for this action.'); return input.actionId as string; };
  const planningAction = (path: string, input: Record<string, unknown>) => {
    const actionId = requireAction(input), { actionId: _omit, ...request } = input;
    const imported = path === '/api/plan/import', started = path === '/api/plan/suggestions';
    const match = /^\/api\/plan\/suggestions\/([0-9a-f-]{36})\/(cancel|apply)$/.exec(path);
    const kind = imported ? 'plan-import' : started ? 'suggestion-start' : `suggestion-${match![2]}`;
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
        if (input.expectedRevision !== plan.revision || input.snapshotId !== snapshot.id) throw new GuardRefusal('Stale plan revision or snapshot. Reload before asking for suggestions.');
        if (typeof input.feedback !== 'string' || input.feedback.length > 4000) throw new BadRequest('feedback must be text of 4000 characters or fewer.');
        const context = service.planContext(), described = planning.describe();
        const handle = suggestions.start({ context, revision: plan.revision, snapshotId: snapshot.id, issue: described.issue, approvedLessons: described.approvedLessons, feedback: input.feedback,
          repo: { ...described.repo, baseSha: snapshot.base, paths: context.baseEntries.map(entry => entry.path) } });
        suggestionHandles.set(handle.id, handle);
        void handle.result.finally(() => suggestionHandles.delete(handle.id));
        return { requestId: handle.id };
      }
      const id = match![1]!;
      if (match![2] === 'cancel') {
        const handle = suggestionHandles.get(id), current = service.store.getSuggestions(identity, id);
        if (current.state === 'pending' && handle) { handle.cancel('Cancelled by the user.'); return { state: 'cancelling' }; }
        // No handle in this process: startup recovery has already stopped any provider (planning runs only through D).
        service.store.cancelSuggestions(identity, id, 'Cancelled by the user.');
        return { state: service.store.getSuggestions(identity, id).state };
      }
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
        const suggestionRead = /^\/api\/plan\/suggestions\/([0-9a-f-]{36})$/.exec(path);
        if (req.method === 'GET' && suggestionRead) { json(200, service.store.getSuggestions(identity, suggestionRead[1]!)); return; }
        const planningPath = path === '/api/plan/import' || path === '/api/plan/suggestions' || /^\/api\/plan\/suggestions\/[0-9a-f-]{36}\/(cancel|apply)$/.test(path);
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
        if(planningPath) { json(200, { result: planningAction(path, input) }); return; }
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
  return { server, service, token, runner, url: `http://127.0.0.1:${address.port}/#${token}`, close: async () => {
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
    try { await merges?.close(); } finally { await issuesClosed; }
    // Step 4: stop runner jobs (shutdown reason only where none is set) and await settlement; no timer abandons a job.
    await runner?.close();
    await closing;
    // Close the store even if Ask's or planning's cleanup fails, then report that failure.
    try { await questions.close(); } finally { try { await suggestions?.close(); } finally { service.close(); } }
  } };
}

import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
import { Questions, type QuestionAgent } from '../runner/questions.ts';
import { GhMergeGateway, type MergeGateway } from '../github/merge.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { RunnerCoordinator, type RunnerDeps } from '../runner/coordinator.ts';
import { BadRequest, GuardRefusal, ShuttingDownError, sameContext } from '../runner/lifecycle.ts';
const publicRoot = new URL('./public/', import.meta.url);
export async function startServer(config: ReviewConfig, port = 4318, questionAgent?: QuestionAgent, mergeGateway?: MergeGateway, shutdownDrainMs = 14_500, runnerDeps?: RunnerDeps) {
  if (!Number.isSafeInteger(shutdownDrainMs) || shutdownDrainMs < 1 || shutdownDrainMs > 14_500) throw new Error('Invalid shutdown drain deadline.');
  const service = new ReviewService(config), token = randomBytes(32).toString('hex');
  let questions: Questions, merges: MergeCoordinator | null, runner: RunnerCoordinator | null;
  // Only coordinators' settlement and close code receive this; HTTP handlers never do.
  const capability = service.store.shutdownCapability();
  try {
    if (!config.demo && config.github && config.github.issue !== service.store.getPlan(config.identity).issue) throw new Error('The GitHub merge issue must match the stored plan issue.');
    questions=new Questions(service,questionAgent,capability);
    merges = !config.demo && (mergeGateway || config.github) ? new MergeCoordinator(service, mergeGateway ?? new GhMergeGateway(config.github!), 14_000, capability) : null;
    // The runner starts only with an injected D; until #51 lands, runner actions report that it is unavailable.
    runner = runnerDeps ? new RunnerCoordinator(service.store, runnerDeps, undefined, capability) : null;
  } catch (error) { service.close(); throw error; }
  const loadReview=()=>{const view=service.load();return {...view,notes:view.notes.map(note=>({...note,answerActive:questions.isRunning(note.id)}))};};
  const load=async(signal?:AbortSignal)=>{const view=loadReview();return {...view,merge:merges?await merges.displayStatus(view,signal):{available:false}};};
  const answerStatuses=()=>service.store.getReviewNotes(config.identity)
    .filter(note=>note.kind==='question')
    .map(note=>({id:note.id,answer:note.answer,answerActive:questions.isRunning(note.id)}));
  const identity = config.identity;
  /** Reads only task and attempt rows; never rebuilds history or the review. */
  const runnerView = () => {
    const task = service.store.getTask(identity), attempts = service.store.getAttempts(identity).slice(-20);
    const status = runner?.status(identity) ?? { active: false, stopRequested: null, unresolved: null };
    const last = attempts.find(attempt => attempt.id === task.currentAttemptId);
    const retryable = !!runner && !!last && (last.state === 'failed' || last.state === 'cancelled')
      && (task.status === 'running' || task.status === 'queued') && !task.requeuePending && task.cancelRequested === null
      && !status.active && !status.unresolved && sameContext(last.context, service.store.currentContext(identity));
    return { available: !!runner, task, attempts: attempts.map(({ result, ...attempt }) => ({ ...attempt, hasResult: result !== null })),
      stateVersion: task.stateVersion, retryable, stopRequested: status.stopRequested, unresolved: status.unresolved };
  };
  const runnerAction = (input: Record<string, unknown>) => {
    const { action, attemptId, expectedStateVersion, actionId } = input;
    if (!['cancel-attempt', 'retry', 'cancel-task'].includes(action as string)) throw new GuardRefusal('Unsupported runner action.');
    if (!Number.isSafeInteger(expectedStateVersion)) throw new GuardRefusal('expectedStateVersion is required.');
    return service.store.userAction(identity, { actionId: actionId as string, kind: action as string, request: { attemptId, expectedStateVersion } }, () => {
      if (service.store.getTask(identity).stateVersion !== expectedStateVersion) throw new GuardRefusal('Stale task state. Reload before writing.');
      if (action === 'cancel-task') return { outcome: runner ? runner.cancelTask(identity, expectedStateVersion as number, actionId as string) : service.store.cancelTask(identity, expectedStateVersion as number, actionId as string) };
      if (!runner) throw new GuardRefusal('The runner is not available yet.');
      if (typeof attemptId !== 'string') throw new GuardRefusal('attemptId is required.');
      if (action === 'cancel-attempt') {
        if (!runner.stop(identity, attemptId, 'cancelled')) throw new GuardRefusal('That attempt is not running.');
        return { outcome: 'stopping' };
      }
      const last = service.store.getAttempt(identity, attemptId);
      const retry = runner.retry(identity, attemptId, { expectedStateVersion: expectedStateVersion as number, kind: last.kind, item: last.item,
        expectedContext: service.store.currentContext(identity), deadline: Date.now() + 10 * 60_000 });
      return { outcome: 'started', attemptId: retry.id };
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
        if (req.method === 'GET' && path === '/api/review') { json(200, await load(requestAbort.signal)); return; }
        if (req.method === 'GET' && path === '/api/runner') { json(200, runnerView()); return; }
        if (req.method !== 'POST' || !['/api/action','/api/settings','/api/runner'].includes(path) || req.headers['content-type'] !== 'application/json') { json(405, { error: 'Unsupported request.' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        activeRequest.readingBody=true;
        try { for await (const chunk of req) { size += chunk.length; if (size > 16384) { json(413, { error: 'Request too large.' }); return; } chunks.push(chunk); } }
        finally { activeRequest.readingBody=false; }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const input=JSON.parse(body);
        // Admitted requests drain normally (AGENTS.md); only the irreversible merge boundary rechecks the flag.
        if (stopping && input.action === 'merge') { json(503, { error: 'The review server is shutting down.' }); return; }
        if(path==='/api/runner') { json(200, { result: runnerAction(input), runner: runnerView() }); return; }
        if(path==='/api/settings') {service.store.setQuestionProvider(input.questionProvider);json(200,{questionProvider:service.store.questionProvider()});return;}
        if(input.action==='retry-question') {
          const view=service.load();if(input.token!==view.token)throw new Error('Stale review state. Refresh and retry.');
          questions.start(input.id,view);json(200,await load(requestAbort.signal));return;
        }
        if(input.action==='merge') {
          if(!merges)throw new Error('Merging is not configured for this review.');
          const merged=await merges.merge(input.token);
          try { const mergeQueue=merges.queueSnapshot();json(200,{...loadReview(),merge:{...merged.status,queue:mergeQueue},mergeResult:merged.result,mergeQueue,mergeRefreshRequired:false}); }
          catch { json(200,{mergeResult:merged.result,mergeQueue:null,mergeRefreshRequired:true}); }
          return;
        }
        const view=service.act(input);
        if(view.createdNoteId && input.kind==='question') {
          try {questions.start(view.createdNoteId,view);} catch(error) {
            // The saved question remains visible and retryable when capacity is reached.
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
    await merges?.close();
    // Step 4: stop runner jobs (shutdown reason only where none is set) and await settlement; no timer abandons a job.
    await runner?.close();
    await closing;
    await questions.close();
    service.close();
  } };
}

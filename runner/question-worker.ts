import { parentPort, workerData } from 'node:worker_threads';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { captureInvocation } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { askInContainer, measureGitRepository, recoverAskOwner, recoverQuestionStorage, RetainedStorage, runReadOnlyAgent, StopError, type ContainerDependencies, type ContainerQuestion, type ReadOnlyRun } from './question-container.ts';
import { PLANNING_FEATURE, PlanningStorage } from './planning-provider.ts';
import { ASK_NAMING, PLANNING_NAMING } from './question-leftovers.ts';

// Lane D's image build, clone and storage allocation are synchronous (Docker and Git calls), so they run here instead of blocking the review server.
// Its trust registries (built image, clones, allocations, captured invocations) live in this worker's modules.
// One worker serves one feature, named in workerData: Ask's worker runs only questions, planning's only plans (#117).
export type WorkerFeature = 'questions' | 'planning';
export type WorkerRequest = { type: 'ask'; id: string; question: ContainerQuestion } | { type: 'plan'; id: string; run: ReadOnlyRun }
  | { type: 'cancel'; id: string; reason: string; stop: StopError['stop'] }
  | { type: 'release'; id: string } | { type: 'recover'; id: string; runnerOwner: string };
export type WorkerReply = { id: string; attemptId: string; ok: true; text: string } | { id: string; attemptId: string; ok: false; error: string };
/** Reply to `release`: how many allocations and failed setups are still not removed after a final attempt. */
export type ReleaseReply = { id: string; remaining: number };
/** Reply to `recover`: `error` is the reason Ask stays off; without it, recovery finished. */
export type RecoverReply = { id: string; recovery: 'done' | 'failed'; error?: string };


// This worker's environment is an allowlist without credentials; the credential variables arrive as data and go
// only to the adapters.
const credentials: Readonly<Record<string, string | undefined>> = Object.freeze({ ...(workerData?.credentials ?? {}) });
const feature: WorkerFeature = workerData?.feature === 'planning' ? 'planning' : 'questions';
const deps: ContainerDependencies = {
  buildImage: buildAgentImage,
  createClone: createTaskClone,
  prepareFilesystems: prepareTaskFilesystems,
  removeFilesystems: removeTaskFilesystems,
  recover: recoverAskOwner,
  measureRepository: measureGitRepository,
  capture: input => captureInvocation(input),
  startClaude: startClaudeInvocation,
  env: credentials,
};
const image: { id?: string } = {};
const retained = feature === 'planning' ? new PlanningStorage() : new RetainedStorage();
const active = new Map<string, AbortController>();

parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') { active.get(message.id)?.abort(new StopError(message.reason, message.stop)); return; }
  if (message.type === 'release') {
    // Shutdown: one last removal attempt, then report how much is still owned. The next process's recovery removes it.
    try { retained.release(deps.removeFilesystems); } catch { /* reported below */ }
    parentPort!.postMessage({ id: message.id, remaining: retained.size + retained.untracked } satisfies ReleaseReply);
    return;
  }
  if (message.type === 'recover') {
    void recoverQuestionStorage(message.runnerOwner, deps, retained, feature === 'planning' ? PLANNING_NAMING : ASK_NAMING).then(
      () => parentPort!.postMessage({ id: message.id, recovery: 'done' } satisfies RecoverReply),
      (error: unknown) => parentPort!.postMessage({ id: message.id, recovery: 'failed',
        error: error instanceof Error ? error.message : 'Recovery failed.' } satisfies RecoverReply));
    return;
  }
  const controller = new AbortController(), id = message.id;
  // A worker runs only its own feature's jobs, with that feature's leftovers and owner.
  const attemptId = message.type === 'ask' ? message.question.attemptId : message.run.attemptId;
  const refused = (message.type === 'ask') !== (feature === 'questions');
  active.set(id, controller);
  const run = () => refused ? Promise.reject(new Error(`This worker does not run ${message.type === 'ask' ? 'questions' : 'plans'}.`))
    : message.type === 'ask' ? askInContainer(message.question, deps, controller.signal, image, retained)
    : runReadOnlyAgent(PLANNING_FEATURE, message.run, deps, controller.signal, image, retained);
  // Defer so a cancel posted with the request is delivered before synchronous setup starts.
  setImmediate(() => void run().then(
    text => parentPort!.postMessage({ id, attemptId, ok: true, text } satisfies WorkerReply),
    (error: unknown) => parentPort!.postMessage({ id, attemptId, ok: false,
      error: controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message
        : error instanceof Error ? error.message : 'Agent failed.' } satisfies WorkerReply),
  ).finally(() => active.delete(id)));
});

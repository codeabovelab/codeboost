import { parentPort, workerData } from 'node:worker_threads';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { startCodexInvocation } from '../agents/adapters/codex.ts';
import { captureInvocation } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { recoverLeftovers } from '../agents/recovery.ts';
import { createTaskClone } from '../git/clone.ts';
import { askInContainer, measureGitRepository, recoverQuestionStorage, RetainedStorage, StopError, type ContainerDependencies, type ContainerQuestion } from './question-container.ts';

// Lane D's image build, clone and storage allocation are synchronous (Docker and Git calls), so they run here instead of blocking the review server.
// Its trust registries (built image, clones, allocations, captured invocations) live in this worker's modules.
export type WorkerRequest = { type: 'ask'; id: string; question: ContainerQuestion } | { type: 'cancel'; id: string; reason: string; stop: StopError['stop'] }
  | { type: 'release'; id: string } | { type: 'recover'; id: string; runnerOwner: string };
export type WorkerReply = { id: string; attemptId: string; ok: true; text: string } | { id: string; attemptId: string; ok: false; error: string };
/** Reply to `release`: how many allocations and failed setups are still not removed after a final attempt. */
export type ReleaseReply = { id: string; remaining: number };
/** Reply to `recover`: `error` is the reason Ask stays off; without it, recovery finished. */
export type RecoverReply = { id: string; recovery: 'done' | 'failed'; error?: string };
// Bounds lane D's recovery, which otherwise allows two minutes; the first question waits for it. Recovery skips
// the daemon-wide search for objects without an owner, so other reviews' objects never reach it (#65).
const RECOVERY_TIMEOUT_MS = 60_000;

// This worker's environment is an allowlist without credentials; the credential variables arrive as data and go
// only to the adapters.
const credentials: Readonly<Record<string, string | undefined>> = Object.freeze({ ...(workerData?.credentials ?? {}) });
const deps: ContainerDependencies = {
  buildImage: buildAgentImage,
  createClone: createTaskClone,
  prepareFilesystems: prepareTaskFilesystems,
  removeFilesystems: removeTaskFilesystems,
  recover: runnerOwner => recoverLeftovers(runnerOwner, RECOVERY_TIMEOUT_MS, { unowned: false }),
  measureRepository: measureGitRepository,
  capture: input => captureInvocation(input),
  startClaude: startClaudeInvocation,
  startCodex: startCodexInvocation,
  env: credentials,
};
const image: { id?: string } = {};
const retained = new RetainedStorage();
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
    void recoverQuestionStorage(message.runnerOwner, deps, retained).then(
      () => parentPort!.postMessage({ id: message.id, recovery: 'done' } satisfies RecoverReply),
      (error: unknown) => parentPort!.postMessage({ id: message.id, recovery: 'failed',
        error: error instanceof Error ? error.message : 'Recovery failed.' } satisfies RecoverReply));
    return;
  }
  const controller = new AbortController();
  active.set(message.id, controller);
  // Defer so a cancel posted with the request is delivered before synchronous setup starts.
  setImmediate(() => void askInContainer(message.question, deps, controller.signal, image, retained).then(
    text => parentPort!.postMessage({ id: message.id, attemptId: message.question.attemptId, ok: true, text } satisfies WorkerReply),
    (error: unknown) => parentPort!.postMessage({ id: message.id, attemptId: message.question.attemptId, ok: false,
      error: controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message
        : error instanceof Error ? error.message : 'Agent failed.' } satisfies WorkerReply),
  ).finally(() => active.delete(message.id)));
});

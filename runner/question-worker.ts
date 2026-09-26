import { parentPort } from 'node:worker_threads';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { startCodexInvocation } from '../agents/adapters/codex.ts';
import { captureInvocation } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { askInContainer, RetainedStorage, type ContainerDependencies, type ContainerQuestion } from './question-container.ts';
import type { Leftover } from './question-leftovers.ts';

// Lane D setup is synchronous (Docker and Git calls), so it runs here instead of blocking the review server.
// Its trust registries (built image, clones, allocations, captured invocations) live in this worker's modules.
export type WorkerRequest = { type: 'ask'; id: string; question: ContainerQuestion } | { type: 'cancel'; id: string; reason: string }
  | { type: 'release'; id: string };
export type WorkerReply = { id: string; attemptId: string; ok: true; text: string } | { id: string; attemptId: string; ok: false; error: string };
/** Reply to `release`: allocations still not removed after a final attempt. */
export type ReleaseReply = { id: string; remaining: Leftover[] };

const deps: ContainerDependencies = {
  buildImage: buildAgentImage,
  createClone: createTaskClone,
  prepareFilesystems: prepareTaskFilesystems,
  removeFilesystems: removeTaskFilesystems,
  capture: input => captureInvocation(input),
  startClaude: startClaudeInvocation,
  startCodex: startCodexInvocation,
  env: process.env,
};
const image: { id?: string } = {};
const retained = new RetainedStorage();
const active = new Map<string, AbortController>();

parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') { active.get(message.id)?.abort(new Error(message.reason)); return; }
  if (message.type === 'release') {
    // Shutdown: one last removal attempt, then report what is still owned so it can be recorded durably.
    try { retained.release(deps.removeFilesystems); } catch { /* reported below */ }
    parentPort!.postMessage({ id: message.id, remaining: retained.list() } satisfies ReleaseReply);
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

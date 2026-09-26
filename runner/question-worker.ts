import { parentPort } from 'node:worker_threads';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { startCodexInvocation } from '../agents/adapters/codex.ts';
import { captureInvocation } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { askInContainer, type ContainerDependencies, type ContainerQuestion } from './question-container.ts';

// Lane D setup is synchronous (Docker and Git calls), so it runs here instead of blocking the review server.
// Its trust registries (built image, clones, allocations, captured invocations) live in this worker's modules.
export type WorkerRequest = { type: 'ask'; id: string; question: ContainerQuestion } | { type: 'cancel'; id: string; reason: string };
export type WorkerReply = { id: string; ok: true; text: string } | { id: string; ok: false; error: string };

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
const active = new Map<string, AbortController>();

parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') { active.get(message.id)?.abort(new Error(message.reason)); return; }
  const controller = new AbortController();
  active.set(message.id, controller);
  // Defer so a cancel posted with the request is delivered before synchronous setup starts.
  setImmediate(() => void askInContainer(message.question, deps, controller.signal, image).then(
    text => parentPort!.postMessage({ id: message.id, ok: true, text } satisfies WorkerReply),
    (error: unknown) => parentPort!.postMessage({ id: message.id, ok: false,
      error: controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message
        : error instanceof Error ? error.message : 'Agent failed.' } satisfies WorkerReply),
  ).finally(() => active.delete(message.id)));
});

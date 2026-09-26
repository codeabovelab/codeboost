import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { QuestionAgent } from './questions.ts';
import type { Provider } from './question-container.ts';
import type { WorkerReply, WorkerRequest } from './question-worker.ts';
export type { Provider } from './question-container.ts';

// Leave the worker time to cancel the container and release storage before the review's own timeout fires.
const SETTLE_MARGIN_MS = 5_000;

/** One worker owns every Ask container, so lane D's trusted image and allocations stay in one registry. */
export class QuestionWorker {
  private worker?: Worker;
  private pending = new Map<string, { attemptId: string; resolve: (text: string) => void; reject: (error: Error) => void }>();
  // Set when the worker dies. Its containers and storage may still exist, and nothing in this process can reclaim
  // them until lane D's scoped recovery exists (#51), so Ask stays off rather than starting a replacement worker.
  private crashed?: Error;
  private url: URL;
  constructor(url = new URL('./question-worker.ts', import.meta.url)) { this.url = url; }
  private start(): Worker {
    if (this.crashed) throw this.crashed;
    if (this.worker) return this.worker;
    const worker = new Worker(this.url);
    worker.on('message', (reply: WorkerReply) => {
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if (reply.attemptId !== job.attemptId) job.reject(new Error('The agent returned a result for a different question attempt.'));
      else if (reply.ok) job.resolve(reply.text); else job.reject(new Error(reply.error));
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.crashed = new Error(`The agent container worker stopped (${error.message}). Its containers and storage may still exist, so Ask is off until codeboost restarts. Check \`docker ps -a\` and \`docker volume ls\` before restarting.`);
      for (const job of this.pending.values()) job.reject(this.crashed);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`exit code ${code}`)));
    this.worker = worker;
    return worker;
  }
  agent(provider: Provider): QuestionAgent {
    return (prompt, signal, scope, timeoutMs) => new Promise<string>((resolve, reject) => {
      if (!scope) { reject(new Error('Ask needs the reviewed repository and head.')); return; }
      let worker: Worker;
      try { worker = this.start(); } catch (error) { reject(error as Error); return; }
      const id = randomUUID();
      this.pending.set(id, { attemptId: scope.attemptId, resolve, reject });
      const question = { ...scope, provider, prompt,
        deadline: Date.now() + Math.max(1_000, (timeoutMs ?? 120_000) - SETTLE_MARGIN_MS) };
      worker.postMessage({ type: 'ask', id, question } satisfies WorkerRequest);
      // The promise settles only when the worker reports that the container and its storage are gone.
      const cancel = () => worker.postMessage({ type: 'cancel', id,
        reason: signal.reason instanceof Error ? signal.reason.message : 'Agent cancelled.' } satisfies WorkerRequest);
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    });
  }
  /** Call only after every agent promise has settled. */
  async close() { const worker = this.worker; this.worker = undefined; await worker?.terminate(); }
}

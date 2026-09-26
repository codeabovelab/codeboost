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
  private pending = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  private url: URL;
  constructor(url = new URL('./question-worker.ts', import.meta.url)) { this.url = url; }
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.url);
    worker.on('message', (reply: WorkerReply) => {
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if (reply.ok) job.resolve(reply.text); else job.reject(new Error(reply.error));
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const job of this.pending.values()) job.reject(new Error(`The agent container worker stopped: ${error.message}`));
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
      const id = randomUUID(), worker = this.start();
      this.pending.set(id, { resolve, reject });
      const question = { ...scope, provider, prompt, attemptId: `question-${id}`,
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

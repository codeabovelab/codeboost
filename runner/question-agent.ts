import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { QuestionAgent } from './questions.ts';
import type { Provider } from './question-container.ts';
import type { ReleaseReply, WorkerReply, WorkerRequest } from './question-worker.ts';
import type { LeftoverLedger } from './question-leftovers.ts';
export type { Provider } from './question-container.ts';

// Leave the worker time to cancel the container and release storage before the review's own timeout fires.
const SETTLE_MARGIN_MS = 5_000;
// Bounds the final storage removal at shutdown; whatever remains is recorded instead of waited for.
const RELEASE_TIMEOUT_MS = 30_000;

/** One worker owns every Ask container, so lane D's trusted image and allocations stay in one registry. */
export class QuestionWorker {
  private worker?: Worker;
  private pending = new Map<string, { attemptId: string; resolve: (text: string) => void; reject: (error: Error) => void }>();
  // Set when the worker dies. Its containers and storage may still exist, and nothing in this process can reclaim
  // them until lane D's scoped recovery exists (#51), so Ask stays off rather than starting a replacement worker.
  private crashed?: Error;
  private releases = new Map<string, (reply: Omit<ReleaseReply, 'id'>) => void>();
  private url: URL;
  private ledger?: LeftoverLedger;
  /** With a ledger, storage left at shutdown is recorded, and Ask stays off while recorded storage still exists. */
  constructor(url = new URL('./question-worker.ts', import.meta.url), ledger?: LeftoverLedger) { this.url = url; this.ledger = ledger; }
  private start(): Worker {
    if (this.crashed) throw this.crashed;
    if (this.worker) return this.worker;
    const worker = new Worker(this.url);
    worker.on('message', (reply: WorkerReply | ReleaseReply) => {
      if ('remaining' in reply) { this.releases.get(reply.id)?.(reply); this.releases.delete(reply.id); return; }
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
      for (const release of this.releases.values()) release({ remaining: [], untracked: 0 });
      this.releases.clear();
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`exit code ${code}`)));
    this.worker = worker;
    return worker;
  }
  agent(provider: Provider): QuestionAgent {
    return async (prompt, signal, scope, timeoutMs) => {
      await this.ledger?.assertClear();
      signal.throwIfAborted();
      return this.#ask(provider, prompt, signal, scope, timeoutMs);
    };
  }
  #ask(provider: Provider, ...[prompt, signal, scope, timeoutMs]: Parameters<QuestionAgent>) {
    return new Promise<string>((resolve, reject) => {
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
  /**
   * Call only after every agent promise has settled. Asks the worker for a final storage removal and records
   * anything it could not remove before terminating it, because terminating drops the worker's allocation handles.
   */
  async close() {
    const worker = this.worker;
    if (!worker) return;
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const released = await new Promise<Omit<ReleaseReply, 'id'> | null>(resolve => {
      this.releases.set(id, resolve);
      timer = setTimeout(() => { this.releases.delete(id); resolve(null); }, RELEASE_TIMEOUT_MS);
      worker.postMessage({ type: 'release', id } satisfies WorkerRequest);
    });
    clearTimeout(timer);
    this.worker = undefined;
    try {
      if (released === null) console.error('codeboost: the agent container worker did not report its storage before shutdown. Check `docker ps -a` and `docker volume ls` for leftover codeboost resources.');
      else this.ledger?.record(released.remaining, released.untracked);
    } finally { await worker.terminate(); }
  }
}

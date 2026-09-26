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
// Lane D's settlement can retry cleanup without limit (#51 item 1). A question not settled this long after its
// deadline is abandoned: its resources are recorded as unknown and the worker is stopped.
const ABANDON_AFTER_DEADLINE_MS = 30_000;

/** One worker owns every Ask container, so lane D's trusted image and allocations stay in one registry. */
export class QuestionWorker {
  private worker?: Worker;
  private pending = new Map<string, { attemptId: string; resolve: (text: string) => void; reject: (error: Error) => void;
    watchdog: ReturnType<typeof setTimeout> }>();
  private scanned = false;
  // Set when the worker dies. Its containers and storage may still exist, and nothing in this process can reclaim
  // them until lane D's scoped recovery exists (#51), so Ask stays off rather than starting a replacement worker.
  private crashed?: Error;
  private releases = new Map<string, (reply: Omit<ReleaseReply, 'id'> | null) => void>();
  private url: URL;
  private ledger?: LeftoverLedger;
  /** With a ledger, storage left at shutdown is recorded, and Ask stays off while recorded storage still exists. */
  private abandonAfterMs: number;
  constructor(url = new URL('./question-worker.ts', import.meta.url), ledger?: LeftoverLedger,
    options: { abandonAfterDeadlineMs?: number } = {}) {
    this.url = url; this.ledger = ledger; this.abandonAfterMs = options.abandonAfterDeadlineMs ?? ABANDON_AFTER_DEADLINE_MS;
  }
  private start(): Worker {
    if (this.crashed) throw this.crashed;
    if (this.worker) return this.worker;
    const worker = new Worker(this.url);
    worker.on('message', (reply: WorkerReply | ReleaseReply) => {
      if ('remaining' in reply) { this.releases.get(reply.id)?.(reply); this.releases.delete(reply.id); return; }
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      clearTimeout(job.watchdog);
      if (reply.attemptId !== job.attemptId) job.reject(new Error('The agent returned a result for a different question attempt.'));
      else if (reply.ok) job.resolve(reply.text); else job.reject(new Error(reply.error));
    });
    const fail = (error: Error) => { if (this.worker === worker) this.#abandon(`stopped (${error.message})`); };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`exit code ${code}`)));
    this.worker = worker;
    return worker;
  }
  /**
   * Give up on the worker: record its allocations as unknown, reject everything waiting on it, and stop it.
   * Used after a crash and when lane D does not settle in time. Ask stays off until codeboost restarts, and after
   * the restart until no labelled resources remain.
   */
  #abandon(why: string) {
    const worker = this.worker;
    this.worker = undefined;
    this.crashed ??= new Error(`The agent container worker ${why}. Its containers and storage may still exist, so Ask is off until codeboost restarts. Check \`docker ps -a\` and \`docker volume ls\` before restarting.`);
    // Durable before anything else, so a later kill of this process cannot lose it.
    this.#recordUnknown();
    for (const job of this.pending.values()) { clearTimeout(job.watchdog); job.reject(this.crashed); }
    this.pending.clear();
    for (const release of this.releases.values()) release(null);
    this.releases.clear();
    void worker?.terminate();
  }
  #recordUnknown() {
    try { this.ledger?.record([], 1); }
    catch (error) { console.error(`codeboost: could not record possible leftover agent storage: ${error instanceof Error ? error.message : error}`); }
  }
  agent(provider: Provider): QuestionAgent {
    return async (prompt, signal, scope, timeoutMs) => {
      if (this.crashed) throw this.crashed;
      // The first question of a process also scans for labelled leftovers when there is no record.
      await this.ledger?.assertClear(signal, { startup: !this.scanned });
      this.scanned = true;
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
      const question = { ...scope, provider, prompt,
        deadline: Date.now() + Math.max(1_000, (timeoutMs ?? 120_000) - SETTLE_MARGIN_MS) };
      const watchdog = setTimeout(() => { if (this.pending.has(id)) this.#abandon('did not settle a question after its deadline'); },
        question.deadline - Date.now() + this.abandonAfterMs);
      watchdog.unref?.();
      this.pending.set(id, { attemptId: scope.attemptId, resolve, reject, watchdog });
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
    // Questions still waiting mean lane D has not settled; do not wait on it at shutdown.
    if (this.pending.size) { this.#abandon('was stopped at shutdown with questions still settling'); return; }
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
      // No report (timeout or crash) means unknown leftovers, which stay recorded until no task storage remains.
      if (released === null) this.#recordUnknown();
      else this.ledger?.record(released.remaining, released.untracked, released.paths);
    } finally { await worker.terminate(); }
  }
}

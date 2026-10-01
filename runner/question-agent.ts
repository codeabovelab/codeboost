import { randomBytes, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { QuestionAgent } from './questions.ts';
import { credentialEnvironment, questionCredential, stopOf, workerEnvironment, type Provider } from './question-container.ts';
import type { RecoverReply, ReleaseReply, WorkerReply, WorkerRequest } from './question-worker.ts';
import { createAskRoot, removeAskRoot, type LeftoverLedger } from './question-leftovers.ts';
export type { Provider } from './question-container.ts';

// Leave the worker time to cancel the container and release storage before the review's own timeout fires.
const SETTLE_MARGIN_MS = 5_000;
// Bounds the final storage removal at shutdown; whatever remains is left for the next process's recovery.
const RELEASE_TIMEOUT_MS = 30_000;
// Lane D's settlement can retry cleanup without limit (#51 item 1). A question not settled this long after its
// deadline is abandoned: the worker is stopped, and its resources are left for the next process's recovery.
const ABANDON_AFTER_DEADLINE_MS = 30_000;
// Bounds the wait for an abandoned worker thread to stop (a synchronous Docker or Git call finishes first).
const DEFAULT_TERMINATE_WAIT_MS = 15_000;

/** One worker owns every Ask container, so lane D's trusted image and allocations stay in one registry. */
export class QuestionWorker {
  private worker?: Worker;
  // The worker's TMPDIR. Recorded before the worker starts, deleted after it stops.
  private root?: string;
  private pending = new Map<string, { attemptId: string; resolve: (text: string) => void; reject: (error: Error) => void;
    watchdog: ReturnType<typeof setTimeout> }>();
  private scanned = false;
  // Written as `io.codeboost.runner` on every Docker object Ask creates, and the only owner Ask's recovery acts on
  // (#65). For a review it is the database's Ask owner token, read once under the review's Ask lock.
  private readonly owner: () => string;
  private runnerOwner?: string;
  // Set when the worker dies. Its containers and storage may still exist, and a worker thread or its Docker children
  // may still be changing them, so Ask stays off rather than starting a replacement worker. The next process's
  // recovery removes them.
  private crashed?: Error;
  private releases = new Map<string, (reply: Omit<ReleaseReply, 'id'> | null) => void>();
  private recoveries = new Map<string, (error: Error | undefined) => void>();
  private url: URL;
  private ledger?: LeftoverLedger;
  /** With a ledger, Ask roots are recorded and the review's Ask lock is held while Ask runs. */
  private abandonAfterMs: number;
  private terminateWaitMs: number;
  private releaseTimeoutMs: number;
  private closed = false;
  private env: Readonly<Record<string, string | undefined>>;
  constructor(url = new URL('./question-worker.ts', import.meta.url), ledger?: LeftoverLedger,
    options: { abandonAfterDeadlineMs?: number; terminateWaitMs?: number; releaseTimeoutMs?: number; env?: Readonly<Record<string, string | undefined>>;
      /** The review's Ask owner token. Without one, each worker uses a random owner, so it recovers nothing earlier. */
      runnerOwner?: () => string } = {}) {
    const random = randomBytes(16).toString('hex');
    this.owner = options.runnerOwner ?? (() => random);
    this.url = url; this.ledger = ledger; this.abandonAfterMs = options.abandonAfterDeadlineMs ?? ABANDON_AFTER_DEADLINE_MS;
    this.terminateWaitMs = options.terminateWaitMs ?? DEFAULT_TERMINATE_WAIT_MS;
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }
  private start(): Worker {
    if (this.crashed) throw this.crashed;
    if (this.worker) return this.worker;
    // Stamped with this review's lock, so a later process can find it even if the record is renamed away or lost.
    const root = createAskRoot(this.ledger?.lockPath ?? '');
    // Durable before any setup: a process killed from here on still leaves a record of this root.
    try { this.ledger?.recordRoot(root); } catch (error) { removeAskRoot(root); throw error; }
    let worker: Worker;
    try {
      worker = new Worker(this.url, { env: workerEnvironment(process.env, root),
        workerData: { credentials: credentialEnvironment(this.env) } });
    } catch (error) {
      // Nothing ran in the root yet: delete it and drop the record, so close() can release the lock.
      removeAskRoot(root); this.ledger?.forget(root);
      throw error;
    }
    this.root = root;
    worker.on('message', (reply: WorkerReply | ReleaseReply | RecoverReply) => {
      if ('remaining' in reply) { this.releases.get(reply.id)?.(reply); this.releases.delete(reply.id); return; }
      if ('recovery' in reply) {
        this.recoveries.get(reply.id)?.(reply.recovery === 'done' ? undefined : new Error(reply.error ?? 'Recovery failed.'));
        this.recoveries.delete(reply.id);
        return;
      }
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      clearTimeout(job.watchdog);
      if (reply.attemptId !== job.attemptId) job.reject(new Error('The agent returned a result for a different question attempt.'));
      else if (reply.ok) job.resolve(reply.text); else job.reject(new Error(reply.error));
    });
    const fail = (error: Error) => { if (this.worker === worker) void this.#abandon(`stopped (${error.message})`); };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`exit code ${code}`)));
    this.worker = worker;
    return worker;
  }
  /**
   * Give up on the worker: reject everything waiting on it, and stop it. Used after a crash and when lane D does not
   * settle in time. Ask stays off until codeboost restarts; the first question after the restart recovers what the
   * worker left in Docker.
   */
  #abandoning?: Promise<void>;
  /** Every caller (crash, watchdog, shutdown) waits on the same bounded termination and handoff. */
  #abandon(why: string): Promise<void> {
    this.#abandoning ??= this.#abandonOnce(why);
    return this.#abandoning;
  }
  async #abandonOnce(why: string) {
    const worker = this.worker;
    this.worker = undefined;
    this.crashed ??= new Error(`The agent container worker ${why}. Its containers and storage may still exist, so Ask is off until codeboost restarts. The first question after the restart removes them.`);
    for (const release of this.releases.values()) release(null);
    this.releases.clear();
    this.#failRecoveries(this.crashed);
    // Keep the questions (and their slots) pending until the thread has stopped: a synchronous Docker or Git call
    // in progress finishes first. Docker objects that asynchronous children leave carry this review's owner label.
    if (worker) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A rejected terminate() proves nothing about the thread: only a settled termination counts as stopped.
      const termination = worker.terminate().then(() => true, () => false);
      const stopped = await Promise.race([termination,
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.terminateWaitMs); })]);
      clearTimeout(timer);
      // Only a stopped thread can no longer write into its root. If it is still inside a synchronous Docker or Git
      // call, its ownership is already durable (the owner label and the recorded root), and the crashed state
      // admits no new question, so the waiters can be released; the root is deleted once the thread does stop.
      const root = this.root;
      if (stopped) this.#removeRoot();
      else void termination.then(ended => { if (ended && this.root === root) this.#removeRoot(); });
    }
    for (const job of this.pending.values()) { clearTimeout(job.watchdog); job.reject(this.crashed); }
    this.pending.clear();
  }
  /** Delete the worker's root and drop it from the record; if deletion fails it stays recorded for the next check. */
  #removeRoot() {
    const root = this.root;
    if (!root) return;
    this.root = undefined;
    try {
      removeAskRoot(root); this.ledger?.forget(root);
      // A thread that stopped after close() has no more files to write; the lock still stays if it was abandoned.
      if (this.closed && !this.#abandoning && !this.#recoveryStopped) this.ledger?.release();
    }
    catch (error) { console.error(`codeboost: could not delete ${root}: ${error instanceof Error ? error.message : error}`); }
  }
  agent(provider: Provider): QuestionAgent {
    return async (prompt, signal, scope, timeoutMs) => {
      if (this.crashed) throw this.crashed;
      // Missing sign-in is reported before any Docker work, including recovery.
      questionCredential(provider, this.env);
      // Held until close, so no other process can recover, start a worker or write the record for this review.
      this.ledger?.acquire();
      // The first question of a process removes what earlier sessions left. The check is single-flight: concurrent
      // first questions share it, so recovery never runs once a question has started.
      if (!this.scanned) await this.#startupScan(signal);
      signal.throwIfAborted();
      return this.#ask(provider, prompt, signal, scope, timeoutMs);
    };
  }
  #scanning?: Promise<void>;
  /**
   * One startup check for all concurrent first questions: delete earlier Ask roots, then recover this review's Docker
   * leftovers in the worker. Each caller may stop waiting; a failed check is retried by the next question.
   */
  async #startupScan(signal: AbortSignal) {
    // Cleared by `.finally`, which runs after the assignment even when the check throws before its first await.
    this.#scanning ??= (async () => {
      this.ledger?.assertClear({ active: this.root });
      this.runnerOwner ??= this.owner();
      await this.#recover(this.start(), this.runnerOwner);
      this.scanned = true;
    })().finally(() => { this.#scanning = undefined; });
    const scan = this.#scanning;
    let release!: () => void;
    const aborted = new Promise<never>((_, reject) => { release = () => reject(signal.reason); signal.addEventListener('abort', release, { once: true }); });
    try { await Promise.race([scan, aborted]); }
    finally { signal.removeEventListener('abort', release); }
  }
  /**
   * Lane D's recovery for this owner, run in the worker that will own the recovered handles. Only the startup check
   * calls it, before `scanned` admits any question: D's recovery removes every agent container of this owner.
   */
  #recover(worker: Worker, runnerOwner: string) {
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      this.recoveries.set(id, error => error ? reject(error) : resolve());
      worker.postMessage({ type: 'recover', id, runnerOwner } satisfies WorkerRequest);
    });
  }
  #ask(provider: Provider, ...[prompt, signal, scope, timeoutMs]: Parameters<QuestionAgent>) {
    return new Promise<string>((resolve, reject) => {
      if (!scope) { reject(new Error('Ask needs the reviewed repository and head.')); return; }
      let worker: Worker;
      try { worker = this.start(); } catch (error) { reject(error as Error); return; }
      const id = randomUUID();
      const question = { ...scope, provider, prompt, runnerOwner: this.runnerOwner!,
        deadline: Date.now() + Math.max(1_000, (timeoutMs ?? 120_000) - SETTLE_MARGIN_MS) };
      const watchdog = setTimeout(() => { if (this.pending.has(id)) void this.#abandon('did not settle a question after its deadline'); },
        question.deadline - Date.now() + this.abandonAfterMs);
      watchdog.unref?.();
      this.pending.set(id, { attemptId: scope.attemptId, resolve, reject, watchdog });
      worker.postMessage({ type: 'ask', id, question } satisfies WorkerRequest);
      // The promise settles only when the worker reports that the container and its storage are gone.
      const cancel = () => worker.postMessage({ type: 'cancel', id, stop: stopOf(signal.reason),
        reason: signal.reason instanceof Error ? signal.reason.message : 'Agent cancelled.' } satisfies WorkerRequest);
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    });
  }
  /**
   * Call only after every agent promise has settled. Asks the worker for a final storage removal before terminating
   * it, because terminating drops the worker's allocation handles. What it cannot remove carries this review's owner
   * label, so the next process's recovery removes it.
   */
  async close() {
    this.closed = true;
    try { await this.#close(); }
    finally {
      // A shared startup check may still be running (its recovery stopped with the worker above); it ends under the lock.
      await this.#scanning?.catch(() => undefined);
      // Keep the lock while an abandoned thread may still write into its recorded root. After any abandonment, or a
      // recovery stopped part way, keep it until this process exits: Docker CLI children the thread started can outlive
      // it, and nothing here can see or await them (that needs lane D's process groups, #51 item 5). The OS releases
      // the lock when the process ends.
      if (!this.root && !this.#abandoning && !this.#recoveryStopped) this.ledger?.release();
    }
  }
  async #close() {
    const worker = this.worker;
    // An abandonment already in progress (crash or watchdog) owns the worker: wait for its bounded settlement.
    if (!worker) { await this.#abandoning; return; }
    // Questions still waiting mean lane D has not settled; do not wait on it at shutdown.
    if (this.pending.size) { await this.#abandon('was stopped at shutdown with questions still settling'); return; }
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const released = await new Promise<Omit<ReleaseReply, 'id'> | null>(resolve => {
      this.releases.set(id, resolve);
      timer = setTimeout(() => { this.releases.delete(id); resolve(null); }, this.releaseTimeoutMs);
      worker.postMessage({ type: 'release', id } satisfies WorkerRequest);
    });
    clearTimeout(timer);
    // No report means the worker may still be inside a synchronous Docker call: use the bounded abandon path,
    // which keeps the root recorded until the thread has stopped.
    if (released === null) { await this.#abandon('did not report its storage before shutdown'); return; }
    this.worker = undefined;
    if (released.remaining) console.error(`codeboost: ${released.remaining} Ask allocation(s) could not be removed at shutdown; the first question after the next start removes them.`);
    try { await worker.terminate(); }
    // A recovery still in flight stops with the thread; the next process's recovery finishes it.
    finally { this.#failRecoveries(new Error('Server stopped. Retry the question.')); }
    this.#removeRoot();
  }
  /** Set when a recovery was stopped before it answered: its Docker clients may still be running. */
  #recoveryStopped = false;
  #failRecoveries(error: Error) {
    if (this.recoveries.size) this.#recoveryStopped = true;
    for (const recovered of this.recoveries.values()) recovered(error);
    this.recoveries.clear();
  }
}

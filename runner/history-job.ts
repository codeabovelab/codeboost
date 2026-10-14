import { Worker } from 'node:worker_threads';
import type { HistoryLimits } from '../git/history.ts';
import type { History, Segment } from '../core/linking.ts';
import type { Plan } from '../core/plan.ts';
import type { PathIdentity } from '../core/path-identity.ts';

/**
 * One history read, and optionally its linking, for one worker thread. `budgetMs` is what the caller's overall deadline
 * leaves when the job is sent; the worker enforces it from its own start as one budget for both stages. A relative
 * budget, because threads share no monotonic clock: each `performance.now()` counts from its own thread's start, and
 * `performance.timeOrigin` is wall-clock time, which a system sleep or clock step moves apart from them.
 */
export interface HistoryJob {
  repository: string; base: string; head: string; budgetMs: number;
  limits?: Omit<HistoryLimits, 'maxDurationMs'>;
  link?: { plan: Plan; ownership: [string, string | null][]; pathIdentity: PathIdentity; resolvedConflicts: string[] };
}
export type HistoryReply = { ok: true; history: History; segments: Segment[] | null } | { ok: false; error: string; code?: string };
/** The worker's first message: its modules are loaded and its budget starts now. */
export type HistoryStarted = { started: true };
export type HistoryCancel = { type: 'cancel'; reason: string };

/** After a cancel, how long the worker may take to kill its Git process and reply before it is terminated. */
export const HISTORY_CANCEL_GRACE_MS = 1_000;
/**
 * Past the job's budget, how long the worker may take to report its own deadline error before it is stopped. The budget
 * is counted from the worker's start message, so a slow thread start does not cut into it.
 */
export const HISTORY_DEADLINE_GRACE_MS = 1_000;
/** How long a worker may take to start (load its modules) before its budget is counted from its creation instead. */
export const HISTORY_START_GRACE_MS = 5_000;
/**
 * How many history workers run at once. The server no longer serializes review loads, so tabs and refreshes could
 * otherwise start any number of threads and Git processes; later jobs wait for a slot.
 */
export const MAX_HISTORY_WORKERS = 2;

/** Slots in use and jobs waiting for one, in arrival order. A slot is held until its worker thread has ended. */
let running = 0;
const waiting: { grant: () => void }[] = [];
const release = () => {
  running--;
  while (running < MAX_HISTORY_WORKERS && waiting.length) { running++; waiting.shift()!.grant(); }
};
/**
 * Waits for a worker slot. A job waiting for one is not started at all if its signal aborts (it rejects with the
 * signal's reason) or its budget runs out first (it rejects with the deadline error).
 */
function acquire(budgetMs: number, signal?: AbortSignal): Promise<void> {
  if (running < MAX_HISTORY_WORKERS) { running++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { grant: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); } };
    const leave = (reason: unknown) => {
      const index = waiting.indexOf(entry);
      if (index < 0) return;
      waiting.splice(index, 1); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(reason);
    };
    const onAbort = () => leave(signal!.reason);
    const timer = setTimeout(() => leave(new Error('History work exceeded its overall deadline.')), budgetMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(entry);
  });
}

const workerUrl = new URL('./history-worker.ts', import.meta.url);

/**
 * Runs a history job in its own worker thread, so Git processes, object storage inspection and linking never block
 * the caller's event loop. At most MAX_HISTORY_WORKERS run at once; a job waits for a slot first, and the wait counts
 * against its budget.
 *
 * Lifecycle: the job is running until the worker replies, fails or exits. An abort, or the budget passing without a
 * reply, sends a cancel: the worker kills its running Git process, waits for it to exit, and replies. A worker that has
 * not replied within the grace is terminated. That is the case for a worker in synchronous work (linking, blob
 * decoding, the object storage walk), where it runs no Git process; and, rarely, for one whose killed Git process has
 * not exited within the grace (a process in an uninterruptible kernel wait), which then outlives the job. The returned
 * promise settles only after the worker thread has ended. An abort rejects with the signal's reason, unchanged.
 */
export async function runHistoryJob(job: HistoryJob, signal?: AbortSignal, url: URL = workerUrl): Promise<{ history: History; segments: Segment[] | null }> {
  signal?.throwIfAborted();
  const queued = performance.now();
  await acquire(job.budgetMs, signal);
  try {
    const budgetMs = Math.ceil(job.budgetMs - (performance.now() - queued));
    if (budgetMs < 1) throw new Error('History work exceeded its overall deadline.');
    signal?.throwIfAborted();
    return await runInWorker({ ...job, budgetMs }, url, signal);
  } finally { release(); }
}

/** One job in one worker thread; settles only after that thread has ended (see runHistoryJob). */
function runInWorker(job: HistoryJob, url: URL, signal?: AbortSignal): Promise<{ history: History; segments: Segment[] | null }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: job });
    // The outcome is decided once (the first reply, failure or stop) and delivered once the thread has exited.
    let outcome: (() => void) | null = null, delivered = false, stopping = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined, graceTimer: ReturnType<typeof setTimeout> | undefined;
    const decide = (value: () => void) => { outcome ??= value; };
    const deliver = () => {
      if (delivered) return;
      delivered = true;
      clearTimeout(deadlineTimer); clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      (outcome ?? (() => reject(new Error('History worker stopped without a reply.'))))();
    };
    // A reply is the worker's last act; terminate makes sure the thread ends and resolves once it has. A rejected
    // terminate proves nothing about the thread, so the job then waits for its `exit` event, which delivers.
    const end = () => { void worker.terminate().then(deliver, () => undefined); };
    const stop = (reason: unknown) => {
      if (stopping || outcome) return;
      stopping = true;
      decide(() => reject(reason));
      worker.postMessage({ type: 'cancel', reason: reason instanceof Error ? reason.message : String(reason) } satisfies HistoryCancel);
      graceTimer = setTimeout(end, HISTORY_CANCEL_GRACE_MS);
    };
    const onAbort = () => stop(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const armDeadline = (startGraceMs: number) => {
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => stop(new Error('History work exceeded its overall deadline.')), startGraceMs + job.budgetMs + HISTORY_DEADLINE_GRACE_MS);
    };
    armDeadline(HISTORY_START_GRACE_MS);
    worker.on('message', (reply: HistoryReply | HistoryStarted) => {
      if ('started' in reply) { if (!stopping && !outcome) armDeadline(0); return; }
      decide(reply.ok ? () => resolve({ history: reply.history, segments: reply.segments })
        : () => reject(Object.assign(new Error(reply.error), reply.code ? { code: reply.code } : {})));
      end();
    });
    worker.on('error', error => { decide(() => reject(error)); end(); });
    worker.on('exit', code => { decide(() => reject(new Error(`History worker stopped (exit code ${code}).`))); deliver(); });
  });
}

/** `readHistory` in a worker thread, within `maxDurationMs` from now (at most 30 s, its own ceiling). */
export async function readHistoryInWorker(repository: string, base: string, head: string, options: { maxDurationMs?: number; signal?: AbortSignal } = {}): Promise<History> {
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 30_000) throw new Error('Duration budget must be a positive integer no larger than 30000 ms.');
  return (await runHistoryJob({ repository, base, head, budgetMs: maxDurationMs }, options.signal)).history;
}

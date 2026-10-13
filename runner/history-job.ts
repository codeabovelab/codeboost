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

const workerUrl = new URL('./history-worker.ts', import.meta.url);

/**
 * Runs a history job in its own worker thread, so Git processes, object storage inspection and linking never block
 * the caller's event loop.
 *
 * Lifecycle: the job is running until the worker replies, fails or exits. An abort, or the budget passing without a
 * reply, sends a cancel: the worker kills its running Git process, waits for it to exit, and replies. A worker that has
 * not replied within the grace is terminated. That is the case for a worker in synchronous work (linking, blob
 * decoding, the object storage walk), where it runs no Git process; and, rarely, for one whose killed Git process has
 * not exited within the grace (a process in an uninterruptible kernel wait), which then outlives the job. The returned
 * promise settles only after the worker thread has ended. An abort rejects with the signal's reason, unchanged.
 */
export function runHistoryJob(job: HistoryJob, signal?: AbortSignal, url: URL = workerUrl): Promise<{ history: History; segments: Segment[] | null }> {
  if (signal?.aborted) return Promise.reject(signal.reason);
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
    // A reply is the worker's last act; terminate makes sure the thread ends and resolves once it has.
    const end = () => { void worker.terminate().then(deliver, deliver); };
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

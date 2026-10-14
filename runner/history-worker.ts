import { parentPort, workerData } from 'node:worker_threads';
import type { HistoryJob, HistoryReply, HistoryCancel, HistoryStarted } from './history-job.ts';
import { runHistoryWork } from './history-work.ts';

// Review history reads run Git and walk object storage, and linking replays every changed line. Both run here so the
// review server's thread stays free; see history-job.ts for the protocol.
const controller = new AbortController();
parentPort!.on('message', (message: HistoryCancel) => { if (message.type === 'cancel') controller.abort(new Error(message.reason)); });
parentPort!.postMessage({ started: true } satisfies HistoryStarted);

// Deferred a turn, so a cancel already posted with the job usually arrives before the first Git process starts; one
// that arrives later kills that process instead.
setImmediate(() => void runHistoryWork(workerData as HistoryJob, controller.signal).then(
  ({ history, segments }) => parentPort!.postMessage({ ok: true, history, segments } satisfies HistoryReply),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error),
    ...(typeof (error as { code?: unknown })?.code === 'string' ? { code: (error as { code: string }).code } : {}) } satisfies HistoryReply),
).finally(() => parentPort!.close()));

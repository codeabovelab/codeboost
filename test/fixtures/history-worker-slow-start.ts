import { parentPort, workerData } from 'node:worker_threads';
// A history worker whose start takes `startMs` (as a slow module load does), then announces its start, reads the
// parent's cancel and never replies.
const until = Date.now() + (workerData?.startMs ?? 0);
while (Date.now() < until) { /* starting */ }
parentPort!.on('message', () => { /* ignored */ });
parentPort!.postMessage({ started: true });

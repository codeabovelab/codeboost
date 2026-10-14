import { workerData } from 'node:worker_threads';
// A history worker stuck in synchronous work (as linking is): it never reads the parent's cancel. While it runs it
// counts in the shared `heartbeat` buffer, so a test can see when the thread has stopped.
const beats = workerData?.heartbeat instanceof SharedArrayBuffer ? new Int32Array(workerData.heartbeat) : null;
const until = Date.now() + 60_000;
while (Date.now() < until) { if (beats) Atomics.add(beats, 0, 1); }

import { parentPort } from 'node:worker_threads';
// A history worker that reads the parent's cancel and never replies, past any deadline.
parentPort!.on('message', () => { /* ignored */ });

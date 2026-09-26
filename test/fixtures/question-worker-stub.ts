import { parentPort } from 'node:worker_threads';
import type { WorkerRequest } from '../../runner/question-worker.ts';

// Stands in for runner/question-worker.ts so the main-thread bridge can be tested without Docker.
const waiting = new Set<string>();
parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') {
    if (waiting.delete(message.id)) parentPort!.postMessage({ id: message.id, ok: false, error: `cancelled:${message.reason}` });
    return;
  }
  const { prompt, provider, noteId } = message.question;
  if (prompt === 'crash') throw new Error('stub crashed');
  if (prompt === 'wait') { waiting.add(message.id); return; }
  parentPort!.postMessage({ id: message.id, ok: true, text: `${provider}:${prompt}:${noteId}` });
});

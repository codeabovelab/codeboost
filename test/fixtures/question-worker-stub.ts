import { parentPort } from 'node:worker_threads';
import type { WorkerRequest } from '../../runner/question-worker.ts';

// Stands in for runner/question-worker.ts so the main-thread bridge can be tested without Docker.
const waiting = new Map<string, string>();
parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') {
    if (waiting.has(message.id)) {
      parentPort!.postMessage({ id: message.id, attemptId: waiting.get(message.id)!, ok: false, error: `cancelled:${message.reason}` });
      waiting.delete(message.id);
    }
    return;
  }
  const { prompt, provider, noteId, attemptId } = message.question;
  if (prompt === 'crash') throw new Error('stub crashed');
  if (prompt === 'wait') { waiting.set(message.id, attemptId); return; }
  // Simulates a reply that carries another attempt's identity.
  const replied = prompt === 'wrong-attempt' ? `${attemptId}-other` : attemptId;
  parentPort!.postMessage({ id: message.id, attemptId: replied, ok: true, text: `${provider}:${prompt}:${noteId}` });
});

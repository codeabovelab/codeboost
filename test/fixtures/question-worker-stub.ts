import { parentPort } from 'node:worker_threads';
import type { WorkerRequest } from '../../runner/question-worker.ts';

// Stands in for runner/question-worker.ts so the main-thread bridge can be tested without Docker.
const waiting = new Map<string, string>();
// Allocations a question could not remove, as the real worker's RetainedStorage would report them.
const leaked: { keeper: string; workVolume: string; metadataVolume: string }[] = [];
let untracked = 0;
parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'release') {
    parentPort!.postMessage({ id: message.id, remaining: leaked, untracked });
    return;
  }
  if (message.type === 'cancel') {
    if (waiting.has(message.id)) {
      parentPort!.postMessage({ id: message.id, attemptId: waiting.get(message.id)!, ok: false, error: `cancelled:${message.reason}` });
      waiting.delete(message.id);
    }
    return;
  }
  const { prompt, provider, noteId, attemptId } = message.question;
  if (prompt === 'crash') throw new Error('stub crashed');
  if (prompt === 'leak') {
    leaked.push({ keeper: 'codeboost-keeper-1', workVolume: 'codeboost-work-1', metadataVolume: 'codeboost-meta-1' });
    parentPort!.postMessage({ id: message.id, attemptId, ok: false, error: 'Question container cleanup did not settle.' });
    return;
  }
  if (prompt === 'lose-setup') {
    untracked++;
    parentPort!.postMessage({ id: message.id, attemptId, ok: false, error: 'Task allocation failed and cleanup did not settle.' });
    return;
  }
  if (prompt === 'wait') { waiting.set(message.id, attemptId); return; }
  // Simulates a reply that carries another attempt's identity.
  const replied = prompt === 'wrong-attempt' ? `${attemptId}-other` : attemptId;
  parentPort!.postMessage({ id: message.id, attemptId: replied, ok: true, text: `${provider}:${prompt}:${noteId}` });
});

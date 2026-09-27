import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerRequest } from '../../runner/question-worker.ts';

// Stands in for runner/question-worker.ts so the main-thread bridge can be tested without Docker.
const waiting = new Map<string, string>();
// Allocations a question could not remove, as the real worker's RetainedStorage would report them.
const leaked: { keeper: string; workVolume: string; metadataVolume: string }[] = [];
let untracked = 0;
let stuckOnRelease = false;
parentPort!.on('message', (message: WorkerRequest) => {
  // Simulates a worker stuck in synchronous cleanup when shutdown asks it to report.
  if (message.type === 'release' && stuckOnRelease) { spawnSync('sleep', ['1']); return; }
  if (message.type === 'release') {
    parentPort!.postMessage({ id: message.id, remaining: leaked, untracked });
    return;
  }
  if (message.type === 'cancel') {
    if (waiting.has(message.id)) {
      parentPort!.postMessage({ id: message.id, attemptId: waiting.get(message.id)!, ok: false, error: `cancelled:${message.stop}:${message.reason}` });
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
  // Never replies, like a question whose lane D cleanup does not settle.
  // Reports what the bridge gave this worker, for the environment allowlist test.
  if (prompt === 'env') { parentPort!.postMessage({ id: message.id, attemptId, ok: true, text: JSON.stringify({ env: Object.keys(process.env).sort(), credentials: Object.keys(workerData?.credentials ?? {}).sort() }) }); return; }
  if (prompt === 'hang') return;
  if (prompt === 'stick-on-release') { stuckOnRelease = true; parentPort!.postMessage({ id: message.id, attemptId, ok: true, text: 'ok' }); return; }
  // Blocks the thread in a native subprocess call, like lane D's synchronous Docker and Git setup, then never replies.
  if (prompt === 'block') { spawnSync('sleep', ['1']); return; }
  if (prompt === 'block-long') { spawnSync('sleep', ['3']); return; }
  // Leaves a host copy behind, as an interrupted setup would, and reports where the worker's TMPDIR put it.
  if (prompt === 'leave-copy') {
    const staging = mkdtempSync(join(tmpdir(), 'codeboost-question-'));
    writeFileSync(join(staging, 'auth.json'), 'secret');
    parentPort!.postMessage({ id: message.id, attemptId, ok: true, text: staging });
    return;
  }
  if (prompt === 'wait') { waiting.set(message.id, attemptId); return; }
  // Simulates a reply that carries another attempt's identity.
  const replied = prompt === 'wrong-attempt' ? `${attemptId}-other` : attemptId;
  parentPort!.postMessage({ id: message.id, attemptId: replied, ok: true, text: `${provider}:${prompt}:${noteId}` });
});

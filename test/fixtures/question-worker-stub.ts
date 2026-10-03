import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerRequest } from '../../runner/question-worker.ts';

// Stands in for runner/question-worker.ts so the main-thread bridge can be tested without Docker.
const waiting = new Map<string, string>();
// Allocations a question could not remove, as the real worker's RetainedStorage would count them.
let remaining = 0;
let stuckOnRelease = false;
// Owners this worker was asked to recover, in order.
const recovered: string[] = [];
parentPort!.on('message', (message: WorkerRequest) => {
  // Simulates a worker stuck in synchronous cleanup when shutdown asks it to report.
  if (message.type === 'release' && stuckOnRelease) { spawnSync('sleep', ['1']); return; }
  if (message.type === 'release') {
    parentPort!.postMessage({ id: message.id, remaining });
    return;
  }
  // Three owner tokens select the stub's recovery behaviour: f×32 fails the first time, e×32 takes 500 ms, d×32 never
  // answers. Any other owner recovers at once.
  if (message.type === 'recover') {
    const owner = message.runnerOwner;
    recovered.push(owner);
    const reply = () => parentPort!.postMessage(owner === 'f'.repeat(32) && recovered.length === 1
      ? { id: message.id, recovery: 'failed', error: 'Ask is off: codeboost could not remove what an earlier session of this review left in Docker (Docker is starting).' }
      : { id: message.id, recovery: 'done' });
    if (owner === 'd'.repeat(32)) return;
    if (owner === 'e'.repeat(32)) setTimeout(reply, 500); else reply();
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
    remaining++;
    parentPort!.postMessage({ id: message.id, attemptId, ok: false, error: 'Question container cleanup did not settle.' });
    return;
  }
  // Reports the owners this worker recovered, and the owner the question carries.
  if (prompt === 'recoveries') {
    parentPort!.postMessage({ id: message.id, attemptId, ok: true, text: JSON.stringify({ recovered, owner: message.question.runnerOwner }) });
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

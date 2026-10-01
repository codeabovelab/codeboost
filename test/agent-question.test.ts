import { fixtureGit } from './fixtures/git.ts';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { QuestionWorker } from '../runner/question-agent.ts';
import { QUESTION_STORAGE } from '../runner/question-container.ts';
import { LeftoverLedger } from '../runner/question-leftovers.ts';

// Real Docker: the production worker builds the image, clones the reviewed head, allocates bounded storage, and runs
// the vendor CLI in the "questions" phase. Runs with the other Docker suites, one file at a time.
const roots: string[] = [];
// Owners this file labels Docker objects with; whatever a failed test leaves under them is removed here.
const owners: string[] = [];
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
afterAll(() => {
  for (const owner of owners) for (const kind of ['container', 'volume', 'network']) {
    const names = docker(kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet', '--filter', `label=io.codeboost.runner=${owner}`).stdout.split('\n').filter(Boolean);
    if (names.length) docker(kind, 'rm', ...(kind === 'volume' ? [] : ['--force']), ...names);
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 120_000);
const git = fixtureGit;

function repository(secret: string) {
  const root = mkdtempSync(join(tmpdir(), 'question-container-')); roots.push(root);
  git(root, 'init'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'secret.txt'), `The review word is ${secret}.\n`);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  return { repository: root, head: git(root, 'rev-parse', 'HEAD'), snapshotId: 'snapshot', planId: 'plan', planRevision: 1, noteId: 'note',
    attemptId: randomBytes(16).toString('hex'), contextId: 'c'.repeat(64) };
}

describe('Ask in the agent container', () => {
  // Storage release after settlement is asserted in question-agent.test.ts; a global Docker count here would also see
  // other suites sharing the daemon.
  it('reaches the vendor from inside the container (fake Claude token)', async () => {
    // The worker copies the environment when it starts, so set the invalid token first and restore it after.
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'codeboost-invalid-test-token';
    const worker = new QuestionWorker();
    try {
      const answer = worker.agent('claude')('Reply with OK.', new AbortController().signal, repository('unused'), 10 * 60_000);
      // Only a request that left the container through the vendor proxy can come back with Anthropic's 401.
      await expect(answer).rejects.toThrow(/Claude could not answer.*(401|authenticate)/);
    } finally {
      await worker.close();
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  }, 11 * 60_000);

  // #65: two reviews share this daemon. Each review's Ask recovers only what carries its own owner, and the other
  // review's storage (here allocated and held by this process, as a live review would) neither blocks it nor is removed.
  it('recovers only its own review when two reviews share one Docker daemon', async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'codeboost-invalid-test-token';
    const review = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
    owners.push(...review);
    const data = repository('unused'), imageId = buildAgentImage();
    const allocate = (runnerOwner: string) => {
      const parent = mkdtempSync(join(tmpdir(), 'question-leftover-')); roots.push(parent);
      const clone = createTaskClone({ source: data.repository, parent, taskId: 'leftover', head: data.head, timeoutMs: 60_000 });
      return prepareTaskFilesystems(clone, QUESTION_STORAGE, imageId, { runnerOwner, attemptId: randomBytes(16).toString('hex'), allocationId: randomUUID() });
    };
    const exists = (kind: string, name: string) => docker(kind, 'inspect', name).status === 0;
    const running = (keeper: string) => docker('container', 'inspect', '--format', '{{.State.Running}}', keeper).stdout.trim() === 'true';
    // Review 0's storage from a session that was killed, and review 1's storage while it runs.
    const left = allocate(review[0]!), live = allocate(review[1]!);
    const ledgers = review.map(() => { const dir = mkdtempSync(join(tmpdir(), 'question-review-')); roots.push(dir); return new LeftoverLedger(join(dir, 'review.sqlite.ask-leftovers.json')); });
    const workers = review.map((owner, index) => new QuestionWorker(undefined, ledgers[index], { runnerOwner: () => owner }));
    try {
      // Review 0 is not refused: its question reaches the vendor, which rejects the fake token.
      await expect(workers[0]!.agent('claude')('Reply with OK.', new AbortController().signal, data, 10 * 60_000))
        .rejects.toThrow(/Claude could not answer.*(401|authenticate)/);
      for (const name of [left.workVolume, left.metadataVolume]) expect(exists('volume', name)).toBe(false);
      expect(exists('container', left.keeper)).toBe(false);
      for (const name of [live.workVolume, live.metadataVolume]) expect(exists('volume', name)).toBe(true);
      expect(running(live.keeper)).toBe(true);
      // Review 0's worker is still live; review 1 starts, recovers its own storage, and leaves review 0 alone.
      await expect(workers[1]!.agent('claude')('Reply with OK.', new AbortController().signal, { ...data, attemptId: randomBytes(16).toString('hex') }, 10 * 60_000))
        .rejects.toThrow(/Claude could not answer.*(401|authenticate)/);
      expect(exists('container', live.keeper)).toBe(false);
      for (const name of [live.workVolume, live.metadataVolume]) expect(exists('volume', name)).toBe(false);
    } finally {
      for (const worker of workers) await worker.close();
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  }, 22 * 60_000);

  it.runIf(process.env.CODEBOOST_RUN_AUTH_PROBES === '1')('answers from a file it can only read in /work (live Claude)', async () => {
    const secret = randomBytes(6).toString('hex');
    const worker = new QuestionWorker();
    try {
      const answer = await worker.agent('claude')('Read secret.txt in /work and reply with only the review word it contains.',
        new AbortController().signal, repository(secret), 10 * 60_000);
      expect(answer).toContain(secret);
    } finally { await worker.close(); }
  }, 11 * 60_000);
});

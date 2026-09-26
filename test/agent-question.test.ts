import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QuestionWorker } from '../runner/question-agent.ts';

// Real Docker: the production worker builds the image, clones the reviewed head, allocates bounded storage, and runs
// the vendor CLI in the "questions" phase. Runs with the other Docker suites, one file at a time.
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repository(secret: string) {
  const root = mkdtempSync(join(tmpdir(), 'question-container-')); roots.push(root);
  git(root, 'init'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'secret.txt'), `The review word is ${secret}.\n`);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  return { repository: root, head: git(root, 'rev-parse', 'HEAD'), snapshotId: 'snapshot', planId: 'plan', planRevision: 1, noteId: 'note' };
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

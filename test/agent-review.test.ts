import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startClaudeInvocation } from '../agents/adapters/claude.ts';
import { captureInvocation } from '../agents/contract.ts';
import { buildAgentImage } from '../agents/container/image.ts';
import { prepareTaskFilesystems, removeTaskFilesystems } from '../agents/container/run.ts';
import { createTaskClone } from '../git/clone.ts';
import { measureGitRepository, RetainedStorage, runReadOnlyAgent } from '../runner/question-container.ts';
import { REVIEW_FEATURE, reviewRun } from '../runner/review-agent.ts';
import { CLIENT_LIMIT, REAL_DOCKER, removeRunnerObjects } from './fixtures/docker-sweep.ts';
import { prepareReviewRecording, REVIEW_RECORDING_FILES } from './fixtures/review/recording-inputs.ts';

// Real Docker (#201): a review round runs Claude in lane D's read-only "review" phase with the review answer schema
// as --json-schema. Runs with the other Docker suites, one file at a time.
const roots: string[] = [], owners: string[] = [];
/** The IDs of one kind of Docker object labelled with `owner`; a failed listing fails the test rather than reading as none. */
const labelled = (kind: string, owner: string) => {
  const listed = spawnSync(REAL_DOCKER, [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet', '--filter',
    `label=io.codeboost.runner=${owner}`], { encoding: 'utf8', ...CLIENT_LIMIT });
  if (listed.error || listed.status !== 0) throw new Error(`docker ${kind} ls failed: ${listed.error?.message ?? listed.stderr}`);
  return listed.stdout.split('\n').filter(Boolean);
};
// The shared sweep makes eleven Docker calls of at most 30 s each.
afterAll(() => {
  try { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  finally { for (const owner of owners) removeRunnerObjects(owner); }
}, 360_000);

describe('review in the agent container', () => {
  it('runs a Claude review in the container and reaches the vendor (fake Claude token)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-review-')); roots.push(root);
    const repository = join(root, 'repository');
    for (const [path, text] of Object.entries(REVIEW_RECORDING_FILES)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args],
      { cwd: repository, encoding: 'utf8' }).trim();
    git('init', '--quiet', '--initial-branch=main'); git('add', '.'); git('commit', '--quiet', '-m', 'baseline');
    const head = git('rev-parse', 'HEAD'), owner = randomBytes(16).toString('hex'); owners.push(owner);
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'codeboost-invalid-test-token' };
    const deps = { buildImage: buildAgentImage, createClone: createTaskClone, prepareFilesystems: prepareTaskFilesystems,
      removeFilesystems: removeTaskFilesystems, measureRepository: measureGitRepository,
      capture: captureInvocation, startClaude: startClaudeInvocation, env };
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-review-'));
    const { request } = prepareReviewRecording('claude-review-round2', head, randomUUID());
    const retained = new RetainedStorage();
    // Only a request that left the container through the vendor proxy can come back with Anthropic's 401. The unit
    // tests (agent-policy, agent-adapter, review-prompt) check that the review command carries the schema.
    await expect(runReadOnlyAgent(REVIEW_FEATURE, { ...reviewRun(request, { vendor: 'claude', repository, snapshotId: 's' },
      Date.now() + 10 * 60_000), runnerOwner: owner }, deps, new AbortController().signal, {}, retained))
      .rejects.toThrow(/Claude could not review the plan items.*(401|authenticate)/);
    // Cleaned up: no Docker object carries the owner, nothing is retained, and the host root is gone.
    for (const kind of ['container', 'volume', 'network']) expect(labelled(kind, owner), kind).toEqual([]);
    expect([retained.size, retained.untracked, retained.paths()]).toEqual([0, 0, []]);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-review-'))).toEqual(before);
  }, 11 * 60_000);
});

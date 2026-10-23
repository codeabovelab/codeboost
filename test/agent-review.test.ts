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
import { removeRunnerObjects } from './fixtures/docker-sweep.ts';
import { prepareReviewRecording, REVIEW_RECORDING_FILES } from './fixtures/review/recording-inputs.ts';

// Real Docker (#201): a review round runs Claude in lane D's read-only "review" phase with the review answer schema
// as --json-schema. Runs with the other Docker suites, one file at a time.
const roots: string[] = [], owners: string[] = [];
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const labelled = (kind: string, owner: string) => docker(kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet',
  '--filter', `label=io.codeboost.runner=${owner}`).stdout.split('\n').filter(Boolean);
afterAll(() => {
  try { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  finally { for (const owner of owners) removeRunnerObjects(owner); }
}, 120_000);

describe('review in the agent container', () => {
  it('reaches the vendor from inside the container with the review schema (fake Claude token)', async () => {
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
    // Only a request that left the container through the vendor proxy can come back with Anthropic's 401. A command
    // the profile refused (a schema that does not match the mount, say) would fail before any network call.
    await expect(runReadOnlyAgent(REVIEW_FEATURE, { ...reviewRun(request, { vendor: 'claude', repository, snapshotId: 's' },
      Date.now() + 10 * 60_000), runnerOwner: owner }, deps, new AbortController().signal, {}, retained))
      .rejects.toThrow(/Claude could not review the plan items.*(401|authenticate)/);
    // Cleaned up: no Docker object carries the owner, nothing is retained, and the host root is gone.
    for (const kind of ['container', 'volume', 'network']) expect(labelled(kind, owner), kind).toEqual([]);
    expect([retained.size, retained.untracked, retained.paths()]).toEqual([0, 0, []]);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('codeboost-review-'))).toEqual(before);
  }, 11 * 60_000);
});

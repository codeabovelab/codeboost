import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { PlanningAgent } from '../runner/planning.ts';
import { ReviewService } from '../runner/review.ts';
import { prepareRecording } from './fixtures/planning/recording-inputs.ts';

// Real Docker (#117): the production planning agent starts planning's worker, which builds the image, clones the
// review's head, allocates bounded storage and runs Claude in the "planning" phase. Runs with the other Docker suites,
// one file at a time.
const roots: string[] = [], services: ReviewService[] = [], owners: string[] = [];
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
afterAll(() => {
  for (const owner of owners) for (const kind of ['container', 'volume', 'network']) {
    const names = docker(kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet', '--filter', `label=io.codeboost.runner=${owner}`).stdout.split('\n').filter(Boolean);
    if (names.length) docker(kind, 'rm', ...(kind === 'volume' ? [] : ['--force']), ...names);
  }
  services.forEach(service => service.close());
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('planning in the agent container', () => {
  it('reaches the vendor from inside the container (fake Claude token)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-planning-')); roots.push(root);
    const service = new ReviewService(createDemo(join(root, 'demo'))); services.push(service);
    service.store.setQuestionProvider('claude');
    owners.push(service.store.planningOwnerToken(statSync(realpathSync(service.config.database), { bigint: true })));
    const snapshot = service.store.getSnapshot(service.config.identity);
    // A real E2 planning request: its schema is the one lane D passes to Claude as --json-schema.
    const request = { ...prepareRecording('draft', snapshot.head, randomUUID()).request, identity: service.config.identity };
    const agent = new PlanningAgent(service, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'codeboost-invalid-test-token' } });
    try {
      // Only a request that left the container through the vendor proxy can come back with Anthropic's 401.
      await expect(agent.invoke(request, new AbortController().signal)).rejects.toThrow(/Claude could not write the plan.*(401|authenticate)/);
    } finally { await agent.close(); }
    // Closed cleanly: no Docker object carries planning's owner, and no planning root stays recorded.
    const owner = owners.at(-1)!;
    for (const kind of ['container', 'volume', 'network'])
      expect(docker(kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet', '--filter', `label=io.codeboost.runner=${owner}`).stdout.trim(), kind).toBe('');
    expect(existsSync(`${realpathSync(service.config.database)}.planning-leftovers.json`)).toBe(false);
  }, 11 * 60_000);
});

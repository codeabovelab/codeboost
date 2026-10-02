import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createDemo } from '../scripts/demo.ts';
import { Store } from '../runner/store.ts';
import { RUNNER_CREDENTIAL_MISSING } from '../runner/production.ts';

vi.setConfig({ testTimeout: 30_000 });
const cli = fileURLToPath(new URL('../web/cli.ts', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** A non-demo review with a runner block, and a HOME of its own so the lock directory is the test's. */
function review() {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-cli-')); roots.push(root);
  const demo = createDemo(join(root, 'demo')), store = new Store(demo.database), issue = store.getPlan(demo.identity).issue; store.close();
  mkdirSync(join(root, 'runner'), { mode: 0o700 }); mkdirSync(join(root, 'home'), { mode: 0o700 });
  const config = join(root, 'review.json');
  writeFileSync(config, JSON.stringify({ ...demo, demo: false, github: { repository: 'owner/repo', pullRequest: 1, issue },
    runner: { root: join(root, 'runner'), committer: { name: 'codeboost', email: 'runner@codeboost.invalid' } } }));
  const run = (...args: string[]) => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = process.env;
    return spawnSync(process.execPath, [cli, '--config', config, ...args], { encoding: 'utf8', env: { ...env, HOME: join(root, 'home') }, timeout: 20_000 });
  };
  return { run };
}

it('refuses a runner startup without a token with its message, exit 1 and the lock released', () => {
  const { run } = review();
  for (let n = 0; n < 2; n++) {
    const result = run('--port', '0');
    expect(result.status).toBe(1);
    // The second start meets the same refusal, not "Another codeboost runner": the first released the lock.
    expect(result.stderr.trim()).toBe(RUNNER_CREDENTIAL_MISSING);
  }
});
it('refuses a bad port and an unknown preparation with a message, never a stack', () => {
  const { run } = review();
  const port = run('--port', 'x');
  expect([port.status, port.stderr.trim()]).toEqual([1, 'Invalid port.']);
  for (let n = 0; n < 2; n++) {
    const release = run('--release-preparation', randomUUID());
    expect([release.status, release.stderr.trim()]).toEqual([1, 'Unknown attempt.']);
  }
});

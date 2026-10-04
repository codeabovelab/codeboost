import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION } from '../agents/container/image.ts';
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
function review(github: Record<string, unknown> = { baseBranch: 'main' }) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-cli-')); roots.push(root);
  const demo = createDemo(join(root, 'demo')), store = new Store(demo.database), issue = store.getPlan(demo.identity).issue; store.close();
  mkdirSync(join(root, 'runner'), { mode: 0o700 }); mkdirSync(join(root, 'home'), { mode: 0o700 });
  const config = join(root, 'review.json');
  writeFileSync(config, JSON.stringify({ ...demo, demo: false, github: { repository: 'owner/repo', pullRequest: 1, issue, ...github },
    runner: { root: join(root, 'runner'), committer: { name: 'codeboost', email: 'runner@codeboost.invalid' } } }));
  /**
   * A `docker` that answers every call with nothing (no leftovers, an image that matches the pinned profile) once the hold
   * file is gone: startup recovery waits on it, as on a slow daemon, for as long as the test keeps the file.
   */
  const fakeDocker = () => {
    const bin = join(root, 'bin'), hold = join(bin, 'hold'), image = JSON.stringify([{ Id: `sha256:${'a'.repeat(64)}`, Config: { User: '10001:10001',
      Labels: { 'org.opencontainers.image.base.name': BASE_IMAGE, 'io.codeboost.codex.version': CODEX_VERSION, 'io.codeboost.claude.version': CLAUDE_VERSION, 'io.codeboost.profile.version': '1' } } }]);
    mkdirSync(bin, { mode: 0o700 }); writeFileSync(hold, '');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nwhile [ -e '${hold}' ]; do sleep 0.05; done\nif [ "$1 $2" = "image inspect" ]; then printf '%s' '${image}'; fi\nexit 0\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    return { path: `${bin}:${process.env.PATH}`, release: () => { if (existsSync(hold)) unlinkSync(hold); } };
  };
  /** The CLI as a child process with a token and the fake docker, its output collected. */
  const start = (docker: { path: string }) => {
    const child = spawn(process.execPath, [cli, '--config', config, '--port', '0'],
      { env: { ...process.env, HOME: join(root, 'home'), PATH: docker.path, CLAUDE_CODE_OAUTH_TOKEN: 'test-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
    const until = async (check: () => boolean, what: string) => {
      for (let n = 0; n < 400 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!check()) throw new Error(`Timed out waiting for ${what}. stdout: ${stdout} stderr: ${stderr}`);
    };
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    return { child, until, exited, out: () => stdout, err: () => stderr };
  };
  const run = (...args: string[]) => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = process.env;
    return spawnSync(process.execPath, [cli, '--config', config, ...args], { encoding: 'utf8', env: { ...env, HOME: join(root, 'home') }, timeout: 20_000 });
  };
  return { run, fakeDocker, start, database: demo.database, identity: demo.identity };
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
it('refuses a runner without github.baseBranch before the lock and before the token check (#103)', () => {
  for (const github of [{}, { baseBranch: 'refs/heads/main' }]) {
    const result = review(github).run('--port', '0');
    expect(result.status).toBe(1);
    // Not the missing-token refusal that the runner's setup would give after the lock: the CLI checked the block first.
    expect(result.stderr.trim()).toMatch(/^The runner publishes pull requests: add github\.baseBranch/);
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

it('waits for startup recovery on a first Ctrl+C, then stops cleanly once startup has finished', async () => {
  const { fakeDocker, start } = review(), docker = fakeDocker();
  const cli = start(docker);
  try {
    await cli.until(() => cli.out().includes('recovering what an earlier run left'), 'startup recovery to begin');
    cli.child.kill('SIGINT');
    await cli.until(() => cli.out().includes('Stopping once startup has finished'), 'the first-signal message');
    // Recovery is still waiting on Docker: the process has not stopped.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(cli.child.exitCode).toBeNull();
    docker.release();
    expect(await cli.exited).toBe(0);
    expect(cli.out()).not.toContain('Review ready');
  } finally { docker.release(); cli.child.kill('SIGKILL'); }
});
it('stops at once with exit 130 on a second Ctrl+C during startup', async () => {
  const { fakeDocker, start } = review(), docker = fakeDocker();
  const cli = start(docker);
  try {
    await cli.until(() => cli.out().includes('recovering what an earlier run left'), 'startup recovery to begin');
    cli.child.kill('SIGINT');
    await cli.until(() => cli.out().includes('Stopping once startup has finished'), 'the first-signal message');
    cli.child.kill('SIGINT');
    expect(await cli.exited).toBe(130);
    expect(cli.err()).toContain('Stopped during startup. The next start recovers what this one left.');
  } finally { docker.release(); cli.child.kill('SIGKILL'); }
});

it('reports that --release-preparation needs --config, instead of printing help and exiting 0', () => {
  const result = spawnSync(process.execPath, [cli, '--release-preparation', randomUUID()], { encoding: 'utf8', timeout: 20_000 });
  expect([result.status, result.stderr.trim()]).toEqual([1, '--release-preparation needs --config.']);
});
it('ignores a runner block in a demo configuration opened with --config, and serves the demo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-cli-')); roots.push(root);
  const demo = createDemo(join(root, 'demo'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  const config = join(root, 'demo-with-runner.json');
  writeFileSync(config, JSON.stringify({ ...demo, runner: { root: join(root, 'runner'), committer: { name: 'codeboost', email: 'runner@codeboost.invalid' } } }));
  const child = spawn(process.execPath, [cli, '--config', config, '--port', '0'], { env: { ...process.env, HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  try {
    for (let n = 0; n < 400 && !stdout.includes('Review ready') && child.exitCode === null; n++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(stderr).toBe('');
    expect(stdout).toContain('Review ready');
    expect(stdout).not.toContain('recovering what an earlier run left');
    child.kill('SIGINT');
    expect(await exited).toBe(0);
  } finally { child.kill('SIGKILL'); }
});

it('starts a publish the database owes once startup has verified the lock (#103)', async () => {
  const { fakeDocker, start, database, identity } = review(), docker = fakeDocker();
  // A task an earlier process left in needs human with no draft PR yet: a draft publish is owed.
  const store = new Store(database);
  try {
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
    const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: store.getPlan(identity).items[0]!.id,
      expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
    store.markRunning(identity, attempt.id);
    store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 1, valid: false });
    store.transitionTask(identity, store.getTask(identity).stateVersion, 'needs human');
  } finally { store.close(); }
  // A gh that records each call and fails, so nothing reaches GitHub.
  const bin = docker.path.split(':')[0]!, calls = join(bin, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`); chmodSync(join(bin, 'gh'), 0o755);
  docker.release();
  const cli = start(docker);
  try {
    await cli.until(() => cli.out().includes('Review ready'), 'the server to open');
    await cli.until(() => existsSync(calls), 'the startup publish to call gh');
    cli.child.kill('SIGINT');
    expect(await cli.exited).toBe(0);
    const reopened = new Store(database);
    try { expect(reopened.lastPublish(identity)).toMatchObject({ outcome: 'failed', draft: true }); } finally { reopened.close(); }
  } finally { cli.child.kill('SIGKILL'); }
});
it('refuses with a message, not a stack, when the database path changes during a runner startup', async () => {
  const { fakeDocker, start, database } = review(), docker = fakeDocker();
  const cli = start(docker);
  try {
    await cli.until(() => cli.out().includes('recovering what an earlier run left'), 'startup recovery to begin');
    // The locked file moves away and another takes its name while startup is still running.
    renameSync(database, `${database}.moved`); writeFileSync(database, '');
    docker.release();
    expect(await cli.exited).toBe(1);
    expect(cli.err().trim()).toBe('The database path changed while opening. Refusing to start.');
  } finally { docker.release(); cli.child.kill('SIGKILL'); }
});

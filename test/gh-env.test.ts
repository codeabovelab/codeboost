import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GhMergeGateway, MERGE_KILL_GRACE_MS, MERGE_PIPE_GRACE_MS, type RunGh } from '../github/merge.ts';
import { GhIssueGateway, ISSUE_KILL_GRACE_MS, ISSUE_PIPE_GRACE_MS } from '../github/issues.ts';
import { GhPullRequestGateway } from '../github/pull-requests.ts';
import { GhAlreadyFixedGateway } from '../github/already-fixed.ts';
import { GH_ENV_ALLOWLIST, ghEnvironment } from '../github/gh-env.ts';

// Every adapter's own runner, not an injected one: these are the runners the server uses.
// Each adapter must send every `gh` call through `run`, or this test does not see it.
const defaultRunners: [string, () => RunGh][] = [
  ['merge', () => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 1, issue: 1 }).run],
  ['issues', () => new GhIssueGateway('owner/repo').run],
  ['pull requests', () => new GhPullRequestGateway({ repository: 'owner/repo' }).run],
  ['already fixed', () => new GhAlreadyFixedGateway({ repository: 'owner/repo' }).run],
];

describe('default gh runners', () => {
  let dir = '';
  // A known value for every allowlisted variable, so the test can check that each one reaches gh.
  const expected: Record<string, string> = {};
  const saved = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  beforeAll(() => {
    // A `gh` first on PATH that prints the environment it was given.
    dir = mkdtempSync(join(tmpdir(), 'codeboost-gh-env-'));
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexec env\n');
    chmodSync(join(dir, 'gh'), 0o755);
    for (const name of GH_ENV_ALLOWLIST) {
      if (name === 'PATH') expected[name] = `${dir}:${process.env.PATH ?? ''}`;
      else if (name === 'LANG' || name === 'LC_ALL') expected[name] = 'C';
      else expected[name] = `sentinel-${name}`;
      setEnv(name, expected[name]);
    }
    setEnv('CODEBOOST_UNRELATED_SECRET', 'must-not-reach-gh');
  });
  afterAll(() => {
    for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(defaultRunners)('%s: passes the allowlisted variables and nothing unrelated', async (_name, runner) => {
    const lines = (await runner()(['api', 'user'])).split('\n');
    for (const [name, value] of Object.entries(expected)) expect(lines).toContain(`${name}=${value}`);
    // The fixed settings are what ghEnvironment adds to an empty environment on this platform.
    for (const [name, value] of Object.entries(ghEnvironment({}))) expect(lines).toContain(`${name}=${value}`);
    expect(lines.some(line => line.startsWith('CODEBOOST_UNRELATED_SECRET='))).toBe(false);
  });
});

// The kill and pipe grace periods each gateway counts inside its deadline, plus 500 ms for a slow test machine.
const settleBudgetMs: Record<string, number | undefined> = {
  merge: MERGE_KILL_GRACE_MS + MERGE_PIPE_GRACE_MS + 500,
  issues: ISSUE_KILL_GRACE_MS + ISSUE_PIPE_GRACE_MS + 500,
};

describe('default gh runners stop a gh that ignores SIGTERM', () => {
  let dir = '';
  const saved = process.env.PATH;
  beforeAll(() => {
    // A `gh` first on PATH that ignores SIGTERM and never exits on its own. Once SIGTERM is ignored it writes its
    // process ID to `ready`, so the test does not abort before then (an early SIGTERM would still stop it).
    dir = mkdtempSync(join(tmpdir(), 'codeboost-gh-stuck-'));
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\ntrap '' TERM\necho $$ > '${join(dir, 'ready.tmp')}'\nmv '${join(dir, 'ready.tmp')}' '${join(dir, 'ready')}'\nwhile :; do sleep 1; done\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}:${saved ?? ''}`;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  // A cancelled gh must not keep running after the caller was told the call stopped.
  it.each(defaultRunners)('%s: an abort settles the call only after gh has exited', async (name, runner) => {
    rmSync(join(dir, 'ready'), { force: true });
    const controller = new AbortController();
    const call = runner()(['api', 'user'], { signal: controller.signal });
    const started = Date.now();
    while (!existsSync(join(dir, 'ready'))) {
      if (Date.now() - started > 5_000) throw new Error('The fake gh did not start.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pid = Number(readFileSync(join(dir, 'ready'), 'utf8'));
    try {
      const aborted = Date.now();
      controller.abort(new Error('stop'));
      await expect(call).rejects.toThrow('stop');
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      // The wait after an abort counts inside the caller's deadline, so it must stay within the stated grace periods.
      const budget = settleBudgetMs[name];
      if (budget !== undefined) expect(Date.now() - aborted).toBeLessThan(budget);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }, 15_000);
});

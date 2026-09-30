import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GhMergeGateway, type RunGh } from '../github/merge.ts';
import { GhIssueGateway } from '../github/issues.ts';
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

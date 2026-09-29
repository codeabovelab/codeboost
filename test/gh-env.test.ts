import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GhMergeGateway, type RunGh } from '../github/merge.ts';
import { GhIssueGateway } from '../github/issues.ts';
import { GhPullRequestGateway } from '../github/pull-requests.ts';
import { GhAlreadyFixedGateway } from '../github/already-fixed.ts';

// Every adapter's own runner, not an injected one: these are the runners the server uses.
const defaultRunners: [string, () => RunGh][] = [
  ['merge', () => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 1, issue: 1 }).run],
  ['issues', () => new GhIssueGateway('owner/repo').run],
  ['pull requests', () => new GhPullRequestGateway({ repository: 'owner/repo' }).run],
  ['already fixed', () => new GhAlreadyFixedGateway({ repository: 'owner/repo' }).run],
];

describe('default gh runners', () => {
  let dir = '';
  let path: string | undefined;
  beforeAll(() => {
    // A `gh` first on PATH that prints the environment it was given.
    dir = mkdtempSync(join(tmpdir(), 'codeboost-gh-env-'));
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexec env\n');
    chmodSync(join(dir, 'gh'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    process.env.CODEBOOST_UNRELATED_SECRET = 'must-not-reach-gh';
  });
  afterAll(() => {
    process.env.PATH = path;
    delete process.env.CODEBOOST_UNRELATED_SECRET;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(defaultRunners)('%s: passes only the gh environment', async (_name, runner) => {
    const lines = (await runner()(['api', 'user'])).split('\n');
    expect(lines).toContain('GH_PROMPT_DISABLED=1');
    expect(lines).toContain(`PATH=${dir}:${path}`);
    expect(lines.some(line => line.startsWith('CODEBOOST_UNRELATED_SECRET='))).toBe(false);
  });
});

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkLiveProbeReport, LIVE_PROBE_FILES, LIVE_PROBES } from '../scripts/live-probes.ts';
import config from '../vitest.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DOCKER_TESTS = [
  'test/agent-container.test.ts',
  'test/agent-gate.test.ts',
  'test/agent-network.test.ts',
  'test/agent-planning.test.ts',
  'test/agent-question.test.ts',
  'test/agent-supervisor.test.ts',
  'test/runner-workspace.test.ts',
];

describe('Vitest scheduling', () => {
  it('finishes ordinary tests before running Docker-backed files one at a time', () => {
    const projects = (config as { test?: { projects?: Array<{ test?: Record<string, unknown> }> } }).test?.projects;
    expect(projects).toHaveLength(2);
    expect(projects?.[0]?.test).toMatchObject({
      name: 'parallel',
      include: ['test/*.test.ts'],
      exclude: DOCKER_TESTS,
      sequence: { groupOrder: 0 },
    });
    expect(projects?.[1]?.test).toMatchObject({
      name: 'docker',
      include: DOCKER_TESTS,
      fileParallelism: false,
      sequence: { groupOrder: 1 },
    });
  });
});

const workflow = (name: string) =>
  parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as {
    on: Record<string, unknown>;
    jobs: Record<string, { env?: unknown; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
  };
const runs = (steps: Array<{ run?: string }>) => steps.flatMap(step => step.run === undefined ? [] : [step.run]);

describe('CI workflows', () => {
  it('excludes exactly the Docker-backed files from the CI test job', () => {
    const ci = workflow('ci.yml');
    const commands = runs(ci.jobs.test!.steps).filter(run => run.startsWith('npm test'));
    expect(commands).toHaveLength(1);
    const words = commands[0]!.split(/\s+/);
    const excluded = words.flatMap((word, index) => word === '--exclude' ? [words[index + 1]] : []);
    expect(excluded.toSorted()).toEqual(DOCKER_TESTS);
    expect(words.filter(word => word.startsWith('-')).every(word => word === '--' || word === '--exclude')).toBe(true);
  });

  it('runs the complete Vitest suite in real-docker on every pull request and on the CI push branches', () => {
    const ci = workflow('ci.yml'), isolation = workflow('agent-isolation.yml');
    expect(Object.keys(isolation.on).toSorted()).toEqual(['pull_request', 'push']);
    // No path filter: a required check that a filter skips never reports, and the pull request cannot merge.
    expect(isolation.on.pull_request).toBeNull();
    expect(ci.on.pull_request).toBeNull();
    expect(isolation.on.push).toEqual(ci.on.push);
    expect(isolation.on.push).toEqual({ branches: ['main', 'codex/**'] });
    expect(runs(isolation.jobs['real-docker']!.steps)).toEqual(['npm ci --ignore-scripts', 'npm run typecheck', 'npm test']);
  });

  it('runs only the live Claude probes, by hand or nightly, never on a pull request or push', () => {
    const live = workflow('live-probes.yml');
    expect(Object.keys(live.on).toSorted()).toEqual(['schedule', 'workflow_dispatch']);
    const job = live.jobs['live-probes']!;
    expect(job.env).toBeUndefined();
    const vitest = job.steps.filter(step => step.run?.startsWith('npx vitest'));
    expect(vitest).toHaveLength(1);
    const words = vitest[0]!.run!.split(/\s+/);
    // The docker project runs the files one at a time; the filter keeps only titles that end in "(live Claude)".
    expect(vitest[0]!.run!.startsWith("npx vitest run --project docker -t '\\(live Claude\\)$' ")).toBe(true);
    expect(words.filter(word => word.startsWith('test/'))).toEqual(LIVE_PROBE_FILES);
    expect(vitest[0]!.env).toEqual({ CODEBOOST_RUN_AUTH_PROBES: '1',
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    expect(runs(job.steps).at(-1)).toBe('node scripts/live-probes.ts check live-probes.json');
    for (const file of LIVE_PROBE_FILES) expect(DOCKER_TESTS).toContain(file);
  });

  it('fails the live probe job at once when the token secret is empty', () => {
    const guard = workflow('live-probes.yml').jobs['live-probes']!.steps[0]!;
    expect(guard.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    const run = (token: string | undefined) => spawnSync('bash', ['-e', '-c', guard.run!], { encoding: 'utf8',
      env: { PATH: process.env.PATH, ...(token === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token }) } });
    for (const token of [undefined, '']) {
      const result = run(token);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::The repository secret CLAUDE_CODE_OAUTH_TOKEN is not set');
    }
    expect(run('placeholder').status).toBe(0);
  });

  it('names every live probe exactly as its test file titles it', () => {
    // Every "(live Claude)" title in the probe files is listed, and no other test file is gated on live credentials.
    for (const file of LIVE_PROBE_FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const titles = [...source.matchAll(/'([^']*\(live Claude\))'/g)].map(match => match[1]);
      expect(titles.length).toBe(LIVE_PROBES.filter(probe => probe.file === file).length);
      for (const title of titles)
        expect(LIVE_PROBES.some(probe => probe.file === file && probe.name.endsWith(` ${title}`))).toBe(true);
    }
    const gated = readdirSync(join(ROOT, 'test')).filter(name => name.endsWith('.test.ts') && name !== 'vitest-config.test.ts')
      .filter(name => readFileSync(join(ROOT, 'test', name), 'utf8').includes('CODEBOOST_RUN_AUTH_PROBES'))
      .map(name => `test/${name}`);
    expect(gated).toEqual(LIVE_PROBE_FILES);
  });
});

describe('live probe report check', () => {
  const report = (tests: Array<[string, string, string]>, failed = 0) => ({
    success: failed === 0, numFailedTests: failed,
    testResults: [...new Set(tests.map(([file]) => file))].map(file => ({ name: join(ROOT, file),
      assertionResults: tests.filter(([testFile]) => testFile === file).map(([, fullName, status]) => ({ fullName, status })) })),
  });
  const all = LIVE_PROBES.map(probe => [probe.file, probe.name, 'passed'] as [string, string, string]);

  it('accepts a report in which every probe passed and nothing else ran', () => {
    expect(checkLiveProbeReport(report([...all, [LIVE_PROBES[0].file, 'other test', 'skipped']]), ROOT)).toEqual([]);
  });

  it('refuses a report in which the probes were skipped, as when the probe switch is off', () => {
    const skipped = all.map(([file, name]) => [file, name, 'skipped'] as [string, string, string]);
    expect(checkLiveProbeReport(report(skipped), ROOT)).toHaveLength(LIVE_PROBES.length);
    expect(checkLiveProbeReport({}, ROOT).length).toBeGreaterThan(LIVE_PROBES.length);
  });

  it('refuses a missing probe, a failure or a test that is not a probe', () => {
    expect(checkLiveProbeReport(report(all.slice(1)), ROOT)).toEqual(
      [`Live probe did not pass: ${LIVE_PROBES[0].file} > ${LIVE_PROBES[0].name}`]);
    expect(checkLiveProbeReport(report(all, 1), ROOT)).toEqual(
      ['Vitest did not report success.', 'Vitest reported 1 failed test(s).']);
    expect(checkLiveProbeReport(report([...all, [LIVE_PROBES[0].file, 'other test', 'passed']]), ROOT)).toEqual(
      [`A test that is not a live probe ran: ${join(ROOT, LIVE_PROBES[0].file)} > other test`]);
  });
});

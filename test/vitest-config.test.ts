import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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
});

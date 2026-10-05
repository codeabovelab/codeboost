import { describe, expect, it } from 'vitest';
import config from '../vitest.config.ts';

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

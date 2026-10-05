import { defineConfig } from 'vitest/config';

// These files share Docker's daemon and the fixed agent-image tag. Keep them out of the ordinary worker pool so an
// image build or container-heavy test cannot starve unrelated five-second tests, then run them one file at a time.
const dockerTests = [
  'test/agent-container.test.ts',
  'test/agent-gate.test.ts',
  'test/agent-network.test.ts',
  'test/agent-planning.test.ts',
  'test/agent-question.test.ts',
  'test/agent-supervisor.test.ts',
  'test/runner-workspace.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'parallel', include: ['test/*.test.ts'], exclude: dockerTests,
        sequence: { groupOrder: 0 } } },
      { test: { name: 'docker', include: dockerTests, fileParallelism: false,
        sequence: { groupOrder: 1 } } },
    ],
  },
});

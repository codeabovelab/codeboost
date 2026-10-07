import { describe, expect, it, vi } from 'vitest';

vi.mock('../agents/process-group.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/process-group.ts')>();
  return { ...actual, runInProcessGroup: async () => ({ status: null, stdout: 'partial', stderr: '',
    error: Object.assign(new Error('descendant remains'), { code: 'EGROUPALIVE' }) }) };
});

const { runTrackedProcess } = await import('../agents/tracked-docker.ts');

describe('tracked subprocess unsettled ownership', () => {
  it('preserves the unsettled outcome code when the durable ownership callback also fails', async () => {
    const result = await runTrackedProcess('git', ['clone'], { env: {}, timeoutMs: 1_000,
      lifecycle: {
        starting: () => {}, started: () => {}, settled: () => {},
        unsettled: () => { throw new Error('durable marker write failed'); },
      } });
    expect(result).toMatchObject({ status: null, stdout: 'partial', error: { code: 'EGROUPALIVE' } });
    expect((result.error as Error).cause).toMatchObject({ message: 'durable marker write failed' });
  });
});

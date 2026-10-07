import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ outcome: { status: null as number | null, stdout: 'partial', stderr: '',
  error: Object.assign(new Error('descendant remains'), { code: 'EGROUPALIVE' }) as Error | undefined } }));
vi.mock('../agents/process-group.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../agents/process-group.ts')>();
  return { ...actual, runInProcessGroup: async () => state.outcome };
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
    const causes = ((result.error as Error).cause as AggregateError).errors;
    expect(causes).toMatchObject([{ message: 'descendant remains', code: 'EGROUPALIVE' },
      { message: 'durable marker write failed' }]);
  });

  it('preserves a timeout or cancellation reason when the settlement callback also fails', async () => {
    for (const [code, name] of [['ETIMEDOUT', 'Error'], ['ABORT_ERR', 'AbortError']] as const) {
      state.outcome = { status: null, stdout: 'partial', stderr: '',
        error: Object.assign(new Error(code === 'ETIMEDOUT' ? 'original timeout' : 'original cancellation'), { code, name }) };
      const result = await runTrackedProcess('git', ['clone'], { env: {}, timeoutMs: 1_000,
        lifecycle: { starting: () => {}, started: () => {}, unsettled: () => {},
          settled: () => { throw new Error('settlement write failed'); } } });
      expect(result).toMatchObject({ status: null, error: { code } });
      expect(((result.error as Error).cause as AggregateError).errors).toMatchObject([
        { message: code === 'ETIMEDOUT' ? 'original timeout' : 'original cancellation', code },
        { message: 'settlement write failed' },
      ]);
    }
  });

  it('preserves a nonzero exit and composes it with settlement failure', async () => {
    state.outcome = { status: 7, stdout: '', stderr: 'failed', error: undefined };
    const result = await runTrackedProcess('git', ['clone'], { env: {}, timeoutMs: 1_000,
      lifecycle: { starting: () => {}, started: () => {}, unsettled: () => {},
        settled: () => { throw new Error('settlement write failed'); } } });
    expect(result).toMatchObject({ status: null, stderr: 'failed' });
    expect(((result.error as Error).cause as AggregateError).errors).toMatchObject([
      { message: 'git clone exited with status 7.', status: 7 }, { message: 'settlement write failed' },
    ]);
  });
});

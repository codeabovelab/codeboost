import { afterEach, describe, expect, it, vi } from 'vitest';

// runDocker must keep the daemon's answer when a cancel lands after the client exited (#51 item 2).
const calls = vi.hoisted(() => ({ finish: undefined as undefined | ((error: unknown, stdout: string, stderr: string) => void) }));
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string,
    stderr: string) => void) => { calls.finish = callback; return {}; }),
}));
const { runDocker } = await import('../agents/docker.ts');
const { createOutcomeUnknown } = await import('../agents/client-outcome.ts');

describe('runDocker exit classification', () => {
  afterEach(() => { calls.finish = undefined; });

  it('keeps a daemon-answered exit status when the signal is aborted before the callback runs', async () => {
    const controller = new AbortController();
    const pending = runDocker(['create', '--name', 'taken'], { timeoutMs: 5_000, signal: controller.signal });
    // The client already exited 1 (name conflict); the cancel arrives before Node delivers the result.
    controller.abort();
    calls.finish!(Object.assign(new Error('Command failed'), { code: 1, killed: false }), '', 'Conflict. The name is in use');
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 1, stderr: 'Conflict. The name is in use' });
    expect(outcome.error).toBeUndefined();
    expect(createOutcomeUnknown({ status: outcome.status })).toBe(false);
  });

  it('reports a client killed by the abort as cancelled, with the outcome unknown', async () => {
    const controller = new AbortController();
    const pending = runDocker(['create', '--name', 'x'], { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    calls.finish!(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), '', '');
    const outcome = await pending;
    expect(outcome.status).toBeNull();
    expect(outcome.error?.message).toContain('was cancelled');
    expect(createOutcomeUnknown({ status: null, cause: outcome.error })).toBe(true);
  });

  it('reports a client killed at its deadline as a timeout', async () => {
    const pending = runDocker(['create'], { timeoutMs: 5_000 });
    calls.finish!(Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGKILL' }), '', '');
    const outcome = await pending;
    expect(outcome.status).toBeNull();
    expect((outcome.error as { code?: unknown }).code).toBe('ETIMEDOUT');
  });
});

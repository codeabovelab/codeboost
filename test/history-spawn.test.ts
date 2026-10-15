import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

// A Git process that never starts: Node reports the spawn error to execFile's callback, the child has no PID, and
// (for EMFILE and ENFILE) it may never emit `close`.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: Buffer) => void) => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: null });
    setImmediate(() => callback(Object.assign(new Error('spawn git EMFILE'), { code: 'EMFILE' }), Buffer.alloc(0)));
    return child;
  }) };
});
const { readHistory } = await import('../git/history.ts');

it('fails a history read at once when its Git process cannot start, without waiting for a close that never comes', async () => {
  const started = performance.now();
  await expect(readHistory('.', 'HEAD', 'HEAD', { maxDurationMs: 30_000 })).rejects.toMatchObject({ code: 'EMFILE' });
  expect(performance.now() - started).toBeLessThan(5_000);
});

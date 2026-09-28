import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOutcomeUnknown } from '../agents/client-outcome.ts';

// A failed create leaves its object possibly present only if the request may have reached the daemon (#51 item 1).
describe('create outcome classification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-outcome-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const failure = (run: () => unknown) => { try { run(); } catch (error) { return error; } throw new Error('did not fail'); };

  it('treats a client that never started as having created nothing', () => {
    expect(createOutcomeUnknown(failure(() => execFileSync('codeboost-no-such-docker', [],
      { env: { PATH: dir }, stdio: 'ignore' })))).toBe(false);
    const notExecutable = join(dir, 'docker');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    expect(createOutcomeUnknown(failure(() => execFileSync(notExecutable, [], { stdio: 'ignore' })))).toBe(false);
  });

  it('treats a daemon-answered failure as known and a killed client as unknown', () => {
    expect(createOutcomeUnknown(failure(() => execFileSync('sh', ['-c', 'exit 3'], { stdio: 'ignore' })))).toBe(false);
    expect(createOutcomeUnknown(failure(() => execFileSync('sleep', ['5'],
      { timeout: 50, killSignal: 'SIGKILL', stdio: 'ignore' })))).toBe(true);
  });

  it('reads the cause of a wrapped client error', () => {
    expect(createOutcomeUnknown({ status: null, cause: { code: 'ENOENT' } })).toBe(false);
    expect(createOutcomeUnknown({ status: null, cause: { code: 'ETIMEDOUT' } })).toBe(true);
    expect(createOutcomeUnknown({ status: null })).toBe(true);
  });
});

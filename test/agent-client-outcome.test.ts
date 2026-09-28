import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOutcomeUnknown } from '../agents/client-outcome.ts';
import { docker } from '../agents/docker.ts';

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

  it('treats a call cancelled before its client started as having created nothing, and a killed one as unknown', async () => {
    // Cancel lands between two setup steps: the next create is refused before any client runs.
    const cancelled = new AbortController(); cancelled.abort();
    const before = await docker(['network', 'create', 'unused'], { timeoutMs: 1_000, signal: cancelled.signal })
      .then(() => undefined, (error: unknown) => error);
    expect(createOutcomeUnknown(before)).toBe(false);
    // A cancel that kills a client already in flight leaves the outcome unknown.
    // The first test left a non-executable `docker` here, and `mode` applies only when a file is created, so set it:
    // otherwise the real Docker CLI further down PATH runs instead, and the outcome depends on its daemon.
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(dir, 'docker'), 0o755);
    const path = process.env.PATH; process.env.PATH = `${dir}:${path}`;
    try {
      const inflight = new AbortController();
      const pending = docker(['network', 'create', 'unused'], { timeoutMs: 10_000, signal: inflight.signal })
        .then(() => undefined, (error: unknown) => error);
      setTimeout(() => inflight.abort(), 100);
      expect(createOutcomeUnknown(await pending)).toBe(true);
    } finally { process.env.PATH = path; }
  });
});

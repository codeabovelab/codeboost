import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { removeLabelledObjects } from './fixtures/docker-sweep.ts';

// The test sweep's handling of output it cannot read (#189). The `docker` on PATH answers as no real daemon does: for
// `network ls` it prints a line that is not JSON, a JSON null and one network without a name, and it answers every
// other call with nothing and exit 0. What Docker 27.4 really prints is covered against the daemon in agent-container.
const roots: string[] = [], savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('skips output that is not a network, reports what is not JSON, and never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' 'not json' 'null' '{"ID":"abc"}'; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  process.env.PATH = `${root}:${savedPath}`;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(() => removeLabelledObjects('io.codeboost.test-run', 'x', 'test')).not.toThrow();
  expect(warn.mock.calls.map(call => String(call[0]))).toContain('test: docker printed a line that is not JSON:');
  // Nothing it could not read is removed or looked up as a holder.
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => /^(ps|rm|network rm|volume rm|container rm|container inspect) /.test(line))).toEqual([]);
});

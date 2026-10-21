import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { removeLabelledObjects, TEST_RUN_LABEL } from './fixtures/docker-sweep.ts';

// The test sweep's handling of output it cannot read (#189). The fake `docker` answers as no real daemon does for
// `network ls`: a line that is not JSON, a JSON null and one network without a name. To every other call it answers
// nothing and exit 0, as Docker 27.4 does for `ls` with no match; the sweep reads only stdout, the exit status and
// whether a signal killed the call, and stderr only to report a failure. What Docker 27.4 really prints is covered against the daemon in agent-container.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('skips output that is not a network, reports what is not JSON, and never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' 'not json' 'null' '{"ID":"abc"}'; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(() => removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'))).not.toThrow();
  expect(warn.mock.calls.map(call => String(call[0]))).toContain('test: docker printed a line that is not JSON:');
  // Nothing it could not read is removed or looked up as a holder.
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => /^(ps|rm|network rm|volume rm|container rm|container inspect) /.test(line))).toEqual([]);
});

it('reads nothing from a docker call that was killed, whose output may be cut short', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  // A well-formed network line, then the client is killed by a signal before it exits by itself.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"${'a'.repeat(64)}","Name":"swept"}'; kill -9 $$; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => /^(ps|network rm) /.test(line))).toEqual([]);
});

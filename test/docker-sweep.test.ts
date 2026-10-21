import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { removeByName, removeLabelledObjects, TEST_RUN_LABEL } from './fixtures/docker-sweep.ts';

// The test sweep's handling of output it cannot read (#189). The fake `docker` answers as no real daemon does for
// `network ls`: a line that is not JSON, a JSON null and one network without a name. To every other call it answers
// nothing and exit 0, as Docker 27.4 does for `ls` with no match; the sweep reads only stdout, the exit status,
// whether a signal killed the call and whether it could start, and stderr only to report a failure. What Docker 27.4
// really prints is covered against the daemon in agent-container.
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
  // The fake does what this test needs: a network line on stdout, then death by a signal.
  const direct = spawnSync(join(root, 'docker'), ['network', 'ls'], { encoding: 'utf8' });
  expect([direct.status, direct.signal, direct.stdout]).toEqual([null, 'SIGKILL', `{"ID":"${'a'.repeat(64)}","Name":"swept"}\n`]);
  rmSync(calls);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => /^(ps|network rm) /.test(line))).toEqual([]);
  expect(warn.mock.calls).toContainEqual(['test: docker network ls failed:', 'killed by SIGKILL']);
});

it('removes by name only an object of exactly that name, and reports failures other than no such object', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls'), id = 'b'.repeat(64);
  // Answers as Docker 27.4 does, read for `--format '{{json .Id}} {{json .Name}}'`: a missing name, another object found
  // by an ID prefix, one whose removal is refused, and an inspect killed by a signal.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    'for arg; do name="$arg"; done',
    'if [ "$2" = inspect ]; then case "$name" in',
    "  gone) echo 'Error response from daemon: No such container: gone' >&2; exit 1;;",
    `  prefix) printf '%s\\n' '"${id}" "/someone-else"';;`,
    `  busy) printf '%s\\n' '"${id}" "/busy"';;`,
    '  killed) kill -9 $$;;', 'esac; exit 0; fi',
    "if [ \"$1\" = rm ]; then echo 'Error response from daemon: conflict' >&2; exit 1; fi", 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const name of ['gone', 'prefix', 'busy', 'killed']) removeByName('container', name, join(root, 'docker'));
  // Only the exact name is removed, and by its full ID.
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => line.startsWith('rm '))).toEqual([`rm --force ${id}`]);
  expect(warn.mock.calls).toEqual([
    ['removing container busy: docker container rm failed:', 'Error response from daemon: conflict'],
    ['removing container killed: docker inspect failed:', 'killed by SIGKILL'],
  ]);
});

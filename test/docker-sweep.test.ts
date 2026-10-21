import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { removeByName, removeLabelledObjects, TEST_RUN_LABEL } from './fixtures/docker-sweep.ts';

// The test sweep's and `removeByName`'s handling of answers they cannot use (#189), each test with its own fake
// `docker`, described beside it. The sweep reads only stdout, the exit status, whether a signal killed the call and
// whether it could start, and stderr only to report a failure; `removeByName` also reads an inspect's stderr to tell a
// missing object from a failure. Against the daemon, agent-container's holder test covers the sweep and removeByName's
// removal, its silence on a missing name, and its refusal of an object found by an ID prefix.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// The fake answers as no real daemon does for `network ls`: a line that is not JSON, a JSON null and one network
// without a name. To every other call it answers nothing and exit 0, as Docker 27.4 does for `ls` with no match.
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
  const calls = join(root, 'calls'), id = 'b'.repeat(64), other = 'c'.repeat(64);
  // Answers as Docker 27.4 does for `inspect --format '{{json .Id}} {{json .Name}}'` (a volume: '{{json .Name}}') and
  // `rm`, in the parts removeByName reads: stdout of an inspect that succeeded, stderr and the exit status. A missing
  // object, an object found under another name (by an ID prefix), a refused removal, an inspect killed by a signal, and a
  // failure before the daemon (an unknown context). The stdout of a failed call, a bare newline in 27.4, is not read.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    'for arg; do name="$arg"; done',
    'if [ "$2" = inspect ]; then case "$1 $name" in',
    "  'container gone') echo; echo 'Error response from daemon: No such container: gone' >&2; exit 1;;",
    "  'network gone') echo; echo 'Error response from daemon: network gone not found' >&2; exit 1;;",
    "  'volume gone') echo; echo 'Error response from daemon: get gone: no such volume' >&2; exit 1;;",
    `  'container prefix') printf '%s\\n' '"${id}" "/someone-else"';;`,
    `  'network prefix') printf '%s\\n' '"${other}" "someone-else"';;`,
    `  'container busy') printf '%s\\n' '"${id}" "/busy"';;`,
    `  'network busy') printf '%s\\n' '"${other}" "busy"';;`,
    `  'volume busy') printf '%s\\n' '"busy"';;`,
    "  'container killed') kill -9 $$;;",
    "  'container lost') echo 'Failed to initialize: unable to resolve docker endpoint: context \"x\": context not found: open /x/meta.json: no such file or directory' >&2; exit 1;;",
    'esac; exit 0; fi',
    `if [ "$1" = rm ]; then echo 'Error response from daemon: removal of container ${id} is already in progress' >&2; exit 1; fi`,
    `if [ "$1 $2" = 'network rm' ]; then echo 'Error response from daemon: error while removing network: network busy id ${other} has active endpoints' >&2; exit 1; fi`,
    `if [ "$1 $2" = 'volume rm' ]; then echo 'Error response from daemon: remove busy: volume is in use - [${id}]' >&2; exit 1; fi`,
    'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const objects = [['container', 'gone'], ['network', 'gone'], ['volume', 'gone'], ['container', 'prefix'], ['network', 'prefix'],
    ['container', 'busy'], ['network', 'busy'], ['volume', 'busy'], ['container', 'killed'], ['container', 'lost']] as const;
  for (const [kind, name] of objects) removeByName(kind, name, join(root, 'docker'));
  // Only the exact names are removed, by full ID (a volume's name is its ID).
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => / rm |^rm /.test(line)))
    .toEqual([`rm --force ${id}`, `network rm ${other}`, 'volume rm --force busy']);
  expect(warn.mock.calls).toEqual([
    ['removing container busy: docker container rm failed:',
      `Error response from daemon: removal of container ${id} is already in progress`],
    ['removing network busy: docker network rm failed:',
      `Error response from daemon: error while removing network: network busy id ${other} has active endpoints`],
    ['removing volume busy: docker volume rm failed:', `Error response from daemon: remove busy: volume is in use - [${id}]`],
    ['removing container killed: docker inspect failed:', 'killed by SIGKILL'],
    ['removing container lost: docker inspect failed:',
      'Failed to initialize: unable to resolve docker endpoint: context "x": context not found: open /x/meta.json: no such file or directory'],
  ]);
});

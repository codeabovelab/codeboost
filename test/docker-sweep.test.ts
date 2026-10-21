import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { removeByName, removeLabelledObjects, TEST_RUN_LABEL } from './fixtures/docker-sweep.ts';
import type * as Sweep from './fixtures/docker-sweep.ts';

// The test sweep's and `removeByName`'s handling of answers they cannot use (#189), each test with its own fake
// `docker`, described beside it. The sweep reads only stdout, the exit status, whether a signal killed the call and
// whether it could start, and stderr to report a failure, and, for its read of holders and its removal of networks, to
// tell one gone since the listing ("No such container", "network <ID> not found") from a failure. `removeByName` reads
// the same, and also an inspect's stdout (the ID and name) and its stderr, to tell a missing object from a failure, and
// a network removal's stderr, to tell a network gone since its inspect. Against the daemon, agent-container's holder
// test covers the sweep and removeByName's removal, its silence on a missing name, and its refusal of an object found
// by an ID prefix.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// The fake answers as no real daemon does for `network ls`: a line that is not JSON, a JSON null and one network
// without a name. To every other call it answers nothing and exit 0, as Docker 27.4 does for `ls` with no match.
it('skips and reports output that is not a network, and never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' 'not json' 'null' '{"ID":"abc"}'; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(() => removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'))).not.toThrow();
  expect(warn.mock.calls).toEqual([['test: listing networks: docker printed a line that is not JSON:', 'not json'],
    ['test: listing networks: docker printed a line that is not a network:', 'null'],
    ['test: listing networks: docker printed a line that is not a network:', '{"ID":"abc"}']]);
  // Nothing it could not read is removed or looked up as a holder.
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => /^(ps|rm|network rm|volume rm|container rm|container inspect) /.test(line))).toEqual([]);
});

it('reads nothing from a docker call that was killed, whose output may be cut short', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  // A well-formed network line, then the client is killed by a signal before it exits by itself. The line holds only
  // the fields the sweep reads (Docker 27.4 also prints CreatedAt, Driver, IPv6, Internal, Labels and Scope); every
  // other call gets no output and exit 0, as Docker 27.4 gives for `ls` with no match.
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
  expect(warn.mock.calls).toContainEqual([`test: listing networks: docker network ls --no-trunc --format {{json .}} --filter label=${TEST_RUN_LABEL}=x failed:`,
    'killed by SIGKILL']);
});

it('removes by name only an object of exactly that name, and reports failures other than no such object', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls'), id = 'b'.repeat(64), other = 'c'.repeat(64), raced = 'd'.repeat(64);
  // Answers as Docker 27.4 does for `inspect --format '{{json .Id}} {{json .Name}}'` (a volume: '{{json .Name}}') and
  // `rm`, in the parts removeByName reads: stdout of an inspect that succeeded, stderr and the exit status. A missing
  // object, an object found under another name (by an ID prefix), a refused removal, an inspect killed by a signal, and
  // a failure before the daemon (an unknown context; its meta.json path shortened). Also a network gone between its
  // inspect and its removal, which 27.4 answers "network <ID> not found", and inspect answers that are not JSON or not
  // an ID and a name, which 27.4 is not known to give. The stdout of a failed call (a bare newline for a missing object
  // in 27.4, nothing for the others) is not read.
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
    `  'network raced') printf '%s\\n' '"${raced}" "raced"';;`,
    "  'container junk') echo 'not json';;",
    "  'container odd') echo '1 2';;",
    "  'container nospace') echo '\"nospace\"';;",
    "  'container optid') echo '\"--help\" \"/optid\"';;",
    "  'container killed') kill -9 $$;;",
    "  'container lost') echo 'Failed to initialize: unable to resolve docker endpoint: context \"x\": context not found: open /x/meta.json: no such file or directory' >&2; exit 1;;",
    'esac; exit 0; fi',
    `if [ "$1" = rm ]; then echo 'Error response from daemon: removal of container ${id} is already in progress' >&2; exit 1; fi`,
    `if [ "$1 $2 $3" = 'network rm ${raced}' ]; then echo 'Error response from daemon: network ${raced} not found' >&2; exit 1; fi`,
    `if [ "$1 $2" = 'network rm' ]; then echo 'Error response from daemon: error while removing network: network busy id ${other} has active endpoints' >&2; exit 1; fi`,
    `if [ "$1 $2" = 'volume rm' ]; then echo 'Error response from daemon: remove busy: volume is in use - [${id}]' >&2; exit 1; fi`,
    'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const objects = [['container', 'gone'], ['network', 'gone'], ['volume', 'gone'], ['container', 'prefix'], ['network', 'prefix'],
    ['container', 'busy'], ['network', 'busy'], ['volume', 'busy'], ['container', 'killed'], ['container', 'lost'],
    ['network', 'raced'], ['container', 'junk'], ['container', 'odd'], ['container', 'nospace'], ['container', 'optid']] as const;
  expect(() => { for (const [kind, name] of objects) removeByName(kind, name, 'test', join(root, 'docker')); }).not.toThrow();
  // Only the exact names are removed, by full ID (a volume's name is its ID).
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => / rm |^rm /.test(line)))
    .toEqual([`rm --force ${id}`, `network rm ${other}`, 'volume rm --force busy', `network rm ${raced}`]);
  expect(warn.mock.calls).toEqual([
    [`test: removing container busy: docker rm --force ${id} failed:`,
      `Error response from daemon: removal of container ${id} is already in progress`],
    [`test: removing network busy: docker network rm ${other} failed:`,
      `Error response from daemon: error while removing network: network busy id ${other} has active endpoints`],
    ['test: removing volume busy: docker volume rm --force busy failed:', `Error response from daemon: remove busy: volume is in use - [${id}]`],
    ['test: removing container killed: docker container inspect --format {{json .Id}} {{json .Name}} killed failed:', 'killed by SIGKILL'],
    ['test: removing container lost: docker container inspect --format {{json .Id}} {{json .Name}} lost failed:',
      'Failed to initialize: unable to resolve docker endpoint: context "x": context not found: open /x/meta.json: no such file or directory'],
    ['test: removing container junk: docker printed what is not JSON:', 'not json\n'],
    ['test: removing container odd: docker printed no ID and name:', '1 2\n'],
    ['test: removing container nospace: docker printed what is not JSON:', '"nospace"\n'],
    ['test: removing container optid: docker printed no ID and name:', '"--help" "/optid"\n'],
  ]);
});

it('talks to the daemon set when it loaded, though a test changed DOCKER_HOST or DOCKER_CONTEXT since', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const seen = join(root, 'seen');
  // Records the address each call is given, and answers as Docker 27.4 does for a missing container and an empty `ls`.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s|%s\\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" >> '${seen}'`,
    'if [ "$2" = inspect ]; then echo; echo "Error response from daemon: No such container: x" >&2; exit 1; fi', 'exit 0'].join('\n'),
  { mode: 0o755 });
  const loaded = `${process.env.DOCKER_HOST ?? 'unset'}|${process.env.DOCKER_CONTEXT ?? 'unset'}`;
  vi.stubEnv('DOCKER_HOST', 'unix:///codeboost-missing.sock');
  vi.stubEnv('DOCKER_CONTEXT', 'codeboost-missing');
  try {
    removeByName('container', 'x', 'test', join(root, 'docker'));
    removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  } finally { vi.unstubAllEnvs(); }
  const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(1);
  expect(new Set(lines)).toEqual(new Set([loaded]));
});

it('takes the daemon set at load, not the default, when one was set, for every call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const seen = join(root, 'seen'), net = 'f'.repeat(64), holder = 'a'.repeat(64), named = 'b'.repeat(64), labelled = 'c'.repeat(64);
  const volumeHolder = 'e'.repeat(64);
  // Records the address and the whole command of each call. Answers as Docker 27.4 does, in the parts the code reads,
  // for one labelled container, one swept network and one swept volume, each held by one container, and for a container
  // named x; every other call gets no output and exit 0, and the removals' stdout is not read. The network line holds
  // only the fields the sweep reads, and the holder's inspect an empty endpoint for its network.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', 'for arg; do last="$arg"; done',
    `printf '%s|%s|%s\\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" "$*" >> '${seen}'`,
    `if [ "$1 $2" = "container ls" ]; then printf '%s\\n' ${labelled}; exit 0; fi`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"${net}","Name":"swept"}'; exit 0; fi`,
    `if [ "$1 $2" = "volume ls" ]; then printf '%s\\n' swept-volume; exit 0; fi`,
    `if [ "$1" = ps ] && [ "$last" = volume=swept-volume ]; then printf '%s\\n' ${volumeHolder}; exit 0; fi`,
    `if [ "$1" = ps ]; then printf '%s\\n' ${holder}; exit 0; fi`,
    `if [ "$1 $2" = "container inspect" ] && [ "$last" = x ]; then printf '%s\\n' '"${named}" "/x"'; exit 0; fi`,
    `if [ "$1 $2" = "container inspect" ]; then printf '%s\\n' '"${holder}" {"swept":{}}'; exit 0; fi`,
    'exit 0'].join('\n'),
  { mode: 0o755 });
  // A fresh copy of the module, loaded while a daemon is set, as on a machine with Colima or rootless Docker.
  vi.stubEnv('DOCKER_HOST', 'unix:///codeboost-loaded.sock');
  vi.stubEnv('DOCKER_CONTEXT', 'codeboost-loaded');
  vi.resetModules();
  const fresh = await import('./fixtures/docker-sweep.ts') as typeof Sweep;
  vi.stubEnv('DOCKER_HOST', 'unix:///codeboost-changed.sock');
  vi.stubEnv('DOCKER_CONTEXT', 'codeboost-changed');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    fresh.removeByName('container', 'x', 'test', join(root, 'docker'));
    fresh.removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  } finally { vi.unstubAllEnvs(); }
  const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean).map(line => line.split('|'));
  const commands = lines.map(line => line[2]);
  // Every call the two make, each checked by its own command line.
  for (const command of [
    `container inspect --format {{json .Id}} {{json .Name}} x`, `rm --force ${named}`,
    `container ls --all --quiet --no-trunc --filter label=${TEST_RUN_LABEL}=x`, `container rm --force ${labelled}`,
    `network ls --no-trunc --format {{json .}} --filter label=${TEST_RUN_LABEL}=x`,
    'ps --all --quiet --no-trunc --filter network=swept',
    `container inspect --format {{json .Id}} {{json .NetworkSettings.Networks}} ${holder}`, `rm --force ${holder}`,
    `network rm ${net}`,
    `volume ls --quiet --filter label=${TEST_RUN_LABEL}=x`, 'ps --all --quiet --no-trunc --filter volume=swept-volume',
    `rm --force ${volumeHolder}`, 'volume rm --force swept-volume',
  ]) expect(commands).toContain(command);
  expect(new Set(lines.map(line => `${line[0]}|${line[1]}`))).toEqual(new Set(['unix:///codeboost-loaded.sock|codeboost-loaded']));
});

it('says nothing of a network gone since the listing, and reports any other failure to remove one', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const net = 'd'.repeat(64), answer = join(root, 'answer');
  // Answers as Docker 27.4 does for one swept network with no holder, whose removal gives the stderr in `answer`; every
  // other call gets no output and exit 0, as for `ls` with no match. The network line holds only the fields the sweep
  // reads. The second answer is invented, as a failure 27.4 might give.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh',
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"${net}","Name":"swept"}'; exit 0; fi`,
    `if [ "$1 $2" = "network rm" ]; then cat '${answer}' >&2; exit 1; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const failures = () => warn.mock.calls.filter(call => String(call[0]).endsWith('failed:'));
  writeFileSync(answer, `Error response from daemon: network ${net} not found\n`);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(failures()).toEqual([]);
  writeFileSync(answer, 'Error response from daemon: permission denied\n');
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(failures()).toEqual([[`test: removing networks: docker network rm ${net} failed:`, 'Error response from daemon: permission denied']]);
});

it.each([
  ['says nothing of a holder gone since the listing', 'Error response from daemon: No such container: b', []],
  ['reports any other failure to read the holders', 'permission denied', [['test: reading holders: docker container inspect --format {{json .Id}} {{json .NetworkSettings.Networks}} HOLDERS failed:', 'permission denied']]],
])('%s, and still removes the holders it read', (_label, stderr, warnings) => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls'), net = 'f'.repeat(64), a = 'a'.repeat(64), b = 'b'.repeat(64);
  // Answers as Docker 27.4 does for one swept network with two candidate holders, one gone before the inspect: the
  // inspect prints the other and exits 1. Every other call gets no output and exit 0, as for `ls` with no match; the
  // removals' stdout (the removed IDs or names in 27.4) is not read. The second case's answer is invented: it stands in
  // for an unexpected inspect failure that still printed some holders, which 27.4 is not known to give. The network
  // line holds only the fields the sweep reads (27.4 also prints CreatedAt, Driver, IPv6, Internal, Labels and Scope),
  // and the inspect an empty endpoint for the network, where 27.4 gives its full settings: the sweep reads only the
  // network names.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"${net}","Name":"swept"}'; exit 0; fi`,
    `if [ "$1" = ps ]; then printf '%s\\n' ${a} ${b}; exit 0; fi`,
    `if [ "$1 $2" = "container inspect" ]; then printf '%s\\n' '"${a}" {"swept":{}}'; echo '${stderr}' >&2; exit 1; fi`,
    'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(warn.mock.calls.filter(call => String(call[0]).endsWith('failed:')))
    .toEqual(warnings.map(([line, cause]) => [line!.replace('HOLDERS', `${a} ${b}`), cause]));
  expect(readFileSync(calls, 'utf8').split('\n')).toContain(`rm --force ${a}`);
});

it('finds the real docker once, at load, uses it by default, and refuses a shim when none was found', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  // Two directories, each with a docker and the sh the lookup runs, and one with only sh. Each docker records its calls
  // and answers as Docker 27.4 does for a missing container and for an `ls` with no match; nothing else is asked of it.
  const bin = (name: string, docker: boolean) => {
    const dir = join(root, name); mkdirSync(dir);
    symlinkSync(spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim(), join(dir, 'sh'));
    if (docker) writeFileSync(join(dir, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${join(dir, 'calls')}'`,
      'if [ "$2" = inspect ]; then echo; echo "Error response from daemon: No such container: x" >&2; exit 1; fi', 'exit 0'].join('\n'),
    { mode: 0o755 });
    return dir;
  };
  const first = bin('first', true), second = bin('second', true), none = bin('none', false);
  // A relative PATH entry, resolved at load.
  vi.stubEnv('PATH', relative(process.cwd(), first));
  vi.resetModules();
  const loaded = await import('./fixtures/docker-sweep.ts') as typeof Sweep;
  // A shim put on PATH later does not change it, and the removals use it when given no docker.
  vi.stubEnv('PATH', second);
  expect(loaded.REAL_DOCKER).toBe(join(first, 'docker'));
  expect(loaded.requireRealDocker()).toBe(join(first, 'docker'));
  loaded.removeByName('container', 'x', 'test');
  loaded.removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test');
  expect(readFileSync(join(first, 'calls'), 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(1);
  expect(existsSync(join(second, 'calls'))).toBe(false);
  vi.stubEnv('PATH', none);
  vi.resetModules();
  const missing = await import('./fixtures/docker-sweep.ts') as typeof Sweep;
  expect(() => missing.requireRealDocker()).toThrow('No docker on PATH when the test files loaded.');
});

it('reports a holder line that is not an ID and networks, and removes no holder from it', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls'), net = 'd'.repeat(64);
  // One swept network with one candidate holder, whose inspect line parses but is not an ID and networks, which Docker
  // 27.4 is not known to print. Every other call gets no output and exit 0, as for `ls` with no match. The network line
  // holds only the fields the sweep reads.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"${net}","Name":"swept"}'; exit 0; fi`,
    `if [ "$1" = ps ]; then printf '%s\\n' ${'a'.repeat(64)}; exit 0; fi`,
    `if [ "$1 $2" = "container inspect" ]; then printf '%s\\n' '123 null' '"--all" {"swept":{}}'; exit 0; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(warn.mock.calls).toContainEqual(['test: reading holders: docker printed a line that is not an ID and networks:', '123 null']);
  expect(warn.mock.calls).toContainEqual(['test: reading holders: docker printed a line that is not an ID and networks:', '"--all" {"swept":{}}']);
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => line.startsWith('rm '))).toEqual([]);
});

it('reports and skips listed lines that are not a container ID, a network or a volume name, so none becomes an option', () => {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-sweep-')); roots.push(root);
  const calls = join(root, 'calls');
  // Lines Docker 27.4 is not known to print for these listings; every other call gets no output and exit 0, as for
  // `ls` with no match.
  writeFileSync(join(root, 'docker'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "container ls" ]; then printf '%s\\n' '--all'; exit 0; fi`,
    `if [ "$1 $2" = "volume ls" ]; then printf '%s\\n' '-v'; exit 0; fi`,
    `if [ "$1 $2" = "network ls" ]; then printf '%s\\n' '{"ID":"--help","Name":"x"}'; exit 0; fi`, 'exit 0'].join('\n'),
  { mode: 0o755 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  removeLabelledObjects(TEST_RUN_LABEL, 'x', 'test', join(root, 'docker'));
  expect(warn.mock.calls).toEqual([['test: listing containers: docker printed a line that is not a container ID:', '--all'],
    ['test: listing networks: docker printed a line that is not a network:', '{"ID":"--help","Name":"x"}'],
    ['test: listing volumes: docker printed a line that is not a volume name:', '-v']]);
  expect(readFileSync(calls, 'utf8').split('\n').filter(line => / rm |^rm |^ps /.test(line))).toEqual([]);
});

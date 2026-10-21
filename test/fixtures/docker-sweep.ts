import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { RUNNER_LABEL } from '../../agents/labels.ts';

/**
 * The real `docker`, found once when this module loads, before any test puts a shim on PATH. A sweep that runs while a
 * shim is still on PATH (after a test timed out inside one) would otherwise wait on the shim's own child, which the
 * call's SIGKILL does not reach.
 */
const FOUND_DOCKER = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout?.trim();
// Resolved, as a PATH entry may be relative.
export const REAL_DOCKER = FOUND_DOCKER ? resolve(FOUND_DOCKER) : 'docker';
/**
 * The daemon `docker` talks to when this module loads. A test that times out may leave DOCKER_HOST or DOCKER_CONTEXT
 * changed (agent-supervisor points DOCKER_HOST at a missing socket until its handle settles), so every call here
 * runs with the values they had when this module loaded.
 */
const LOADED_ENV = { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
const dockerEnv = () => {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(LOADED_ENV)) if (value === undefined) delete env[name]; else env[name] = value;
  return env;
};
/**
 * A Docker client call's own limit, for a test's synchronous calls (#189): no Vitest timer can stop one, so a stalled
 * daemon would otherwise hold the whole suite.
 */
export const CLIENT_LIMIT = { timeout: 60_000, killSignal: 'SIGKILL' as const };
/** The real `docker` for a shim to call; refuses when none was found, since a shim calling `docker` would call itself. */
export function requireRealDocker(): string {
  if (!isAbsolute(REAL_DOCKER)) throw new Error('No docker on PATH when the test files loaded.');
  return REAL_DOCKER;
}

/**
 * The label a test (most often through its Docker shim) adds to an object it makes without the runner label (#189),
 * so the test can still find and remove that object however the test ends. No codeboost code writes or reads it.
 */
export const TEST_RUN_LABEL = 'io.codeboost.test-run';
/** Beside it, one value per test file run, so afterAll removes them all with one sweep. */
export const TEST_FILE_LABEL = 'io.codeboost.test-file';

/**
 * Removes the container, network or volume named exactly `name`, by its full ID (a volume by its name, which is its
 * ID). Docker would read a missing name as an ID prefix, so an object found under another name is left alone. It
 * reports, prefixed with `when`, a failed call and an answer it cannot read, but not an object that is gone: an inspect
 * that finds no such object, or a network gone between its inspect and its removal. It never throws; each call has a
 * 30 s limit.
 */
export function removeByName(kind: 'container' | 'network' | 'volume', name: string, when: string, docker = REAL_DOCKER): void {
  const options = { encoding: 'utf8' as const, timeout: 30_000, killSignal: 'SIGKILL' as const, env: dockerEnv() };
  const failed = (result: SpawnSyncReturns<string>, what: string) => console.warn(`${when}: removing ${kind} ${name}: docker ${what} failed:`,
    result.error?.message ?? (result.signal ? `killed by ${result.signal}` : result.stderr.trim()));
  // As JSON: a network's name may hold spaces. Only a container's name comes with a leading slash.
  const found = spawnSync(docker, [kind, 'inspect', '--format', kind === 'volume' ? '{{json .Name}}' : '{{json .Id}} {{json .Name}}', name], options);
  // Docker 27.4's answers for a missing object, each naming it, so a failure before the daemon (an unknown context's
  // "context not found: … no such file or directory") is still reported.
  const missing = { container: `No such container: ${name}`, network: `network ${name} not found`, volume: `get ${name}: no such volume` }[kind];
  if (found.error || found.status !== 0) { if (found.status === null || !found.stderr.includes(missing)) failed(found, `${kind} inspect`); return; }
  let id: unknown, actual: unknown;
  try {
    const at = found.stdout.indexOf(' ');
    [id, actual] = kind === 'volume' ? [name, JSON.parse(found.stdout)] : [JSON.parse(found.stdout.slice(0, at)), JSON.parse(found.stdout.slice(at + 1))];
  } catch { console.warn(`${when}: removing ${kind} ${name}: docker printed what is not JSON:`, found.stdout); return; }
  if (typeof id !== 'string' || typeof actual !== 'string') {
    console.warn(`${when}: removing ${kind} ${name}: docker printed no ID and name:`, found.stdout); return;
  }
  if ((kind === 'container' ? actual.replace(/^\//, '') : actual) !== name) return;
  const removed = spawnSync(docker, kind === 'container' ? ['rm', '--force', id] : [kind, 'rm', ...(kind === 'volume' ? ['--force'] : []), id], options);
  // A network gone since the inspect is gone: Docker 27.4 answers "network <ID> not found" (rm --force of a missing
  // container or volume exits 0).
  const raced = kind === 'network' && removed.status === 1 && removed.stderr.includes(`network ${id} not found`);
  if ((removed.error || removed.status !== 0) && !raced) failed(removed, kind === 'container' ? 'rm' : `${kind} rm`);
}

/**
 * Removes the containers, networks and volumes labelled with one runner owner, and every container that holds one of
 * those networks or volumes, whatever its labels (see `removeLabelledObjects`). A test file's afterAll calls it after
 * its other cleanup, and a test that makes objects under its own runner owner sweeps them, by owner (here, or with
 * `removeLabelledObjects(RUNNER_LABEL, owner)`) or by allocation with `removeLabelledObjects`.
 */
export function removeRunnerObjects(runnerOwner: string, when = 'afterAll'): void {
  removeLabelledObjects(RUNNER_LABEL, runnerOwner, when);
}

/**
 * Removes the containers, networks and volumes that carry `label=value`, containers first, as they hold the others in
 * use. Before it removes a network or a volume it also removes every container attached to it or mounting it, labelled
 * or not: a test can make a network or volume with one owner and the container that holds it with another, or without
 * one. Containers and volumes go by force; a network another container joins meanwhile stays. It reports what it finds
 * and any Docker call that fails (but not one that fails only because what it names has gone since the listing: a
 * holder it reads, or a network it removes), prefixed with `when`, and never throws, so cleanup can call it without
 * hiding an earlier error. Each call has a 30 s limit, so all eleven can take up to 5.5 minutes. It runs `docker`, the
 * real one by default (`REAL_DOCKER`).
 */
export function removeLabelledObjects(label: string, value: string, when: string, docker = REAL_DOCKER): void {
  const run = (stage: string, args: string[]) => {
    const result = spawnSync(docker, args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env: dockerEnv() });
    // A holder gone since the listing is expected: Docker 27.4 answers "No such container" for it, and prints the rest.
    // So is a network gone since the listing (removed by its own test meanwhile): "network <ID> not found".
    const errors = result.stderr?.trim().split('\n') ?? [];
    const gone = result.status === 1 && (stage === 'reading holders'
      ? errors.every(line => line.startsWith('Error response from daemon: No such container: '))
      : stage === 'removing networks' && errors.every(line => /^Error response from daemon: network [0-9a-f]{64} not found$/.test(line)));
    if (result.status !== 0 && !gone) console.warn(`${when}: ${stage}: docker ${args.slice(0, 2).join(' ')} failed:`,
      result.error?.message ?? (result.signal ? `killed by ${result.signal}` : result.stderr.trim()));
    // An inspect of several objects exits 1 if one is gone, yet prints the rest (Docker 27.4), so the output of a call
    // that exited by itself is read whatever its status. A killed call's output may be cut short, so it is not.
    return result.error || result.status === null ? [] : result.stdout.split('\n').filter(Boolean);
  };
  // A line Docker printed that is not JSON is reported and skipped, so the sweep never throws.
  const parsed = <T>(text: string): T[] => {
    try { return [JSON.parse(text) as T]; } catch { console.warn(`${when}: docker printed a line that is not JSON:`, text); return []; }
  };
  for (const kind of ['container', 'network', 'volume'] as const) {
    // Networks with their names: `ps --filter network=` finds a created, never started container by the name only
    // (Docker 27.4). Each is removed by its full ID, which no other network's name can be mistaken for.
    // As JSON: a network's name may hold spaces. Only a container's name comes with a leading slash.
    const listed = run(`listing ${kind}s`, [kind, 'ls', ...(kind === 'container' ? ['--all'] : []), ...(kind === 'network'
      ? ['--no-trunc', '--format', '{{json .}}'] : kind === 'container' ? ['--quiet', '--no-trunc'] : ['--quiet']),
      '--filter', `label=${label}=${value}`])
      .flatMap(line => kind === 'network' ? parsed<{ ID?: unknown; Name?: unknown } | null>(line)
        .filter((object): object is { ID: string; Name: string } => typeof object?.ID === 'string' && typeof object.Name === 'string')
        : [{ ID: line, Name: line }]);
    const ids = listed.map(object => object.ID), names = listed.map(object => object.Name);
    if (!ids.length) continue;
    console.warn(`${when} removes leftover ${kind}s labelled ${label}=${value}: ${names.join(' ')}`);
    if (kind !== 'container') {
      // Filters with one key match any of their values. The network filter also matches the start of another network's
      // ID, so a container counts only if it is on one of these networks by name (Docker refuses a second local network
      // of one name). Containers go by full ID: Docker resolves a name before an ID prefix.
      const candidates = run('finding holders', ['ps', '--all', '--quiet', '--no-trunc',
        ...names.flatMap(name => ['--filter', `${kind}=${name}`])]);
      const holders = kind === 'volume' || !candidates.length ? candidates : run('reading holders', ['container', 'inspect', '--format',
        '{{json .Id}} {{json .NetworkSettings.Networks}}', ...candidates]).flatMap(line => {
        const at = line.indexOf(' '), id = parsed<string>(line.slice(0, at)), on = parsed<Record<string, unknown>>(line.slice(at + 1));
        return typeof id[0] === 'string' && typeof on[0] === 'object' ? [{ id: id[0], on: Object.keys(on[0] ?? {}) }] : [];
      }).filter(holder => holder.on.some(name => names.includes(name))).map(holder => holder.id);
      if (holders.length) {
        console.warn(`${when} removes the containers that hold them: ${holders.join(' ')}`);
        run('removing holders', ['rm', '--force', ...holders]);
      }
    }
    run(`removing ${kind}s`, [kind, 'rm', ...(kind === 'network' ? [] : ['--force']), ...ids]);
  }
}

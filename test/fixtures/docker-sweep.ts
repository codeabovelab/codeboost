import { spawnSync } from 'node:child_process';
import { RUNNER_LABEL } from '../../agents/labels.ts';

/**
 * The real `docker`, found once when this module loads, before any test puts a shim on PATH. A sweep that runs while a
 * shim is still on PATH (after a test timed out inside one) would otherwise wait on the shim's own child, which the
 * call's SIGKILL does not reach.
 */
export const REAL_DOCKER = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout?.trim() || 'docker';
/** The real `docker` for a shim to call; refuses when none was found, since a shim calling `docker` would call itself. */
export function requireRealDocker(): string {
  if (!REAL_DOCKER.startsWith('/')) throw new Error('No docker on PATH when the test files loaded.');
  return REAL_DOCKER;
}

/**
 * The label a test's Docker shim adds to an object it makes without the runner label (#189), so the test can still
 * find and remove that object however the test ends. No codeboost code writes or reads it.
 */
export const TEST_RUN_LABEL = 'io.codeboost.test-run';
/** Beside it, one value per test file run, so afterAll removes them all with one sweep. */
export const TEST_FILE_LABEL = 'io.codeboost.test-file';

/**
 * Removes the containers, networks and volumes labelled with one runner owner, and every container that holds one of
 * those networks or volumes, whatever its labels (see `removeLabelledObjects`). A test file's afterAll calls it after
 * its other cleanup, and a test that makes objects under its own runner owner sweeps them, by owner here or by
 * allocation with `removeLabelledObjects`.
 */
export function removeRunnerObjects(runnerOwner: string, when = 'afterAll'): void {
  removeLabelledObjects(RUNNER_LABEL, runnerOwner, when);
}

/**
 * Removes the containers, networks and volumes that carry `label=value`, containers first, as they hold the others in
 * use. Before it removes a network or a volume it also removes every container attached to it or mounting it, labelled
 * or not: a test can make a network or volume with one owner and the container that holds it with another, or without
 * one. Containers and volumes go by force; a network another container joins meanwhile stays. It reports what it finds
 * and any Docker call that fails, prefixed with `when`, and never throws, so cleanup can call it without hiding an
 * earlier error. Each call has a 30 s limit, so all eleven can take up to 5.5 minutes. It runs `docker`, the real one by
 * default (`REAL_DOCKER`).
 */
export function removeLabelledObjects(label: string, value: string, when: string, docker = REAL_DOCKER): void {
  const run = (args: string[]) => {
    const result = spawnSync(docker, args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    if (result.status !== 0) console.warn(`${when}: docker ${args.slice(0, 2).join(' ')} failed:`,
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
    // As JSON: a network's name may hold spaces.
    const listed = run([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), ...(kind === 'network'
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
      const candidates = run(['ps', '--all', '--quiet', '--no-trunc',
        ...names.flatMap(name => ['--filter', `${kind}=${name}`])]);
      const holders = kind === 'volume' || !candidates.length ? candidates : run(['container', 'inspect', '--format',
        '{{json .Id}} {{json .NetworkSettings.Networks}}', ...candidates]).flatMap(line => {
        const at = line.indexOf(' '), id = parsed<string>(line.slice(0, at)), on = parsed<Record<string, unknown>>(line.slice(at + 1));
        return typeof id[0] === 'string' && typeof on[0] === 'object' ? [{ id: id[0], on: Object.keys(on[0] ?? {}) }] : [];
      }).filter(holder => holder.on.some(name => names.includes(name))).map(holder => holder.id);
      if (holders.length) {
        console.warn(`${when} removes the containers that hold them: ${holders.join(' ')}`);
        run(['rm', '--force', ...holders]);
      }
    }
    run([kind, 'rm', ...(kind === 'network' ? [] : ['--force']), ...ids]);
  }
}

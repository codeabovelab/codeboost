import { spawnSync } from 'node:child_process';
import { RUNNER_LABEL } from '../../agents/labels.ts';

/**
 * The label a test's Docker shim adds to an object it makes without the runner label (#189), so the test can still
 * find and remove that object however the test ends. No codeboost code writes or reads it.
 */
export const TEST_RUN_LABEL = 'io.codeboost.test-run';

/**
 * Removes the containers, networks and volumes labelled with one runner owner, and every container that holds one of
 * those networks or volumes, whatever its labels (see `removeLabelledObjects`). A test file's afterAll calls it in a
 * finally block.
 */
export function removeRunnerObjects(runnerOwner: string): void {
  removeLabelledObjects(RUNNER_LABEL, runnerOwner, 'afterAll');
}

/**
 * Removes the containers, networks and volumes that carry `label=value`, containers first, as they hold the others in
 * use. Before it removes a network or a volume it also removes every container attached to it or mounting it, labelled
 * or not: a test can make a network or volume with one owner and the container that holds it with another, or without
 * one. Containers and volumes go by force; a network another container joins meanwhile stays. It reports what it finds
 * and any Docker call that fails, prefixed with `when`, and never throws, so cleanup can call it without hiding an
 * earlier error. Each call has a 30 s limit, so all eleven can take up to 5.5 minutes.
 */
export function removeLabelledObjects(label: string, value: string, when: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    if (result.status !== 0) console.warn(`${when}: docker ${args.slice(0, 2).join(' ')} failed:`,
      result.error?.message ?? result.stderr.trim());
    // An inspect of several objects exits 1 if one is gone, yet prints the rest (Docker 27.4), so the output of a call
    // that exited by itself is read whatever its status. A killed call's output may be cut short, so it is not.
    return result.error || result.status === null ? [] : result.stdout.split('\n').filter(Boolean);
  };
  for (const kind of ['container', 'network', 'volume'] as const) {
    // Networks with their names: `ps --filter network=` finds a created, never started container by the name only
    // (Docker 27.4). Each is removed by its full ID, which no other network's name can be mistaken for.
    // As JSON: a network's name may hold spaces.
    const listed = run([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), ...(kind === 'network'
      ? ['--no-trunc', '--format', '{{json .}}'] : kind === 'container' ? ['--quiet', '--no-trunc'] : ['--quiet']),
      '--filter', `label=${label}=${value}`])
      .map(line => kind === 'network' ? JSON.parse(line) as { ID: string; Name: string } : { ID: line, Name: line });
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
        '{{json .Id}} {{json .NetworkSettings.Networks}}', ...candidates]).map(line => {
        const at = line.indexOf(' ');
        return { id: JSON.parse(line.slice(0, at)) as string, on: Object.keys(JSON.parse(line.slice(at + 1)) ?? {}) };
      }).filter(holder => holder.on.some(name => names.includes(name))).map(holder => holder.id);
      if (holders.length) {
        console.warn(`${when} removes the containers that hold them: ${holders.join(' ')}`);
        run(['rm', '--force', ...holders]);
      }
    }
    run([kind, 'rm', ...(kind === 'network' ? [] : ['--force']), ...ids]);
  }
}

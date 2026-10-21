import { spawnSync } from 'node:child_process';
import { RUNNER_LABEL } from '../../agents/labels.ts';

/**
 * The label a test's Docker shim adds to an object it makes without the runner label (#189), so the test can still
 * find and remove that object however the test ends. No codeboost code writes or reads it.
 */
export const TEST_RUN_LABEL = 'io.codeboost.test-run';

/**
 * Removes the containers, networks and volumes labelled with one runner owner (see `removeLabelledObjects`). A test
 * file's afterAll calls it in a finally block.
 */
export function removeRunnerObjects(runnerOwner: string): void {
  removeLabelledObjects(RUNNER_LABEL, runnerOwner, 'afterAll');
}

/**
 * Removes the containers, networks and volumes that carry `label=value`, containers first, as they hold the others in
 * use. Before it removes a volume it also removes every container that mounts it, labelled or not: a test can make a
 * volume with one owner and the container that holds it without that owner. Containers and volumes go by force; a
 * network that another container still uses stays. It reports what it finds and any Docker call that fails, prefixed
 * with `when`, and never throws, so cleanup can call it without hiding an earlier error. Each call has a 30 s limit.
 */
export function removeLabelledObjects(label: string, value: string, when: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    if (result.status !== 0) console.warn(`${when}: docker ${args.slice(0, 2).join(' ')} failed:`,
      result.error?.message ?? result.stderr.trim());
    return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
  };
  for (const kind of ['container', 'network', 'volume'] as const) {
    const ids = run([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--quiet', '--filter', `label=${label}=${value}`]);
    if (!ids.length) continue;
    console.warn(`${when} removes leftover ${kind}s labelled ${label}=${value}: ${ids.join(' ')}`);
    if (kind === 'volume') {
      const holders = [...new Set(ids.flatMap(id => run(['ps', '--all', '--quiet', '--filter', `volume=${id}`])))];
      if (holders.length) {
        console.warn(`${when} removes the containers that hold them: ${holders.join(' ')}`);
        run(['rm', '--force', ...holders]);
      }
    }
    run([kind, 'rm', ...(kind === 'network' ? [] : ['--force']), ...ids]);
  }
}

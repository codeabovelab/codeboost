import { spawnSync } from 'node:child_process';
import { RUNNER_LABEL } from '../../agents/labels.ts';

/**
 * Force-removes every container, network and volume labelled with one runner owner, containers first, as they hold
 * the others in use. It reports what it finds and any Docker call that fails, and never throws, so a test file's
 * afterAll can call it in a finally block without hiding an error from its ordinary cleanup. Each call has a 30 s
 * limit, so all six can take up to 3 minutes.
 */
export function removeRunnerObjects(runnerOwner: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    if (result.status !== 0) console.warn(`afterAll: docker ${args.slice(0, 2).join(' ')} failed:`,
      result.error?.message ?? result.stderr.trim());
    return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
  };
  for (const kind of ['container', 'network', 'volume'] as const) {
    const ids = run([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--quiet', '--filter',
      `label=${RUNNER_LABEL}=${runnerOwner}`]);
    if (!ids.length) continue;
    console.warn(`afterAll removes this run's leftover ${kind}s: ${ids.join(' ')}`);
    run([kind, 'rm', ...(kind === 'network' ? [] : ['--force']), ...ids]);
  }
}

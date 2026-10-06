import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { MAX_INDEX_BYTES, MAX_INDEX_ENTRIES } from './verify-checkout.ts';

const MAX_GIT_OUTPUT_BYTES = MAX_INDEX_BYTES * 4 + 1024;

type PathListMode = 'conflicts' | 'changed' | 'untracked' | 'unmerged';

/** Return one bounded raw NUL stream as base64 so the parent can perform fatal UTF-8 decoding without replacement. */
export function listGitPaths(root: string, executable: string, mode: PathListMode, head?: string): string {
  if (mode === 'changed' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? ''))
    throw new Error('A full pinned head is required for the changed-path scan.');
  if (mode !== 'changed' && head !== undefined) throw new Error('This path scan does not accept a head.');
  const command = mode === 'conflicts' ? ['diff', '--name-only', '--diff-filter=U', '-z', '--']
    : mode === 'changed' ? ['diff', '--name-only', '--ignore-submodules=all', '-z', head!, '--']
    : mode === 'untracked' ? ['ls-files', '--others', '-z', '--']
    : ['ls-files', '--unmerged', '-z', '--'];
  const result = spawnSync(executable, [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...command],
    { cwd: root, env: gitEnvironment(), maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw result.error ?? new Error(`git ${command[0]} failed while listing paths.`);
  const output = result.stdout;
  if (output.length > MAX_INDEX_BYTES) throw new Error('Git path output exceeds its byte bound.');
  let entries = 0;
  for (const byte of output) if (byte === 0 && ++entries > MAX_INDEX_ENTRIES)
    throw new Error('Git path output exceeds its entry bound.');
  if (output.length && output[output.length - 1] !== 0) throw new Error('Git returned an unterminated path record.');
  return output.toString('base64');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Path listing requires a pinned Git executable and mode.');
  process.stdout.write(listGitPaths(process.cwd(), process.argv[2], process.argv[3] as PathListMode, process.argv[4]));
}

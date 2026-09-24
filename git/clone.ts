import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, opendirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TaskClone } from '../agents/contract.ts';

/**
 * Prepare an independent committed snapshot. This is trusted staging, not the
 * writable execution filesystem: D2 must reserve bounded storage and separate
 * metadata before mounting it. Source must stay quiescent during this operation.
 * No hooks, filters from user config, credentials, submodules or network access.
 */
export function createTaskClone(options: {
  source: string; parent: string; taskId: string; head: string; timeoutMs?: number;
}): TaskClone {
  if (!options.taskId || options.taskId.includes('\0')) throw new Error('Task identity is required.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.head)) throw new Error('A full committed head is required.');
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid clone deadline.');
  const deadline = performance.now() + timeout;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error('Clone deadline exceeded.');
    return value;
  };
  const source = realpathSync(options.source), parent = realpathSync(options.parent);
  const within = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  };
  if (within(source, parent)) throw new Error('Task storage must be outside the source repository.');
  // Deliberately do not inherit Git variables or credential/config environment.
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' };
  const run = (cwd: string, ...args: string[]) => {
    const result = execFileSync('git', [
      '--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
      '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false', ...args,
    ], { cwd, env, timeout: remaining(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
    remaining();
    return result.toString().trim();
  };
  const common = realpathSync(resolve(source, run(source, 'rev-parse', '--git-common-dir')));
  if (within(common, parent)) throw new Error('Task storage must be outside source metadata.');
  function audit(metadata: string, independent: boolean) {
    for (const name of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
      if (lstatSync(join(metadata, name), { throwIfNoEntry: false })) throw new Error(`Unsupported Git storage: ${name}`);
    }
    const pending = [join(metadata, 'objects')];
    let count = 0;
    while (pending.length) {
      remaining();
      if (++count > 100_000) throw new Error('Object storage exceeds inspection limit.');
      const path = pending.pop()!, stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported object entry.');
      if (independent && stat.isFile() && stat.nlink !== 1) throw new Error('Task objects must not be hard-linked.');
      if (stat.isDirectory()) {
        const directory = opendirSync(path, { bufferSize: 1 });
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            remaining();
            if (count + pending.length >= 100_000) throw new Error('Object storage exceeds inspection limit.');
            pending.push(join(path, entry.name));
          }
        } finally { directory.closeSync(); }
      }
    }
  }
  audit(common, false);
  if (run(source, 'for-each-ref', '--format=%(refname)', 'refs/replace')) throw new Error('Replacement objects are unsupported.');
  if (run(source, 'rev-parse', '--verify', `${options.head}^{commit}`) !== options.head) throw new Error('Head is not a commit.');
  const directory = mkdtempSync(join(parent, 'codeboost-task-'));
  try {
    run(parent, '-c', 'protocol.file.allow=always', 'clone', '--local', '--no-hardlinks', '--no-checkout', '--', source, directory);
    const metadata = join(directory, '.git');
    if (!lstatSync(metadata).isDirectory()) throw new Error('Task requires standalone Git metadata.');
    audit(metadata, true);
    run(directory, 'remote', 'remove', 'origin');
    run(directory, 'checkout', '--detach', options.head);
    if (run(directory, 'rev-parse', 'HEAD') !== options.head) throw new Error('Task head changed during clone.');
    return Object.freeze({ id: randomUUID(), taskId: options.taskId, directory, head: options.head });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

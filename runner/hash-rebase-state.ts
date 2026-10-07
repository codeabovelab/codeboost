import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { MAX_INDEX_BYTES, MAX_INDEX_ENTRIES } from './verify-checkout.ts';

const gitPath = (root: string, executable: string): Buffer => {
  const result = spawnSync(executable, [...GIT_OPTIONS, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'],
    { cwd: root, env: gitEnvironment(), maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw result.error ?? new Error('Git could not locate its rebase state.');
  const output = result.stdout;
  if (!output.length || output.includes(0) || output[output.length - 1] !== 0x0a)
    throw new Error('Git returned an invalid rebase-state path.');
  return output.subarray(0, output.length - 1);
};

export function readBoundedRebaseStateNames(read: () => Buffer | null,
  budget: { entries: number; nameBytes: number },
  limits = { entries: MAX_INDEX_ENTRIES, nameBytes: MAX_INDEX_BYTES }): Buffer[] {
  const children: Buffer[] = [];
  for (let name = read(); name; name = read()) {
    if (++budget.entries > limits.entries) throw new Error('Git rebase state exceeds its entry bound.');
    if ((budget.nameBytes += name.length) > limits.nameBytes)
      throw new Error('Git rebase state exceeds its name-byte bound.');
    children.push(name);
  }
  return children;
}

/** Hash the byte-exact rebase control directory without following any link. */
export function rebaseStateDigest(root = process.cwd(), executable = 'git'): string {
  const directory = gitPath(root, executable), initial = lstatSync(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('Git rebase state is not a plain directory.');
  const hash = createHash('sha256'), pending: { full: Buffer; relative: Buffer }[] = [{ full: directory, relative: Buffer.alloc(0) }];
  const enumeration = { entries: 0, nameBytes: 0 };
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!, opened = opendirSync(current.full, { encoding: 'buffer' as BufferEncoding });
    let children: Buffer[];
    try {
      children = readBoundedRebaseStateNames(() => {
        const entry = opened.readSync();
        return entry ? entry.name as unknown as Buffer : null;
      }, enumeration);
    }
    finally { opened.closeSync(); }
    children.sort(Buffer.compare);
    for (const name of children) {
      const full = Buffer.concat([current.full, Buffer.from('/'), name]);
      const relative = current.relative.length ? Buffer.concat([current.relative, Buffer.from('/'), name]) : name;
      const stat = lstatSync(full);
      hash.update(String(relative.length)).update(':').update(relative).update(':').update(String(stat.mode)).update(':');
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hash.update('directory\0'); pending.push({ full, relative }); continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Git rebase state contains an unsupported entry.');
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedStat = fstatSync(fd);
        if (!openedStat.isFile()) throw new Error('Git rebase state changed type while it was audited.');
        hash.update(`file:${openedStat.size}\0`);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const length = readSync(fd, buffer, 0, buffer.length, null);
          if (!length) break;
          if ((bytes += length) > MAX_INDEX_BYTES) throw new Error('Git rebase state exceeds its byte bound.');
          hash.update(buffer.subarray(0, length));
        }
      } finally { closeSync(fd); }
    }
  }
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Rebase-state hashing requires a pinned Git executable.');
  process.stdout.write(rebaseStateDigest(process.cwd(), process.argv[2]));
}

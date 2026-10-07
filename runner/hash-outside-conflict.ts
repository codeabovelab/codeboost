import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { MAX_INDEX_BYTES, MAX_INDEX_ENTRIES } from './verify-checkout.ts';

const MAX_GIT_OUTPUT_BYTES = MAX_INDEX_BYTES * 4 + 1024;
const split0 = (input: Buffer): Buffer[] => {
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index++) if (input[index] === 0) {
    if (++values.length > MAX_INDEX_ENTRIES) throw new Error('Git path output exceeds its entry bound.');
    values[values.length - 1] = input.subarray(start, index); start = index + 1;
  }
  if (start !== input.length) throw new Error('Git returned an unterminated path record.');
  return values;
};
const git = (root: string, executable: string, args: readonly string[]): Buffer => {
  const result = spawnSync(executable, [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
    { cwd: root, env: gitEnvironment(), maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw result.error ?? new Error(`git ${args[0]} failed while auditing conflict scope.`);
  if (result.stdout.length > MAX_INDEX_BYTES) throw new Error('Git path output exceeds its byte bound.');
  return result.stdout;
};
const safePath = (root: Buffer, path: Buffer): Buffer => {
  const parts = split0(Buffer.concat([Buffer.from(path).map(byte => byte === 0x2f ? 0 : byte), Buffer.from([0])]));
  if (!parts.length || parts.some(part => !part.length || part.equals(Buffer.from('.')) || part.equals(Buffer.from('..'))))
    throw new Error('Git returned an unsafe path.');
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The conflict workspace is not a plain directory.');
  let ancestor = root;
  for (const part of parts.slice(0, -1)) {
    ancestor = Buffer.concat([ancestor, Buffer.from('/'), part]);
    const stat = lstatSync(ancestor, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error('A changed path has a symlink ancestor.');
    if (!stat.isDirectory()) throw new Error('A changed path has a non-directory ancestor.');
  }
  return Buffer.concat([root, Buffer.from('/'), path]);
};

/** Hash every tracked or untracked state outside the allowed conflict paths in one killable helper process. */
export function outsideConflictDigest(root: string, executable: string, head: string, allowedInput: Buffer): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error('A full pinned head is required.');
  if (allowedInput.length > MAX_INDEX_BYTES) throw new Error('Allowed conflict paths exceed their byte bound.');
  const allowed = new Set(split0(allowedInput).map(path => path.toString('hex')));
  const changed = new Map<string, Buffer>();
  let changedBytes = 0;
  for (const path of [...split0(git(root, executable, ['diff', '--name-only', '--ignore-submodules=all', '-z', head, '--'])),
    ...split0(git(root, executable, ['ls-files', '--others', '-z', '--']))]) {
    const key = path.toString('hex');
    if (!allowed.has(key) && !changed.has(key)) {
      if (changed.size >= MAX_INDEX_ENTRIES || (changedBytes += path.length + 1) > MAX_INDEX_BYTES)
        throw new Error('Changed paths exceed their combined bound.');
      changed.set(key, path);
    }
  }
  const index = new Map<string, Buffer[]>();
  for (const record of split0(git(root, executable, ['ls-files', '--stage', '-z']))) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Git returned an invalid index record.');
    const key = record.subarray(tab + 1).toString('hex'), records = index.get(key) ?? [];
    records.push(record); index.set(key, records);
  }
  const rootBytes = Buffer.from(root), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  for (const key of [...changed.keys()].sort()) {
    const path = changed.get(key)!, records = index.get(key) ?? [];
    hash.update(`path:${path.length}:`).update(path).update(`:index:${records.length}:`);
    for (const record of records) hash.update(`${record.length}:`).update(record);
    const full = safePath(rootBytes, path), before = lstatSync(full, { throwIfNoEntry: false });
    if (!before) { hash.update('missing\0'); continue; }
    if (before.isSymbolicLink()) {
      const target = readlinkSync(full, { encoding: 'buffer' });
      hash.update(`link:${before.mode}:${target.length}:`).update(target).update('\0'); continue;
    }
    if (!before.isFile()) throw new Error('A changed path is not a regular file or symbolic link.');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('A changed path changed type while it was audited.');
      hash.update(`file:${stat.mode}:${stat.size}:`);
      for (;;) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (!length) break;
        hash.update(buffer.subarray(0, length));
      }
      hash.update('\0');
    } finally { closeSync(fd); }
  }
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Outside-conflict hashing requires a pinned Git executable and head.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(outsideConflictDigest(process.cwd(), process.argv[2], process.argv[3], Buffer.concat(chunks)));
}

import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';

export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
export const MAX_INDEX_ENTRIES = 262_144;
// A C-quoted path can expand every input byte to four bytes. Keep transport above every accepted index listing;
// accepted input is then rejected by our explicit bounds, never by spawnSync's smaller implementation limit.
const MAX_GIT_OUTPUT_BYTES = MAX_INDEX_BYTES * 4 + 1024;
const git = (executable: string, args: readonly string[], input?: Buffer): Buffer => {
  const result = spawnSync(executable, [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
    { env: gitEnvironment(), input, maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw result.error ?? new Error(`git ${args[0]} failed while verifying the checkout.`);
  return result.stdout;
};
export const splitBoundedIndexRecords = (input: Buffer, maxEntries = MAX_INDEX_ENTRIES): Buffer[] => {
  const values: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) if (input[i] === 0) {
    if (values.length >= maxEntries) throw new Error('Checkout index exceeds its entry bound.');
    values.push(input.subarray(start, i)); start = i + 1;
  }
  if (start !== input.length) throw new Error('Git returned an unterminated index record.');
  return values;
};
const splitPath = (path: Buffer): Buffer[] => {
  const values: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) if (i === path.length || path[i] === 0x2f) {
    const part = path.subarray(start, i);
    if (!part.length || part.equals(Buffer.from('.')) || part.equals(Buffer.from('..'))) throw new Error('Git returned an unsafe index path.');
    values.push(part); start = i + 1;
  }
  return values;
};
const objectId = (algorithm: 'sha1' | 'sha256', bytes: Buffer): string =>
  createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');

/** Hash index-only gitlink entries without entering or reading their nested repositories. */
export function gitlinkIndexDigest(root = process.cwd(), executable = 'git'): string {
  const rawOutput = git(executable, ['-C', root, 'ls-files', '--stage', '-z']);
  if (rawOutput.length > MAX_INDEX_BYTES) throw new Error('Checkout index exceeds its byte bound.');
  const raw = splitBoundedIndexRecords(rawOutput);
  const hash = createHash('sha256');
  for (const record of raw) {
    const tab = record.indexOf(0x09), header = record.subarray(0, tab).toString('ascii').split(' ');
    if (tab < 0 || header.length !== 3 || !/^[0-3]$/.test(header[2]!)) throw new Error('Git returned an invalid index record.');
    if (header[0] === '160000') hash.update(record).update('\0');
  }
  return hash.digest('hex');
}

/** Byte-exact, content-based proof that the disposable worktree represents its index. Gitlinks stay index-only. */
export function verifyCheckout(root = process.cwd(), executable = 'git'): void {
  const repositoryGit = (args: readonly string[], input?: Buffer) => git(executable, ['-C', root, ...args], input);
  const rawOutput = repositoryGit(['ls-files', '--stage', '-z']);
  if (rawOutput.length > MAX_INDEX_BYTES) throw new Error('Checkout index exceeds its byte bound.');
  const raw = splitBoundedIndexRecords(rawOutput);
  const quotedOutput = repositoryGit(['ls-files', '--stage']).toString('utf8');
  if (quotedOutput && !quotedOutput.endsWith('\n')) throw new Error('Git returned an unterminated quoted index listing.');
  const quoted = quotedOutput ? quotedOutput.slice(0, -1).split('\n') : [];
  if (quoted.length !== raw.length) throw new Error('Git returned inconsistent index listings.');
  const format = repositoryGit(['rev-parse', '--show-object-format']).toString('ascii').trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Git returned an unsupported object format.');
  const rootBytes = Buffer.from(root), regular: { oid: string; quoted: string }[] = [];
  const rootStat = lstatSync(rootBytes);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Checkout root is not a plain directory.');
  let entries = 0;
  const directories = new Map<string, Set<string>>();
  const hasEntry = (directory: Buffer, expected: Buffer): boolean => {
    const key = directory.toString('hex'), cached = directories.get(key);
    if (cached) return cached.has(expected.toString('hex'));
    // Node supports Buffer directory entries at runtime, but its opendirSync overload still omits the documented
    // `buffer` encoding that readdirSync exposes. Preserve raw names rather than decoding hostile bytes as UTF-8.
    const opened = opendirSync(directory, { encoding: 'buffer' as BufferEncoding });
    const names = new Set<string>();
    try {
      for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
        if (++entries > MAX_INDEX_ENTRIES) throw new Error('Checkout verification exceeded its directory-entry bound.');
        names.add((entry.name as unknown as Buffer).toString('hex'));
      }
    } finally { opened.closeSync(); }
    directories.set(key, names);
    return names.has(expected.toString('hex'));
  };
  for (let index = 0; index < raw.length; index++) {
    const record = raw[index]!, tab = record.indexOf(0x09), header = record.subarray(0, tab).toString('ascii').split(' ');
    if (tab < 0 || header.length !== 3 || header[2] !== '0') throw new Error('Git returned an invalid index record.');
    const [mode, oid] = header, path = record.subarray(tab + 1), parts = splitPath(path);
    if (mode === '160000') continue;
    let parent = rootBytes;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]!;
      if (!hasEntry(parent, part)) throw new Error(`The host filesystem changed indexed path component ${part.toString('hex')}.`);
      parent = Buffer.concat([parent, Buffer.from('/'), part]);
      if (partIndex < parts.length - 1) {
        const directory = lstatSync(parent);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('An indexed path traverses a non-directory.');
      }
    }
    const stat = lstatSync(parent);
    if (mode === '120000') {
      if (!stat.isSymbolicLink() || objectId(format, readlinkSync(parent, { encoding: 'buffer' })) !== oid)
        throw new Error('An indexed symlink does not match its blob.');
    } else if (mode === '100644' || mode === '100755') {
      if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== (mode === '100755')) throw new Error('An indexed file mode changed.');
      const text = quoted[index]!, quotedTab = text.indexOf('\t');
      if (quotedTab < 0 || !text.startsWith(`${mode} ${oid} 0\t`)) throw new Error('Git returned inconsistent index records.');
      regular.push({ oid: oid!, quoted: text.slice(quotedTab + 1) });
    } else throw new Error('The index contains an unsupported file mode.');
  }
  if (regular.length) {
    const hashes = repositoryGit(['hash-object', '--stdin-paths'], Buffer.from(`${regular.map(entry => entry.quoted).join('\n')}\n`))
      .toString('ascii').trim().split('\n');
    if (hashes.length !== regular.length || hashes.some((hash, index) => hash !== regular[index]!.oid))
      throw new Error('An indexed file does not match its blob.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Checkout verification requires a pinned Git executable.');
  if (process.argv[3] === 'gitlinks') process.stdout.write(gitlinkIndexDigest(process.cwd(), process.argv[2]));
  else if (process.argv[3] === undefined) verifyCheckout(process.cwd(), process.argv[2]);
  else throw new Error('Unknown checkout verification mode.');
}

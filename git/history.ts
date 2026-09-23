import { imageSize } from 'image-size';
import { execFileSync } from 'node:child_process';
import { lstatSync, opendirSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import type { FileDelta, FileVersion, History } from '../core/linking.ts';

/** Read-only Git adapter. Never follows working-tree symlinks or runs diff helpers. */
export function readHistory(repo: string, baseRef: string, headRef = 'HEAD', limits: { maxBlobBytes?: number; maxObjectEntries?: number; maxDiffBytes?: number; maxFileEntries?: number; maxDurationMs?: number } = {}): History {
  const maxDurationMs = limits.maxDurationMs ?? 30_000;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 30_000) throw new Error('Duration budget must be a positive integer no larger than 30000 ms.');
  const deadline = performance.now() + maxDurationMs;
  const remaining = () => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new Error('History read exceeded its overall deadline.');
    return Math.max(1, Math.ceil(ms));
  };
  const maxBlobBytes = limits.maxBlobBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1 || maxBlobBytes > 64 * 1024 * 1024) throw new Error('Blob byte budget must be a positive integer no larger than 64 MiB.');
  const maxObjectEntries = limits.maxObjectEntries ?? 100_000;
  if (!Number.isSafeInteger(maxObjectEntries) || maxObjectEntries < 1 || maxObjectEntries > 100_000) throw new Error('Object entry budget must be a positive integer no larger than 100000.');
  const maxDiffBytes = limits.maxDiffBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 1 || maxDiffBytes > 8 * 1024 * 1024) throw new Error('Diff byte budget must be a positive integer no larger than 8 MiB.');
  const maxFileEntries = limits.maxFileEntries ?? 20_000;
  if (!Number.isSafeInteger(maxFileEntries) || maxFileEntries < 1 || maxFileEntries > 20_000) throw new Error('File entry budget must be a positive integer no larger than 20000.');
  let blobBytes = 0, diffBytes = 0, fileEntries = 0;
  const accountDiff = (data: Buffer): Buffer => {
    diffBytes += data.length;
    if (diffBytes > maxDiffBytes) throw new Error('Review history exceeds the cumulative diff byte budget; choose a narrower base.');
    return data;
  };
  // Inherited Git variables can redirect repository, index, config, and object lookup.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const run = (...args: string[]) => {
    const timeout = remaining();
    let result: Buffer;
    try {
      result = execFileSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args], {
        cwd: repo, maxBuffer: 32 * 1024 * 1024, timeout, killSignal: 'SIGKILL',
        env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_GRAFT_FILE: '/dev/null' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ETIMEDOUT') throw new Error('History read exceeded its overall deadline.', { cause: error });
      throw error;
    }
    remaining();
    return result;
  };
  // Parent-rewriting files are not immutable commit ancestry. Resolve via Git so
  // linked worktrees use the common administrative directory as well.
  const commonDirectory = resolvePath(repo, run('rev-parse', '--git-common-dir').toString().trim());
  for (const name of ['info/grafts', 'shallow']) {
    const path = join(commonDirectory, name);
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw new Error(`Review repositories must not use graft or shallow ancestry metadata (${name}).`);
  }
  // Inspect storage without following links before any object-resolving command.
  const objects = resolvePath(repo, run('rev-parse', '--git-path', 'objects').toString().trim());
  const pending = [objects];
  let inspected = 0;
  while (pending.length) {
    remaining();
    const path = pending.pop()!;
    if (++inspected > maxObjectEntries) throw new Error('Object storage inspection exceeds its entry budget.');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Review repositories must not use symlinked object storage.');
    if (stat.isDirectory()) {
      const directory = opendirSync(path, { bufferSize: 1 });
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          remaining();
          if (pending.length + inspected >= maxObjectEntries) throw new Error('Object storage inspection exceeds its entry budget.');
          pending.push(join(path, entry.name));
        }
      } finally { directory.closeSync(); }
    }
  }
  const alternates = join(objects, 'info/alternates');
  if (lstatSync(alternates, { throwIfNoEntry: false })) throw new Error('Review repositories must not use object alternates.');
  const resolve = (ref: string) => run('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const base = resolve(baseRef), head = resolve(headRef);
  const records = run('rev-list', '--reverse', '--parents', `${base}..${head}`).toString().trim().split('\n').filter(Boolean);
  if (records.length > 500) throw new Error('Review history exceeds 500 commits; choose a narrower base.');
  let expectedParent = base;
  const commits = records.map(record => {
    const parts = record.split(' '), sha = parts[0]!, parent = parts[1]!;
    if (parts.length !== 2 || parent !== expectedParent) throw new Error('Review requires a linear history descended from the base; rebase first.');
    expectedParent = sha;
    return { sha, parent, files: [] as FileDelta[] };
  });
  if (expectedParent !== head) throw new Error('The base must be an ancestor of the head.');
  const blobs = new Map<string, { text: string | null; byteSize: number; preview?: string }>();
  let previewBytes = 0, previewPixels = 0;
  const version = (oid: string, mode: string): FileVersion | null => {
    if (/^0+$/.test(oid)) return null;
    if (mode === '160000') return { oid, mode, text: null }; // gitlink is not a local blob
    if (!blobs.has(oid)) {
      const size = Number(run('cat-file', '-s', oid).toString().trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBlobBytes - blobBytes) throw new Error('Review history exceeds the cumulative blob byte budget; choose a narrower base.');
      const data = run('cat-file', 'blob', oid);
      blobBytes += data.length;
      let text: string | null = null;
      if (!data.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { /* binary */ } }
      let preview: string | undefined;
      // Only bounded raster images; never embed SVG/HTML or fetch external references.
      const mime = data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
        data.subarray(0,3).equals(Buffer.from([255,216,255])) ? 'image/jpeg' :
        /^GIF8[79]a$/.test(data.subarray(0,6).toString('ascii')) ? 'image/gif' :
        data.subarray(0,4).toString('ascii') === 'RIFF' && data.subarray(8,12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
      if (mime && data.length <= 1024 * 1024 && previewBytes + data.length <= 4 * 1024 * 1024) {
        try {
          // Parse metadata from the already bounded buffer; never allocate decoded pixels.
          const { width, height } = imageSize(data), pixels = width * height;
          if (Number.isSafeInteger(pixels) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && pixels <= 4_000_000 && previewPixels + pixels <= 16_000_000) {
            preview = `data:${mime};base64,${data.toString('base64')}`;
            previewBytes += data.length; previewPixels += pixels;
          }
        } catch { /* Unknown or malformed dimensions: metadata card only. */ }
      }
      blobs.set(oid, { text, byteSize: data.length, ...(preview ? { preview } : {}) });
    }
    return { oid, mode, ...blobs.get(oid)! };
  };
  const diff = (from: string, to: string, contexts: boolean): FileDelta[] => {
    const raw = accountDiff(run('diff', '--ignore-submodules=none', '--no-relative', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '-M', from, to, '--'));
    const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0');
    const result: FileDelta[] = [];
    for (let i = 0; i < fields.length && fields[i];) {
      remaining();
      if (++fileEntries > maxFileEntries) throw new Error('Review history exceeds the cumulative file entry budget; choose a narrower base.');
      const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i++]!);
      if (!match) throw new Error('Unexpected Git raw diff record.');
      const [, oldMode, newMode, oldOid, newOid, status] = match;
      const first = fields[i++]!;
      const oldPath = status === 'A' ? null : first;
      const newPath = status === 'D' ? null : status === 'R' ? fields[i++]! : first;
      const before = version(oldOid!, oldMode!), after = version(newOid!, newMode!);
      const ranges: FileDelta['contexts'] = [];
      if (contexts && (before?.text !== null || after?.text !== null)) {
        const paths = [...new Set([oldPath, newPath].filter((path): path is string => path !== null))];
        // Literal pathspecs preserve filenames containing Git pathspec metacharacters.
        const patch = accountDiff(run('diff', '--ignore-submodules=none', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '-M', from, to, '--', ...paths.map(path => `:(literal)${path}`))).toString();
        for (const line of patch.split('\n')) {
          const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
          if (hunk) ranges.push({ oldStart: +hunk[1]!, oldCount: +(hunk[2] ?? 1), newStart: +hunk[3]!, newCount: +(hunk[4] ?? 1), name: hunk[5]!.trim() });
        }
      }
      result.push({ oldPath, newPath, before, after, contexts: ranges });
    }
    return result;
  };
  for (const commit of commits) commit.files = diff(commit.parent, commit.sha, false);
  const final = diff(base, head, true);
  remaining();
  return { base, head, commits, final };
}

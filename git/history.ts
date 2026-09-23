import { execFileSync } from 'node:child_process';
import type { FileDelta, FileVersion, History } from '../core/linking.ts';

/** Read-only Git adapter. Never follows working-tree symlinks or runs diff helpers. */
export function readHistory(repo: string, baseRef: string, headRef = 'HEAD'): History {
  const run = (...args: string[]) => execFileSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const blobs = new Map<string, string | null>();
  const version = (oid: string, mode: string): FileVersion | null => {
    if (/^0+$/.test(oid)) return null;
    if (mode === '160000') return { oid, mode, text: null }; // gitlink is not a local blob
    if (!blobs.has(oid)) {
      const data = run('cat-file', 'blob', oid);
      let text: string | null = null;
      if (!data.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { /* binary */ } }
      blobs.set(oid, text);
    }
    return { oid, mode, text: blobs.get(oid)! };
  };
  const diff = (from: string, to: string, contexts: boolean): FileDelta[] => {
    const raw = run('diff', '--ignore-submodules=none', '--no-relative', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '-M', from, to, '--');
    const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0');
    const result: FileDelta[] = [];
    for (let i = 0; i < fields.length && fields[i];) {
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
        const patch = run('diff', '--ignore-submodules=none', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '-M', from, to, '--', ...paths.map(path => `:(literal)${path}`)).toString();
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
  return { base, head, commits, final: diff(base, head, true) };
}

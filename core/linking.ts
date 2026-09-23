import { diffArrays } from 'diff';
import type { Plan } from './plan.ts';

export interface FileVersion { oid: string; mode: string; text: string | null }
export interface ContextRange { oldStart: number; oldCount: number; newStart: number; newCount: number; name: string }
export interface FileDelta {
  oldPath: string | null; newPath: string | null;
  before: FileVersion | null; after: FileVersion | null;
  contexts: ContextRange[];
}
export interface CommitDelta { sha: string; parent: string; files: FileDelta[] }
export interface History { base: string; head: string; commits: CommitDelta[]; final: FileDelta[] }
export interface Segment {
  path: string; oldPath: string | null; kind: 'text' | 'file';
  /** Null means a foreign commit. Caller-supplied ledger is the sole authority. */
  owners: (string | null)[];
  row: string; scope: 'in-scope' | 'out-of-scope' | 'unplanned' | 'ambiguous';
  oldLine: number | null; newLine: number | null; operation: '+' | '-' | null;
  content: string; context: string; hunk: number; sharesHunkWith: string[];
}
interface TrackedLine { text: string; owners: (string | null)[]; origins: string[]; movedOwners: (string | null)[] }
interface TrackedFile { lines: TrackedLine[]; metadataOwners: (string | null)[] }
const lines = (text: string | null | undefined): string[] => text?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const origin = (path: string, i: number) => `${path}\0${i}`;
function textFile(file: FileVersion | null): boolean {
  return file !== null && file.text !== null && ['100644', '100755'].includes(file.mode);
}
function metadataChange(delta: FileDelta): boolean {
  return delta.oldPath !== delta.newPath || delta.before?.mode !== delta.after?.mode ||
    !textFile(delta.before) || !textFile(delta.after);
}
function classify(plan: Plan, owners: (string | null)[], paths: string[]): Pick<Segment, 'row' | 'scope'> {
  if (!owners.length || owners.includes(null)) return { row: 'Unplanned', scope: 'unplanned' };
  if (owners.length > 1) return { row: 'Ambiguous', scope: 'ambiguous' };
  const item = plan.items.find(item => item.id === owners[0]);
  if (!item) throw new Error(`Ledger references unknown plan item ${owners[0]}.`);
  const declared = new Set(item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]));
  return { row: item.id, scope: paths.every(path => declared.has(path)) ? 'in-scope' : 'out-of-scope' };
}

/** Replays a linear history. Commit messages and Plan-Item trailers are never trusted. */
export function linkHistory(plan: Plan, history: History, ledger: ReadonlyMap<string, string>): Segment[] {
  const files = new Map<string, TrackedFile>();
  const removed = new Map<string, (string | null)[]>();
  // Deletions retain metadata even after the file leaves the tree.
  const metadata = new Map<string, (string | null)[]>();
  let parent = history.base;
  for (const commit of history.commits) {
    if (commit.parent !== parent) throw new Error('Linking requires a contiguous linear history.');
    parent = commit.sha;
    const owner = ledger.get(commit.sha) ?? null;
    if (owner !== null && !plan.items.some(item => item.id === owner)) throw new Error(`Unknown ledger item: ${owner}`);
    for (const delta of commit.files) {
      const oldPath = delta.oldPath;
      const path = delta.newPath ?? oldPath!;
      let previous = oldPath ? files.get(oldPath) : undefined;
      if (!previous) previous = {
        lines: lines(textFile(delta.before) ? delta.before!.text : '').map((text, i) => ({ text, owners: [], origins: [origin(oldPath!, i)], movedOwners: [] })),
        metadataOwners: [],
      };
      const next: TrackedLine[] = [];
      const changes = diffArrays(previous.lines.map(line => line.text), lines(textFile(delta.after) ? delta.after!.text : ''), { timeout: 2000 });
      if (!changes) throw new Error('Line attribution exceeded the diff time budget.');
      let cursor = 0;
      for (let n = 0; n < changes.length; n++) {
        const change = changes[n]!;
        if (!change.added && !change.removed) { next.push(...previous.lines.slice(cursor, cursor + change.value.length)); cursor += change.value.length; continue; }
        const deleted = change.removed ? previous.lines.slice(cursor, cursor + change.value.length) : [];
        if (change.removed) cursor += change.value.length;
        const owners = unique([...deleted.flatMap(line => line.owners), owner]);
        const origins = unique(deleted.flatMap(line => line.origins));
        for (const id of origins) removed.set(id, owners);
        const added = change.added ? change : changes[n + 1]?.added ? changes[++n]! : undefined;
        if (added) for (const text of added.value) next.push({ text, owners, origins, movedOwners: unique(deleted.flatMap(line => line.movedOwners)) });
      }
      if (oldPath && delta.newPath && oldPath !== delta.newPath) {
        for (let i = 0; i < next.length; i++) {
          const line = next[i]!;
          next[i] = { ...line, movedOwners: unique([...line.movedOwners, owner]) };
          for (const id of line.origins) if (!removed.has(id)) removed.set(id, unique([...line.owners, owner]));
        }
      }
      const metadataOwners = metadataChange(delta) ? unique([...previous.metadataOwners, owner]) : previous.metadataOwners;
      if (oldPath) { files.delete(oldPath); metadata.set(oldPath, metadataOwners); }
      if (delta.newPath) { files.set(delta.newPath, { lines: next, metadataOwners }); metadata.set(delta.newPath, metadataOwners); }
    }
  }
  if (parent !== history.head) throw new Error('History does not end at the requested head.');
  const segments: Segment[] = [];
  for (const delta of history.final) {
    const path = delta.newPath ?? delta.oldPath!;
    const tracked = delta.newPath ? files.get(delta.newPath) : undefined;
    const oldLines = lines(textFile(delta.before) ? delta.before!.text : '');
    const newLines = lines(textFile(delta.after) ? delta.after!.text : '');
    let oldIndex = 0, newIndex = 0, hunk = 0;
    const fileSegments: Segment[] = [];
    const affectedPaths = unique([delta.oldPath, delta.newPath].filter((p): p is string => p !== null));
    const push = (part: Omit<Segment, 'row' | 'scope' | 'sharesHunkWith'>) => fileSegments.push({
      ...part, ...classify(plan, part.owners, affectedPaths), sharesHunkWith: [],
    });
    if (metadataChange(delta)) {
      const owners = unique(affectedPaths.flatMap(path => metadata.get(path) ?? []));
      push({ path, oldPath: delta.oldPath, kind: 'file', owners, oldLine: null, newLine: null,
        operation: null, context: '', hunk: -1,
        content: JSON.stringify({ oldPath: delta.oldPath, newPath: delta.newPath,
          oldMode: delta.before?.mode ?? null, newMode: delta.after?.mode ?? null,
          oldOid: delta.before?.oid ?? null, newOid: delta.after?.oid ?? null }),
      });
    }
    const finalChanges = diffArrays(oldLines, newLines, { timeout: 2000 });
    if (!finalChanges) throw new Error('Final diff exceeded the time budget.');
    for (const change of finalChanges) {
      if (!change.added && !change.removed) {
        oldIndex += change.value.length; newIndex += change.value.length;
        if (change.value.length > 6) hunk++;
        continue;
      }
      for (const text of change.value) {
        const trackedLine = tracked?.lines[newIndex];
        const owners = change.added
          ? trackedLine?.owners.length ? trackedLine.owners : trackedLine?.movedOwners ?? []
          : removed.get(origin(delta.oldPath!, oldIndex)) ?? [];
        const context = delta.contexts.find(range => change.added
          ? newIndex + 1 >= range.newStart && newIndex + 1 < range.newStart + range.newCount
          : oldIndex + 1 >= range.oldStart && oldIndex + 1 < range.oldStart + range.oldCount)?.name ?? '';
        push({ path, oldPath: delta.oldPath, kind: 'text', owners, content: text, context, hunk,
          oldLine: change.removed ? oldIndex + 1 : null, newLine: change.added ? newIndex + 1 : null,
          operation: change.added ? '+' : '-',
        });
        if (change.added) newIndex++; else oldIndex++;
      }
    }
    // Adjacent lines with identical ownership/context form one segment.
    const grouped: Segment[] = [];
    for (const part of fileSegments) {
      const last = grouped.at(-1);
      if (last && part.kind === 'text' && last.kind === 'text' && last.hunk === part.hunk &&
          last.operation === part.operation && last.context === part.context &&
          (part.operation === '+' ? last.newLine! + lines(last.content).length === part.newLine : last.oldLine! + lines(last.content).length === part.oldLine) &&
          JSON.stringify(last.owners) === JSON.stringify(part.owners)) last.content += part.content;
      else grouped.push({ ...part });
    }
    for (const part of grouped) part.sharesHunkWith = unique(grouped
      .filter(other => other !== part && other.hunk === part.hunk && other.row !== part.row)
      .flatMap(other => other.owners.filter((owner): owner is string => owner !== null)));
    segments.push(...grouped);
  }
  return segments;
}

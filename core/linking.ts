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
interface Evidence { owners: (string | null)[]; outOfScope: string[] }
interface TrackedLine { text: string; evidence: Evidence; origins: string[]; moved: Evidence }
interface TrackedFile { lines: TrackedLine[]; metadata: Evidence }
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
const empty = (): Evidence => ({ owners: [], outOfScope: [] });
const combine = (...evidence: Evidence[]): Evidence => ({
  owners: unique(evidence.flatMap(e => e.owners)),
  outOfScope: unique(evidence.flatMap(e => e.outOfScope)),
});
function classify(evidence: Evidence): Pick<Segment, 'row' | 'scope'> {
  const { owners, outOfScope } = evidence;
  if (!owners.length || owners.includes(null)) return { row: 'Unplanned', scope: 'unplanned' };
  if (owners.length > 1) return { row: 'Ambiguous', scope: 'ambiguous' };
  const owner = owners[0]!;
  return { row: owner, scope: outOfScope.includes(owner) ? 'out-of-scope' : 'in-scope' };
}

/** Replays a linear history. Commit messages and Plan-Item trailers are never trusted. */
export function linkHistory(plan: Plan, history: History, ledger: ReadonlyMap<string, string>): Segment[] {
  const files = new Map<string, TrackedFile>();
  const removed = new Map<string, Evidence>();
  // Deletions retain metadata even after the file leaves the tree.
  const metadata = new Map<string, Evidence>();
  let parent = history.base;
  for (const commit of history.commits) {
    if (commit.parent !== parent) throw new Error('Linking requires a contiguous linear history.');
    parent = commit.sha;
    const owner = ledger.get(commit.sha) ?? null;
    if (owner !== null && !plan.items.some(item => item.id === owner)) throw new Error(`Unknown ledger item: ${owner}`);
    for (const delta of commit.files) {
      const oldPath = delta.oldPath;
      const item = plan.items.find(item => item.id === owner);
      const declared = new Set(item?.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]));
      const touched = [delta.oldPath, delta.newPath].filter((path): path is string => path !== null);
      const current: Evidence = { owners: [owner], outOfScope: owner !== null && touched.some(path => !declared.has(path)) ? [owner] : [] };
      let previous = oldPath ? files.get(oldPath) : undefined;
      if (!previous) previous = {
        lines: lines(textFile(delta.before) ? delta.before!.text : '').map((text, i) => ({ text, evidence: empty(), origins: [origin(oldPath!, i)], moved: empty() })),
        metadata: empty(),
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
        const evidence = combine(...deleted.map(line => line.evidence), current);
        const origins = unique(deleted.flatMap(line => line.origins));
        for (const id of origins) removed.set(id, evidence);
        const added = change.added ? change : changes[n + 1]?.added ? changes[++n]! : undefined;
        if (added) for (const text of added.value) next.push({ text, evidence, origins, moved: combine(...deleted.map(line => line.moved)) });
      }
      if (oldPath && delta.newPath && oldPath !== delta.newPath) {
        for (let i = 0; i < next.length; i++) {
          const line = next[i]!;
          next[i] = { ...line, moved: combine(line.moved, current) };
          for (const id of line.origins) if (!removed.has(id)) removed.set(id, combine(line.evidence, current));
        }
      }
      const metadataEvidence = metadataChange(delta) ? combine(previous.metadata, current) : previous.metadata;
      if (oldPath) { files.delete(oldPath); metadata.set(oldPath, metadataEvidence); }
      if (delta.newPath) { files.set(delta.newPath, { lines: next, metadata: metadataEvidence }); metadata.set(delta.newPath, metadataEvidence); }
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
    const push = (part: Omit<Segment, 'row' | 'scope' | 'sharesHunkWith' | 'owners'>, evidence: Evidence) => fileSegments.push({
      ...part, owners: evidence.owners, ...classify(evidence), sharesHunkWith: [],
    });
    if (metadataChange(delta)) {
      const evidence = combine(...affectedPaths.map(path => metadata.get(path) ?? empty()));
      push({ path, oldPath: delta.oldPath, kind: 'file', oldLine: null, newLine: null,
        operation: null, context: '', hunk: -1,
        content: JSON.stringify({ oldPath: delta.oldPath, newPath: delta.newPath,
          oldMode: delta.before?.mode ?? null, newMode: delta.after?.mode ?? null,
          oldOid: delta.before?.oid ?? null, newOid: delta.after?.oid ?? null }),
      }, evidence);
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
        const evidence = change.added
          ? trackedLine?.evidence.owners.length ? trackedLine.evidence : trackedLine?.moved ?? empty()
          : removed.get(origin(delta.oldPath!, oldIndex)) ?? empty();
        const context = delta.contexts.find(range => change.added
          ? newIndex + 1 >= range.newStart && newIndex + 1 < range.newStart + range.newCount
          : oldIndex + 1 >= range.oldStart && oldIndex + 1 < range.oldStart + range.oldCount)?.name ?? '';
        push({ path, oldPath: delta.oldPath, kind: 'text', content: text, context, hunk,
          oldLine: change.removed ? oldIndex + 1 : null, newLine: change.added ? newIndex + 1 : null,
          operation: change.added ? '+' : '-',
        }, evidence);
        if (change.added) newIndex++; else oldIndex++;
      }
    }
    // Adjacent lines with identical ownership/context form one segment.
    const grouped: Segment[] = [];
    for (const part of fileSegments) {
      const last = grouped.at(-1);
      if (last && part.kind === 'text' && last.kind === 'text' && last.hunk === part.hunk &&
          last.operation === part.operation && last.context === part.context && last.scope === part.scope &&
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

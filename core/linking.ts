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
interface TrackedFile { lines: TrackedLine[]; metadata: Evidence; metadataPaths: string[] }
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
function classify(evidence: Evidence): Pick<Segment, 'row' | 'scope'> {
  const { owners, outOfScope } = evidence;
  if (!owners.length || owners.includes(null)) return { row: 'Unplanned', scope: 'unplanned' };
  if (owners.length > 1) return { row: 'Ambiguous', scope: 'ambiguous' };
  const owner = owners[0]!;
  return { row: owner, scope: outOfScope.includes(owner) ? 'out-of-scope' : 'in-scope' };
}

export interface LinkingLimits { maxLines?: number; maxSegments?: number; maxReferences?: number; maxDurationMs?: number }

/** Replays a linear history. Commit messages and Plan-Item trailers are never trusted. */
export function linkHistory(plan: Plan, history: History, ledger: ReadonlyMap<string, string | null>, pathKey: (path: string) => string, limits: LinkingLimits = {}): Segment[] {
  if (typeof pathKey !== 'function') throw new Error('Known checkout path identity is required.');
  const budget = (value: number | undefined, ceiling: number, name: string) => {
    const limit = value ?? ceiling;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) throw new Error(`Invalid ${name} budget.`);
    return limit;
  };
  const maxLines = budget(limits.maxLines, 100_000, 'line');
  const maxSegments = budget(limits.maxSegments, 100_000, 'segment');
  const maxReferences = budget(limits.maxReferences, 1_000_000, 'reference');
  const deadline = performance.now() + budget(limits.maxDurationMs, 30_000, 'duration');
  const remaining = () => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new Error('Linking exceeded its overall deadline.');
    return Math.max(1, Math.min(2000, Math.ceil(ms)));
  };
  let lineCount = 0, segmentCount = 0, references = 0, characters = 0;
  const charge = (count: number) => {
    remaining(); references += count;
    if (references > maxReferences) throw new Error('Linking exceeds its cumulative reference/work budget.');
  };
  const chargeText = (count: number) => {
    characters += count;
    if (characters > 32 * 1024 * 1024) throw new Error('Linking exceeds its cumulative text/origin character budget.');
  };
  const lines = (text: string | null | undefined): string[] => {
    remaining();
    if (!text) return [];
    chargeText(text.length);
    const result: string[] = [];
    for (let start = 0; start < text.length;) {
      if (++lineCount > maxLines) throw new Error('Linking exceeds its cumulative line budget.');
      remaining();
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
      result.push(text.slice(start, end)); start = end;
    }
    return result;
  };
  const combine = (evidence: readonly Evidence[]): Evidence => {
    const owners = new Set<string | null>(), outOfScope = new Set<string>();
    for (const entry of evidence) {
      charge(entry.owners.length + entry.outOfScope.length);
      for (const owner of entry.owners) owners.add(owner);
      for (const owner of entry.outOfScope) outOfScope.add(owner);
    }
    return { owners: [...owners], outOfScope: [...outOfScope] };
  };
  const mergeOrigins = (tracked: readonly TrackedLine[]): string[] => {
    const origins = new Set<string>();
    for (const line of tracked) { charge(line.origins.length); for (const id of line.origins) origins.add(id); }
    return [...origins];
  };
  const files = new Map<string, TrackedFile>();
  const removed = new Map<string, Evidence>();
  // Deletions retain metadata even after the file leaves the tree.
  const metadata = new Map<string, Evidence>();
  let parent = history.base;
  for (const commit of history.commits) {
    remaining();
    if (commit.parent !== parent) throw new Error('Linking requires a contiguous linear history.');
    parent = commit.sha;
    const owner = ledger.get(commit.sha) ?? null;
    if (owner !== null && !plan.items.some(item => item.id === owner)) throw new Error(`Unknown ledger item: ${owner}`);
    for (const delta of commit.files) {
      remaining();
      const oldPath = delta.oldPath;
      const item = plan.items.find(item => item.id === owner);
      const declared = new Set(item?.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]).map(pathKey));
      const touched = [delta.oldPath, delta.newPath].filter((path): path is string => path !== null);
      const current: Evidence = { owners: [owner], outOfScope: owner !== null && touched.some(path => !declared.has(pathKey(path))) ? [owner] : [] };
      let previous = oldPath ? files.get(oldPath) : undefined;
      if (!previous) previous = {
        lines: lines(textFile(delta.before) ? delta.before!.text : '').map((text, i) => {
          charge(1); chargeText((oldPath?.length ?? 0) + 12);
          return { text, evidence: empty(), origins: [origin(oldPath!, i)], moved: empty() };
        }),
        metadata: empty(), metadataPaths: oldPath ? [oldPath] : [],
      };
      const next: TrackedLine[] = [];
      const changes = diffArrays(previous.lines.map(line => line.text), lines(textFile(delta.after) ? delta.after!.text : ''), { timeout: remaining() });
      if (!changes) throw new Error('Line attribution exceeded the diff time budget.');
      let cursor = 0;
      for (let n = 0; n < changes.length; n++) {
        const change = changes[n]!;
        if (!change.added && !change.removed) { for (const line of previous.lines.slice(cursor, cursor + change.value.length)) next.push(line); cursor += change.value.length; continue; }
        const deleted = change.removed ? previous.lines.slice(cursor, cursor + change.value.length) : [];
        if (change.removed) cursor += change.value.length;
        const evidence = combine([...deleted.map(line => line.evidence), current]);
        const origins = mergeOrigins(deleted);
        for (const id of origins) removed.set(id, evidence);
        const added = change.added ? change : changes[n + 1]?.added ? changes[++n]! : undefined;
        if (added) {
          const moved = combine(deleted.map(line => line.moved));
          for (const text of added.value) { charge(origins.length + 1); next.push({ text, evidence, origins, moved }); }
        }
      }
      if (oldPath && delta.newPath && oldPath !== delta.newPath) {
        for (let i = 0; i < next.length; i++) {
          const line = next[i]!;
          next[i] = { ...line, moved: combine([line.moved, current]) };
          charge(line.origins.length);
          for (const id of line.origins) if (!removed.has(id)) removed.set(id, combine([line.evidence, current]));
        }
      }
      const metadataEvidence = metadataChange(delta) ? combine([previous.metadata, current]) : previous.metadata;
      const metadataPaths = unique([...previous.metadataPaths, ...touched]);
      charge(metadataPaths.length);
      for (const path of metadataPaths) metadata.set(path, metadataEvidence);
      if (oldPath) files.delete(oldPath);
      if (delta.newPath) files.set(delta.newPath, { lines: next, metadata: metadataEvidence, metadataPaths });
    }
  }
  if (parent !== history.head) throw new Error('History does not end at the requested head.');
  const segments: Segment[] = [];
  for (const delta of history.final) {
    remaining();
    const path = delta.newPath ?? delta.oldPath!;
    const tracked = delta.newPath ? files.get(delta.newPath) : undefined;
    const oldLines = lines(textFile(delta.before) ? delta.before!.text : '');
    const newLines = lines(textFile(delta.after) ? delta.after!.text : '');
    let oldIndex = 0, newIndex = 0, hunk = 0;
    const fileSegments: Segment[] = [];
    const affectedPaths = unique([delta.oldPath, delta.newPath].filter((p): p is string => p !== null));
    const push = (part: Omit<Segment, 'row' | 'scope' | 'sharesHunkWith' | 'owners'>, evidence: Evidence) => {
      remaining();
      if (++segmentCount > maxSegments) throw new Error('Linking exceeds its cumulative segment budget.');
      fileSegments.push({ ...part, owners: evidence.owners, ...classify(evidence), sharesHunkWith: [] });
    };
    if (metadataChange(delta)) {
      const evidence = combine(affectedPaths.map(path => metadata.get(path) ?? empty()));
      push({ path, oldPath: delta.oldPath, kind: 'file', oldLine: null, newLine: null,
        operation: null, context: '', hunk: -1,
        content: JSON.stringify({ oldPath: delta.oldPath, newPath: delta.newPath,
          oldMode: delta.before?.mode ?? null, newMode: delta.after?.mode ?? null,
          oldObject: delta.before ? { kind: delta.before.mode === '160000' ? 'commit' : 'blob', oid: delta.before.oid } : null,
          newObject: delta.after ? { kind: delta.after.mode === '160000' ? 'commit' : 'blob', oid: delta.after.oid } : null }),
      }, evidence);
    }
    const finalChanges = diffArrays(oldLines, newLines, { timeout: remaining() });
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
    let groupedLineCount = 0;
    for (const part of fileSegments) {
      remaining();
      const last = grouped.at(-1);
      if (last && part.kind === 'text' && last.kind === 'text' && last.hunk === part.hunk &&
          last.operation === part.operation && last.context === part.context && last.scope === part.scope &&
          (part.operation === '+' ? last.newLine! + groupedLineCount === part.newLine : last.oldLine! + groupedLineCount === part.oldLine) &&
          JSON.stringify(last.owners) === JSON.stringify(part.owners)) { last.content += part.content; groupedLineCount++; }
      else { grouped.push({ ...part }); groupedLineCount = part.kind === 'text' ? 1 : 0; }
    }
    const hunkRows = new Map<number, Map<string, Set<string>>>();
    for (const part of grouped) {
      charge(part.owners.length + 1);
      let rows = hunkRows.get(part.hunk);
      if (!rows) { rows = new Map(); hunkRows.set(part.hunk, rows); }
      let owners = rows.get(part.row);
      if (!owners) { owners = new Set(); rows.set(part.row, owners); }
      for (const owner of part.owners) if (owner !== null) owners.add(owner);
    }
    const sharing = new Map<number, Map<string, string[]>>();
    for (const [hunk, rows] of hunkRows) {
      const byRow = new Map<string, string[]>(); sharing.set(hunk, byRow);
      for (const row of rows.keys()) {
        const owners = new Set<string>();
        for (const [otherRow, otherOwners] of rows) {
          charge(1);
          if (row === otherRow) continue;
          charge(otherOwners.size);
          for (const owner of otherOwners) owners.add(owner);
        }
        byRow.set(row, [...owners]);
      }
    }
    for (const part of grouped) {
      const owners = sharing.get(part.hunk)!.get(part.row)!;
      charge(owners.length);
      part.sharesHunkWith = [...owners];
    }
    for (const part of grouped) segments.push(part);
  }
  remaining();
  return segments;
}

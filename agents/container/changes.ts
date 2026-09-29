import { createHash } from 'node:crypto';
import { runStorageScript, taskMetadataBaseline, type RecoveredTaskStorage, type StorageScriptOptions,
  type TaskFilesystems } from './storage.ts';
import { MAXIMUM_CHANGES, MAXIMUM_TARGET_ENTRIES, MAXIMUM_TREE_OUTPUT, TREE_SCRIPT } from './tree-script.ts';

export { MAXIMUM_CHANGES, MAXIMUM_TARGET_ENTRIES };

/** What an entry is, as the change manifest reports it. `other` is a fifo, socket or device. */
export type EntryType = 'file' | 'symlink' | 'gitlink' | 'directory' | 'other';

/**
 * One difference between the work tree and the tree of `base`, read without following links (#66). A tracked file
 * counts as changed only when its stat no longer matches the index the seeder refreshed from `base` (its ctime, which
 * no agent can set, changes on any write) and Git would now store different content. Content IDs are the blobs Git
 * would store, hashed with the work tree's attributes as a commit would, so what the audit approves is what a commit
 * stores. A link target is compared as it is.
 */
export interface TaskChange {
  readonly path: string;
  /** For a rename: where the entry was. Only an exact rename (same type and content) is paired. */
  readonly oldPath?: string;
  /** `modify` covers a type change too, with `oldType` and `newType` both set; `mode` is a change of mode only. */
  readonly kind: 'add' | 'modify' | 'delete' | 'rename' | 'mode';
  readonly oldType?: EntryType;
  readonly newType?: EntryType;
  /** Git modes: `100644`, `100755`, `120000` (symlink) or `160000` (gitlink). A directory or `other` has none. */
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly newLinkTarget?: string;
  /** Whether a part of the path is named `.git` (in any case): Git will never commit it. */
  readonly underGit: boolean;
  /**
   * Whether `base`'s own ignore rules (its `.gitignore` files and the repository's `info/exclude`, never the agent's
   * edits) ignore this new path. An ignored new directory with no tracked entry beneath it is reported once, as an
   * `add` of type `directory`, and nothing inside it is listed.
   */
  readonly ignored: boolean;
}

/** One entry of a declared link's target, as lstat saw it. */
export interface TargetEntry {
  readonly path: string;
  readonly type: Exclude<EntryType, 'gitlink'>;
  /** The full st_mode in octal. */
  readonly mode: string;
  readonly gitMode?: string;
  readonly size: number;
  readonly ino: number;
  readonly ctime: string;
  readonly mtime: string;
  readonly oid?: string;
  readonly linkTarget?: string;
}
/** Where a declared link's target resolves, by name only, and what is there. */
export interface TargetState {
  /**
   * `present`: `entries` is the target and everything beneath it. `absent`: nothing is there (or a part on the way is
   * missing or not a directory), and `anchor` is the nearest existing entry; its inode shows whether it was replaced
   * (its times also change when a sibling is created, so they are not compared). `through-link`: a part on the way is
   * a link, which `anchor` names. The link is resolved one part at a time, as the kernel does, so `a/..` goes through
   * `a`.
   */
  readonly status: 'present' | 'absent' | 'through-link';
  readonly entries?: readonly TargetEntry[];
  readonly anchor?: TargetEntry;
}
export interface DeclaredLink extends Omit<Partial<TargetState>, 'status'> {
  readonly link: string;
  readonly linkTarget?: string;
  /** The target's path in the work tree, when it resolves inside it through real directories. */
  readonly target?: string;
  /**
   * Besides the target states: `not-a-link` (the declared path is not a symlink), `outside` (the target is absolute
   * or climbs out of the work tree) and `metadata` (it points into `.git`). None of those has a target to watch.
   */
  readonly status: TargetState['status'] | 'not-a-link' | 'outside' | 'metadata';
}
/** Taken before launch and kept by F; `inspectTaskChanges` compares every recorded target with what is there after. */
export interface DeclaredLinkSnapshot {
  readonly links: readonly DeclaredLink[];
}
/** A difference in a declared link's target between the snapshot and the inspection. */
export interface LinkTargetChange {
  readonly link: string;
  /** Where the link resolved before launch; empty when it did not resolve inside the work tree. */
  readonly target: string;
  /** The entry that differs: the target, something beneath it, the anchor, or the link itself for `retargeted`. */
  readonly path: string;
  /**
   * `content`, `mode` and `type` as named; `created` and `deleted` for an entry that appeared or went; `identity` for
   * the same content under a new inode or ctime (a rewrite, a chmod back, a hard link); `status` for a change between
   * present, absent and through a link; `retargeted` when the link now resolves somewhere else (its own text changed,
   * or a directory on the way did).
   */
  readonly change: 'content' | 'mode' | 'type' | 'created' | 'deleted' | 'identity' | 'status' | 'retargeted';
}

/** What an agent changed in task storage, for F2a's audit. Every check fails closed: nothing is left out. */
export interface TaskChangeManifest {
  readonly base: string;
  readonly changes: readonly TaskChange[];
  /** Commits on top of `base`. The metadata volume is read-only to agents, so any entry here means needs human. */
  readonly agentCommits: readonly string[];
  /** Whether anything under `.git` differs from the baseline the seeder recorded. `true` means needs human. */
  readonly metadataChanged: boolean;
  readonly linkTargetChanges: readonly LinkTargetChange[];
  /** Gitlink paths with anything in them, or that cannot be read. */
  readonly nestedGitlinkContent: readonly string[];
  /** SHA-256 of the manifest without this field, as canonical JSON. `commitTaskChanges` recomputes and compares it. */
  readonly digest: string;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
// A declared path names one entry of the work tree by its Git path: relative, no empty, `.` or `..` part, and not the
// metadata. Control characters cannot appear in a manifest.
const assertDeclaredPath = (path: unknown) => {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => part === '' || part === '.' || part === '..') || path.split('/')[0] === '.git')
    throw new Error(`Declared path ${JSON.stringify(path)} is not a path in the work tree.`);
};
// Every argument, and the whole list, must fit what the kernel lets one exec carry, with room for the script.
const MAXIMUM_ARGUMENT_BYTES = 64 * 1024;
const assertArguments = (values: readonly string[]) => {
  if (values.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0) > MAXIMUM_ARGUMENT_BYTES)
    throw new Error('Too many declared paths to pass to the storage container at once.');
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
/** The digest of a manifest: SHA-256 of its canonical JSON without the `digest` field. */
export function manifestDigest(manifest: Omit<TaskChangeManifest, 'digest'> | TaskChangeManifest): string {
  const { digest: _ignored, ...rest } = manifest as TaskChangeManifest;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/**
 * Record, before launch, where each declared link's target resolves (by name, never through the filesystem) and the
 * state of that target and everything beneath it, including the nearest existing directory above a dangling target.
 * Runs in a read-only container over the storage with no network. F keeps the result and passes it to
 * `inspectTaskChanges`. More than `MAXIMUM_TARGET_ENTRIES` entries beneath one target fails rather than truncates.
 */
export async function snapshotDeclaredLinks(storage: TaskFilesystems | RecoveredTaskStorage, paths: readonly string[],
  options: StorageScriptOptions): Promise<DeclaredLinkSnapshot> {
  if (!Array.isArray(paths)) throw new Error('Declared paths must be a list.');
  for (const path of paths) assertDeclaredPath(path);
  assertArguments(paths);
  if (paths.length === 0) return deepFreeze({ links: [] });
  const stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Declared link snapshot',
    consequence: 'declared links cannot be recorded', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT,
    args: ['-e', TREE_SCRIPT, 'snapshot', ...paths] }, { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  const snapshot = JSON.parse(stdout) as DeclaredLinkSnapshot;
  if (!Array.isArray(snapshot.links) || snapshot.links.length !== paths.length)
    throw new Error('The declared link snapshot did not cover every declared path.');
  return deepFreeze(snapshot);
}

export interface InspectOptions extends StorageScriptOptions {
  /** The commit the storage was seeded from: the clone's head. */
  readonly base: string;
  /** What `snapshotDeclaredLinks` returned before launch. */
  readonly linkSnapshot: DeclaredLinkSnapshot;
  /**
   * The metadata baseline the storage value carried (`metadataBaseline`). Required for a recovery handle, since D
   * keeps no record of it across a restart; for an allocated value it must match D's own when given.
   */
  readonly metadataBaseline?: string;
}

const sameIdentity = (a: TargetEntry, b: TargetEntry) => a.ino === b.ino && a.ctime === b.ctime && a.mtime === b.mtime;
function compareTarget(link: string, target: string, before: TargetState, after: TargetState): LinkTargetChange[] {
  const change = (path: string, kind: LinkTargetChange['change']) => ({ link, target, path, change: kind });
  if (before.status !== after.status) return [change(target, 'status')];
  if (before.status !== 'present') {
    const [a, b] = [before.anchor!, after.anchor!];
    if (a.path !== b.path || a.type !== b.type) return [change(a.path, 'status')];
    // Creating the target itself shows as a status change; a sibling created beside it is not a write through the link.
    return a.ino === b.ino ? [] : [change(a.path, 'identity')];
  }
  const now = new Map((after.entries ?? []).map(entry => [entry.path, entry]));
  const changes: LinkTargetChange[] = [];
  for (const old of before.entries ?? []) {
    const current = now.get(old.path);
    now.delete(old.path);
    if (!current) changes.push(change(old.path, 'deleted'));
    else if (current.type !== old.type) changes.push(change(old.path, 'type'));
    else if (current.oid !== old.oid || current.size !== old.size || current.linkTarget !== old.linkTarget)
      changes.push(change(old.path, 'content'));
    else if (current.mode !== old.mode) changes.push(change(old.path, 'mode'));
    else if (!sameIdentity(current, old)) changes.push(change(old.path, 'identity'));
  }
  for (const path of now.keys()) changes.push(change(path, 'created'));
  return changes;
}

interface InspectOutput {
  readonly metadataDigest: string;
  readonly head: string;
  readonly agentCommits: readonly string[];
  readonly changes: readonly TaskChange[];
  readonly nestedGitlinkContent: readonly string[];
  /** Each declared link resolved again, in snapshot order. */
  readonly links: readonly DeclaredLink[];
  /** The state now of each target the snapshot recorded, by path. */
  readonly targets: Readonly<Record<string, TargetState>>;
}

/**
 * Compare the work tree with the tree of `base` after an invocation settled, without following links, and return the
 * change manifest F2a audits (#66). Every regular file is hashed as raw bytes, so no Git attribute can hide an edit,
 * and every entry is seen: ignored files, fifos, anything under a `.git` part, and anything in a gitlink directory
 * (reported in `nestedGitlinkContent`). Runs in a read-only container over the storage with no network. It fails,
 * rather than returns part of the answer, on more than `MAXIMUM_CHANGES` changes, on a name or link target that is not
 * printable UTF-8, and on anything it cannot read.
 */
export async function inspectTaskChanges(storage: TaskFilesystems | RecoveredTaskStorage,
  options: InspectOptions): Promise<TaskChangeManifest> {
  if (typeof options.base !== 'string' || !COMMIT_ID.test(options.base)) throw new Error('base must be a full commit ID.');
  const known = taskMetadataBaseline(storage);
  if (options.metadataBaseline !== undefined && !DIGEST.test(options.metadataBaseline))
    throw new Error('metadataBaseline must be the SHA-256 the storage value carried.');
  if (known && options.metadataBaseline !== undefined && options.metadataBaseline !== known)
    throw new Error('metadataBaseline does not match the one recorded when this storage was seeded.');
  const baseline = known ?? options.metadataBaseline;
  if (!baseline) throw new Error('A recovered storage handle needs the metadataBaseline F recorded at allocation.');
  const links = options.linkSnapshot?.links;
  if (!Array.isArray(links)) throw new Error('linkSnapshot must be what snapshotDeclaredLinks returned.');
  for (const link of links) assertDeclaredPath(link?.link);
  const targets = [...new Set(links.flatMap(link => link.target === undefined ? [] : [link.target]))];
  for (const target of targets) assertDeclaredPath(target);
  assertArguments([...links.map(link => link.link), ...targets]);
  const stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Task change inspection',
    consequence: 'changes cannot be inspected', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT,
    args: ['-e', TREE_SCRIPT, 'inspect', options.base, ...links.map(link => link.link), '--', ...targets] },
  { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  const output = JSON.parse(stdout) as InspectOutput;
  if (!DIGEST.test(output.metadataDigest) || !Array.isArray(output.changes) || !Array.isArray(output.agentCommits)
    || !Array.isArray(output.nestedGitlinkContent) || !Array.isArray(output.links) || output.links.length !== links.length
    || typeof output.targets !== 'object' || output.targets === null)
    throw new Error('The change inspection returned an unexpected result.');
  const linkTargetChanges = links.flatMap((before, index) => {
    const after = output.links[index]!, target = before.target ?? '';
    const change = (path: string, kind: LinkTargetChange['change']) => ({ link: before.link, target, path, change: kind });
    if (after.link !== before.link) throw new Error('The change inspection resolved the declared links out of order.');
    const found: LinkTargetChange[] = [];
    // Where it resolves now: its text, or a directory on the way, may have changed.
    if (after.linkTarget !== before.linkTarget || after.target !== before.target) found.push(change(before.link, 'retargeted'));
    else if (after.status !== before.status) found.push(change(before.link, 'status'));
    else if (before.target === undefined && before.anchor
      && (after.anchor?.path !== before.anchor.path || after.anchor?.type !== before.anchor.type
        || after.anchor?.ino !== before.anchor.ino))
      found.push(change(before.anchor.path, 'identity'));
    // What the target recorded before launch holds now, even if the link was pointed elsewhere.
    if (before.target !== undefined) {
      const now = output.targets[before.target];
      if (!now) throw new Error('The change inspection did not report every declared link target.');
      found.push(...compareTarget(before.link, before.target, before as TargetState, now));
    }
    return found;
  });
  const manifest = { base: options.base, changes: output.changes, agentCommits: output.agentCommits,
    metadataChanged: output.metadataDigest !== baseline, linkTargetChanges,
    nestedGitlinkContent: output.nestedGitlinkContent };
  return deepFreeze({ ...manifest, digest: manifestDigest(manifest) });
}

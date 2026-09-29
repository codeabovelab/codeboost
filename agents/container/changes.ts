import { createHash } from 'node:crypto';
import { resolveMetadataBaseline, runStorageScript, type RecoveredTaskStorage, type StorageScriptOptions,
  type TaskFilesystems } from './storage.ts';
import { MAXIMUM_CHANGES, MAXIMUM_DECLARED_LINKS, MAXIMUM_NAME_BYTES, MAXIMUM_TARGET_ENTRIES, MAXIMUM_TREE_OUTPUT,
  TREE_SCRIPT } from './tree-script.ts';

export { MAXIMUM_CHANGES, MAXIMUM_DECLARED_LINKS, MAXIMUM_NAME_BYTES, MAXIMUM_TARGET_ENTRIES };
// Walking a large checkout holds every path in memory: more than an export needs.
const INSPECTION_MEMORY = '1g';
// The scratch index an inspection hashes into holds an entry for every file of base.
const INSPECTION_TMP = '512m';

/** What an entry is, as the change manifest reports it. `other` is a fifo, socket or device. */
export type EntryType = 'file' | 'symlink' | 'gitlink' | 'directory' | 'other';

/**
 * One difference between the work tree and the tree of `base`, read without following links (#66). Every file is read
 * and hashed as the blob Git would store, with the work tree's attributes (only those: a deleted `.gitattributes`, or
 * one Git will not read, such as a symlink, applies no rules); a tracked file counts as changed when that blob or its
 * mode differs from `base`. A file whose stored blob would not change (an honest CRLF checkout, say) is not a change.
 * The commit step (#66 part 2) builds its tree from `base` plus these changes, storing each file the same way, so what
 * the audit approves is what is committed. A link target is compared as it is.
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
   * (its times also change when a sibling is created, so they are not compared). `through-link`: a part on the way, the
   * target itself, or an entry inside a directory target is a link, which `anchor` names; a write would go on to
   * wherever it points. The link is resolved one part at a time, as the kernel does, so `a/..` goes through `a`.
   */
  readonly status: 'present' | 'absent' | 'through-link';
  readonly entries?: readonly TargetEntry[];
  readonly anchor?: TargetEntry;
}
export interface DeclaredLink {
  readonly link: string;
  readonly linkTarget?: string;
  /**
   * The target's path in the work tree, when it resolves inside it; its state is in the snapshot's `targets`. With a
   * target, `status` is that state's status.
   */
  readonly target?: string;
  /** For a link that stops before a target (`absent` or `through-link` on the way): the entry it stopped at. */
  readonly anchor?: TargetEntry;
  /**
   * Besides the target states: `not-a-link` (the declared path is not a symlink), `outside` (the target is outside the
   * work tree, is the work tree itself, or passes through anything outside it on the way, which D cannot check from the
   * storage) and `metadata` (it points into `.git`). None of those has a target to watch.
   */
  readonly status: TargetState['status'] | 'not-a-link' | 'outside' | 'metadata';
}
/**
 * Taken before launch and kept by F; `inspectTaskChanges` compares every recorded target with what is there after. F
 * must not launch an item with a declared link whose status is `through-link`: a write through it would land somewhere
 * the snapshot does not watch as the link's target (plan-format.md: a target never goes through another link).
 */
export interface DeclaredLinkSnapshot {
  readonly links: readonly DeclaredLink[];
  /** Each target's state, once, by path: two links to one target share it. */
  readonly targets: Readonly<Record<string, TargetState>>;
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
  /**
   * Whether anything under `.git` differs from the baseline the seeder recorded. `true` means needs human. Git reads
   * that config, so when it changed no Git command runs and nothing else is read: every other list is then empty.
   */
  readonly metadataChanged: boolean;
  readonly linkTargetChanges: readonly LinkTargetChange[];
  /** Gitlink paths with anything in them, or that cannot be read. */
  readonly nestedGitlinkContent: readonly string[];
  /**
   * SHA-256 of the manifest without this field, as canonical JSON (`manifestDigest`). The commit step (#66 part 2) is
   * to recompute it and refuse a work tree that no longer matches.
   */
  readonly digest: string;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The script refuses output past MAXIMUM_TREE_OUTPUT itself; the runner keeps a little more so that refusal, with its
// reason, is what reaches the caller.
const OUTPUT_SLACK = 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
// A declared path names one entry of the work tree by its Git path: relative, no empty, `.` or `..` part, and not the
// metadata. It must be a name the manifest can carry: no control or format characters or separators, and not too long.
const assertDeclaredPath = (path: unknown) => {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/u.test(path)
    || Buffer.byteLength(path) > MAXIMUM_NAME_BYTES
    || path.split('/').some(part => part === '' || part === '.' || part === '..') || path.split('/')[0] === '.git')
    throw new Error(`Declared path ${JSON.stringify(path)} is not a path in the work tree.`);
};
// Every argument, and the whole list, must fit what the kernel lets one exec carry, with room for the script. It holds
// the most a snapshot can pass on to its inspection: every declared link and every distinct target, each at the name
// limit, so a snapshot that was accepted can always be inspected.
const MAXIMUM_ARGUMENT_BYTES = 2 * MAXIMUM_DECLARED_LINKS * (MAXIMUM_NAME_BYTES + 1);
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
 * Record, before launch, where each declared link resolves (one part at a time, as the kernel would in an agent
 * container) and the state of its target and everything beneath it, or the nearest existing entry for a dangling one.
 * A link on the way, a target that is itself a link, or a link inside a directory target makes it `through-link`.
 * Runs in a read-only container over the storage with no network. F keeps the result and passes it to
 * `inspectTaskChanges`. More than `MAXIMUM_TARGET_ENTRIES` entries beneath all targets together fails rather than
 * truncates.
 */
export async function snapshotDeclaredLinks(storage: TaskFilesystems | RecoveredTaskStorage, paths: readonly string[],
  options: StorageScriptOptions & { readonly metadataBaseline?: string }): Promise<DeclaredLinkSnapshot> {
  const baseline = resolveMetadataBaseline(storage, options.metadataBaseline);
  if (!Array.isArray(paths)) throw new Error('Declared paths must be a list.');
  if (paths.length > MAXIMUM_DECLARED_LINKS) throw new Error(`At most ${MAXIMUM_DECLARED_LINKS} declared paths are recorded.`);
  for (const path of paths) assertDeclaredPath(path);
  assertArguments(paths);
  // Run even with nothing declared: the metadata check before launch is part of the answer.
  const stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Declared link snapshot',
    consequence: 'declared links cannot be recorded', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK,
    memory: INSPECTION_MEMORY, tmpBytes: INSPECTION_TMP,
    args: ['-e', TREE_SCRIPT, 'snapshot', baseline, ...paths] }, { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  const snapshot = JSON.parse(stdout) as DeclaredLinkSnapshot;
  if (!Array.isArray(snapshot.links) || snapshot.links.length !== paths.length || typeof snapshot.targets !== 'object'
    || snapshot.targets === null || snapshot.links.some(link => link.target !== undefined && !snapshot.targets[link.target]))
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
// An anchor is compared by what shows it was replaced or repointed: its inode, and for a link, where it points. Its
// times are not compared: they change whenever a sibling is created beside a dangling target.
const sameAnchor = (a: TargetEntry | undefined, b: TargetEntry | undefined) => a?.path === b?.path && a?.type === b?.type
  && a?.ino === b?.ino && a?.linkTarget === b?.linkTarget;
function compareTarget(link: string, target: string, before: TargetState, after: TargetState): LinkTargetChange[] {
  const change = (path: string, kind: LinkTargetChange['change']) => ({ link, target, path, change: kind });
  if (before.status !== after.status) return [change(target, 'status')];
  // A directory target that holds a link is through-link but still carries every entry, and all of them are compared
  // below. Without entries (absent, or stopped at a link), the anchor is what can change.
  if (before.entries === undefined) {
    // Creating the target itself shows as a status change; a sibling created beside it is not a write through the link.
    return sameAnchor(before.anchor, after.anchor) ? [] : [change(before.anchor?.path ?? target, 'identity')];
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
 * change manifest F2a audits (#66). Content IDs are what a commit would store (see `TaskChange`). Entries Git would
 * skip are listed too: new ignored files, fifos, anything under a `.git` part, and anything in a gitlink directory
 * (reported in `nestedGitlinkContent`); a new directory that base's rules ignore is one entry. Each declared link is
 * resolved again and each target the snapshot recorded is compared with what is there now. Runs in a read-only
 * container over the storage with no network. It fails, rather than returns part of the answer, on: more than
 * `MAXIMUM_CHANGES` changes; a name or link target longer than `MAXIMUM_NAME_BYTES` or not strict printable UTF-8; more
 * than `MAXIMUM_TARGET_ENTRIES` entries beneath the recorded targets; anything it cannot read; a `base` that is not a
 * commit there; and any Git failure. F treats every refusal as needs human.
 */
export async function inspectTaskChanges(storage: TaskFilesystems | RecoveredTaskStorage,
  options: InspectOptions): Promise<TaskChangeManifest> {
  if (typeof options.base !== 'string' || !COMMIT_ID.test(options.base)) throw new Error('base must be a full commit ID.');
  const baseline = resolveMetadataBaseline(storage, options.metadataBaseline);
  const links = options.linkSnapshot?.links, recorded = options.linkSnapshot?.targets;
  if (!Array.isArray(links) || links.length > MAXIMUM_DECLARED_LINKS || typeof recorded !== 'object' || recorded === null
    || links.some(link => link?.target !== undefined && !recorded[link.target]))
    throw new Error('linkSnapshot must be what snapshotDeclaredLinks returned.');
  for (const link of links) assertDeclaredPath(link?.link);
  const targets = [...new Set(links.flatMap(link => link.target === undefined ? [] : [link.target]))];
  for (const target of targets) assertDeclaredPath(target);
  assertArguments([...links.map(link => link.link), ...targets]);
  const stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Task change inspection',
    consequence: 'changes cannot be inspected', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK,
    memory: INSPECTION_MEMORY, tmpBytes: INSPECTION_TMP,
    args: ['-e', TREE_SCRIPT, 'inspect', baseline, options.base, String(links.length), ...links.map(link => link.link), ...targets] },
  { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  const output = JSON.parse(stdout) as InspectOutput & { readonly metadataOnly?: boolean };
  // The metadata changed: no Git command ran, so nothing else was read. That alone sends the task to needs human.
  if (output.metadataOnly === true) {
    if (!DIGEST.test(output.metadataDigest) || output.metadataDigest === baseline)
      throw new Error('The change inspection returned an unexpected result.');
    const manifest = { base: options.base, changes: [], agentCommits: [], metadataChanged: true, linkTargetChanges: [],
      nestedGitlinkContent: [] };
    return deepFreeze({ ...manifest, digest: manifestDigest(manifest) });
  }
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
    // A link that stopped before a target (not a link, outside, through a link or missing on the way) is compared here;
    // a target's own state is compared below, from a full walk.
    else if (before.target === undefined) {
      if (after.status !== before.status) found.push(change(before.link, 'status'));
      else if (!sameAnchor(before.anchor, after.anchor)) found.push(change(before.anchor?.path ?? before.link, 'identity'));
    }
    // What the target recorded before launch holds now, even if the link was pointed elsewhere.
    if (before.target !== undefined) {
      const now = output.targets[before.target];
      if (!now) throw new Error('The change inspection did not report every declared link target.');
      found.push(...compareTarget(before.link, before.target, recorded[before.target]!, now));
    }
    return found;
  });
  const manifest = { base: options.base, changes: output.changes, agentCommits: output.agentCommits,
    metadataChanged: output.metadataDigest !== baseline, linkTargetChanges,
    nestedGitlinkContent: output.nestedGitlinkContent };
  return deepFreeze({ ...manifest, digest: manifestDigest(manifest) });
}

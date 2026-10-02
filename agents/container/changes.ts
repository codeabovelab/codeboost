import { constants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { DockerError } from '../docker.ts';
import { resolveMetadataBaseline, runStorageScript, type RecoveredTaskStorage, type StorageScriptOptions,
  type TaskFilesystems } from './storage.ts';
import { MAXIMUM_CHANGES, MAXIMUM_DECLARED_LINKS, MAXIMUM_NAME_BYTES, MAXIMUM_TARGET_ENTRIES, MAXIMUM_TREE_OUTPUT,
  TASK_COMMIT_REF, TREE_SCRIPT } from './tree-script.ts';

export { MAXIMUM_CHANGES, MAXIMUM_DECLARED_LINKS, MAXIMUM_NAME_BYTES, MAXIMUM_TARGET_ENTRIES, TASK_COMMIT_REF };
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
 * mode differs from `base`. Its content is unchanged when the blob Git would store is base's (an honest CRLF
 * checkout, say), when its bytes are exactly base's blob whatever rules the work tree has now, or when its bytes are
 * exactly what checking out base's blob writes under base's own attributes, as the clone's checkout wrote it (a file
 * base stores in a form Git would now store differently).
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
  /**
   * For a change whose new entry is a symlink: whether its target, resolved one part at a time as the kernel would in
   * an agent container, passes through another link on the way or is a link itself. A target outside the work tree or
   * in the metadata counts as `true`, since D cannot check it.
   */
  readonly linkTargetTraversesLink?: boolean;
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
   * or a directory on the way did). A `retargeted` link the item itself edits is that edit, judged by the plan's link
   * rules; every other kind is a change to what the link points at.
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

// Checks an inspection's inputs and returns the script arguments after the mode: baseline, base, then the links.
function inspectionInput(storage: TaskFilesystems | RecoveredTaskStorage, options: InspectOptions) {
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
  return { baseline, links, recorded, linkArgs: [String(links.length), ...links.map(link => link.link), ...targets] };
}

// The manifest from what the script printed: the same for an inspection and for a commit, so the commit's digest is
// the inspection's whenever the work tree is the same.
function manifestOf(base: string, { baseline, links, recorded }: ReturnType<typeof inspectionInput>,
  output: InspectOutput & { readonly metadataOnly?: boolean }): TaskChangeManifest {
  // The metadata changed: no Git command ran, so nothing else was read. That alone sends the task to needs human.
  if (output.metadataOnly === true) {
    if (!DIGEST.test(output.metadataDigest) || output.metadataDigest === baseline)
      throw new Error('The change inspection returned an unexpected result.');
    const manifest = { base, changes: [], agentCommits: [], metadataChanged: true, linkTargetChanges: [],
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
  const manifest = { base, changes: output.changes, agentCommits: output.agentCommits,
    metadataChanged: output.metadataDigest !== baseline, linkTargetChanges,
    nestedGitlinkContent: output.nestedGitlinkContent };
  return deepFreeze({ ...manifest, digest: manifestDigest(manifest) });
}

/**
 * Compare the work tree with the tree of `base` after an invocation settled, without following links, and return the
 * change manifest F2a audits (#66). Content IDs are what a commit would store (see `TaskChange`). Entries Git would
 * skip are listed too: new ignored files, fifos, anything under a `.git` part, and anything in a gitlink directory
 * (reported in `nestedGitlinkContent`); a new directory that base's rules ignore is one entry. Each declared link is
 * resolved again and each target the snapshot recorded is compared with what is there now. Runs in a read-only
 * container over the storage with no network. It fails, rather than returns part of the answer, on: more than
 * `MAXIMUM_CHANGES` changes; a reported name or link target longer than `MAXIMUM_NAME_BYTES`, not strict UTF-8, or
 * holding a Unicode control, format, separator or unassigned character (Cc, Cf, Zl, Zp, Cn); more
 * than `MAXIMUM_TARGET_ENTRIES` entries beneath the recorded targets; anything it cannot read; a `base` that is not a
 * commit there; and any Git failure. F treats every refusal as needs human.
 */
export async function inspectTaskChanges(storage: TaskFilesystems | RecoveredTaskStorage,
  options: InspectOptions): Promise<TaskChangeManifest> {
  const input = inspectionInput(storage, options);
  const stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Task change inspection',
    consequence: 'changes cannot be inspected', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK,
    memory: INSPECTION_MEMORY, tmpBytes: INSPECTION_TMP,
    args: ['-e', TREE_SCRIPT, 'inspect', input.baseline, options.base, ...input.linkArgs] },
  { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  return manifestOf(options.base, input, JSON.parse(stdout));
}

/** One file operation a plan item declares, as the plan names it (`renamedFrom` only for a rename). */
export interface DeclaredOperation {
  readonly kind: 'add' | 'edit' | 'delete' | 'rename';
  readonly path: string;
  readonly renamedFrom?: string | null;
}
export interface TreeCheckOptions extends StorageScriptOptions {
  /** The recorded head the storage was seeded from: the clone's head. */
  readonly base: string;
  /** The item's file operations, checked against the tree of `base`. */
  readonly operations: readonly DeclaredOperation[];
  /** As for `inspectTaskChanges`. */
  readonly metadataBaseline?: string;
}
/**
 * What `checkTaskTree` found, for the execute or fix profile of the same storage. Each check is one-shot: one profile
 * uses it, and the next invocation needs a new check.
 */
export interface TaskTreeCheck {
  readonly base: string;
  /** Every gitlink of `base`, each an empty directory now; each gets an empty read-only mount. */
  readonly gitlinks: readonly string[];
}
/**
 * The item must not launch on this storage: the tree is not a clean copy of the head, an operation does not fit the
 * head, or a gitlink cannot be mounted. Each entry of `differences` says why. A person must look; retrying the same
 * head and plan gives the same answer.
 */
export class TaskTreeRefused extends Error {
  readonly differences: readonly string[];
  constructor(differences: readonly string[]) {
    const shown = differences.slice(0, 10).join('; ');
    super(`The pre-launch tree check refused: ${shown}${differences.length > 10
      ? `; and ${differences.length - 10} more` : ''}.`);
    this.name = 'TaskTreeRefused';
    this.differences = Object.freeze([...differences]);
  }
}
/** The most gitlinks one profile mounts; a head with more refuses the launch. */
export const MAXIMUM_GITLINK_MOUNTS = 256;
// The storage each check was made over, and whether a profile has used it.
const treeChecks = new WeakMap<TaskTreeCheck, { filesystems: TaskFilesystems; used: boolean }>();
// Docker reads `--mount` as comma-separated fields that a double quote can open: a name with either cannot be mounted
// exactly where it is.
const unmountable = (path: string) => /[,"]/.test(path);
const KINDS = new Set(['add', 'edit', 'delete', 'rename']);
interface DeclaredFact { readonly path: string; readonly type: EntryType | 'absent'; readonly blockedBy?: string;
  readonly blockedByType?: EntryType }

// Why the storage is not a fresh copy of `base`: every change, nested content, commit or metadata difference.
function treeDifferences(manifest: TaskChangeManifest): string[] {
  if (manifest.metadataChanged) return ['the Git metadata differs from what the seeder recorded'];
  const q = JSON.stringify, found: string[] = [];
  if (manifest.agentCommits.length) found.push('HEAD is not the recorded head');
  for (const change of manifest.changes) {
    if (change.kind === 'add') found.push(`${q(change.path)} is a ${change.newType} the head does not have`);
    else if (change.kind === 'delete') found.push(`${q(change.path)} is missing`);
    else if (change.kind === 'rename') found.push(`${q(change.path)} is ${q(change.oldPath)} moved`);
    else if (change.oldType !== change.newType) found.push(`${q(change.path)} is a ${change.newType} where the head has a ${change.oldType}`);
    else found.push(`${q(change.path)} differs from the head`);
  }
  for (const path of manifest.nestedGitlinkContent) found.push(`gitlink ${q(path)} has content or cannot be read`);
  return found;
}

/**
 * Check task storage immediately before an execute or fix invocation (plan-format.md, "Clean invocation state" and
 * "Submodules in version 1"): read without following links, the work tree must be exactly the tree of `base` (no
 * untracked or ignored entry, no changed type or content, nothing in a gitlink directory, HEAD at `base`, metadata as
 * seeded), and each declared operation must fit that tree: an add or rename destination is free, an edit, delete or
 * rename source is a file or symlink, and no declared path lies beneath a file, symlink or gitlink. It refuses with
 * `TaskTreeRefused` otherwise, and when a gitlink cannot be given its empty read-only mount (more than
 * `MAXIMUM_GITLINK_MOUNTS`, or a name Docker cannot take). Runs the inspection's read-only, no-network container.
 * The result is the capability `createContainerProfile` needs for an execute or fix profile over this storage.
 */
export async function checkTaskTree(storage: TaskFilesystems, options: TreeCheckOptions): Promise<TaskTreeCheck> {
  if (typeof options.base !== 'string' || !COMMIT_ID.test(options.base)) throw new Error('base must be a full commit ID.');
  const baseline = resolveMetadataBaseline(storage, options.metadataBaseline);
  if (!Array.isArray(options.operations)) throw new Error('Declared operations must be a list.');
  const operations = options.operations.map(operation => {
    const { kind, path, renamedFrom } = operation ?? {} as DeclaredOperation;
    if (!KINDS.has(kind)) throw new Error(`Declared operation kind ${JSON.stringify(kind)} is not add, edit, delete or rename.`);
    assertDeclaredPath(path);
    if (kind === 'rename') assertDeclaredPath(renamedFrom);
    else if (renamedFrom !== undefined && renamedFrom !== null) throw new Error('Only a rename has renamedFrom.');
    return { kind, path, renamedFrom: kind === 'rename' ? renamedFrom! : undefined };
  });
  const paths = [...new Set(operations.flatMap(operation => [operation.path, ...operation.renamedFrom ? [operation.renamedFrom] : []]))];
  if (paths.length > MAXIMUM_DECLARED_LINKS) throw new Error(`At most ${MAXIMUM_DECLARED_LINKS} declared paths are checked.`);
  assertArguments(paths);
  let stdout: string;
  try {
    stdout = await runStorageScript(storage, { kind: 'inspect', operation: 'Pre-launch tree check',
      consequence: 'the task tree cannot be checked', entrypoint: 'perl', maxOutputBytes: MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK,
      memory: INSPECTION_MEMORY, tmpBytes: INSPECTION_TMP,
      args: ['-e', TREE_SCRIPT, 'prelaunch', baseline, options.base, ...paths] },
    { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  } catch (error) {
    // The script found the tree itself unfit: something it cannot read (6), a name the manifest cannot carry (8), or
    // too many changes or too much output (9). A fresh copy of the head has none of these, so each is a refusal like
    // any other difference, not a failure to run. Its message escapes every name it shows.
    if (error instanceof DockerError && [6, 8, 9].includes(error.status ?? -1)) {
      const reason = error.stderr.trim().split('\n').at(-1)!.slice(0, 512);
      throw new TaskTreeRefused([`the tree cannot be checked whole (${JSON.stringify(reason)})`]);
    }
    throw error;
  }
  const output = JSON.parse(stdout) as InspectOutput & { metadataOnly?: boolean; gitlinks?: unknown; declared?: unknown };
  const manifest = manifestOf(options.base, { baseline, links: [], recorded: {}, linkArgs: [] }, output);
  const differences = treeDifferences(manifest);
  if (manifest.metadataChanged) throw new TaskTreeRefused(differences);
  const gitlinks = output.gitlinks, declared = output.declared as DeclaredFact[] | undefined;
  if (!Array.isArray(gitlinks) || gitlinks.some(path => { try { assertDeclaredPath(path); return false; } catch { return true; } })
    || !Array.isArray(declared)
    || declared.length !== paths.length || declared.some((fact, index) => fact?.path !== paths[index]))
    throw new Error('The pre-launch tree check returned an unexpected result.');
  const facts = new Map(declared.map(fact => [fact.path, fact]));
  const q = JSON.stringify;
  for (const operation of operations) {
    const sources = operation.kind === 'add' ? [] : [operation.renamedFrom ?? operation.path];
    const destinations = operation.kind === 'add' || operation.kind === 'rename' ? [operation.path] : [];
    for (const path of [...sources, ...destinations]) {
      const fact = facts.get(path)!;
      if (fact.blockedBy !== undefined) differences.push(`${q(path)} lies beneath the ${fact.blockedByType} ${q(fact.blockedBy)}`);
    }
    for (const path of sources) {
      const type = facts.get(path)!.type;
      if (type === 'gitlink') differences.push(`${q(path)} is a gitlink, which a plan item cannot change`);
      else if (type !== 'file' && type !== 'symlink') differences.push(`${operation.kind} source ${q(path)} is ${type === 'absent' ? 'missing' : `a ${type}`}`);
    }
    for (const path of destinations) {
      const type = facts.get(path)!.type;
      if (type !== 'absent') differences.push(`${operation.kind} destination ${q(path)} is occupied by a ${type}`);
    }
  }
  if (gitlinks.length > MAXIMUM_GITLINK_MOUNTS)
    differences.push(`the head has ${gitlinks.length} gitlinks, more than the ${MAXIMUM_GITLINK_MOUNTS} that can be mounted`);
  for (const path of gitlinks as string[]) if (unmountable(path)) differences.push(`gitlink ${q(path)} has a name Docker cannot mount`);
  if (differences.length) throw new TaskTreeRefused([...new Set(differences)]);
  const check = Object.freeze({ base: options.base, gitlinks: Object.freeze([...gitlinks as string[]]) });
  treeChecks.set(check, { filesystems: storage, used: false });
  return check;
}

/**
 * For the profile builder: the gitlinks of a check `checkTaskTree` made over these filesystems at `base`, marking it
 * used. Refuses a copied, reused or mismatched check.
 */
export function useTaskTreeCheck(check: TaskTreeCheck | undefined, filesystems: TaskFilesystems, base: string): readonly string[] {
  const record = check ? treeChecks.get(check) : undefined;
  if (!record) throw new Error('An execute or fix profile requires a pre-launch tree check from checkTaskTree.');
  if (record.filesystems !== filesystems || check!.base !== base)
    throw new Error('The pre-launch tree check was made over other task storage or another head.');
  if (record.used) throw new Error('The pre-launch tree check was already used; check the tree again before each invocation.');
  record.used = true;
  return check!.gitlinks;
}

/** The most bundle bytes a runner commit returns; a larger one fails the commit. */
export const MAXIMUM_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
// The script's JSON and the bundle in base64 come back as one string, which V8 caps.
if (MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK + Math.ceil(MAXIMUM_BUNDLE_BYTES / 3) * 4 + 1 > constants.MAX_STRING_LENGTH)
  throw new Error('The commit output limit is larger than one string can hold.');

/**
 * Who a runner commit is by, from F: D takes nothing from the environment or the repository, so the commit ID follows
 * from these, the message, base and the changes alone. `date` is Git's raw form: seconds since the epoch, a space, and
 * the offset (`1700000000 +0000`).
 */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}
export interface CommitOptions extends InspectOptions {
  /** The `digest` of the manifest the audit approved. The commit refuses a work tree whose manifest differs. */
  readonly digest: string;
  /** The message. Trailing newlines are dropped; one ends it, and the trailers follow after a blank line. */
  readonly message: string;
  /** Trailer lines, in this order, as `Key: value` (for example `Plan-Item`, `Plan-Revision`). */
  readonly trailers?: Readonly<Record<string, string>>;
  readonly author: CommitIdentity;
  readonly committer: CommitIdentity;
  /** Default and maximum `MAXIMUM_BUNDLE_BYTES`. */
  readonly maxBundleBytes?: number;
}
export interface TaskCommit {
  /** The runner commit, or `base` when the manifest has no changes ("planned but unchanged"). */
  readonly head: string;
  readonly unchanged: boolean;
  /**
   * The commit as a `git bundle` whose one ref, `TASK_COMMIT_REF`, points at `head`, with `base` as its prerequisite.
   * Empty when unchanged. F fetches it into a runner-owned repository and checks that the ref is `head`.
   */
  readonly bundle: Buffer;
}
/** The commit refused the work tree: it changed after the audit, or holds something the runner never commits. */
export class TaskCommitRefused extends Error {}

// Git drops these from either end of a name or email (ident.c, crud), which would change the commit.
const CRUD = /^[\x00-\x20.,:;<>"\\']|[\x00-\x20.,:;<>"\\']$/;
function assertIdentity(identity: CommitIdentity | undefined, role: string): void {
  const { name, email, date } = identity ?? {} as Partial<CommitIdentity>;
  for (const [field, value] of [['name', name], ['email', email]] as const) {
    if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > 256 || CRUD.test(value)
      || /[<>\p{Cc}\p{Noncharacter_Code_Point}]/u.test(value) || (field === 'email' && /\s/.test(value)))
      throw new Error(`The ${role}'s ${field} must be 1 to 256 bytes of text without <, >, control characters,`
        + ' noncharacters, or punctuation or space at either end.');
  }
  // Git writes a zero offset as +0000, so -0000 would make another commit than the one checked here.
  if (typeof date !== 'string' || !/^(?:0|[1-9][0-9]{0,11}) [+-](?:0[0-9]|1[0-4])[0-5][0-9]$/.test(date) || date.endsWith(' -0000'))
    throw new Error(`The ${role}'s date must be Git's raw form: seconds since the epoch and an offset, such as "1700000000 +0000".`);
}
// Git re-encodes a message it does not take for UTF-8 (commit.c, verify_utf8), and it counts noncharacters as not UTF-8.
function commitMessage(message: string, trailers: Readonly<Record<string, string>> = {}): string {
  if (typeof message !== 'string' || !message.isWellFormed() || message.includes('\0')
    || /\p{Noncharacter_Code_Point}/u.test(message))
    throw new Error('The commit message must be text without NUL or Unicode noncharacters.');
  const body = message.replace(/\n+$/, '');
  if (!body.trim()) throw new Error('The commit message must not be empty.');
  const lines = Object.entries(trailers ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key) || typeof value !== 'string' || !value.trim() || value !== value.trim()
      || !value.isWellFormed() || /[\p{Cc}\p{Noncharacter_Code_Point}]/u.test(value))
      throw new Error(`Trailer ${JSON.stringify(key)} must be a token with a one-line value.`);
    return `${key}: ${value}`;
  });
  const text = `${body}\n${lines.length ? `\n${lines.join('\n')}\n` : ''}`;
  if (Buffer.byteLength(text) > MAXIMUM_MESSAGE_BYTES) throw new Error(`The commit message must be at most ${MAXIMUM_MESSAGE_BYTES} bytes.`);
  return text;
}
// The ID Git gives the commit these inputs describe: nothing else (a signature, an encoding header) may be in it.
function commitId(base: string, tree: string, author: CommitIdentity, committer: CommitIdentity, message: string): string {
  const body = Buffer.from(`tree ${tree}\nparent ${base}\nauthor ${author.name} <${author.email}> ${author.date}\n`
    + `committer ${committer.name} <${committer.email}> ${committer.date}\n\n${message}`);
  return createHash(base.length === 64 ? 'sha256' : 'sha1').update(`commit ${body.length}\0`).update(body).digest('hex');
}
// Git refuses a symlink named .gitmodules, in any case, anywhere in a tree.
const gitmodulesLink = (change: TaskChange) => change.newType === 'symlink'
  && change.path.split('/').at(-1)!.toLowerCase() === '.gitmodules';
// What the runner never commits, whatever the audit said: each is needs human (the same list the script will not build).
function unstorable(manifest: TaskChangeManifest): string | undefined {
  if (manifest.metadataChanged) return 'the Git metadata changed since the storage was seeded';
  if (manifest.agentCommits.length) return 'the agent made commits';
  // A retargeted declared link is the item's own edit of it, which the audit judges; every other kind is a write
  // through the link.
  if (manifest.linkTargetChanges.some(change => change.change !== 'retargeted')) return 'a declared link\'s target changed';
  if (manifest.nestedGitlinkContent.length) return 'a gitlink directory has content';
  const change = manifest.changes.find(entry => entry.underGit || gitmodulesLink(entry)
    || [entry.oldType, entry.newType].some(type => type === 'directory' || type === 'other'));
  if (change) return `${JSON.stringify(change.path)} is ${change.underGit ? 'under a .git part' : gitmodulesLink(change)
    ? 'a symlink named .gitmodules' : 'a directory or special file'}, which a commit cannot hold`;
  return undefined;
}

/**
 * Make the runner's commit (#66): `base` plus exactly the changes of the manifest the audit approved, each file stored
 * as the inspection hashed it, with the message, trailers and identities F passes. It runs the inspection again in its
 * own container (read-only over the storage, no network), and from the same reads writes the commit's objects to a
 * scratch store in the container's /tmp and returns them as a bounded bundle: neither volume is ever written. The
 * bundle is kept only if the manifest's digest is `digest`; otherwise it refuses (`TaskCommitRefused`), as it does
 * for a manifest with agent commits, a metadata change, a declared link target change other than `retargeted` (the
 * item's own edit of the link, which the audit judges), gitlink content, or a change a tree cannot hold (a directory,
 * a fifo or other special file, a path under `.git`, a symlink named `.gitmodules`). An empty change set makes no commit
 * and returns `base`. Hooks, signing and the repository's commit encoding never apply, so the same inputs give the
 * same ID, which is checked here against the ID they describe. It fails on whatever fails an inspection, on a bundle
 * over `maxBundleBytes`, on new content that does not fit the container's /tmp (512 MB, within its 1 GB of memory),
 * and on any Git failure.
 * Takes `signal`, `onProcessGroup` and `timeoutMs` (default 300 s), and settles only after its container is gone.
 */
export async function commitTaskChanges(storage: TaskFilesystems | RecoveredTaskStorage,
  options: CommitOptions): Promise<TaskCommit> {
  const input = inspectionInput(storage, options);
  if (typeof options.digest !== 'string' || !DIGEST.test(options.digest)) throw new Error('digest must be the manifest\'s SHA-256.');
  const message = commitMessage(options.message, options.trailers);
  assertIdentity(options.author, 'author');
  assertIdentity(options.committer, 'committer');
  const maxBundleBytes = options.maxBundleBytes ?? MAXIMUM_BUNDLE_BYTES;
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes < 1 || maxBundleBytes > MAXIMUM_BUNDLE_BYTES)
    throw new Error(`maxBundleBytes must be a positive integer of at most ${MAXIMUM_BUNDLE_BYTES}.`);
  const author = { name: options.author.name, email: options.author.email, date: options.author.date };
  const committer = { name: options.committer.name, email: options.committer.email, date: options.committer.date };
  const stdout = await runStorageScript(storage, { kind: 'commit', operation: 'Runner commit',
    consequence: 'nothing can be committed', entrypoint: 'perl',
    maxOutputBytes: MAXIMUM_TREE_OUTPUT + OUTPUT_SLACK + Math.ceil(maxBundleBytes / 3) * 4 + 1,
    memory: INSPECTION_MEMORY, tmpBytes: INSPECTION_TMP,
    input: Buffer.from(JSON.stringify({ message, author, committer })),
    args: ['-e', TREE_SCRIPT, 'commit', input.baseline, options.base, String(maxBundleBytes), ...input.linkArgs] },
  { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
  // The inspection's JSON (a metadata-only one has no newline after it), then the commit's, then the bundle.
  const first = stdout.indexOf('\n'), second = first < 0 ? -1 : stdout.indexOf('\n', first + 1);
  const manifest = manifestOf(options.base, input, JSON.parse(first < 0 ? stdout : stdout.slice(0, first)));
  const built = second < 0 ? undefined : JSON.parse(stdout.slice(first + 1, second)) as { readonly tree?: unknown; readonly head?: unknown };
  const encoded = second < 0 ? '' : stdout.slice(second + 1);
  if (manifest.digest !== options.digest)
    throw new TaskCommitRefused('The work tree no longer matches the manifest the audit approved; nothing was committed.');
  const reason = unstorable(manifest);
  if (reason) throw new TaskCommitRefused(`Nothing was committed: ${reason}.`);
  if (!manifest.changes.length) {
    if (built !== undefined || (first >= 0 && first !== stdout.length - 1)) throw new Error('The runner commit returned a commit for no changes.');
    return Object.freeze({ head: options.base, unchanged: true, bundle: Buffer.alloc(0) });
  }
  const id = new RegExp(`^[0-9a-f]{${options.base.length}}$`), { tree, head } = built ?? {};
  // The script builds nothing for what it cannot store; its list mirrors `unstorable`, and a case only it knows is a
  // refusal too.
  if (built === undefined) throw new TaskCommitRefused('Nothing was committed: the storage container made no commit for the changes.');
  if (typeof tree !== 'string' || !id.test(tree) || typeof head !== 'string' || !id.test(head))
    throw new Error('The runner commit returned a malformed commit.');
  if (head !== commitId(options.base, tree, author, committer, message))
    throw new Error('The runner commit is not the commit its inputs describe; nothing was committed.');
  // Decoding skips what is not base64, so the bundle must encode back to exactly the text that came.
  const bundle = Buffer.from(encoded, 'base64');
  if (!bundle.length || bundle.length > maxBundleBytes || bundle.toString('base64') !== encoded)
    throw new Error('The runner commit returned a malformed bundle.');
  return Object.freeze({ head, unchanged: false, bundle });
}

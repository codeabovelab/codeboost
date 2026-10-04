import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/**
 * Agent storage that a build before #65 recorded by name. Those builds labelled Ask's Docker objects with no owner, or
 * with a random owner per session, so recovery cannot find them: they are kept only to tell the user what to remove.
 */
interface LegacyLeftover {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
}
interface LedgerRecord { roots: string[]; leftovers: LegacyLeftover[]; untracked: number }

const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** A temporary directory created by mkdtemp(join(tmpdir(), prefix)): a direct child of `parent` with that name. */
const isTemporary = (path: unknown, prefix: string, parent: string): path is string =>
  typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && dirname(path) === parent
  && new RegExp(`^${prefix}[A-Za-z0-9]{6}$`).test(basename(path));
/**
 * The names and wording of one feature that runs agents in its own worker (Ask, planning): its worker root, lock and
 * record, and how its refusals name it. Ask's values reproduce Ask's names and messages exactly.
 */
export interface WorkerNaming {
  /** The feature as a person reads it: "Ask is off: ...". */
  readonly label: string;
  /** Prefix of the worker root, the worker's TMPDIR: `codeboost-<root>-XXXXXX`. */
  readonly root: string;
  /** Prefix of the folder a root is prepared under before it is renamed into place. */
  readonly prep: string;
  /** Prefix of the lock file, and of the private directory that holds the locks. */
  readonly lock: string;
  /** Suffix of the record beside the review database. */
  readonly record: string;
  /** What the host copies are, in refusals: "reviewed code" for Ask. */
  readonly code: string;
  /** The worker's folders, in refusals: "Ask folders". */
  readonly folders: string;
  /** The worker, in errors: "the Ask worker". */
  readonly worker: string;
  /** One worker root, in refusals: "an Ask root". */
  readonly rootName: string;
  /** What another process may be running, in refusals: "running Ask for this review". */
  readonly activity: string;
}
export const ASK_NAMING: WorkerNaming = Object.freeze({ label: 'Ask', root: 'ask', prep: 'askprep', lock: 'asklock',
  record: 'ask-leftovers.json', code: 'reviewed code', folders: 'Ask folders', worker: 'the Ask worker', rootName: 'an Ask root', activity: 'Ask' });
export const PLANNING_NAMING: WorkerNaming = Object.freeze({ label: 'Planning', root: 'plan', prep: 'planprep', lock: 'planlock',
  record: 'planning-leftovers.json', code: 'planned code', folders: 'planning folders', worker: 'the planning worker', rootName: 'a planning root', activity: 'planning' });

/**
 * A worker root: one directory per agent worker, set as the worker's TMPDIR, so every host copy it or lane D makes
 * (the clone, input, the Codex auth copy) lives inside it. Only this exact shape is accepted from the record.
 */
export const isWorkerRoot = (path: unknown, naming: WorkerNaming): path is string => isTemporary(path, `codeboost-${naming.root}-`, tmpdir());
/** The Ask root (see isWorkerRoot). */
export const isAskRoot = (path: unknown): path is string => isWorkerRoot(path, ASK_NAMING);
/** A question's staging directory, inside the worker's TMPDIR (the Ask root). */
export const isStagingPath = (path: unknown): path is string => isTemporary(path, 'codeboost-question-', tmpdir());

/** Delete a tree that may contain read-only directories (staged input). Links are removed, never followed. */
function removeTree(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (lstatSync(child).isDirectory()) removeTree(child);
    }
  }
  rmSync(path, { recursive: true, force: true });
}
/** Remove a question's staging directory (reviewed clone and read-only input). Throws if it cannot be removed. */
export function removeStaging(root: string): void {
  if (!isStagingPath(root)) throw new Error('Refusing to remove a path that is not an Ask staging directory.');
  removeTree(root);
}
/** Remove a worker root and everything in it. Throws if it cannot be removed. */
export function removeWorkerRoot(root: string, naming: WorkerNaming): void {
  if (!isWorkerRoot(root, naming)) throw new Error(`Refusing to remove a path that is not ${naming.rootName}.`);
  removeTree(root);
}
/** Remove an Ask root and everything in it. Throws if it cannot be removed. */
export const removeAskRoot = (root: string): void => removeWorkerRoot(root, ASK_NAMING);
const MAX_LEFTOVERS = 100;

const OWNER_FILE = '.owner';
// Well above any valid record (100 allocations, 100 roots) or stamp.
const MAX_READ_BYTES = 1024 * 1024;
/**
 * Read a file without following a link: opened with O_NOFOLLOW and accepted only as a regular, single-link file within
 * the size limit. Returns undefined when the file does not exist; throws for a link or any other shape.
 */
function readNoFollow(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_READ_BYTES) throw new Error(`${path} is not a plain file.`);
    // Platforms without O_NOFOLLOW: refuse if the name is a link now.
    if (!constants.O_NOFOLLOW && lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a link.`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!read) break; offset += read; }
    return buffer.subarray(0, offset).toString('utf8');
  } finally { closeSync(fd); }
}
/** A codeboost worker lock: a direct child of the lock directory with the lock name, so a stamp cannot aim elsewhere. */
export const isWorkerLock = (path: unknown, naming: WorkerNaming): path is string => typeof path === 'string' && path.length <= 4096
  && isAbsolute(path) && dirname(path) === lockDirectoryPath(naming)
  && new RegExp(`^codeboost-${naming.lock}-[0-9a-f]+(?:-[0-9]+)?\\.sqlite$`).test(basename(path));
/** A codeboost Ask lock (see isWorkerLock). */
export const isAskLock = (path: unknown): path is string => isWorkerLock(path, ASK_NAMING);
/**
 * Lock files live in a directory only this user can write, so no other local user can plant or swap one (for example
 * a symlink to an unrelated database) between the name check and SQLite opening it. Refused if it is not ours.
 */
const lockDirectoryPath = (naming: WorkerNaming) => join(tmpdir(), `codeboost-${naming.lock}s-${process.getuid?.() ?? 'user'}`);
function lockDirectory(naming: WorkerNaming): string {
  const directory = lockDirectoryPath(naming);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
    throw new Error(`${naming.label} is off: the lock directory ${directory} is not a private directory owned by you. Remove it, then retry.`);
  return directory;
}
/** Open a lock file only if it is a regular file or absent; a symlink or other file type is refused, never followed. */
function assertPlainLockFile(path: string, naming: WorkerNaming): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${naming.label} is off: ${path} is not a plain lock file. Remove it, then retry.`);
}
/**
 * Create a worker root stamped with the lock of the process that owns it. The stamp is written under a preparation
 * name and the folder is then renamed, so any folder visible under the root name already carries its owner stamp.
 */
export function createWorkerRoot(lockPath: string, naming: WorkerNaming): string {
  const prepPrefix = `codeboost-${naming.prep}-`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const prep = mkdtempSync(join(tmpdir(), prepPrefix));
    writeFileSync(join(prep, OWNER_FILE), `${lockPath}\n`, { mode: 0o600, flag: 'wx' });
    const root = join(tmpdir(), `codeboost-${naming.root}-${basename(prep).slice(prepPrefix.length)}`);
    if (!existsSync(root)) try { renameSync(prep, root); return root; } catch { /* taken meanwhile; try another name */ }
    rmSync(prep, { recursive: true, force: true });
  }
  throw new Error(`Could not create a folder for ${naming.worker}.`);
}
/** Create an Ask root (see createWorkerRoot). */
export const createAskRoot = (lockPath: string): string => createWorkerRoot(lockPath, ASK_NAMING);
/** Whether another process holds a worker lock file, tested without creating or keeping it. */
function lockIsHeld(path: string, naming: WorkerNaming): boolean {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let probe: import('node:sqlite').DatabaseSync | undefined;
  try {
    assertPlainLockFile(path, naming);
    probe = new DatabaseSync(path, { timeout: 0 });
    probe.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    return false;
  } catch { return true; }
  finally { probe?.close(); }
}

function parse(text: string, naming: WorkerNaming): LedgerRecord {
  const value = JSON.parse(text) as { leftovers?: unknown; untracked?: unknown; roots?: unknown };
  // `leftovers` and `untracked` appear only in records from builds before #65.
  const list = value?.leftovers ?? [], untracked = value?.untracked ?? 0, roots = value?.roots;
  if (!Array.isArray(list) || list.length > MAX_LEFTOVERS || !Number.isSafeInteger(untracked) || (untracked as number) < 0
    || !Array.isArray(roots) || roots.length > MAX_LEFTOVERS || !roots.every(root => isWorkerRoot(root, naming)))
    throw new Error('invalid record');
  return { untracked: untracked as number, roots: roots as string[], leftovers: list.map(entry => {
    const { keeper, workVolume, metadataVolume } = (entry ?? {}) as Record<string, unknown>;
    if (![keeper, workVolume, metadataVolume].every(name => typeof name === 'string' && DOCKER_NAME.test(name)))
      throw new Error('invalid entry');
    return { keeper, workVolume, metadataVolume } as LegacyLeftover;
  }) };
}

/**
 * Durable record of a feature's host copies (worker roots) that outlived their worker, and the review's lock for that
 * feature. Docker leftovers need no record: the feature labels them with the review's own owner token for it, and the
 * first request of each process removes them through lane D's scoped recovery (#51 item 4, #65). Ask and planning each
 * have their own ledger, lock and owner, so neither one's recovery or refusals affect the other (#117).
 */
export class LeftoverLedger {
  readonly path: string;
  readonly naming: WorkerNaming;
  #lock?: import('node:sqlite').DatabaseSync;
  #refusal?: string;
  /** Where the exclusive lock lives; for a review database it is keyed by the file's identity (see forDatabase). */
  lockPath: string;
  /** The review database's device and inode, which key the feature's owner token (see forDatabase). */
  identity?: { readonly dev: bigint; readonly ino: bigint };
  constructor(path: string, naming: WorkerNaming = ASK_NAMING) {
    this.path = path; this.naming = naming;
    this.lockPath = join(lockDirectoryPath(naming), `codeboost-${naming.lock}-${createHash('sha256').update(path).digest('hex').slice(0, 32)}.sqlite`);
  }

  /**
   * Exclusive lock on this feature for this review database, held for the worker's lifetime. Only the holder checks,
   * recovers, starts a worker or writes this record, so two processes on one review cannot both pass the startup check or
   * overwrite each other's record. It is an exclusive SQLite transaction on `<record>.lock`: an OS file lock that the
   * operating system releases when its process ends, so no PID check or takeover is needed.
   */
  acquire(): void {
    if (this.#lock) return;
    if (this.#refusal) throw new Error(this.#refusal);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    lockDirectory(this.naming);
    assertPlainLockFile(this.lockPath, this.naming);
    const lock = new DatabaseSync(this.lockPath, { timeout: 0 });
    try { lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;'); }
    catch (error) {
      lock.close();
      if (/locked|busy/i.test(String((error as Error).message)))
        throw new Error(`${this.naming.label} is off: another codeboost process is running ${this.naming.activity} for this review. Stop it, then retry.`);
      throw error;
    }
    this.#lock = lock;
  }
  release(): void {
    const lock = this.#lock;
    if (!lock) return;
    this.#lock = undefined;
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  }

  /**
   * Delete unrecorded worker roots whose owner is gone. A root outlives its record when the database is renamed or the
   * record is lost; its `.owner` stamp names the lock of the process that made it. A held lock means a live process
   * owns the root and it is left alone. A free lock, a missing lock file or a missing stamp means the owner is gone.
   */
  #reclaimOrphanRoots(skip: ReadonlySet<string>): string[] {
    const stuck: string[] = [];
    for (const name of readdirSync(tmpdir())) {
      const root = join(tmpdir(), name);
      if (!isWorkerRoot(root, this.naming) || skip.has(root)) continue;
      // Only a folder this user owns, carrying a valid stamp from createWorkerRoot, is ours to judge. It stamps
      // every root before it becomes visible, so an unstamped, tampered or foreign folder is left in place.
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      let owner = '';
      try { owner = readNoFollow(join(root, OWNER_FILE))?.trim() ?? ''; } catch { continue; }
      if (!isWorkerLock(owner, this.naming)) continue;
      if (owner !== this.lockPath && existsSync(owner) && lockIsHeld(owner, this.naming)) continue;
      // Our own lock is held by us, so our earlier-session roots (not the live one, which is skipped) are reclaimed.
      try { removeWorkerRoot(root, this.naming); } catch { stuck.push(root); }
    }
    return stuck;
  }

  /**
   * The ledger for a review database, keyed by its canonical path so relative, absolute and symlinked spellings share
   * one lock and record. A hard-linked database has no single canonical path, so the feature refuses to run on it.
   */
  static forDatabase(database: string, naming: WorkerNaming = ASK_NAMING): LeftoverLedger {
    const canonical = realpathSync(database);
    const ledger = new LeftoverLedger(`${canonical}.${naming.record}`, naming);
    // One stat for the lock path, the hard-link check and the owner identity, so all three name the same file.
    const identity = statSync(canonical, { bigint: true });
    ledger.identity = { dev: identity.dev, ino: identity.ino };
    // The lock only excludes, so it may live in the temp directory; keyed by device and inode, every spelling and
    // every later name of this database file (including an atomic rename while a server runs) finds the same lock.
    ledger.lockPath = join(lockDirectoryPath(naming), `codeboost-${naming.lock}-${identity.dev}-${identity.ino}.sqlite`);
    if (identity.nlink > 1)
      ledger.#refusal = `${naming.label} is off: the review database ${canonical} has other hard links, so codeboost cannot tell whether another process is using it. Use a database file without hard links.`;
    return ledger;
  }

  #read(): LedgerRecord {
    let text: string | undefined;
    try {
      // A planted link here could make this review act on another review's record: never follow one.
      text = readNoFollow(this.path);
      if (text === undefined) return { roots: [], leftovers: [], untracked: 0 };
      return parse(text, this.naming);
    }
    catch { throw new Error(`${this.naming.label} is off: the record of leftover ${this.naming.folders} (${this.path}) is unreadable. Delete the codeboost-${this.naming.root}-* folders in ${tmpdir()} that no running codeboost uses, then delete that file.`); }
  }

  #write(record: LedgerRecord): void {
    if (!record.leftovers.length && !record.untracked && !record.roots.length) { rmSync(this.path, { force: true }); return; }
    // A fresh random name, created exclusively: an existing file or planted link at the name is never followed.
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      // Legacy fields are kept until the user deletes the record, and never written when empty.
      const { roots, leftovers, untracked } = record;
      const stored = { roots, ...(leftovers.length ? { leftovers } : {}), ...(untracked ? { untracked } : {}) };
      writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  /** Add a worker root that may hold host copies, before anything is written into it. */
  recordRoot(root: string): void {
    if (!isWorkerRoot(root, this.naming)) throw new Error(`Refusing to record a path that is not ${this.naming.rootName}.`);
    const known = this.#read();
    if (known.roots.includes(root)) return;
    // Roots hold host copies that only their path can find, so none is ever dropped: refuse to add one past the cap.
    if (known.roots.length >= MAX_LEFTOVERS)
      throw new Error(`${this.naming.label} is off: ${known.roots.length} ${this.naming.folders} from earlier sessions could not be deleted. Delete the codeboost-${this.naming.root}-* folders in ${tmpdir()}, then retry.`);
    this.#write({ ...known, roots: [...known.roots, root] });
  }

  /** Drop a worker root from the record after it has been deleted. */
  forget(root: string): void {
    const known = this.#read();
    if (known.roots.includes(root)) this.#write({ ...known, roots: known.roots.filter(entry => entry !== root) });
  }

  /**
   * The host part of the first check of a process: delete worker roots of earlier sessions, recorded or found by their
   * owner stamp, but never `active`. Throws, with the commands to finish by hand, while any remain. Then refuses while
   * the record still lists Docker storage from a build before #65, which recovery cannot find.
   */
  assertClear(options: { active?: string } = {}): void {
    const known = this.#read();
    // Roots this record does not list (a renamed database, a lost record) are found by their owner stamp.
    const orphans = this.#reclaimOrphanRoots(new Set([...known.roots, ...(options.active ? [options.active] : [])]));
    if (orphans.length) throw new Error(`${this.naming.label} is off: host copies of ${this.naming.code} or credentials from an earlier session could not be deleted. Delete them, then retry:\n${orphans.map(root => `rm -rf '${root}'`).join('\n')}`);
    // Host copies (reviewed code, Codex auth) need no Docker: delete earlier roots first, never the live one.
    const roots = known.roots.filter(root => {
      if (root === options.active) return true;
      try { removeWorkerRoot(root, this.naming); return false; } catch { return true; }
    });
    if (roots.length !== known.roots.length) this.#write({ ...known, roots });
    const stuck = roots.filter(root => root !== options.active);
    if (stuck.length) throw new Error(`${this.naming.label} is off: host copies of ${this.naming.code} or credentials from an earlier session could not be deleted. Delete them, then retry:\n${stuck.map(root => `rm -rf '${root}'`).join('\n')}`);
    // Last, so host copies are deleted (and dropped from the record) before the user is told to delete the record.
    if (known.leftovers.length || known.untracked) {
      const commands = known.leftovers.flatMap(entry => [`docker rm -f ${entry.keeper}`, `docker volume rm ${entry.workVolume} ${entry.metadataVolume}`]);
      throw new Error(`${this.naming.label} is off: an earlier codeboost build recorded agent storage it could not remove, and codeboost cannot find it by owner. Remove ${commands.length ? 'what is left of it (a command for an object that is already gone fails harmlessly)' : 'it'}, and any other container, volume or network labelled io.codeboost.allocation, io.codeboost.invocation or io.codeboost.egress that no running codeboost uses. Then delete ${this.path} and retry.${commands.length ? `\n${commands.join('\n')}` : ''}`);
    }
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Docker resources of one Ask storage allocation that codeboost could not remove. */
export interface Leftover {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
}
/**
 * Names of Docker resources that lane D labels as its own: task storage and the seeder (`io.codeboost.allocation`),
 * agent containers (`io.codeboost.invocation`), and egress proxies and networks (`io.codeboost.egress`).
 */
export interface TaskStorage {
  readonly containers: ReadonlySet<string>;
  readonly volumes: ReadonlySet<string>;
  readonly networks?: ReadonlySet<string>;
}
export type ListTaskStorage = (signal: AbortSignal) => Promise<TaskStorage>;
interface LedgerRecord { leftovers: Leftover[]; untracked: number; roots: string[] }

// One whole check, not per resource: it runs before each question and must not hold it or shutdown for long.
const CHECK_TIMEOUT_MS = 15_000;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** A temporary directory created by mkdtemp(join(tmpdir(), prefix)): a direct child of `parent` with that name. */
const isTemporary = (path: unknown, prefix: string, parent: string): path is string =>
  typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && dirname(path) === parent
  && new RegExp(`^${prefix}[A-Za-z0-9]{6}$`).test(basename(path));
/**
 * The Ask root: one directory per question worker, set as the worker's TMPDIR, so every host copy it or lane D makes
 * (reviewed clone, input, the Codex auth copy) lives inside it. Only this exact shape is accepted from the record.
 */
export const isAskRoot = (path: unknown): path is string => isTemporary(path, 'codeboost-ask-', tmpdir());
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
/** Remove an Ask root and everything in it. Throws if it cannot be removed. */
export function removeAskRoot(root: string): void {
  if (!isAskRoot(root)) throw new Error('Refusing to remove a path that is not an Ask root.');
  removeTree(root);
}
const MAX_LEFTOVERS = 100;

/** Read-only label queries (Docker ANDs label filters, so one query per label). Any failure keeps Ask off. */
// The same minimal environment lane D gives Docker: no credentials reach these queries.
export const dockerQueryEnvironment = () => ({ PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST });
export const dockerTaskStorage: ListTaskStorage = async signal => {
  const list = (args: string[]) => new Promise<string[]>((resolve, reject) => execFile('docker', args,
    { timeout: CHECK_TIMEOUT_MS, signal, env: dockerQueryEnvironment() }, (error, stdout) => error ? reject(error)
      : resolve(String(stdout).split('\n').map(line => line.trim()).filter(Boolean))));
  const labels = ['io.codeboost.allocation', 'io.codeboost.invocation', 'io.codeboost.egress'];
  const [containers, volumes, networks] = await Promise.all([
    Promise.all(labels.map(label => list(['ps', '-a', '--format', '{{.Names}}', '--filter', `label=${label}`]))),
    list(['volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation']),
    list(['network', 'ls', '--format', '{{.Name}}', '--filter', 'label=io.codeboost.egress'])]);
  return { containers: new Set(containers.flat()), volumes: new Set(volumes), networks: new Set(networks) };
};
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
/** A codeboost Ask lock: a direct child of the temp directory with the lock name, so a stamp cannot aim elsewhere. */
export const isAskLock = (path: unknown): path is string => typeof path === 'string' && path.length <= 4096
  && isAbsolute(path) && dirname(path) === lockDirectoryPath() && /^codeboost-asklock-[0-9a-f]+(?:-[0-9]+)?\.sqlite$/.test(basename(path));
/**
 * Lock files live in a directory only this user can write, so no other local user can plant or swap one (for example
 * a symlink to an unrelated database) between the name check and SQLite opening it. Refused if it is not ours.
 */
const lockDirectoryPath = () => join(tmpdir(), `codeboost-asklocks-${process.getuid?.() ?? 'user'}`);
function lockDirectory(): string {
  const directory = lockDirectoryPath();
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
    throw new Error(`Ask is off: the lock directory ${directory} is not a private directory owned by you. Remove it, then retry.`);
  return directory;
}
/** Open a lock file only if it is a regular file or absent; a symlink or other file type is refused, never followed. */
function assertPlainLockFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Ask is off: ${path} is not a plain lock file. Remove it, then retry.`);
}
/**
 * Create an Ask root stamped with the lock of the process that owns it. The stamp is written under a preparation name
 * and the folder is then renamed, so any folder visible under the Ask root name already carries its owner stamp.
 */
export function createAskRoot(lockPath: string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prep = mkdtempSync(join(tmpdir(), 'codeboost-askprep-'));
    writeFileSync(join(prep, OWNER_FILE), `${lockPath}\n`, { mode: 0o600, flag: 'wx' });
    const root = join(tmpdir(), `codeboost-ask-${basename(prep).slice('codeboost-askprep-'.length)}`);
    if (!existsSync(root)) try { renameSync(prep, root); return root; } catch { /* taken meanwhile; try another name */ }
    rmSync(prep, { recursive: true, force: true });
  }
  throw new Error('Could not create a folder for the Ask worker.');
}
/** Whether another process holds an Ask lock file, tested without creating or keeping it. */
function lockIsHeld(path: string): boolean {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let probe: import('node:sqlite').DatabaseSync | undefined;
  try {
    assertPlainLockFile(path);
    probe = new DatabaseSync(path, { timeout: 0 });
    probe.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    return false;
  } catch { return true; }
  finally { probe?.close(); }
}
const LABELLED = 'docker ps -a, docker volume ls and docker network ls, each with --filter label=io.codeboost.allocation, label=io.codeboost.invocation or label=io.codeboost.egress';

function parse(text: string): LedgerRecord {
  const value = JSON.parse(text) as { leftovers?: unknown; untracked?: unknown };
  const list = value?.leftovers, untracked = value?.untracked, roots = (value as { roots?: unknown })?.roots;
  if (!Array.isArray(list) || list.length > MAX_LEFTOVERS || !Number.isSafeInteger(untracked) || (untracked as number) < 0
    || !Array.isArray(roots) || roots.length > MAX_LEFTOVERS || !roots.every(isAskRoot))
    throw new Error('invalid record');
  return { untracked: untracked as number, roots: roots as string[], leftovers: list.map(entry => {
    const { keeper, workVolume, metadataVolume } = (entry ?? {}) as Record<string, unknown>;
    if (![keeper, workVolume, metadataVolume].every(name => typeof name === 'string' && DOCKER_NAME.test(name)))
      throw new Error('invalid entry');
    return { keeper, workVolume, metadataVolume } as Leftover;
  }) };
}

/**
 * Durable record of Ask storage that outlived its worker. Lane D keeps allocation ownership in process memory,
 * so after a shutdown nothing can remove these through D until its scoped recovery exists (#51 item 4).
 * Until then, Ask stays off while any recorded resource still exists, and tells the user how to remove it.
 */
export class LeftoverLedger {
  readonly path: string;
  #lock?: import('node:sqlite').DatabaseSync;
  #refusal?: string;
  readonly listTaskStorage: ListTaskStorage;
  /** Where the exclusive lock lives; for a review database it is keyed by the file's identity (see forDatabase). */
  lockPath: string;
  constructor(path: string, listTaskStorage: ListTaskStorage = dockerTaskStorage) {
    this.path = path; this.listTaskStorage = listTaskStorage;
    this.lockPath = join(lockDirectoryPath(), `codeboost-asklock-${createHash('sha256').update(path).digest('hex').slice(0, 32)}.sqlite`);
  }

  /**
   * Exclusive Ask lock for this review database, held for the question worker's lifetime. Only the holder scans,
   * starts a worker or writes this record, so two processes on one review cannot both pass the startup scan or
   * overwrite each other's record. It is an exclusive SQLite transaction on `<record>.lock`: an OS file lock that the
   * operating system releases when its process ends, so no PID check or takeover is needed.
   */
  acquire(): void {
    if (this.#lock) return;
    if (this.#refusal) throw new Error(this.#refusal);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    lockDirectory();
    assertPlainLockFile(this.lockPath);
    const lock = new DatabaseSync(this.lockPath, { timeout: 0 });
    try { lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;'); }
    catch (error) {
      lock.close();
      if (/locked|busy/i.test(String((error as Error).message)))
        throw new Error('Ask is off: another codeboost process is running Ask for this review. Stop it, then retry.');
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
   * Delete unrecorded Ask roots whose owner is gone. A root outlives its record when the database is renamed or the
   * record is lost; its `.owner` stamp names the lock of the process that made it. A held lock means a live process
   * owns the root and it is left alone. A free lock, a missing lock file or a missing stamp means the owner is gone.
   */
  #reclaimOrphanRoots(skip: ReadonlySet<string>): string[] {
    const stuck: string[] = [];
    for (const name of readdirSync(tmpdir())) {
      const root = join(tmpdir(), name);
      if (!isAskRoot(root) || skip.has(root)) continue;
      // Only a folder this user owns, carrying a valid stamp from createAskRoot, is ours to judge. createAskRoot stamps
      // every root before it becomes visible, so an unstamped, tampered or foreign folder is left in place.
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      let owner = '';
      try { owner = readNoFollow(join(root, OWNER_FILE))?.trim() ?? ''; } catch { continue; }
      if (!isAskLock(owner)) continue;
      if (owner !== this.lockPath && existsSync(owner) && lockIsHeld(owner)) continue;
      // Our own lock is held by us, so our earlier-session roots (not the live one, which is skipped) are reclaimed.
      try { removeAskRoot(root); } catch { stuck.push(root); }
    }
    return stuck;
  }

  /**
   * The ledger for a review database, keyed by its canonical path so relative, absolute and symlinked spellings share
   * one lock and record. A hard-linked database has no single canonical path, so Ask refuses to run on it.
   */
  static forDatabase(database: string, listTaskStorage?: ListTaskStorage): LeftoverLedger {
    const canonical = realpathSync(database);
    const ledger = new LeftoverLedger(`${canonical}.ask-leftovers.json`, listTaskStorage);
    const identity = statSync(canonical);
    // The lock only excludes, so it may live in the temp directory; keyed by device and inode, every spelling and
    // every later name of this database file (including an atomic rename while a server runs) finds the same lock.
    ledger.lockPath = join(lockDirectoryPath(), `codeboost-asklock-${identity.dev}-${identity.ino}.sqlite`);
    if (identity.nlink > 1)
      ledger.#refusal = `Ask is off: the review database ${canonical} has other hard links, so codeboost cannot tell whether another process is using it. Use a database file without hard links.`;
    return ledger;
  }

  #read(): LedgerRecord {
    let text: string | undefined;
    try {
      // A planted link here could make this review act on another review's record: never follow one.
      text = readNoFollow(this.path);
      if (text === undefined) return { leftovers: [], untracked: 0, roots: [] };
      return parse(text);
    }
    catch { throw new Error(`Ask is off: the record of leftover agent storage (${this.path}) is unreadable. Check \`docker ps -a\` and \`docker volume ls\` for codeboost resources, remove them, then delete that file.`); }
  }

  #write(record: LedgerRecord): void {
    if (!record.leftovers.length && !record.untracked && !record.roots.length) { rmSync(this.path, { force: true }); return; }
    // A fresh random name, created exclusively: an existing file or planted link at the name is never followed.
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  /** Add allocations that could not be removed, unnamed failures, and Ask roots that may still hold host copies. */
  record(leftovers: readonly Leftover[], untracked = 0, roots: readonly string[] = []): void {
    if (!leftovers.length && !untracked && !roots.length) return;
    const known = this.#read();
    const keys = new Set(known.leftovers.map(entry => entry.keeper));
    const merged = [...known.leftovers, ...leftovers.filter(entry => !keys.has(entry.keeper))];
    // Never drop evidence: entries beyond the cap become unnamed, which keeps Ask off until no task storage remains.
    const mergedRoots = [...new Set([...known.roots, ...roots.filter(isAskRoot)])];
    // Roots hold host copies that only their path can find, so none is ever dropped: refuse to add one past the cap.
    if (mergedRoots.length > MAX_LEFTOVERS)
      throw new Error(`Ask is off: ${known.roots.length} Ask folders from earlier sessions could not be deleted. Delete the codeboost-ask-* folders in ${tmpdir()}, then retry.`);
    this.#write({ leftovers: merged.slice(0, MAX_LEFTOVERS), roots: mergedRoots,
      untracked: known.untracked + untracked + Math.max(0, merged.length - MAX_LEFTOVERS) });
  }

  /** Drop an Ask root from the record after it has been deleted. */
  forget(root: string): void {
    const known = this.#read();
    if (known.roots.includes(root)) this.#write({ ...known, roots: known.roots.filter(entry => entry !== root) });
  }

  /**
   * Drop entries whose resources are all gone. Throws, with removal commands, while any remain, and also when
   * Docker cannot be checked within the time limit or `signal` aborts.
   */
  async assertClear(signal?: AbortSignal, options: { startup?: boolean; active?: string } = {}): Promise<void> {
    const known = this.#read();
    // At startup a missing record proves nothing: the last process may have been killed before writing it.
    const stored = known.untracked;
    if (options.startup) {
      // Roots this record does not list (a renamed database, a lost record) are found by their owner stamp.
      const orphans = this.#reclaimOrphanRoots(new Set([...known.roots, ...(options.active ? [options.active] : [])]));
      if (orphans.length) throw new Error(`Ask is off: host copies of reviewed code or credentials from an earlier session could not be deleted. Delete them, then retry:\n${orphans.map(root => `rm -rf '${root}'`).join('\n')}`);
      if (!known.untracked) known.untracked = 1;
    }
    // Host copies (reviewed code, Codex auth) need no Docker: delete earlier roots first, never the live one.
    const roots = known.roots.filter(root => {
      if (root === options.active) return true;
      try { removeAskRoot(root); return false; } catch { return true; }
    });
    if (roots.length !== known.roots.length) this.#write({ ...known, roots, untracked: stored });
    const stuck = roots.filter(root => root !== options.active);
    if (stuck.length) throw new Error(`Ask is off: host copies of reviewed code or credentials from an earlier session could not be deleted. Delete them, then retry:\n${stuck.map(root => `rm -rf '${root}'`).join('\n')}`);
    known.roots = roots;
    if (!known.leftovers.length && !known.untracked) return;
    const limit = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    let storage: TaskStorage;
    try { storage = await this.listTaskStorage(signal ? AbortSignal.any([signal, limit]) : limit); }
    catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Ask is off: codeboost could not check Docker for agent storage left by an earlier session (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}). Start Docker, then retry.`);
    }
    const commands: string[] = [], remaining: Leftover[] = [];
    for (const entry of known.leftovers) {
      const keeper = storage.containers.has(entry.keeper);
      const volumes = [entry.workVolume, entry.metadataVolume].filter(name => storage.volumes.has(name));
      if (!keeper && !volumes.length) continue;
      remaining.push(entry);
      // Only what still exists, so a command never fails on an already removed keeper.
      if (keeper) commands.push(`docker rm -f ${entry.keeper}`);
      if (volumes.length) commands.push(`docker volume rm ${volumes.join(' ')}`);
    }
    // Any labelled resource that is not part of a still-listed allocation is unidentified (a seeder, agent container,
    // proxy or network). It keeps the marker even when the named entries are gone; the marker clears only when none
    // remain.
    const named = new Set(remaining.flatMap(entry => [entry.keeper, entry.workVolume, entry.metadataVolume]));
    const labelled = [...storage.containers, ...storage.volumes, ...(storage.networks ?? [])].filter(name => !named.has(name)).length;
    const untracked = labelled ? Math.max(known.untracked, 1) : 0;
    this.#write({ leftovers: remaining, untracked, roots: known.roots });
    // Named leftovers first: their exact removal commands are the most useful next step. The marker is saved either way.
    if (remaining.length) throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
    if (untracked) throw new Error(`Ask is off: an earlier codeboost session may have left agent containers, volumes or networks that cannot be identified (${labelled} labelled resource${labelled === 1 ? '' : 's'} found). List them with ${LABELLED}. Remove them if no other codeboost is running, then retry.`);
  }
}

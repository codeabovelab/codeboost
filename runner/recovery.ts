import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';
import { WRITABLE_KINDS, isUuidV4 } from './lifecycle.ts';

/**
 * Startup recovery and the single-runner lock. See docs/implementation/runner-lifecycle.md,
 * "Startup recovery" and decision 1. D's recovery, export and removal are injected until #51 provides them.
 */
export class LockHeld extends Error { constructor() { super('Another codeboost runner is using this database.'); } }
export class RecoveryBlocked extends Error {
  readonly items: string[];
  constructor(message: string, items: string[]) { super(`${message}: ${items.join(', ')}`); this.items = items; }
}

/** Linux statfs magic numbers for network filesystems, where POSIX locks are unreliable. */
const NETWORK_FILESYSTEMS = new Set([0x6969 /* NFS */, 0x517b /* SMB */, 0xff534d42 /* CIFS */, 0xfe534d42 /* SMB2 */, 0x65735546 /* FUSE */]);
function assertOwnerOnly(path: string, what: string): void {
  const st = statSync(path);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022) !== 0)
    throw new Error(`${what} ${path} must be a directory owned by you and not writable by group or others.`);
}
function assertLocal(path: string): void {
  if (process.platform !== 'linux') return; // macOS statfs types are not stable enough to classify; see the PR notes.
  if (NETWORK_FILESYSTEMS.has(Number(statfsSync(path).type))) throw new Error(`${path} is on a network filesystem; the runner lock needs a local filesystem.`);
}

export interface RunnerLock {
  readonly file: { dev: bigint; ino: bigint };
  /** Step 4: the database path still names the locked file. Call after the Store opens. */
  verify(): void;
  release(): void;
}
/** Steps 0–2: owner-only parent, identify (or create) the file with no-follow, then take the OS lock by device and inode. */
export function acquireRunnerLock(databasePath: string, options: { lockRoot?: string } = {}): RunnerLock {
  const absolute = resolve(databasePath), parent = realpathSync(dirname(absolute)), path = join(parent, absolute.slice(dirname(absolute).length + 1));
  assertOwnerOnly(parent, 'The database directory');
  assertLocal(parent);
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (link?.isSymbolicLink()) throw new Error('The database path must not be a symlink.');
  let fd: number;
  try { fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (race) { if ((race as NodeJS.ErrnoException).code !== 'EEXIST') throw race; fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
  }
  let db: DatabaseSync | undefined;
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw new Error('The database must be a regular file with exactly one name (no hard links).');
    const lockRoot = options.lockRoot ?? join(homedir(), '.codeboost', 'locks');
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
    assertOwnerOnly(lockRoot, 'The lock directory');
    assertLocal(lockRoot);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new DatabaseSync(join(lockRoot, `${st.dev}-${st.ino}.runner-lock`), { timeout: 0 });
    try {
      // EXCLUSIVE locking mode keeps the file lock after the first write until the connection closes; the OS drops it on exit or crash.
      db.exec('PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY); INSERT OR REPLACE INTO holder VALUES (1);');
    } catch (error) {
      if (/locked|busy/i.test((error as Error).message)) throw new LockHeld();
      throw error;
    }
    const file = { dev: st.dev, ino: st.ino }, heldDb = db;
    let released = false;
    return {
      file,
      verify() {
        const now = lstatSync(path, { bigint: true });
        if (now.isSymbolicLink() || !now.isFile() || now.dev !== file.dev || now.ino !== file.ino || now.nlink !== 1n)
          throw new Error('The database path changed while opening. Refusing to start.');
      },
      release() { if (released) return; released = true; heldDb.close(); closeSync(fd); },
    };
  } catch (error) { db?.close(); closeSync(fd); throw error; }
}

export interface ProcessControl {
  /** The group leader is alive and started at the recorded time (guards against PID reuse). */
  isAlive(pgid: number, startedAt: number): boolean;
  /** SIGTERM the group, SIGKILL after the grace period, and resolve only once it has exited. */
  terminate(pgid: number, graceMs: number): Promise<void>;
}
export const hostProcesses: ProcessControl = {
  isAlive(pgid, startedAt) {
    try { process.kill(-pgid, 0); } catch { return false; }
    try {
      const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pgid)], { encoding: 'utf8' }).trim());
      return Number.isFinite(started) && Math.abs(started - startedAt) < 2_000;
    } catch { return true; } // Alive but unreadable: treat as ours and stop it (fail closed).
  },
  async terminate(pgid, graceMs) {
    const alive = () => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
    try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
    const until = Date.now() + graceMs;
    while (alive() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    if (alive()) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
    while (alive()) await new Promise(resolve => setTimeout(resolve, 50));
  },
};

export interface RecoveredStorage { readonly attemptId: string; readonly allocationId: string; readonly handle: unknown }
export interface RecoveryDeps {
  /** D (#51): stop leftover agent containers, proxies and networks for this owner; keep task storage and return authenticated handles. */
  recoverLeftovers(runnerOwner: string): Promise<{ storage: RecoveredStorage[]; unowned: string[] }>;
  /** D (#51, before F2): bounded diff of a recovered task volume; must stop its own work when the signal aborts. */
  exportTaskDiff(handle: unknown, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  removeTaskFilesystems(handle: unknown): Promise<void>;
  /** F3: abort an interrupted rebase. Until F3 exists no rebase is ever recorded. */
  abortRebase?(planKey: string, marker: unknown): Promise<void>;
  processes?: ProcessControl;
}
export interface RecoveryOptions {
  store: Store; runnerOwner: string; runnerRoot: string; diagnosticsDir: string; deps: RecoveryDeps;
  now?: () => number; exportDeadlineMs?: number; graceMs?: number;
}
export interface RecoveryReport {
  finalized: { attemptId: string; planKey: string; state: string; requeued: boolean }[];
  requeue: string[]; removedDirectories: string[]; unknownEntries: string[]; unmatchedStorage: string[]; repairedMerges: string[];
}
const EXPORT_LIMIT = 1024 * 1024;

/**
 * Startup steps 2b–7 after the lock (step 1) and the Store open (2a). Throws on any step that must fail closed;
 * the caller then closes the Store, releases the lock and exits without opening the coordinator.
 */
export async function recoverStartup(o: RecoveryOptions): Promise<RecoveryReport> {
  const now = o.now ?? Date.now, processes = o.deps.processes ?? hostProcesses;
  if (!/^[0-9a-f]{32}$/.test(o.runnerOwner)) throw new Error('Invalid runner owner token.');
  const interrupted = o.store.interruptedAttempts();
  // Step 7's input is taken before finalization: an interrupted attempt that started preparation but never saved its group.
  const unowned = interrupted.filter(a => a.preparationStartedAt !== null && a.preparationPgid === null).map(a => a.id);
  // 2b. Stop leftover preparation before D's recovery or any storage work.
  for (const a of interrupted) if (a.preparationPgid !== null && a.preparationStartedAt !== null && processes.isAlive(a.preparationPgid, a.preparationStartedAt))
    await processes.terminate(a.preparationPgid, o.graceMs ?? 5_000);
  // 2c/2d. D's recovery; a rejection propagates and stops startup.
  const recovered = await o.deps.recoverLeftovers(o.runnerOwner);
  if (recovered.unowned.length) throw new RecoveryBlocked('Unlabelled codeboost resources from an older build must be removed by hand (see --list-unowned-agent-resources)', recovered.unowned);
  const matched = recovered.storage.filter(s => isUuidV4(s.attemptId) && o.store.attemptOwner(s.attemptId) !== null);
  const unmatchedStorage = recovered.storage.filter(s => !matched.includes(s)).map(s => s.attemptId);
  // 3. Export phase: stopped writable attempts only, outside any transaction, fixed names, bounded deadline.
  const exports: Record<string, { diagnosticRef?: string; failure?: string }> = {};
  mkdirSync(o.diagnosticsDir, { recursive: true, mode: 0o700 });
  for (const storage of matched) {
    const attempt = interrupted.find(a => a.id === storage.attemptId);
    if (!attempt || !WRITABLE_KINDS.includes(attempt.kind)) continue;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Export timed out.')), o.exportDeadlineMs ?? 60_000);
    try {
      const diff = await Promise.race([o.deps.exportTaskDiff(storage.handle, EXPORT_LIMIT, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))]);
      const file = join(o.diagnosticsDir, `${storage.attemptId}.diff`);
      writeFileSync(file, diff.subarray(0, EXPORT_LIMIT), { mode: 0o600 });
      exports[storage.attemptId] = { diagnosticRef: file };
    } catch (error) { exports[storage.attemptId] = { failure: error instanceof Error ? error.message : String(error) }; }
    finally { clearTimeout(timer); }
  }
  // 3. Finalization phase: one transaction; a failure stops startup.
  const finalized = o.store.recoverInterrupted(now(), exports);
  // 4. Rebases, storage removal (every matched handle), then attempt directories.
  for (const rebase of o.store.rebasesInProgress()) {
    if (!o.deps.abortRebase) throw new RecoveryBlocked('An interrupted rebase needs F3 to abort it', [rebase.planKey]);
    await o.deps.abortRebase(rebase.planKey, rebase.marker);
  }
  for (const storage of matched) await o.deps.removeTaskFilesystems(storage.handle);
  const removedDirectories: string[] = [], unknownEntries: string[] = [];
  const attemptsDir = join(o.runnerRoot, o.runnerOwner, 'attempts');
  const rootDev = lstatSync(o.runnerRoot, { throwIfNoEntry: false })?.dev;
  for (const name of lstatSync(attemptsDir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(attemptsDir) : []) {
    const entry = join(attemptsDir, name), st = lstatSync(entry);
    const owned = st.isDirectory() && !st.isSymbolicLink() && st.dev === rootDev && isUuidV4(name) && o.store.attemptOwner(name) !== null;
    if (!owned) { unknownEntries.push(entry); continue; }
    if (unowned.includes(name)) continue; // step 7 keeps it for --release-preparation
    rmSync(entry, { recursive: true, force: true }); removedDirectories.push(entry);
  }
  // 5. Confirmed merges get their closed status and task-closed event.
  const repairedMerges = o.store.reconcileMergedTasks();
  // 7. An unidentifiable preparation child may exist: fail closed until the user releases it.
  const blocked = [...unowned, ...o.store.unownedPreparations().filter(id => !unowned.includes(id))];
  if (blocked.length) throw new RecoveryBlocked('Preparation started but its process was never recorded; stop it, then run --release-preparation', blocked);
  return { finalized, requeue: finalized.filter(f => f.requeued).map(f => f.planKey), removedDirectories, unknownEntries, unmatchedStorage, repairedMerges };
}

/** --release-preparation: remove an attempt directory only when no process has a file open or a working directory in it. */
export function releasePreparation(o: { store: Store; runnerRoot: string; runnerOwner: string; attemptId: string; openFiles?: (dir: string) => string[] }): void {
  if (!isUuidV4(o.attemptId) || o.store.attemptOwner(o.attemptId) === null) throw new Error('Unknown attempt.');
  const dir = join(o.runnerRoot, o.runnerOwner, 'attempts', o.attemptId), st = lstatSync(dir, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error('The attempt path is not a plain directory.');
  if (st) {
    const users = (o.openFiles ?? hostOpenFiles)(dir);
    if (users.length) throw new RecoveryBlocked('A process is still using the attempt directory', users);
    rmSync(dir, { recursive: true, force: true });
  }
  if (!o.store.clearPreparationMarker(o.attemptId)) throw new Error('The attempt is not waiting for release.');
}
/** Processes with a file open or a working directory under dir. Throws if the check cannot run (fail closed). */
export function hostOpenFiles(dir: string): string[] {
  if (process.platform === 'linux') {
    const users: string[] = [];
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      const links: string[] = [];
      try { links.push(realpathSync(`/proc/${pid}/cwd`)); } catch {}
      try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { links.push(realpathSync(`/proc/${pid}/fd/${fd}`)); } catch {} } } catch {}
      if (links.some(link => link === dir || link.startsWith(`${dir}/`))) users.push(pid);
    }
    return users;
  }
  try { return execFileSync('lsof', ['-t', '+D', dir], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch (error) {
    const e = error as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return []; // lsof exits 1 when nothing matches
    throw new Error('Could not check which processes use the attempt directory. Refusing to release it.');
  }
}

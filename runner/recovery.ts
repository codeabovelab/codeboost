import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { RebaseMarker, Store } from './store.ts';
import { WRITABLE_KINDS, isUuidV4 } from './lifecycle.ts';
import { partialOutput, saveDiagnostic } from './diagnostics.ts';
import { ownerOnlyDirectory } from './runner-repository.ts';
import { runInProcessGroup } from '../agents/process-group.ts';
import type { DockerOutcome } from '../agents/docker.ts';

/**
 * Startup recovery and the single-runner lock. See docs/implementation/runner-lifecycle.md,
 * "Startup recovery" and decision 1. D's recovery, export and removal are injected: `runner/production.ts` passes D's own.
 */
export class LockHeld extends Error { constructor() { super('Another codeboost runner is using this database.'); } }
export class RecoveryBlocked extends Error {
  readonly items: string[];
  /** One item per line, so a list of commands can be copied as it is. */
  constructor(message: string, items: string[]) { super(`${message}:\n${items.join('\n')}`); this.items = items; }
}
/** The shell line that removes a Docker object D reported, its name or ID quoted as one shell word. */
export function removalCommand(resource: { kind: 'container' | 'network' | 'volume'; id?: string; name: string }): string {
  const word = `'${(resource.id ?? resource.name).replaceAll("'", "'\\''")}'`;
  return `docker ${resource.kind} rm${resource.kind === 'container' ? ' -f' : ''} ${word}`;
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

/**
 * Strong references to every held lock connection. Without this, a caller that drops the returned RunnerLock lets the
 * connection be garbage-collected, and closing it silently releases the OS lock while the runner is still alive.
 */
const heldLocks = new Set<DatabaseSync>();
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
    heldLocks.add(heldDb);
    let released = false;
    return {
      file,
      verify() {
        const now = lstatSync(path, { bigint: true });
        if (now.isSymbolicLink() || !now.isFile() || now.dev !== file.dev || now.ino !== file.ino || now.nlink !== 1n)
          throw new Error('The database path changed while opening. Refusing to start.');
      },
      release() { if (released) return; released = true; heldLocks.delete(heldDb); heldDb.close(); closeSync(fd); },
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
    try { return startTimeMatches(execFileSync('ps', ['-o', 'lstart=', '-p', String(pgid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }), startedAt); }
    catch { return true; } // Alive but unreadable: treat as ours and stop it (fail closed).
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

/** Whether `ps -o lstart=` output names the recorded start time. An unreadable time counts as a match (fail closed). */
export function startTimeMatches(lstart: string, startedAt: number): boolean {
  const started = Date.parse(lstart.trim());
  return !Number.isFinite(started) || Math.abs(started - startedAt) < 2_000;
}

export interface RecoveredStorage { readonly attemptId: string; readonly allocationId: string; readonly handle: unknown }
export interface RecoveryDeps {
  /** D (#51): stop leftover agent containers, proxies and networks for this owner; keep task storage and return authenticated handles. */
  recoverLeftovers(runnerOwner: string): Promise<{ storage: RecoveredStorage[]; unowned: string[] }>;
  /**
   * D's bounded diff of a recovered task storage against `base`, the commit it was seeded from, checked against the
   * `metadataBaseline` F saved at allocation. It must stop its own work when the signal aborts.
   */
  exportTaskDiff(handle: unknown, input: { base: string; metadataBaseline: string }, maxBytes: number, signal: AbortSignal): Promise<{ diff: Buffer; truncated: boolean }>;
  removeTaskFilesystems(handle: unknown): Promise<void>;
  /** F3: abort an interrupted rebase. Until F3 exists no rebase is ever recorded. */
  abortRebase?(planKey: string, marker: unknown): Promise<void>;
  processes?: ProcessControl;
}
export interface RecoveryOptions {
  store: Store; runnerOwner: string; runnerRoot: string; diagnosticsDir: string; deps: RecoveryDeps;
  now?: () => number; exportDeadlineMs?: number; graceMs?: number; openFiles?: (dir: string) => string[] | Promise<string[]>;
  /** The diagnostics directory's total byte cap; retention as on the live path (`saveDiagnostic`). */
  diagnosticsCapBytes?: number;
}
export interface RecoveryReport {
  finalized: { attemptId: string; planKey: string; state: string; requeued: boolean }[];
  requeue: string[]; removedDirectories: string[]; unknownEntries: string[]; unmatchedStorage: string[]; repairedMerges: string[];
}
function validRebaseResult(marker: Partial<RebaseMarker>, head: unknown, mappings: unknown): boolean {
  if (mappings === null) return head === null;
  if (!Array.isArray(mappings) || mappings.length > 500 ||
      (marker.onto === marker.oldBase) !== (head === null)) return false;
  const sources = new Set<string>(), destinations = new Set<string>();
  for (const mapping of mappings as unknown[]) {
    if (!mapping || typeof mapping !== 'object') return false;
    const { oldSha, newSha } = mapping as { oldSha?: unknown; newSha?: unknown };
    if (typeof oldSha !== 'string' || typeof newSha !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oldSha) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(newSha) ||
        sources.has(oldSha) || destinations.has(newSha)) return false;
    sources.add(oldSha); destinations.add(newSha);
  }
  if (marker.oldHead === marker.oldBase) return mappings.length === 0;
  const endpoint = mappings.at(-1) as { oldSha: string; newSha: string } | undefined;
  return !!endpoint && endpoint.oldSha === marker.oldHead &&
    (head === null ? endpoint.newSha === marker.oldHead && mappings.every(mapping => mapping.oldSha === mapping.newSha) : endpoint.newSha === head);
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
  if (recovered.unowned.length) throw new RecoveryBlocked('Docker holds codeboost objects this runner will not remove itself: objects without a runner label may belong to an older build that is still running, and objects of this runner it cannot identify are not ones it made. Stop every older codeboost process, check and run these commands, then start again', recovered.unowned);
  // A handle is used only if both its attempt ID and its allocation ID match one attempt row of this database
  // (runner-lifecycle.md, "Recovered storage handles"); any other is reported and left for a person.
  const matched = recovered.storage.filter(s => isUuidV4(s.attemptId) && isUuidV4(s.allocationId) && o.store.attemptAllocation(s.attemptId) === s.allocationId);
  const unmatchedStorage = recovered.storage.filter(s => !matched.includes(s)).map(s => s.attemptId);
  // 3. Export phase: stopped writable attempts only, outside any transaction, fixed names, bounded deadline.
  const exports: Record<string, { diagnosticRef?: string; failure?: string }> = {};
  ownerOnlyDirectory(o.diagnosticsDir);
  for (const storage of matched) {
    const attempt = interrupted.find(a => a.id === storage.attemptId);
    if (!attempt || !WRITABLE_KINDS.includes(attempt.kind)) continue;
    // Saved after D's allocation returned; a crash before that leaves nothing D's export would accept (fail closed).
    if (!attempt.metadataBaseline || !attempt.storageBase) {
      exports[storage.attemptId] = { failure: 'its storage baseline was never saved' };
      continue;
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Export timed out.')), o.exportDeadlineMs ?? 60_000);
    const exporting = o.deps.exportTaskDiff(storage.handle, { base: attempt.storageBase, metadataBaseline: attempt.metadataBaseline }, EXPORT_LIMIT, controller.signal);
    try {
      const { diff, truncated } = await Promise.race([exporting,
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))]);
      // Earlier exports of this pass are not referenced until finalization, so retention must keep them too.
      const saved = Object.values(exports).flatMap(entry => entry.diagnosticRef ? [entry.diagnosticRef] : []);
      exports[storage.attemptId] = { diagnosticRef: saveDiagnostic(o.store, o.diagnosticsDir, storage.attemptId,
        partialOutput(diff.subarray(0, EXPORT_LIMIT), truncated || diff.length > EXPORT_LIMIT), o.diagnosticsCapBytes, saved) };
    } catch (error) { exports[storage.attemptId] = { failure: error instanceof Error ? error.message : String(error) }; }
    finally { clearTimeout(timer); }
    // A timed-out export must stop before step 4 removes its storage. D stops on abort; if it does not, fail closed.
    if (controller.signal.aborted) await stopped(exporting, o.graceMs ?? 5_000, storage.attemptId);
  }
  // 3. Finalization phase: one transaction; a failure stops startup.
  const finalized = o.store.recoverInterrupted(now(), exports);
  // 4. Rebases, storage removal (every matched handle), then attempt directories.
  for (const rebase of o.store.rebasesInProgress()) {
    if (!o.deps.abortRebase) throw new RecoveryBlocked('An interrupted rebase needs F3 to abort it', [rebase.planKey]);
    const marker = rebase.marker as Partial<RebaseMarker> | null;
    const processGroup = marker?.processGroup, resultHead = marker?.resultHead ?? null, resultMappings = marker?.resultMappings ?? null;
    if (!marker || !isUuidV4(marker.attemptId) || typeof marker.oldBase !== 'string' || typeof marker.oldHead !== 'string' || typeof marker.onto !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(marker.oldBase) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(marker.oldHead) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(marker.onto) ||
        !Number.isSafeInteger(marker.startedAt) || marker.startedAt! < 0 ||
        (resultHead !== null && (typeof resultHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resultHead))) ||
        !validRebaseResult(marker, resultHead, resultMappings) ||
        (processGroup !== null && (!processGroup || typeof processGroup === 'string' || !Number.isSafeInteger(processGroup.pgid) || processGroup.pgid <= 1 ||
          !Number.isSafeInteger(processGroup.startedAt) || processGroup.startedAt < 0)))
      throw new RecoveryBlocked('An interrupted rebase has an invalid recovery marker', [rebase.planKey]);
    if (processGroup) {
      if (processes.isAlive(processGroup.pgid, processGroup.startedAt)) await processes.terminate(processGroup.pgid, o.graceMs ?? 5_000);
      // A descendant can escape the recorded process group before it is terminated. Whether the group was initially
      // alive or dead, prove that no process still uses the workspace before releasing its durable owner.
      const workspace = join(o.runnerRoot, o.runnerOwner, 'rebases', marker.attemptId);
      const stat = lstatSync(workspace, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new RecoveryBlocked('An interrupted rebase workspace is not a plain directory', [workspace]);
      const users = stat ? await (o.openFiles ? o.openFiles(workspace) : hostOpenFilesBounded(workspace)) : [];
      if (users.length) throw new RecoveryBlocked('A process still uses an interrupted rebase workspace', users);
      o.store.setRebaseProcessGroup(rebase.planKey, marker.attemptId, processGroup, null);
    }
    await o.deps.abortRebase(rebase.planKey, { ...marker, resultHead, resultMappings, processGroup: null });
    if (!o.store.abortRebase(rebase.planKey, marker.attemptId))
      throw new RecoveryBlocked('An interrupted rebase changed while recovery aborted it', [rebase.planKey]);
  }
  for (const storage of matched) await o.deps.removeTaskFilesystems(storage.handle);
  // Step 7's set, read after finalization so it also holds preparations an earlier startup already finalized.
  const blocked = [...new Set([...unowned, ...o.store.unownedPreparations()])];
  const removedDirectories: string[] = [], unknownEntries: string[] = [];
  const attemptsDir = join(o.runnerRoot, o.runnerOwner, 'attempts');
  const rootDev = lstatSync(o.runnerRoot, { throwIfNoEntry: false })?.dev;
  for (const name of lstatSync(attemptsDir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(attemptsDir) : []) {
    const entry = join(attemptsDir, name), st = lstatSync(entry);
    const owned = st.isDirectory() && !st.isSymbolicLink() && st.dev === rootDev && isUuidV4(name) && o.store.attemptOwner(name) !== null;
    if (!owned) { unknownEntries.push(entry); continue; }
    if (blocked.includes(name)) continue; // step 7 keeps it for --release-preparation
    rmSync(entry, { recursive: true, force: true }); removedDirectories.push(entry);
  }
  // 5. Confirmed merges get their closed status and task-closed event.
  const repairedMerges = o.store.reconcileMergedTasks();
  // 7. An unidentifiable preparation child may exist: fail closed until the user releases it.
  if (blocked.length) throw new RecoveryBlocked('Preparation started but its process was never recorded; stop it, then run --release-preparation', blocked);
  return { finalized, requeue: finalized.filter(f => f.requeued).map(f => f.planKey), removedDirectories, unknownEntries, unmatchedStorage, repairedMerges };
}

/** Wait for an aborted export to settle, up to graceMs; otherwise stop startup before its storage is touched. */
async function stopped(exporting: Promise<unknown>, graceMs: number, attemptId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([exporting.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
  clearTimeout(timer);
  if (!settled) throw new RecoveryBlocked('A partial-output export did not stop after its deadline; its task storage was left in place', [attemptId]);
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
  // /proc links and lsof report resolved paths, so compare against the resolved directory.
  dir = realpathSync(dir);
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

const OPEN_FILES_DEADLINE_MS = 15_000;
const MAX_PROC_ENTRIES = 100_000;
const MAX_FD_ENTRIES = 1_000_000;
type OpenFilesRun = (file: string, args: readonly string[], options: Parameters<typeof runInProcessGroup>[2]) => Promise<DockerOutcome>;
function linuxOpenFiles(dir: string): string[] {
  dir = realpathSync(dir);
  const users: string[] = [], disappeared = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
  let processes = 0, descriptors = 0;
  const proc = opendirSync('/proc');
  try {
    for (let entry = proc.readSync(); entry; entry = proc.readSync()) {
      if (!/^\d+$/.test(entry.name)) continue;
      if (++processes > MAX_PROC_ENTRIES) throw new Error('Open-file probe exceeded its process bound.');
      const pid = entry.name, links: string[] = [];
      try { if (process.getuid && lstatSync(`/proc/${pid}`).uid !== process.getuid()) continue; }
      catch (error) { if (disappeared(error)) continue; throw error; }
      try { links.push(realpathSync(`/proc/${pid}/cwd`)); }
      catch (error) { if (!disappeared(error)) throw error; }
      let fds: ReturnType<typeof opendirSync> | undefined;
      try { fds = opendirSync(`/proc/${pid}/fd`); }
      catch (error) { if (disappeared(error)) continue; throw error; }
      try {
        for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
          if (++descriptors > MAX_FD_ENTRIES) throw new Error('Open-file probe exceeded its descriptor bound.');
          try { links.push(realpathSync(`/proc/${pid}/fd/${fd.name}`)); }
          catch (error) { if (!disappeared(error)) throw error; }
        }
      } finally { fds.closeSync(); }
      if (links.some(link => link === dir || link.startsWith(`${dir}/`))) users.push(pid);
    }
  } finally { proc.closeSync(); }
  return users;
}
/** Recovery's bounded variant. Its lsof process and pipes settle inside the overall deadline before startup proceeds. */
export async function hostOpenFilesBounded(dir: string, options: { timeoutMs?: number; platform?: NodeJS.Platform;
  now?: () => number; run?: OpenFilesRun } = {}): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? OPEN_FILES_DEADLINE_MS, now = options.now ?? performance.now.bind(performance);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 12_001) throw new Error('Invalid open-file probe deadline.');
  const deadline = now() + timeoutMs;
  if ((options.platform ?? process.platform) === 'linux') {
    const childTimeoutMs = timeoutMs - 12_000;
    const outcome = await (options.run ?? runInProcessGroup)(process.execPath,
      [fileURLToPath(import.meta.url), '--scan-open-files'], { env: { PATH: process.env.PATH ?? '' }, input: Buffer.from(dir),
        timeoutMs: childTimeoutMs, graceMs: 1_000, maxBuffer: 1024 * 1024 });
    if (now() >= deadline) throw new Error('Open-file probe timed out. Refusing to recover the rebase workspace.');
    if (outcome.status === 0 && !outcome.stderr.trim()) {
      const users = outcome.stdout.split('\n').filter(Boolean);
      if (users.every(pid => /^\d+$/.test(pid))) return users;
    }
    throw new Error('Could not check which processes use the rebase workspace. Refusing to recover it.');
  }
  // runInProcessGroup may spend 1 s on SIGTERM, 10 s draining the group, and 1 s draining pipes after its timer.
  const childTimeoutMs = timeoutMs - 12_000;
  const outcome = await (options.run ?? runInProcessGroup)('/usr/sbin/lsof', ['-t', '+D', dir],
    { env: { LC_ALL: 'C' }, timeoutMs: childTimeoutMs, graceMs: 1_000, maxBuffer: 1024 * 1024 });
  if (now() >= deadline) throw new Error('Open-file probe timed out. Refusing to recover the rebase workspace.');
  if (outcome.status === 0 && !outcome.stderr.trim()) return outcome.stdout.split('\n').filter(Boolean);
  if (outcome.status === 1 && !outcome.stdout && !outcome.stderr.trim() && !outcome.error) return [];
  throw new Error('Could not check which processes use the rebase workspace. Refusing to recover it.');
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--scan-open-files')
  process.stdout.write(`${linuxOpenFiles(readFileSync(0, 'utf8')).join('\n')}\n`);

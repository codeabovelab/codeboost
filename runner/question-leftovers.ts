import { execFile } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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
const LABELLED = 'docker ps -a, docker volume ls and docker network ls, each with --filter label=io.codeboost.allocation, label=io.codeboost.invocation or label=io.codeboost.egress';

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

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
  #locked = false;
  readonly listTaskStorage: ListTaskStorage;
  constructor(path: string, listTaskStorage: ListTaskStorage = dockerTaskStorage) { this.path = path; this.listTaskStorage = listTaskStorage; }

  /**
   * Exclusive Ask lock for this review database, held for the question worker's lifetime. Only the holder scans,
   * starts a worker or writes this record, so two processes on one review cannot both pass the startup scan or
   * overwrite each other's record. A lock left by a process that no longer exists is taken over.
   */
  acquire(): void {
    if (this.#locked) return;
    const lock = `${this.path}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
        this.#locked = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number.parseInt(readFileSync(lock, 'utf8'), 10);
        if (!Number.isSafeInteger(owner) || owner <= 0 || processExists(owner)) {
          throw new Error(`Ask is off: another codeboost process (${Number.isSafeInteger(owner) ? `PID ${owner}` : 'unknown'}) is running Ask for this review. Stop it, or delete ${lock} if that process is gone.`);
        }
        rmSync(lock, { force: true });
      }
    }
    throw new Error(`Ask is off: could not take the Ask lock ${lock}.`);
  }
  release(): void {
    if (!this.#locked) return;
    this.#locked = false;
    rmSync(`${this.path}.lock`, { force: true });
  }

  #read(): LedgerRecord {
    if (!existsSync(this.path)) return { leftovers: [], untracked: 0, roots: [] };
    try { return parse(readFileSync(this.path, 'utf8')); }
    catch { throw new Error(`Ask is off: the record of leftover agent storage (${this.path}) is unreadable. Check \`docker ps -a\` and \`docker volume ls\` for codeboost resources, remove them, then delete that file.`); }
  }

  #write(record: LedgerRecord): void {
    if (!record.leftovers.length && !record.untracked && !record.roots.length) { rmSync(this.path, { force: true }); return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Add allocations that could not be removed, unnamed failures, and Ask roots that may still hold host copies. */
  record(leftovers: readonly Leftover[], untracked = 0, roots: readonly string[] = []): void {
    if (!leftovers.length && !untracked && !roots.length) return;
    const known = this.#read();
    const keys = new Set(known.leftovers.map(entry => entry.keeper));
    const merged = [...known.leftovers, ...leftovers.filter(entry => !keys.has(entry.keeper))];
    // Never drop evidence: entries beyond the cap become unnamed, which keeps Ask off until no task storage remains.
    const mergedRoots = [...new Set([...known.roots, ...roots.filter(isAskRoot)])];
    this.#write({ leftovers: merged.slice(0, MAX_LEFTOVERS), roots: mergedRoots.slice(0, MAX_LEFTOVERS),
      untracked: known.untracked + untracked + Math.max(0, merged.length - MAX_LEFTOVERS) + Math.max(0, mergedRoots.length - MAX_LEFTOVERS) });
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
    if (options.startup && !known.untracked) known.untracked = 1;
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
    // Unnamed leftovers are gone only when no task storage exists at all.
    const labelled = storage.containers.size + storage.volumes.size + (storage.networks?.size ?? 0);
    const untracked = known.untracked && labelled ? known.untracked : 0;
    this.#write({ leftovers: remaining, untracked, roots: known.roots });
    if (untracked) throw new Error(`Ask is off: an earlier codeboost session may have left agent containers, volumes or networks that cannot be identified (${labelled} labelled resource${labelled === 1 ? '' : 's'} found). List them with ${LABELLED}. Remove them if no other codeboost is running, then retry.`);
    if (remaining.length) throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
  }
}

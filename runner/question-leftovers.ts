import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

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
interface LedgerRecord { leftovers: Leftover[]; untracked: number; paths: string[] }

// One whole check, not per resource: it runs before each question and must not hold it or shutdown for long.
const CHECK_TIMEOUT_MS = 15_000;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
// Ask's host staging directory, as created by mkdtemp(join(tmpdir(), 'codeboost-question-')).
const STAGING_NAME = /^codeboost-question-[A-Za-z0-9]{6}$/;
export const isStagingPath = (path: unknown): path is string =>
  typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && STAGING_NAME.test(basename(path));

/** Remove Ask's host staging directory (reviewed clone and read-only input). Throws if it cannot be removed. */
export function removeStaging(root: string): void {
  if (!isStagingPath(root)) throw new Error('Refusing to remove a path that is not an Ask staging directory.');
  try { chmodSync(join(root, 'input'), 0o700); } catch { /* not created or already gone */ }
  rmSync(root, { recursive: true, force: true });
}
const MAX_LEFTOVERS = 100;

/** Read-only label queries (Docker ANDs label filters, so one query per label). Any failure keeps Ask off. */
export const dockerTaskStorage: ListTaskStorage = async signal => {
  const list = (args: string[]) => new Promise<string[]>((resolve, reject) => execFile('docker', args,
    { timeout: CHECK_TIMEOUT_MS, signal }, (error, stdout) => error ? reject(error)
      : resolve(String(stdout).split('\n').map(line => line.trim()).filter(Boolean))));
  const labels = ['io.codeboost.allocation', 'io.codeboost.invocation', 'io.codeboost.egress'];
  const [containers, volumes, networks] = await Promise.all([
    Promise.all(labels.map(label => list(['ps', '-a', '--format', '{{.Names}}', '--filter', `label=${label}`]))),
    list(['volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.allocation']),
    list(['network', 'ls', '--format', '{{.Name}}', '--filter', 'label=io.codeboost.egress'])]);
  return { containers: new Set(containers.flat()), volumes: new Set(volumes), networks: new Set(networks) };
};
const LABELLED = 'docker ps -a, docker volume ls and docker network ls, each with --filter label=io.codeboost.allocation, label=io.codeboost.invocation or label=io.codeboost.egress';

function parse(text: string): LedgerRecord {
  const value = JSON.parse(text) as { leftovers?: unknown; untracked?: unknown };
  const list = value?.leftovers, untracked = value?.untracked, paths = (value as { paths?: unknown })?.paths ?? [];
  if (!Array.isArray(list) || list.length > MAX_LEFTOVERS || !Number.isSafeInteger(untracked) || (untracked as number) < 0
    || !Array.isArray(paths) || paths.length > MAX_LEFTOVERS || !paths.every(isStagingPath))
    throw new Error('invalid record');
  return { untracked: untracked as number, paths: paths as string[], leftovers: list.map(entry => {
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
  readonly listTaskStorage: ListTaskStorage;
  constructor(path: string, listTaskStorage: ListTaskStorage = dockerTaskStorage) { this.path = path; this.listTaskStorage = listTaskStorage; }

  #read(): LedgerRecord {
    if (!existsSync(this.path)) return { leftovers: [], untracked: 0, paths: [] };
    try { return parse(readFileSync(this.path, 'utf8')); }
    catch { throw new Error(`Ask is off: the record of leftover agent storage (${this.path}) is unreadable. Check \`docker ps -a\` and \`docker volume ls\` for codeboost resources, remove them, then delete that file.`); }
  }

  #write(record: LedgerRecord): void {
    if (!record.leftovers.length && !record.untracked && !record.paths.length) { rmSync(this.path, { force: true }); return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Add allocations and host staging directories that could not be removed, and unnamed failures. */
  record(leftovers: readonly Leftover[], untracked = 0, paths: readonly string[] = []): void {
    if (!leftovers.length && !untracked && !paths.length) return;
    const known = this.#read();
    const keys = new Set(known.leftovers.map(entry => entry.keeper));
    const merged = [...known.leftovers, ...leftovers.filter(entry => !keys.has(entry.keeper))];
    // Never drop evidence: entries beyond the cap become unnamed, which keeps Ask off until no task storage remains.
    const mergedPaths = [...new Set([...known.paths, ...paths.filter(isStagingPath)])];
    this.#write({ leftovers: merged.slice(0, MAX_LEFTOVERS), paths: mergedPaths.slice(0, MAX_LEFTOVERS),
      untracked: known.untracked + untracked + Math.max(0, merged.length - MAX_LEFTOVERS) + Math.max(0, mergedPaths.length - MAX_LEFTOVERS) });
  }

  /**
   * Drop entries whose resources are all gone. Throws, with removal commands, while any remain, and also when
   * Docker cannot be checked within the time limit or `signal` aborts.
   */
  async assertClear(signal?: AbortSignal, options: { startup?: boolean } = {}): Promise<void> {
    const known = this.#read();
    // At startup a missing record proves nothing: the last process may have been killed before writing it.
    const stored = known.untracked;
    if (options.startup && !known.untracked) known.untracked = 1;
    // Host copies of reviewed code need no Docker: remove them first and keep only what still resists.
    const paths = known.paths.filter(path => { try { removeStaging(path); return false; } catch { return true; } });
    if (paths.length !== known.paths.length) this.#write({ ...known, paths, untracked: stored });
    if (paths.length) throw new Error(`Ask is off: copies of reviewed code from an earlier question could not be deleted. Delete them, then retry:\n${paths.map(path => `rm -rf '${path}'`).join('\n')}`);
    known.paths = [];
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
    this.#write({ leftovers: remaining, untracked, paths: [] });
    if (untracked) throw new Error(`Ask is off: an earlier codeboost session may have left agent containers, volumes or networks that cannot be identified (${labelled} labelled resource${labelled === 1 ? '' : 's'} found). List them with ${LABELLED}. Remove them if no other codeboost is running, then retry.`);
    if (remaining.length) throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
  }
}

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** Docker resources of one Ask storage allocation that codeboost could not remove. */
export interface Leftover {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
}
/** Names of the containers and volumes that carry lane D's task-storage label. */
export interface TaskStorage { readonly containers: ReadonlySet<string>; readonly volumes: ReadonlySet<string> }
export type ListTaskStorage = (signal: AbortSignal) => Promise<TaskStorage>;
interface LedgerRecord { leftovers: Leftover[]; untracked: number }

// One whole check, not per resource: it runs before each question and must not hold it or shutdown for long.
const CHECK_TIMEOUT_MS = 15_000;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const MAX_LEFTOVERS = 100;

/** Two read-only label queries. Any failure rejects, so an unreachable daemon keeps Ask off. */
export const dockerTaskStorage: ListTaskStorage = async signal => {
  const list = (args: string[]) => new Promise<Set<string>>((resolve, reject) => execFile('docker', args,
    { timeout: CHECK_TIMEOUT_MS, signal }, (error, stdout) => error ? reject(error)
      : resolve(new Set(String(stdout).split('\n').map(line => line.trim()).filter(Boolean)))));
  const [containers, volumes] = await Promise.all([
    list(['ps', '-a', '--format', '{{.Names}}', '--filter', 'label=io.codeboost.task-storage']),
    list(['volume', 'ls', '--quiet', '--filter', 'label=io.codeboost.task-storage'])]);
  return { containers, volumes };
};

function parse(text: string): LedgerRecord {
  const value = JSON.parse(text) as { leftovers?: unknown; untracked?: unknown };
  const list = value?.leftovers, untracked = value?.untracked;
  if (!Array.isArray(list) || list.length > MAX_LEFTOVERS || !Number.isSafeInteger(untracked) || (untracked as number) < 0)
    throw new Error('invalid record');
  return { untracked: untracked as number, leftovers: list.map(entry => {
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
    if (!existsSync(this.path)) return { leftovers: [], untracked: 0 };
    try { return parse(readFileSync(this.path, 'utf8')); }
    catch { throw new Error(`Ask is off: the record of leftover agent storage (${this.path}) is unreadable. Check \`docker ps -a\` and \`docker volume ls\` for codeboost resources, remove them, then delete that file.`); }
  }

  #write(record: LedgerRecord): void {
    if (!record.leftovers.length && !record.untracked) { rmSync(this.path, { force: true }); return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Add allocations that could not be removed, and a count of failed setups with no known names. */
  record(leftovers: readonly Leftover[], untracked = 0): void {
    if (!leftovers.length && !untracked) return;
    const known = this.#read();
    const keys = new Set(known.leftovers.map(entry => entry.keeper));
    const merged = [...known.leftovers, ...leftovers.filter(entry => !keys.has(entry.keeper))];
    // Never drop evidence: entries beyond the cap become unnamed, which keeps Ask off until no task storage remains.
    this.#write({ leftovers: merged.slice(0, MAX_LEFTOVERS),
      untracked: known.untracked + untracked + Math.max(0, merged.length - MAX_LEFTOVERS) });
  }

  /**
   * Drop entries whose resources are all gone. Throws, with removal commands, while any remain, and also when
   * Docker cannot be checked within the time limit or `signal` aborts.
   */
  async assertClear(signal?: AbortSignal): Promise<void> {
    const known = this.#read();
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
    const untracked = known.untracked && (storage.containers.size || storage.volumes.size) ? known.untracked : 0;
    this.#write({ leftovers: remaining, untracked });
    if (untracked) throw new Error('Ask is off: agent storage setup failed in an earlier session and its leftovers could not be identified. Remove the containers and volumes listed by `docker ps -a --filter label=io.codeboost.task-storage` and `docker volume ls --filter label=io.codeboost.task-storage`, then retry.');
    if (remaining.length) throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
  }
}

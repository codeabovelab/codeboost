import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** Docker resources of one Ask storage allocation that codeboost could not remove. */
export interface Leftover {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
}
export type ResourceExists = (kind: 'container' | 'volume', name: string) => Promise<boolean>;
/** Whether any container or volume labelled as lane D task storage exists. */
export type AnyTaskStorage = () => Promise<boolean>;
interface LedgerRecord { leftovers: Leftover[]; untracked: number }

const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const MAX_LEFTOVERS = 100;

/**
 * Read-only check through `docker inspect`. Any answer other than "no such object" counts as still present,
 * so an unreachable daemon keeps Ask off instead of forgetting the leftovers.
 */
export const dockerResourceExists: ResourceExists = (kind, name) => new Promise(resolve => {
  execFile('docker', [kind, 'inspect', '--format', '{{.Name}}', name], { timeout: 10_000 }, (error, _stdout, stderr) => {
    resolve(!error ? true : !/no such (container|volume|object)/i.test(String(stderr)));
  });
});

/** Read-only label query. An unreachable daemon counts as "storage exists", so Ask stays off. */
export const dockerAnyTaskStorage: AnyTaskStorage = async () => {
  const list = (args: string[]) => new Promise<boolean>(resolve => execFile('docker', args, { timeout: 10_000 },
    (error, stdout) => resolve(!!error || String(stdout).trim() !== '')));
  const [containers, volumes] = await Promise.all([
    list(['ps', '-a', '-q', '--filter', 'label=io.codeboost.task-storage']),
    list(['volume', 'ls', '-q', '--filter', 'label=io.codeboost.task-storage'])]);
  return containers || volumes;
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
  readonly exists: ResourceExists;
  readonly anyTaskStorage: AnyTaskStorage;
  constructor(path: string, exists: ResourceExists = dockerResourceExists, anyTaskStorage: AnyTaskStorage = dockerAnyTaskStorage) {
    this.path = path; this.exists = exists; this.anyTaskStorage = anyTaskStorage;
  }

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
    this.#write({ leftovers: [...known.leftovers, ...leftovers.filter(entry => !keys.has(entry.keeper))].slice(0, MAX_LEFTOVERS),
      untracked: known.untracked + untracked });
  }

  /** Drop entries whose resources are all gone. Throws, with removal commands, while any remain. */
  async assertClear(): Promise<void> {
    const known = this.#read();
    if (!known.leftovers.length && !known.untracked) return;
    const remaining: Leftover[] = [];
    for (const entry of known.leftovers) {
      const present = await Promise.all([this.exists('container', entry.keeper),
        this.exists('volume', entry.workVolume), this.exists('volume', entry.metadataVolume)]);
      if (present.some(Boolean)) remaining.push(entry);
    }
    // Untracked leftovers have no names, so only "no task storage at all" proves they are gone.
    const untracked = known.untracked && await this.anyTaskStorage() ? known.untracked : 0;
    this.#write({ leftovers: remaining, untracked });
    if (untracked) throw new Error('Ask is off: agent storage setup failed in an earlier session and its leftovers could not be identified. Remove the containers and volumes listed by `docker ps -a --filter label=io.codeboost.task-storage` and `docker volume ls --filter label=io.codeboost.task-storage`, then retry.');
    if (remaining.length) {
      const commands = remaining.map(entry => `docker rm -f ${entry.keeper} && docker volume rm ${entry.workVolume} ${entry.metadataVolume}`);
      throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
    }
  }
}

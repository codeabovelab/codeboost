import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** Docker resources of one Ask storage allocation that codeboost could not remove. */
export interface Leftover {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
}
export type ResourceExists = (kind: 'container' | 'volume', name: string) => Promise<boolean>;

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

function parse(text: string): Leftover[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > MAX_LEFTOVERS) throw new Error('invalid list');
  return value.map(entry => {
    const { keeper, workVolume, metadataVolume } = (entry ?? {}) as Record<string, unknown>;
    if (![keeper, workVolume, metadataVolume].every(name => typeof name === 'string' && DOCKER_NAME.test(name)))
      throw new Error('invalid entry');
    return { keeper, workVolume, metadataVolume } as Leftover;
  });
}

/**
 * Durable record of Ask storage that outlived its worker. Lane D keeps allocation ownership in process memory,
 * so after a shutdown nothing can remove these through D until its scoped recovery exists (#51 item 4).
 * Until then, Ask stays off while any recorded resource still exists, and tells the user how to remove it.
 */
export class LeftoverLedger {
  readonly path: string;
  readonly exists: ResourceExists;
  constructor(path: string, exists: ResourceExists = dockerResourceExists) { this.path = path; this.exists = exists; }

  #read(): Leftover[] {
    if (!existsSync(this.path)) return [];
    try { return parse(readFileSync(this.path, 'utf8')); }
    catch { throw new Error(`Ask is off: the record of leftover agent storage (${this.path}) is unreadable. Check \`docker ps -a\` and \`docker volume ls\` for codeboost resources, remove them, then delete that file.`); }
  }

  #write(leftovers: readonly Leftover[]): void {
    if (!leftovers.length) { rmSync(this.path, { force: true }); return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(leftovers, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Add allocations that could not be removed. Existing entries are kept. */
  record(leftovers: readonly Leftover[]): void {
    if (!leftovers.length) return;
    const known = this.#read();
    const keys = new Set(known.map(entry => entry.keeper));
    this.#write([...known, ...leftovers.filter(entry => !keys.has(entry.keeper))].slice(0, MAX_LEFTOVERS));
  }

  /** Drop entries whose resources are all gone. Throws, with removal commands, while any remain. */
  async assertClear(): Promise<void> {
    const known = this.#read();
    if (!known.length) return;
    const remaining: Leftover[] = [];
    for (const entry of known) {
      const present = await Promise.all([this.exists('container', entry.keeper),
        this.exists('volume', entry.workVolume), this.exists('volume', entry.metadataVolume)]);
      if (present.some(Boolean)) remaining.push(entry);
    }
    this.#write(remaining);
    if (remaining.length) {
      const commands = remaining.map(entry => `docker rm -f ${entry.keeper} && docker volume rm ${entry.workVolume} ${entry.metadataVolume}`);
      throw new Error(`Ask is off: agent storage from an earlier session was not removed. Remove it, then retry:\n${commands.join('\n')}`);
    }
  }
}

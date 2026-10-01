import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUuidV4 } from './lifecycle.ts';
import type { Store } from './store.ts';

/** The total the diagnostics directory may hold before retention deletes files. */
export const DEFAULT_DIAGNOSTICS_CAP_BYTES = 256 * 1024 * 1024;
const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.diff$/;

/**
 * Save a stopped attempt's partial output as `<directory>/<attemptId>.diff` (runner-lifecycle.md, the task storage
 * row), then apply retention. The file is written through a unique temporary file opened exclusively, owner-only, and
 * renamed into place; a failed write leaves nothing. Returns the path the attempt row references as `diagnostic_ref`.
 */
export function saveDiagnostic(store: Store, directory: string, attemptId: string, bytes: Buffer,
  capBytes = DEFAULT_DIAGNOSTICS_CAP_BYTES): string {
  if (!isUuidV4(attemptId)) throw new Error('Attempt ID must be a UUID v4.');
  if (!Number.isSafeInteger(capBytes) || capBytes < 1) throw new Error('The diagnostics cap must be a positive integer.');
  const path = join(directory, `${attemptId}.diff`), temporary = join(directory, `.${attemptId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  // The saved file stands even if retention cannot run now (the write gate closed): the next save retains again.
  try { retain(store, directory, capBytes, path); }
  catch (error) { console.error(`Diagnostics retention did not run: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
  return path;
}

/**
 * Retention never deletes a file an attempt row still references. Over the cap, it deletes unreferenced files oldest
 * first; if that is not enough, it takes the oldest referenced file and, in one transaction, clears that row's
 * `diagnostic_ref` and notes the removal in its diagnostic, and only after that commit deletes the file. The file just
 * saved (`keep`) is never removed: it is not referenced until the terminal write.
 */
export function retain(store: Store, directory: string, capBytes: number, keep?: string): void {
  const files = readdirSync(directory).flatMap(name => {
    const match = NAME.exec(name), path = join(directory, name);
    if (!match) return [];
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat?.isFile() ? [{ path, attemptId: match[1]!, size: stat.size, mtime: stat.mtimeMs }] : [];
  }).sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const referenced = new Set(store.referencedDiagnostics());
  for (const unreferenced of [true, false]) {
    for (const file of files) {
      if (total <= capBytes) return;
      if (file.path === keep || referenced.has(file.path) === unreferenced) continue;
      if (!unreferenced && !store.forgetDiagnostic(file.path)) continue;
      rmSync(file.path, { force: true });
      total -= file.size;
    }
  }
}

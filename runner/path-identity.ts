import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How a checkout's filesystem tells two path spellings apart (#162). */
export interface PathIdentity { caseSensitive: boolean; unicodeNormalization: 'none' | 'NFC' }

/**
 * Probes the filesystem that holds `directory`: writes `case` and NFC `café` in a fresh child directory, then asks
 * whether `CASE` and NFD `café` name the same files. The child directory is removed again.
 */
export function probePathIdentity(directory: string): PathIdentity {
  const probe = mkdtempSync(join(directory, 'identity-'));
  try {
    writeFileSync(join(probe, 'case'), '');
    writeFileSync(join(probe, 'café'), '');
    return { caseSensitive: !existsSync(join(probe, 'CASE')), unicodeNormalization: existsSync(join(probe, 'café')) ? 'NFC' : 'none' };
  } finally { rmSync(probe, { recursive: true, force: true }); }
}

/**
 * Refuses a configured `pathIdentity` that disagrees with the filesystem under `directory`. A wrong setting gives two
 * spellings of one file different plan keys (or one key to two files), so plan validation and linking would be wrong.
 */
export function assertPathIdentity(configured: PathIdentity, directory: string): void {
  const probed = probePathIdentity(directory);
  if (probed.caseSensitive === configured.caseSensitive && probed.unicodeNormalization === configured.unicodeNormalization) return;
  const describe = (identity: PathIdentity) => `caseSensitive ${identity.caseSensitive}, unicodeNormalization ${identity.unicodeNormalization}`;
  throw new Error(`pathIdentity (${describe(configured)}) does not match the filesystem that holds the task checkouts at ${directory} (${describe(probed)}). Set pathIdentity to the probed values.`);
}

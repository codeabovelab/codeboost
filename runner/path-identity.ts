import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PathIdentity } from '../core/path-identity.ts';

/**
 * Probes the host filesystem that holds `directory`: writes `case` and NFC `caf\u00e9` in a fresh child directory, then
 * asks whether `CASE` and NFD `cafe\u0301` name the same files. The child directory is removed again. The demo reviews a
 * checkout on this filesystem; the runner's task checkouts are on task storage instead (`probeTaskStoragePathIdentity`).
 */
export function probePathIdentity(directory: string): PathIdentity {
  const probe = mkdtempSync(join(directory, 'identity-'));
  try {
    writeFileSync(join(probe, 'case'), '');
    writeFileSync(join(probe, 'caf\u00e9'), '');
    return { caseSensitive: !existsSync(join(probe, 'CASE')), unicodeNormalization: existsSync(join(probe, 'cafe\u0301')) ? 'NFC' : 'none' };
  } finally { rmSync(probe, { recursive: true, force: true }); }
}

/**
 * Refuses a configured `pathIdentity` that disagrees with the probed one (#162). A wrong setting gives two spellings of
 * one file different plan keys (or one key to two files), so plan validation and linking would be wrong.
 */
export function assertPathIdentity(configured: PathIdentity, probed: PathIdentity, where: string): void {
  if (probed.caseSensitive === configured.caseSensitive && probed.unicodeNormalization === configured.unicodeNormalization) return;
  const describe = (identity: PathIdentity) => `caseSensitive ${identity.caseSensitive}, unicodeNormalization ${identity.unicodeNormalization}`;
  throw new Error(`pathIdentity (${describe(configured)}) does not match ${where} (${describe(probed)}). Set pathIdentity to the probed values.`);
}

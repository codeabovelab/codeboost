import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPathIdentity, probePathIdentity } from '../runner/path-identity.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'codeboost-path-identity-')); roots.push(root); return root; };

describe('checkout path identity probe', () => {
  it('reports the filesystem identity and removes its probe files', () => {
    const root = directory();
    const probed = probePathIdentity(root);
    expect(typeof probed.caseSensitive).toBe('boolean');
    expect(['none', 'NFC']).toContain(probed.unicodeNormalization);
    expect(readdirSync(root)).toEqual([]);
    // The same filesystem answers the same way twice.
    expect(probePathIdentity(root)).toEqual(probed);
  });
  it('accepts the probed identity and refuses one that disagrees on case or Unicode', () => {
    const root = directory(), probed = probePathIdentity(root);
    expect(() => assertPathIdentity(probed, root)).not.toThrow();
    expect(() => assertPathIdentity({ ...probed, caseSensitive: !probed.caseSensitive }, root))
      .toThrow(`pathIdentity (caseSensitive ${!probed.caseSensitive}, unicodeNormalization ${probed.unicodeNormalization}) does not match`);
    const other = probed.unicodeNormalization === 'NFC' ? 'none' : 'NFC';
    expect(() => assertPathIdentity({ ...probed, unicodeNormalization: other }, root)).toThrow(`unicodeNormalization ${other}) does not match`);
    expect(readdirSync(root)).toEqual([]);
  });
  it('fails when the directory cannot hold the probe', () => {
    expect(() => probePathIdentity(join(directory(), 'missing'))).toThrow();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PATH_IDENTITY_SCRIPT } from '../agents/container/storage.ts';
import { assertPathIdentity, probePathIdentity } from '../runner/path-identity.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'codeboost-path-identity-')); roots.push(root); return root; };

describe('host path identity probe', () => {
  it('reports the filesystem identity and removes its probe files', () => {
    const root = directory();
    const probed = probePathIdentity(root);
    expect(typeof probed.caseSensitive).toBe('boolean');
    expect(['none', 'NFC']).toContain(probed.unicodeNormalization);
    expect(readdirSync(root)).toEqual([]);
    // The same filesystem answers the same way twice.
    expect(probePathIdentity(root)).toEqual(probed);
  });
  it.runIf(process.platform === 'linux')('reports a Linux filesystem as case-sensitive without normalization', () => {
    // The CI runner's ext4: a probe that compared the same spelling twice would report NFC here.
    expect(probePathIdentity(directory())).toEqual({ caseSensitive: true, unicodeNormalization: 'none' });
  });
  it('fails when the directory cannot hold the probe', () => {
    expect(() => probePathIdentity(join(directory(), 'missing'))).toThrow();
  });
});

describe('path identity check', () => {
  const identity = { caseSensitive: true, unicodeNormalization: 'none' } as const;
  it('accepts an identical identity and refuses one that differs on case or Unicode', () => {
    expect(() => assertPathIdentity(identity, { ...identity }, 'the storage')).not.toThrow();
    expect(() => assertPathIdentity(identity, { ...identity, caseSensitive: false }, 'the storage'))
      .toThrow('pathIdentity (caseSensitive true, unicodeNormalization none) does not match the storage (caseSensitive false, unicodeNormalization none). Set pathIdentity to the probed values.');
    expect(() => assertPathIdentity(identity, { ...identity, unicodeNormalization: 'NFC' }, 'the storage'))
      .toThrow('does not match the storage (caseSensitive true, unicodeNormalization NFC)');
  });
});

describe('task storage probe script', () => {
  // The container probe runs this script; here it runs on a host folder whose answer the host probe knows. On a macOS
  // host (APFS folds both) a script that stopped measuring, and printed a constant, would disagree.
  it('reports what the host probe reports for the same folder', () => {
    const root = directory();
    const out = execFileSync('sh', ['-c', PATH_IDENTITY_SCRIPT, 'probe', root], { encoding: 'utf8' });
    const expected = probePathIdentity(root);
    expect(out).toBe(`codeboost-path-identity ${expected.caseSensitive} ${expected.unicodeNormalization}\n`);
  });
});

/** How the checkout compares paths. Linking needs it to decide whether two paths name the same file. */
export interface PathIdentity { caseSensitive: boolean; unicodeNormalization: 'none' | 'NFC' }

export function validPathIdentity(identity: PathIdentity | undefined): identity is PathIdentity {
  return typeof identity?.caseSensitive === 'boolean' && ['none', 'NFC'].includes(identity.unicodeNormalization);
}

/** The comparison key of a path under a checkout's path identity. */
export function pathKeyFor(identity: PathIdentity): (path: string) => string {
  if (!validPathIdentity(identity)) throw new Error('Known checkout path identity is required.');
  return path => {
    if (!identity.caseSensitive && /[^\x20-\x7e]/.test(path)) throw new Error('Non-ASCII case-insensitive paths require a filesystem-specific identity adapter.');
    const normalized = identity.unicodeNormalization === 'NFC' ? path.normalize('NFC') : path;
    return identity.caseSensitive ? normalized : normalized.toLowerCase();
  };
}

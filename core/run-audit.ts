import { posix } from 'node:path';
import type { PlanItem } from './plan.ts';

/**
 * The change manifest D reports after an execute/fix invocation (#66, `inspectTaskChanges`).
 * Paths are repo-relative with forward slashes; every entry is read without following links.
 */
export type EntryType = 'file' | 'symlink' | 'gitlink' | 'directory' | 'other';
export interface ManifestChange {
  path: string;
  oldPath?: string;
  kind: 'add' | 'modify' | 'delete' | 'rename' | 'mode';
  oldType?: EntryType;
  newType?: EntryType;
  /** Link text as stored, never resolved on the host. Present when newType is 'symlink'. */
  newLinkTarget?: string;
  /** D reports whether resolving the new target would traverse another symlink. */
  linkTargetTraversesLink?: boolean;
  underGit: boolean;
}
export interface ChangeManifest {
  changes: readonly ManifestChange[];
  agentCommits: readonly string[];
  metadataChanged: boolean;
  /** Differences from the pre-run snapshot of declared symlink targets. */
  linkTargetChanges: readonly string[];
  nestedGitlinkContent: readonly string[];
}
export type AuditOutcome =
  /** Stop before any test or commit; the task moves to needs human. Keep the output for diagnosis. */
  | { kind: 'violation'; violations: string[] }
  /** The runner may commit. Out-of-scope files are committed with the item, and pause the task in needs amendment. */
  | { kind: 'commit'; inScope: string[]; outOfScope: string[]; unchanged: boolean; needsAmendment: boolean };

const MAX_CHANGES = 10_000;
/** Every path in the report together; keeps the saved result (scope lists included) far below its 1 MiB limit. */
const MAX_PATH_BYTES = 480 * 1024;
const KINDS = new Set(['add', 'modify', 'delete', 'rename', 'mode']);
const TYPES = new Set(['file', 'symlink', 'gitlink', 'directory', 'other']);

/**
 * Every field the audit reads, checked before it reads any (AGENTS.md: partial records fail closed). A missing boolean
 * or entry type must never read as "clean". Returns the first problem, or null.
 */
function malformed(manifest: ChangeManifest): string | null {
  if (!manifest || typeof manifest !== 'object') return 'The change report is missing.';
  if (!Array.isArray(manifest.changes)) return 'The change report has no change list.';
  for (const field of ['agentCommits', 'linkTargetChanges', 'nestedGitlinkContent'] as const)
    if (!Array.isArray(manifest[field]) || manifest[field].some(entry => typeof entry !== 'string')) return `The change report has no ${field} list.`;
  if (typeof manifest.metadataChanged !== 'boolean') return 'The change report does not say whether Git metadata changed.';
  let bytes = 0;
  for (const change of manifest.changes) {
    if (!change || typeof change !== 'object' || typeof change.path !== 'string' || !change.path) return 'A change has no path.';
    // Only a rename has an old path; on any other kind it would be staged as if it were part of the change.
    if (change.kind === 'rename' ? typeof change.oldPath !== 'string' || !change.oldPath : change.oldPath !== undefined) return `The change at ${change.path} has an invalid old path.`;
    if (!KINDS.has(change.kind)) return `The change at ${change.path} has an unknown kind.`;
    if (typeof change.underGit !== 'boolean') return `The change at ${change.path} does not say whether it is under .git.`;
    // add has only a new entry, delete only an old one, every other kind both.
    const needsOld = change.kind !== 'add', needsNew = change.kind !== 'delete';
    if ((needsOld && !TYPES.has(change.oldType as string)) || (!needsOld && change.oldType !== undefined)) return `The change at ${change.path} has an invalid old entry type.`;
    if ((needsNew && !TYPES.has(change.newType as string)) || (!needsNew && change.newType !== undefined)) return `The change at ${change.path} has an invalid new entry type.`;
    if (change.newType === 'symlink' && typeof change.newLinkTarget !== 'string') return `The link at ${change.path} has no target.`;
    if (change.linkTargetTraversesLink !== undefined && typeof change.linkTargetTraversesLink !== 'boolean') return `The link at ${change.path} has an invalid traversal flag.`;
    // Only `path` is saved (in the result's scope lists and a checkpoint), so only it counts, as the JSON that stores it.
    bytes += Buffer.byteLength(JSON.stringify(change.path)) + 1;
  }
  if (bytes > MAX_PATH_BYTES) return 'The change report is too large to audit.';
  return null;
}

/** A stored link target must stay inside the repo, outside `.git`, without an absolute path. */
function unsafeLinkTarget(linkPath: string, target: string): string | null {
  if (!target || target.includes('\0')) return 'empty or invalid target';
  if (target.startsWith('/')) return 'absolute target';
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (resolved === '..' || resolved.startsWith('../')) return 'target leaves the repository';
  if (resolved === '.git' || resolved.startsWith('.git/')) return 'target enters .git';
  return null;
}

/**
 * The post-run audit (docs/plan-format.md, "After each run"). Safety violations are checked first and take precedence
 * over scope: an unsafe change never enters the out-of-scope commit path. Scope uses the trusted path identity.
 */
export function auditRun(item: PlanItem, manifest: ChangeManifest, pathKey: (path: string) => string): AuditOutcome {
  const violations: string[] = [];
  if (!Array.isArray(manifest?.changes) || manifest.changes.length > MAX_CHANGES) return { kind: 'violation', violations: ['The change report is missing or too large to audit.'] };
  const problem = malformed(manifest);
  if (problem) return { kind: 'violation', violations: [problem] };
  if (manifest.metadataChanged) violations.push('The agent changed Git metadata under .git.');
  // Agents never commit: the metadata volume is read-only to them, so any agent commit is a violation, never undone (#66).
  if (manifest.agentCommits.length) violations.push(`The agent made its own commits: ${manifest.agentCommits.slice(0, 5).join(', ')}.`);
  for (const path of manifest.linkTargetChanges) violations.push(`A declared symlink target changed: ${path}.`);
  for (const path of manifest.nestedGitlinkContent) violations.push(`Content appeared under a gitlink: ${path}.`);
  const declared = new Set(item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]).map(pathKey));
  for (const change of manifest.changes) {
    const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    // A path must be in canonical form: another spelling (./, a/../, //, a trailing /) could reach .git or hide a match.
    if (paths.some(path => path !== posix.normalize(path) || path.endsWith('/') || path.startsWith('./')))
      { violations.push(`Path not in canonical form in the change report: ${change.path}.`); continue; }
    // Git refuses a .git part of any case at any depth, so the audit does too.
    if (change.underGit || paths.some(path => path.split('/').some((part: string) => part.toLowerCase() === '.git'))) { violations.push(`The agent changed ${change.path} under .git.`); continue; }
    if (paths.some(path => path.startsWith('/') || posix.normalize(path).startsWith('../') || ['.', '..'].includes(posix.normalize(path)) || path.includes('\0')))
      { violations.push(`Invalid path in the change report: ${change.path}.`); continue; }
    if (change.oldType === 'gitlink' || change.newType === 'gitlink') { violations.push(`Plan items cannot change gitlinks: ${change.path}.`); continue; }
    if (change.newType === 'symlink') {
      if (change.oldType !== 'symlink') { violations.push(`New symlink or file-to-symlink conversion: ${change.path}.`); continue; }
      if (!declared.has(pathKey(change.path))) { violations.push(`A pre-existing symlink changed at an undeclared path: ${change.path}.`); continue; }
      const unsafe = unsafeLinkTarget(change.path, change.newLinkTarget ?? '');
      if (unsafe) { violations.push(`Unsafe symlink target at ${change.path}: ${unsafe}.`); continue; }
      if (change.linkTargetTraversesLink !== false) { violations.push(`The symlink target at ${change.path} traverses another link, or was not checked.`); continue; }
    }
    for (const type of [change.oldType, change.newType]) if (type === 'directory' || type === 'other') violations.push(`Unexpected ${type} entry: ${change.path}.`);
  }
  if (violations.length) return { kind: 'violation', violations };
  const inScope: string[] = [], outOfScope: string[] = [];
  for (const change of manifest.changes) {
    const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    (paths.every(path => declared.has(pathKey(path))) ? inScope : outOfScope).push(change.path);
  }
  return { kind: 'commit', inScope, outOfScope, unchanged: manifest.changes.length === 0, needsAmendment: outOfScope.length > 0 };
}

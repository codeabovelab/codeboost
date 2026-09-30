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
/**
 * Whether a path part names Git's metadata directory in any spelling Git itself refuses (read-cache.c, verify_path):
 * any case; on NTFS with trailing dots or spaces and as the 8.3 short name `git~1`; on HFS with ignorable code points.
 */
export function isDotGit(part: string): boolean {
  // NTFS ends a name at a stream separator (`:`), then drops trailing dots and spaces. Callers split on `\` as well
  // as `/`, since NTFS reads a backslash as a directory separator.
  const name = part.split(':')[0]!;
  const plain = name.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '');
  return plain === '.git' || plain === 'git~1';
}
/** Agent-controlled text in a finding is quoted (AGENTS.md), and each list is cut short, so a reason stays readable. */
const q = (text: string) => JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}…` : text);
const list = (items: readonly string[]) => items.slice(0, 5).map(q).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '');
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
    if (change.kind === 'rename' ? typeof change.oldPath !== 'string' || !change.oldPath : change.oldPath !== undefined) return `The change at ${q(change.path)} has an invalid old path.`;
    if (!KINDS.has(change.kind)) return `The change at ${q(change.path)} has an unknown kind.`;
    if (typeof change.underGit !== 'boolean') return `The change at ${q(change.path)} does not say whether it is under .git.`;
    // add has only a new entry, delete only an old one, every other kind both.
    const needsOld = change.kind !== 'add', needsNew = change.kind !== 'delete';
    if ((needsOld && !TYPES.has(change.oldType as string)) || (!needsOld && change.oldType !== undefined)) return `The change at ${q(change.path)} has an invalid old entry type.`;
    if ((needsNew && !TYPES.has(change.newType as string)) || (!needsNew && change.newType !== undefined)) return `The change at ${q(change.path)} has an invalid new entry type.`;
    if (change.newType === 'symlink' && typeof change.newLinkTarget !== 'string') return `The link at ${q(change.path)} has no target.`;
    if (change.linkTargetTraversesLink !== undefined && typeof change.linkTargetTraversesLink !== 'boolean') return `The link at ${q(change.path)} has an invalid traversal flag.`;
    // Both paths can be saved (an undeclared rename source is a scope finding), measured as the JSON that stores them.
    for (const path of [change.path, ...(change.oldPath ? [change.oldPath] : [])]) bytes += Buffer.byteLength(JSON.stringify(path)) + 1;
  }
  if (bytes > MAX_PATH_BYTES) return 'The change report is too large to audit.';
  return null;
}

/** A stored link target must stay inside the repo, outside `.git`, without an absolute path. */
function unsafeLinkTarget(linkPath: string, target: string): string | null {
  if (!target || target.includes('\0')) return 'empty or invalid target';
  if (target.startsWith('/')) return 'absolute target';
  // A trailing slash names the same directory: `./` and `a/../` are the root, like `.`.
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target)).replace(/\/+$/, '') || '.';
  if (resolved === '..' || resolved.startsWith('../')) return 'target leaves the repository';
  // The repository root contains .git: a link to it reaches the metadata through one more path part.
  if (resolved === '.') return 'target is the repository root';
  // As for paths: Git's metadata is `.git` in any case, at any depth.
  if (resolved.split(/[/\\]/).some(isDotGit)) return 'target enters .git';
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
  if (manifest.agentCommits.length) violations.push(`The agent made its own commits: ${list(manifest.agentCommits)}.`);
  if (manifest.linkTargetChanges.length) violations.push(`A declared symlink target changed: ${list(manifest.linkTargetChanges)}.`);
  if (manifest.nestedGitlinkContent.length) violations.push(`Content appeared under a gitlink: ${list(manifest.nestedGitlinkContent)}.`);
  const declared = new Set(item.files.flatMap(file => [file.path, ...(file.renamed_from ? [file.renamed_from] : [])]).map(pathKey));
  // Each path appears once, under the trusted path identity: two entries for one path contradict each other.
  const seen = new Map<string, ManifestChange[]>();
  for (const change of manifest.changes) {
    // A case-only rename's two sides are one path under a folding identity; count it once for this change.
    const keys = new Set([change.path, ...(change.oldPath ? [change.oldPath] : [])].map(pathKey));
    for (const key of keys) {
      const entries = [...(seen.get(key) ?? []), change];
      seen.set(key, entries);
      if (entries.length === 1) continue;
      // The only second entry allowed is a case-only rename that Git reports as one delete and one add (the file also
      // changed a lot): exactly two entries, one delete and one add, with different spellings.
      const [a, b] = entries as [ManifestChange, ManifestChange];
      const splitRename = entries.length === 2 && a.path !== b.path && [a.kind, b.kind].sort().join() === 'add,delete';
      if (!splitRename) return { kind: 'violation', violations: [`The change report lists ${q(key)} more than once.`] };
    }
  }
  for (const change of manifest.changes) {
    const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    // A path must be in canonical form: another spelling (./, a/../, //, a trailing /) could reach .git or hide a match.
    if (paths.some(path => path !== posix.normalize(path) || path.endsWith('/') || path.startsWith('./')))
      { violations.push(`Path not in canonical form in the change report: ${q(change.path)}.`); continue; }
    // Git refuses a .git part in any spelling it treats as .git, at any depth, so the audit does too.
    if (change.underGit || paths.some(path => path.split(/[/\\]/).some(isDotGit))) { violations.push(`The agent changed ${q(change.path)} under .git.`); continue; }
    if (paths.some(path => path.startsWith('/') || posix.normalize(path).startsWith('../') || ['.', '..'].includes(posix.normalize(path)) || path.includes('\0')))
      { violations.push(`Invalid path in the change report: ${q(change.path)}.`); continue; }
    if (change.oldType === 'gitlink' || change.newType === 'gitlink') { violations.push(`Plan items cannot change gitlinks: ${q(change.path)}.`); continue; }
    // Only a declared pre-existing link may change at all: deleting it, turning it into a file, or renaming it from an
    // undeclared path is a link change too.
    if (change.oldType === 'symlink' && !declared.has(pathKey(change.oldPath ?? change.path)))
      { violations.push(`A pre-existing symlink was changed at an undeclared path: ${q(change.oldPath ?? change.path)}.`); continue; }
    if (change.newType === 'symlink') {
      if (change.oldType !== 'symlink') { violations.push(`New symlink or file-to-symlink conversion: ${q(change.path)}.`); continue; }
      if (!declared.has(pathKey(change.path))) { violations.push(`A pre-existing symlink changed at an undeclared path: ${q(change.path)}.`); continue; }
      const unsafe = unsafeLinkTarget(change.path, change.newLinkTarget ?? '');
      if (unsafe) { violations.push(`Unsafe symlink target at ${q(change.path)}: ${unsafe}.`); continue; }
      if (change.linkTargetTraversesLink !== false) { violations.push(`The symlink target at ${q(change.path)} traverses another link, or was not checked.`); continue; }
    }
    for (const type of [change.oldType, change.newType]) if (type === 'directory' || type === 'other') violations.push(`Unexpected ${type} entry: ${q(change.path)}.`);
  }
  if (violations.length) return { kind: 'violation', violations };
  const inScope: string[] = [], outOfScope: string[] = [];
  for (const change of manifest.changes) {
    const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    const undeclared = paths.filter(path => !declared.has(pathKey(path)));
    // Each undeclared path is the scope finding itself, a rename's source included: never only the declared other side.
    if (undeclared.length) outOfScope.push(...undeclared); else inScope.push(change.path);
  }
  return { kind: 'commit', inScope, outOfScope, unchanged: manifest.changes.length === 0, needsAmendment: outOfScope.length > 0 };
}

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationInput, Phase } from '../contract.ts';

export interface TaskFilesystems {
  readonly keeper: string;
  readonly workVolume: string;
  readonly metadataVolume: string;
  readonly workBytes: number;
  readonly workInodes: number;
  readonly metadataBytes: number;
  readonly metadataInodes: number;
}
export interface ContainerProfile {
  readonly name: string;
  readonly args: readonly string[];
  readonly expectedImage: string;
  readonly phase: Phase;
  readonly vendor: 'claude' | 'codex';
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly codexAuthFile?: string;
  readonly command: readonly string[];
}
export interface ProfileOptions {
  readonly invocation: InvocationInput;
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly command: readonly string[];
  readonly imageId: string;
  readonly codexAuthFile?: string;
  readonly claudeToken?: string;
}

interface FileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly digest: string;
}
interface ProfileIdentity { readonly inputDirectory: string; readonly schema: FileIdentity; readonly auth?: FileIdentity;
  readonly cleanupDirectory?: string }
const identities = new WeakMap<ContainerProfile, ProfileIdentity>();

const readCapturedFile = (path: string, kind: string): { identity: FileIdentity; content: Buffer } => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024)
      throw new Error(`${kind} must be a bounded, unlinked regular file.`);
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`${kind} changed while its identity was captured.`);
    const identity = Object.freeze({ path, dev: after.dev, ino: after.ino, mode: after.mode, nlink: after.nlink,
      size: after.size, mtimeMs: after.mtimeMs, digest: createHash('sha256').update(content).digest('hex') });
    return { identity, content };
  } finally { if (fd !== undefined) closeSync(fd); }
};
const captureFile = (path: string, kind: string) => readCapturedFile(path, kind).identity;
const sameFile = (actual: FileIdentity, expected: FileIdentity) => actual.path === expected.path
  && actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode
  && actual.nlink === expected.nlink && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs
  && actual.digest === expected.digest;
const captureInput = (directory: string): ProfileIdentity => {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o005) !== 0o005)
    throw new Error('Schema input directory must be a container-readable real directory.');
  const canonical = mountSource(realpathSync(directory), 'Schema input');
  const entries = readdirSync(canonical);
  if (entries.length !== 1 || entries[0] !== 'schema.json')
    throw new Error('Schema input must contain only one bounded, unlinked regular schema.json file.');
  const schema = captureFile(`${canonical}/schema.json`, 'Schema input');
  if ((schema.mode & 0o004) === 0) throw new Error('Schema input must be container-readable.');
  return Object.freeze({ inputDirectory: canonical, schema });
};

/** Internal authenticity and host-file revalidation used at every launch boundary. */
export function assertContainerProfile(profile: ContainerProfile): void {
  const expected = identities.get(profile);
  if (!expected) throw new Error('Container profile was not created by the trusted profile builder.');
  const actual = captureInput(expected.inputDirectory);
  if (actual.inputDirectory !== expected.inputDirectory || !sameFile(actual.schema, expected.schema))
    throw new Error('Schema input changed after the profile was captured.');
  if (expected.auth) {
    const auth = captureFile(expected.auth.path, 'Codex auth');
    if (!sameFile(auth, expected.auth)) throw new Error('Codex auth changed after the profile was captured.');
  }
}

/** Remove runner-owned credential staging after this one-shot profile settles. */
export function disposeContainerProfile(profile: ContainerProfile): void {
  const identity = identities.get(profile);
  if (!identity) return;
  identities.delete(profile);
  if (identity.cleanupDirectory) rmSync(identity.cleanupDirectory, { recursive: true, force: true });
}

const safeName = (value: string) => {
  const prefix = value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 24);
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
};
const mount = (parts: Record<string, string | boolean>) => Object.entries(parts)
  .map(([key, value]) => value === true ? key : `${key}=${value}`).join(',');
const mountSource = (path: string, kind: string) => {
  if (!path || /[\0\n,]/.test(path)) throw new Error(`${kind} path cannot be represented as a Docker mount.`);
  return path;
};

export function createContainerProfile(options: ProfileOptions): ContainerProfile {
  const { invocation, filesystems } = options;
  if (!options.command.length || options.command.some(value => typeof value !== 'string' || value.includes('\0')))
    throw new Error('Container command must be a complete literal argv array.');
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId))
    throw new Error('Container profile requires the immutable built image ID.');
  const inputIdentity = captureInput(options.inputDirectory);
  const inputDirectory = inputIdentity.inputDirectory;
  if (invocation.vendor === 'codex' && (!options.codexAuthFile || options.claudeToken))
    throw new Error('Codex requires only its auth file.');
  if (invocation.vendor === 'claude' && (!options.claudeToken || options.codexAuthFile))
    throw new Error('Claude requires only its OAuth token.');
  if (options.claudeToken?.includes('\0')) throw new Error('Claude OAuth token is malformed.');
  if (!/^codeboost-work-[0-9a-f-]+$/.test(filesystems.workVolume)
    || !/^codeboost-metadata-[0-9a-f-]+$/.test(filesystems.metadataVolume)
    || !/^codeboost-keeper-[0-9a-f-]+$/.test(filesystems.keeper)) throw new Error('Task filesystem identity is invalid.');
  if (options.codexAuthFile && !lstatSync(options.codexAuthFile).isFile())
    throw new Error('Codex auth must be a direct regular file, not a link.');
  const sourceAuth = options.codexAuthFile ? readCapturedFile(realpathSync(options.codexAuthFile), 'Codex auth') : undefined;
  let cleanupDirectory: string | undefined, codexAuthFile: string | undefined, authIdentity: FileIdentity | undefined;
  if (sourceAuth) {
    cleanupDirectory = mkdtempSync(join(tmpdir(), 'codeboost-auth-'));
    try {
      const stagedAuth = join(cleanupDirectory, 'auth.json');
      writeFileSync(stagedAuth, sourceAuth.content, { mode: 0o400, flag: 'wx' });
      chmodSync(stagedAuth, 0o444);
      codexAuthFile = mountSource(realpathSync(stagedAuth), 'Codex auth');
      authIdentity = captureFile(codexAuthFile, 'Staged Codex auth');
    } catch (error) {
      rmSync(cleanupDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const name = `codeboost-agent-${safeName(invocation.attemptId)}`;
  const readOnlyWork = ['planning', 'questions', 'review'].includes(invocation.phase);
  const args = ['create', '--name', name, '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1',
    '--network=none', '--env', 'HOME=/home/codeboost', '--env', `CODEBOOST_PHASE=${invocation.phase}`,
    '--env', `CODEBOOST_VENDOR=${invocation.vendor}`, '--env', 'npm_config_cache=/tmp/npm-cache',
    '--env', `CODEBOOST_WORK_BYTES=${filesystems.workBytes}`, '--env', `CODEBOOST_WORK_INODES=${filesystems.workInodes}`,
    '--env', `CODEBOOST_METADATA_BYTES=${filesystems.metadataBytes}`, '--env', `CODEBOOST_METADATA_INODES=${filesystems.metadataInodes}`,
    '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=33554432,nr_inodes=4096,mode=1777',
    '--tmpfs', '/home/codeboost:rw,nosuid,nodev,size=1048576,nr_inodes=128,uid=10001,gid=10001,mode=0700',
    '--mount', mount({ type: 'volume', source: filesystems.workVolume, target: '/work', readonly: readOnlyWork }),
    '--mount', mount({ type: 'volume', source: filesystems.metadataVolume, target: '/work/.git', readonly: true }),
    '--mount', mount({ type: 'bind', source: inputDirectory, target: '/run/codeboost-input', readonly: true })];
  if (invocation.vendor === 'codex') {
    args.push('--env', 'CODEX_HOME=/run/codeboost-auth/codex',
      '--tmpfs', '/run/codeboost-auth/codex:rw,nosuid,nodev,size=4194304,nr_inodes=256,uid=10001,gid=10001,mode=0700',
      '--mount', mount({ type: 'bind', source: codexAuthFile!, target: '/run/codeboost-auth/codex/auth.json', readonly: true }));
  } else args.push('--env', 'CLAUDE_CODE_OAUTH_TOKEN');
  args.push(options.imageId, ...options.command);
  const capturedFilesystems = Object.freeze({ ...filesystems });
  const profile = Object.freeze({ name, args: Object.freeze(args), expectedImage: options.imageId,
    phase: invocation.phase, vendor: invocation.vendor,
    filesystems: capturedFilesystems, inputDirectory, codexAuthFile,
    command: Object.freeze([...options.command]) });
  identities.set(profile, Object.freeze({ ...inputIdentity, auth: authIdentity, cleanupDirectory }));
  return profile;
}

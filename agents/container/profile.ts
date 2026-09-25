import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCapturedInvocation, type InvocationInput, type Phase } from '../contract.ts';
import { assertBuiltAgentImage } from './image.ts';
import { assertTaskFilesystems, type TaskFilesystems } from './storage.ts';
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
  readonly ownershipId: string;
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
  readonly cleanupDirectories: readonly string[]; readonly filesystems: TaskFilesystems;
  readonly clone: InvocationInput['clone']; readonly deadline: number }
type InputIdentity = Pick<ProfileIdentity, 'inputDirectory' | 'schema'>;
interface InputCapture extends InputIdentity { readonly content: Buffer }
const identities = new WeakMap<ContainerProfile, ProfileIdentity>();
const removeOwnedDirectory = (directory: string) => {
  if (!lstatSync(directory, { throwIfNoEntry: false })) return;
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
};
const removeOwnedDirectories = (directories: readonly string[]) => {
  const failures: unknown[] = [];
  for (const directory of directories) {
    try { removeOwnedDirectory(directory); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Profile snapshot cleanup did not settle.');
};

const readCapturedFile = (path: string, kind: string): { identity: FileIdentity; content: Buffer } => {
  let fd: number | undefined;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${kind} must be a direct regular file, not a link.`);
      throw error;
    }
    const before = fstatSync(fd);
    const maximum = 1024 * 1024;
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
      throw new Error(`${kind} must be a bounded, unlinked regular file.`);
    const bounded = Buffer.allocUnsafe(maximum + 1);
    let length = 0, count = 0;
    do {
      count = readSync(fd, bounded, length, bounded.length - length, null);
      length += count;
    } while (count > 0 && length < bounded.length);
    if (length > maximum) throw new Error(`${kind} exceeds its maximum size.`);
    const content = bounded.subarray(0, length);
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
const captureInput = (directory: string): InputCapture => {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o005) !== 0o005)
    throw new Error('Schema input directory must be a container-readable real directory.');
  const canonical = mountSource(realpathSync(directory), 'Schema input');
  const entries = readdirSync(canonical);
  if (entries.length !== 1 || entries[0] !== 'schema.json')
    throw new Error('Schema input must contain only one bounded, unlinked regular schema.json file.');
  const captured = readCapturedFile(`${canonical}/schema.json`, 'Schema input'), schema = captured.identity;
  if ((schema.mode & 0o004) === 0) throw new Error('Schema input must be container-readable.');
  return Object.freeze({ inputDirectory: canonical, schema, content: captured.content });
};

/** Internal authenticity and host-file revalidation used at every launch boundary. */
export function assertContainerProfile(profile: ContainerProfile): void {
  const expected = identities.get(profile);
  if (!expected) throw new Error('Container profile was not created by the trusted profile builder.');
  assertTaskFilesystems(expected.filesystems, expected.clone);
  const actual = captureInput(expected.inputDirectory);
  if (actual.inputDirectory !== expected.inputDirectory || !sameFile(actual.schema, expected.schema))
    throw new Error('Schema input changed after the profile was captured.');
  if (expected.auth) {
    const auth = captureFile(expected.auth.path, 'Codex auth');
    if (!sameFile(auth, expected.auth)) throw new Error('Codex auth changed after the profile was captured.');
  }
}

/** Clamp a Docker budget to the captured invocation deadline, which no launch may outlive. */
export function profileTimeout(profile: ContainerProfile, timeoutMs: number, now = Date.now()): number {
  const expected = identities.get(profile);
  if (!expected) throw new Error('Container profile was not created by the trusted profile builder.');
  const left = Math.floor(expected.deadline - now);
  if (left < 1) throw new Error('Invocation deadline has passed.');
  return Math.min(timeoutMs, left);
}

/** Remove runner-owned credential staging after this one-shot profile settles. */
export function disposeContainerProfile(profile: ContainerProfile): void {
  const identity = identities.get(profile);
  if (!identity) return;
  removeOwnedDirectories(identity.cleanupDirectories);
  identities.delete(profile);
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
  // Phase, vendor and deadline drive mount modes and credentials, so they must come from a captured request.
  assertCapturedInvocation(invocation);
  if (!options.command.length || options.command.some(value => typeof value !== 'string' || value.includes('\0')))
    throw new Error('Container command must be a complete literal argv array.');
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId))
    throw new Error('Container profile requires the immutable built image ID.');
  assertBuiltAgentImage(options.imageId);
  assertTaskFilesystems(filesystems, invocation.clone);
  const sourceInput = captureInput(options.inputDirectory);
  if (invocation.vendor === 'codex' && (!options.codexAuthFile || options.claudeToken))
    throw new Error('Codex requires only its auth file.');
  if (invocation.vendor === 'claude' && (!options.claudeToken || options.codexAuthFile))
    throw new Error('Claude requires only its OAuth token.');
  if (options.claudeToken?.includes('\0')) throw new Error('Claude OAuth token is malformed.');
  if (!/^codeboost-work-[0-9a-f-]+$/.test(filesystems.workVolume)
    || !/^codeboost-metadata-[0-9a-f-]+$/.test(filesystems.metadataVolume)
    || !/^codeboost-keeper-[0-9a-f-]+$/.test(filesystems.keeper)) throw new Error('Task filesystem identity is invalid.');
  // Read through one no-follow descriptor so the path cannot be swapped between check and open.
  const sourceAuth = options.codexAuthFile ? readCapturedFile(options.codexAuthFile, 'Codex auth') : undefined;
  const cleanupDirectories: string[] = [];
  let codexAuthFile: string | undefined, authIdentity: FileIdentity | undefined;
  try {
    const inputDirectory = mkdtempSync(join(tmpdir(), 'codeboost-input-'));
    cleanupDirectories.push(inputDirectory);
    writeFileSync(join(inputDirectory, 'schema.json'), sourceInput.content,
      { mode: 0o400, flag: 'wx' });
    chmodSync(join(inputDirectory, 'schema.json'), 0o444);
    chmodSync(inputDirectory, 0o555);
    const inputIdentity = captureInput(inputDirectory);
    if (sourceAuth) {
      const cleanupDirectory = mkdtempSync(join(tmpdir(), 'codeboost-auth-'));
      cleanupDirectories.push(cleanupDirectory);
      const stagedAuth = join(cleanupDirectory, 'auth.json');
      writeFileSync(stagedAuth, sourceAuth.content, { mode: 0o400, flag: 'wx' });
      chmodSync(stagedAuth, 0o444);
      codexAuthFile = mountSource(realpathSync(stagedAuth), 'Codex auth');
      authIdentity = captureFile(codexAuthFile, 'Staged Codex auth');
    }
    const name = `codeboost-agent-${safeName(invocation.attemptId)}`, ownershipId = randomUUID();
    const readOnlyWork = ['planning', 'questions', 'review'].includes(invocation.phase);
    const args = ['create', '--name', name, '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--pids-limit=128', '--memory=512m', '--memory-swap=512m',
      '--cpus=1', '--shm-size=16m', '--ipc=private', '--cgroupns=private',
      '--network=none', '--env', 'HOME=/home/codeboost', '--env', `CODEBOOST_PHASE=${invocation.phase}`,
      '--label', `io.codeboost.invocation=${ownershipId}`,
      '--env', `CODEBOOST_VENDOR=${invocation.vendor}`, '--env', 'npm_config_cache=/tmp/npm-cache',
      '--env', `CODEBOOST_WORK_BYTES=${filesystems.workBytes}`, '--env', `CODEBOOST_WORK_INODES=${filesystems.workInodes}`,
      '--env', `CODEBOOST_METADATA_BYTES=${filesystems.metadataBytes}`, '--env', `CODEBOOST_METADATA_INODES=${filesystems.metadataInodes}`,
      '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=33554432,nr_inodes=4096,mode=1777',
      '--tmpfs', '/home/codeboost:rw,nosuid,nodev,size=1048576,nr_inodes=128,uid=10001,gid=10001,mode=0700',
      '--mount', mount({ type: 'volume', source: filesystems.workVolume, target: '/work', readonly: readOnlyWork }),
      '--mount', mount({ type: 'volume', source: filesystems.metadataVolume, target: '/work/.git', readonly: true }),
      '--mount', mount({ type: 'bind', source: inputIdentity.inputDirectory, target: '/run/codeboost-input', readonly: true })];
    if (invocation.vendor === 'codex') {
      args.push('--env', 'CODEX_HOME=/run/codeboost-auth/codex',
        '--tmpfs', '/run/codeboost-auth/codex:rw,nosuid,nodev,size=4194304,nr_inodes=256,uid=10001,gid=10001,mode=0700',
        '--mount', mount({ type: 'bind', source: codexAuthFile!, target: '/run/codeboost-auth/codex/auth.json', readonly: true }));
    } else args.push('--env', 'CLAUDE_CODE_OAUTH_TOKEN');
    args.push(options.imageId, ...options.command);
    const capturedFilesystems = filesystems;
    const profile = Object.freeze({ name, args: Object.freeze(args), expectedImage: options.imageId,
      phase: invocation.phase, vendor: invocation.vendor,
      filesystems: capturedFilesystems, inputDirectory: inputIdentity.inputDirectory, codexAuthFile,
      command: Object.freeze([...options.command]), ownershipId });
    identities.set(profile, Object.freeze({ inputDirectory: inputIdentity.inputDirectory, schema: inputIdentity.schema,
      auth: authIdentity,
      cleanupDirectories: Object.freeze([...cleanupDirectories]), filesystems, clone: invocation.clone,
      deadline: invocation.deadline }));
    return profile;
  } catch (error) {
    try { removeOwnedDirectories(cleanupDirectories); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Profile creation and cleanup both failed.'); }
    throw error;
  }
}

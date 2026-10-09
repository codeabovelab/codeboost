import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assertCapturedInvocation, type InvocationInput, type Phase, type UnreleasedResource } from '../contract.ts';
import { assertBuiltAgentImage } from './image.ts';
import { assertTaskFilesystems, taskFilesystemOwner, type TaskFilesystems } from './storage.ts';
import { gitlinkParents, useTaskTreeCheck, type TaskTreeCheck } from './changes.ts';
import { ownerLabelArgs, type ResourceOwner } from '../labels.ts';
import { assertVendorNetwork, removeVendorNetwork, vendorNetworkResources,
  type VendorNetwork } from '../network/network.ts';
import { assertAgentCommand, assertCommandSchema, assertPhasePolicy, type AgentCommand, type PhasePolicy } from '../policy.ts';
import type { ProcessGroupLifecycle } from '../tracked-docker.ts';
export interface ContainerProfile {
  readonly name: string;
  readonly args: readonly string[];
  readonly expectedImage: string;
  readonly phase: Phase;
  readonly vendor: InvocationInput['vendor'];
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly codexAuthFile?: string;
  readonly command: readonly string[];
  readonly ownershipId: string;
  readonly network: VendorNetwork;
  readonly policy: PhasePolicy;
  readonly deferredOutput: boolean;
  /** Execute and fix: every gitlink path, each covered by an empty read-only tmpfs. Empty in read-only phases. */
  readonly gitlinks: readonly string[];
  /** Execute and fix: every directory above a gitlink below the top level, each remounted from the work volume (#99). */
  readonly gitlinkParents: readonly string[];
}
export interface ProfileOptions {
  readonly invocation: InvocationInput;
  readonly filesystems: TaskFilesystems;
  readonly inputDirectory: string;
  readonly command: AgentCommand;
  readonly imageId: string;
  readonly codexAuthFile?: string;
  readonly claudeToken?: string;
  readonly network: VendorNetwork;
  readonly policy: PhasePolicy;
  readonly deferredOutput?: boolean;
  /**
   * Execute and fix only, and required there: what `checkTaskTree` returned for these filesystems at the clone's head,
   * just before this launch. Each check serves one profile.
   */
  readonly treeCheck?: TaskTreeCheck;
  /** Remaining invocation budget for Docker-backed profile validation. */
  readonly timeoutMs?: number;
  /** Trusted monotonic budget carried from adapter admission. */
  readonly invocationBudget?: () => number;
  /** Cancels creation; whatever was staged is removed before the promise rejects. */
  readonly signal?: AbortSignal;
  /** Optional owner-only plain directory beneath which temporary profile snapshots are created. */
  readonly cleanupRoot?: string;
  /** Durable ownership for Docker clients used during cleanup. */
  readonly processLifecycle?: ProcessGroupLifecycle;
}

export class ProfileCreationCleanupError extends AggregateError {
  readonly startupError: unknown;
  /** Retry the cleanup; `budgetMs` (default 30 s) bounds the network removal. */
  readonly retryCleanup: (budgetMs?: number) => Promise<void>;
  readonly #resources: () => readonly UnreleasedResource[];

  constructor(startupError: unknown, cleanupError: unknown, retryCleanup: (budgetMs?: number) => Promise<void>,
    resources: () => readonly UnreleasedResource[] = () => []) {
    super([startupError, cleanupError], 'Profile creation and cleanup both failed.');
    this.startupError = startupError;
    this.retryCleanup = retryCleanup;
    this.#resources = resources;
  }
  /** The staging directories and network this creation may still have left behind, as of now. */
  get resources(): readonly UnreleasedResource[] { return this.#resources(); }
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
  readonly clone: InvocationInput['clone']; readonly deadline: number; readonly network: VendorNetwork;
  readonly invocationBudget?: () => number; readonly policy: PhasePolicy; readonly invocation: InvocationInput }
type InputIdentity = Pick<ProfileIdentity, 'inputDirectory' | 'schema'>;
interface InputCapture extends InputIdentity { readonly content: Buffer }
const identities = new WeakMap<ContainerProfile, ProfileIdentity>();
const claimedNetworks = new WeakSet<VendorNetwork>();
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

/**
 * Read a regular, unlinked file through one no-follow descriptor, so the path cannot be swapped between check and
 * read. `O_NONBLOCK` makes a FIFO fail the regular-file check instead of blocking the open.
 */
export const readCapturedFile = (path: string, kind: string, maximum = 1024 * 1024):
  { identity: FileIdentity; content: Buffer } => {
  let fd: number | undefined;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${kind} must be a direct regular file, not a link.`);
      throw error;
    }
    const before = fstatSync(fd);
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

/** The labels on an invocation's agent container: its runner and attempt, and the task-storage allocation it mounts. */
export function agentContainerOwner(invocation: InvocationInput, filesystems: TaskFilesystems): ResourceOwner {
  return Object.freeze({ runnerOwner: invocation.runnerOwner, attemptId: invocation.attemptId,
    allocationId: taskFilesystemOwner(filesystems).allocationId });
}

/** Prove that a profile object is the exact capability issued by this module. */
export function assertContainerProfileAuthenticity(profile: ContainerProfile): void {
  if (!identities.has(profile)) throw new Error('Container profile was not created by the trusted profile builder.');
}

export function isContainerProfileAuthentic(profile: ContainerProfile): boolean {
  return identities.has(profile);
}

/** Internal authenticity and host-file revalidation used at every launch boundary. */
export async function assertContainerProfile(profile: ContainerProfile, timeoutMs = 30_000,
  signal?: AbortSignal, processLifecycle?: ProcessGroupLifecycle): Promise<void> {
  const expected = identities.get(profile);
  if (!expected) throw new Error('Container profile was not created by the trusted profile builder.');
  assertTaskFilesystems(expected.filesystems, expected.clone);
  // Every caller, including those using the default budget, is bounded by the invocation deadline.
  await assertVendorNetwork(expected.network, expected.invocation, profile.name, profileTimeout(profile, timeoutMs),
    signal, processLifecycle);
  assertPhasePolicy(expected.policy, expected.invocation);
  const actual = captureInput(expected.inputDirectory);
  if (actual.inputDirectory !== expected.inputDirectory || !sameFile(actual.schema, expected.schema))
    throw new Error('Schema input changed after the profile was captured.');
  if (expected.auth) {
    const auth = captureFile(expected.auth.path, 'Codex auth');
    if (!sameFile(auth, expected.auth)) throw new Error('Codex auth changed after the profile was captured.');
  }
}

/** Clamp a Docker budget to the captured monotonic budget, or the wall deadline when no budget was carried. */
export function profileTimeout(profile: ContainerProfile, timeoutMs: number, now = Date.now()): number {
  const expected = identities.get(profile);
  if (!expected) throw new Error('Container profile was not created by the trusted profile builder.');
  const left = Math.floor(expected.invocationBudget?.() ?? expected.deadline - now);
  if (!Number.isSafeInteger(left) || left < 1) throw new Error('Invocation deadline has passed.');
  return Math.min(timeoutMs, left);
}

// Never throws: this runs while a handle settles. A directory whose state cannot be read is still reported.
const directoryResources = (directories: readonly string[]) => directories.filter(directory => {
  try { return lstatSync(directory, { throwIfNoEntry: false }) !== undefined; } catch { return true; }
}).map(name => Object.freeze({ kind: 'directory' as const, name }));

/**
 * The staging directories and network a profile still owns, for reporting when their removal is not confirmed. The
 * agent container is reported separately (`agentContainerResources`), because only a create makes it this profile's.
 */
export function containerProfileResources(profile: ContainerProfile): readonly UnreleasedResource[] {
  const identity = identities.get(profile);
  if (!identity) return Object.freeze([]);
  return Object.freeze([...vendorNetworkResources(identity.network), ...directoryResources(identity.cleanupDirectories)]);
}

/** Remove runner-owned credential staging after this one-shot profile settles. */
export async function disposeContainerProfile(profile: ContainerProfile, networkTimeoutMs = 30_000,
  processLifecycle?: ProcessGroupLifecycle): Promise<void> {
  const identity = identities.get(profile);
  if (!identity) return;
  const failures: unknown[] = [];
  try { removeOwnedDirectories(identity.cleanupDirectories); } catch (error) { failures.push(error); }
  try { await removeVendorNetwork(identity.network, networkTimeoutMs, processLifecycle); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Profile resource cleanup did not settle.');
  identities.delete(profile);
}

const safeName = (value: string) => {
  const prefix = value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 24);
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
};
/** The size and mode of the empty read-only tmpfs at each gitlink path. */
export const GITLINK_MOUNT_BYTES = 4096;
export const GITLINK_MOUNT_MODE = '0555';
const mount = (parts: Record<string, string | boolean>) => Object.entries(parts)
  .map(([key, value]) => value === true ? key : `${key}=${value}`).join(',');
const mountSource = (path: string, kind: string) => {
  if (!path || /[\0\n,]/.test(path)) throw new Error(`${kind} path cannot be represented as a Docker mount.`);
  return path;
};

export async function createContainerProfile(options: ProfileOptions): Promise<ContainerProfile> {
  const { invocation, filesystems } = options;
  // Phase, vendor and deadline drive mount modes and credentials, so they must come from a captured request.
  assertCapturedInvocation(invocation);
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageId))
    throw new Error('Container profile requires the immutable built image ID.');
  assertBuiltAgentImage(options.imageId);
  assertTaskFilesystems(filesystems, invocation.clone);
  let cleanupRoot = tmpdir();
  if (options.cleanupRoot !== undefined) {
    if (!isAbsolute(options.cleanupRoot) || realpathSync(options.cleanupRoot) !== options.cleanupRoot)
      throw new Error('Profile cleanup root must be an absolute canonical directory.');
    const stat = lstatSync(options.cleanupRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
      throw new Error('Profile cleanup root must be a plain owner-only directory.');
    cleanupRoot = options.cleanupRoot;
  }
  // The storage must belong to this runner. The agent container is labelled with its own attempt and the allocation
  // it mounts, so recovery can find both from the container.
  const storageOwner = taskFilesystemOwner(filesystems);
  if (storageOwner.runnerOwner !== invocation.runnerOwner) throw new Error('Task filesystems belong to another runner.');
  const containerOwner = agentContainerOwner(invocation, filesystems);
  const invocationLeft = Math.floor(options.invocationBudget?.() ?? invocation.deadline - Date.now());
  if (!Number.isSafeInteger(invocationLeft) || invocationLeft < 1) throw new Error('Invocation deadline has passed.');
  await assertVendorNetwork(options.network, invocation, undefined, Math.min(options.timeoutMs ?? 30_000, invocationLeft),
    options.signal, options.processLifecycle);
  if (claimedNetworks.has(options.network)) throw new Error('Vendor network already belongs to another container profile.');
  // Own the network from here on, so any later failure removes it rather than leaking it.
  claimedNetworks.add(options.network);
  const cleanupDirectories: string[] = [];
  let codexAuthFile: string | undefined, authIdentity: FileIdentity | undefined;
  try {
    options.signal?.throwIfAborted();
    assertPhasePolicy(options.policy, invocation);
    const command = assertAgentCommand(options.command, options.policy, invocation.vendor);
    const sourceInput = captureInput(options.inputDirectory);
    assertCommandSchema(options.command, sourceInput.content);
    if (invocation.vendor === 'codex' && (!options.codexAuthFile || options.claudeToken))
      throw new Error('Codex requires only its auth file.');
    if (invocation.vendor === 'claude' && (!options.claudeToken || options.codexAuthFile))
      throw new Error('Claude requires only its OAuth token.');
    if (invocation.vendor === 'runner' && (options.claudeToken || options.codexAuthFile))
      throw new Error('Runner commands receive no provider credential.');
    if (options.claudeToken?.includes('\0')) throw new Error('Claude OAuth token is malformed.');
    if (!/^codeboost-work-[0-9a-f-]+$/.test(filesystems.workVolume)
      || !/^codeboost-metadata-[0-9a-f-]+$/.test(filesystems.metadataVolume)
      || !/^codeboost-keeper-[0-9a-f-]+$/.test(filesystems.keeper)) throw new Error('Task filesystem identity is invalid.');
    // Read through one no-follow descriptor so the path cannot be swapped between check and open.
    const sourceAuth = options.codexAuthFile ? readCapturedFile(options.codexAuthFile, 'Codex auth') : undefined;
    const createdInputDirectory = mkdtempSync(join(cleanupRoot, 'codeboost-input-'));
    // Own each directory immediately after creation. Every following write, chmod, canonicalization, or recapture can
    // fail, and construction cleanup must still remove or durably report the newly created staging path.
    cleanupDirectories.push(createdInputDirectory);
    const inputDirectory = realpathSync(createdInputDirectory);
    cleanupDirectories[cleanupDirectories.length - 1] = inputDirectory;
    writeFileSync(join(inputDirectory, 'schema.json'), sourceInput.content,
      { mode: 0o400, flag: 'wx' });
    chmodSync(join(inputDirectory, 'schema.json'), 0o444);
    // The agent runs as another uid and the bind mount is read-only; keep owner write permission so crash recovery can
    // remove this directory as part of its durably known parent without first trusting an unrecorded leaf path.
    chmodSync(inputDirectory, 0o755);
    const inputIdentity = captureInput(inputDirectory);
    if (sourceAuth) {
      const createdAuthDirectory = mkdtempSync(join(cleanupRoot, 'codeboost-auth-'));
      cleanupDirectories.push(createdAuthDirectory);
      const cleanupDirectory = realpathSync(createdAuthDirectory);
      cleanupDirectories[cleanupDirectories.length - 1] = cleanupDirectory;
      const stagedAuth = join(cleanupDirectory, 'auth.json');
      writeFileSync(stagedAuth, sourceAuth.content, { mode: 0o400, flag: 'wx' });
      chmodSync(stagedAuth, 0o444);
      codexAuthFile = mountSource(realpathSync(stagedAuth), 'Codex auth');
      authIdentity = captureFile(codexAuthFile, 'Staged Codex auth');
    }
    const name = `codeboost-agent-${safeName(invocation.attemptId)}`, ownershipId = randomUUID();
    const readOnlyWork = ['planning', 'questions', 'review'].includes(invocation.phase);
    // In a read-only phase nothing can be written beneath a gitlink, and no check is made. Execute and fix use theirs
    // up: the next profile needs a new check, made just before its own launch.
    if (readOnlyWork && options.treeCheck) throw new Error('Only an execute or fix profile takes a pre-launch tree check.');
    const gitlinks = readOnlyWork ? [] : useTaskTreeCheck(options.treeCheck, filesystems, invocation.clone.head);
    const parents = gitlinkParents(gitlinks);
    const args = ['create', '--name', name, '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--runtime=runc', '--pids-limit=128', '--memory=512m', '--memory-swap=512m',
      '--cpus=1', '--shm-size=16m', '--ipc=private', '--cgroupns=private',
      `--network=${options.network.name}`, '--dns=127.0.0.1', '--env', 'HOME=/home/codeboost',
      '--env', `CODEBOOST_PHASE=${invocation.phase}`,
      '--label', `io.codeboost.invocation=${ownershipId}`, ...ownerLabelArgs(containerOwner),
      '--env', `CODEBOOST_VENDOR=${invocation.vendor}`, '--env', 'npm_config_cache=/tmp/npm-cache',
      '--env', `HTTPS_PROXY=${options.network.proxyUrl}`, '--env', `HTTP_PROXY=${options.network.proxyUrl}`,
      '--env', 'NO_PROXY=localhost,127.0.0.1',
      '--env', `CODEBOOST_WORK_BYTES=${filesystems.workBytes}`, '--env', `CODEBOOST_WORK_INODES=${filesystems.workInodes}`,
      '--env', `CODEBOOST_METADATA_BYTES=${filesystems.metadataBytes}`, '--env', `CODEBOOST_METADATA_INODES=${filesystems.metadataInodes}`,
      '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=33554432,nr_inodes=4096,mode=1777',
      '--tmpfs', '/home/codeboost:rw,nosuid,nodev,size=1048576,nr_inodes=128,uid=10001,gid=10001,mode=0700',
      '--mount', mount({ type: 'volume', source: filesystems.workVolume, target: '/work', readonly: readOnlyWork }),
      '--mount', mount({ type: 'volume', source: filesystems.metadataVolume, target: '/work/.git', readonly: true }),
      '--mount', mount({ type: 'bind', source: inputIdentity.inputDirectory, target: '/run/codeboost-input', readonly: true }),
      // Each directory above a nested gitlink is a real directory: the check proved it, and nothing writes the work
      // volume between the check and this container's start (Docker would follow a link it found there). Mounting it
      // again from the work volume makes it a mountpoint, which cannot be renamed, so the gitlink's mount cannot be moved
      // aside and its path refilled during the run (#99). Docker mounts parents before children whatever the order here.
      ...parents.flatMap(path => ['--mount', mount({ type: 'volume', source: filesystems.workVolume, target: `/work/${path}`,
        'volume-subpath': path })]),
      // Each gitlink is an empty directory (the check proved it): an empty read-only tmpfs over it keeps it empty.
      ...gitlinks.flatMap(path => ['--mount', mount({ type: 'tmpfs', target: `/work/${path}`, readonly: true,
        'tmpfs-mode': GITLINK_MOUNT_MODE, 'tmpfs-size': String(GITLINK_MOUNT_BYTES) })])];
    if (options.deferredOutput) {
      if (invocation.vendor !== 'codex') throw new Error('Deferred output is available only for Codex.');
      args.push('--env', 'CODEBOOST_DEFERRED_OUTPUT=1',
        '--tmpfs', '/run/codeboost-control:rw,nosuid,nodev,noexec,size=65536,nr_inodes=16,uid=0,gid=0,mode=0711');
    }
    if (invocation.vendor === 'codex') {
      args.push('--env', 'CODEX_HOME=/run/codeboost-auth/codex',
        '--tmpfs', '/run/codeboost-output:rw,nosuid,nodev,noexec,size=20971520,nr_inodes=64,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/run/codeboost-auth/codex:rw,nosuid,nodev,size=4194304,nr_inodes=256,uid=10001,gid=10001,mode=0700',
        '--mount', mount({ type: 'bind', source: codexAuthFile!, target: '/run/codeboost-auth/codex/auth.json', readonly: true }));
    } else if (invocation.vendor === 'claude') args.push('--env', 'CLAUDE_CODE_OAUTH_TOKEN');
    args.push(options.imageId, ...command);
    const capturedFilesystems = filesystems;
    const profile = Object.freeze({ name, args: Object.freeze(args), expectedImage: options.imageId,
      phase: invocation.phase, vendor: invocation.vendor,
      filesystems: capturedFilesystems, inputDirectory: inputIdentity.inputDirectory, codexAuthFile,
      command: Object.freeze([...command]), ownershipId, network: options.network, policy: options.policy,
      deferredOutput: options.deferredOutput === true, gitlinks: Object.freeze([...gitlinks]), gitlinkParents: parents });
    identities.set(profile, Object.freeze({ inputDirectory: inputIdentity.inputDirectory, schema: inputIdentity.schema,
      auth: authIdentity,
      cleanupDirectories: Object.freeze([...cleanupDirectories]), filesystems, clone: invocation.clone,
      deadline: invocation.deadline, invocationBudget: options.invocationBudget,
      network: options.network, policy: options.policy, invocation }));
    return profile;
  } catch (error) {
    const cleanupProfileResources = async (budgetMs = 30_000) => {
      const failures: unknown[] = [];
      try { removeOwnedDirectories(cleanupDirectories); } catch (cleanupError) { failures.push(cleanupError); }
      try { await removeVendorNetwork(options.network, budgetMs, options.processLifecycle); }
      catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length) throw new AggregateError(failures, 'Profile resource cleanup did not settle.');
    };
    try { await cleanupProfileResources(); }
    catch (cleanupError) {
      throw new ProfileCreationCleanupError(error, cleanupError, cleanupProfileResources, () => Object.freeze([
        ...vendorNetworkResources(options.network), ...directoryResources(cleanupDirectories)]));
    }
    throw error;
  }
}

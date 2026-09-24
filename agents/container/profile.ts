import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import type { InvocationInput, Phase } from '../contract.ts';
import { AGENT_IMAGE } from './image.ts';

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
  readonly networkMode: 'none' | 'bridge';
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
  readonly codexAuthFile?: string;
  readonly claudeToken?: string;
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
  const inputStat = options.inputDirectory ? lstatSync(options.inputDirectory) : undefined;
  if (!inputStat?.isDirectory() || (inputStat.mode & 0o005) !== 0o005) throw new Error('Schema input directory must be container-readable.');
  const inputDirectory = mountSource(realpathSync(options.inputDirectory), 'Schema input');
  const entries = readdirSync(inputDirectory);
  const schema = entries.length === 1 && entries[0] === 'schema.json' ? lstatSync(`${inputDirectory}/schema.json`) : undefined;
  if (!schema?.isFile() || schema.isSymbolicLink() || schema.nlink !== 1 || schema.size > 1024 * 1024
    || (schema.mode & 0o004) === 0)
    throw new Error('Schema input must contain only one bounded, unlinked regular schema.json file.');
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
  const codexAuthFile = options.codexAuthFile ? mountSource(realpathSync(options.codexAuthFile), 'Codex auth') : undefined;
  if (codexAuthFile) {
    const auth = lstatSync(codexAuthFile);
    if (!auth.isFile() || auth.isSymbolicLink() || auth.size > 1024 * 1024) throw new Error('Codex auth must be a bounded regular file.');
  }
  const name = `codeboost-agent-${safeName(invocation.attemptId)}`;
  const readOnlyWork = ['planning', 'questions', 'review'].includes(invocation.phase);
  const networkMode = 'none';
  const args = ['create', '--name', name, '--read-only', '--user', '10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1',
    `--network=${networkMode}`, '--env', 'HOME=/home/codeboost', '--env', `CODEBOOST_PHASE=${invocation.phase}`,
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
  args.push(AGENT_IMAGE, ...options.command);
  const capturedFilesystems = Object.freeze({ ...filesystems });
  return Object.freeze({ name, args: Object.freeze(args), expectedImage: AGENT_IMAGE,
    phase: invocation.phase, vendor: invocation.vendor, networkMode,
    filesystems: capturedFilesystems, inputDirectory, codexAuthFile,
    command: Object.freeze([...options.command]) });
}

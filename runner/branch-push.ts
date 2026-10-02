import type { PlanIdentity } from '../core/identity.ts';
import { runInProcessGroup } from '../agents/process-group.ts';
import { GIT_OPTIONS, gitEnvironment } from '../git/clone.ts';
import { ghEnvironment } from '../github/gh-env.ts';
import type { BranchPusher } from './publish.ts';
import type { GitCallOptions, RunnerRepository } from './runner-repository.ts';

/**
 * The real push (#98): makes the task's branch on GitHub point at the task head, from the runner-owned repository. The
 * user's checkout is never read or written, and neither the user's Git config nor their credential helpers are used.
 */

/** The branch holds a commit codeboost did not make, or moved while the push ran. Nothing was pushed; a person decides. */
export class BranchPushRefused extends Error {}

export interface GitBranchPusherConfig extends Pick<GitCallOptions, 'onProcessGroup' | 'timeoutMs'> {
  /** The runner-owned repository the head is pushed from. */
  readonly repository: RunnerRepository;
  /** The `repositoryId` of every identity this pusher serves; any other is refused. */
  readonly repositoryId: string;
  /** `owner/name` on GitHub. */
  readonly remote: string;
  /**
   * The commits the task's ledger records as owned (made by codeboost). Only these may be overwritten. Read after the
   * remote branch, so a ledger written meanwhile is seen.
   */
  readonly ownedCommits: (identity: PlanIdentity) => Iterable<string>;
  /** The push URL. Default `https://<GH_HOST or github.com>/<remote>.git`. A local path is allowed, for tests. */
  readonly url?: string;
  /** The environment `gh` and Git read their allowlisted variables from. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The shape `PullRequestPublisher.branch` makes. Nothing outside `codeboost/` is ever pushed.
const BRANCH = /^codeboost\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REMOTE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+(?::[0-9]+)?$/;
// The variables whose values `gh` may authenticate with; their exact values are removed from error text.
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;
// GitHub token shapes, removed from any text that leaves this module in case a server or proxy echoed one back. No word
// boundaries: a token glued to other text (a URL, a path) is still removed.
const TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
/** `gh` acts as Git's only credential helper. The empty value first clears any helper set before it. */
export const CREDENTIAL_HELPER = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] as const;

/** The environment of the push: Git's hardened one plus what `gh` needs to authenticate. Nothing else. */
export function pushEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // gitEnvironment last: its config isolation (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM) wins over anything from gh's list.
  return { ...ghEnvironment(source), ...gitEnvironment(), PATH: source.PATH };
}

export function pushUrl(remote: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!REMOTE.test(remote) || remote.split('/').some(part => part === '.' || part === '..')) throw new Error('The repository must be owner/name.');
  const host = env.GH_HOST || 'github.com';
  if (!HOST.test(host)) throw new Error('GH_HOST is not a host name.');
  return `https://${host}/${remote}.git`;
}

/** Remove every configured token value and every known token shape. */
export function redact(text: string, secrets: readonly string[]): string {
  // Longest first, so a token that contains another is removed whole. A value under 8 characters is not a real token,
  // and removing it would garble ordinary words in the message.
  for (const secret of [...secrets].filter(value => value.length >= 8).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[token]');
  return text.replace(TOKEN, '[token]');
}

/**
 * The error for a failed Git call: one line, at most 400 characters of Git's output, with any token removed. `staleLease`
 * is read from the whole output, so a long message cannot hide the push's verdict.
 */
export function gitFailure(command: string, status: number | null, output: string, fallback = '', secrets: readonly string[] = []):
  Error & { staleLease: boolean; status: number | null } {
  // Redacted before it is cut, so a token across the cut cannot leave half of itself. The exact configured tokens go too:
  // an enterprise token need not have a known shape. A call that did not run to completion keeps its cause.
  const detail = redact([output, status === null ? fallback : ''].filter(Boolean).join('\n'), secrets).slice(0, 400);
  // GitHub's refusal of a push that changes a workflow without the workflow scope.
  const hint = command === 'push' && /refusing to allow [^\n]* to create or update workflow/i.test(output)
    ? ' The push changes .github/workflows, so the GitHub token needs the workflow scope.' : '';
  // Git's message can quote a path; JSON keeps it one line of printable text.
  return Object.assign(new Error(`git ${command} failed${status === null ? '' : ` (exit ${status})`}: ${JSON.stringify(detail)}${hint}`),
    { staleLease: /\[rejected\][^\n]*\(stale info\)/.test(output), status });
}

export class GitBranchPusher implements BranchPusher {
  readonly #config: GitBranchPusherConfig;
  readonly #url: string;

  constructor(config: GitBranchPusherConfig) {
    const url = config.url ?? pushUrl(config.remote, config.env);
    if (!url.startsWith('https://') && !url.startsWith('/')) throw new Error('The push URL must be https:// or a local path.');
    this.#config = config; this.#url = url;
  }

  async push(identity: PlanIdentity, input: { head: string; branch: string }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (identity.repositoryId !== this.#config.repositoryId) throw new Error('The task belongs to another repository.');
    if (!COMMIT_ID.test(input.head)) throw new Error('A full commit ID is required.');
    if (!BRANCH.test(input.branch) || input.branch.length > 255) throw new Error('Only a codeboost/ task branch can be pushed.');
    const ref = `refs/heads/${input.branch}`;
    // Git answers "<id> missing" for an absent object; any other failure (no repository, permissions) keeps Git's error.
    const found = await this.#git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], signal, false, Buffer.from(`${input.head}\n`));
    if (found === `${input.head} missing`) throw new Error(`The runner repository has no commit ${input.head}.`);
    if (found !== `${input.head} commit`) throw new Error(`${input.head} is not a commit in the runner repository.`);
    const remote = await this.#read(ref, signal);
    // Already there: a push whose outcome was lost, or a retry. Nothing to do.
    if (remote === input.head) return;
    const owned = new Set(this.#config.ownedCommits(identity));
    if (remote !== null && !owned.has(remote))
      throw new BranchPushRefused(`The branch ${input.branch} holds commit ${remote}, which codeboost did not make. Nothing was pushed.`);
    signal?.throwIfAborted();
    // The lease pins the exact value read above (empty: the branch must not exist), so GitHub refuses the push if anyone
    // moved the branch since. Only this one ref is sent: no tags, no hooks, no submodules.
    try {
      await this.#git(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no',
        `--force-with-lease=${ref}:${remote ?? ''}`, '--', this.#url, `${input.head}:${ref}`], signal, true);
    } catch (error) {
      if ((error as { staleLease?: boolean }).staleLease)
        throw new BranchPushRefused(`The branch ${input.branch} moved while codeboost pushed it. Nothing was pushed.`);
      throw error;
    }
    // A push that exits 0 does not prove the branch moved: read it back.
    const after = await this.#read(ref, signal);
    if (after !== input.head) throw new Error(`After the push, the branch ${input.branch} is at ${after ?? 'nothing'}, not ${input.head}.`);
  }

  /** The commit `ref` points at on the remote, or null when it does not exist. */
  async #read(ref: string, signal?: AbortSignal): Promise<string | null> {
    const out = await this.#git(['ls-remote', '--refs', '--', this.#url, ref], signal, true);
    // ls-remote matches patterns by their tail, so `refs/heads/x/<ref>` would match too: keep only the exact name.
    const matches = out.split('\n').filter(Boolean).map(line => line.split('\t')).filter(([, name]) => name === ref);
    if (matches.length > 1 || (matches[0] && !COMMIT_ID.test(matches[0][0]!))) throw new Error(`The remote's answer for ${ref} is malformed.`);
    return matches[0]?.[0] ?? null;
  }

  async #git(args: readonly string[], signal?: AbortSignal, remote = false, input?: Buffer): Promise<string> {
    const protocol = this.#url.startsWith('/') ? 'file' : 'https';
    const outcome = await runInProcessGroup('git', [...GIT_OPTIONS, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      ...remote ? ['-c', `protocol.${protocol}.allow=always`, ...CREDENTIAL_HELPER] : [], ...args],
    { cwd: this.#config.repository.path, env: pushEnvironment(this.#config.env), timeoutMs: this.#config.timeoutMs ?? 120_000,
      signal, onProcessGroup: this.#config.onProcessGroup, maxBuffer: 1024 * 1024, input });
    // Aborted before or while Git ran: the caller's reason (such as shutdown) is what leaves, not Git's failure.
    signal?.throwIfAborted();
    if (outcome.status !== 0) throw gitFailure(args[0]!, outcome.status, [outcome.stderr.trim(), outcome.stdout.trim()].filter(Boolean).join('\n'),
      outcome.error?.message, TOKEN_VARIABLES.flatMap(name => (this.#config.env ?? process.env)[name] ?? []));
    return outcome.stdout.trim();
  }
}

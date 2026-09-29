import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunGh } from './merge.ts';

const runFile = promisify(execFile);

export interface OpenPullRequestInput {
  base: string;
  headBranch: string;
  title: string;
  /** Must contain `marker`, so a PR whose opening outcome was lost can be found again. */
  body: string;
  draft: boolean;
  marker: string;
}
export interface OpenedPullRequest { number: number; url: string; headSha: string; draft: boolean }
export interface PullRequestGateway {
  open(input: OpenPullRequestInput, signal?: AbortSignal): Promise<OpenedPullRequest>;
  /** The open PR from `headBranch` into `base` whose description carries `marker`, or null when there is none. */
  findOpened(input: { base: string; headBranch: string; marker: string }, signal?: AbortSignal): Promise<OpenedPullRequest | null>;
  /** Replaces the title and description of an open PR codeboost opened, and marks it ready for review when `ready`. */
  refresh(number: number, input: OpenPullRequestInput & { ready: boolean }, signal?: AbortSignal): Promise<OpenedPullRequest>;
}

const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/;

/** GitHub CLI adapter for opening a task's PR. All arguments are literal argv; no shell is involved. */
export class GhPullRequestGateway implements PullRequestGateway {
  readonly repository: string;
  readonly run: RunGh;
  constructor(config: { repository: string }, run?: RunGh) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error('A GitHub repository is required to open pull requests.');
    this.repository = config.repository;
    this.run = run ?? (async (args, options) => (await runFile('gh', [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal })).stdout);
  }

  async #json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.run(args, { signal });
    try { return JSON.parse(output); }
    catch { throw new Error('GitHub returned invalid JSON.'); }
  }

  #pull(value: unknown, input: { base: string; headBranch: string }): OpenedPullRequest & { body: string } {
    const pr = value as { number?: unknown; html_url?: unknown; draft?: unknown; body?: unknown; head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null }; base?: { ref?: unknown; repo?: { full_name?: unknown } } };
    if (!pr || typeof pr !== 'object' || !Number.isSafeInteger(pr.number) || (pr.number as number) < 1 || typeof pr.html_url !== 'string' || !pr.html_url.startsWith('https://')
      || typeof pr.draft !== 'boolean' || (pr.body !== null && typeof pr.body !== 'string') || typeof pr.head?.sha !== 'string' || !SHA.test(pr.head.sha))
      throw new Error('GitHub returned an invalid pull request.');
    const same = (name: unknown) => typeof name === 'string' && name.toLowerCase() === this.repository.toLowerCase();
    if (pr.head.ref !== input.headBranch || !same(pr.head.repo?.full_name) || pr.base?.ref !== input.base || !same(pr.base.repo?.full_name))
      throw new Error('GitHub returned a pull request for a different branch.');
    return { number: pr.number as number, url: pr.html_url, headSha: pr.head.sha, draft: pr.draft, body: pr.body ?? '' };
  }

  #validate(input: { base: string; headBranch: string; marker: string }): void {
    if (!BRANCH.test(input.base) || !BRANCH.test(input.headBranch)) throw new Error('Invalid branch name.');
    if (!/^<!-- codeboost:[a-z-]+=[0-9a-f-]{36} -->$/.test(input.marker)) throw new Error('Invalid pull request marker.');
  }

  async open(input: OpenPullRequestInput, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!input.body.includes(input.marker)) throw new Error('The pull request description must carry its marker.');
    const response = await this.#json(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls`,
      '-f', `title=${input.title}`, '-f', `body=${input.body}`, '-f', `head=${input.headBranch}`, '-f', `base=${input.base}`, '-F', `draft=${input.draft}`], signal);
    const { body, ...pr } = this.#pull(response, input);
    if (!body.includes(input.marker)) throw new Error('GitHub returned a pull request without its marker.');
    return pr;
  }

  async findOpened(input: { base: string; headBranch: string; marker: string }, signal?: AbortSignal): Promise<OpenedPullRequest | null> {
    this.#validate(input);
    const owner = this.repository.split('/')[0]!;
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${input.headBranch}`, base: input.base, per_page: '100' });
    const response = await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls?${query}`], signal);
    // GitHub allows one open PR per head and base, so more than one result is a malformed response.
    if (!Array.isArray(response) || response.length > 1) throw new Error('GitHub returned an invalid pull request list.');
    if (!response.length) return null;
    const { body, ...pr } = this.#pull(response[0], input);
    if (!body.includes(input.marker)) throw new Error(`An open pull request from ${input.headBranch} exists that codeboost did not open.`);
    return pr;
  }

  async refresh(number: number, input: OpenPullRequestInput & { ready: boolean }, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    if (!input.body.includes(input.marker)) throw new Error('The pull request description must carry its marker.');
    const patched = this.#pull(await this.#json(['api', '-X', 'PATCH', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`,
      '-f', `title=${input.title}`, '-f', `body=${input.body}`], signal), input);
    if (patched.number !== number || !patched.body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
    if (input.ready && patched.draft) await this.run(['pr', 'ready', String(number), '--repo', this.repository], { signal });
    const { body, ...pr } = this.#pull(await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`], signal), input);
    if (pr.number !== number || !body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
    return pr;
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunGh } from './merge.ts';
import { ghEnvironment } from './gh-env.ts';

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
  /**
   * The open PR from `headBranch` into `base`, with the one of `markers` its description carries, or null when there is
   * no open PR. An open PR that carries none of them was not opened by codeboost, and is refused.
   */
  findOpened(input: { base: string; headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string }) | null>;
  /** Replaces the title and description of an open PR codeboost opened; marks it ready when `ready`, or a draft when `draft`. */
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
    this.run = run ?? (async (args, options) => (await runFile('gh', [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal, env: ghEnvironment() })).stdout);
  }

  async #json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.run(args, { signal });
    try { return JSON.parse(output); }
    catch { throw new Error('GitHub returned invalid JSON.'); }
  }

  #pull(value: unknown, input: { base: string; headBranch: string }): OpenedPullRequest & { body: string } {
    const pr = value as { number?: unknown; html_url?: unknown; draft?: unknown; state?: unknown; body?: unknown; head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null }; base?: { ref?: unknown; repo?: { full_name?: unknown } } };
    if (!pr || typeof pr !== 'object' || !Number.isSafeInteger(pr.number) || (pr.number as number) < 1 || typeof pr.html_url !== 'string' || !pr.html_url.startsWith('https://')
      || typeof pr.draft !== 'boolean' || (pr.body !== null && typeof pr.body !== 'string') || typeof pr.head?.sha !== 'string' || !SHA.test(pr.head.sha))
      throw new Error('GitHub returned an invalid pull request.');
    const same = (name: unknown) => typeof name === 'string' && name.toLowerCase() === this.repository.toLowerCase();
    if (pr.head.ref !== input.headBranch || !same(pr.head.repo?.full_name) || pr.base?.ref !== input.base || !same(pr.base.repo?.full_name))
      throw new Error('GitHub returned a pull request for a different branch.');
    // A PR can be closed between any two calls; codeboost only records and reports an open one.
    if (pr.state !== 'open') throw new Error(`Pull request #${pr.number} is not open.`);
    return { number: pr.number as number, url: pr.html_url, headSha: pr.head.sha, draft: pr.draft, body: pr.body ?? '' };
  }

  #validate(input: { base: string; headBranch: string; marker?: string; markers?: readonly string[] }): void {
    if (!BRANCH.test(input.base) || !BRANCH.test(input.headBranch)) throw new Error('Invalid branch name.');
    const markers = input.markers ?? [input.marker];
    if (!markers.length || markers.some(marker => typeof marker !== 'string' || !/^<!-- codeboost:[a-z-]+=[0-9a-f-]{36} -->$/.test(marker))) throw new Error('Invalid pull request marker.');
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

  async findOpened(input: { base: string; headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string }) | null> {
    this.#validate(input);
    const owner = this.repository.split('/')[0]!;
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${input.headBranch}`, base: input.base, per_page: '100' });
    const response = await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls?${query}`], signal);
    // GitHub allows one open PR per head and base, so more than one result is a malformed response.
    if (!Array.isArray(response) || response.length > 1) throw new Error('GitHub returned an invalid pull request list.');
    if (!response.length) return null;
    const { body, ...pr } = this.#pull(response[0], input);
    const found = input.markers.filter(marker => body.includes(marker));
    if (found.length !== 1) throw new Error(`An open pull request from ${input.headBranch} exists that codeboost did not open.`);
    return { ...pr, marker: found[0]! };
  }

  async refresh(number: number, input: OpenPullRequestInput & { ready: boolean }, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    if (!input.body.includes(input.marker)) throw new Error('The pull request description must carry its marker.');
    const patched = this.#pull(await this.#json(['api', '-X', 'PATCH', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`,
      '-f', `title=${input.title}`, '-f', `body=${input.body}`], signal), input);
    if (patched.number !== number || !patched.body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
    // A ready PR whose task went back to needs human becomes a draft again; a draft whose task is ready leaves draft.
    if (input.ready && patched.draft) await this.run(['pr', 'ready', String(number), '--repo', this.repository], { signal });
    else if (input.draft && !patched.draft) await this.run(['pr', 'ready', String(number), '--undo', '--repo', this.repository], { signal });
    const { body, ...pr } = this.#pull(await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`], signal), input);
    if (pr.number !== number || !body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
    return pr;
  }
}

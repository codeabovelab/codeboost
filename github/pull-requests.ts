import { ghEnvironment } from './gh-env.ts';
import { runWithInput } from './run-with-input.ts';
import { BRANCH, REPOSITORY, SHA } from './validate.ts';

/** A `gh` runner that can also write a request body to stdin (`gh api --input -`). */
export type RunGhWithInput = (args: readonly string[], options?: { signal?: AbortSignal; input?: string }) => Promise<string>;

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
   * no open PR. An open PR that carries none of them (always the case with no markers) was not opened by codeboost, and
   * is refused.
   */
  findOpened(input: { base: string; headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string }) | null>;
  /** Replaces the title and description of an open PR codeboost opened; marks it ready when `ready`, or a draft when `draft`. */
  refresh(number: number, input: OpenPullRequestInput & { ready: boolean; headSha?: string }, signal?: AbortSignal): Promise<OpenedPullRequest>;
  /** Turns an open PR codeboost opened back into a draft; a no-op for a draft. */
  markDraft(number: number, input: { base: string; headBranch: string; marker: string }, signal?: AbortSignal): Promise<OpenedPullRequest>;
}
/**
 * GitHub refused a draft because the repository does not support draft PRs (for example a private repository on the
 * Free plan). A definite refusal: nothing was created or changed.
 */
export class DraftsUnsupported extends Error {}
const DRAFTS_UNSUPPORTED = /draft pull requests? (?:are|is) not supported/i;
/** Runs a GitHub call that asks for a draft, turning GitHub's "not supported" refusal into DraftsUnsupported. */
async function draftCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (error instanceof Error && DRAFTS_UNSUPPORTED.test(error.message)) throw new DraftsUnsupported('This repository does not support draft pull requests.');
    throw error;
  }
}
/** GitHub updates a PR's head a moment after a push; the read-back waits up to this many polls for the pushed head. */
export const HEAD_POLLS = 5, HEAD_POLL_MS = 500;


/**
 * GitHub CLI adapter for opening a task's PR. All arguments are literal argv; no shell is involved. The title and
 * description go as a JSON request body on stdin, never as arguments.
 */
export class GhPullRequestGateway implements PullRequestGateway {
  readonly repository: string;
  readonly run: RunGhWithInput;
  constructor(config: { repository: string }, run?: RunGhWithInput) {
    if (!REPOSITORY.test(config.repository)) throw new Error('A GitHub repository is required to open pull requests.');
    this.repository = config.repository;
    this.run = run ?? ((args, options) => runWithInput('gh', args, { input: options?.input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal, env: ghEnvironment() }));
  }

  async #json(args: readonly string[], signal?: AbortSignal, body?: Record<string, unknown>): Promise<unknown> {
    const output = await this.run(body ? [...args, '--input', '-'] : args, { signal, ...(body ? { input: JSON.stringify(body) } : {}) });
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
    // A lookup may carry no markers (the task has no PR yet); every other call names the PR's own marker.
    const markers = input.markers ?? [input.marker];
    if ((input.markers === undefined && !markers.length) || markers.some(marker => typeof marker !== 'string' || !/^<!-- codeboost:[a-z-]+=[0-9a-f-]{36} -->$/.test(marker))) throw new Error('Invalid pull request marker.');
  }

  async open(input: OpenPullRequestInput, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!input.body.includes(input.marker)) throw new Error('The pull request description must carry its marker.');
    const post = () => this.#json(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls`], signal,
      { title: input.title, body: input.body, head: input.headBranch, base: input.base, draft: input.draft });
    const response = input.draft ? await draftCall(post) : await post();
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

  async refresh(number: number, input: OpenPullRequestInput & { ready: boolean; headSha?: string }, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    if (!input.body.includes(input.marker)) throw new Error('The pull request description must carry its marker.');
    const patched = this.#pull(await this.#json(['api', '-X', 'PATCH', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`], signal,
      { title: input.title, body: input.body }), input);
    if (patched.number !== number || !patched.body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
    // A ready PR whose task went back to needs human becomes a draft again; a draft whose task is ready leaves draft.
    if (input.ready && patched.draft) await this.run(['pr', 'ready', String(number), '--repo', this.repository], { signal });
    else if (input.draft && !patched.draft) await draftCall(() => this.run(['pr', 'ready', String(number), '--undo', '--repo', this.repository], { signal }));
    const wantDraft = input.ready ? false : input.draft ? true : undefined;
    const pr = await this.#readBack(number, input, found => (input.headSha === undefined || found.headSha === input.headSha) && (wantDraft === undefined || found.draft === wantDraft), signal);
    // A draft change GitHub has not applied fails the refresh, so it stays unconfirmed and the next publish repeats it.
    if (wantDraft !== undefined && pr.draft !== wantDraft) throw new Error(`GitHub did not ${wantDraft ? 'turn the pull request into a draft' : 'mark the pull request ready'}.`);
    return pr;
  }

  /** The caller has just read the PR as ready, so this changes it straight away and reads the result back once. */
  async markDraft(number: number, input: { base: string; headBranch: string; marker: string }, signal?: AbortSignal): Promise<OpenedPullRequest> {
    this.#validate(input);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    let refused: unknown = null;
    try { await draftCall(() => this.run(['pr', 'ready', String(number), '--undo', '--repo', this.repository], { signal })); }
    catch (error) { if (error instanceof DraftsUnsupported || signal?.aborted) throw error; refused = error; }
    const pr = await this.#readBack(number, input, found => found.draft, signal);
    // A refusal because the PR had meanwhile become a draft is success; otherwise the change did not apply.
    if (!pr.draft) throw refused ?? new Error('GitHub did not turn the pull request into a draft.');
    return pr;
  }

  /** Reads the PR back, polling briefly until `done` holds (GitHub applies pushes and draft changes a moment later); returns the last answer. */
  async #readBack(number: number, input: { base: string; headBranch: string; marker: string }, done: (pr: OpenedPullRequest) => boolean, signal?: AbortSignal): Promise<OpenedPullRequest> {
    for (let poll = 1; ; poll++) {
      const { body, ...pr } = this.#pull(await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`], signal), input);
      if (pr.number !== number || !body.includes(input.marker)) throw new Error('GitHub returned a different pull request.');
      if (done(pr) || poll >= HEAD_POLLS) return pr;
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, HEAD_POLL_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

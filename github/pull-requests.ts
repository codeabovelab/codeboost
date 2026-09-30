import { ghEnvironment } from './gh-env.ts';
import { CommandFailed, runWithInput } from './run-with-input.ts';
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
  /** The repository it calls, when fixed; the publisher refuses one that differs from its own. */
  readonly repository?: string;
  open(input: OpenPullRequestInput, signal?: AbortSignal): Promise<OpenedPullRequest>;
  /**
   * The open PR from `headBranch` into `base`, with the one of `markers` its description carries, or null when there is
   * no open PR. An open PR that carries none of them (always the case with no markers) was not opened by codeboost, and
   * is refused. The task's own PRs (those carrying one of `markers`) must be at most one, and into `base`: its own PR in
   * another base (retargeted by a person, or left by a base change) is refused, and so are two of its own PRs. Anyone
   * else's PR from the branch into another base (a backport, say) is ignored. For the calls that change a PR's content.
   */
  findOpened(input: { base: string; headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string }) | null>;
  /**
   * Every open PR from `headBranch` that carries one of `markers`, in whatever base, with that base. Nothing is refused
   * for being in another base: for recording what GitHub shows and for making PRs drafts, both safe in any base.
   */
  findOwned(input: { headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string; base: string })[]>;
  /** Replaces the title and description of an open PR codeboost opened; marks it ready when `ready`, or a draft when `draft`. */
  /** `beforeReady` runs after the description update's await and before any ready or draft change; if it throws, no such change is made. */
  refresh(number: number, input: OpenPullRequestInput & { ready: boolean; headSha?: string; beforeReady?: () => void }, signal?: AbortSignal): Promise<OpenedPullRequest>;
  /** Turns an open PR codeboost opened back into a draft; a no-op for a draft. */
  markDraft(number: number, input: { base: string; headBranch: string; marker: string }, signal?: AbortSignal): Promise<OpenedPullRequest>;
}
/**
 * GitHub refused a draft because the repository does not support draft PRs (for example a private repository on the
 * Free plan). A definite refusal: nothing was created or changed.
 */
export class DraftsUnsupported extends Error {}
/**
 * GitHub refused to open the PR with a validation error (HTTP 422: no commits between base and head, a PR already open
 * for the branch, and so on). A definite refusal: GitHub created nothing, so the opening is not left in flight.
 */
export class PullRequestRefused extends Error {}
const DRAFTS_UNSUPPORTED = /draft pull requests? (?:are|is) not supported/i;
/**
 * What a refusal is matched against: `gh`'s stderr (`gh: <message> (HTTP 422)`) and GitHub's own error fields in the
 * response body `gh api` prints on stdout (`message`, `errors[].message`, where a validation reason such as "A pull
 * request already exists" is). Never the raw stdout, which could echo text codeboost sent, and nothing from a failure
 * that is not a finished `gh` run.
 */
function refusalText(error: unknown): string {
  if (!(error instanceof CommandFailed)) return '';
  const reasons = [error.stderr];
  try {
    const body = JSON.parse(error.stdout) as { errors?: unknown } | null;
    // The top-level message is already on stderr (`gh: <message> (HTTP 422)`).
    if (Array.isArray(body?.errors)) for (const item of body.errors) if (typeof item?.message === 'string') reasons.push(item.message);
  } catch { /* no JSON body: stderr alone */ }
  return reasons.join('\n');
}
/** Runs a GitHub call that asks for a draft, turning GitHub's "not supported" refusal into DraftsUnsupported. */
async function draftCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (DRAFTS_UNSUPPORTED.test(refusalText(error))) throw new DraftsUnsupported('This repository does not support draft pull requests.');
    throw error;
  }
}
/**
 * A PR's marker is its description's first line and nothing else. Plan text and problems later in the description are
 * agent-controlled, so a marker-shaped string there never identifies a PR.
 */
export const markerOf = (body: string): string => body.split('\n', 1)[0]!.trim();
/** The longest one open, lookup, refresh or draft change may take in total, whatever the caller's signal. */
export const PR_OPERATION_DEADLINE_MS = 60_000;
/** GitHub updates a PR's head a moment after a push; the read-back waits up to this many polls for the pushed head. */
export const HEAD_POLLS = 5, HEAD_POLL_MS = 500;


/**
 * GitHub CLI adapter for opening a task's PR. All arguments are literal argv; no shell is involved. The title and
 * description go as a JSON request body on stdin, never as arguments.
 */
export class GhPullRequestGateway implements PullRequestGateway {
  readonly repository: string;
  readonly run: RunGhWithInput;
  /** One deadline for a whole operation (every command and poll wait in it), not a fresh allowance per command. */
  readonly operationMs: number;
  constructor(config: { repository: string; operationMs?: number }, run?: RunGhWithInput) {
    if (!REPOSITORY.test(config.repository)) throw new Error('A GitHub repository is required to open pull requests.');
    if (config.operationMs !== undefined && (!Number.isSafeInteger(config.operationMs) || config.operationMs < 1)) throw new Error('Invalid operation deadline.');
    this.repository = config.repository;
    this.operationMs = config.operationMs ?? PR_OPERATION_DEADLINE_MS;
    this.run = run ?? ((args, options) => runWithInput('gh', args, { input: options?.input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal, env: ghEnvironment() }));
  }

  /** The caller's signal combined with this operation's single deadline; every command and wait in it uses the result. */
  #bounded(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.operationMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
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

  #validate(input: { base?: string; headBranch: string; marker?: string; markers?: readonly string[] }): void {
    if ((input.base !== undefined && !BRANCH.test(input.base)) || !BRANCH.test(input.headBranch)) throw new Error('Invalid branch name.');
    // A lookup may carry no markers (the task has no PR yet); every other call names the PR's own marker.
    const markers = input.markers ?? [input.marker];
    if ((input.markers === undefined && !markers.length) || markers.some(marker => typeof marker !== 'string' || !/^<!-- codeboost:[a-z-]+=[0-9a-f-]{36} -->$/.test(marker))) throw new Error('Invalid pull request marker.');
  }

  async open(input: OpenPullRequestInput, signal?: AbortSignal): Promise<OpenedPullRequest> {
    signal = this.#bounded(signal);
    this.#validate(input);
    if (markerOf(input.body) !== input.marker) throw new Error('The pull request description must start with its marker.');
    const post = () => this.#json(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls`], signal,
      { title: input.title, body: input.body, head: input.headBranch, base: input.base, draft: input.draft });
    let response;
    try { response = input.draft ? await draftCall(post) : await post(); }
    catch (error) {
      if (error instanceof DraftsUnsupported || !/\(HTTP 422\)/.test(refusalText(error))) throw error;
      throw new PullRequestRefused(`GitHub refused to open the pull request: ${(error as Error).message}`);
    }
    const { body, ...pr } = this.#pull(response, input);
    if (markerOf(body) !== input.marker) throw new Error('GitHub returned a pull request without its marker.');
    // The PR exists, but not in the requested state: failing keeps the opening owned, and recovery turns it into a draft.
    if (input.draft && !pr.draft) throw new Error('GitHub opened the pull request as ready, not as a draft.');
    return pr;
  }

  /**
   * Every open PR from the branch, in any base. Not filtered by base on GitHub's side: GitHub allows one open PR per head
   * and base, so the task's own PR that a person retargeted would be missed, and a second PR opened from the same branch.
   */
  async #branchPulls(headBranch: string, signal: AbortSignal): Promise<unknown[]> {
    const owner = this.repository.split('/')[0]!;
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${headBranch}`, per_page: '100' });
    const response = await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls?${query}`], signal);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid pull request list.');
    return response;
  }

  /** The task's own PRs among `pulls`: those whose description's first line is one of `markers`, each with its base. */
  #owned(pulls: readonly unknown[], headBranch: string, markers: readonly string[]): (OpenedPullRequest & { marker: string; base: string })[] {
    return pulls.flatMap(value => {
      const body = (value as { body?: unknown } | null)?.body;
      if (typeof body !== 'string' || !markers.includes(markerOf(body))) return [];
      const base = (value as { base?: { ref?: unknown } }).base?.ref;
      if (typeof base !== 'string' || !BRANCH.test(base)) throw new Error('GitHub returned an invalid pull request.');
      const { body: _, ...pr } = this.#pull(value, { base, headBranch });
      return [{ ...pr, marker: markerOf(body), base }];
    });
  }

  async findOwned(input: { headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string; base: string })[]> {
    signal = this.#bounded(signal);
    this.#validate(input);
    return this.#owned(await this.#branchPulls(input.headBranch, signal), input.headBranch, input.markers);
  }

  async findOpened(input: { base: string; headBranch: string; markers: readonly string[] }, signal?: AbortSignal): Promise<(OpenedPullRequest & { marker: string }) | null> {
    signal = this.#bounded(signal);
    this.#validate(input);
    const pulls = await this.#branchPulls(input.headBranch, signal);
    const own = this.#owned(pulls, input.headBranch, input.markers);
    if (own.length > 1) throw new Error(`More than one of the task's pull requests is open from ${input.headBranch} (${own.map(pr => `#${pr.number} into ${pr.base}`).join(', ')}). Close all but one.`);
    if (own.length === 1 && own[0]!.base !== input.base)
      throw new Error(`The task's pull request #${own[0]!.number} from ${input.headBranch} now targets ${own[0]!.base}, not ${input.base}. Retarget it to ${input.base} or close it.`);
    const here = pulls.filter(pr => (pr as { base?: { ref?: unknown } } | null)?.base?.ref === input.base);
    if (here.length > 1) throw new Error('GitHub returned an invalid pull request list.');
    if (!here.length) return null;
    const { body, ...pr } = this.#pull(here[0], input);
    const found = input.markers.filter(marker => markerOf(body) === marker);
    if (found.length !== 1) throw new Error(`An open pull request from ${input.headBranch} exists that codeboost did not open.`);
    return { ...pr, marker: found[0]! };
  }

  async refresh(number: number, input: OpenPullRequestInput & { ready: boolean; headSha?: string; beforeReady?: () => void }, signal?: AbortSignal): Promise<OpenedPullRequest> {
    signal = this.#bounded(signal);
    this.#validate(input);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    if (markerOf(input.body) !== input.marker) throw new Error('The pull request description must start with its marker.');
    const patched = this.#pull(await this.#json(['api', '-X', 'PATCH', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/pulls/${number}`], signal,
      { title: input.title, body: input.body }), input);
    if (patched.number !== number || markerOf(patched.body) !== input.marker) throw new Error('GitHub returned a different pull request.');
    // The caller's re-check after the PATCH's await: a task change during it must not lead to a ready change.
    input.beforeReady?.();
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
    signal = this.#bounded(signal);
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
      if (pr.number !== number || markerOf(body) !== input.marker) throw new Error('GitHub returned a different pull request.');
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

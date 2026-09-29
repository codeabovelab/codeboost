import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunGh } from './merge.ts';

const runFile = promisify(execFile);

/**
 * The pre-PR "already fixed" check (design, "Checking whether the issue is already fixed"). It reports a match when
 * something other than this task closed the issue, when another open or merged PR links to the issue, or when a new
 * commit on the base branch mentions it. The task's own PRs and commits are excluded by repository and number or by
 * SHA only. Every read is bounded; a response past a bound, or one that cannot be read, is `unknown`, never clear.
 */
export type AlreadyFixedMatch =
  | { kind: 'closed'; by: string }
  | { kind: 'pull request'; repository: string; number: number; state: 'OPEN' | 'MERGED'; draft: boolean }
  | { kind: 'commit'; sha: string; subject: string };
export type AlreadyFixedResult =
  | { outcome: 'clear'; baseHead: string }
  | { outcome: 'found'; baseHead: string; matches: AlreadyFixedMatch[] }
  | { outcome: 'unknown'; reason: string };
export interface AlreadyFixedInput {
  issue: number;
  /** The base commit the task started from. Commits after it on the base branch are scanned. */
  taskBase: string;
  baseBranch: string;
  /** This task's PRs in the configured repository (the open PR and any earlier drafts). */
  ownPullRequests: readonly number[];
  /** This task's own commits (runner-owned ledger entries). */
  ownCommits: ReadonlySet<string>;
}
export interface AlreadyFixedGateway { check(input: AlreadyFixedInput, signal?: AbortSignal): Promise<AlreadyFixedResult> }

export const MAX_TIMELINE_ITEMS = 100;
export const MAX_BASE_COMMITS = 250;
const PAGE = 100;

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      state
      timelineItems(first: ${MAX_TIMELINE_ITEMS}, itemTypes: [CLOSED_EVENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on ClosedEvent { closer { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Commit { oid } } }
          ... on CrossReferencedEvent { source { __typename ... on PullRequest { number state isDraft repository { nameWithOwner } } } }
          ... on ConnectedEvent { subject { __typename ... on PullRequest { number state isDraft repository { nameWithOwner } } } }
        }
      }
    }
  }
}`;

class Unknown extends Error {}
const SHA = /^[a-f0-9]{40}$/;
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Unknown(`GitHub returned an invalid ${label}.`);
  return value as Record<string, unknown>;
};
const positive = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Unknown(`GitHub returned an invalid ${label}.`);
  return value as number;
};
const repositoryName = (value: unknown): string => {
  const name = object(value, 'repository').nameWithOwner;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Unknown('GitHub returned an invalid repository name.');
  return name;
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a commit message refers to the issue: `#N`, `GH-N`, `owner/name#N`, or the issue URL. A reference qualified
 * with another repository (`other/repo#N`) is not this issue, and `#N` never matches a longer number.
 */
export function mentionsIssue(message: string, repository: string, issue: number): boolean {
  const n = String(issue), repo = escape(repository);
  return new RegExp(`(?<![\\w/.#-])#${n}(?!\\w)`).test(message)
    || new RegExp(`(?<![\\w-])GH-${n}(?!\\w)`, 'i').test(message)
    || new RegExp(`(?<![\\w.-])${repo}#${n}(?!\\w)`, 'i').test(message)
    || new RegExp(`(?<![\\w.-])(?:https?://)?(?:www\\.)?github\\.com/${repo}/issues/${n}(?![\\w])`, 'i').test(message);
}

export interface GhAlreadyFixedConfig { repository: string }

/** GitHub CLI adapter. All arguments are literal argv; no shell is involved. */
export class GhAlreadyFixedGateway implements AlreadyFixedGateway {
  readonly repository: string;
  readonly run: RunGh;
  constructor(config: GhAlreadyFixedConfig, run?: RunGh) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error('A GitHub repository is required for the already-fixed check.');
    this.repository = config.repository;
    this.run = run ?? (async (args, options) => (await runFile('gh', [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal })).stdout);
  }

  async #json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.run(args, { signal });
    try { return JSON.parse(output); }
    catch { throw new Unknown('GitHub returned invalid JSON.'); }
  }

  async check(input: AlreadyFixedInput, signal?: AbortSignal): Promise<AlreadyFixedResult> {
    if (!Number.isSafeInteger(input.issue) || input.issue < 1) throw new Error('Invalid issue number.');
    if (!SHA.test(input.taskBase)) throw new Error('Invalid task base commit.');
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/.test(input.baseBranch)) throw new Error('Invalid base branch name.');
    if (input.ownPullRequests.some(number => !Number.isSafeInteger(number) || number < 1)) throw new Error('Invalid pull request number.');
    try {
      const matches = await this.#timeline(input, signal);
      const { baseHead, commits } = await this.#baseCommits(input, signal);
      for (const commit of commits) {
        if (input.ownCommits.has(commit.sha) || !mentionsIssue(commit.message, this.repository, input.issue)) continue;
        matches.push({ kind: 'commit', sha: commit.sha, subject: commit.message.split('\n', 1)[0]!.slice(0, 200) });
      }
      return matches.length ? { outcome: 'found', baseHead, matches } : { outcome: 'clear', baseHead };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { outcome: 'unknown', reason: error instanceof Unknown ? error.message : 'GitHub could not be read.' };
    }
  }

  async #timeline(input: AlreadyFixedInput, signal?: AbortSignal): Promise<AlreadyFixedMatch[]> {
    const [owner, name] = this.repository.split('/') as [string, string];
    const response = object(await this.#json(['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${input.issue}`, '-f', `query=${TIMELINE_QUERY}`], signal), 'response');
    if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Unknown('GitHub reported errors reading the issue.');
    const repository = object(object(response.data, 'response').repository, 'repository');
    const self = repositoryName(repository).toLowerCase();
    if (self !== this.repository.toLowerCase()) throw new Unknown('GitHub returned a different repository.');
    const issue = object(repository.issue, 'issue');
    if (issue.state !== 'OPEN' && issue.state !== 'CLOSED') throw new Unknown('GitHub returned an invalid issue state.');
    const timeline = object(issue.timelineItems, 'timeline');
    const nodes = timeline.nodes;
    if (!Array.isArray(nodes) || !Number.isSafeInteger(timeline.totalCount)) throw new Unknown('GitHub returned an invalid timeline.');
    if ((timeline.totalCount as number) > MAX_TIMELINE_ITEMS || object(timeline.pageInfo, 'timeline page').hasNextPage !== false || nodes.length !== timeline.totalCount)
      throw new Unknown(`The issue has more than ${MAX_TIMELINE_ITEMS} linking events; the check cannot read them all.`);
    const own = new Set(input.ownPullRequests);
    const isOwn = (repo: string, number: number) => repo.toLowerCase() === self && own.has(number);
    const matches: AlreadyFixedMatch[] = [], seen = new Set<string>();
    let lastCloser: string | null | undefined;
    for (const raw of nodes) {
      const node = object(raw, 'timeline event');
      if (node.__typename === 'ClosedEvent') {
        if (node.closer === null) { lastCloser = 'a person, without a linked PR or commit'; continue; }
        const closer = object(node.closer, 'closer');
        if (closer.__typename === 'PullRequest') {
          const repo = repositoryName(closer.repository), number = positive(closer.number, 'pull request number');
          lastCloser = isOwn(repo, number) ? null : `${repo}#${number}`;
        } else if (closer.__typename === 'Commit') {
          if (typeof closer.oid !== 'string' || !SHA.test(closer.oid)) throw new Unknown('GitHub returned an invalid closing commit.');
          lastCloser = input.ownCommits.has(closer.oid) ? null : `commit ${closer.oid}`;
        } else throw new Unknown('GitHub returned an unknown closer.');
        continue;
      }
      const field = node.__typename === 'CrossReferencedEvent' ? 'source' : node.__typename === 'ConnectedEvent' ? 'subject' : null;
      if (!field) throw new Unknown('GitHub returned an unexpected timeline event.');
      const source = object(node[field], 'linked item');
      if (source.__typename === 'Issue') continue;
      if (source.__typename !== 'PullRequest') throw new Unknown('GitHub returned an unknown linked item.');
      const repo = repositoryName(source.repository), number = positive(source.number, 'pull request number');
      if (!['OPEN', 'CLOSED', 'MERGED'].includes(source.state as string) || typeof source.isDraft !== 'boolean') throw new Unknown('GitHub returned an invalid pull request state.');
      if (isOwn(repo, number) || source.state === 'CLOSED') continue;
      const key = `${repo.toLowerCase()}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ kind: 'pull request', repository: repo, number, state: source.state as 'OPEN' | 'MERGED', draft: source.isDraft });
    }
    if (issue.state === 'CLOSED') {
      if (lastCloser === undefined) throw new Unknown('The issue is closed, but GitHub did not say what closed it.');
      if (lastCloser !== null) matches.unshift({ kind: 'closed', by: lastCloser });
    }
    return matches;
  }

  async #baseCommits(input: AlreadyFixedInput, signal?: AbortSignal): Promise<{ baseHead: string; commits: { sha: string; message: string }[] }> {
    const ref = object(await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/git/ref/heads/${input.baseBranch}`], signal), 'branch');
    if (ref.ref !== `refs/heads/${input.baseBranch}`) throw new Unknown('GitHub returned a different base branch.');
    const baseHead = object(ref.object, 'branch head').sha;
    if (typeof baseHead !== 'string' || !SHA.test(baseHead)) throw new Unknown('GitHub returned an invalid base branch head.');
    const commits: { sha: string; message: string }[] = [];
    let total = 0;
    for (let page = 1; page === 1 || commits.length < total; page++) {
      const response = object(await this.#json(['api', '-H', 'Accept: application/vnd.github+json', `repos/${this.repository}/compare/${input.taskBase}...${baseHead}?per_page=${PAGE}&page=${page}`], signal), 'comparison');
      if (response.status !== 'identical' && response.status !== 'ahead') throw new Unknown('The task base is not an ancestor of the base branch.');
      if (!Number.isSafeInteger(response.total_commits) || (response.total_commits as number) < 0) throw new Unknown('GitHub returned an invalid commit count.');
      if (page === 1) total = response.total_commits as number;
      else if (response.total_commits !== total) throw new Unknown('The base branch changed during the check.');
      if (total > MAX_BASE_COMMITS) throw new Unknown(`The base branch has more than ${MAX_BASE_COMMITS} new commits; the check cannot read them all.`);
      if (!Array.isArray(response.commits) || (total > 0 && response.commits.length === 0) || commits.length + response.commits.length > total) throw new Unknown('GitHub returned an incomplete commit list.');
      for (const raw of response.commits) {
        const entry = object(raw, 'commit');
        const message = object(entry.commit, 'commit').message;
        if (typeof entry.sha !== 'string' || !SHA.test(entry.sha) || typeof message !== 'string') throw new Unknown('GitHub returned an invalid commit.');
        commits.push({ sha: entry.sha, message });
      }
      if (total === 0) break;
    }
    return { baseHead, commits };
  }
}

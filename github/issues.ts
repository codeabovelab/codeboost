import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_ISSUES = PAGE_SIZE * MAX_PAGES;
const MAX_BODY_LENGTH = 65_536;
// Covers one bounded 100-record page, including JSON-escaped bodies, labels and response overhead.
export const ISSUE_PAGE_MAX_BYTES = 64 * 1024 * 1024;

export type IssueAuthorAssociation =
  | 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR'
  | 'FIRST_TIMER' | 'FIRST_TIME_CONTRIBUTOR' | 'MANNEQUIN' | 'NONE';

export interface RepositoryIssue {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly comments: number;
  readonly positiveReactions: number;
  readonly labels: readonly string[];
  readonly authorAssociation: IssueAuthorAssociation;
  readonly trust: 'trusted' | 'requires-approval';
}

export interface IssueSnapshot {
  readonly repository: string;
  readonly retrievedAt: string;
  readonly issues: readonly RepositoryIssue[];
}

export interface IssueGateway {
  readonly repository: string;
  fetch(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<IssueSnapshot>;
}

type RunGh = (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<string>;

const associations = new Set<IssueAuthorAssociation>([
  'OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'NONE',
]);

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maximum: number, nullable = false): string {
  if (nullable && value === null) return '';
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`GitHub returned an invalid issue ${field}.`);
  return value;
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`GitHub returned an invalid issue ${field}.`);
  return value as number;
}

function repositoryName(value: string): boolean {
  if (value.length > 201 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split('/').every(part => part !== '.' && part !== '..' && part.length <= 100);
}

function sameGithubUrl(value: unknown, expected: string, field: string): string {
  const url = boundedString(value, field, 2048);
  if (url.toLowerCase() !== expected.toLowerCase()) throw new Error(`GitHub returned an invalid issue ${field}.`);
  return url;
}

function timestamp(value: unknown, field: string): string {
  const text = boundedString(value, field, 64);
  const parsed = Date.parse(text);
  const canonical = text.includes('.') ? text : text.replace('Z', '.000Z');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)
    || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical)
    throw new Error(`GitHub returned an invalid issue ${field}.`);
  return text;
}

function normalizeIssue(repository: string, value: unknown): RepositoryIssue | null {
  const issue = object(value, 'GitHub returned a malformed issue.');
  if (!Number.isSafeInteger(issue.number) || (issue.number as number) < 1) throw new Error('GitHub returned an invalid issue number.');
  const number = issue.number as number;
  if (Object.hasOwn(issue, 'pull_request')) {
    const marker = object(issue.pull_request, 'GitHub returned an invalid pull request marker.');
    sameGithubUrl(marker.url, `https://api.github.com/repos/${repository}/pulls/${number}`, 'pull request marker');
    return null;
  }
  if (issue.state !== 'open') throw new Error('GitHub returned a non-open issue.');
  const url = sameGithubUrl(issue.html_url, `https://github.com/${repository}/issues/${number}`, 'URL');
  const createdAt = timestamp(issue.created_at, 'creation time');
  const updatedAt = timestamp(issue.updated_at, 'update time');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('GitHub returned an issue update before its creation.');
  if (!Array.isArray(issue.labels) || issue.labels.length > 100) throw new Error('GitHub returned invalid issue labels.');
  const labels = issue.labels.map(label => {
    const name = boundedString(object(label, 'GitHub returned an invalid issue label.').name, 'label', 100);
    if (!name.trim()) throw new Error('GitHub returned an empty issue label.');
    return name;
  });
  if (new Set(labels.map(label => label.toLocaleLowerCase('en-US'))).size !== labels.length)
    throw new Error('GitHub returned duplicate issue labels.');
  const reactionData = object(issue.reactions, 'GitHub returned invalid issue reactions.');
  const positiveReactions = ['+1', 'heart', 'hooray', 'rocket']
    .reduce((total, key) => total + count(reactionData[key], `${key} reactions`), 0);
  if (!Number.isSafeInteger(positiveReactions)) throw new Error('GitHub returned an invalid positive reaction count.');
  const authorAssociation = issue.author_association;
  if (typeof authorAssociation !== 'string' || !associations.has(authorAssociation as IssueAuthorAssociation))
    throw new Error('GitHub returned an unknown issue author association.');
  const association = authorAssociation as IssueAuthorAssociation;
  const title = boundedString(issue.title, 'title', 4096);
  if (!title.trim()) throw new Error('GitHub returned an empty issue title.');
  return {
    repository,
    number,
    title,
    body: boundedString(issue.body, 'body', MAX_BODY_LENGTH, true),
    url,
    createdAt,
    updatedAt,
    comments: count(issue.comments, 'comment count'),
    positiveReactions,
    labels,
    authorAssociation: association,
    trust: ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association) ? 'trusted' : 'requires-approval',
  };
}

/** Read-only GitHub CLI adapter. Issue content is returned only as data. */
export class GhIssueGateway implements IssueGateway {
  readonly repository: string;
  readonly run: RunGh;
  readonly now: () => Date;

  constructor(repository: string, run?: RunGh, now: () => Date = () => new Date()) {
    if (!repositoryName(repository)) throw new Error('A GitHub repository is required for issue retrieval.');
    this.repository = repository;
    this.run = run ?? (async (args, options) => (await runFile('gh', [...args], {
      maxBuffer: ISSUE_PAGE_MAX_BYTES,
      signal: options?.signal,
    })).stdout);
    this.now = now;
  }

  async #load(signal: AbortSignal): Promise<RepositoryIssue[]> {
    const issues: RepositoryIssue[] = [];
    const numbers = new Set<number>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const output = await this.run([
        'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
        `repos/${this.repository}/issues`, '-f', 'state=open', '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`,
      ], { signal });
      let decoded: unknown;
      try { decoded = JSON.parse(output); }
      catch { throw new Error('GitHub returned invalid issue JSON.'); }
      if (!Array.isArray(decoded)) throw new Error('GitHub returned an invalid issue page.');
      if (decoded.length > PAGE_SIZE) throw new Error('GitHub returned an oversized issue page.');
      for (const value of decoded) {
        const issue = normalizeIssue(this.repository, value);
        if (!issue) continue;
        if (numbers.has(issue.number)) throw new Error('GitHub returned a duplicate issue.');
        numbers.add(issue.number);
        issues.push(issue);
      }
      if (decoded.length < PAGE_SIZE) return issues;
    }
    throw new Error(`Issue retrieval exceeded the ${MAX_ISSUES}-record safety limit.`);
  }

  async fetch(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<IssueSnapshot> {
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid issue retrieval timeout.');
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const relay = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Issue retrieval timed out.')), timeoutMs);
    try {
      const issues = await this.#load(controller.signal);
      controller.signal.throwIfAborted();
      const retrievedAt = this.now();
      if (!Number.isFinite(retrievedAt.getTime())) throw new Error('Issue retrieval clock is invalid.');
      return { repository: this.repository, retrievedAt: retrievedAt.toISOString(), issues };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (controller.signal.aborted) throw new Error('Issue retrieval timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
    }
  }
}

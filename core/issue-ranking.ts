import type { IssueGateway, IssueSnapshot, RepositoryIssue } from '../github/issues.ts';

export interface RankedIssue extends RepositoryIssue {
  readonly score: number;
  readonly reasons: readonly string[];
}

export type IssuePriorityState =
  | { state: 'fresh'; repository: string; retrievedAt: string; issues: RankedIssue[] }
  | { state: 'stale'; repository: string; retrievedAt: string; failedAt: string; error: string; issues: RankedIssue[] }
  | { state: 'unavailable'; repository: string; attemptedAt: string; error: string; issues: [] };

const priorityScores = new Map([['p0', 100], ['p1', 75], ['p2', 50], ['p3', 25]]);

function clock(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error('Issue ranking clock is invalid.');
  return value.toISOString();
}

export function rankIssues(issues: readonly RepositoryIssue[], at: Date): RankedIssue[] {
  const now = at.getTime();
  if (!Number.isFinite(now)) throw new Error('Issue ranking clock is invalid.');
  const seen = new Set<string>();
  const ranked = issues.map(issue => {
    const identity = `${issue.repository}#${issue.number}`;
    if (seen.has(identity)) throw new Error('Cannot rank duplicate issues.');
    seen.add(identity);
    const labels = new Set(issue.labels.map(label => label.toLocaleLowerCase('en-US')));
    let score = 0;
    const reasons: string[] = [];
    for (const label of ['p0', 'p1', 'p2', 'p3']) {
      if (!labels.has(label)) continue;
      const points = priorityScores.get(label)!;
      score += points;
      reasons.push(`${points} points: ${label.toUpperCase()} priority label`);
      break;
    }
    if (labels.has('security')) { score += 40; reasons.push('40 points: security label'); }
    if (labels.has('bug')) { score += 20; reasons.push('20 points: bug label'); }
    const reactions = Math.min(issue.positiveReactions, 20);
    if (reactions) { score += reactions; reasons.push(`${reactions} point${reactions === 1 ? '' : 's'}: ${issue.positiveReactions} positive reaction${issue.positiveReactions === 1 ? '' : 's'}${issue.positiveReactions > 20 ? ' (cap 20)' : ''}`); }
    const comments = Math.min(issue.comments, 10);
    if (comments) { score += comments; reasons.push(`${comments} point${comments === 1 ? '' : 's'}: ${issue.comments} comment${issue.comments === 1 ? '' : 's'}${issue.comments > 10 ? ' (cap 10)' : ''}`); }
    const ageDays = Math.max(0, Math.floor((now - Date.parse(issue.createdAt)) / 86_400_000));
    const age = Math.min(12, Math.floor(ageDays / 30));
    if (age) { score += age; reasons.push(`${age} point${age === 1 ? '' : 's'}: ${ageDays} days old${ageDays >= 360 ? ' (cap 12)' : ''}`); }
    if (!reasons.length) reasons.push('No configured priority signals.');
    return { ...issue, labels: [...issue.labels], score, reasons };
  });
  return ranked.sort((left, right) => right.score - left.score
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.number - right.number);
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Issue retrieval failed.';
  return message.slice(0, 500) || 'Issue retrieval failed.';
}

function copyIssues(issues: readonly RankedIssue[]): RankedIssue[] {
  return issues.map(issue => ({ ...issue, labels: [...issue.labels], reasons: [...issue.reasons] }));
}

class SupersededIssueRefreshError extends Error {
  constructor() { super('Issue refresh was superseded by a newer request.'); }
}

export class IssuePrioritizer {
  readonly gateway: IssueGateway;
  readonly now: () => Date;
  #last: Extract<IssuePriorityState, { state: 'fresh' }> | null = null;
  #generation = 0;

  constructor(gateway: IssueGateway, now: () => Date = () => new Date()) {
    this.gateway = gateway;
    this.now = now;
  }

  async refresh(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<IssuePriorityState> {
    options.signal?.throwIfAborted();
    const generation = ++this.#generation;
    try {
      const snapshot: IssueSnapshot = await this.gateway.fetch(options);
      options.signal?.throwIfAborted();
      if (snapshot.repository !== this.gateway.repository) throw new Error('Issue snapshot repository mismatch.');
      if (snapshot.issues.some(issue => issue.repository !== snapshot.repository))
        throw new Error('Issue snapshot contains an issue from another repository.');
      const result: Extract<IssuePriorityState, { state: 'fresh' }> = {
        state: 'fresh',
        repository: snapshot.repository,
        retrievedAt: snapshot.retrievedAt,
        issues: rankIssues(snapshot.issues, new Date(snapshot.retrievedAt)),
      };
      if (generation !== this.#generation) throw new SupersededIssueRefreshError();
      this.#last = { ...result, issues: copyIssues(result.issues) };
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof SupersededIssueRefreshError || generation !== this.#generation)
        throw new SupersededIssueRefreshError();
      const attemptedAt = clock(this.now());
      if (!this.#last) return { state: 'unavailable', repository: this.gateway.repository, attemptedAt, error: failure(error), issues: [] };
      return {
        state: 'stale',
        repository: this.#last.repository,
        retrievedAt: this.#last.retrievedAt,
        failedAt: attemptedAt,
        error: failure(error),
        issues: copyIssues(this.#last.issues),
      };
    }
  }
}

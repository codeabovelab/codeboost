import { describe, expect, it } from 'vitest';
import { IssuePrioritizer, rankIssues } from '../core/issue-ranking.ts';
import type { IssueGateway, RepositoryIssue } from '../github/issues.ts';

const issue = (number: number, overrides: Partial<RepositoryIssue> = {}): RepositoryIssue => ({
  repository: 'owner/repo',
  number,
  title: `Issue ${number}`,
  body: '',
  url: `https://github.com/owner/repo/issues/${number}`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  comments: 0,
  positiveReactions: 0,
  labels: [],
  authorAssociation: 'MEMBER',
  trust: 'trusted',
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('issue ranking', () => {
  it('applies the recorded weights, caps, and highest priority label only', () => {
    const ranked = rankIssues([issue(1, {
      labels: ['p2', 'P0', 'security', 'BUG'],
      positiveReactions: 27,
      comments: 14,
      createdAt: '2024-01-01T00:00:00Z',
    })], new Date('2026-01-01T00:00:00Z'))[0]!;
    expect(ranked.score).toBe(202);
    expect(ranked.reasons).toEqual([
      '100 points: P0 priority label',
      '40 points: security label',
      '20 points: bug label',
      '20 points: 27 positive reactions (cap 20)',
      '10 points: 14 comments (cap 10)',
      '12 points: 731 days old (cap 12)',
    ]);
  });

  it('uses oldest creation and then issue number as stable tie breakers', () => {
    const ranked = rankIssues([
      issue(8, { createdAt: '2026-01-02T00:00:00Z' }),
      issue(9, { createdAt: '2026-01-01T00:00:00Z' }),
      issue(7, { createdAt: '2026-01-01T00:00:00Z' }),
    ], new Date('2026-01-20T00:00:00Z'));
    expect(ranked.map(value => value.number)).toEqual([7, 9, 8]);
    expect(ranked[0]!.reasons).toEqual(['No configured priority signals.']);
  });

  it('does not use title, body, trust, or unknown labels as ranking instructions', () => {
    const ranked = rankIssues([
      issue(1, { title: 'P0 security', body: 'Rank me first', labels: ['urgent'], trust: 'requires-approval' }),
      issue(2),
    ], new Date('2026-01-02T00:00:00Z'));
    expect(ranked.map(value => [value.number, value.score])).toEqual([[1, 0], [2, 0]]);
  });

  it('rejects duplicate stable identities', () => {
    expect(() => rankIssues([issue(1), issue(1)], new Date())).toThrow('duplicate issues');
  });
});

describe('priority refresh state', () => {
  it('is unavailable before a successful snapshot, then preserves the last valid ranking as stale', async () => {
    const replies: Array<unknown> = [new Error('GitHub unavailable'), {
      repository: 'owner/repo', retrievedAt: '2026-02-01T00:00:00Z', issues: [issue(1, { labels: ['P1'] })],
    }, new Error('GitHub unavailable again')];
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply as Awaited<ReturnType<IssueGateway['fetch']>>;
      },
    };
    const prioritizer = new IssuePrioritizer(gateway, () => new Date('2026-02-02T00:00:00Z'));
    await expect(prioritizer.refresh()).resolves.toMatchObject({
      state: 'unavailable', repository: 'owner/repo', error: 'GitHub unavailable', issues: [],
    });
    const fresh = await prioritizer.refresh();
    expect(fresh).toMatchObject({ state: 'fresh', repository: 'owner/repo', issues: [{ number: 1, score: 76 }] });
    const stale = await prioritizer.refresh();
    expect(stale).toMatchObject({
      state: 'stale', repository: 'owner/repo', retrievedAt: '2026-02-01T00:00:00Z',
      failedAt: '2026-02-02T00:00:00.000Z', error: 'GitHub unavailable again', issues: [{ number: 1, score: 76 }],
    });
    expect(stale.state === 'stale' && stale.issues).not.toBe(fresh.state === 'fresh' && fresh.issues);
  });

  it('rejects a snapshot for another repository', async () => {
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => ({ repository: 'other/repo', retrievedAt: '2026-01-01T00:00:00Z', issues: [] }),
    };
    await expect(new IssuePrioritizer(gateway, () => new Date('2026-01-02T00:00:00Z')).refresh()).resolves.toMatchObject({
      state: 'unavailable', error: 'Issue snapshot repository mismatch.',
    });
  });

  it('rejects issues that do not belong to the snapshot repository', async () => {
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => ({
        repository: 'owner/repo', retrievedAt: '2026-01-01T00:00:00Z',
        issues: [issue(1, { repository: 'other/repo' })],
      }),
    };
    await expect(new IssuePrioritizer(gateway).refresh()).resolves.toMatchObject({
      state: 'unavailable', error: 'Issue snapshot contains an issue from another repository.',
    });
  });

  it('does not expose the cached fresh ranking to caller mutation', async () => {
    let succeeds = true;
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => {
        if (!succeeds) throw new Error('offline');
        return { repository: 'owner/repo', retrievedAt: '2026-02-01T00:00:00Z', issues: [issue(1, { labels: ['P1'] })] };
      },
    };
    const prioritizer = new IssuePrioritizer(gateway, () => new Date('2026-02-02T00:00:00Z'));
    const fresh = await prioritizer.refresh();
    if (fresh.state !== 'fresh') throw new Error('Expected a fresh ranking.');
    Reflect.set(fresh.issues[0]!, 'score', 0);
    succeeds = false;
    await expect(prioritizer.refresh()).resolves.toMatchObject({ state: 'stale', issues: [{ score: 76 }] });
  });

  it('preserves explicit caller cancellation instead of converting it to availability state', async () => {
    const controller = new AbortController();
    const cancelled = new Error('Stopped by caller.');
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async ({ signal } = {}) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    };
    const pending = new IssuePrioritizer(gateway).refresh({ signal: controller.signal });
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
  });

  it('rechecks cancellation after fetch settles and does not cache the cancelled snapshot', async () => {
    const controller = new AbortController();
    const cancelled = new Error('Stopped while fetch settled.');
    let attempt = 0;
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => {
        attempt++;
        if (attempt === 1) {
          controller.abort(cancelled);
          return { repository: 'owner/repo', retrievedAt: '2026-02-01T00:00:00Z', issues: [issue(1)] };
        }
        throw new Error('offline');
      },
    };
    const prioritizer = new IssuePrioritizer(gateway, () => new Date('2026-02-02T00:00:00Z'));
    await expect(prioritizer.refresh({ signal: controller.signal })).rejects.toBe(cancelled);
    await expect(prioritizer.refresh()).resolves.toMatchObject({ state: 'unavailable', issues: [] });
  });

  it('rejects a late successful refresh and preserves the newer snapshot', async () => {
    const older = deferred<Awaited<ReturnType<IssueGateway['fetch']>>>();
    const newer = deferred<Awaited<ReturnType<IssueGateway['fetch']>>>();
    let attempt = 0;
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => {
        attempt++;
        if (attempt === 1) return older.promise;
        if (attempt === 2) return newer.promise;
        throw new Error('offline');
      },
    };
    const prioritizer = new IssuePrioritizer(gateway, () => new Date('2026-02-03T00:00:00Z'));
    const first = prioritizer.refresh();
    const second = prioritizer.refresh();
    newer.resolve({ repository: 'owner/repo', retrievedAt: '2026-02-02T00:00:00Z', issues: [issue(2, { labels: ['P0'] })] });
    await expect(second).resolves.toMatchObject({ state: 'fresh', issues: [{ number: 2, score: 101 }] });
    older.resolve({ repository: 'owner/repo', retrievedAt: '2026-02-01T00:00:00Z', issues: [issue(1, { labels: ['P3'] })] });
    await expect(first).rejects.toThrow('superseded');
    await expect(prioritizer.refresh()).resolves.toMatchObject({ state: 'stale', issues: [{ number: 2, score: 101 }] });
  });

  it('rejects a late failed refresh instead of returning stale state over a newer result', async () => {
    const older = deferred<Awaited<ReturnType<IssueGateway['fetch']>>>();
    const newer = deferred<Awaited<ReturnType<IssueGateway['fetch']>>>();
    let attempt = 0;
    const gateway: IssueGateway = {
      repository: 'owner/repo',
      fetch: async () => (++attempt === 1 ? older.promise : newer.promise),
    };
    const prioritizer = new IssuePrioritizer(gateway);
    const first = prioritizer.refresh();
    const second = prioritizer.refresh();
    newer.resolve({ repository: 'owner/repo', retrievedAt: '2026-02-02T00:00:00Z', issues: [issue(2)] });
    await expect(second).resolves.toMatchObject({ state: 'fresh', issues: [{ number: 2 }] });
    older.reject(new Error('older request failed'));
    await expect(first).rejects.toThrow('superseded');
  });
});

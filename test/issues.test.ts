import { describe, expect, it, vi } from 'vitest';
import { GhIssueGateway } from '../github/issues.ts';

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Fix retries',
  body: 'Keep issue text as data.',
  html_url: 'https://github.com/owner/repo/issues/7',
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  comments: 3,
  author_association: 'MEMBER',
  labels: [{ name: 'bug' }, { name: 'P1' }],
  reactions: { '+1': 2, heart: 1, hooray: 0, rocket: 1 },
  ...overrides,
});

describe('GitHub issue retrieval', () => {
  it.each(['./repo', '../repo', 'owner/..'])('rejects unsafe repository identity %s', repository => {
    expect(() => new GhIssueGateway(repository)).toThrow('GitHub repository');
  });

  it('uses literal read-only pagination arguments and normalizes trusted issues', async () => {
    const calls: readonly string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      (calls as string[][]).push([...args]);
      return JSON.stringify([rawIssue()]);
    });
    const snapshot = await new GhIssueGateway('owner/repo', run, () => new Date('2026-02-01T00:00:00Z')).fetch();
    expect(calls).toEqual([[
      'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
      'repos/owner/repo/issues', '-f', 'state=open', '-f', 'per_page=100', '-f', 'page=1',
    ]]);
    expect(snapshot).toEqual({
      repository: 'owner/repo',
      retrievedAt: '2026-02-01T00:00:00.000Z',
      issues: [{
        repository: 'owner/repo', number: 7, title: 'Fix retries', body: 'Keep issue text as data.',
        url: 'https://github.com/owner/repo/issues/7', createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z', comments: 3, positiveReactions: 4,
        labels: ['bug', 'P1'], authorAssociation: 'MEMBER', trust: 'trusted',
      }],
    });
  });

  it('excludes pull requests and requires approval for outside authors', async () => {
    const run = vi.fn(async () => JSON.stringify([
      rawIssue({ pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/7' } }),
      rawIssue({ number: 8, html_url: 'https://github.com/owner/repo/issues/8', author_association: 'CONTRIBUTOR' }),
    ]));
    const snapshot = await new GhIssueGateway('owner/repo', run).fetch();
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ number: 8, trust: 'requires-approval' });
  });

  it('accepts the maximum bounded issue body', async () => {
    const gateway = new GhIssueGateway('owner/repo', async () => JSON.stringify([
      rawIssue({ body: 'x'.repeat(65_536) }),
    ]));
    const snapshot = await gateway.fetch();
    expect(snapshot.issues[0]?.body).toHaveLength(65_536);
  });

  it.each([
    ['repository URL', { html_url: 'https://github.com/other/repo/issues/7' }],
    ['state', { state: 'closed' }],
    ['pull request marker', { pull_request: {} }],
    ['author association', { author_association: 'UNKNOWN' }],
    ['title', { title: '   ' }],
    ['body length', { body: 'x'.repeat(65_537) }],
    ['comments', { comments: -1 }],
    ['reactions', { reactions: { '+1': 0, heart: 0, hooray: 0 } }],
    ['labels', { labels: [{ name: 'bug' }, { name: 'BUG' }] }],
    ['timestamps', { updated_at: '2025-01-01T00:00:00Z' }],
    ['calendar timestamp', { created_at: '2026-02-31T00:00:00Z' }],
  ])('fails the complete refresh on invalid %s', async (_label, overrides) => {
    const gateway = new GhIssueGateway('owner/repo', async () => JSON.stringify([rawIssue(overrides)]));
    await expect(gateway.fetch()).rejects.toThrow(/GitHub returned/);
  });

  it('rejects duplicate records across pages', async () => {
    let page = 0;
    const gateway = new GhIssueGateway('owner/repo', async () => {
      page++;
      return JSON.stringify(page === 1
        ? Array.from({ length: 100 }, (_, index) => rawIssue({ number: index + 1, html_url: `https://github.com/owner/repo/issues/${index + 1}` }))
        : [rawIssue({ number: 1, html_url: 'https://github.com/owner/repo/issues/1' })]);
    });
    await expect(gateway.fetch()).rejects.toThrow('duplicate issue');
  });

  it('fails closed when the bounded page limit is exhausted', async () => {
    const gateway = new GhIssueGateway('owner/repo', async args => {
      const page = Number(args.at(-1)?.split('=')[1]);
      return JSON.stringify(Array.from({ length: 100 }, (_, index) => {
        const number = (page - 1) * 100 + index + 1;
        return rawIssue({ number, html_url: `https://github.com/owner/repo/issues/${number}` });
      }));
    });
    await expect(gateway.fetch()).rejects.toThrow('1000-record safety limit');
  });

  it('preserves caller cancellation and classifies its own deadline', async () => {
    const run = vi.fn((_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const cancelled = new Error('Stopped by caller.');
    const first = new GhIssueGateway('owner/repo', run).fetch({ signal: controller.signal });
    controller.abort(cancelled);
    await expect(first).rejects.toBe(cancelled);
    await expect(new GhIssueGateway('owner/repo', run).fetch({ timeoutMs: 1 })).rejects.toThrow('timed out');
  });

  it('rechecks caller cancellation after a runner returns successfully', async () => {
    const controller = new AbortController();
    const cancelled = new Error('Stopped while the response settled.');
    const gateway = new GhIssueGateway('owner/repo', async () => {
      controller.abort(cancelled);
      return JSON.stringify([rawIssue()]);
    });
    await expect(gateway.fetch({ signal: controller.signal })).rejects.toBe(cancelled);
  });
});

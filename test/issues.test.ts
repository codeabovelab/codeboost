import { describe, expect, it, vi } from 'vitest';
import { GhIssueGateway, ISSUE_PAGE_MAX_BYTES, type IssueText } from '../github/issues.ts';
import { prepareExecution } from '../core/execution-prompt.ts';

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Fix retries',
  body: 'Keep issue text as data.',
  html_url: 'https://github.com/owner/repo/issues/7',
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  comments: 3,
  user: { login: 'member' },
  author_association: 'MEMBER',
  labels: [{ name: 'bug' }, { name: 'P1' }],
  reactions: { '+1': 2, heart: 1, hooray: 0, rocket: 1 },
  ...overrides,
});

const isCollaboratorRequest = (args: readonly string[]) =>
  args.some(argument => argument.toLocaleLowerCase('en-US').endsWith('/collaborators'));
const responses = (issues: readonly unknown[], collaborators: readonly string[] = ['MEMBER']) =>
  async (args: readonly string[]) => JSON.stringify(isCollaboratorRequest(args)
    ? collaborators.map(login => ({ login }))
    : issues);

describe('GitHub issue retrieval', () => {
  it.each([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
    'CONTRIBUTOR',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'MANNEQUIN',
    'NONE',
  ] as const)('classifies the intermediate %s association using current repository membership', async (authorAssociation) => {
    const issue = rawIssue({ author_association: authorAssociation });
    const trusted = await new GhIssueGateway('owner/repo', responses([issue])).fetch();
    const outside = await new GhIssueGateway('owner/repo', responses([issue], [])).fetch();
    expect(trusted.issues[0]).toMatchObject({ authorAssociation, authorLogin: 'member', trust: 'trusted' });
    expect(outside.issues[0]).toMatchObject({ authorAssociation, authorLogin: 'member', trust: 'requires-approval' });
  });

  it.each(['./repo', '../repo', 'owner/..'])('rejects unsafe repository identity %s', repository => {
    expect(() => new GhIssueGateway(repository)).toThrow('GitHub repository');
  });

  it('uses literal read-only pagination arguments and normalizes trusted issues', async () => {
    const calls: readonly string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      (calls as string[][]).push([...args]);
      return responses([rawIssue()])(args);
    });
    const snapshot = await new GhIssueGateway('owner/repo', run, () => new Date('2026-02-01T00:00:00Z')).fetch();
    expect(calls).toEqual([[
      'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
      'repos/owner/repo/issues', '-f', 'state=open', '-f', 'per_page=100', '-f', 'page=1',
    ], [
      'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
      'repos/owner/repo/collaborators', '-f', 'affiliation=all', '-f', 'per_page=100', '-f', 'page=1',
    ]]);
    expect(snapshot).toEqual({
      repository: 'owner/repo',
      retrievedAt: '2026-02-01T00:00:00.000Z',
      issues: [{
        repository: 'owner/repo', number: 7, title: 'Fix retries', body: 'Keep issue text as data.',
        url: 'https://github.com/owner/repo/issues/7', createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z', comments: 3, positiveReactions: 4,
        labels: ['bug', 'P1'], authorLogin: 'member', authorAssociation: 'MEMBER', trust: 'trusted',
      }],
    });
  });

  it('excludes pull requests and requires approval for outside authors', async () => {
    const run = vi.fn(responses([
      rawIssue({ pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/7' } }),
      rawIssue({ number: 8, html_url: 'https://github.com/owner/repo/issues/8', author_association: 'CONTRIBUTOR' }),
    ], []));
    const snapshot = await new GhIssueGateway('owner/repo', run).fetch();
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ number: 8, trust: 'requires-approval' });
  });

  it('accepts canonical URL casing without relaxing repository identity or URL shape', async () => {
    const run = vi.fn(responses([
      rawIssue(),
      rawIssue({
        number: 8,
        html_url: 'https://github.com/owner/repo/issues/8',
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/8' },
      }),
    ]));
    const snapshot = await new GhIssueGateway('Owner/Repo', run).fetch();
    expect(snapshot).toMatchObject({ repository: 'Owner/Repo', issues: [{ repository: 'Owner/Repo', number: 7 }] });
  });

  it('accepts the maximum bounded issue body', async () => {
    const gateway = new GhIssueGateway('owner/repo', responses([
      rawIssue({ body: 'x'.repeat(65_536) }),
    ]));
    const snapshot = await gateway.fetch();
    expect(snapshot.issues[0]?.body).toHaveLength(65_536);
  });

  it('requires approval when GitHub explicitly reports a deleted author', async () => {
    const snapshot = await new GhIssueGateway('owner/repo', responses([
      rawIssue({ user: null, author_association: 'OWNER' }),
    ])).fetch();
    expect(snapshot.issues[0]).toMatchObject({ authorLogin: null, trust: 'requires-approval' });
  });

  it('fails closed on collaborator-access failure even when every author is deleted', async () => {
    const gateway = new GhIssueGateway('owner/repo', async args => {
      if (isCollaboratorRequest(args)) throw new Error('Collaborators unavailable.');
      return JSON.stringify([rawIssue({ user: null, author_association: 'OWNER' })]);
    });
    await expect(gateway.fetch()).rejects.toThrow('Collaborators unavailable.');
  });

  it('fails closed on collaborator-access failure even when no issues are open', async () => {
    const gateway = new GhIssueGateway('owner/repo', async args => {
      if (isCollaboratorRequest(args)) throw new Error('Collaborators unavailable.');
      return '[]';
    });
    await expect(gateway.fetch()).rejects.toThrow('Collaborators unavailable.');
  });

  it('budgets for a maximum page of JSON-escaped control-character bodies', () => {
    const body = '\0'.repeat(65_536);
    const page = Array.from({ length: 100 }, (_, index) => rawIssue({
      number: index + 1,
      html_url: `https://github.com/owner/repo/issues/${index + 1}`,
      body,
    }));
    const serializedBytes = Buffer.byteLength(JSON.stringify(page));
    expect(serializedBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(serializedBytes).toBeLessThan(ISSUE_PAGE_MAX_BYTES);
  });

  it.each([
    ['repository URL', { html_url: 'https://github.com/other/repo/issues/7' }],
    ['state', { state: 'closed' }],
    ['pull request marker', { pull_request: {} }],
    ['author association', { author_association: 'UNKNOWN' }],
    ['author object', { user: 42 }],
    ['author login', { user: { login: '' } }],
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

  it('fails closed when collaborator pagination reaches its bounded limit', async () => {
    const gateway = new GhIssueGateway('owner/repo', async args => {
      if (!isCollaboratorRequest(args)) return JSON.stringify([rawIssue()]);
      const page = Number(args.at(-1)?.split('=')[1]);
      return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        login: `member-${(page - 1) * 100 + index + 1}`,
      })));
    });
    await expect(gateway.fetch()).rejects.toThrow('Collaborator retrieval exceeded the 1000-record safety limit');
  });

  it('distinguishes an omitted author from an explicitly deleted author', async () => {
    const issue: Record<string, unknown> = rawIssue();
    delete issue.user;
    await expect(new GhIssueGateway('owner/repo', responses([issue])).fetch())
      .rejects.toThrow('omitted the issue author');
  });

  it.each([
    ['page shape', {}],
    ['record shape', [null]],
    ['login', [{ login: '' }]],
    ['duplicate', [{ login: 'member' }, { login: 'MEMBER' }]],
  ])('fails closed on invalid collaborator %s', async (_label, collaboratorPage) => {
    const gateway = new GhIssueGateway('owner/repo', async args => JSON.stringify(
      isCollaboratorRequest(args) ? collaboratorPage : [rawIssue()],
    ));
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

describe('issue text for an execute prompt (#91)', () => {
  const comment = (login: string | null, body: string) => ({ body, user: login === null ? null : { login } });
  const gateway = (pages: unknown[][], issue: Record<string, unknown> = rawIssue(), collaborators = ['member']) => {
    const calls: string[][] = [];
    return { calls, gateway: new GhIssueGateway('owner/repo', async args => {
      calls.push([...args]);
      if (isCollaboratorRequest(args)) return JSON.stringify(collaborators.map(login => ({ login })));
      const path = args[5]!;
      if (path.endsWith('/comments')) return JSON.stringify(pages[Number(args.at(-1)!.split('=')[1]) - 1] ?? []);
      return JSON.stringify(issue);
    }) };
  };
  it('keeps only collaborators\' comments, oldest first, across pages', async () => {
    const full = Array.from({ length: 100 }, (_, n) => comment(n % 2 ? 'Member' : 'outsider', `c${n}`));
    const { gateway: g, calls } = gateway([full, [comment('member', 'last'), comment(null, 'ghost')]]);
    const text = await g.issueText(7);
    expect(text).toMatchObject({ number: 7, title: 'Fix retries', body: 'Keep issue text as data.' });
    expect(text.comments).toEqual([...full.filter((_, n) => n % 2).map(c => c.body), 'last']);
    expect(calls.filter(args => args[5]!.endsWith('/comments')).map(args => args.at(-1))).toEqual(['page=1', 'page=2']);
  });
  it('includes every comment only when trust matches the issue current author', async () => {
    const comments = [comment('member', 'collaborator'), comment('outsider', 'outside'), comment(null, 'ghost')];
    const fixture = gateway([comments], rawIssue({ user: { login: 'outside-author' } })), g = fixture.gateway;
    expect((await g.issueText(7)).comments).toEqual(['collaborator']);
    expect((await g.issueText(7, { trustedAuthor: 'old-author' })).comments).toEqual(['collaborator']);
    expect((await g.issueText(7, { trustedAuthor: 'outside-author' })).comments).toEqual(['collaborator', 'outside', 'ghost']);
    expect(fixture.calls.filter(isCollaboratorRequest)).toHaveLength(2);
  });
  it('reads the current author and collaborator list as one bounded admission decision', async () => {
    await expect(gateway([], rawIssue({ user: { login: 'Member' } })).gateway.issueAccess(7)).resolves.toEqual({
      number: 7, authorLogin: 'Member', collaborator: true,
    });
    await expect(gateway([], rawIssue({ user: null })).gateway.issueAccess(7)).resolves.toEqual({
      number: 7, authorLogin: null, collaborator: false,
    });
  });
  it('refuses text when its current author or collaborator access differs from admission', async () => {
    const changedAuthor = gateway([], rawIssue({ user: { login: 'other' } }), ['other']).gateway;
    await expect(changedAuthor.issueText(7, { expectedAccess: { number: 7, authorLogin: 'member', collaborator: true } }))
      .rejects.toThrow(/author or collaborator access changed during admission/);
    const changedAccess = gateway([], rawIssue({ user: { login: 'member' } }), []).gateway;
    await expect(changedAccess.issueText(7, { expectedAccess: { number: 7, authorLogin: 'member', collaborator: true } }))
      .rejects.toThrow(/author or collaborator access changed during admission/);
  });
  it('refuses a pull request, a different issue, and text too long for a prompt', async () => {
    await expect(gateway([], rawIssue({ pull_request: { url: 'x' } })).gateway.issueText(7)).rejects.toThrow(/is a pull request/);
    await expect(gateway([], rawIssue({ number: 8 })).gateway.issueText(7)).rejects.toThrow(/different issue/);
    const long = Array.from({ length: 9 }, () => comment('member', 'x'.repeat(65_000)));
    await expect(gateway([long]).gateway.issueText(7)).rejects.toThrow(/larger than the 32 KiB an execute prompt carries/);
  });
  it('accepts exactly what an execute prompt can carry, end to end, and refuses the rest at the fetch (#91)', async () => {
    const promptOf = (issue: IssueText) => prepareExecution({ identity: { repositoryId: 'repo', taskId: 'task', planId: 'plan' }, attemptId: 'attempt-1',
      mode: 'execute', itemId: 'P1', approvedLessons: [], allowedCommands: [], issue,
      plan: { schema_version: 1, issue: 7, revision: 1, summary: 'S', questions: [], items: [{ id: 'P1', title: 'T', intent: 'I',
        files: [{ path: 'a', kind: 'edit', renamed_from: null, change: 'x' }], acceptance: [], depends_on: [] }] } });
    // Under the budget: what the fetch returns, the prompt carries.
    const fits = await gateway([[comment('member', 'x'.repeat(30_000))]]).gateway.issueText(7);
    expect(promptOf(fits).prompt).toContain('x'.repeat(30_000));
    // Small in characters, over the budget once escaped as the prompt escapes it ('<' becomes \u003c): refused at the
    // fetch, with the reason, instead of at every attempt's preparation.
    await expect(gateway([[comment('member', '<'.repeat(6_000))]]).gateway.issueText(7)).rejects.toThrow(/larger than the 32 KiB/);
    expect(() => promptOf({ number: 7, title: 'Fix retries', body: 'Keep issue text as data.', comments: ['<'.repeat(6_000)] })).toThrow(/exceeds 32 KiB/);
  });
  it('ignores an oversized comment from someone else, and reads exactly the page limit', async () => {
    const huge = comment('outsider', 'x'.repeat(70_000));
    expect((await gateway([[huge, comment('member', 'kept')]]).gateway.issueText(7)).comments).toEqual(['kept']);
    const pages = Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => comment('outsider', 'spam')));
    expect((await gateway(pages).gateway.issueText(7)).comments).toEqual([]);
    await expect(gateway([...pages, [comment('outsider', 'one more')]]).gateway.issueText(7)).rejects.toThrow(/more than 1000 comments/);
  });
  it('refuses a title and body already over the prompt budget before reading any collaborator or comment page', async () => {
    const { gateway: g, calls } = gateway([[comment('member', 'never read')]], rawIssue({ body: 'x'.repeat(40_000) }));
    await expect(g.issueText(7)).rejects.toThrow(/larger than the 32 KiB/);
    expect(calls.map(args => args[5])).toEqual(['repos/owner/repo/issues/7']);
    // Small in bytes, over the budget once the prompt escapes it ('<' becomes \u003c): refused just as early.
    const escaped = gateway([[comment('member', 'never read')]], rawIssue({ body: '<'.repeat(6_000) }));
    await expect(escaped.gateway.issueText(7)).rejects.toThrow(/larger than the 32 KiB/);
    expect(escaped.calls.map(args => args[5])).toEqual(['repos/owner/repo/issues/7']);
  });
  it('stops on the caller\'s abort', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(gateway([]).gateway.issueText(7, { signal: controller.signal })).rejects.toThrow(/stopped/);
  });
});

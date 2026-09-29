import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECK_DEADLINE_MS, GhAlreadyFixedGateway, MAX_BASE_COMMITS, mentionsIssue, type AlreadyFixedInput } from '../github/already-fixed.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const repo = 'Owner/Repo';
const pr = (number: number, state = 'OPEN', extra: Record<string, unknown> = {}) =>
  ({ __typename: 'PullRequest', number, state, isDraft: false, repository: { nameWithOwner: repo }, ...extra });
const cross = (source: unknown) => ({ __typename: 'CrossReferencedEvent', source });
const connected = (subject: unknown) => ({ __typename: 'ConnectedEvent', subject });
const disconnected = (subject: unknown) => ({ __typename: 'DisconnectedEvent', subject });
const closed = (closer: unknown) => ({ __typename: 'ClosedEvent', closer });

interface Fake { state?: string; nodes?: unknown[]; totalCount?: number; hasNextPage?: boolean; errors?: unknown; nameWithOwner?: string;
  commits?: { sha: string; message: string }[]; status?: string; totalCommits?: number; baseRef?: string; fail?: RegExp }
function gateway(fake: Fake = {}) {
  const calls: string[][] = [];
  const nodes = fake.nodes ?? [];
  const commits = fake.commits ?? [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const joined = args.join(' ');
    if (fake.fail?.test(joined)) throw new Error('HTTP 502');
    if (args[1] === 'graphql') return JSON.stringify({
      ...(fake.errors !== undefined ? { errors: fake.errors } : {}),
      data: { repository: { nameWithOwner: fake.nameWithOwner ?? 'owner/repo', issue: { state: fake.state ?? 'OPEN',
        timelineItems: { totalCount: fake.totalCount ?? nodes.length, pageInfo: { hasNextPage: fake.hasNextPage ?? false }, nodes } } } },
    });
    if (joined.includes('/git/ref/heads/')) return JSON.stringify({ ref: `refs/heads/${fake.baseRef ?? 'main'}`, object: { sha: sha(99) } });
    const page = Number(/[?&]page=(\d+)/.exec(joined)![1]);
    return JSON.stringify({ status: fake.status ?? 'ahead', total_commits: fake.totalCommits ?? commits.length,
      commits: commits.slice((page - 1) * 100, page * 100).map(c => ({ sha: c.sha, commit: { message: c.message } })) });
  };
  return { calls, gh: new GhAlreadyFixedGateway({ repository: repo }, run) };
}
const input = (over: Partial<AlreadyFixedInput> = {}): AlreadyFixedInput =>
  ({ issue: 12, taskBase: sha(1), baseBranch: 'main', ownPullRequests: [], ownCommits: new Set(), ...over });

describe('issue mentions in commit messages', () => {
  it('matches this issue by number, GH- form, qualified name or URL, and nothing else', () => {
    for (const message of ['Fix #12', 'fixes #12.', '(#12)', 'Resolve GH-12', 'owner/repo#12', 'See https://github.com/Owner/Repo/issues/12 for context'])
      expect(mentionsIssue(message, repo, 12), message).toBe(true);
    for (const message of ['Fix #123', 'Fix #1', 'other/repo#12', 'x#12', 'issue 12', 'https://github.com/owner/repo/issues/120', 'https://github.com/other/repo/issues/12', 'GH-120', 'owner/repo2#12'])
      expect(mentionsIssue(message, repo, 12), message).toBe(false);
  });
});

describe('the pre-PR already-fixed check', () => {
  it('is clear when nothing links, closes or mentions the issue, and reports the base head it read', async () => {
    const { gh, calls } = gateway({ nodes: [cross({ __typename: 'Issue' })], commits: [{ sha: sha(5), message: 'Unrelated' }] });
    expect(await gh.check(input())).toEqual({ outcome: 'clear', baseHead: sha(99) });
    expect(calls.map(call => call.find(arg => arg.startsWith('repos/')) ?? call[1])).toEqual(['graphql', 'repos/Owner/Repo/git/ref/heads/main', `repos/Owner/Repo/compare/${sha(1)}...${sha(99)}?per_page=100&page=1`]);
  });
  it('finds other open or merged PRs that link the issue, but not closed ones', async () => {
    const { gh } = gateway({ nodes: [cross(pr(401)), connected(pr(402, 'MERGED', { isDraft: false })), cross(pr(403, 'CLOSED')), cross(pr(401))] });
    expect(await gh.check(input())).toMatchObject({ outcome: 'found', matches: [
      { kind: 'pull request', repository: repo, number: 401, state: 'OPEN' }, { kind: 'pull request', number: 402, state: 'MERGED' }] });
  });
  it('replays manual links: a later disconnect removes a connected PR, a later connect restores it, a cross-reference stays', async () => {
    expect(await gateway({ nodes: [connected(pr(401)), disconnected(pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
    expect(await gateway({ nodes: [connected(pr(401)), disconnected(pr(401)), connected(pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ number: 401 }] });
    expect(await gateway({ nodes: [cross(pr(401)), connected(pr(401)), disconnected(pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ number: 401 }] });
  });
  it("ignores the task's own PR and earlier drafts by repository and number", async () => {
    const { gh } = gateway({ nodes: [cross(pr(7)), cross(pr(8, 'OPEN', { isDraft: true }))] });
    expect(await gh.check(input({ ownPullRequests: [7, 8] }))).toMatchObject({ outcome: 'clear' });
  });
  it('does not exclude a PR in another repository that has the same number as an own PR', async () => {
    const { gh } = gateway({ nodes: [cross(pr(7, 'OPEN', { repository: { nameWithOwner: 'fork/repo' } }))] });
    expect(await gh.check(input({ ownPullRequests: [7] }))).toMatchObject({ outcome: 'found', matches: [{ repository: 'fork/repo', number: 7 }] });
  });
  it('reports an issue closed by someone else, and ignores one closed by an own PR or commit', async () => {
    expect(await gateway({ state: 'CLOSED', nodes: [closed(null)] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed' }] });
    expect(await gateway({ state: 'CLOSED', nodes: [closed(pr(9))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: `${repo}#9` }] });
    expect(await gateway({ state: 'CLOSED', nodes: [closed(pr(9))] }).gh.check(input({ ownPullRequests: [9] }))).toMatchObject({ outcome: 'clear' });
    expect(await gateway({ state: 'CLOSED', nodes: [closed({ __typename: 'Commit', oid: sha(3) })] }).gh.check(input({ ownCommits: new Set([sha(3)]) }))).toMatchObject({ outcome: 'clear' });
    // Only the latest close counts: an earlier close by someone else was followed by a reopen and an own close.
    expect(await gateway({ state: 'CLOSED', nodes: [closed(null), closed(pr(9))] }).gh.check(input({ ownPullRequests: [9] }))).toMatchObject({ outcome: 'clear' });
    // A reopened issue does not count as closed.
    expect(await gateway({ state: 'OPEN', nodes: [closed(null)] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
  });
  it('treats an issue closed by a Projects workflow as closed by someone else, not as unreadable', async () => {
    expect(await gateway({ state: 'CLOSED', nodes: [closed({ __typename: 'ProjectV2', number: 3 })] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: 'a project workflow' }] });
  });
  it('runs the timeline and base-commit reads together, and a failure in one stops the other', async () => {
    let timelineAborted = false;
    const gh = new GhAlreadyFixedGateway({ repository: repo, deadlineMs: 10_000 }, async (args, options) => {
      if (args[1] === 'graphql') return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => { timelineAborted = true; reject(new Error('killed')); }));
      throw new Error('HTTP 502');
    });
    const started = Date.now();
    expect(await gh.check(input())).toMatchObject({ outcome: 'unknown', reason: 'GitHub could not be read.' });
    expect(timelineAborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it('finds new base-branch commits that mention the issue, except its own commits', async () => {
    const commits = [{ sha: sha(5), message: 'Fix crash (#12)\n\nlong body' }, { sha: sha(6), message: 'P1: own change, refs #12' }, { sha: sha(7), message: 'Fix #123' }];
    expect(await gateway({ commits }).gh.check(input({ ownCommits: new Set([sha(6)]) }))).toMatchObject({ outcome: 'found', matches: [{ kind: 'commit', sha: sha(5), subject: 'Fix crash (#12)' }] });
  });
  it('reads every page of base commits', async () => {
    const commits = Array.from({ length: 230 }, (_, i) => ({ sha: sha(1000 + i), message: i === 229 ? 'Late fix for #12' : 'Other' }));
    const { gh, calls } = gateway({ commits });
    expect(await gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'commit', sha: sha(1229) }] });
    expect(calls.filter(call => call.some(arg => arg.includes('/compare/')))).toHaveLength(3);
  });
  it('fails closed past every bound and on unreadable or inconsistent answers', async () => {
    const cases: Fake[] = [
      { totalCount: 101 }, { hasNextPage: true }, { nodes: [cross(pr(1))], totalCount: 2 },
      { commits: Array.from({ length: MAX_BASE_COMMITS + 1 }, (_, i) => ({ sha: sha(2000 + i), message: 'x' })) }, { status: 'diverged' }, { status: 'behind' },
      { commits: [{ sha: sha(5), message: 'x' }], totalCommits: 2 },
      { errors: [{ message: 'rate limited' }] }, { nameWithOwner: 'other/repo' }, { baseRef: 'other' },
      { state: 'CLOSED' }, { nodes: [cross(null)] }, { nodes: [cross({ __typename: 'Discussion' })] },
      { nodes: [cross(pr(1, 'OPEN', { repository: null }))] }, { nodes: [{ __typename: 'LabeledEvent' }] },
      { fail: /graphql/ }, { fail: /compare/ },
    ];
    for (const fake of cases) expect(await gateway(fake).gh.check(input()), JSON.stringify(fake)).toMatchObject({ outcome: 'unknown' });
  });
  it('gives the whole check one deadline and aborts the running call when it passes', async () => {
    let aborted = false;
    const gh = new GhAlreadyFixedGateway({ repository: repo, deadlineMs: 50 }, (_args, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('killed')); });
    }));
    expect(await gh.check(input())).toEqual({ outcome: 'unknown', reason: 'The check did not finish within 1 s.' });
    expect(aborted).toBe(true);
  });
  it('defaults to a deadline below the 15-second serving request budget', () => {
    expect(DEFAULT_CHECK_DEADLINE_MS).toBeLessThan(15_000);
    expect(new GhAlreadyFixedGateway({ repository: repo }).deadlineMs).toBe(DEFAULT_CHECK_DEADLINE_MS);
  });
  it('returns only after the stopped stage has settled', async () => {
    let timelineSettled = false;
    const gh = new GhAlreadyFixedGateway({ repository: repo, deadlineMs: 10_000 }, async (args, options) => {
      if (args[1] === 'graphql') return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => setTimeout(() => { timelineSettled = true; reject(new Error('killed')); }, 100)));
      throw new Error('HTTP 502');
    });
    expect(await gh.check(input())).toMatchObject({ outcome: 'unknown' });
    expect(timelineSettled).toBe(true);
  });
  it('passes cancellation through instead of reporting it as unknown', async () => {
    const controller = new AbortController();
    const gh = new GhAlreadyFixedGateway({ repository: repo }, async () => { controller.abort(); throw new Error('aborted'); });
    await expect(gh.check(input(), controller.signal)).rejects.toThrow('aborted');
  });
  it('refuses invalid input before calling GitHub', async () => {
    const { gh, calls } = gateway();
    for (const bad of [{ issue: 0 }, { taskBase: 'HEAD' }, { baseBranch: '-x' }, { baseBranch: 'a..b' }, { ownPullRequests: [0] }])
      await expect(gh.check(input(bad as Partial<AlreadyFixedInput>))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

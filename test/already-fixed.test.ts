import { describe, expect, it } from 'vitest';
import { CHECK_KILL_GRACE_MS, CHECK_PIPE_GRACE_MS, DEFAULT_CHECK_DEADLINE_MS, GhAlreadyFixedGateway, MAX_BASE_COMMITS, mentionsIssue, type AlreadyFixedInput } from '../github/already-fixed.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const repo = 'Owner/Repo';
const pr = (number: number, state = 'OPEN', extra: Record<string, unknown> = {}) =>
  ({ __typename: 'PullRequest', number, state, isDraft: false, baseRefName: 'main', repository: { nameWithOwner: repo }, ...extra });
const cross = (source: unknown, willCloseTarget: unknown = true) => ({ __typename: 'CrossReferencedEvent', willCloseTarget, source });
const issue = { __typename: 'Issue' };
const connected = (subject: unknown, source: unknown = issue) => ({ __typename: 'ConnectedEvent', source, subject });
const disconnected = (subject: unknown, source: unknown = issue) => ({ __typename: 'DisconnectedEvent', source, subject });
const closed = (closer: unknown) => ({ __typename: 'ClosedEvent', closer });

interface Fake { defaultBranch?: unknown; state?: string; nodes?: unknown[]; totalCount?: number; hasNextPage?: boolean; errors?: unknown; nameWithOwner?: string;
  commits?: { sha: string; message: string }[]; status?: string; totalCommits?: number; totalCommitsLater?: number; baseSha?: string; baseRef?: string; fail?: RegExp }
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
      data: { repository: { nameWithOwner: fake.nameWithOwner ?? 'owner/repo', defaultBranchRef: fake.defaultBranch === undefined ? { name: 'main' } : fake.defaultBranch, issue: { state: fake.state ?? 'OPEN',
        timelineItems: { totalCount: fake.totalCount ?? nodes.length, pageInfo: { hasNextPage: fake.hasNextPage ?? false }, nodes } } } },
    });
    if (joined.includes('/git/ref/heads/')) return JSON.stringify({ ref: `refs/heads/${fake.baseRef ?? 'main'}`, object: { sha: fake.baseSha ?? sha(99) } });
    const page = Number(/[?&]page=(\d+)/.exec(joined)![1]);
    return JSON.stringify({ status: fake.status ?? 'ahead', total_commits: page > 1 && fake.totalCommitsLater !== undefined ? fake.totalCommitsLater : fake.totalCommits ?? commits.length,
      commits: commits.slice((page - 1) * 100, page * 100).map(c => ({ sha: c.sha, commit: { message: c.message } })) });
  };
  return { calls, gh: new GhAlreadyFixedGateway({ repository: repo }, run) };
}
const input = (over: Partial<AlreadyFixedInput> = {}): AlreadyFixedInput =>
  ({ issue: 12, taskBase: sha(1), baseBranch: 'main', ownPullRequests: [], ownCommits: new Set(), ...over });

describe('the timeline query', () => {
  // The fake above answers any query, so the query text itself is checked here. Verified against GitHub with a default
  // `gh auth login` token (scopes gist, read:org, repo, workflow).
  it('reads both sides of a manual link and asks for no field that needs a scope beyond repo', async () => {
    const { gh, calls } = gateway();
    await gh.check(input());
    const query = calls.find(args => args[1] === 'graphql')!.find(arg => arg.startsWith('query='))!.slice('query='.length);
    for (const event of ['ConnectedEvent', 'DisconnectedEvent']) expect(query).toContain(`... on ${event} { source { ...Linked } subject { ...Linked } }`);
    expect(query).toContain('fragment Linked on ReferencedSubject');
    expect(query).toContain('... on CrossReferencedEvent { willCloseTarget source {');
    expect(query).toContain('defaultBranchRef { name }');
    expect(query).toMatch(/on CrossReferencedEvent \{ willCloseTarget source \{[^}]*baseRefName/);
    // A ProjectV2 closer is read by its type name only: any field on ProjectV2 needs the read:project scope, and GitHub
    // then refuses the whole query.
    expect(query).not.toMatch(/on ProjectV2/);
  });
});

describe('issue mentions in commit messages', () => {
  it('matches this issue by number, GH- form, qualified name or URL, and nothing else', () => {
    for (const message of ['Fix #12', 'fixes #12.', '(#12)', 'Resolve GH-12', 'fixes gh-12', 'owner/repo#12', 'See https://github.com/Owner/Repo/issues/12 for context'])
      expect(mentionsIssue(message, repo, 12), message).toBe(true);
    for (const message of ['Fix #123', 'Fix #1', 'other/repo#12', 'x#12', 'issue 12', 'https://github.com/owner/repo/issues/120', 'https://github.com/other/repo/issues/12', 'GH-120', 'owner/repo2#12', 'https://example.com/#12', 'XGH-12', 'foo-GH-12', '##12'])
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
    // A PR that only mentions the issue, here or in another repository, is not a link.
    expect(await gateway({ nodes: [cross(pr(401), false), cross(pr(402, 'MERGED', { repository: { nameWithOwner: 'someone/else' } }), false)] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
    expect(await gateway({ nodes: [cross(pr(401), 'yes')] }).gh.check(input())).toMatchObject({ outcome: 'unknown' });
  });
  it('with a base that is not the default branch, also counts a PR here into that base that references the issue', async () => {
    const develop = (number: number, over: Record<string, unknown> = {}) => cross(pr(number, 'OPEN', { baseRefName: 'develop', ...over }), false);
    const onDevelop = input({ baseBranch: 'develop' });
    // GitHub reports willCloseTarget false for any PR into a non-default branch, even with "Fixes #12".
    expect(await gateway({ nodes: [develop(401)], baseRef: 'develop' }).gh.check(onDevelop)).toMatchObject({ outcome: 'found', matches: [{ number: 401 }] });
    expect(await gateway({ nodes: [develop(401, { state: 'MERGED' })], baseRef: 'develop' }).gh.check(onDevelop)).toMatchObject({ outcome: 'found', matches: [{ number: 401, state: 'MERGED' }] });
    // Not into that base, not in this repository, or the base is the default branch: a mention still is not a link.
    expect(await gateway({ nodes: [develop(401, { baseRefName: 'main' })], baseRef: 'develop' }).gh.check(onDevelop)).toMatchObject({ outcome: 'clear' });
    expect(await gateway({ nodes: [develop(401, { repository: { nameWithOwner: 'someone/else' } })], baseRef: 'develop' }).gh.check(onDevelop)).toMatchObject({ outcome: 'clear' });
    expect(await gateway({ nodes: [develop(401)], baseRef: 'develop', defaultBranch: { name: 'develop' } }).gh.check(onDevelop)).toMatchObject({ outcome: 'clear' });
    // Fails closed without a readable default branch or PR base.
    expect(await gateway({ nodes: [], baseRef: 'develop', defaultBranch: null }).gh.check(onDevelop)).toMatchObject({ outcome: 'unknown' });
    expect(await gateway({ nodes: [], baseRef: 'develop', defaultBranch: { name: '' } }).gh.check(onDevelop)).toMatchObject({ outcome: 'unknown' });
    expect(await gateway({ nodes: [develop(401, { baseRefName: 7 })], baseRef: 'develop' }).gh.check(onDevelop)).toMatchObject({ outcome: 'unknown' });
    const { gh } = gateway({ nodes: [cross(pr(401)), connected(pr(402, 'MERGED', { isDraft: false })), cross(pr(403, 'CLOSED')), cross(pr(401))] });
    expect(await gh.check(input())).toMatchObject({ outcome: 'found', matches: [
      { kind: 'pull request', repository: repo, number: 401, state: 'OPEN' }, { kind: 'pull request', number: 402, state: 'MERGED' }] });
  });
  it('replays manual links: a later disconnect removes a connected PR, a later connect restores it, a cross-reference stays', async () => {
    expect(await gateway({ nodes: [connected(pr(401)), disconnected(pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
    // A link made from the PR's side reports the PR as the source and the issue as the subject; it counts the same way.
    expect(await gateway({ nodes: [connected(issue, pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ number: 401 }] });
    expect(await gateway({ nodes: [connected(pr(401)), disconnected(issue, pr(401))] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
    // Two PRs, or a side of an unknown type, cannot be read as a link to this issue.
    expect(await gateway({ nodes: [connected(pr(401), pr(402))] }).gh.check(input())).toMatchObject({ outcome: 'unknown' });
    expect(await gateway({ nodes: [connected(pr(401), { __typename: 'Discussion' })] }).gh.check(input())).toMatchObject({ outcome: 'unknown' });
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
  it("reports an issue closed by anything, including the task's own merged PR or its own commit on the default branch", async () => {
    expect(await gateway({ state: 'CLOSED', nodes: [closed(null)] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed' }] });
    expect(await gateway({ state: 'CLOSED', nodes: [closed(pr(9))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: `${repo}#9` }] });
    // A close by the task's own PR means that PR merged: the issue is fixed, so it is a match, labelled as own.
    expect(await gateway({ state: 'CLOSED', nodes: [closed(pr(9))] }).gh.check(input({ ownPullRequests: [9] }))).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: `${repo}#9 (this task's own PR, already merged)` }] });
    expect(await gateway({ state: 'CLOSED', nodes: [closed({ __typename: 'Commit', oid: sha(3) })] }).gh.check(input({ ownCommits: new Set([sha(3)]) }))).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: expect.stringContaining("this task's own commit") }] });
    // Only the latest close counts.
    expect(await gateway({ state: 'CLOSED', nodes: [closed(null), closed(pr(9))] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: `${repo}#9` }] });
    // A reopened issue does not count as closed.
    expect(await gateway({ state: 'OPEN', nodes: [closed(null)] }).gh.check(input())).toMatchObject({ outcome: 'clear' });
  });
  it("counts the task's own merged PR as a match, while its own open PR is still excluded", async () => {
    expect(await gateway({ nodes: [cross(pr(7, 'MERGED'))] }).gh.check(input({ ownPullRequests: [7] }))).toMatchObject({ outcome: 'found', matches: [{ number: 7, state: 'MERGED' }] });
    expect(await gateway({ nodes: [cross(pr(7, 'OPEN'))] }).gh.check(input({ ownPullRequests: [7] }))).toMatchObject({ outcome: 'clear' });
  });
  it('cuts a long commit subject without splitting a surrogate pair', async () => {
    // The second emoji straddles unit 200 (units 199–200), so a plain slice would split it.
    const subject = `Fix #12 ${'a'.repeat(191)}😀😀😀`;
    const result = await gateway({ commits: [{ sha: sha(5), message: subject }] }).gh.check(input());
    const cut = (result as { matches: { subject: string }[] }).matches[0]!.subject;
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('treats an issue closed by a Projects workflow as closed by someone else, not as unreadable', async () => {
    expect(await gateway({ state: 'CLOSED', nodes: [closed({ __typename: 'ProjectV2', number: 3 })] }).gh.check(input())).toMatchObject({ outcome: 'found', matches: [{ kind: 'closed', by: 'a project workflow' }] });
    expect(await gateway({ state: 'CLOSED', nodes: [closed({ __typename: 'Mystery' })] }).gh.check(input())).toMatchObject({ outcome: 'unknown', reason: expect.stringMatching(/unknown closer/) });
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
  it('fails closed at once on an empty comparison page that should hold commits, without asking for more', async () => {
    const { gh, calls } = gateway({ commits: [], totalCommits: 5 });
    expect(await gh.check(input())).toMatchObject({ outcome: 'unknown', reason: expect.stringMatching(/incomplete commit list/) });
    expect(calls.filter(call => call.some(arg => arg.includes('/compare/')))).toHaveLength(1);
  });
  it('fails closed past every bound and on unreadable or inconsistent answers', async () => {
    const cases: Fake[] = [
      { totalCount: 101 }, { hasNextPage: true }, { nodes: [cross(pr(1))], totalCount: 2 },
      { commits: Array.from({ length: MAX_BASE_COMMITS + 1 }, (_, i) => ({ sha: sha(2000 + i), message: 'x' })) }, { status: 'diverged' }, { status: 'behind' },
      { commits: [{ sha: sha(5), message: 'x' }], totalCommits: 2 },
      // A commit without a message, an invalid base head, and a non-integer commit count.
      { commits: [{ sha: sha(5), message: undefined as unknown as string }] }, { baseSha: 'HEAD' }, { totalCommits: 1.5, commits: [{ sha: sha(5), message: 'x' }] },
      // Validation of the issue state, a linked PR's state and draft flag, and a closing commit's SHA.
      { state: 'WEIRD' }, { nodes: [cross(pr(1, 'UNKNOWN'))] }, { nodes: [cross(pr(1, 'OPEN', { isDraft: 'no' }))] },
      { state: 'CLOSED', nodes: [closed({ __typename: 'Commit', oid: 'short' })] },
      // The base branch moved between pages (the count changed), and a page longer than the reported total.
      { commits: Array.from({ length: 150 }, (_, i) => ({ sha: sha(3000 + i), message: 'x' })), totalCommitsLater: 151 },
      { commits: Array.from({ length: 160 }, (_, i) => ({ sha: sha(3000 + i), message: 'x' })), totalCommits: 120 },
      { commits: [{ sha: sha(5), message: 'x' }, { sha: sha(5), message: 'x' }] },
      { errors: [{ message: 'rate limited' }] }, { errors: { message: 'not a list' } }, { nameWithOwner: 'other/repo' }, { baseRef: 'other' },
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
    // The deadline plus the runner's SIGTERM and pipe grace periods stays below the budget.
    expect(DEFAULT_CHECK_DEADLINE_MS + CHECK_KILL_GRACE_MS + CHECK_PIPE_GRACE_MS).toBeLessThan(15_000);
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

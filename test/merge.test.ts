import { expect, it, vi } from 'vitest';
import { ReviewService } from '../runner/review.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { GhMergeGateway, type MergeGateway, type RemoteMergeState } from '../github/merge.ts';

type ReviewView = ReturnType<ReviewService['load']>;
const sha = (digit: string) => digit.repeat(40);
function readyView(): ReviewView {
  return {
    items: [{ id: 'P1', state: 'approved', acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
    plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: 'snapshot', base: sha('a'), head: sha('b') }, token: 'review-token',
  } as unknown as ReviewView;
}
function serviceFor(view: ReviewView): ReviewService { return { load: vi.fn(() => view) } as unknown as ReviewService; }

function remote(view: ReviewView, change: Partial<RemoteMergeState> = {}): RemoteMergeState {
  return { base: view.snapshot.base, head: view.snapshot.head, pullRequestState: 'OPEN', mergeable: 'MERGEABLE', rulesKnown: true, atomicBaseGuard: true, mergeQueue: false, requiredChecks: [], alreadyFixed: 'clear', ...change };
}

function gateway(states: RemoteMergeState[]): MergeGateway & { heads: string[] } {
  const heads: string[] = [];
  return { heads, inspect: vi.fn(async () => states.shift() ?? states.at(-1)!), merge: vi.fn(async head => { heads.push(head); return { url: 'https://github.example/pr/1' }; }) };
}

it('lists every local review blocker before merge', async () => {
  const view = { ...readyView(), items: [{ ...readyView().items[0]!, state: 'stale' }], segments: [{ row: 'Unplanned' }], notes: [{ kind: 'change', revision: 1, snapshotId: 'snapshot' }] } as unknown as ReviewView;
  const service = serviceFor(view);
  const status = await new MergeCoordinator(service, gateway([remote(view)])).status(view);
  expect(new Set(status.blockers.map(blocker => blocker.code))).toEqual(new Set(['approval', 'unplanned', 'changes']));
});

it('keeps review available when GitHub merge state cannot be read', async () => {
  const view = readyView(), service = serviceFor(view);
  const client: MergeGateway = { inspect: async () => { throw new Error('login required'); }, merge: async () => ({ url: '' }) };
  const status = await new MergeCoordinator(service, client).displayStatus(view);
  expect(status).toMatchObject({ ready: false, remote: null, blockers: [{ code: 'github', message: 'Could not read GitHub merge state. login required' }] });
});

it.each([
  ['base', (_view: ReviewView) => ({ base: sha('c') })],
  ['head', (_view: ReviewView) => ({ head: sha('c') })],
  ['pr-state', (_view: ReviewView) => ({ pullRequestState: 'CLOSED' as const })],
  ['mergeable', (_view: ReviewView) => ({ mergeable: 'CONFLICTING' as const })],
  ['rules', (_view: ReviewView) => ({ rulesKnown: false })],
  ['base-guard', (_view: ReviewView) => ({ atomicBaseGuard: false })],
  ['merge-queue', (_view: ReviewView) => ({ mergeQueue: true })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'pending-test', appId: null, state: 'pending' as const }] })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'failed-test', appId: null, state: 'failure' as const }] })],
  ['check', (_view: ReviewView) => ({ requiredChecks: [{ context: 'missing-test', appId: null, state: 'missing' as const }] })],
  ['already-fixed', (_view: ReviewView) => ({ alreadyFixed: 'found' as const })],
])('blocks the %s remote condition', async (code, change) => {
  const view = readyView(), service = serviceFor(view);
  const status = await new MergeCoordinator(service, gateway([remote(view, change(view))])).status(view);
  expect(status.blockers.map(blocker => blocker.code)).toContain(code);
});

it('blocks command acceptance that has no current passing runner result', async () => {
  const view = readyView();
  const changed = { ...view, items: view.items.map((item, index) => index ? item : { ...item, acceptance: [{ type: 'cmd' as const, text: 'npm test' }] }) };
  const fakeService = { load: () => changed } as unknown as ReviewService;
  const status = await new MergeCoordinator(fakeService, gateway([remote(view)])).status(changed);
  expect(status.blockers.map(blocker => blocker.code)).toContain('acceptance');
});

it('rechecks the exact base and head, then invokes the guarded head merge', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view)]);
  const merged = await new MergeCoordinator(service, client).merge(view.token);
  expect(client.heads).toEqual([view.snapshot.head]);
  expect(merged.result.url).toContain('/pr/1');
});

it('budgets both fresh validation passes below the serving deadline', async () => {
  const view = readyView(), service = serviceFor(view), options: Array<{ fresh?: boolean; timeoutMs?: number } | undefined> = [];
  const client: MergeGateway = { inspect: vi.fn(async value => { options.push(value); return remote(view); }), merge: vi.fn(async () => ({ url: 'https://github.example/pr/1' })) };
  await new MergeCoordinator(service, client).merge(view.token);
  expect(options).toEqual([{ fresh: true, timeoutMs: 6_000 }, { fresh: true, timeoutMs: 6_000 }]);
});

it('refuses a base or head race after the initial validation', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view, { head: 'c'.repeat(40) })]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/changed during merge validation/);
  expect(client.heads).toEqual([]);
});

it('refuses a requirement that changes after the initial validation', async () => {
  const view = readyView(), service = serviceFor(view);
  const client = gateway([remote(view), remote(view, { mergeable: 'CONFLICTING' })]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/requirements changed.*merge conflicts/i);
  expect(client.heads).toEqual([]);
});

it('revalidates the store generation after the final asynchronous status check', async () => {
  const view = readyView(), changed = { ...view, token: 'new-review-token' };
  let loads = 0;
  const service = { load: vi.fn(() => ++loads < 3 ? view : changed) } as unknown as ReviewService;
  const client = gateway([remote(view), remote(view)]);
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow(/Review changed during merge validation/);
  expect(client.heads).toEqual([]);
});

it('preserves the GitHub merge refusal', async () => {
  const view = readyView(), service = serviceFor(view), state = remote(view);
  const client: MergeGateway = { inspect: vi.fn(async () => state), merge: async () => { throw new Error('Required review is missing.'); } };
  await expect(new MergeCoordinator(service, client).merge(view.token)).rejects.toThrow('Required review is missing.');
});

it('parses required checks from both rule sources and pins the gh merge head', async () => {
  const calls: string[][] = [];
  let pullReads = 0;
  const run = async (args: readonly string[]) => {
    calls.push([...args]); const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) { pullReads++; return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', app: { databaseId: 10 } },
      { name: 'race', status: 'IN_PROGRESS', conclusion: 'SUCCESS' },
      { context: 'lint', state: 'SUCCESS' },
    ] }); }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test', integration_id: 10 }, { context: 'race', integration_id: null }] } }]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.includes('/protection')) return JSON.stringify({ required_status_checks: { strict: false, checks: [{ context: 'lint', app_id: null }] } });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    if (joined.startsWith('pr merge 7')) return '';
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
  const state = await client.inspect();
  expect(state.atomicBaseGuard).toBe(true);
  expect(state.mergeQueue).toBe(true);
  expect(state.requiredChecks).toEqual([
    { context: 'test', appId: 10, state: 'success' },
    { context: 'race', appId: null, state: 'pending' },
    { context: 'lint', appId: null, state: 'success' },
  ]);
  await client.merge(sha('b'));
  expect(calls.at(-1)).toEqual(['pr','merge','7','--repo','owner/repo','--merge','--match-head-commit',sha('b')]);
  await client.inspect();
  expect(pullReads).toBe(2);
});

it('rejects an unsupported runtime merge method', () => {
  expect(() => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21, method: 'typo' as 'merge' })).toThrow(/merge method/i);
});

it.each([
  ['ruleset', [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test', integration_id: '10' }] } }], { strict: false, checks: [] }],
  ['classic', [], { strict: true, checks: [{ context: 'test' }] }],
] as const)('fails closed for an invalid %s check app identity', async (_source, rules, requiredStatusChecks) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', app: { databaseId: 10 } }] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([rules]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('aborts one shared status inspection at its overall deadline', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0, aborts = 0;
    const run = async (_args: readonly string[], options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      calls++;
      options?.signal?.addEventListener('abort', () => { aborts++; reject(options.signal?.reason); }, { once: true });
    });
    const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
    const first = client.inspect(), second = client.inspect();
    const resultsPromise = Promise.allSettled([first, second]);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    const results = await resultsPromise;
    expect(results.every(result => result.status === 'rejected' && /timed out/i.test(String(result.reason)))).toBe(true);
    expect(aborts).toBe(1);
  } finally { vi.useRealTimers(); }
});

it.each([[false, true], [true, false]])('treats a protection 404 with protected=%s as rulesKnown=%s', async (protectedBranch, expectedKnown) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: protectedBranch });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(expectedKnown);
  expect(state.requiredChecks).toEqual([]);
});

it.each([['feature', 'found'], ['other-branch', 'found']] as const)('classifies a referenced PR on %s as %s', async (referencedBranch, expected) => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) return JSON.stringify({ data: { repository: { p0: { state: 'OPEN', mergedAt: null, headRefName: referencedBranch } } } });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 7, pull_request: {} } } }, { source: { issue: { number: 8, pull_request: {} } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe(expected);
});

it.each([{}, { state: 'CLOSED' }, { state: 'BOGUS', mergedAt: null }, { state: 'CLOSED', mergedAt: 42 }, { state: 'MERGED', mergedAt: null }, { state: 'OPEN', mergedAt: '2026-01-01' }, { state: 'CLOSED', mergedAt: '2026-01-01' }])('fails closed for malformed referenced PR data: %j', async referencedPull => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('api graphql')) return JSON.stringify({ data: { repository: { p0: referencedPull } } });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: 8, pull_request: {} } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it.each([false, 'required', []])('fails closed for malformed classic protection metadata: %j', async requiredStatusChecks => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('fails closed for a ruleset entry without a type', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{}]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: { strict: true, checks: [] } });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

it('does not let an inspection started before merge repopulate the cache', async () => {
  let pullReads = 0, releaseTimeline!: (value: string) => void, markTimelineStarted!: () => void;
  const timelineStarted = new Promise<void>(resolve => { markTimelineStarted = resolve; });
  const delayedTimeline = new Promise<string>(resolve => { releaseTimeline = resolve; });
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) { pullReads++; return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] }); }
    if (joined.startsWith('pr merge')) return '';
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline') && pullReads === 1) { markTimelineStarted(); return delayedTimeline; }
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const client = new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run);
  const staleInspection = client.inspect();
  await timelineStarted;
  await client.merge(sha('b'));
  releaseTimeline(JSON.stringify([[]]));
  await staleInspection;
  await client.inspect();
  expect(pullReads).toBe(2);
});

it('blocks the already-fixed check instead of truncating more than 100 references', async () => {
  const references = Array.from({ length: 101 }, (_, index) => ({ source: { issue: { number: index + 8, pull_request: {} } } }));
  let referencedViews = 0;
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view 7')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.startsWith('pr view')) { referencedViews++; return JSON.stringify({ state: 'CLOSED', mergedAt: null, headRefName: 'other' }); }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([references]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
  expect(referencedViews).toBe(0);
});

it('fails closed when a paginated timeline contains a malformed page', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([{ source: { issue: { number: 8, pull_request: {} } } }]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('fails closed when a timeline pull request reference has no valid number', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[{ source: { issue: { number: '8', pull_request: {} } } }]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it('fails closed when a timeline contains a non-object event', async () => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    if (joined.includes('/timeline')) return JSON.stringify([[null]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.alreadyFixed).toBe('unknown');
});

it.each([
  { strict: true, checks: 'bad', contexts: [] },
  { strict: true, checks: [], contexts: ['test'] },
  { strict: true, checks: [{ context: 'test', app_id: null }], contexts: [] },
  { strict: 'true', checks: [], contexts: [] },
])('fails closed for inconsistent classic protection fields: %j', async requiredStatusChecks => {
  const run = async (args: readonly string[]) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'), state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: true });
    if (joined.endsWith('/protection')) return JSON.stringify({ required_status_checks: requiredStatusChecks });
    if (joined.includes('/timeline')) return JSON.stringify([[]]);
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const state = await new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, run).inspect();
  expect(state.rulesKnown).toBe(false);
});

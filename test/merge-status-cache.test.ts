import { expect, it } from 'vitest';
import { GhMergeGateway, MergeSubmissionError, type RemoteMergeState } from '../github/merge.ts';
import type { AlreadyFixedGateway } from '../github/already-fixed.ts';
import { CommandFailed } from '../github/run-with-input.ts';

// #48: "invalidate status caches after successful and refused irreversible mutations, and reject stale in-flight
// cache publication". GhMergeGateway keeps the only server-side merge status cache (5 s, keyed by target) and an
// in-flight inspection shared by non-fresh readers. Its only mutation is merge() (direct merge or enqueue).
const sha = (c: string) => c.repeat(40);
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const checks: AlreadyFixedGateway = { repository: 'owner/repo', check: async () => ({ outcome: 'clear', baseHead: sha('9') }) };

/**
 * A fake gh. `pr view` answers with the PR state GitHub had when the call started, released by the test's gate, so
 * a read that began before a mutation returns pre-mutation state. `pr merge` waits on its own gate.
 */
function fakeGh() {
  let state: 'OPEN' | 'MERGED' = 'OPEN', mergeable: 'MERGEABLE' | 'CONFLICTING' = 'MERGEABLE';
  const views: Array<Deferred<void>> = [];
  let mergeGate: Deferred<void> | null = null;
  const run = async (args: readonly string[], _options?: { signal?: AbortSignal }) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) {
      const observed = state, observedMergeable = mergeable, gate = deferred<void>();
      views.push(gate);
      await gate.promise;
      return JSON.stringify({ number: 7, isDraft: false, baseRefName: 'main', baseRefOid: sha('a'), headRefName: 'feature', headRefOid: sha('b'),
        state: observed, mergeable: observedMergeable, statusCheckRollup: [] });
    }
    if (joined.startsWith('pr merge')) {
      if (mergeGate) await mergeGate.promise;
      return '';
    }
    if (joined.includes('/rules/branches/')) return JSON.stringify([[]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ protected: false });
    if (joined.endsWith('/protection')) throw new Error('HTTP 404: Not Found');
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  return {
    run, views,
    setState: (next: 'OPEN' | 'MERGED') => { state = next; },
    setMergeable: (next: 'MERGEABLE' | 'CONFLICTING') => { mergeable = next; },
    gateMerge: () => (mergeGate = deferred<void>()),
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const client = (gh: ReturnType<typeof fakeGh>) => new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, gh.run, checks);

for (const outcome of ['merged', 'refused'] as const) {
  const gatewayFor = (gh: ReturnType<typeof fakeGh>) => outcome === 'merged' ? client(gh)
    : new GhMergeGateway({ repository: 'owner/repo', pullRequest: 7, issue: 21 }, async (args, options) => {
      if (args[0] === 'pr' && args[1] === 'merge') { gh.setMergeable('CONFLICTING'); throw new CommandFailed('gh failed (exit 1): GraphQL: Pull Request is not mergeable', 'GraphQL: Pull Request is not mergeable', ''); }
      return gh.run(args, options);
    }, checks);
  const mutate = async (gh: ReturnType<typeof fakeGh>, gateway: GhMergeGateway) => {
    if (outcome === 'merged') { await gateway.merge(sha('b')); gh.setState('MERGED'); return; }
    const refusal = await gateway.merge(sha('b')).catch(error => error);
    expect(refusal).toBeInstanceOf(MergeSubmissionError);
    expect((refusal as MergeSubmissionError).outcome).toBe('refused');
  };

  // What changed on GitHub with the mutation: the PR merged, or (refused) GitHub now reports the conflict that refused it.
  const observed = (state: RemoteMergeState) => outcome === 'merged' ? state.pullRequestState : state.mergeable;
  const expected = outcome === 'merged' ? 'MERGED' : 'CONFLICTING';

  it(`does not serve the status cached before a ${outcome} merge after it`, async () => {
    const gh = fakeGh(), gateway = gatewayFor(gh);
    const cached = gateway.inspect(); await flush(); gh.views[0]!.resolve();
    expect((await cached).pullRequestState).toBe('OPEN');
    // Still within the 5 s lifetime: served from the cache before the mutation.
    expect((await gateway.inspect()).pullRequestState).toBe('OPEN');
    expect(gh.views).toHaveLength(1);
    await mutate(gh, gateway);
    const after = gateway.inspect(); await flush();
    expect(gh.views).toHaveLength(2);
    gh.views[1]!.resolve();
    expect(observed(await after)).toBe(expected);
  });

  it(`neither joins nor publishes a read in flight across a ${outcome} merge`, async () => {
    const gh = fakeGh(), gateway = gatewayFor(gh);
    const stale = gateway.inspect(); await flush();
    expect(gh.views).toHaveLength(1);
    await mutate(gh, gateway);
    // A reader after the mutation does not join the pre-mutation read.
    const after = gateway.inspect(); await flush();
    expect(gh.views).toHaveLength(2);
    // The pre-mutation read settles last; it must not overwrite the newer answer in the cache.
    gh.views[1]!.resolve(); await after;
    gh.views[0]!.resolve();
    expect((await stale).pullRequestState).toBe('OPEN');
    expect(observed(await gateway.inspect())).toBe(expected);
    expect(gh.views).toHaveLength(2);
  });
}

it('a read that starts while the merge command runs and ends after it is neither joined nor published', async () => {
  const gh = fakeGh(), gateway = client(gh);
  const merge = gh.gateMerge();
  const merging = gateway.merge(sha('b')); await flush();
  // Started during the merge: GitHub still shows the PR open.
  const during = gateway.inspect(); await flush();
  expect(gh.views).toHaveLength(1);
  merge.resolve(); await merging;
  gh.setState('MERGED');
  // A reader arriving after the merge must not join the read that started during it.
  const joined = gateway.inspect(); await flush();
  expect(gh.views).toHaveLength(2);
  // The read that started during the merge settles last; it must not overwrite the newer answer in the cache.
  gh.views[1]!.resolve(); expect((await joined).pullRequestState).toBe('MERGED');
  gh.views[0]!.resolve(); expect((await during).pullRequestState).toBe('OPEN');
  // And the stale read did not land in the cache afterwards.
  expect((await gateway.inspect()).pullRequestState).toBe('MERGED');
  expect(gh.views).toHaveLength(2);
});

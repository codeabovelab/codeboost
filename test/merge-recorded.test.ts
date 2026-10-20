import { afterEach, expect, it, vi } from 'vitest';
import { GhMergeGateway, type RunGh } from '../github/merge.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { MergeJobCoordinator } from '../runner/merge-job.ts';
import type { PreMergeCoordinator } from '../runner/pre-merge.ts';
import type { ReviewService } from '../runner/review.ts';
import { Store } from '../runner/store.ts';
import { commandDigest } from '../runner/checks.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { loadRecording, replayGh, type RecordedGh } from './fixtures/gh/recorded.ts';

// T12: required checks read from GitHub's real answers, recorded by scripts/record-merge-gh.ts with gh 2.102.0 from the
// public codeabovelab/codeboost repository:
// - zero-checks: PR 104, into a branch no ruleset or classic protection covers (merged since, so it is read here only for
//   its required checks);
// - checks-pending: PR 183, while its two required checks (`test`, `real-docker`, from the "main checks" ruleset) ran;
// - checks-passing: PR 183 at the same head, after both passed.
// The already-fixed check's reads are not recorded: every gateway here gets a stub check that answers clear.
const zero = loadRecording('zero-checks'), pending = loadRecording('checks-pending'), passing = loadRecording('checks-passing');
const pullOf = (recording: RecordedGh) => JSON.parse(recording.calls.find(call => call.args[0] === 'pr')!.stdout) as
  { number: number; baseRefOid: string; headRefOid: string; baseRefName: string };
const clearCheck = (repository: string) => ({ repository, check: async () => ({ outcome: 'clear' as const, baseHead: '0'.repeat(40) }) });
const gatewayFor = (recording: RecordedGh, run: RunGh) =>
  new GhMergeGateway({ repository: recording.repository, pullRequest: recording.pullRequest, issue: 1 }, run, clearCheck(recording.repository));

it('reads pending and passing at one pull request head, and no app in any recorded rollup', () => {
  expect([pending.gh, passing.gh, zero.gh]).toEqual(Array(3).fill('gh version 2.102.0 (2026-09-30)'));
  expect(pullOf(passing)).toMatchObject({ number: 183, baseRefOid: pullOf(pending).baseRefOid, headRefOid: pullOf(pending).headRefOid });
  // gh's statusCheckRollup never carries a check's app (#176), in any recording.
  for (const recording of [zero, pending, passing]) {
    const rollup = (JSON.parse(recording.calls.find(call => call.args[0] === 'pr')!.stdout) as { statusCheckRollup: object[] }).statusCheckRollup;
    for (const check of rollup) expect(check).not.toHaveProperty('app');
  }
});

it('reads zero required checks from a branch with no rules', async () => {
  const run = replayGh(zero), state = await gatewayFor(zero, run).inspect({ fresh: true });
  expect(run.unrecorded).toEqual([]);
  expect(state).toMatchObject({ base: pullOf(zero).baseRefOid, head: pullOf(zero).headRefOid, rulesKnown: true, requiredChecks: [],
    atomicBaseGuard: false, mergeQueue: false });
});

it('reads the ruleset\'s required checks as pending, then as passing at the same head', async () => {
  const runPending = replayGh(pending), runPassing = replayGh(passing);
  const before = await gatewayFor(pending, runPending).inspect({ fresh: true });
  // The ruleset names its checks with no `integration_id`, and the branch reads as protected with no classic protection.
  expect(before).toMatchObject({ rulesKnown: true, atomicBaseGuard: false, mergeQueue: false, requiredChecks: [
    { context: 'test', appId: null, state: 'pending' }, { context: 'real-docker', appId: null, state: 'pending' }] });
  const after = await gatewayFor(passing, runPassing).inspect({ fresh: true });
  expect([...runPending.unrecorded, ...runPassing.unrecorded]).toEqual([]);
  expect(after).toMatchObject({ base: before.base, head: before.head, rulesKnown: true, requiredChecks: [
    { context: 'test', appId: null, state: 'success' }, { context: 'real-docker', appId: null, state: 'success' }] });
});

// The job, against the real Store and guarded merge, with GitHub answered from the recordings. Its preparation is a
// fake that records readiness, as in test/merge-job.test.ts.
const identity = { repositoryId: 'repo', taskId: 'Task_183', planId: 'plan' };
const stores: Store[] = [], jobs: MergeJobCoordinator[] = [];
afterEach(async () => { for (const job of jobs.splice(0)) await job.close(); for (const store of stores.splice(0)) store.close(); });

/** A task in review whose snapshot is the recorded pull request's base and head. */
function taskAt(recording: RecordedGh): Store {
  const { baseRefOid: base, headRefOid: head } = pullOf(recording);
  const plan: Plan = { schema_version: 1, issue: 1, revision: 1, summary: 'Recorded', questions: [], items: [
    { id: 'P1', title: 'Change', intent: 'Change it', files: [{ path: 'a.ts', kind: 'edit', renamed_from: null, change: 'Change' }], acceptance: [{ type: 'check', text: 'Works' }], depends_on: [] }] };
  const context: PlanContext = { identity, issue: 1, baseEntries: [{ path: 'a.ts', kind: 'file' }], pathKey: p => p, allowedCommands: [] };
  const store = new Store(':memory:'); stores.push(store);
  store.createPlan(JSON.stringify(plan), 'json', context, base, head);
  store.recordHistory(identity, { revision: 1, snapshotId: store.getSnapshot(identity).id }, base, head, [{ sha: head, owner: 'P1', origin: 'owned', sourceSha: null }]);
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'queued');
  const attempt = store.admitAttempt(identity, { expectedStateVersion: store.getTask(identity).stateVersion, kind: 'execute', item: 'P1', expectedContext: store.currentContext(identity), deadline: Date.now() + 60_000 });
  store.markRunning(identity, attempt.id);
  store.settleAttempt(identity, attempt.id, { firstReason: null, exitCode: 0, valid: true });
  store.transitionTask(identity, store.getTask(identity).stateVersion, 'in review');
  return store;
}
function reviewOf(store: Store): ReviewService {
  const view = () => {
    const snapshot = store.getSnapshot(identity);
    return { items: [{ id: 'P1', state: 'approved', outside: [], acceptance: [{ type: 'check', text: 'Works' }], checks: { tests: '– No tests defined' } }],
      plan: { revision: 1 }, segments: [], notes: [], snapshot: { id: snapshot.id, base: snapshot.base, head: snapshot.head }, token: 'review-token',
      expected: { revision: 1, snapshotId: snapshot.id, reviewVersion: store.reviewVersion(identity) } };
  };
  return { store, config: { identity }, load: vi.fn(async () => view()), commandPolicyDigest: () => commandDigest([]) } as unknown as ReviewService;
}
function readyPreparation(store: Store): PreMergeCoordinator {
  return { assertStartable: () => undefined, start: async (expected: { actionId: string }) => {
    const snapshot = store.getSnapshot(identity);
    return store.settlePreMergeAction(identity, expected.actionId, { state: 'ready', base: snapshot.base, head: snapshot.head, checked: [], reason: null },
      { stateVersion: store.getTask(identity).stateVersion, reviewVersion: store.reviewVersion(identity), snapshotId: snapshot.id,
        base: snapshot.base, head: snapshot.head, commandPolicyDigest: commandDigest([]) });
  } } as unknown as PreMergeCoordinator;
}
/**
 * The recorded ruleset with its strict policy turned on, the one change from what GitHub returned: GitHub then refuses a
 * merge whose head is not up to date with the base, the atomic base guard an automatic merge needs (T7). The repository's
 * real ruleset is not strict, and a job against it stops before it waits (see the next test).
 */
function strictRuleset(recording: RecordedGh): RecordedGh {
  return { ...recording, calls: recording.calls.map(call => {
    if (!call.args.some(arg => arg.includes('/rules/branches/'))) return call;
    const pages = JSON.parse(call.stdout) as { type: string; parameters: Record<string, unknown> }[][];
    const rule = pages.flat().find(value => value.type === 'required_status_checks')!;
    expect(rule.parameters.strict_required_status_checks_policy).toBe(false);
    rule.parameters.strict_required_status_checks_policy = true;
    return { ...call, stdout: JSON.stringify(pages) };
  }) };
}
/** Runs one job; `answer(n)` picks the recordings that answer the n-th `gh pr view`. */
async function runJob(store: Store, answer: (pullView: number) => RecordedGh[]) {
  let pullViews = 0;
  const merges: string[][] = [], unrecorded: string[][] = [], ruleReads = { ruleset: 0, classic: 0 };
  const run: RunGh = async (args, options) => {
    // `gh pr merge` was not recorded: it would merge the pull request. The gateway reads only its exit status.
    if (args[0] === 'pr' && args[1] === 'merge') { merges.push([...args]); return ''; }
    if (args[0] === 'pr' && args[1] === 'view') pullViews++;
    if (args.some(arg => arg.includes('/rules/branches/'))) ruleReads.ruleset++;
    if (args.some(arg => arg.endsWith('/protection'))) ruleReads.classic++;
    const replay = replayGh(...answer(Math.max(pullViews, 1)));
    try { return await replay(args, options); } finally { unrecorded.push(...replay.unrecorded); }
  };
  const review = reviewOf(store), recording = pending;
  const merge = new MergeCoordinator(review, gatewayFor(recording, run));
  const coordinator = new MergeJobCoordinator(review, readyPreparation(store), merge, undefined, { checkWaitMs: 2_000, firstDelayMs: 5, maxDelayMs: 20 });
  jobs.push(coordinator);
  await coordinator.start('review-token', crypto.randomUUID());
  await coordinator.current;
  // Every gh call the job made had a recorded answer.
  expect(unrecorded).toEqual([]);
  return { job: coordinator.latest()!, merges, ruleReads, pullViews: () => pullViews };
}

it('ends the job for a person, before waiting, against the repository\'s real non-strict ruleset', async () => {
  const store = taskAt(pending);
  // Pending checks: a job that waited on them before reading the guard would end blocked at the time limit instead.
  const { job, merges } = await runJob(store, () => [pending]);
  expect(job).toMatchObject({ state: 'failed', reason: 'GitHub does not expose a server-enforced guard for the validated base.' });
  expect(merges).toEqual([]);
});

it('waits while the recorded checks are pending, then merges once they pass', async () => {
  const store = taskAt(pending);
  const strictPending = strictRuleset(pending), strictPassing = strictRuleset(passing);
  const { job, merges, ruleReads, pullViews } = await runJob(store, view => view <= 2 ? [strictPending] : [strictPassing]);
  expect(job).toMatchObject({ state: 'merged', url: 'https://github.com/codeabovelab/codeboost/pull/183' });
  // Reads 1-2 answer pending and later ones passing. The job merged, so its wait saw the checks pending, then passing;
  // it stops reading once they pass, so at least five reads mean the guarded merge read GitHub again after it.
  expect(pullViews()).toBeGreaterThanOrEqual(5);
  // Every one of those inspections read both rule sources again, though base and head never changed.
  expect(ruleReads).toEqual({ ruleset: pullViews(), classic: pullViews() });
  expect(merges).toEqual([['pr', 'merge', '183', '--repo', 'codeabovelab/codeboost', '--merge', '--match-head-commit', pullOf(pending).headRefOid]]);
});

it('blocks the job when the recorded checks are still pending at the time limit', async () => {
  const store = taskAt(pending);
  const strictPending = strictRuleset(pending);
  const { job, merges } = await runJob(store, () => [strictPending]);
  expect(job).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/did not pass within .*: test is pending, real-docker is pending\. Wait for the checks to pass, then Retry merge\.$/) });
  expect(store.getTask(identity).status).toBe('approved but merge blocked');
  expect(merges).toEqual([]);
});

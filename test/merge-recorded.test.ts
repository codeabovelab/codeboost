import { afterEach, expect, it, vi } from 'vitest';
import { GhMergeGateway, type RunGh } from '../github/merge.ts';
import { MergeCoordinator } from '../runner/merge.ts';
import { MergeJobCoordinator } from '../runner/merge-job.ts';
import type { PreMergeCoordinator } from '../runner/pre-merge.ts';
import type { ReviewService } from '../runner/review.ts';
import { Store } from '../runner/store.ts';
import { commandDigest } from '../runner/checks.ts';
import type { Plan, PlanContext } from '../core/plan.ts';
import { CommandFailed } from '../github/run-with-input.ts';
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
  for (const recording of [zero, pending, passing, ...Object.values(nonAdmin)]) {
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

// The same reads by a token without admin rights, recorded 2026-10-20 with gh 2.102.0 from public repositories this
// token may only read. Each classic protection read answers 404 "Not Found", so classic checks come from the branch read.
// nonadmin-ruleset and nonadmin-mixed were recorded again at the same heads on 2026-10-21 (UTC), when the inspection
// began to read the runs of checks pinned to an app from GitHub (#176); their other answers did not change.
// - nonadmin-ruleset: vitejs/vite PR 23837 into main, which only a ruleset covers (`protection.enabled` false);
// - nonadmin-classic: cli/cli PR 14716 into trunk, with classic required checks and no ruleset checks;
// - nonadmin-mixed: sveltejs/svelte PR 19050 into main, where a ruleset and classic protection both require one check.
const nonAdmin = { ruleset: loadRecording('nonadmin-ruleset'), classic: loadRecording('nonadmin-classic'), mixed: loadRecording('nonadmin-mixed') };

it('records the 404 a token without admin rights gets, and the branch read\'s classic checks', () => {
  for (const recording of Object.values(nonAdmin)) {
    expect(recording.gh).toBe('gh version 2.102.0 (2026-09-30)');
    const classic = recording.calls.find(call => call.args.at(-1)!.endsWith('/protection'))!;
    expect(classic).toMatchObject({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
    expect(JSON.parse(classic.stdout)).toMatchObject({ message: 'Not Found', status: '404' });
  }
  const protectionOf = (recording: RecordedGh) => JSON.parse(recording.calls.find(call => /^repos\/[^/]+\/[^/]+\/branches\/[^/]+$/.test(call.args.at(-1)!))!.stdout) as
    { protected: boolean; protection: { enabled: boolean; required_status_checks: Record<string, unknown> } };
  expect(protectionOf(nonAdmin.ruleset)).toEqual({ name: 'main', protected: true, protection: { enabled: false,
    required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } });
  // No `strict` here: a reader without admin rights cannot see whether the branch must be up to date.
  expect(protectionOf(nonAdmin.classic).protection).toEqual({ enabled: true, required_status_checks: { enforcement_level: 'non_admins',
    contexts: ['build (macos-latest)', 'build (ubuntu-latest)', 'build (windows-latest)'],
    checks: [{ context: 'build (macos-latest)', app_id: null }, { context: 'build (ubuntu-latest)', app_id: null }, { context: 'build (windows-latest)', app_id: null }] } });
  expect(protectionOf(nonAdmin.mixed).protection.required_status_checks).toEqual({ enforcement_level: 'non_admins',
    contexts: ['vite-ecosystem-ci'], checks: [{ context: 'vite-ecosystem-ci', app_id: 2935623 }] });
});

it('reads a ruleset-only branch\'s required checks with a token without admin rights', async () => {
  const run = replayGh(nonAdmin.ruleset), state = await gatewayFor(nonAdmin.ruleset, run).inspect({ fresh: true });
  expect(run.unrecorded).toEqual([]);
  // The ruleset binds each check to GitHub Actions (app 15368). gh's rollup names no app (#176), so they are read from
  // GitHub by app and name, in one call; GitHub Actions reported a passing run of each (`Build & Test Passed or Skipped`
  // ran in two suites, skipped in the older and passed in the newer).
  expect(run.calls.filter(args => args[1] === 'graphql')).toHaveLength(1);
  expect(state).toMatchObject({ rulesKnown: true, atomicBaseGuard: false, mergeQueue: false, requiredChecks: [
    { context: 'Semantic Pull Request', appId: 15368, state: 'success' },
    { context: 'Build & Test Passed or Skipped', appId: 15368, state: 'success' },
    { context: 'Lint: node-24, ubuntu-latest', appId: 15368, state: 'success' }] });
});

it('reads a classic-protected branch\'s required checks with a token without admin rights', async () => {
  const run = replayGh(nonAdmin.classic), state = await gatewayFor(nonAdmin.classic, run).inspect({ fresh: true });
  expect(run.unrecorded).toEqual([]);
  // `strict` is unknown to this reader, so classic protection gives no base guard, and an automatic merge stays blocked.
  expect(state).toMatchObject({ base: pullOf(nonAdmin.classic).baseRefOid, head: pullOf(nonAdmin.classic).headRefOid,
    rulesKnown: true, atomicBaseGuard: false, mergeQueue: false, requiredChecks: [
      { context: 'build (macos-latest)', appId: null, state: 'success' },
      { context: 'build (ubuntu-latest)', appId: null, state: 'success' },
      { context: 'build (windows-latest)', appId: null, state: 'success' }] });
});

it('reads a check both a ruleset and classic protection require once, with a token without admin rights', async () => {
  const run = replayGh(nonAdmin.mixed), state = await gatewayFor(nonAdmin.mixed, run).inspect({ fresh: true });
  expect(run.unrecorded).toEqual([]);
  // App 2935623 is private: GitHub's GraphQL API gives this reader `app: null` for its check suite, though REST names
  // the app (private-app-suites.json, recorded 2026-10-21). Filtering suites by app ID on GitHub's side still returns
  // that suite, with its skipped `vite-ecosystem-ci` run, so the check reads as passing (#176 review).
  const privateApp = loadRecording('private-app-suites');
  const rest = JSON.parse(privateApp.calls.find(call => call.args[1]!.endsWith('/check-suites'))!.stdout) as { id: number; app: { id: number; slug: string } }[];
  const graphql = JSON.parse(privateApp.calls.find(call => call.args[1] === 'graphql')!.stdout) as
    { data: { repository: { object: { checkSuites: { nodes: { databaseId: number; app: { databaseId: number } | null }[] } } } } };
  const suite = rest.find(entry => entry.app.id === 2935623)!;
  expect(suite.app.slug).toBe('svite-ecosystem-ci');
  expect(graphql.data.repository.object.checkSuites.nodes.find(node => node.databaseId === suite.id)).toEqual({ databaseId: suite.id, app: null });
  const answer = JSON.parse(nonAdmin.mixed.calls.find(call => call.args[1] === 'graphql')!.stdout) as
    { data: { repository: { object: { c0: { totalCount: number; nodes: { checkRuns: { nodes: { name: string; conclusion: string }[] } }[] } } } } };
  expect(answer.data.repository.object.c0).toMatchObject({ totalCount: 1, nodes: [{ checkRuns: { nodes: [{ name: 'vite-ecosystem-ci', conclusion: 'SKIPPED' }] } }] });
  expect(state).toMatchObject({ rulesKnown: true, atomicBaseGuard: false, requiredChecks: [{ context: 'vite-ecosystem-ci', appId: 2935623, state: 'success' }] });
});

// Pinned-check reads on public commits whose rules pin no check, recorded 2026-10-21 with gh 2.102.0 by
// scripts/record-pinned-gh.ts, which runs the gateway with the same fake pull request and rules as `inspectPinned` below
// and sends only the pinned-check read to the real gh. Each file also holds a REST read that shows what makes the
// commit a case worth recording.
// - pinned-rerun: codeabovelab/codeboost commit e3697dd (PR 151's head). REST's list of every run (`filter=all`) shows
//   suite 102552054061 ran `test` twice: failed at 21:54, passed when re-run at 22:02.
// - pinned-large-suite: microsoft/vscode commit b3aa5cb (PR 343099's head). REST counts more than 100 runs in GitHub
//   Actions suite 107124344927, more than one page of runs holds.
const pinnedRecordings = { rerun: loadRecording('pinned-rerun'), largeSuite: loadRecording('pinned-large-suite') };
/**
 * Inspects `recording`'s head with `context` pinned to `appId`; only the pinned-check read is answered from the recording.
 * The other answers follow the shapes gh 2.102.0 gave in zero-checks.json for a branch no classic protection covers:
 * the branch read with `name`, `protected` and `protection`, and the protection read's 404 "Branch not protected", as
 * runWithInput reports it. The pull request read leaves out `url` and gives an empty rollup: the gateway reads `url`
 * only for display, and a pinned check is never matched from the rollup. The ruleset leaves out each rule's
 * `ruleset_source_type`, `ruleset_source`, `ruleset_id` and `do_not_enforce_on_create`, which the gateway does not read.
 */
async function inspectPinned(recording: RecordedGh, head: string, context: string, appId: number) {
  const replay = replayGh(recording);
  const notProtected = '{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}';
  const run: RunGh = async (args, options) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr view')) return JSON.stringify({ baseRefName: 'main', baseRefOid: '0'.repeat(40), headRefName: 'x', headRefOid: head, isDraft: false, mergeable: 'MERGEABLE', number: recording.pullRequest, state: 'OPEN', statusCheckRollup: [] });
    if (joined.includes('/rules/branches/')) return JSON.stringify([[{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context, integration_id: appId }] } }]]);
    if (/branches\/main$/.test(joined)) return JSON.stringify({ name: 'main', protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } });
    if (joined.endsWith('/protection')) throw new CommandFailed(`gh failed (exit 1): gh: Branch not protected (HTTP 404)\n${notProtected}`, 'gh: Branch not protected (HTTP 404)', notProtected);
    return replay(args, options);
  };
  const state = await new GhMergeGateway({ repository: recording.repository, pullRequest: recording.pullRequest, issue: 1 }, run, clearCheck(recording.repository)).inspect({ fresh: true });
  expect(replay.unrecorded).toEqual([]);
  expect(replay.calls.filter(args => args[1] === 'graphql')).toHaveLength(1);
  return state;
}
type PinnedAnswer = { data: { repository: { object: { c0: { nodes: { checkRuns: { totalCount: number; nodes: { name: string; conclusion: string }[] } }[] } } } } };
const pinnedAnswer = (recording: RecordedGh) => JSON.parse(recording.calls.find(call => call.args[1] === 'graphql')!.stdout) as PinnedAnswer;

it('reads only the latest run of a pinned check inside a suite that re-ran it', async () => {
  const { rerun } = pinnedRecordings;
  expect(rerun.gh).toBe('gh version 2.102.0 (2026-09-30)');
  const every = JSON.parse(rerun.calls.find(call => call.args[1]!.includes('filter=all'))!.stdout) as { name: string; conclusion: string; check_suite: { id: number } }[];
  expect(every.filter(check => check.name === 'test' && check.check_suite.id === 102552054061).map(check => check.conclusion).sort()).toEqual(['failure', 'success']);
  // The read asks for each suite's latest run of a name, and GitHub leaves the older failure out.
  expect(pinnedAnswer(rerun).data.repository.object.c0.nodes.flatMap(suite => suite.checkRuns.nodes.map(check => check.conclusion))).toEqual(['SUCCESS', 'SUCCESS']);
  expect((await inspectPinned(rerun, 'e3697dd532643de0f831b678856b2d677338231d', 'test', 15368)).requiredChecks).toEqual([{ context: 'test', appId: 15368, state: 'success' }]);
});

it('reads a pinned check from an app whose suite has more than 100 runs', async () => {
  const { largeSuite } = pinnedRecordings;
  expect(largeSuite.gh).toBe('gh version 2.102.0 (2026-09-30)');
  const count = JSON.parse(largeSuite.calls.find(call => call.args[1]!.includes('/check-suites/'))!.stdout) as { total_count: number; app: { id: number }; check_suite: { id: number; head_sha: string } };
  // The suite had 101 runs when the review found it and 116 when this was recorded, later the same day.
  expect(count).toEqual({ total_count: 116, app: { id: 15368 }, check_suite: { id: 107124344927, head_sha: 'b3aa5cb6d1d0267f1b60cbb0bffaba898c83ad3f' } });
  // GitHub filters the runs by name, so that suite answers with only the one run asked for.
  const suites = pinnedAnswer(largeSuite).data.repository.object.c0.nodes;
  expect(suites.map(suite => suite.checkRuns.totalCount).sort()).toEqual([0, 0, 0, 0, 1]);
  expect((await inspectPinned(largeSuite, 'b3aa5cb6d1d0267f1b60cbb0bffaba898c83ad3f', 'Detect Changes', 15368)).requiredChecks)
    .toEqual([{ context: 'Detect Changes', appId: 15368, state: 'success' }]);
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
    // `gh pr merge` was not recorded: it would merge the pull request. This fake answers exit 0 with empty stdout and
    // stderr, leaving out whatever gh prints; the gateway reads only the exit status (github/merge.ts `merge`). It
    // stands for gh 2.102.0, the recordings' version, which exits 0 only when its command succeeds.
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

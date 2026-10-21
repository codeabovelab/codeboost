import { GhAlreadyFixedGateway, type AlreadyFixedGateway, type AlreadyFixedMatch } from './already-fixed.ts';
import { ghEnvironment } from './gh-env.ts';
import { markerOf } from './pull-requests.ts';
import { CommandFailed, ghAnswered, runWithInput } from './run-with-input.ts';
import { RemoteTimeout } from './timeout.ts';
import { BRANCH, REPOSITORY, SHA } from './validate.ts';

/**
 * How long a stopped `gh` gets after SIGTERM before SIGKILL, and how long its inherited output pipes may stay open after
 * it exits. Every gh call of this gateway settles only when gh has stopped, so a call aborted at a deadline settles up
 * to 0.4 s later, and an inspection (at most 12 s) within 12.4 s. A merge click (14 s deadline in runner/merge.ts) can
 * also be waiting on its issue-trust read, whose stop wait is 0.75 s (github/issues.ts), or on a review load, whose
 * history worker gets 1 s after the abort before it is terminated (runner/history-job.ts). So it settles about 0.75 s
 * after its deadline, or about 1 s or a little more when a review load was running: past the 14.5 s shutdown drain
 * (docs/implementation/merge-queue.md).
 */
export const MERGE_KILL_GRACE_MS = 250, MERGE_PIPE_GRACE_MS = 150;
/**
 * How long before an inspection's deadline the already-fixed check stops: both grace periods of this gateway's runner,
 * which the check also uses, plus a margin. Its processes then settle before the deadline.
 */
export const MERGE_CHECK_SETTLE_MS = MERGE_KILL_GRACE_MS + MERGE_PIPE_GRACE_MS + 250;
/** The longest deadline of any inspection, and the default for merge-state and queue-state inspections. */
export const MERGE_INSPECTION_TIMEOUT_MS = 12_000;

export interface RequiredCheck {
  context: string;
  appId: number | null;
  state: 'success' | 'pending' | 'failure' | 'missing';
}

export interface RemoteMergeState {
  base: string;
  head: string;
  pullRequestState: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  rulesKnown: boolean;
  atomicBaseGuard: boolean;
  mergeQueue: boolean;
  requiredChecks: RequiredCheck[];
  alreadyFixed: 'clear' | 'found' | 'unknown';
  /** Why the check is `found` (its matches) or `unknown` (its reason), for display. */
  alreadyFixedDetail?: string;
  /** The pull request's web URL, when GitHub reports a valid one. Display only; never used to decide readiness. */
  url?: string;
  /** The pull request this state describes, as GitHub reports it. */
  pullRequest: number;
  /** GitHub does not merge a draft. */
  draft: boolean;
  /**
   * Read only for a published target (#121): where GitHub shows the PR, its description's first line, whether it comes
   * from a fork, and every open PR from its head branch. The coordinator decides from these whether it is the task's PR.
   */
  published?: PublishedPullRequestState;
}
export interface PublishedPullRequestState {
  headBranch: string; baseBranch: string; crossRepository: boolean; marker: string;
  branchOpen: Array<{ number: number; base: string }>;
}
/** The pull request one inspection acts on. Without one, the gateway uses its configured `pullRequest`. */
export interface MergeTarget {
  pullRequest: number;
  /** The task's own PRs in this repository; the already-fixed check excludes them while open. `pullRequest` is always one. */
  ownPullRequests?: readonly number[];
  /** The task branch of a published target (#121). The inspection then also reads `RemoteMergeState.published`. */
  headBranch?: string;
  /**
   * Where the already-fixed commit scan starts, so it covers every base commit after the task's original base, which a
   * rebase can bring under the PR (F6b of #22; the runner picks it, `merge-handoff.md`). Default: the PR's base commit.
   */
  alreadyFixedSince?: string;
  /** Commits the task made; the already-fixed scan does not count them. Default: none. */
  ownCommits?: readonly string[];
}

export interface MergeResult { url: string; }
export class MergeSubmissionError extends Error {
  readonly outcome: 'refused' | 'unknown';
  constructor(message: string, outcome: 'refused' | 'unknown', options?: ErrorOptions) {
    super(message, options);
    this.name = 'MergeSubmissionError';
    this.outcome = outcome;
  }
}
export type MergeQueueEntryPhase = 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED';
export type MergeQueueObservation =
  | { state: 'queued'; reviewedHead: string; entryId: string; phase: MergeQueueEntryPhase; position: number; enqueuedAt: string; queueHead: string }
  | { state: 'removed'; reviewedHead: string; removedAt: string; reason: string }
  | { state: 'failed'; reviewedHead: string; entryId: string; reason: string }
  | { state: 'merged'; reviewedHead: string; mergedAt: string };
export interface MergeQueueGateway {
  queueWatermark(expectedHead: string, options?: { signal?: AbortSignal; timeoutMs?: number; pullRequest?: number }): Promise<string | null>;
  inspectQueue(expectedHead: string, options?: { signal?: AbortSignal; timeoutMs?: number; afterCursor?: string | null; pullRequest?: number }): Promise<MergeQueueObservation>;
}
export interface MergeGateway {
  inspect(options?: { fresh?: boolean; timeoutMs?: number; signal?: AbortSignal; target?: MergeTarget }): Promise<RemoteMergeState>;
  /** `pullRequest`: the PR to merge; without it, the configured one. */
  merge(expectedHead: string, options?: { signal?: AbortSignal; pullRequest?: number }): Promise<MergeResult>;
}

export interface GhMergeConfig {
  repository: string;
  /**
   * The PR to merge. Required without a runner block. With one, the merge targets the task's published PR, and this, if
   * set, must name that PR (#121).
   */
  pullRequest?: number;
  issue: number;
  method?: 'merge' | 'squash' | 'rebase';
  /** The branch a task's pull request targets (#103). Required when the review has a runner block. */
  baseBranch?: string;
}

type ResolvedTarget = { pullRequest: number; ownPullRequests: readonly number[]; headBranch?: string; alreadyFixedSince?: string; ownCommits?: readonly string[] };
type BranchRules = Pick<RemoteMergeState, 'rulesKnown' | 'atomicBaseGuard' | 'mergeQueue' | 'requiredChecks'>;
export type RunGh = (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<string>;

/**
 * The already-fixed matches as display text. Only validated fields are used (repository names, numbers, states, SHAs and
 * the check's own close description), never a commit message, and at most five are named.
 */
function describeMatches(matches: readonly AlreadyFixedMatch[]): string {
  const named = matches.slice(0, 5).map(match => match.kind === 'closed' ? `the issue was closed by ${match.by.replace(/^commit ([a-f0-9]{12})[a-f0-9]{28}\b/, 'commit $1')}`
    : match.kind === 'pull request' ? `${match.repository}#${match.number} (${match.state.toLowerCase()}${match.draft ? ', draft' : ''})`
    : `commit ${match.sha.slice(0, 12)} on the base branch`);
  return named.join('; ') + (matches.length > 5 ? `; and ${matches.length - 5} more` : '');
}

function confirmedMergeRefusal(message: string): boolean {
  return /required (?:approving )?review|required status check|branch protection|merge conflict|not mergeable|head (?:branch |commit )?(?:was )?(?:modified|changed)|does not match.*head|pull request.*(?:closed|draft)|merge method.*not allowed/i.test(message);
}

function validNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`GitHub returned an invalid ${label}.`);
  return value;
}

function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.some(page => !Array.isArray(page))) throw new Error('GitHub returned an invalid paginated response.');
  return value.flat();
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`GitHub returned an invalid ${label}.`);
  return value;
}

/**
 * The state GitHub gives one observed required check. A check run that completed SUCCESS, NEUTRAL or SKIPPED passes, as
 * GitHub treats those conclusions for required checks; a commit status passes only with SUCCESS.
 */
function observedCheckState(check: Record<string, unknown>): 'success' | 'pending' | 'failure' {
  if (typeof check.name === 'string') {
    const status = String(check.status ?? '').toUpperCase();
    const conclusion = String(check.conclusion ?? '').toUpperCase();
    if (['QUEUED','IN_PROGRESS','WAITING','PENDING','REQUESTED'].includes(status)) return 'pending';
    if (status === 'COMPLETED') return ['SUCCESS','NEUTRAL','SKIPPED'].includes(conclusion) ? 'success' : 'failure';
    return 'failure';
  }
  const status = String(check.state ?? '').toUpperCase();
  return status === 'SUCCESS' ? 'success' : ['PENDING','EXPECTED'].includes(status) ? 'pending' : 'failure';
}
/** A real time gh reports, or NaN for none or the zero time (year 1) it gives a run that has not started or finished. */
function observedTime(value: unknown): number {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && new Date(at).getUTCFullYear() > 1 ? at : NaN;
}
/**
 * When an observed check run or status started, to pick the latest of several with one name, or NaN when that is not
 * known. A run or commit status not yet completed (queued, in progress, pending) with no start time was queued after
 * every started one, so it counts as the latest (+Infinity). A completed one with no start time gets NaN: its order
 * relative to the latest is unknown (see `observedCheckOlderThan`).
 */
function observedCheckStart(check: Record<string, unknown>): number {
  const started = observedTime(check.startedAt);
  if (Number.isFinite(started)) return started;
  return observedCheckState(check) === 'pending' ? Number.POSITIVE_INFINITY : NaN;
}
/**
 * For a completed run or commit status with no start time: its completion time, before which it started, so it is
 * known to be older than any observation of its kind that started after that time. NaN when it has a start time, is not
 * completed, or has no completion time.
 */
function observedCheckOlderThan(check: Record<string, unknown>): number {
  return Number.isNaN(observedCheckStart(check)) ? observedTime(check.completedAt) : NaN;
}
/**
 * The message of GitHub's own 404 answer, from the body gh prints, not only from gh's message: "Branch not protected"
 * for a branch with no classic protection, "Not Found" for a token that may not read it (or for a branch deleted since
 * the branch read). Null for any other failure.
 */
function github404(error: Error): string | null {
  if (!(error instanceof CommandFailed)) return null;
  try {
    const body = JSON.parse(error.stdout) as { message?: unknown; status?: unknown } | null;
    return body?.status === '404' && typeof body.message === 'string' ? body.message : null;
  } catch { return null; }
}
/**
 * Classic required checks from the branch read's `protection.required_status_checks`, which a token with read access
 * got on the public repositories recorded in test/fixtures/gh/nonadmin-*.json, in the shape of the protection read's.
 * GitHub leaves `strict` out there, so it reads as false: that only withholds the base guard. `enforced` is false for
 * enforcement level `off`. Null when the answer's shape is wrong or contradicts itself (checks listed while enforcement
 * is off); its entries are checked as the protection read's are.
 */
function classicFromBranch(required: unknown): { enforced: boolean; strict: false; contexts: unknown[]; checks: unknown[] } | null {
  if (!required || typeof required !== 'object' || Array.isArray(required)) return null;
  const value = required as { enforcement_level?: unknown; contexts?: unknown; checks?: unknown };
  if (!['off','non_admins','everyone'].includes(value.enforcement_level as string) || !Array.isArray(value.contexts) || !Array.isArray(value.checks)) return null;
  const enforced = value.enforcement_level !== 'off';
  if (!enforced && (value.contexts.length || value.checks.length)) return null;
  return { enforced, strict: false, contexts: value.contexts, checks: value.checks };
}
/** Every value GitHub's GraphQL API documents for a check run's `status` and `conclusion` (CheckStatusState, CheckConclusionState). */
const CHECK_RUN_STATUSES = ['REQUESTED','QUEUED','IN_PROGRESS','COMPLETED','WAITING','PENDING'];
const CHECK_RUN_CONCLUSIONS = ['ACTION_REQUIRED','CANCELLED','FAILURE','NEUTRAL','SKIPPED','STALE','STARTUP_FAILURE','SUCCESS','TIMED_OUT'];
/**
 * Pinned checks read per `gh api graphql` call, and pages of 100 suites read per check. Each check asks for at most
 * 100 suites of 100 runs, so 25 stay well inside GitHub's limit of 500,000 nodes per query.
 */
const PINNED_CHECKS_PER_READ = 25, PINNED_SUITE_PAGES = 10;
const pinnedKey = (context: string, appId: number) => `${context}\0${appId}`;
/** Among runs with the same start, the one that passes least counts, so a tie never reads as passing. */
const checkStateRank = { failure: 0, pending: 1, success: 2 } as const;

/** GitHub CLI adapter. All arguments are literal argv; no shell is involved. */
export class GhMergeGateway implements MergeGateway, MergeQueueGateway {
  readonly config: GhMergeConfig;
  readonly run: RunGh;
  readonly checks: AlreadyFixedGateway;
  /** Keyed by the inspected target, so a state read for one PR is never served for another. */
  #cache: { key: string; expiresAt: number; state: RemoteMergeState } | null = null;
  #generation = 0;
  #inflight: { generation: number; key: string; promise: Promise<RemoteMergeState> } | null = null;
  /** `checks` defaults to the pre-PR check's GitHub adapter for the same repository, using this gateway's runner. */
  constructor(config: GhMergeConfig, run?: RunGh, checks?: AlreadyFixedGateway) {
    if (!REPOSITORY.test(config.repository) || (config.pullRequest !== undefined && !validNumber(config.pullRequest)) || !Number.isSafeInteger(config.issue) || config.issue < 1)
      throw new Error('A GitHub repository and issue, and a valid pull request number if one is given, are required for merging.');
    if (config.method !== undefined && !['merge','squash','rebase'].includes(config.method)) throw new Error('GitHub merge method must be merge, squash, or rebase.');
    if (checks && checks.repository?.toLowerCase() !== config.repository.toLowerCase()) throw new Error('The already-fixed check must name and read the merge repository.');
    this.config = config;
    this.run = run ?? ((args, options) => runWithInput('gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal, env: ghEnvironment(), killGraceMs: MERGE_KILL_GRACE_MS, pipeGraceMs: MERGE_PIPE_GRACE_MS }));
    // The check uses this gateway's runner, so its stopped `gh` calls settle within the same grace periods as the merge's.
    this.checks = checks ?? new GhAlreadyFixedGateway({ repository: config.repository }, this.run);
  }

  /** The PR a call acts on: the one given, else the configured one. */
  #number(pullRequest?: number): number {
    const number = pullRequest ?? this.config.pullRequest;
    if (number === undefined) throw new Error('No pull request to merge: add github.pullRequest, or publish the task\'s pull request first.');
    if (!validNumber(number)) throw new Error('Invalid pull request number.');
    return number;
  }

  #target(target?: MergeTarget): ResolvedTarget {
    const pullRequest = this.#number(target?.pullRequest);
    const own = target?.ownPullRequests ?? [];
    if (own.some(number => !validNumber(number))) throw new Error('Invalid pull request number.');
    if (target?.headBranch !== undefined && (typeof target.headBranch !== 'string' || !BRANCH.test(target.headBranch))) throw new Error('Invalid pull request branch.');
    if (target?.alreadyFixedSince !== undefined && (typeof target.alreadyFixedSince !== 'string' || !SHA.test(target.alreadyFixedSince))) throw new Error('Invalid already-fixed scan start.');
    if (target?.ownCommits !== undefined && (!Array.isArray(target.ownCommits) || target.ownCommits.some(sha => typeof sha !== 'string' || !SHA.test(sha)))) throw new Error('Invalid own commit.');
    return { pullRequest, ownPullRequests: [...new Set([pullRequest, ...own])], ...(target?.headBranch !== undefined ? { headBranch: target.headBranch } : {}),
      ...(target?.alreadyFixedSince !== undefined ? { alreadyFixedSince: target.alreadyFixedSince } : {}),
      ...(target?.ownCommits !== undefined ? { ownCommits: [...new Set(target.ownCommits)].sort() } : {}) };
  }

  async #json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.run(args, { signal });
    try { return JSON.parse(output); }
    catch { throw new Error('GitHub returned invalid JSON.'); }
  }

  /**
   * The pre-merge "already fixed" check runs the pre-PR check (`github/already-fixed.ts`) with the same rules. This PR and
   * the task's other recorded PRs are its own: excluded while open, a match once merged. The base-branch scan starts at
   * `target.alreadyFixedSince` when given (a runner-published PR), else at the PR's base commit; `target.ownCommits`, the
   * task's own commits a rebase may have rewritten, are not counted.
   * The check stops early enough that its `gh` processes, which may need both grace periods after an abort, settle before
   * the inspection's deadline; stopped that way it is `unknown`.
   */
  async #alreadyFixed(target: ResolvedTarget, baseBranch: string, base: string, deadlineAt: number, signal?: AbortSignal): Promise<Pick<RemoteMergeState, 'alreadyFixed' | 'alreadyFixedDetail'>> {
    // A check started with no settle time left could leave processes running past the inspection's deadline.
    const runFor = deadlineAt - MERGE_CHECK_SETTLE_MS - Date.now();
    if (runFor <= 0) return { alreadyFixed: 'unknown', alreadyFixedDetail: 'No time was left to run the check.' };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error('The already-fixed check did not finish in time.')), runFor);
    try {
      const result = await this.checks.check({ issue: this.config.issue, taskBase: target.alreadyFixedSince ?? base, baseBranch,
        ownPullRequests: [...target.ownPullRequests], ownCommits: new Set(target.ownCommits ?? []) },
        signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
      // An answer that arrives after the check was stopped is not used. (One after a caller's abort is refused by the
      // inspection itself, once the rule reads have ended.)
      if (stop.signal.aborted) return { alreadyFixed: 'unknown', alreadyFixedDetail: 'The check did not finish in time.' };
      // `clear` removes this blocker, so a clear or found answer without its base head is malformed and counts as unknown.
      const based = (result.outcome === 'clear' || result.outcome === 'found') && typeof result.baseHead === 'string' && SHA.test(result.baseHead);
      if (based && result.outcome === 'clear') return { alreadyFixed: 'clear' };
      if (based && result.outcome === 'found' && Array.isArray(result.matches) && result.matches.length) return { alreadyFixed: 'found', alreadyFixedDetail: describeMatches(result.matches) };
      return { alreadyFixed: 'unknown', alreadyFixedDetail: result.outcome === 'unknown' && typeof result.reason === 'string' ? result.reason.slice(0, 300) : 'The check returned an invalid result.' };
    } catch (error) {
      // After an abort, the check's own gh failure stays its result, as without the abort: an unknown blocker, which the
      // inspection then discards for the abort (#48). Any other error is rethrown, including the abort's own reason; a
      // failed stage's error is that reason, so a check it stopped rejects with that error, which changes no answer: the
      // failed stage's own rejection is checked first.
      if (signal?.aborted && (error === signal.reason || !ghAnswered(error))) throw error;
      return { alreadyFixed: 'unknown', alreadyFixedDetail: stop.signal.aborted ? 'The check did not finish in time.' : 'GitHub could not be read.' };
    } finally { clearTimeout(timer); }
  }

  async #inspectNow(target: ResolvedTarget, deadlineAt: number, signal?: AbortSignal): Promise<RemoteMergeState> {
    const published = target.headBranch !== undefined;
    const fields = 'number,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup,url' + (published ? ',body,isCrossRepository' : '');
    const pr = await this.#json(['pr','view',String(target.pullRequest),'--repo',this.config.repository,'--json',fields], signal) as Record<string, unknown>;
    if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || !['OPEN','CLOSED','MERGED'].includes(String(pr.state)) || !['MERGEABLE','CONFLICTING','UNKNOWN'].includes(String(pr.mergeable)) || !Array.isArray(pr.statusCheckRollup)
      || typeof pr.isDraft !== 'boolean' || (published && (typeof pr.body !== 'string' || typeof pr.isCrossRepository !== 'boolean')))
      throw new Error('GitHub returned an incomplete pull request state.');
    if (pr.number !== target.pullRequest) throw new Error('GitHub returned a different pull request.');
    const base = fullSha(pr.baseRefOid, 'base SHA'), head = fullSha(pr.headRefOid, 'head SHA');
    // The already-fixed check needs only the PR's base, so it runs alongside the rule reads (and, for a published target,
    // the branch's PR list). If either read fails, the others are stopped. All three are awaited on every path, so no `gh`
    // process they started outlives the inspection.
    const failed = new AbortController(), reads = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
    const stopOthers = (error: unknown) => { failed.abort(error); throw error; };
    // Handled from the start: a stopped check can settle before the other stages, and an unhandled rejection meanwhile
    // would reach Node's process-wide handler (#48).
    const alreadyFixed = this.#alreadyFixed(target, pr.baseRefName, base, deadlineAt, reads)
      .catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    const [ruleRead, listRead] = await Promise.allSettled([
      this.#rules(pr.baseRefName, head, pr.statusCheckRollup as Array<Record<string, unknown>>, reads).catch(stopOthers),
      published ? this.#branchOpen(target.headBranch!, reads).catch(stopOthers) : undefined,
    ]);
    const fixed = await alreadyFixed;
    // The first stage to fail stopped the others, and its error is `failed`'s reason. A stopped stage can still settle
    // with an error of its own (its gh had already exited, and its pipes closed after the stop), so the first failure is
    // reported, not the first stage in this list that failed. Every rejection above aborts `failed`, so the loop after it is a backstop.
    if (failed.signal.aborted) throw failed.signal.reason;
    for (const read of [ruleRead, listRead]) if (read.status === 'rejected') throw read.reason;
    if (fixed instanceof Error) throw fixed;
    const rules = (ruleRead as PromiseFulfilledResult<BranchRules>).value;
    const branchOpen = (listRead as PromiseFulfilledResult<PublishedPullRequestState['branchOpen'] | undefined>).value;
    // The rule reads turn a failed read into rulesKnown: false, so a read that ends after an abort must not yield a state.
    signal?.throwIfAborted();
    return {
      base, head, pullRequest: target.pullRequest, draft: pr.isDraft,
      pullRequestState: pr.state as RemoteMergeState['pullRequestState'], mergeable: pr.mergeable as RemoteMergeState['mergeable'],
      ...rules, ...fixed,
      ...(typeof pr.url === 'string' && pr.url.length <= 2048 && /^https:\/\//.test(pr.url) ? { url: pr.url } : {}),
      ...(published ? { published: { headBranch: pr.headRefName, baseBranch: pr.baseRefName, crossRepository: pr.isCrossRepository as boolean,
        marker: markerOf(pr.body as string), branchOpen: branchOpen! } } : {}),
    };
  }

  /**
   * Every open PR from `headBranch` in this repository, with its base. One page is read, as in the publisher's lookup: a
   * full page could hide another PR from the branch, so it fails closed, and so does any malformed entry.
   */
  async #branchOpen(headBranch: string, signal?: AbortSignal): Promise<PublishedPullRequestState['branchOpen']> {
    const owner = this.config.repository.split('/')[0]!;
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${headBranch}`, per_page: '100' });
    const response = await this.#json(['api','-H','Accept: application/vnd.github+json',`repos/${this.config.repository}/pulls?${query}`], signal);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid pull request list.');
    if (response.length >= 100) throw new Error(`GitHub lists 100 or more open pull requests from ${headBranch}; codeboost cannot read them all.`);
    return response.map(entry => {
      const pr = entry as { number?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown } } | null;
      if (!pr || typeof pr !== 'object' || !validNumber(pr.number) || pr.head?.ref !== headBranch || typeof pr.base?.ref !== 'string')
        throw new Error('GitHub returned an invalid pull request list.');
      return { number: pr.number, base: pr.base.ref };
    });
  }

  /**
   * For each required check pinned to an app, the runs of that check's name on commit `head` from that app's check suites,
   * in the shape of gh's statusCheckRollup entries, keyed by `pinnedKey`. gh's statusCheckRollup does not ask for a
   * run's app (#176), so a pinned check is matched from this read, `gh api graphql`. GitHub filters on its side, by
   * suite app (`checkSuites(filterBy: {appId})`) and by run name (`checkRuns(filterBy: {checkName})`, which matches
   * the name exactly), so the answer holds only the runs that can meet a pinned check. The app filter also returns a
   * suite whose `app` GitHub hides from this reader (a private app), which an app read from the answer would not name.
   * Only each suite's latest run of a name is asked for (`checkType: LATEST`): a run re-run inside its suite is left out.
   * Each check is one alias in the query, with up to PINNED_CHECKS_PER_READ checks per call; a check whose app has more
   * than 100 suites on the head is paged, up to PINNED_SUITE_PAGES pages. That cap only bounds the work: at about a second
   * per call, the inspection's deadline usually stops the read first (after a few pages in a fresh six-second inspection,
   * about nine in a 12-second display one), and the inspection then fails with its timeout.
   *
   * The read fails closed. A gh failure keeps gh's error. GitHub's own errors in an answer, a malformed field, an answer
   * for another commit, a suite with more runs of the name than one page holds, more suites than the page limit, and
   * suites that change between pages each fail it with codeboost's reason.
   */
  async #pinnedRuns(head: string, pinned: ReadonlyArray<{ context: string; appId: number }>, signal?: AbortSignal): Promise<Map<string, Array<Record<string, unknown>>>> {
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const found = new Map<string, Array<Record<string, unknown>>>();
    for (let start = 0; start < pinned.length; start += PINNED_CHECKS_PER_READ) {
      // Every check of this call, with its cursor (null for its first page), its suites seen and GitHub's suite count.
      const checks = pinned.slice(start, start + PINNED_CHECKS_PER_READ).map(check => ({ ...check, cursor: null as string | null, suites: 0, total: null as number | null, done: false }));
      for (const check of checks) found.set(pinnedKey(check.context, check.appId), []);
      for (let page = 1; checks.some(check => !check.done); page++) {
        const open = checks.map((check, index) => ({ check, index })).filter(({ check }) => !check.done);
        const declared = open.map(({ index }) => `,$app${index}:Int!,$name${index}:String!,$after${index}:String`).join('');
        const selected = open.map(({ index }) => ` c${index}:checkSuites(first:100,after:$after${index},filterBy:{appId:$app${index}}){totalCount pageInfo{hasNextPage endCursor} nodes{checkRuns(first:100,filterBy:{checkName:$name${index},checkType:LATEST}){totalCount nodes{name status conclusion startedAt completedAt}}}}`).join('');
        const query = `query($owner:String!,$repo:String!,$oid:GitObjectID!${declared}){repository(owner:$owner,name:$repo){object(oid:$oid){__typename ... on Commit{oid${selected}}}}}`;
        // `-F` makes an app ID a number; a name always goes with `-f`, which gh passes as a literal string.
        const args = ['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`repo=${name}`,'-f',`oid=${head}`];
        for (const { check, index } of open) {
          args.push('-F', `app${index}=${check.appId}`, '-f', `name${index}=${check.context}`);
          if (check.cursor !== null) args.push('-f', `after${index}=${check.cursor}`);
        }
        const response = await this.#json(args, signal) as { data?: { repository?: { object?: Record<string, unknown> | null } | null }; errors?: unknown } | null;
        signal?.throwIfAborted();
        // gh exits 1 on an answer with errors, so this is defensive: such an answer never reaches here as gh's output.
        if (!response || typeof response !== 'object' || (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)))
          throw new Error('GitHub returned check runs with errors.');
        const commit = response.data?.repository?.object;
        if (!commit || commit.__typename !== 'Commit' || commit.oid !== head) throw new Error('GitHub returned no check runs for the pull request head.');
        for (const { check, index } of open) {
          const connection = commit[`c${index}`] as { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null; nodes?: unknown } | null | undefined;
          if (!connection || typeof connection !== 'object' || !Number.isSafeInteger(connection.totalCount) || (connection.totalCount as number) < 0 || !Array.isArray(connection.nodes)
              || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean' || (connection.pageInfo.endCursor !== null && typeof connection.pageInfo.endCursor !== 'string'))
            throw new Error('GitHub returned incomplete check runs.');
          if (check.total !== null && connection.totalCount !== check.total) throw new Error('The check suites on the pull request head changed while they were read.');
          check.total = connection.totalCount as number;
          const runs = found.get(pinnedKey(check.context, check.appId))!;
          for (const suite of connection.nodes) {
            const checkRuns = (suite as { checkRuns?: { totalCount?: unknown; nodes?: unknown } | null } | null)?.checkRuns;
            if (!checkRuns || typeof checkRuns !== 'object' || !Number.isSafeInteger(checkRuns.totalCount) || !Array.isArray(checkRuns.nodes)) throw new Error('GitHub returned incomplete check runs.');
            // One page of runs per suite is read: more latest runs of one name in one suite than it holds could hide one.
            if (checkRuns.nodes.length !== checkRuns.totalCount) throw new Error(`A check suite on the pull request head has more runs named ${JSON.stringify(check.context)} than codeboost can read.`);
            for (const run of checkRuns.nodes) {
              const value = run as Record<string, unknown> | null;
              if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !CHECK_RUN_STATUSES.includes(value.status as string)
                  || (value.conclusion !== null && !CHECK_RUN_CONCLUSIONS.includes(value.conclusion as string))
                  || (value.startedAt !== null && typeof value.startedAt !== 'string') || (value.completedAt !== null && typeof value.completedAt !== 'string'))
                throw new Error('GitHub returned a malformed check run.');
              // GitHub's name filter is exact (checked against GitHub); a run of another name could only be dropped here.
              if (value.name === check.context)
                runs.push({ name: value.name, status: value.status, conclusion: value.conclusion, startedAt: value.startedAt, completedAt: value.completedAt });
            }
          }
          check.suites += connection.nodes.length;
          if (!connection.pageInfo.hasNextPage) {
            if (check.suites !== check.total) throw new Error('The check suites on the pull request head changed while they were read.');
            check.done = true;
            continue;
          }
          if (page === PINNED_SUITE_PAGES)
            throw new Error(`The pull request head has more check suites from app ${check.appId} than codeboost can read.`);
          // A next page without a cursor to it is a malformed answer, not a long one.
          if (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor) throw new Error('GitHub returned incomplete check runs.');
          check.cursor = connection.pageInfo.endCursor;
        }
      }
    }
    return found;
  }

  /** The effective branch rules and the state of each required check on the PR, whose head is `head`. */
  async #rules(baseRefName: string, head: string, observed: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<BranchRules> {
    const branch = encodeURIComponent(baseRefName);
    let rulesKnown = true;
    let rules: unknown[] = [];
    let classic: unknown | null = null;
    try {
      rules = flattenPages(await this.#json(['api','--paginate','--slurp',`repos/${this.config.repository}/rules/branches/${branch}`], signal));
      const branchState = await this.#json(['api',`repos/${this.config.repository}/branches/${branch}`], signal) as
        { protected?: unknown; protection?: { enabled?: unknown; required_status_checks?: unknown } | null };
      if (typeof branchState.protected !== 'boolean') throw new Error('GitHub returned an incomplete branch state.');
      let protection: unknown | null = null, answer404: string | null = null;
      try { protection = await this.#json(['api',`repos/${this.config.repository}/branches/${branch}/protection`], signal); }
      catch (error) {
        if (!(error instanceof Error) || !/HTTP 404|not found/i.test(error.message)) throw error;
        answer404 = github404(error);
      }
      if (protection === null) {
        // `protected` is also true when only a ruleset applies. The branch read then shows classic protection off
        // (`protection.enabled` false), and the protection read answers 404: "Branch not protected" to a token with
        // admin rights, "Not Found" to one without. With classic protection on, a token without admin rights gets
        // "Not Found" too, and the branch read lists the required checks (all recorded in test/fixtures/gh/). Any
        // other answer on a protected branch may hide classic rules: fail closed.
        if (branchState.protected) {
          const enabled = branchState.protection?.enabled, fromBranch = classicFromBranch(branchState.protection?.required_status_checks);
          // Classic protection off must also show no enforced checks.
          const classicOff = enabled === false && fromBranch?.enforced === false && (answer404 === 'Branch not protected' || answer404 === 'Not Found');
          if (!classicOff) {
            if (!(enabled === true && answer404 === 'Not Found' && fromBranch)) throw new Error('Branch protection is present but unreadable.');
            classic = fromBranch;
          }
        }
      } else if (!protection || typeof protection !== 'object' || !('required_status_checks' in protection)) {
        throw new Error('GitHub returned incomplete branch protection.');
      } else {
        const required = (protection as { required_status_checks: unknown }).required_status_checks;
        if (required !== null && (typeof required !== 'object' || Array.isArray(required))) throw new Error('GitHub returned malformed branch protection.');
        classic = required;
      }
    } catch { rulesKnown = false; }
    const requirements = new Map<string, { context: string; appId: number | null }>();
    let atomicBaseGuard = false;
    let mergeQueue = false;
    if (rulesKnown) {
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') { rulesKnown = false; break; }
        const value = rule as { type?: unknown; parameters?: Record<string, unknown> };
        if (typeof value.type !== 'string') { rulesKnown = false; break; }
        if (value.type === 'merge_queue') { mergeQueue = true; atomicBaseGuard = true; }
        if (value.type !== 'required_status_checks') continue;
        const parameters = value.parameters;
        if (!parameters || !Array.isArray(parameters.required_status_checks)) { rulesKnown = false; break; }
        if (parameters.strict_required_status_checks_policy === true && parameters.required_status_checks.length > 0) atomicBaseGuard = true;
        for (const check of parameters.required_status_checks) {
          if (!check || typeof check !== 'object' || typeof (check as { context?: unknown }).context !== 'string') { rulesKnown = false; break; }
          const context = (check as { context: string }).context;
          // GitHub leaves `integration_id` out for a check any app may report (recorded in test/fixtures/gh/).
          const app = Object.hasOwn(check, 'integration_id') ? (check as { integration_id: unknown }).integration_id : null;
          if (app !== null && (!Number.isSafeInteger(app) || (app as number) < 1)) { rulesKnown = false; break; }
          const appId = app as number | null;
          requirements.set(`${context}\0${appId ?? ''}`, { context, appId });
        }
      }
      if (classic && typeof classic === 'object') {
        const value = classic as { strict?: unknown; checks?: unknown; contexts?: unknown };
        const hasChecks = Object.hasOwn(value, 'checks'), hasContexts = Object.hasOwn(value, 'contexts');
        if (typeof value.strict !== 'boolean' || (hasChecks && !Array.isArray(value.checks)) || (hasContexts && !Array.isArray(value.contexts)) || (!hasChecks && !hasContexts)) rulesKnown = false;
        const contexts = Array.isArray(value.contexts) ? value.contexts : [];
        const suppliedChecks = Array.isArray(value.checks) ? value.checks : [];
        if (contexts.some(context => typeof context !== 'string') || suppliedChecks.some(check => !check || typeof check !== 'object' || typeof (check as { context?: unknown }).context !== 'string')) rulesKnown = false;
        if (rulesKnown && hasChecks && hasContexts) {
          const fromContexts = new Set(contexts as string[]), fromChecks = new Set(suppliedChecks.map(check => (check as { context: string }).context));
          if (fromContexts.size !== fromChecks.size || [...fromContexts].some(context => !fromChecks.has(context))) rulesKnown = false;
        }
        const checks = hasChecks ? suppliedChecks : contexts.map(context => ({ context, app_id: null }));
        if (rulesKnown && value.strict && checks.length > 0) atomicBaseGuard = true;
        if (rulesKnown) for (const check of checks) {
          if (!check || typeof check !== 'object' || typeof (check as { context?: unknown }).context !== 'string') { rulesKnown = false; break; }
          const context = (check as { context: string }).context;
          if (!Object.hasOwn(check, 'app_id')) { rulesKnown = false; break; }
          const app = (check as { app_id: unknown }).app_id;
          if (app !== null && (!Number.isSafeInteger(app) || (app as number) < 1)) { rulesKnown = false; break; }
          const appId = app as number | null;
          requirements.set(`${context}\0${appId ?? ''}`, { context, appId });
        }
      }
    }
    // A check any app may report is matched from gh's rollup, check runs and commit statuses alike. One pinned to an app
    // is matched only from the check runs that app reported on the head (#176): the rollup names no app. No commit status
    // meets a pinned check, though GitHub may count one an app set: that fails closed (the check waits or reads missing).
    // With the rules unknown the merge is blocked anyway, so the read is skipped and cannot replace that blocker. A failed
    // read fails the inspection with its reason.
    const pinnedChecks = [...requirements.values()].filter((required): required is { context: string; appId: number } => required.appId !== null);
    const pinned = rulesKnown && pinnedChecks.length ? await this.#pinnedRuns(head, pinnedChecks, signal) : new Map<string, Array<Record<string, unknown>>>();
    const requiredChecks = [...requirements.values()].map(required => {
      const matches = required.appId === null
        ? observed.filter(check => (typeof check.name === 'string' ? check.name : check.context) === required.context)
        : pinned.get(pinnedKey(required.context, required.appId)) ?? [];
      if (!matches.length) return { ...required, state: 'missing' as const };
      // A re-run adds a newer run (or status) with the same name; GitHub counts the latest one, so an older failure
      // does not outrank a newer pending or passing run. A check run and a commit status with the same name are not
      // re-runs of each other: GitHub requires both to pass. So the latest of each kind counts, and the one that passes
      // least decides.
      // The latest is the observation with the greatest known start (a not-completed one with no start counts as
      // +Infinity). A completed observation with no start time is dropped when another of its kind started (or is
      // not-completed with no start) strictly after its completion: it is known to be older. Otherwise its order is
      // unknown, so it ties with the latest, and it can only make the result pass less.
      const latestOfKind = (kind: Record<string, unknown>[]) => {
        if (kind.length === 0) return null;
        const seen = kind.map(check => ({ state: observedCheckState(check), at: observedCheckStart(check), olderThan: observedCheckOlderThan(check) }));
        const latest = Math.max(...seen.map(check => Number.isNaN(check.at) ? Number.NEGATIVE_INFINITY : check.at));
        return seen.filter(check => Number.isNaN(check.at) ? !(latest > check.olderThan) : check.at === latest)
          .reduce((worst, next) => checkStateRank[next.state] < checkStateRank[worst.state] ? next : worst).state;
      };
      const states = [latestOfKind(matches.filter(check => typeof check.name === 'string')), latestOfKind(matches.filter(check => typeof check.name !== 'string'))]
        .filter(state => state !== null);
      return { ...required, state: states.reduce((worst, next) => checkStateRank[next] < checkStateRank[worst] ? next : worst) };
    });
    return { rulesKnown, atomicBaseGuard, mergeQueue, requiredChecks };
  }

  async inspect(options: { fresh?: boolean; timeoutMs?: number; signal?: AbortSignal; target?: MergeTarget } = {}): Promise<RemoteMergeState> {
    const timeoutMs = options.timeoutMs ?? MERGE_INSPECTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MERGE_INSPECTION_TIMEOUT_MS) throw new Error('Invalid GitHub inspection timeout.');
    const target = this.#target(options.target), key = JSON.stringify(target);
    if (!options.fresh && this.#cache?.key === key && this.#cache.expiresAt > Date.now()) return this.#cache.state;
    const generation = this.#generation;
    if (!options.fresh && this.#inflight?.generation === generation && this.#inflight.key === key) return this.#inflight.promise;
    const timeout = new AbortController(), deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => timeout.abort(new RemoteTimeout('GitHub merge-state inspection timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const attempt = this.#inspectNow(target, deadlineAt, signal).catch(error => {
      // The combined signal keeps the reason of whichever abort came first, the caller's or the deadline's; a stopped gh
      // call can settle after both have fired. A CommandFailed is a gh exit, reported as itself (#48): gh exited before
      // the abort. When one stage's gh exit stops the other stages, the inspection waits for every stage to settle and
      // then reports that exit first, whatever the stopped stages settled with, even when its deadline fired meanwhile
      // (test/merge-stop-reasons.test.ts). A gh call that the abort stopped fails with the abort's reason instead.
      if (signal.aborted && !ghAnswered(error)) throw signal.reason;
      throw error;
    }).then(state => {
      if (this.#generation === generation) this.#cache = { key, expiresAt: Date.now() + 5_000, state };
      return state;
    }).finally(() => { clearTimeout(timer); if (this.#inflight?.promise === attempt) this.#inflight = null; });
    if (!options.fresh) this.#inflight = { generation, key, promise: attempt };
    return attempt;
  }

  async queueWatermark(expectedHead: string, options: { signal?: AbortSignal; timeoutMs?: number; pullRequest?: number } = {}): Promise<string | null> {
    fullSha(expectedHead, 'expected head SHA');
    const number = this.#number(options.pullRequest);
    const timeoutMs = options.timeoutMs ?? 6_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MERGE_INSPECTION_TIMEOUT_MS) throw new Error('Invalid GitHub queue watermark timeout.');
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){edges{cursor node{id}}}}}}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new RemoteTimeout('GitHub merge-queue watermark timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      const response = await this.#json(['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`], signal) as {
        data?: { repository?: { pullRequest?: { number?: unknown; headRefOid?: unknown; timelineItems?: { edges?: unknown } } | null } | null };
        errors?: unknown;
      };
      if (signal.aborted) throw signal.reason;
      if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('GitHub returned merge-queue watermark data with errors.');
      const pull = response.data?.repository?.pullRequest;
      if (!pull || pull.number !== number || fullSha(pull.headRefOid, 'queue watermark head SHA') !== expectedHead || !Array.isArray(pull.timelineItems?.edges))
        throw new Error('GitHub returned an incomplete merge-queue watermark.');
      const edges = pull.timelineItems.edges;
      if (edges.length > 1) throw new Error('GitHub returned an invalid merge-queue watermark.');
      const edge = edges[0];
      if (edge === undefined) return null;
      if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof (edge as { cursor?: unknown }).cursor !== 'string' || !(edge as { cursor: string }).cursor ||
          !(edge as { node?: unknown }).node || typeof (edge as { node: unknown }).node !== 'object' || Array.isArray((edge as { node: unknown }).node) ||
          typeof ((edge as { node: { id?: unknown } }).node.id) !== 'string' || !(edge as { node: { id: string } }).node.id)
        throw new Error('GitHub returned an invalid merge-queue watermark.');
      return (edge as { cursor: string }).cursor;
    } catch (error) {
      // The combined signal keeps the reason of whichever abort came first, the caller's or the deadline's. A CommandFailed
      // is gh's own answer, given before the abort, and is reported as itself (#48).
      if (signal.aborted && !ghAnswered(error)) throw signal.reason;
      throw error;
    } finally { clearTimeout(timer); }
  }

  async inspectQueue(expectedHead: string, options: { signal?: AbortSignal; timeoutMs?: number; afterCursor?: string | null; pullRequest?: number } = {}): Promise<MergeQueueObservation> {
    fullSha(expectedHead, 'expected head SHA');
    const number = this.#number(options.pullRequest);
    const timeoutMs = options.timeoutMs ?? MERGE_INSPECTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MERGE_INSPECTION_TIMEOUT_MS) throw new Error('Invalid GitHub queue inspection timeout.');
    const correlated = Object.hasOwn(options, 'afterCursor');
    if (options.afterCursor !== undefined && options.afterCursor !== null && (typeof options.afterCursor !== 'string' || !options.afterCursor || options.afterCursor.length > 512))
      throw new Error('Invalid merge-queue event cursor.');
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid state mergedAt mergeQueueEntry{id state position enqueuedAt headCommit{oid} pullRequest{number headRefOid}} timelineItems(first:100,after:$after,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){edges{cursor node{id __typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason beforeCommit{oid}}}} pageInfo{hasNextPage endCursor}}}}}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new RemoteTimeout('GitHub merge-queue inspection timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      let cursor = options.afterCursor ?? null, pull: Record<string, unknown> | null = null, stable = '', page = 0;
      const events: Array<{ id: string; type: unknown; createdAt: string; reason: string | undefined; beforeHead: string | undefined }> = [];
      while (page++ < 10) {
        const args = ['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`];
        if (cursor !== null) args.push('-f', `after=${cursor}`);
        const response = await this.#json(args, signal) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null }; errors?: unknown };
        if (signal.aborted) throw signal.reason;
        if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('GitHub returned merge-queue data with errors.');
        const nextPull = response.data?.repository?.pullRequest;
        if (!nextPull || nextPull.number !== number) throw new Error('GitHub returned an incomplete merge-queue pull request.');
        const current = JSON.stringify({ number: nextPull.number, headRefOid: nextPull.headRefOid, state: nextPull.state, mergedAt: nextPull.mergedAt, mergeQueueEntry: nextPull.mergeQueueEntry });
        if (stable && current !== stable) throw new Error('GitHub merge-queue state changed during paginated inspection.');
        stable = current; pull = nextPull;
        const timeline = nextPull.timelineItems;
        if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) throw new Error('GitHub returned incomplete merge-queue history.');
        const value = timeline as { edges?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
        if (!Array.isArray(value.edges) || !value.pageInfo || typeof value.pageInfo.hasNextPage !== 'boolean' ||
            (value.pageInfo.endCursor !== null && typeof value.pageInfo.endCursor !== 'string')) throw new Error('GitHub returned incomplete merge-queue pagination.');
        for (const edge of value.edges) {
          if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof (edge as { cursor?: unknown }).cursor !== 'string' || !(edge as { cursor: string }).cursor)
            throw new Error('GitHub returned a malformed merge-queue edge.');
          const event = (edge as { node?: unknown }).node;
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('GitHub returned a malformed merge-queue event.');
          const node = event as { id?: unknown; __typename?: unknown; createdAt?: unknown; reason?: unknown; beforeCommit?: { oid?: unknown } | null };
          if (typeof node.id !== 'string' || !node.id || node.id.length > 512) throw new Error('GitHub returned a merge-queue event without stable identity.');
          if (!['AddedToMergeQueueEvent','RemovedFromMergeQueueEvent'].includes(String(node.__typename))) throw new Error('GitHub returned an unknown merge-queue event.');
          const createdAt = timestamp(node.createdAt, 'merge-queue event time');
          if (node.__typename === 'RemovedFromMergeQueueEvent' && (typeof node.reason !== 'string' || !node.reason.trim())) throw new Error('GitHub returned a merge-queue removal without a reason.');
          const beforeHead = node.__typename === 'RemovedFromMergeQueueEvent' ? fullSha(node.beforeCommit?.oid, 'removed merge-queue head SHA') : undefined;
          events.push({ id: node.id, type: node.__typename, createdAt, reason: node.reason as string | undefined, beforeHead });
        }
        if (!value.pageInfo.hasNextPage) break;
        if (page === 10 || typeof value.pageInfo.endCursor !== 'string' || !value.pageInfo.endCursor) throw new Error('GitHub merge-queue history exceeded the inspection limit.');
        cursor = value.pageInfo.endCursor;
      }
      if (!pull || pull.number !== number) throw new Error('GitHub returned an incomplete merge-queue pull request.');
      const reviewedHead = fullSha(pull.headRefOid, 'queue pull request head SHA');
      if (reviewedHead !== expectedHead) throw new Error('The pull request head changed after review.');
      if (!['OPEN','CLOSED','MERGED'].includes(String(pull.state))) throw new Error('GitHub returned an invalid queue pull request state.');
      if (!Object.hasOwn(pull, 'mergedAt') || (pull.mergedAt !== null && typeof pull.mergedAt !== 'string')) throw new Error('GitHub returned invalid merge completion data.');
      if (!Object.hasOwn(pull, 'mergeQueueEntry')) throw new Error('GitHub returned incomplete merge-queue data.');
      const entry = pull.mergeQueueEntry;
      const attemptEvents = events;
      const addCount = attemptEvents.filter(event => event.type === 'AddedToMergeQueueEvent').length;
      const hasCurrentAdd = addCount === 1 && attemptEvents[0]?.type === 'AddedToMergeQueueEvent';
      const singleSequence = hasCurrentAdd && (attemptEvents.length === 1 || (attemptEvents.length === 2 && attemptEvents[1]?.type === 'RemovedFromMergeQueueEvent'));
      if (correlated && !singleSequence) throw new Error(addCount > 1 ? 'GitHub returned multiple enqueue sequences after the current attempt cursor.' : 'GitHub did not return one complete enqueue sequence for the current attempt.');
      if (pull.state === 'MERGED') {
        if (entry !== null) throw new Error('GitHub returned an active queue entry for a merged pull request.');
        return { state: 'merged', reviewedHead, mergedAt: timestamp(pull.mergedAt, 'merge completion time') };
      }
      if (pull.mergedAt !== null) throw new Error('GitHub returned inconsistent merge completion data.');

      if (entry !== null) {
        if (pull.state !== 'OPEN' || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('GitHub returned an invalid merge-queue entry.');
        const value = entry as { id?: unknown; state?: unknown; position?: unknown; enqueuedAt?: unknown; headCommit?: { oid?: unknown } | null; pullRequest?: { number?: unknown; headRefOid?: unknown } | null };
        if (typeof value.id !== 'string' || !value.id || !['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED','UNMERGEABLE'].includes(String(value.state)) || !Number.isSafeInteger(value.position) || (value.position as number) < 0)
          throw new Error('GitHub returned an invalid merge-queue entry.');
        const enqueuedAt = timestamp(value.enqueuedAt, 'merge-queue entry time');
        if (correlated && attemptEvents.length !== 1) throw new Error('GitHub returned an ambiguous active event sequence for the current enqueue attempt.');
        const queueHead = fullSha(value.headCommit?.oid, 'merge-queue head SHA');
        const entryHead = fullSha(value.pullRequest?.headRefOid, 'merge-queue entry pull request head SHA');
        if (value.pullRequest?.number !== number || queueHead !== expectedHead || entryHead !== expectedHead) throw new Error('The merge-queue entry does not match the reviewed pull request head.');
        if (value.state === 'UNMERGEABLE') return { state: 'failed', reviewedHead, entryId: value.id, reason: 'GitHub reported the merge queue entry as unmergeable.' };
        return {
          state: 'queued', reviewedHead, entryId: value.id, phase: value.state as MergeQueueEntryPhase,
          position: value.position as number, enqueuedAt, queueHead,
        };
      }
      if (correlated && attemptEvents.length === 0) throw new Error('GitHub did not return an event for the current enqueue attempt.');
      const last = (correlated ? attemptEvents : events).at(-1);
      if (!last || last.type !== 'RemovedFromMergeQueueEvent') throw new Error('GitHub did not confirm a queued, removed, failed, or merged state.');
      if (last.beforeHead !== expectedHead) throw new Error('The merge-queue removal does not match the reviewed pull request head.');
      if (correlated && (attemptEvents.length !== 2 || attemptEvents[1]?.type !== 'RemovedFromMergeQueueEvent')) throw new Error('GitHub returned an ambiguous terminal event sequence for the current enqueue attempt.');
      return { state: 'removed', reviewedHead, removedAt: last.createdAt, reason: last.reason! };
    } catch (error) {
      // The combined signal keeps the reason of whichever abort came first, the caller's or the deadline's. A CommandFailed
      // is gh's own answer, given before the abort, and is reported as itself (#48).
      if (signal.aborted && !ghAnswered(error)) throw signal.reason;
      throw error;
    } finally { clearTimeout(timer); }
  }

  async merge(expectedHead: string, options: { signal?: AbortSignal; pullRequest?: number } = {}): Promise<MergeResult> {
    fullSha(expectedHead, 'expected head SHA');
    const number = this.#number(options.pullRequest);
    const flag = this.config.method === 'squash' ? '--squash' : this.config.method === 'rebase' ? '--rebase' : '--merge';
    this.#generation++;
    this.#cache = null;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      await this.run(['pr','merge',String(number),'--repo',this.config.repository,flag,'--match-head-commit',expectedHead], { signal: options.signal });
      return { url: `https://github.com/${this.config.repository}/pull/${number}` };
    } catch (error) {
      if (error instanceof MergeSubmissionError) throw error;
      const message = error instanceof Error ? error.message : 'GitHub merge submission failed with an unknown outcome.';
      // GitHub's refusal stays definite though an abort arrived after gh had already answered (a CommandFailed is gh's
      // own exit); an error from the abort itself is never a refusal (#48).
      const answered = !options.signal?.aborted || ghAnswered(error);
      const outcome = answered && confirmedMergeRefusal(message) ? 'refused' : 'unknown';
      throw new MergeSubmissionError(message, outcome, { cause: error });
    } finally { this.#generation++; this.#cache = null; }
  }
}

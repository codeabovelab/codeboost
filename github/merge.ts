import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHECK_SETTLE_MS, GhAlreadyFixedGateway, type AlreadyFixedGateway, type AlreadyFixedMatch } from './already-fixed.ts';
import { REPOSITORY } from './validate.ts';

const runFile = promisify(execFile);

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
  queueWatermark(expectedHead: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null>;
  inspectQueue(expectedHead: string, options?: { signal?: AbortSignal; timeoutMs?: number; afterCursor?: string | null }): Promise<MergeQueueObservation>;
}
export interface MergeGateway {
  inspect(options?: { fresh?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<RemoteMergeState>;
  merge(expectedHead: string, options?: { signal?: AbortSignal }): Promise<MergeResult>;
}

export interface GhMergeConfig {
  repository: string;
  pullRequest: number;
  issue: number;
  method?: 'merge' | 'squash' | 'rebase';
}

type BranchRules = Pick<RemoteMergeState, 'rulesKnown' | 'atomicBaseGuard' | 'mergeQueue' | 'requiredChecks'>;
export type RunGh = (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<string>;

/**
 * The already-fixed matches as display text. Only validated fields are used (repository names, numbers, states, SHAs and
 * the check's own close description), never a commit message, and at most five are named.
 */
function describeMatches(matches: readonly AlreadyFixedMatch[]): string {
  const named = matches.slice(0, 5).map(match => match.kind === 'closed' ? `the issue was closed by ${match.by}`
    : match.kind === 'pull request' ? `${match.repository}#${match.number} (${match.state.toLowerCase()}${match.draft ? ', draft' : ''})`
    : `commit ${match.sha.slice(0, 12)} on the base branch`);
  return named.join('; ') + (matches.length > 5 ? `; and ${matches.length - 5} more` : '');
}

function confirmedMergeRefusal(message: string): boolean {
  return /required (?:approving )?review|required status check|branch protection|merge conflict|not mergeable|head (?:branch |commit )?(?:was )?(?:modified|changed)|does not match.*head|pull request.*(?:closed|draft)|merge method.*not allowed/i.test(message);
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

/** GitHub CLI adapter. All arguments are literal argv; no shell is involved. */
export class GhMergeGateway implements MergeGateway, MergeQueueGateway {
  readonly config: GhMergeConfig;
  readonly run: RunGh;
  readonly checks: AlreadyFixedGateway;
  #cache: { expiresAt: number; state: RemoteMergeState } | null = null;
  #generation = 0;
  #inflight: { generation: number; promise: Promise<RemoteMergeState> } | null = null;
  /** `checks` defaults to the pre-PR check's GitHub adapter for the same repository, using `run` when one is given. */
  constructor(config: GhMergeConfig, run?: RunGh, checks?: AlreadyFixedGateway) {
    if (!REPOSITORY.test(config.repository) || !Number.isSafeInteger(config.pullRequest) || config.pullRequest < 1 || !Number.isSafeInteger(config.issue) || config.issue < 1)
      throw new Error('A GitHub repository, pull request, and issue are required for merging.');
    if (config.method !== undefined && !['merge','squash','rebase'].includes(config.method)) throw new Error('GitHub merge method must be merge, squash, or rebase.');
    if (checks && checks.repository?.toLowerCase() !== config.repository.toLowerCase()) throw new Error('The already-fixed check must name and read the merge repository.');
    this.config = config;
    this.checks = checks ?? new GhAlreadyFixedGateway({ repository: config.repository }, run);
    this.run = run ?? (async (args, options) => (await runFile('gh', [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options?.signal })).stdout);
  }

  async #json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.run(args, { signal });
    try { return JSON.parse(output); }
    catch { throw new Error('GitHub returned invalid JSON.'); }
  }

  async #optionalJson(args: readonly string[], signal?: AbortSignal): Promise<unknown | null> {
    try { return await this.#json(args, signal); }
    catch (error) {
      if (error instanceof Error && /HTTP 404|not found/i.test(error.message)) return null;
      throw error;
    }
  }

  /**
   * The pre-merge "already fixed" check runs the pre-PR check (`github/already-fixed.ts`) with the same rules. This PR is
   * the task's own PR: excluded while open, a match once merged. The base-branch scan starts at the PR's base commit, the
   * base the merge is validated against; the task has no own commits on the base branch before its merge.
   * The check stops early enough that its `gh` processes, which may need both grace periods after an abort, settle before
   * the inspection's deadline; stopped that way it is `unknown`.
   */
  async #alreadyFixed(baseBranch: string, base: string, deadlineAt: number, signal?: AbortSignal): Promise<Pick<RemoteMergeState, 'alreadyFixed' | 'alreadyFixedDetail'>> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error('The already-fixed check did not finish in time.')), Math.max(0, deadlineAt - CHECK_SETTLE_MS - Date.now()));
    try {
      const result = await this.checks.check({ issue: this.config.issue, taskBase: base, baseBranch, ownPullRequests: [this.config.pullRequest], ownCommits: new Set() },
        signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
      if (result.outcome === 'clear') return { alreadyFixed: 'clear' };
      if (result.outcome === 'found' && Array.isArray(result.matches) && result.matches.length) return { alreadyFixed: 'found', alreadyFixedDetail: describeMatches(result.matches) };
      return { alreadyFixed: 'unknown', alreadyFixedDetail: result.outcome === 'unknown' && typeof result.reason === 'string' ? result.reason.slice(0, 300) : 'The check returned an invalid result.' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { alreadyFixed: 'unknown', alreadyFixedDetail: stop.signal.aborted ? 'The check did not finish in time.' : 'GitHub could not be read.' };
    } finally { clearTimeout(timer); }
  }

  async #inspectNow(deadlineAt: number, signal?: AbortSignal): Promise<RemoteMergeState> {
    const pr = await this.#json(['pr','view',String(this.config.pullRequest),'--repo',this.config.repository,'--json','baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup,url'], signal) as Record<string, unknown>;
    if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || !['OPEN','CLOSED','MERGED'].includes(String(pr.state)) || !['MERGEABLE','CONFLICTING','UNKNOWN'].includes(String(pr.mergeable)) || !Array.isArray(pr.statusCheckRollup))
      throw new Error('GitHub returned an incomplete pull request state.');
    const base = fullSha(pr.baseRefOid, 'base SHA'), head = fullSha(pr.headRefOid, 'head SHA');
    // The already-fixed check needs only the PR's base, so it runs alongside the rule reads. If those fail, the check is
    // stopped; it is awaited on every path, so no `gh` process it started outlives the inspection.
    const failed = new AbortController();
    const alreadyFixed = this.#alreadyFixed(pr.baseRefName, base, deadlineAt, signal ? AbortSignal.any([signal, failed.signal]) : failed.signal);
    alreadyFixed.catch(() => {});
    let rules: BranchRules;
    try { rules = await this.#rules(pr.baseRefName, pr.statusCheckRollup as Array<Record<string, unknown>>, signal); }
    catch (error) { failed.abort(error); await alreadyFixed.catch(() => {}); throw error; }
    return {
      base, head,
      pullRequestState: pr.state as RemoteMergeState['pullRequestState'], mergeable: pr.mergeable as RemoteMergeState['mergeable'],
      ...rules, ...await alreadyFixed,
      ...(typeof pr.url === 'string' && pr.url.length <= 2048 && /^https:\/\//.test(pr.url) ? { url: pr.url } : {}),
    };
  }

  /** The effective branch rules and the state of each required check on the PR. */
  async #rules(baseRefName: string, observed: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<BranchRules> {
    const branch = encodeURIComponent(baseRefName);
    let rulesKnown = true;
    let rules: unknown[] = [];
    let classic: unknown | null = null;
    try {
      rules = flattenPages(await this.#json(['api','--paginate','--slurp',`repos/${this.config.repository}/rules/branches/${branch}`], signal));
      const branchState = await this.#json(['api',`repos/${this.config.repository}/branches/${branch}`], signal) as { protected?: unknown };
      if (typeof branchState.protected !== 'boolean') throw new Error('GitHub returned an incomplete branch state.');
      const protection = await this.#optionalJson(['api',`repos/${this.config.repository}/branches/${branch}/protection`], signal);
      if (protection === null) {
        if (branchState.protected) throw new Error('Branch protection is present but unreadable.');
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
          if (!Object.hasOwn(check, 'integration_id')) { rulesKnown = false; break; }
          const app = (check as { integration_id: unknown }).integration_id;
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
    const requiredChecks = [...requirements.values()].map(required => {
      const match = observed.find(check => {
        const context = typeof check.name === 'string' ? check.name : check.context;
        const app = check.app && typeof check.app === 'object' ? (check.app as { databaseId?: unknown }).databaseId : null;
        return context === required.context && (required.appId === null || app === required.appId);
      });
      if (!match) return { ...required, state: 'missing' as const };
      let state: RequiredCheck['state'];
      if (typeof match.name === 'string') {
        const status = String(match.status ?? '').toUpperCase();
        const conclusion = String(match.conclusion ?? '').toUpperCase();
        if (['QUEUED','IN_PROGRESS','WAITING','PENDING','REQUESTED'].includes(status)) state = 'pending';
        else if (status === 'COMPLETED') state = conclusion === 'SUCCESS' ? 'success' : 'failure';
        else state = 'failure';
      } else {
        const status = String(match.state ?? '').toUpperCase();
        state = status === 'SUCCESS' ? 'success' : ['PENDING','EXPECTED'].includes(status) ? 'pending' : 'failure';
      }
      return { ...required, state };
    });
    return { rulesKnown, atomicBaseGuard, mergeQueue, requiredChecks };
  }

  async inspect(options: { fresh?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RemoteMergeState> {
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid GitHub inspection timeout.');
    if (!options.fresh && this.#cache && this.#cache.expiresAt > Date.now()) return this.#cache.state;
    const generation = this.#generation;
    if (!options.fresh && this.#inflight?.generation === generation) return this.#inflight.promise;
    const timeout = new AbortController(), deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => timeout.abort(new Error('GitHub merge-state inspection timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const attempt = this.#inspectNow(deadlineAt, signal).catch(error => {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
    }).then(state => {
      if (this.#generation === generation) this.#cache = { expiresAt: Date.now() + 5_000, state };
      return state;
    }).finally(() => { clearTimeout(timer); if (this.#inflight?.promise === attempt) this.#inflight = null; });
    if (!options.fresh) this.#inflight = { generation, promise: attempt };
    return attempt;
  }

  async queueWatermark(expectedHead: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | null> {
    fullSha(expectedHead, 'expected head SHA');
    const timeoutMs = options.timeoutMs ?? 6_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid GitHub queue watermark timeout.');
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){edges{cursor node{id}}}}}}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('GitHub merge-queue watermark timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      const response = await this.#json(['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${this.config.pullRequest}`], signal) as {
        data?: { repository?: { pullRequest?: { number?: unknown; headRefOid?: unknown; timelineItems?: { edges?: unknown } } | null } | null };
        errors?: unknown;
      };
      if (signal.aborted) throw signal.reason;
      if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('GitHub returned merge-queue watermark data with errors.');
      const pull = response.data?.repository?.pullRequest;
      if (!pull || pull.number !== this.config.pullRequest || fullSha(pull.headRefOid, 'queue watermark head SHA') !== expectedHead || !Array.isArray(pull.timelineItems?.edges))
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
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.signal.aborted && !options.signal?.aborted) throw new Error('GitHub merge-queue watermark timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async inspectQueue(expectedHead: string, options: { signal?: AbortSignal; timeoutMs?: number; afterCursor?: string | null } = {}): Promise<MergeQueueObservation> {
    fullSha(expectedHead, 'expected head SHA');
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid GitHub queue inspection timeout.');
    const correlated = Object.hasOwn(options, 'afterCursor');
    if (options.afterCursor !== undefined && options.afterCursor !== null && (typeof options.afterCursor !== 'string' || !options.afterCursor || options.afterCursor.length > 512))
      throw new Error('Invalid merge-queue event cursor.');
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid state mergedAt mergeQueueEntry{id state position enqueuedAt headCommit{oid} pullRequest{number headRefOid}} timelineItems(first:100,after:$after,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){edges{cursor node{id __typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason beforeCommit{oid}}}} pageInfo{hasNextPage endCursor}}}}}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('GitHub merge-queue inspection timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      let cursor = options.afterCursor ?? null, pull: Record<string, unknown> | null = null, stable = '', page = 0;
      const events: Array<{ id: string; type: unknown; createdAt: string; reason: string | undefined; beforeHead: string | undefined }> = [];
      while (page++ < 10) {
        const args = ['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${this.config.pullRequest}`];
        if (cursor !== null) args.push('-f', `after=${cursor}`);
        const response = await this.#json(args, signal) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null }; errors?: unknown };
        if (signal.aborted) throw signal.reason;
        if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('GitHub returned merge-queue data with errors.');
        const nextPull = response.data?.repository?.pullRequest;
        if (!nextPull || nextPull.number !== this.config.pullRequest) throw new Error('GitHub returned an incomplete merge-queue pull request.');
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
      if (!pull || pull.number !== this.config.pullRequest) throw new Error('GitHub returned an incomplete merge-queue pull request.');
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
        if (value.pullRequest?.number !== this.config.pullRequest || queueHead !== expectedHead || entryHead !== expectedHead) throw new Error('The merge-queue entry does not match the reviewed pull request head.');
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
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.signal.aborted && !options.signal?.aborted) throw new Error('GitHub merge-queue inspection timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async merge(expectedHead: string, options: { signal?: AbortSignal } = {}): Promise<MergeResult> {
    fullSha(expectedHead, 'expected head SHA');
    const flag = this.config.method === 'squash' ? '--squash' : this.config.method === 'rebase' ? '--rebase' : '--merge';
    this.#generation++;
    this.#cache = null;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      await this.run(['pr','merge',String(this.config.pullRequest),'--repo',this.config.repository,flag,'--match-head-commit',expectedHead], { signal: options.signal });
      return { url: `https://github.com/${this.config.repository}/pull/${this.config.pullRequest}` };
    } catch (error) {
      if (error instanceof MergeSubmissionError) throw error;
      const message = error instanceof Error ? error.message : 'GitHub merge submission failed with an unknown outcome.';
      const outcome = !options.signal?.aborted && confirmedMergeRefusal(message) ? 'refused' : 'unknown';
      throw new MergeSubmissionError(message, outcome, { cause: error });
    } finally { this.#generation++; this.#cache = null; }
  }
}

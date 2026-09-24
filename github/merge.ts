import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
}

export interface MergeResult { url: string; }
export type MergeQueueEntryPhase = 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED';
export type MergeQueueObservation =
  | { state: 'queued'; reviewedHead: string; entryId: string; phase: MergeQueueEntryPhase; position: number; enqueuedAt: string; queueHead: string }
  | { state: 'removed'; reviewedHead: string; removedAt: string; reason: string }
  | { state: 'failed'; reviewedHead: string; entryId: string; reason: string }
  | { state: 'merged'; reviewedHead: string; mergedAt: string };
export interface MergeQueueGateway {
  inspectQueue(expectedHead: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<MergeQueueObservation>;
}
export interface MergeGateway {
  inspect(options?: { fresh?: boolean; timeoutMs?: number }): Promise<RemoteMergeState>;
  merge(expectedHead: string, options?: { signal?: AbortSignal }): Promise<MergeResult>;
}

export interface GhMergeConfig {
  repository: string;
  pullRequest: number;
  issue: number;
  method?: 'merge' | 'squash' | 'rebase';
}

type RunGh = (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<string>;

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
  #cache: { expiresAt: number; state: RemoteMergeState } | null = null;
  #generation = 0;
  #inflight: { generation: number; promise: Promise<RemoteMergeState> } | null = null;
  constructor(config: GhMergeConfig, run?: RunGh) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !Number.isSafeInteger(config.pullRequest) || config.pullRequest < 1 || !Number.isSafeInteger(config.issue) || config.issue < 1)
      throw new Error('A GitHub repository, pull request, and issue are required for merging.');
    if (config.method !== undefined && !['merge','squash','rebase'].includes(config.method)) throw new Error('GitHub merge method must be merge, squash, or rebase.');
    this.config = config;
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

  async #alreadyFixed(signal?: AbortSignal): Promise<'clear' | 'found' | 'unknown'> {
    try {
      const timeline = flattenPages(await this.#json(['api','--paginate','--slurp','-H','Accept: application/vnd.github+json',`repos/${this.config.repository}/issues/${this.config.issue}/timeline`], signal));
      const referenced = new Set<number>();
      for (const event of timeline) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('GitHub returned a malformed timeline event.');
        const source = (event as { source?: { issue?: { number?: unknown; pull_request?: unknown; repository_url?: unknown } } }).source?.issue;
        if (!source?.pull_request) continue;
        if (source.repository_url !== `https://api.github.com/repos/${this.config.repository}`) throw new Error('GitHub returned a cross-repository or incomplete pull request reference.');
        if (!Number.isSafeInteger(source.number) || (source.number as number) < 1) throw new Error('GitHub returned an invalid pull request reference.');
        if (source.number !== this.config.pullRequest) referenced.add(source.number as number);
      }
      const numbers = [...referenced];
      if (numbers.length > 100) return 'unknown';
      if (!numbers.length) return 'clear';
      const [owner, name] = this.config.repository.split('/') as [string, string];
      const selections = numbers.map((number, index) => `p${index}: pullRequest(number:${number}) { state mergedAt }`).join(' ');
      const response = await this.#json(['api','graphql','-f',`query=query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${selections} } }`], signal) as { data?: { repository?: Record<string, { state?: unknown; mergedAt?: unknown } | null> }; errors?: unknown };
      if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) return 'unknown';
      const pulls = response.data?.repository;
      if (!pulls || Object.keys(pulls).length !== numbers.length) return 'unknown';
      for (let index = 0; index < numbers.length; index++) {
        const pr = pulls[`p${index}`];
        if (!pr) return 'unknown';
        if (!['OPEN','CLOSED','MERGED'].includes(String(pr.state)) || !Object.hasOwn(pr, 'mergedAt') || (pr.mergedAt !== null && typeof pr.mergedAt !== 'string')) return 'unknown';
        if ((pr.state === 'OPEN' || pr.state === 'CLOSED') && pr.mergedAt !== null) return 'unknown';
        if (pr.state === 'MERGED' && typeof pr.mergedAt !== 'string') return 'unknown';
        if (pr.state === 'OPEN' || pr.state === 'MERGED') return 'found';
      }
      return 'clear';
    } catch (error) {
      if (signal?.aborted) throw error;
      return 'unknown';
    }
  }

  async #inspectNow(signal?: AbortSignal): Promise<RemoteMergeState> {
    const pr = await this.#json(['pr','view',String(this.config.pullRequest),'--repo',this.config.repository,'--json','baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup'], signal) as Record<string, unknown>;
    if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || !['OPEN','CLOSED','MERGED'].includes(String(pr.state)) || !['MERGEABLE','CONFLICTING','UNKNOWN'].includes(String(pr.mergeable)) || !Array.isArray(pr.statusCheckRollup))
      throw new Error('GitHub returned an incomplete pull request state.');
    const branch = encodeURIComponent(pr.baseRefName);
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
        if (value.type === 'merge_queue') mergeQueue = true;
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
    const observed = pr.statusCheckRollup as Array<Record<string, unknown>>;
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
    return {
      base: fullSha(pr.baseRefOid, 'base SHA'), head: fullSha(pr.headRefOid, 'head SHA'),
      pullRequestState: pr.state as RemoteMergeState['pullRequestState'], mergeable: pr.mergeable as RemoteMergeState['mergeable'],
      rulesKnown, atomicBaseGuard, mergeQueue, requiredChecks, alreadyFixed: await this.#alreadyFixed(signal),
    };
  }

  async inspect(options: { fresh?: boolean; timeoutMs?: number } = {}): Promise<RemoteMergeState> {
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid GitHub inspection timeout.');
    if (!options.fresh && this.#cache && this.#cache.expiresAt > Date.now()) return this.#cache.state;
    const generation = this.#generation;
    if (!options.fresh && this.#inflight?.generation === generation) return this.#inflight.promise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('GitHub merge-state inspection timed out.')), timeoutMs);
    const attempt = this.#inspectNow(controller.signal).catch(error => {
      if (controller.signal.aborted) throw new Error('GitHub merge-state inspection timed out.');
      throw error;
    }).then(state => {
      if (this.#generation === generation) this.#cache = { expiresAt: Date.now() + 5_000, state };
      return state;
    }).finally(() => { clearTimeout(timer); if (this.#inflight?.promise === attempt) this.#inflight = null; });
    if (!options.fresh) this.#inflight = { generation, promise: attempt };
    return attempt;
  }

  async inspectQueue(expectedHead: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MergeQueueObservation> {
    fullSha(expectedHead, 'expected head SHA');
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid GitHub queue inspection timeout.');
    const [owner, name] = this.config.repository.split('/') as [string, string];
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid state mergedAt mergeQueueEntry{id state position enqueuedAt headCommit{oid}} timelineItems(last:20,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('GitHub merge-queue inspection timed out.')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      const response = await this.#json(['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${this.config.pullRequest}`], signal) as {
        data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null };
        errors?: unknown;
      };
      if (signal.aborted) throw signal.reason;
      if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('GitHub returned merge-queue data with errors.');
      const pull = response.data?.repository?.pullRequest;
      if (!pull || pull.number !== this.config.pullRequest) throw new Error('GitHub returned an incomplete merge-queue pull request.');
      const reviewedHead = fullSha(pull.headRefOid, 'queue pull request head SHA');
      if (reviewedHead !== expectedHead) throw new Error('The pull request head changed after review.');
      if (!['OPEN','CLOSED','MERGED'].includes(String(pull.state))) throw new Error('GitHub returned an invalid queue pull request state.');
      if (!Object.hasOwn(pull, 'mergedAt') || (pull.mergedAt !== null && typeof pull.mergedAt !== 'string')) throw new Error('GitHub returned invalid merge completion data.');
      if (!Object.hasOwn(pull, 'mergeQueueEntry') || !Object.hasOwn(pull, 'timelineItems')) throw new Error('GitHub returned incomplete merge-queue data.');
      const entry = pull.mergeQueueEntry;
      const timeline = pull.timelineItems;
      if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline) || !Array.isArray((timeline as { nodes?: unknown }).nodes)) throw new Error('GitHub returned incomplete merge-queue history.');
      const events = (timeline as { nodes: unknown[] }).nodes.map(event => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('GitHub returned a malformed merge-queue event.');
        const value = event as { __typename?: unknown; createdAt?: unknown; reason?: unknown };
        if (!['AddedToMergeQueueEvent','RemovedFromMergeQueueEvent'].includes(String(value.__typename))) throw new Error('GitHub returned an unknown merge-queue event.');
        const createdAt = timestamp(value.createdAt, 'merge-queue event time');
        if (value.__typename === 'RemovedFromMergeQueueEvent' && (typeof value.reason !== 'string' || !value.reason.trim())) throw new Error('GitHub returned a merge-queue removal without a reason.');
        return { type: value.__typename, createdAt, reason: value.reason as string | undefined };
      });
      if (pull.state === 'MERGED') {
        if (entry !== null) throw new Error('GitHub returned an active queue entry for a merged pull request.');
        return { state: 'merged', reviewedHead, mergedAt: timestamp(pull.mergedAt, 'merge completion time') };
      }
      if (pull.mergedAt !== null) throw new Error('GitHub returned inconsistent merge completion data.');

      if (entry !== null) {
        if (pull.state !== 'OPEN' || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('GitHub returned an invalid merge-queue entry.');
        const value = entry as { id?: unknown; state?: unknown; position?: unknown; enqueuedAt?: unknown; headCommit?: { oid?: unknown } | null };
        if (typeof value.id !== 'string' || !value.id || !['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED','UNMERGEABLE'].includes(String(value.state)) || !Number.isSafeInteger(value.position) || (value.position as number) < 0)
          throw new Error('GitHub returned an invalid merge-queue entry.');
        timestamp(value.enqueuedAt, 'merge-queue entry time');
        const queueHead = fullSha(value.headCommit?.oid, 'merge-queue head SHA');
        if (value.state === 'UNMERGEABLE') return { state: 'failed', reviewedHead, entryId: value.id, reason: 'GitHub reported the merge queue entry as unmergeable.' };
        return {
          state: 'queued', reviewedHead, entryId: value.id, phase: value.state as MergeQueueEntryPhase,
          position: value.position as number, enqueuedAt: value.enqueuedAt as string, queueHead,
        };
      }
      const last = events.at(-1);
      if (!last || last.type !== 'RemovedFromMergeQueueEvent') throw new Error('GitHub did not confirm a queued, removed, failed, or merged state.');
      return { state: 'removed', reviewedHead, removedAt: last.createdAt, reason: last.reason! };
    } catch (error) {
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
    } finally { this.#generation++; this.#cache = null; }
  }
}

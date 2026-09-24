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
  requiredChecks: RequiredCheck[];
  alreadyFixed: 'clear' | 'found' | 'unknown';
}

export interface MergeResult { url: string; }
export interface MergeGateway {
  inspect(options?: { fresh?: boolean }): Promise<RemoteMergeState>;
  merge(expectedHead: string): Promise<MergeResult>;
}

export interface GhMergeConfig {
  repository: string;
  pullRequest: number;
  issue: number;
  method?: 'merge' | 'squash' | 'rebase';
}

type RunGh = (args: readonly string[]) => Promise<string>;

function fullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`GitHub returned an invalid ${label}.`);
  return value;
}

function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid paginated response.');
  return value.flatMap(page => Array.isArray(page) ? page : [page]);
}

/** GitHub CLI adapter. All arguments are literal argv; no shell is involved. */
export class GhMergeGateway implements MergeGateway {
  readonly config: GhMergeConfig;
  readonly run: RunGh;
  #cache: { expiresAt: number; state: RemoteMergeState } | null = null;
  #inflight: Promise<RemoteMergeState> | null = null;
  constructor(config: GhMergeConfig, run?: RunGh) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !Number.isSafeInteger(config.pullRequest) || config.pullRequest < 1 || !Number.isSafeInteger(config.issue) || config.issue < 1)
      throw new Error('A GitHub repository, pull request, and issue are required for merging.');
    this.config = config;
    this.run = run ?? (async args => (await runFile('gh', [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  }

  async #json(args: readonly string[]): Promise<unknown> {
    const output = await this.run(args);
    try { return JSON.parse(output); }
    catch { throw new Error('GitHub returned invalid JSON.'); }
  }

  async #optionalJson(args: readonly string[]): Promise<unknown | null> {
    try { return await this.#json(args); }
    catch (error) {
      if (error instanceof Error && /HTTP 404|not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async #alreadyFixed(): Promise<'clear' | 'found' | 'unknown'> {
    try {
      const timeline = flattenPages(await this.#json(['api','--paginate','--slurp','-H','Accept: application/vnd.github+json',`repos/${this.config.repository}/issues/${this.config.issue}/timeline`]));
      const numbers = [...new Set(timeline.flatMap(event => {
        if (!event || typeof event !== 'object') return [];
        const source = (event as { source?: { issue?: { number?: unknown; pull_request?: unknown } } }).source?.issue;
        return source?.pull_request && Number.isSafeInteger(source.number) && source.number !== this.config.pullRequest ? [source.number as number] : [];
      }))];
      if (numbers.length > 100) return 'unknown';
      if (!numbers.length) return 'clear';
      const [owner, name] = this.config.repository.split('/') as [string, string];
      const selections = numbers.map((number, index) => `p${index}: pullRequest(number:${number}) { state mergedAt }`).join(' ');
      const response = await this.#json(['api','graphql','-f',`query=query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${selections} } }`]) as { data?: { repository?: Record<string, { state?: unknown; mergedAt?: unknown } | null> } };
      const pulls = response.data?.repository;
      if (!pulls || Object.keys(pulls).length !== numbers.length) return 'unknown';
      for (let index = 0; index < numbers.length; index++) {
        const pr = pulls[`p${index}`];
        if (!pr) return 'unknown';
        if (pr.state === 'OPEN' || typeof pr.mergedAt === 'string') return 'found';
      }
      return 'clear';
    } catch { return 'unknown'; }
  }

  async #inspectNow(): Promise<RemoteMergeState> {
    const pr = await this.#json(['pr','view',String(this.config.pullRequest),'--repo',this.config.repository,'--json','baseRefName,baseRefOid,headRefName,headRefOid,state,mergeable,statusCheckRollup']) as Record<string, unknown>;
    if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || !['OPEN','CLOSED','MERGED'].includes(String(pr.state)) || !['MERGEABLE','CONFLICTING','UNKNOWN'].includes(String(pr.mergeable)) || !Array.isArray(pr.statusCheckRollup))
      throw new Error('GitHub returned an incomplete pull request state.');
    const branch = encodeURIComponent(pr.baseRefName);
    let rulesKnown = true;
    let rules: unknown[] = [];
    let classic: unknown | null = null;
    try {
      rules = flattenPages(await this.#json(['api','--paginate','--slurp',`repos/${this.config.repository}/rules/branches/${branch}`]));
      const branchState = await this.#json(['api',`repos/${this.config.repository}/branches/${branch}`]) as { protected?: unknown };
      if (typeof branchState.protected !== 'boolean') throw new Error('GitHub returned an incomplete branch state.');
      const protection = await this.#optionalJson(['api',`repos/${this.config.repository}/branches/${branch}/protection`]);
      if (protection === null) {
        if (branchState.protected) throw new Error('Branch protection is present but unreadable.');
      } else if (!protection || typeof protection !== 'object' || !('required_status_checks' in protection)) {
        throw new Error('GitHub returned incomplete branch protection.');
      } else classic = (protection as { required_status_checks: unknown }).required_status_checks;
    } catch { rulesKnown = false; }
    const requirements = new Map<string, { context: string; appId: number | null }>();
    let atomicBaseGuard = false;
    if (rulesKnown) {
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') { rulesKnown = false; break; }
        const value = rule as { type?: unknown; parameters?: Record<string, unknown> };
        if (value.type === 'merge_queue') atomicBaseGuard = true;
        if (value.type !== 'required_status_checks') continue;
        const parameters = value.parameters;
        if (!parameters || !Array.isArray(parameters.required_status_checks)) { rulesKnown = false; break; }
        if (parameters.strict_required_status_checks_policy === true) atomicBaseGuard = true;
        for (const check of parameters.required_status_checks) {
          if (!check || typeof check !== 'object' || typeof (check as { context?: unknown }).context !== 'string') { rulesKnown = false; break; }
          const context = (check as { context: string }).context;
          const app = (check as { integration_id?: unknown }).integration_id;
          const appId = typeof app === 'number' ? app : null;
          requirements.set(`${context}\0${appId ?? ''}`, { context, appId });
        }
      }
      if (classic && typeof classic === 'object') {
        const value = classic as { strict?: unknown; checks?: unknown; contexts?: unknown };
        if (value.strict === true) atomicBaseGuard = true;
        const checks = Array.isArray(value.checks) ? value.checks : Array.isArray(value.contexts) ? value.contexts.map(context => ({ context })) : null;
        if (!checks) rulesKnown = false;
        else for (const check of checks) {
          if (!check || typeof check !== 'object' || typeof (check as { context?: unknown }).context !== 'string') { rulesKnown = false; break; }
          const context = (check as { context: string }).context;
          const app = (check as { app_id?: unknown }).app_id;
          const appId = typeof app === 'number' ? app : null;
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
      const conclusion = String(match.conclusion ?? match.state ?? '').toUpperCase();
      const status = String(match.status ?? '').toUpperCase();
      const state: RequiredCheck['state'] = conclusion === 'SUCCESS' ? 'success' : ['FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED'].includes(conclusion) ? 'failure' : status === 'COMPLETED' && conclusion ? 'failure' : 'pending';
      return { ...required, state };
    });
    return {
      base: fullSha(pr.baseRefOid, 'base SHA'), head: fullSha(pr.headRefOid, 'head SHA'),
      pullRequestState: pr.state as RemoteMergeState['pullRequestState'], mergeable: pr.mergeable as RemoteMergeState['mergeable'],
      rulesKnown, atomicBaseGuard, requiredChecks, alreadyFixed: await this.#alreadyFixed(),
    };
  }

  async inspect(options: { fresh?: boolean } = {}): Promise<RemoteMergeState> {
    if (!options.fresh && this.#cache && this.#cache.expiresAt > Date.now()) return this.#cache.state;
    if (!options.fresh && this.#inflight) return this.#inflight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub merge-state inspection timed out.')), 12_000); });
    const attempt = Promise.race([this.#inspectNow(), deadline]).then(state => {
      this.#cache = { expiresAt: Date.now() + 5_000, state };
      return state;
    }).finally(() => { if (timer) clearTimeout(timer); if (this.#inflight === attempt) this.#inflight = null; });
    if (!options.fresh) this.#inflight = attempt;
    return attempt;
  }

  async merge(expectedHead: string): Promise<MergeResult> {
    fullSha(expectedHead, 'expected head SHA');
    const flag = this.config.method === 'squash' ? '--squash' : this.config.method === 'rebase' ? '--rebase' : '--merge';
    await this.run(['pr','merge',String(this.config.pullRequest),'--repo',this.config.repository,flag,'--match-head-commit',expectedHead]);
    return { url: `https://github.com/${this.config.repository}/pull/${this.config.pullRequest}` };
  }
}

import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { PullRequestMisplaced, PullRequestRefused } from '../github/pull-requests.ts';
import { BranchPushRefused, redact, TOKEN_VARIABLES } from './branch-push.ts';
import type { RunnerCoordinator } from './coordinator.ts';
import type { ItemExecutor } from './execution.ts';
import { GuardRefusal, ShuttingDownError, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { OpeningUnsettled, type PublishOutcome, type PullRequestPublisher } from './publish.ts';
import type { PublishRecord, Store } from './store.ts';

/** Outcomes after which nothing is owed until the task changes again. Every other record (a refusal, a failure, a stop) leaves the publish owed. */
const SETTLED = ['opened', 'possibly already fixed', 'draft skipped', 'draft unsupported', 'no changes',
  // Recorded by the v10 upgrade for a task that reached its status before publishing existed: only the action publishes it.
  'not published'];
/** Refusals a person acts on; anything else that fails is reported as `failed`. */
const REFUSALS = [GuardRefusal, BranchPushRefused, OpeningUnsettled, PullRequestMisplaced, PullRequestRefused];

/**
 * Publishes a task's pull request in production (#103): when a run ends, on the `publish` action, and once at startup.
 * The task's status decides the mode: a running task whose every plan item has run gets a ready PR, a task in needs human
 * a draft PR with its problems. One publish per task at a time, in the background, tracked until it settles; its outcome
 * is recorded in the Store, where GET /api/runner reads it. Shutdown aborts every publish and awaits it before the Store's
 * write gate closes, so a publish's last records still land.
 */
export class TaskPublishing {
  #store: Store; #publisher: PullRequestPublisher; #runner: RunnerCoordinator; #executor: ItemExecutor;
  #write: <T>(fn: () => T) => T;
  /** Token values to remove from recorded error text: those of the environment the gh calls and the push run with. */
  #secrets: string[];
  #closing = false;
  /** Publishes in progress, by task, from scheduling until the outcome is recorded. */
  #running = new Map<string, Promise<void>>();
  constructor(store: Store, publisher: PullRequestPublisher, runner: RunnerCoordinator, executor: ItemExecutor, capability?: ShutdownCapability,
    env: NodeJS.ProcessEnv = process.env) {
    this.#store = store; this.#publisher = publisher; this.#runner = runner; this.#executor = executor; this.#write = settleWith(capability);
    this.#secrets = TOKEN_VARIABLES.flatMap(name => env[name] ?? []);
  }

  /** Whether a publish of this task is in progress. */
  busy(identity: PlanIdentity): boolean { return this.#running.has(identityKey(identity)); }
  lastOutcome(identity: PlanIdentity): PublishRecord | null { return this.#store.lastPublish(identity); }
  /** Resolves once the task's publish in progress, if any, has recorded its outcome. */
  async settled(identity: PlanIdentity): Promise<void> { await this.#running.get(identityKey(identity)); }

  /**
   * What a publish would do now: a ready or a draft PR. Throws the refusal otherwise, with what a person can act on.
   * Writes nothing, so the view asks it too and never offers what the action would refuse.
   */
  mode(identity: PlanIdentity, progress?: { next: string | null }): { draft: boolean } {
    if (this.#closing || this.#runner.closing) throw new ShuttingDownError();
    if (this.busy(identity)) throw new GuardRefusal('A pull request is already being published for this task.');
    // Publishing reads the task head, so it waits for the run (and the attempt) to end: assertPublishable refuses an active attempt.
    if (this.#runner.isActive(identity) || this.#executor.busy(identity)) throw new GuardRefusal('A run of this task is still in progress; publish once it has ended.');
    const task = this.#store.getTask(identity);
    if (task.status === 'running') {
      const { next } = progress ?? this.#executor.progress(identity);
      if (next !== null) throw new GuardRefusal(`${next} has not run yet; publish once every plan item has run.`);
      this.#store.assertPublishableNow(identity, false);
      return { draft: false };
    }
    if (task.status === 'needs human') {
      this.#store.assertPublishableNow(identity, true);
      return { draft: true };
    }
    throw new GuardRefusal(`The task is ${task.status}; a pull request is published for a running task whose plan items have all run, or a task that needs a person.`);
  }

  /**
   * The publish owed, if any: the task can be published, and no publish has settled since the task last changed. Null
   * when nothing is owed.
   */
  owed(identity: PlanIdentity): { draft: boolean } | null {
    let mode;
    try { mode = this.mode(identity); }
    catch (error) { if (error instanceof GuardRefusal || error instanceof ShuttingDownError) return null; throw error; }
    const last = this.#store.lastPublish(identity);
    return !last || !SETTLED.includes(last.outcome) || last.stateVersion !== this.#store.getTask(identity).stateVersion ? mode : null;
  }

  /**
   * The `publish` action: start a publish now, or throw its refusal. Runs after the caller's transaction commits; its
   * outcome replaces the action's saved response, so a replay reports it.
   */
  request(identity: PlanIdentity, actionId: string): { draft: boolean } {
    const mode = this.mode(identity);
    this.#schedule(identity, mode.draft, actionId);
    return mode;
  }

  /** A run of the task ended, or the server started: publish if one is owed. Never throws. */
  publishIfOwed(identity: PlanIdentity): void {
    try { const owed = this.owed(identity); if (owed) this.#schedule(identity, owed.draft); }
    catch (error) { console.error(`Could not start publishing: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * Startup, once the runner lock is verified: publish if one is owed. Otherwise a publish action whose process stopped
   * before its publish recorded an outcome (a crash) is settled now, so its replay stops saying `publishing`; the task's
   * records (a PR it opened, recovered by its marker on the next publish) show what that publish did. Never throws.
   */
  startup(identity: PlanIdentity): void {
    try {
      const owed = this.owed(identity);
      if (owed) { this.#schedule(identity, owed.draft); return; }
      if (this.#store.hasUnsettledPublishAction(identity))
        this.#write(() => this.#store.recordPublish(identity, { outcome: 'stopped', draft: false,
          message: 'The publish was interrupted before it recorded an outcome (codeboost stopped). Its pull request, if it opened one, is in the task\'s records; the publish action runs it again.' }));
    } catch (error) { console.error(`Could not start publishing: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * Shutdown: refuse new publishes, abort those in progress (the publisher refuses every later push, opening and ready
   * change) and await their recorded outcomes.
   */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#publisher.close();
    while (this.#running.size) await Promise.all([...this.#running.values()]);
  }

  #schedule(identity: PlanIdentity, draft: boolean, actionId?: string): void {
    const key = identityKey(identity);
    // Reserved in this turn, so a second request in the same transaction is refused.
    const reserved = Promise.withResolvers<void>();
    this.#running.set(key, reserved.promise);
    const run = async () => {
      let record: Omit<PublishRecord, 'stateVersion' | 'at'>, seenVersion: number | undefined;
      try {
        // The problems are read when the publish starts: the task is in needs human, and its last attempt says why.
        const outcome = await this.#publisher.publish(identity, draft ? { problems: this.#problems(identity) } : {});
        record = describe(outcome, draft);
        seenVersion = outcome.seenVersion;
      } catch (error) {
        const stopped = error instanceof ShuttingDownError || (this.#closing && (error as Error)?.name === 'AbortError');
        record = { outcome: stopped ? 'stopped' : REFUSALS.some(type => error instanceof type) ? 'refused' : 'failed', draft, message: message(error, this.#secrets) };
      }
      try { this.#write(() => this.#store.recordPublish(identity, record, actionId, seenVersion)); }
      catch (error) { console.error(`Could not record the publish outcome: ${JSON.stringify(message(error, this.#secrets))}`); }
    };
    // Starts once the caller's transaction (the action's userAction) has committed; a rollback starts nothing.
    this.#store.afterCommit(() => {
      void run().finally(() => { this.#running.delete(key); reserved.resolve(); });
    }, () => { this.#running.delete(key); reserved.resolve(); });
  }

  /**
   * Why a needs-human task needs a person, for its draft PR, from what sent it there now: its current attempt's safety
   * finding first (a budget that also ran out since must not hide it), then its spent budget, then that attempt's
   * diagnostic. An earlier attempt's finding, which a person may have dealt with, is not used.
   */
  #problems(identity: PlanIdentity): string[] {
    const task = this.#store.getTask(identity);
    const current = task.currentAttemptId === null ? undefined : this.#store.getAttempt(identity, task.currentAttemptId);
    if (current?.safetyFinding) return [current.safetyFinding];
    if (task.budgetDeadline !== null && task.budgetDeadline <= Date.now()) return ['The task\'s time budget ran out before its plan finished.'];
    if (current?.diagnostic) return [current.diagnostic];
    return ['The task needs a person.'];
  }
}

function describe(outcome: PublishOutcome, draft: boolean): Omit<PublishRecord, 'stateVersion' | 'at'> {
  const ready = 'leftReady' in outcome && outcome.leftReady !== undefined ? ` Pull request #${outcome.leftReady} could not be made a draft and may still be ready for review.` : '';
  switch (outcome.kind) {
    case 'opened': return { outcome: outcome.kind, draft, number: outcome.number, url: outcome.url,
      message: `Pull request #${outcome.number} is open${outcome.draft ? ' as a draft' : ''}; the task is ${outcome.status}.${ready}` };
    case 'possibly already fixed': return { outcome: outcome.kind, draft, message: `The issue may already be fixed (${checkSummary(outcome.result)}), so no pull request was opened.${ready}` };
    case 'draft skipped': return { outcome: outcome.kind, draft, message: `The issue may already be fixed (${checkSummary(outcome.result)}), so no draft pull request was opened.${ready}` };
    case 'draft unsupported': return { outcome: outcome.kind, draft, ...(outcome.number === null ? {} : { number: outcome.number }),
      message: 'This repository does not support draft pull requests, so the task, which needs a person, has none.' };
    case 'no changes': return { outcome: outcome.kind, draft, message: `The task head is its base: there is nothing to publish.${ready}` };
  }
}
function checkSummary(result: Extract<PublishOutcome, { kind: 'draft skipped' }>['result']): string {
  if (result.outcome === 'unknown') return `the check could not finish: ${result.reason}`;
  // Only codeboost-shaped fields: a commit subject is someone else's text.
  if (result.outcome === 'found') return result.matches.map(match => match.kind === 'pull request' ? `pull request ${match.repository}#${match.number}`
    : match.kind === 'commit' ? `commit ${match.sha.slice(0, 12)}` : 'the issue was closed').join(', ');
  return 'clear';
}
/**
 * An error's text for the record and the runner view. A `gh` failure carries its output, which a server or proxy may have
 * echoed a token into: every configured token value and every GitHub token shape is removed, as for the push.
 */
const message = (error: unknown, secrets: readonly string[]) => redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 2000);

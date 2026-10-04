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
/** The record a publish writes before it starts; one left at startup is a publish whose process stopped (#103). */
const IN_FLIGHT = 'publishing';
/** The refusal while an earlier run owes work; the publish action that gets it pays that work (web/server.ts). */
export const OWED_REFUSAL = 'An earlier run left a safety finding or a scope pause that has not been acted on yet; it is settled before anything is published.';
/**
 * How long a publish waits before its short retry: refused because GitHub's PR list lags behind a PR, refused just as
 * an opening's deadline passed, or opened while GitHub still showed another head (`reconcile`).
 */
export const SHORT_RETRY_MS = 30_000;
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
  /** The automatic retry armed for each task (at most one), cleared at shutdown. */
  #retries = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The automatic retries each task has had since its last settled publish: at most one at an opening's deadline and one
   * short one per chain, so a GitHub outage that fails every open cannot republish every settle time for ever.
   */
  #retried = new Map<string, { deadline: number; short: number }>();
  #shortRetryMs: number;
  /** Publishes in progress, by task, from scheduling until the outcome is recorded. */
  #running = new Map<string, Promise<void>>();
  constructor(store: Store, publisher: PullRequestPublisher, runner: RunnerCoordinator, executor: ItemExecutor, capability?: ShutdownCapability,
    env: NodeJS.ProcessEnv = process.env, options: { shortRetryMs?: number } = {}) {
    this.#store = store; this.#publisher = publisher; this.#runner = runner; this.#executor = executor; this.#write = settleWith(capability);
    this.#shortRetryMs = options.shortRetryMs ?? SHORT_RETRY_MS;
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
      this.#assertNothingOwed(identity);
      this.#store.assertPublishableNow(identity, false);
      return { draft: false };
    }
    if (task.status === 'needs human') {
      // A draft invites no review, and a scope pause cannot be recorded for a task already in needs human, so only an owed
      // safety finding (its escalation records it) holds a draft back.
      this.#assertNothingOwed(identity, false);
      this.#store.assertPublishableNow(identity, true);
      return { draft: true };
    }
    throw new GuardRefusal(`The task is ${task.status}; a pull request is published for a running task whose plan items have all run, or a task that needs a person.`);
  }

  /**
   * An earlier run owes a safety escalation or a scope pause (its write failed, or the process stopped): the task is not
   * finished work until that is settled, so a ready PR must not show its unreviewed changes. publishIfOwed pays it. Read
   * only for a status that could publish, so a poll of any other task does not scan its attempts.
   */
  #assertNothingOwed(identity: PlanIdentity, scope = true): void {
    if (this.#executor.owes(identity, { scope })) throw new GuardRefusal(OWED_REFUSAL);
  }

  /**
   * The publish owed, if any: the task can be published, and no publish has settled since the task last changed. Null
   * when nothing is owed.
   */
  owed(identity: PlanIdentity, options: { personAsked?: boolean } = {}): { draft: boolean } | null {
    let mode;
    try { mode = this.mode(identity); }
    catch (error) { if (error instanceof GuardRefusal || error instanceof ShuttingDownError) return null; throw error; }
    const last = this.#store.lastPublish(identity);
    // A task that reached its status before publishing existed (the v10 upgrade's record) is published only when a person
    // asks, until a run starts after the upgrade: that run's end is the first state the upgrade did not decide.
    if (last?.outcome === 'not published' && !options.personAsked && !this.#store.getAttempts(identity).some(attempt => attempt.createdAt > last.at)) return null;
    // `reconcile`: an open or update that left the PR or the task not where the publish meant them (GitHub showed another
    // head, or a draft change failed); the next publish reconciles it, so it is still owed.
    return !last || !SETTLED.includes(last.outcome) || last.reconcile || last.stateVersion !== this.#store.getTask(identity).stateVersion ? mode : null;
  }

  /**
   * The `publish` action: start a publish now, or throw its refusal. Runs after the caller's transaction commits; its
   * outcome replaces the action's saved response, so a replay reports it.
   */
  request(identity: PlanIdentity, actionId: string): { draft: boolean } {
    const mode = this.mode(identity);
    // A person's action starts a new chain, with its own automatic retries (AGENTS.md: reset on an explicit user action).
    this.#retried.delete(identityKey(identity));
    this.#schedule(identity, mode.draft, actionId);
    return mode;
  }

  /**
   * A run of the task ended, the server started, or a person's start or resume moved the task (`personAsked`: it also ends
   * the v10 upgrade's `not published` hold, as a run starting would): publish if one is owed. Never throws.
   */
  publishIfOwed(identity: PlanIdentity, options: { personAsked?: boolean; retry?: boolean } = {}): void {
    try {
      this.#payOwed(identity);
      const owed = this.owed(identity, options);
      if (!owed) return;
      // A run's end, a person's action or a restart is a meaningful lifecycle change: a new chain, with its own automatic
      // retries. A retry timer's own publish is not, or the retries would be unbounded again.
      if (!options.retry) this.#retried.delete(identityKey(identity));
      this.#schedule(identity, owed.draft);
    }
    catch (error) { console.error(`Could not start publishing: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * Startup, once the runner lock is verified: publish if one is owed. Otherwise a publish whose process stopped before
   * it recorded an outcome (a crash) is settled now: its in-flight record, and any action reply still saying
   * `publishing`, become `stopped`; the task's records (a PR it opened, recovered by its marker on the next publish)
   * show what that publish did. Never throws.
   */
  startup(identity: PlanIdentity): void {
    // A publish of this process is running: its record is its own, not one a crash left.
    if (this.busy(identity)) return;
    try {
      this.#payOwed(identity);
      const owed = this.owed(identity);
      if (owed) { this.#schedule(identity, owed.draft); return; }
      const last = this.#store.lastPublish(identity);
      if (!last || last.outcome === IN_FLIGHT) {
        if (last || this.#store.hasUnsettledPublishAction(identity)) this.#write(() => this.#store.recordPublish(identity, { outcome: 'stopped', draft: last?.draft ?? false,
          message: 'The publish was interrupted before it recorded an outcome (codeboost stopped). Its pull request, if it opened one, is in the task\'s records; the publish action runs it again.' }));
      // Only a reply is stuck (its publish never recorded itself as started): it reports the outcome on record, which is
      // left as it is, stamp included, so what is owed does not change.
      } else if (this.#store.hasUnsettledPublishAction(identity)) this.#write(() => this.#store.settleUnsettledPublishReplies(identity, last));
    } catch (error) { console.error(`Could not start publishing: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * Shutdown: refuse new publishes, abort those in progress (the publisher refuses every later push, opening and ready
   * change) and await their recorded outcomes.
   */
  async close(): Promise<void> {
    this.#closing = true;
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    await this.#publisher.close();
    while (this.#running.size) await Promise.all([...this.#running.values()]);
  }

  /** Settle what an earlier run owes before deciding what to publish (see mode); a task it moves is then not finished work. */
  #payOwed(identity: PlanIdentity): void {
    if (this.#closing || this.#runner.closing) return;
    // Only where a run would pay it before its first item (a running or queued task), or where a draft waits on it.
    if (!['running', 'queued', 'needs human'].includes(this.#store.getTask(identity).status)) return;
    // Its failure must not stop the caller from settling what it can (an in-flight record, a stuck reply): the task still
    // owes the work, and mode() refuses to publish until it is paid.
    try {
      const paid = this.#executor.payOwed(identity);
      if (paid?.kind === 'stopped') console.error(`Could not settle what an earlier run owes: ${JSON.stringify(paid.reason ?? '')}`);
    } catch (error) { console.error(`Could not settle what an earlier run owes: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * A publish that ended with an opening still in flight (its reply was lost, or it was refused while one settles),
   * refused because GitHub's list lags behind a PR, or opened without settling (`reconcile`) is tried again by itself:
   * nothing else would (no run ends, startup has passed). Bounded (AGENTS.md: back off recurring external polling): one
   * timer per task, and per chain (until a publish settles) at most one retry at an opening's deadline, while it is
   * still ahead, and one short retry. What is still unsettled after them is stuck for a reason a person must fix (two
   * PRs carry a marker, the repository changed, GitHub keeps failing): the next publish waits for a run's end, a restart
   * or the action. Never throws.
   */
  #retryIfUnsettled(identity: PlanIdentity, record: Omit<PublishRecord, 'stateVersion' | 'at'>, unsettled: boolean): void {
    try {
      const key = identityKey(identity);
      if (SETTLED.includes(record.outcome) && !record.reconcile) { this.#retried.delete(key); return; }
      if (this.#closing || this.#retries.has(key)) return;
      const retried = this.#retried.get(key) ?? { deadline: 0, short: 0 };
      const remaining = this.#publisher.settleRemaining(identity);
      let wait: number | null = null;
      if (remaining !== null && remaining > 0 && retried.deadline < 1) { retried.deadline++; wait = remaining; }
      // Refused for the list's lag or just as an opening's deadline passed, or opened without settling: one short retry.
      // Not while an opening's deadline is still ahead: a publish before it would only be refused again.
      else if ((unsettled || record.reconcile) && !(remaining !== null && remaining > 0) && retried.short < 1) { retried.short++; wait = this.#shortRetryMs; }
      if (wait === null) return;
      this.#retried.set(key, retried);
      const timer = setTimeout(() => { this.#retries.delete(key); this.publishIfOwed(identity, { retry: true }); }, wait + 1_000);
      timer.unref?.();
      this.#retries.set(key, timer);
    } catch (error) { console.error(`Could not arrange a retry of the publish: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  #schedule(identity: PlanIdentity, draft: boolean, actionId?: string): void {
    const key = identityKey(identity);
    // Reserved in this turn, so a second request in the same transaction is refused.
    const reserved = Promise.withResolvers<void>();
    this.#running.set(key, reserved.promise);
    const run = async () => {
      // Durable in-flight ownership before the first external write (AGENTS.md): if this process stops before the outcome
      // is recorded, startup finds the marker and publishes again or settles it as interrupted. No marker, no publish.
      try { this.#write(() => this.#store.recordPublish(identity, { outcome: IN_FLIGHT, draft, message: 'A pull request is being published.' })); }
      catch (error) { console.error(`Could not record the publish as started, so it did not run: ${JSON.stringify(message(error, this.#secrets))}`); return; }
      let record: Omit<PublishRecord, 'stateVersion' | 'at'>, unsettled = false;
      try {
        // The problems are read when the publish starts: the task is in needs human, and its last attempt says why.
        const outcome = await this.#publisher.publish(identity, draft ? { problems: this.#problems(identity) } : {});
        record = describe(outcome, draft);
      } catch (error) {
        unsettled = error instanceof OpeningUnsettled;
        const stopped = error instanceof ShuttingDownError || (this.#closing && (error as Error)?.name === 'AbortError');
        record = { outcome: stopped ? 'stopped' : REFUSALS.some(type => error instanceof type) ? 'refused' : 'failed', draft, message: message(error, this.#secrets) };
      }
      try { this.#write(() => this.#store.recordPublish(identity, record, actionId)); }
      catch (error) { console.error(`Could not record the publish outcome: ${JSON.stringify(message(error, this.#secrets))}`); }
      this.#retryIfUnsettled(identity, record, unsettled);
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
    // A ready publish whose task did not reach in review (GitHub showed another head, so the PR was drafted), or any
    // publish that left a PR ready it meant to draft, is not done: the next publish reconciles it.
    case 'opened': return { outcome: outcome.kind, draft, number: outcome.number, url: outcome.url,
      // Only while the task can still be published (running, needs human): an approved, merged or cancelled task is
      // published no more, so nothing would reconcile it.
      ...(['running', 'needs human'].includes(outcome.status) && ((!draft && outcome.status !== 'in review') || outcome.leftReady !== undefined) ? { reconcile: true } : {}),
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

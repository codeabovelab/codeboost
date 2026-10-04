import { identityKey, type PlanIdentity } from '../core/identity.ts';
import { PullRequestMisplaced, PullRequestRefused } from '../github/pull-requests.ts';
import { BranchPushRefused, redact, TOKEN_VARIABLES } from './branch-push.ts';
import type { RunnerCoordinator } from './coordinator.ts';
import { SAFETY_VIOLATION, type ItemExecutor } from './execution.ts';
import { GuardRefusal, ShuttingDownError, settleWith, type ShutdownCapability } from './lifecycle.ts';
import { OpeningUnsettled, type PublishOutcome, type PullRequestPublisher } from './publish.ts';
import type { PublishRecord, Store } from './store.ts';

/** Outcomes after which nothing is owed until the task changes again. Every other record (a refusal, a failure, a stop) leaves the publish owed. */
const SETTLED = ['opened', 'possibly already fixed', 'draft skipped', 'draft unsupported', 'no changes',
  // Recorded by the v10 upgrade for a task that reached its status before publishing existed: only the action publishes it.
  'not published'];
/** The records a publish or close writes before it starts; one left at startup is a job whose process stopped. */
const IN_FLIGHT = ['publishing', 'closing'];
/** The refusal while an earlier run owes work; the publish action that gets it pays that work (web/server.ts). */
export const OWED_REFUSAL = 'An earlier run left a safety finding or a scope pause that has not been acted on yet; it is settled before anything is published.';
/**
 * How long a publish waits before its short retry: refused because GitHub's PR list lags behind a PR, refused just as
 * an opening's deadline passed, or opened while GitHub still showed another head (`reconcile`).
 */
export const SHORT_RETRY_MS = 30_000;
/** Refusals a person acts on; anything else that fails is reported as `failed`. */
const REFUSALS = [GuardRefusal, BranchPushRefused, OpeningUnsettled, PullRequestMisplaced, PullRequestRefused];
/** A publish stopped because a person cancelled its task (#111); the close that follows does what is left. */
export class PublishCancelled extends Error {}

/** What a task's pull request work is now: a publish (ready or draft), or the close of a cancelled task's PRs (#111). */
export type PullRequestJob = { kind: 'publish'; draft: boolean } | { kind: 'close' };

/**
 * Publishes a task's pull request in production (#103), and closes a cancelled task's PRs (#111): when a run ends, when
 * a task is cancelled, on the `publish` and `close-pull-requests` actions, and once at startup. The task's status
 * decides the job: a running task whose every plan item has run gets a ready PR, a task in needs human a draft PR with
 * its problems, a cancelled task's open PRs are closed. One job per task at a time, in the background, tracked until it
 * settles; its outcome is recorded in the Store, where GET /api/runner reads it. Shutdown aborts every job and awaits it
 * before the Store's write gate closes, so a job's last records still land.
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
  /**
   * The reason an owed escalation was paid with (a safety finding whose save had failed): the executor settles it in
   * memory only, so the task's attempt rows do not carry it, and the draft PR would otherwise not say why (#103).
   */
  #escalations = new Map<string, { reason: string; attemptId: string | null }>();
  /** Jobs in progress, by task, from scheduling until the outcome is recorded; `abort` stops a publish on cancel. */
  #running = new Map<string, { job: PullRequestJob; done: Promise<void>; abort: AbortController }>();
  constructor(store: Store, publisher: PullRequestPublisher, runner: RunnerCoordinator, executor: ItemExecutor, capability?: ShutdownCapability,
    env: NodeJS.ProcessEnv = process.env, options: { shortRetryMs?: number } = {}) {
    this.#store = store; this.#publisher = publisher; this.#runner = runner; this.#executor = executor; this.#write = settleWith(capability);
    this.#shortRetryMs = options.shortRetryMs ?? SHORT_RETRY_MS;
    this.#secrets = TOKEN_VARIABLES.flatMap(name => env[name] ?? []);
  }

  /** Whether a publish or close of this task is in progress. */
  busy(identity: PlanIdentity): boolean { return this.#running.has(identityKey(identity)); }
  lastOutcome(identity: PlanIdentity): PublishRecord | null { return this.#store.lastPublish(identity); }
  /** Resolves once the task's job in progress, and any close it led to, have recorded their outcomes. */
  async settled(identity: PlanIdentity): Promise<void> {
    for (let job = this.#running.get(identityKey(identity)); job; job = this.#running.get(identityKey(identity))) await job.done;
  }

  /**
   * What a job would do now. Throws the refusal otherwise, with what a person can act on. Writes nothing, so the view
   * asks it too and never offers what an action would refuse.
   */
  mode(identity: PlanIdentity, progress?: { next: string | null }): PullRequestJob {
    if (this.#closing || this.#runner.closing) throw new ShuttingDownError();
    if (this.busy(identity)) throw new GuardRefusal(`A pull request is already being ${this.#running.get(identityKey(identity))!.job.kind === 'close' ? 'closed' : 'published'} for this task.`);
    const task = this.#store.getTask(identity);
    if (task.status === 'cancelled') {
      // Only what the task opened, or was opening, can be closed: a task that never began a PR has nothing to do.
      if (!this.#store.taskPullRequests(identity).length) throw new GuardRefusal('The task has no pull request to close.');
      return { kind: 'close' };
    }
    // Publishing reads the task head, so it waits for the run (and the attempt) to end: assertPublishable refuses an active attempt.
    if (this.#runner.isActive(identity) || this.#executor.busy(identity)) throw new GuardRefusal('A run of this task is still in progress; publish once it has ended.');
    if (task.status === 'running') {
      const { next } = progress ?? this.#executor.progress(identity);
      if (next !== null) throw new GuardRefusal(`${next} has not run yet; publish once every plan item has run.`);
      this.#assertNothingOwed(identity);
      this.#store.assertPublishableNow(identity, false);
      return { kind: 'publish', draft: false };
    }
    if (task.status === 'needs human') {
      // A draft invites no review, and a scope pause cannot be recorded for a task already in needs human, so only an owed
      // safety finding (its escalation records it) holds a draft back.
      this.#assertNothingOwed(identity, false);
      this.#store.assertPublishableNow(identity, true);
      return { kind: 'publish', draft: true };
    }
    throw new GuardRefusal(`The task is ${task.status}; a pull request is published for a running task whose plan items have all run, or a task that needs a person.`);
  }

  /**
   * An earlier run owes a safety escalation or a scope pause (its write failed, or the process stopped): the task is not
   * finished work until that is settled, so a ready PR must not show its unreviewed changes. actIfOwed pays it. Read
   * only for a status that could publish, so a poll of any other task does not scan its attempts.
   */
  #assertNothingOwed(identity: PlanIdentity, scope = true): void {
    if (this.#executor.owes(identity, { scope })) throw new GuardRefusal(OWED_REFUSAL);
  }

  /**
   * The job owed, if any. A publish is owed when the task can be published and no publish has settled since the task last
   * changed; a close, when the task is cancelled, has a pull request record, and its PRs have not been closed since. Either
   * is owed while an action that asked for it has not recorded an outcome.
   */
  owed(identity: PlanIdentity, options: { personAsked?: boolean } = {}): PullRequestJob | null {
    let job;
    try { job = this.mode(identity); }
    catch (error) { if (error instanceof GuardRefusal || error instanceof ShuttingDownError) return null; throw error; }
    // A person asked for this job and its process stopped before it recorded anything (a crash between the action and its
    // in-flight record): the request is owed, whatever an earlier job settled, e.g. a close after a PR was reopened.
    if (this.#store.hasUnsettledPublishAction(identity)) return job;
    const last = this.#store.lastPublish(identity);
    // A task that reached its status before publishing existed (the v10 upgrade's record) is published only when a person
    // asks, until a run starts after the upgrade: that run's end is the first state the upgrade did not decide.
    if (last?.outcome === 'not published' && !options.personAsked && !this.#store.getAttempts(identity).some(attempt => attempt.createdAt > last.at)) return null;
    if (job.kind === 'close') return last?.outcome === 'closed' ? null : job;
    // `reconcile`: an open or update that left the PR or the task not where the publish meant them (GitHub showed another
    // head, or a draft change failed); the next publish reconciles it, so it is still owed.
    return !last || !SETTLED.includes(last.outcome) || last.reconcile || last.stateVersion !== this.#store.getTask(identity).stateVersion ? job : null;
  }

  /**
   * The `publish` or `close-pull-requests` action: start that job now, or throw its refusal. Runs after the caller's
   * transaction commits; its outcome replaces the action's saved response, so a replay reports it.
   */
  request(identity: PlanIdentity, kind: PullRequestJob['kind'], actionId: string): PullRequestJob {
    // The action's own refusal comes first: asking to close a running task's PRs is not answered with a publish refusal.
    const status = this.#store.getTask(identity).status;
    if (kind === 'close' && status !== 'cancelled') throw new GuardRefusal(`The task is ${status}; only a cancelled task's pull requests are closed.`);
    if (kind === 'publish' && status === 'cancelled') throw new GuardRefusal('The task is cancelled; its pull requests are closed, not published.');
    const job = this.mode(identity);
    // A person's action starts a new chain, with its own automatic retries (AGENTS.md: reset on an explicit user action).
    this.#newChain(identity);
    this.#schedule(identity, job, actionId);
    return job;
  }

  /**
   * A run of the task ended, the task was cancelled, the server started, or a person's start or resume moved the task
   * (`personAsked`: it also ends the v10 upgrade's `not published` hold, as a run starting would): do the job owed, if
   * any. Never throws.
   */
  actIfOwed(identity: PlanIdentity, options: { personAsked?: boolean; retry?: boolean } = {}): void {
    try {
      this.#payOwed(identity);
      const job = this.owed(identity, options);
      if (!job) return;
      // A run's end, a cancel, a person's action or a restart is a meaningful lifecycle change: a new chain, with its own
      // automatic retries. A retry timer's own job is not, or the retries would be unbounded again.
      if (!options.retry) this.#newChain(identity);
      this.#schedule(identity, job);
    }
    catch (error) { console.error(`Could not start pull request work: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * The task was just cancelled (#111): stop its publish in progress, if any, whose own end then closes what it left;
   * otherwise close the task's PRs now. The cancel itself never waits for GitHub.
   */
  taskCancelled(identity: PlanIdentity): void {
    const running = this.#running.get(identityKey(identity));
    if (running?.job.kind === 'publish') running.abort.abort(new PublishCancelled('The task was cancelled; its pull requests are closed instead.'));
    else if (!running) this.actIfOwed(identity);
  }

  /**
   * Startup, once the runner lock is verified: do the job owed, if any. Otherwise a publish or close action whose process
   * stopped before its job recorded an outcome (a crash) is settled now, so its replay stops saying `publishing` or
   * `closing`, and its in-flight record becomes `stopped`; the task's records show what that job did, and the action
   * runs it again. Never throws.
   */
  startup(identity: PlanIdentity): void {
    // A publish of this process is running: its record is its own, not one a crash left.
    if (this.busy(identity)) return;
    try {
      this.#payOwed(identity);
      const job = this.owed(identity);
      if (job) { this.#schedule(identity, job); return; }
      const last = this.#store.lastPublish(identity), closing = this.#store.getTask(identity).status === 'cancelled';
      if (!last || IN_FLIGHT.includes(last.outcome)) {
        if (last || this.#store.hasUnsettledPublishAction(identity)) this.#write(() => this.#store.recordPublish(identity, { outcome: 'stopped', draft: last?.draft ?? false, ...(closing ? { action: 'close' as const } : {}),
          message: `The ${closing ? 'close' : 'publish'} was interrupted before it recorded an outcome (codeboost stopped). The task's records show what it did; the ${closing ? 'close-pull-requests' : 'publish'} action runs it again.` }));
      // Only a reply is stuck (its job never recorded itself as started): it reports the outcome on record, which is left
      // as it is, stamp included, so what is owed does not change.
      } else if (this.#store.hasUnsettledPublishAction(identity)) this.#write(() => this.#store.settleUnsettledPublishReplies(identity, last));
    } catch (error) { console.error(`Could not start pull request work: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * Shutdown: refuse new jobs, abort those in progress (the publisher refuses every later push, opening, ready change and
   * close) and await their recorded outcomes.
   */
  async close(): Promise<void> {
    this.#closing = true;
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    await this.#publisher.close();
    while (this.#running.size) await Promise.all([...this.#running.values()].map(running => running.done));
  }

  /** Settle what an earlier run owes before deciding what to publish (see mode); a task it moves is then not finished work. */
  #payOwed(identity: PlanIdentity): void {
    if (this.#closing || this.#runner.closing) return;
    // Only where a run would pay it before its first item (a running or queued task), or where a draft waits on it.
    if (!['running', 'queued', 'needs human'].includes(this.#store.getTask(identity).status)) return;
    // Its failure must not stop the caller from settling what it can (an in-flight record, a stuck reply): the task still
    // owes the work, and mode() refuses to publish until it is paid.
    try {
      // A task in needs human cannot record a scope pause, and its draft does not wait for one (mode): only a finding.
      const paid = this.#executor.payOwed(identity, { scope: this.#store.getTask(identity).status !== 'needs human' });
      // Tied to the attempt current once paid: a later run (a new attempt) that ends in needs human again has its own reason.
      if (paid?.kind === 'needs human') this.#escalations.set(identityKey(identity), { reason: paid.reason, attemptId: this.#store.getTask(identity).currentAttemptId });
      if (paid?.kind === 'stopped') console.error(`Could not settle what an earlier run owes: ${JSON.stringify(paid.reason ?? '')}`);
    } catch (error) { console.error(`Could not settle what an earlier run owes: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  /**
   * A new chain (a run's end, a cancel, a person's action, a restart): a fresh retry budget, and a retry the old chain armed is
   * dropped with it, so it cannot fire later on the new chain's budget. One timer per task at all times.
   */
  #newChain(identity: PlanIdentity): void {
    const key = identityKey(identity);
    this.#retried.delete(key);
    const armed = this.#retries.get(key);
    if (armed) { clearTimeout(armed); this.#retries.delete(key); }
  }

  /**
   * A publish or close that ended with an opening still in flight (its reply was lost, or it was refused while one settles),
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
      if ((SETTLED.includes(record.outcome) || record.outcome === 'closed') && !record.reconcile) { this.#retried.delete(key); return; }
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
      const timer = setTimeout(() => { this.#retries.delete(key); this.actIfOwed(identity, { retry: true }); }, wait + 1_000);
      timer.unref?.();
      this.#retries.set(key, timer);
    } catch (error) { console.error(`Could not arrange a retry of the publish: ${JSON.stringify(message(error, this.#secrets))}`); }
  }

  #schedule(identity: PlanIdentity, job: PullRequestJob, actionId?: string): void {
    const key = identityKey(identity);
    // Reserved in this turn, so a second request in the same transaction is refused.
    const reserved = Promise.withResolvers<void>(), abort = new AbortController();
    this.#running.set(key, { job, done: reserved.promise, abort });
    const run = async () => {
      // Durable in-flight ownership before the first external write (AGENTS.md): if this process stops before the outcome
      // is recorded, startup finds the marker and publishes again or settles it as interrupted. No marker, no publish.
      const draft = job.kind === 'publish' && job.draft;
      try {
        this.#write(() => this.#store.recordPublish(identity, job.kind === 'close' ? { outcome: 'closing', draft: false, action: 'close', message: 'The task\'s pull requests are being closed.' }
          : { outcome: 'publishing', draft, message: 'A pull request is being published.' }));
      }
      catch (error) { console.error(`Could not record the publish as started, so it did not run: ${JSON.stringify(message(error, this.#secrets))}`); return; }
      let record: Omit<PublishRecord, 'stateVersion' | 'at'>, unsettled = false;
      try {
        if (job.kind === 'close') {
          const closed = await this.#publisher.closeAll(identity, abort.signal);
          record = { outcome: 'closed', draft: false, action: 'close', message: closed.length
            ? `${closed.length === 1 ? 'Pull request' : 'Pull requests'} ${closed.map(number => `#${number}`).join(', ')} closed; the task's branch is kept.`
            : 'No open pull request of the task was left to close.' };
        } else {
          // The problems are read when the publish starts: the task is in needs human, and its last attempt says why.
          const outcome = await this.#publisher.publish(identity, draft ? { problems: this.#problems(identity) } : {}, abort.signal);
          record = describe(outcome, draft);
        }
      } catch (error) {
        // A guard refusal is mostly a race (the task, its review or its head changed during the job): one short retry
        // acts on the new state. One that persists is in mode() too, so the retry finds nothing owed.
        unsettled = error instanceof OpeningUnsettled || error instanceof GuardRefusal;
        const stopped = error instanceof ShuttingDownError || error instanceof PublishCancelled || (this.#closing && (error as Error)?.name === 'AbortError');
        record = { outcome: stopped ? 'stopped' : REFUSALS.some(type => error instanceof type) ? 'refused' : 'failed', draft, message: message(error, this.#secrets),
          ...(job.kind === 'close' ? { action: 'close' as const } : {}) };
      }
      try { this.#write(() => this.#store.recordPublish(identity, record, actionId)); }
      catch (error) { console.error(`Could not record the pull request outcome: ${JSON.stringify(message(error, this.#secrets))}`); }
      this.#retryIfUnsettled(identity, record, unsettled);
    };
    const release = () => {
      this.#running.delete(key);
      // A publish that the task's cancel stopped, or that ended as the task was cancelled, leaves its PRs to close (#111).
      // Started before `done` resolves, so settled() and shutdown see the close too. Only then: a refused publish stays
      // owed, and starting it again here would repeat it without end. A close never starts another job.
      try { if (job.kind === 'publish' && this.#store.getTask(identity).status === 'cancelled') this.actIfOwed(identity); }
      catch (error) { console.error(`Could not start closing pull requests: ${JSON.stringify(message(error, this.#secrets))}`); }
      reserved.resolve();
    };
    // Starts once the caller's transaction (the action's userAction) has committed; a rollback starts nothing.
    this.#store.afterCommit(() => { void run().finally(release); }, () => { this.#running.delete(key); reserved.resolve(); });
  }

  /**
   * Why a needs-human task needs a person, for its draft PR, from what sent it there now: its current attempt's safety
   * finding first (a budget that also ran out since must not hide it), then its spent budget, then that attempt's
   * diagnostic. An earlier attempt's finding, which a person may have dealt with, is not used.
   */
  #problems(identity: PlanIdentity): string[] {
    const task = this.#store.getTask(identity);
    // An owed finding paid here first: only this process knows its text. Only while the task is still in needs human from
    // that payment (the same current attempt); once a later run has started, the finding is an earlier attempt's.
    const key = identityKey(identity), escalated = this.#escalations.get(key);
    if (escalated && task.status === 'needs human' && escalated.attemptId === task.currentAttemptId) return [escalated.reason];
    this.#escalations.delete(key);
    const current = task.currentAttemptId === null ? undefined : this.#store.getAttempt(identity, task.currentAttemptId);
    if (current?.safetyFinding) return [current.safetyFinding];
    // A finding whose save failed while the run still moved the task: the attempt's diagnostic is the finding's text.
    if (current?.diagnostic?.startsWith(SAFETY_VIOLATION)) return [current.diagnostic];
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

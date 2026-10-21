import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { GuardRefusal } from './lifecycle.ts';
import { AgentWorker, type Provider } from './question-agent.ts';
import { StopError } from './question-container.ts';
import { LeftoverLedger, PLANNING_NAMING } from './question-leftovers.ts';
import { PLANNING_BUDGET_MS, planningRun } from './planning-provider.ts';
import type { ReviewService } from './review.ts';

// Leave the worker time to cancel the container and release storage before E3's own timer fires (as Ask does).
const SETTLE_MARGIN_MS = 5_000;
export const NO_PLANNING_AGENT = 'Choose an agent in Settings, then retry.';

/**
 * The planning check (#164): one planning invocation in the profile a real request gets (lane D's "planning" phase:
 * read, list and search only, vendor-only egress, the answer constrained by a mounted schema), on the review's code at
 * the current snapshot's head. It passes when the agent signs in and returns exactly this schema's answer.
 */
export const PLANNING_PROBE_PROMPT = 'This is codeboost\'s check that planning works. Read no files. '
  + 'Answer with the JSON object {"ok": true} and nothing else.';
export const PLANNING_PROBE_SCHEMA = JSON.stringify({ type: 'object', properties: { ok: { const: true } },
  required: ['ok'], additionalProperties: false });
/**
 * Whether a planning answer is exactly the check's: the object `{"ok": true}`, as JSON, with that one member written
 * once (JSON.parse would let a repeated key's last value win).
 */
export function isPlanningProbeAnswer(text: string): boolean {
  return /^[ \t\n\r]*\{[ \t\n\r]*"ok"[ \t\n\r]*:[ \t\n\r]*true[ \t\n\r]*\}[ \t\n\r]*$/.test(text);
}

/**
 * The production planning provider (#117): every request runs in planning's own worker thread, so lane D's synchronous
 * setup never blocks the server. The worker's TMPDIR is a planning root recorded in a ledger beside the review
 * database, and every Docker object it creates carries the database's planning owner. The first job of a process that
 * can sign in (in production, web/planning.ts, always a planning check: at startup, or one a request starts) removes
 * what earlier sessions left, by that owner only, so Ask's and the runner's agents are never touched. A first job whose
 * recovery fails leaves it to the next job.
 *
 * The code is the review's repository at the current snapshot's head; E3 discards a reply whose snapshot or revision
 * changed meanwhile. The vendor is the one chosen in Settings for Ask; Codex is refused (#93).
 */
export class PlanningAgent implements AuthorProvider {
  readonly #service: ReviewService;
  readonly #worker: AgentWorker;
  constructor(service: ReviewService, options: { url?: URL; env?: Readonly<Record<string, string | undefined>>;
    ledger?: LeftoverLedger; abandonAfterDeadlineMs?: number; terminateWaitMs?: number; releaseTimeoutMs?: number } = {}) {
    this.#service = service;
    // Beside the review database's canonical path, so a restart of the same review finds what an earlier session left.
    const ledger = options.ledger ?? LeftoverLedger.forDatabase(service.config.database, PLANNING_NAMING);
    this.#worker = new AgentWorker(options.url, ledger, { naming: PLANNING_NAMING, env: options.env,
      abandonAfterDeadlineMs: options.abandonAfterDeadlineMs, terminateWaitMs: options.terminateWaitMs,
      releaseTimeoutMs: options.releaseTimeoutMs,
      runnerOwner: () => service.store.planningOwnerToken(ledger.identity!) });
  }
  async invoke(request: AuthorRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const store = this.#service.store, vendor = store.questionProvider();
    if (!vendor) throw new Error(NO_PLANNING_AGENT);
    const snapshot = store.getSnapshot(request.identity);
    const run = planningRun(request, { vendor, repository: this.#service.reviewRepository().path, head: snapshot.head,
      snapshotId: snapshot.id }, Date.now() + PLANNING_BUDGET_MS - SETTLE_MARGIN_MS);
    return this.#worker.plan(run, signal);
  }
  /**
   * Run the planning check (#164) with `vendor`, in this provider's worker. Rejects with the reason when the agent
   * cannot run a planning invocation (no sign-in, Codex, Docker, a refused or wrong answer); resolves when it can.
   */
  async probe(vendor: Provider, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const store = this.#service.store, identity = this.#service.config.identity;
    const plan = store.getPlan(identity), snapshot = store.getSnapshot(identity), requestId = randomUUID();
    const run = planningRun({ mode: 'suggest', phase: 'planning', access: 'read-only', identity, requestId, issue: plan.issue,
      revision: plan.revision, prompt: PLANNING_PROBE_PROMPT, schemaText: PLANNING_PROBE_SCHEMA },
    { vendor, repository: this.#service.reviewRepository().path, head: snapshot.head, snapshotId: snapshot.id },
    // A real request's budget: a process's first job may build the agent image, which takes its time from this.
    Date.now() + PLANNING_BUDGET_MS - SETTLE_MARGIN_MS);
    const text = await this.#worker.plan({ ...run, taskId: `planning-probe-${requestId}` }, signal);
    if (!isPlanningProbeAnswer(text)) throw new Error('The planning agent did not give the check\'s answer.');
  }
  /** Call only after every request has settled (E3's close). Releases what the worker still owns, then stops it. */
  close(): Promise<void> { return this.#worker.close(); }
}

/** Starts every refusal from planning admission: a failed or unfinished check, a stopped wait, and planning stopping. */
export const PLANNING_UNAVAILABLE = 'Planning is unavailable:';
/** How long a failed check refuses requests before the next request checks again. */
export const PLANNING_RECHECK_MS = 60_000;
/** How long a request waits for a running check before it is refused, so the browser is never held for long. */
export const PLANNING_ADMIT_WAIT_MS = 30_000;
/** How long close waits for a check that is still running after it is cancelled. */
export const PLANNING_CHECK_CLOSE_MS = 20_000;

/** One run of the planning check, for one vendor. `passed` or `failure` is set once it settles. */
type Check = { vendor: Provider; done: Promise<void>; passed: boolean; failure?: { error: unknown; at: number };
  abort: AbortController; replaced?: boolean };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const STILL_CHECKING = `${PLANNING_UNAVAILABLE} codeboost is still checking the planning agent. The first check after `
  + 'codeboost starts can take several minutes while the agent image is built. Retry in a minute.';
const duration = (ms: number) => ms === 60_000 ? 'a minute' : ms < 1_000 ? 'a moment'
  : ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1_000)} s`;
// Reasons a recheck cannot help, so only a restart can: an abandoned worker (question-agent.ts), unconfirmed cleanup
// (planning-provider.ts' "off until codeboost restarts"), a database file with other hard links (question-leftovers.ts),
// and a missing token, since codeboost's environment is fixed while it runs. Each is codeboost's own message, given
// before any vendor output. A run whose cleanup did not settle is not among them: its storage is retried before the
// next run, and if planning did go off, the recheck reports that with these words.
const UNTIL_RESTART = /until codeboost restarts|needs CLAUDE_CODE_OAUTH_TOKEN|a database file without hard links/;
const ownText = (message: string) => message.split(' Claude said:')[0]!;
/**
 * How long one check may take before it fails: a real request's budget, as the probe has, and a minute for the worker
 * to settle. Waiting requests are then refused with the failure, and the next one after the recheck window checks
 * again. A recheck joins the worker's one startup recovery, so a recovery that never ends fails each recheck the same
 * way until codeboost restarts.
 */
export const PLANNING_CHECK_TIMEOUT_MS = PLANNING_BUDGET_MS + 60_000;
/**
 * Admission for planning requests (#164). The check runs for the vendor chosen in Settings: `start` begins it at
 * startup, and `admit`, called before anything about a request is recorded, waits for it. The last check is kept: a
 * passed one admits every request for its vendor; a failed one refuses them for `recheckMs`, after which the next
 * request checks again. The first request after the vendor changes starts that vendor's check and cancels the one it
 * replaces. A request waits for a check for at most `waitMs` in all, then is refused as still checking. With no vendor
 * chosen nothing is checked, and the request fails later, as before, with `NO_PLANNING_AGENT`.
 */
export class PlanningCheck {
  readonly #probe: (vendor: Provider, signal: AbortSignal) => Promise<void>;
  readonly #vendor: () => Provider | null;
  readonly #recheckMs: number;
  readonly #waitMs: number;
  readonly #timeoutMs: number;
  readonly #abort = new AbortController();
  readonly #running = new Set<Promise<void>>();
  #current?: Check;
  // Tells a request waiting on an older check that `#current` was replaced, so it moves to the new one at once. A
  // listener, removed when the wait ends, so no settled request stays attached.
  readonly #events = new EventTarget();
  constructor(probe: (vendor: Provider, signal: AbortSignal) => Promise<void>, vendor: () => Provider | null,
    options: { recheckMs?: number; waitMs?: number; timeoutMs?: number } = {}) {
    // One listener per waiting request and per running check, each removed when it ends: many at once are no leak.
    setMaxListeners(0, this.#events, this.#abort.signal);
    this.#probe = probe; this.#vendor = vendor;
    this.#recheckMs = options.recheckMs ?? PLANNING_RECHECK_MS; this.#waitMs = options.waitMs ?? PLANNING_ADMIT_WAIT_MS;
    this.#timeoutMs = options.timeoutMs ?? PLANNING_CHECK_TIMEOUT_MS;
  }
  /** Begin the check for the chosen vendor, if any, without waiting for it. */
  start(): void {
    const vendor = this.#vendor();
    if (vendor) this.#check(vendor);
  }
  // The current check if it covers `vendor`: for that vendor, and not failed `recheckMs` ago.
  #covering(vendor: Provider) {
    const current = this.#current;
    return current && current.vendor === vendor
      && !(current.failure && performance.now() - current.failure.at >= this.#recheckMs) ? current : undefined;
  }
  // The check that covers `vendor`, started now if none does.
  #check(vendor: Provider) {
    const covering = this.#covering(vendor);
    if (covering) return covering;
    if (this.#abort.signal.aborted) throw new GuardRefusal(`${PLANNING_UNAVAILABLE} planning is stopping.`);
    // A check for another vendor no longer admits anything: stop it, so replaced checks do not pile up in the worker.
    if (this.#current && !this.#current.passed && !this.#current.failure) {
      this.#current.replaced = true;
      this.#current.abort.abort(new Error('The planning agent chosen in Settings changed.'));
    }
    const abort = new AbortController(), stop = () => abort.abort(this.#abort.signal.reason);
    this.#abort.signal.addEventListener('abort', stop, { once: true });
    const check: Check = { vendor, done: Promise.resolve(), passed: false, abort };
    let probe: Promise<void>;
    // Started now, so close can cancel it; a probe that throws instead of rejecting fails the check the same way.
    try { probe = this.#probe(vendor, abort.signal); } catch (error) { probe = Promise.reject(error); }
    // Bounded: a check that has not settled in time fails, and is cancelled, so the recheck path applies to it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`The planning check did not finish within ${duration(this.#timeoutMs)}.`);
        reject(error); abort.abort(error);
      }, this.#timeoutMs);
      timer.unref?.();
    });
    // Never rejects: the outcome is kept on the check, so every waiting request gets it.
    const done = Promise.race([probe, late]).then(() => { check.passed = true; }, (error: unknown) => {
      check.failure = { error, at: performance.now() };
    }).finally(() => { clearTimeout(timer); this.#abort.signal.removeEventListener('abort', stop); });
    check.done = done;
    // Close waits for the probe itself too: a check that timed out has settled, but its job may still be in the worker.
    const settled = probe.then(() => undefined, () => undefined);
    for (const running of [done, settled]) {
      this.#running.add(running);
      void running.finally(() => this.#running.delete(running));
    }
    this.#current = check;
    this.#events.dispatchEvent(new Event('replaced'));
    return check;
  }
  /**
   * Resolve once the check for the vendor chosen now has passed; reject with a `GuardRefusal` naming why when it
   * failed, or when no check passed within `waitMs`. `signal` stops only this wait, never the check, which other
   * requests may share: an aborted wait rejects with `signal.reason`, and a vendor that cannot be read (a Store error)
   * with that error; the caller maps both.
   *
   * A passed check is kept until a check for another vendor replaces it: a worker that is abandoned later, cleanup that
   * does not settle later (the check's own run included, when its answer still came back), or a token revoked later
   * shows as a failed request, not as "Planning is unavailable".
   */
  async admit(signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + this.#waitMs;
    for (;;) {
      // A request that stopped waiting starts, replaces or cancels no check.
      signal.throwIfAborted();
      const vendor = this.#vendor();
      if (!vendor) return;
      const check = this.#check(vendor);
      // A settled check gives its verdict at once.
      if (check.passed || check.failure) return this.#verdict(check);
      let release!: () => void, moved!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<'timeout' | 'replaced'>((resolve, reject) => {
        release = () => reject(signal.reason); signal.addEventListener('abort', release, { once: true });
        moved = () => resolve('replaced'); this.#events.addEventListener('replaced', moved, { once: true });
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - performance.now()));
      });
      if (signal.aborted) release();
      let outcome: void | 'timeout' | 'replaced';
      try { outcome = await Promise.race([check.done, stopped]); }
      finally {
        signal.removeEventListener('abort', release); this.#events.removeEventListener('replaced', moved); clearTimeout(timer);
      }
      if (outcome === 'timeout') throw new GuardRefusal(STILL_CHECKING);
      // Settings changed while this request waited, or its check was replaced (the vendor changed and changed back):
      // check the vendor it will run with, within the same wait.
      if (this.#vendor() !== vendor || check.replaced || check !== this.#current) continue;
      if (!check.passed && !check.failure) continue;
      // This check's own verdict: calling #check again could start a recheck once the window has passed.
      return this.#verdict(check);
    }
  }
  /**
   * Throw a `GuardRefusal` unless the check for the vendor chosen now has passed (or no vendor is chosen). Requests call
   * it again inside the action that starts them, so a vendor chosen after `admit` never runs unchecked. It starts no
   * check there (that runs inside the Store's transaction): one it needs is started on the next turn.
   */
  assertPassed(): void {
    const vendor = this.#vendor();
    if (!vendor) return;
    const covering = this.#covering(vendor);
    if (covering) return this.#verdict(covering);
    if (this.#abort.signal.aborted) throw new GuardRefusal(`${PLANNING_UNAVAILABLE} planning is stopping.`);
    // Checks the vendor chosen when this runs, which Settings may have changed since the refusal.
    setImmediate(() => {
      // Never throws: an exception here would end the process. A Store that cannot be read starts nothing.
      try { const now = this.#vendor(); if (now) this.#check(now); } catch { /* stopping, or no Store: nothing to start */ }
    });
    throw new GuardRefusal(`${PLANNING_UNAVAILABLE} the planning agent chosen in Settings changed, and codeboost is `
      + 'checking it now. Retry in a minute.');
  }
  #verdict(check: Check): void {
    if (check.passed) return;
    // After close no check starts, so no recheck can be promised.
    if (this.#abort.signal.aborted) throw new GuardRefusal(`${PLANNING_UNAVAILABLE} planning is stopping.`);
    // The reason comes last and as it is: some end with a command a person may copy. One that holds until a restart
    // gets no promise of a recheck, which could not help.
    if (check.failure && UNTIL_RESTART.test(ownText(messageOf(check.failure.error))))
      throw new GuardRefusal(`${PLANNING_UNAVAILABLE} codeboost's check of the planning agent failed, and only a restart `
        + `of codeboost can change that. The check said: ${messageOf(check.failure.error)}`);
    // Codex is refused whatever happens (#93): only choosing another agent helps, and the next request checks that
    // one. A restart-only reason above keeps its own wording.
    if (check.failure && check.vendor === 'codex')
      throw new GuardRefusal(`${PLANNING_UNAVAILABLE} codeboost's check of the planning agent failed; choose another `
        + `agent in Settings, and the next planning request checks it. The check said: ${messageOf(check.failure.error)}`);
    if (check.failure) throw new GuardRefusal(`${PLANNING_UNAVAILABLE} codeboost's check of the planning agent failed; `
      + `it checks again on the next request after ${duration(this.#recheckMs)}. `
      + `The check said: ${messageOf(check.failure.error)}`);
    throw new GuardRefusal(STILL_CHECKING);
  }
  /** Cancel any running check and wait up to `waitMs` for it to stop. No check starts afterwards. */
  async close(waitMs = PLANNING_CHECK_CLOSE_MS): Promise<void> {
    this.#abort.abort(new StopError('Planning stopped.', 'shutdown'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(this.#running), new Promise(done => { timer = setTimeout(done, waitMs); })]);
    clearTimeout(timer);
  }
}

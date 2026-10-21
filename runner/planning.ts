import { randomUUID } from 'node:crypto';
import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { GuardRefusal } from './lifecycle.ts';
import { AgentWorker, type Provider } from './question-agent.ts';
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
/** Whether a planning answer is exactly the check's: the object `{"ok": true}`, as JSON. */
export function isPlanningProbeAnswer(text: string): boolean {
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { return false; }
  return typeof answer === 'object' && answer !== null && !Array.isArray(answer) && Object.keys(answer).length === 1
    && (answer as { ok?: unknown }).ok === true;
}
/** The whole budget of one check, setup included. Lane D caps the invocation inside it. */
export const PLANNING_PROBE_BUDGET_MS = 2 * 60_000;

/**
 * The production planning provider (#117): every request runs in planning's own worker thread, so lane D's synchronous
 * setup never blocks the server. The worker's TMPDIR is a planning root recorded in a ledger beside the review
 * database, and every Docker object it creates carries the database's planning owner. The first request of a process
 * removes what earlier sessions left, by that owner only, so Ask's and the runner's agents are never touched.
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
    Date.now() + PLANNING_PROBE_BUDGET_MS - SETTLE_MARGIN_MS);
    const text = await this.#worker.plan({ ...run, taskId: `planning-probe-${requestId}` }, signal);
    if (!isPlanningProbeAnswer(text)) throw new Error('The planning agent did not give the check\'s answer.');
  }
  /** Call only after every request has settled (E3's close). Releases what the worker still owns, then stops it. */
  close(): Promise<void> { return this.#worker.close(); }
}

/** Starts with this text when planning is refused because its check failed. */
export const PLANNING_UNAVAILABLE = 'Planning is unavailable:';
/** How long a failed check refuses requests before the next request checks again. */
export const PLANNING_RECHECK_MS = 60_000;
/** How long close waits for a check that is still running after it is cancelled. */
export const PLANNING_CHECK_CLOSE_MS = 20_000;

/** One run of the planning check, for one vendor. `failure` is set once it failed. */
type Check = { vendor: Provider; done: Promise<void>; failure?: { error: unknown; at: number } };
/**
 * Admission for planning requests (#164). The planning check runs once per process for each vendor chosen in Settings:
 * `start` begins it at startup, and `admit`, called before anything about a request is recorded, waits for it. A
 * request is refused while the check that covers it has failed: for `recheckMs` after the failure, after which the next
 * request checks again. A changed vendor is checked before its first request. With no vendor chosen nothing is
 * checked, and the request is refused later, as before, with `NO_PLANNING_AGENT`.
 */
export class PlanningCheck {
  readonly #probe: (vendor: Provider, signal: AbortSignal) => Promise<void>;
  readonly #vendor: () => Provider | null;
  readonly #recheckMs: number;
  readonly #abort = new AbortController();
  readonly #running = new Set<Promise<void>>();
  #current?: Check;
  constructor(probe: (vendor: Provider, signal: AbortSignal) => Promise<void>, vendor: () => Provider | null,
    options: { recheckMs?: number } = {}) {
    this.#probe = probe; this.#vendor = vendor; this.#recheckMs = options.recheckMs ?? PLANNING_RECHECK_MS;
  }
  /** Begin the check for the chosen vendor, if any, without waiting for it. */
  start(): void {
    const vendor = this.#vendor();
    if (vendor) this.#check(vendor);
  }
  // The check that covers `vendor` now: the current one, unless it was for another vendor, or failed `recheckMs` ago.
  #check(vendor: Provider) {
    const current = this.#current;
    if (current && current.vendor === vendor
      && !(current.failure && performance.now() - current.failure.at >= this.#recheckMs)) return current;
    if (this.#abort.signal.aborted) throw new GuardRefusal('Planning is stopping.');
    const check: Check = { vendor, done: Promise.resolve() };
    // Never rejects: a failure is kept on the check, so every waiting request is refused with it.
    const done = Promise.resolve().then(() => this.#probe(vendor, this.#abort.signal)).then(() => undefined, (error: unknown) => {
      check.failure = { error, at: performance.now() };
    });
    check.done = done;
    this.#running.add(done);
    void done.finally(() => this.#running.delete(done));
    this.#current = check;
    return check;
  }
  /**
   * Resolve once the check for the vendor chosen now has passed; reject with a `GuardRefusal` naming why when it
   * failed. `signal` stops only this wait, never the check, which other requests may share.
   */
  async admit(signal: AbortSignal): Promise<void> {
    for (;;) {
      const vendor = this.#vendor();
      if (!vendor) return;
      const check = this.#check(vendor);
      let release!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        release = () => reject(signal.reason); signal.addEventListener('abort', release, { once: true });
      });
      if (signal.aborted) release();
      try { await Promise.race([check.done, aborted]); }
      finally { signal.removeEventListener('abort', release); }
      // Settings changed while this request waited: check the vendor it will run with.
      if (this.#vendor() !== vendor) continue;
      if (!check.failure) return;
      const reason = check.failure.error instanceof Error ? check.failure.error.message : String(check.failure.error);
      throw new GuardRefusal(`${PLANNING_UNAVAILABLE} codeboost's check of the planning agent failed. ${reason} `
        + 'Planning stays off until a check passes; retry in a minute.');
    }
  }
  /** Cancel any running check and wait up to `waitMs` for it to stop. No check starts afterwards. */
  async close(waitMs = PLANNING_CHECK_CLOSE_MS): Promise<void> {
    this.#abort.abort(new Error('Planning stopped.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(this.#running), new Promise(done => { timer = setTimeout(done, waitMs); })]);
    clearTimeout(timer);
  }
}

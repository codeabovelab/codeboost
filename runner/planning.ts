import type { AuthorProvider, AuthorRequest } from '../core/planning-author.ts';
import { AgentWorker } from './question-agent.ts';
import { LeftoverLedger, PLANNING_NAMING } from './question-leftovers.ts';
import { PLANNING_BUDGET_MS, planningRun } from './planning-provider.ts';
import type { ReviewService } from './review.ts';

// Leave the worker time to cancel the container and release storage before E3's own timer fires (as Ask does).
const SETTLE_MARGIN_MS = 5_000;
export const NO_PLANNING_AGENT = 'Choose an agent in Settings, then retry.';

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
  /** Call only after every request has settled (E3's close). Releases what the worker still owns, then stops it. */
  close(): Promise<void> { return this.#worker.close(); }
}

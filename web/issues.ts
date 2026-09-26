import { IssuePrioritizer, type IssuePriorityState, type RankedIssue } from '../core/issue-ranking.ts';
import type { IssueGateway } from '../github/issues.ts';

/** Issue bodies stay on the server: the screen never shows them, and each may be up to 64 KiB. */
export type IssueSummary = Omit<RankedIssue, 'body'>;
type Summarized<State> = State extends unknown ? Omit<State, 'issues'> & { issues: IssueSummary[] } : never;
export type IssueBoardState = Summarized<IssuePriorityState>;

export type IssueBoardView =
  | { configured: false; reason: string }
  | { configured: true; repository: string; refreshing: boolean; state: IssueBoardState | null };

function summarize(state: IssuePriorityState): IssueBoardState {
  return { ...state, issues: state.issues.map(({ body: _body, ...issue }) => issue) } as IssueBoardState;
}

// Leaves headroom below the 15-second server request timeout for a request that joins an in-flight refresh.
const REFRESH_TIMEOUT_MS = 12_000;

/**
 * Server-owned issue list for the Issues screen. One refresh runs at a time; concurrent
 * requests join it. The refresh is owned by the server, not by any one HTTP request, so a
 * departing request never cancels work another request is waiting for. Shutdown aborts the
 * refresh and awaits its settlement before storage closes.
 */
export class IssueBoard {
  readonly #prioritizer: IssuePrioritizer | null;
  readonly #reason: string;
  #state: IssueBoardState | null = null;
  #flight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #closing = false;

  constructor(gateway: IssueGateway | null, unavailableReason = 'Issue ranking is not configured.', now?: () => Date) {
    this.#prioritizer = gateway ? new IssuePrioritizer(gateway, now) : null;
    this.#reason = unavailableReason;
  }

  view(): IssueBoardView {
    if (!this.#prioritizer) return { configured: false, reason: this.#reason };
    return { configured: true, repository: this.#prioritizer.gateway.repository, refreshing: this.#flight !== null, state: this.#state };
  }

  async refresh(signal?: AbortSignal): Promise<IssueBoardView> {
    if (!this.#prioritizer) return this.view();
    if (this.#closing) throw new Error('The review server is shutting down.');
    signal?.throwIfAborted();
    if (!this.#flight) {
      const controller = new AbortController();
      this.#controller = controller;
      this.#flight = this.#prioritizer.refresh({ signal: controller.signal, timeoutMs: REFRESH_TIMEOUT_MS })
        .then(state => { this.#state = summarize(state); })
        .finally(() => { this.#flight = null; this.#controller = null; });
    }
    const flight = this.#flight;
    if (!signal) await flight;
    else {
      let release!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        release = () => reject(signal.reason);
        signal.addEventListener('abort', release, { once: true });
      });
      try { await Promise.race([flight, aborted]); }
      finally { signal.removeEventListener('abort', release); }
    }
    return this.view();
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#controller?.abort(new Error('Issue refresh cancelled during shutdown.'));
    await this.#flight?.catch(() => undefined);
  }
}

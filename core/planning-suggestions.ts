import { identityKey, type PlanIdentity } from './identity.ts';
import { prepareSuggestions, type AuthorInput, type AuthorProvider } from './planning-author.ts';
import type { Diagnostic, EditReply, Plan } from './plan.ts';

/** Implemented by the existing Store. No SQL or second persistence writer in core. */
export interface SuggestionStore {
  getPlan(identity: PlanIdentity): Plan;
  getSnapshot(identity: PlanIdentity): { id: string; base: string; head: string };
  beginSuggestions(identity: PlanIdentity, expectedRevision: number): string;
  completeSuggestions(identity: PlanIdentity, id: string, reply: unknown): void;
  cancelSuggestions(identity: PlanIdentity, id: string): void;
  getSuggestions(identity: PlanIdentity, id: string): { state: string; revision: number; reply: EditReply | null };
}
export type SuggestionInput = Omit<AuthorInput, 'requestId' | 'previousPlan'>;
export type SuggestionOutcome =
  | { state: 'completed'; id: string; warnings: Diagnostic[] }
  | { state: 'failed' | 'cancelled' | 'stale'; id: string; reason: string };
export interface SuggestionHandle {
  readonly id: string;
  readonly result: Promise<SuggestionOutcome>;
  cancel(reason?: string): void;
}
interface Active {
  handle: SuggestionHandle;
  stop: (state: 'failed' | 'cancelled', reason: string) => void;
}

/** One instance per runner. Close it before closing Store. Not a cross-process scheduler. */
export class SuggestionCoordinator {
  #store: SuggestionStore;
  #provider: AuthorProvider;
  #active = new Map<string, Active>();
  #closing = false;
  #closePromise?: Promise<void>;
  #timeoutMs: number;
  constructor(store: SuggestionStore, provider: AuthorProvider, timeoutMs = 120_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      throw new Error('Suggestion timeout must fit a positive timer interval.');
    this.#store = store; this.#provider = provider; this.#timeoutMs = timeoutMs;
  }
  start(input: SuggestionInput): SuggestionHandle {
    if (this.#closing) throw new Error('Suggestion coordinator is closing.');
    const identity = { ...input.context.identity }, key = identityKey(identity);
    if (this.#active.has(key)) throw new Error('A suggestion invocation is still active for this plan.');
    const previousPlan = this.#store.getPlan(identity), snapshot = this.#store.getSnapshot(identity);
    if (previousPlan.revision !== input.revision) throw new Error('Stale plan revision.');
    if (snapshot.base !== input.repo.baseSha) throw new Error('Stale base snapshot.');
    // Validate before allocating a durable request; no await permits local state changes.
    const prepared = prepareSuggestions({ ...input, requestId: 'pending', previousPlan });
    const id = this.#store.beginSuggestions(identity, input.revision);
    const request = Object.freeze({ ...prepared.request, requestId: id });
    const controller = new AbortController();
    let stopped: { state: 'failed' | 'cancelled'; reason: string } | undefined;
    const cancellation = () => stopped;
    let settled = false;
    const stop = (state: 'failed' | 'cancelled', reason: string) => {
      if (stopped || settled) return;
      stopped = { state, reason };
      // Even if storage fails, deliver cancellation to the invocation and retain its slot.
      try { this.#store.cancelSuggestions(identity, id); }
      catch (error) { stopped.reason += ` Request cleanup failed: ${String(error)}`; }
      finally { controller.abort(new Error(reason)); }
    };
    const timer = setTimeout(() => stop('failed', 'Suggestion invocation timed out.'), this.#timeoutMs);
    let finish!: (result: SuggestionOutcome) => void;
    const result = new Promise<SuggestionOutcome>(resolve => { finish = resolve; });
    const handle: SuggestionHandle = Object.freeze({ id, result,
      cancel: (reason = 'Suggestion cancelled by user.') => stop('cancelled', reason) });
    this.#active.set(key, { handle, stop });
    // Defer invocation until the handle owns its slot, including synchronous provider errors.
    void Promise.resolve().then(async () => {
      let outcome: SuggestionOutcome;
      try {
        if (stopped) outcome = { id, ...stopped };
        else {
          const source = await this.#provider.invoke(request, controller.signal);
          const afterInvocation = cancellation();
          if (afterInvocation) outcome = { id, ...afterInvocation };
          else {
            const current = this.#store.getSuggestions(identity, id);
            if (this.#store.getPlan(identity).revision !== request.revision ||
                this.#store.getSnapshot(identity).id !== snapshot.id || current.state === 'invalidated') {
              outcome = { id, state: 'stale', reason: 'Plan revision or snapshot changed during authoring.' };
            } else if (current.state !== 'pending') {
              outcome = { id, state: current.state === 'cancelled' ? 'cancelled' : 'stale', reason: `Suggestion request is ${current.state}.` };
            } else {
              const validated = prepared.validate(source);
              this.#store.completeSuggestions(identity, id, validated.value);
              outcome = { id, state: 'completed', warnings: validated.warnings };
            }
          }
        }
      } catch (error) {
        outcome = { id, ...(stopped ?? { state: 'failed' as const, reason: error instanceof Error ? error.message : String(error) }) };
      }
      if (outcome.state !== 'completed') {
        try { this.#store.cancelSuggestions(identity, id); }
        catch (error) {
          // Keep the original provider/timeout reason, but surface cleanup failure too.
          outcome = { ...outcome, reason: `${outcome.reason} Request cleanup failed: ${String(error)}` };
        }
      }
      clearTimeout(timer);
      settled = true;
      this.#active.delete(key);
      finish(outcome);
    });
    return handle;
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const active = [...this.#active.values()];
    this.#closePromise = Promise.all(active.map(job => job.handle.result)).then(() => undefined);
    for (const job of active) job.stop('cancelled', 'Suggestion coordinator is closing.');
    return this.#closePromise;
  }
}

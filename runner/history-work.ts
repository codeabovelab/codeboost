import { readHistory } from '../git/history.ts';
import { linkHistory, type History, type Segment } from '../core/linking.ts';
import { pathKeyFor } from '../core/path-identity.ts';
import type { HistoryJob } from './history-job.ts';

/**
 * The work of one history job, as its worker runs it: the history read, then linking, within the job's one budget,
 * counted from now on this thread's monotonic clock. Each stage gets what the budget leaves (at most 30 s, the stages'
 * own ceiling), so a slow read leaves linking less. `signal` kills the running Git process.
 */
export async function runHistoryWork(job: HistoryJob, signal: AbortSignal, now: () => number = () => performance.now()): Promise<{ history: History; segments: Segment[] | null }> {
  const deadline = now() + job.budgetMs;
  const remaining = (what: string) => {
    const ms = deadline - now();
    if (ms <= 0) throw new Error(`${what} exceeded its overall deadline.`);
    return Math.min(30_000, Math.max(1, Math.ceil(ms)));
  };
  const history = await readHistory(job.repository, job.base, job.head, { ...job.limits, maxDurationMs: remaining('History read') }, signal);
  if (!job.link) return { history, segments: null };
  signal.throwIfAborted();
  const segments = linkHistory(job.link.plan, history, new Map(job.link.ownership), pathKeyFor(job.link.pathIdentity),
    { maxDurationMs: remaining('Review load') }, new Set(job.link.resolvedConflicts));
  return { history, segments };
}

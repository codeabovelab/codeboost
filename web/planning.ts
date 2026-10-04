import { GhIssueGateway, type IssueText } from '../github/issues.ts';
import { PlanningAgent } from '../runner/planning.ts';
import type { ReviewConfig, ReviewService } from '../runner/review.ts';
import type { PlanningSetup } from './server.ts';

/** Bounds the GitHub read of the issue before a suggestion request starts. */
export const ISSUE_READ_TIMEOUT_MS = 30_000;

/**
 * Production planning (#117): on for a review with a github block, never in a demo. It needs no runner block, since
 * planning only reads code, as Ask does. The issue text is read from GitHub for each request (collaborators' comments
 * only, bounded like an execute prompt's); approved lessons stay empty until lessons exist (L1 to L4).
 */
export function productionPlanning(config: ReviewConfig, options: {
  issues?: { issueText(number: number, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<IssueText> };
  agent?: (service: ReviewService) => PlanningAgent;
} = {}): PlanningSetup | undefined {
  const github = config.github;
  if (config.demo || !github) return undefined;
  const issues = options.issues ?? new GhIssueGateway(github.repository);
  return service => {
    const provider = options.agent?.(service) ?? new PlanningAgent(service);
    return {
      provider,
      async describe(signal) {
        const text = await issues.issueText(github.issue, { signal, timeoutMs: ISSUE_READ_TIMEOUT_MS });
        // No base branch name is configured yet, so the base is named by its commit.
        const base = service.store.getSnapshot(config.identity).base;
        return { issue: { number: text.number, title: text.title, body: text.body, comments: [...text.comments] },
          approvedLessons: [], repo: { name: github.repository, baseRef: base } };
      },
      close: () => provider.close(),
    };
  };
}

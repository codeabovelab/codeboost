import { GhIssueGateway, ISSUE_READ_TIMEOUT_MS, withIssueReadDeadline, type IssueTrustGateway } from '../github/issues.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { PlanningAgent } from '../runner/planning.ts';
import type { ReviewConfig, ReviewService } from '../runner/review.ts';
import type { PlanningSetup } from './server.ts';

export { ISSUE_READ_TIMEOUT_MS } from '../github/issues.ts';

/**
 * Production planning (#117): on for a review with a github block, never in a demo. It needs no runner block, since
 * planning only reads code, as Ask does. The issue text is read from GitHub for each request (current collaborators'
 * comments, or every comment under explicit author-bound trust), bounded like an execute prompt; approved lessons stay
 * empty until lessons exist (L1 to L4).
 */
export function productionPlanning(config: ReviewConfig, options: {
  /** The single-runner lock's check that the database path still names the locked file (runner/recovery.ts). */
  verifyLock: () => void;
  issues?: Pick<IssueTrustGateway, 'issueAccess' | 'issueText'>;
  agent?: (service: ReviewService) => PlanningAgent;
}): PlanningSetup | undefined {
  const github = config.github;
  if (config.demo || !github) return undefined;
  const issues = options.issues ?? new GhIssueGateway(github.repository);
  return service => {
    // Runs after the Store opens and before the server listens. A request still pending belonged to a process that
    // ended (its provider ran in that process's planning worker), so nothing can complete it: fail it (#124). Only under
    // a lock verified to name this database, so a live process's requests are never touched.
    options.verifyLock();
    service.store.settleInterruptedRequests();
    const provider = options.agent?.(service) ?? new PlanningAgent(service);
    return {
      provider,
      describe(signal) { return withIssueReadDeadline(signal, async (readSignal, timeoutMs) => {
        const access = await issues.issueAccess(github.issue, { signal: readSignal, timeoutMs });
        const trust = service.store.issueTrust(github.repository, github.issue);
        const explicitlyTrusted = trust?.revokedAt === null && trust.authorLogin === access.authorLogin;
        if (!access.collaborator && !explicitlyTrusted) throw new GuardRefusal(`Issue #${github.issue} is not trusted for its current author.`);
        const validate = () => {
          if (!explicitlyTrusted) return;
          const current = service.store.issueTrust(github.repository, github.issue);
          if (!current || current.revokedAt !== null || current.authorLogin !== access.authorLogin)
            throw new GuardRefusal(`Issue #${github.issue} is not trusted for its current author.`);
        };
        const text = await issues.issueText(github.issue, { signal: readSignal, timeoutMs,
          trustedAuthor: explicitlyTrusted ? access.authorLogin : undefined, expectedAccess: access });
        validate();
        // The configured base branch (#103), or the base commit when none (or an empty one) is configured.
        const baseRef = github.baseBranch || service.store.getSnapshot(config.identity).base;
        return { issue: { number: text.number, title: text.title, body: text.body, comments: [...text.comments] },
          approvedLessons: [], repo: { name: github.repository, baseRef }, validate };
      }); },
      close: () => provider.close(),
    };
  };
}

import { GhIssueGateway, ISSUE_READ_TIMEOUT_MS, withIssueReadDeadline, type IssueTrustGateway } from '../github/issues.ts';
import { GuardRefusal } from '../runner/lifecycle.ts';
import { PLANNING_UNAVAILABLE, PlanningAgent, PlanningCheck } from '../runner/planning.ts';
import type { ReviewConfig, ReviewService } from '../runner/review.ts';
import type { PlanningSetup } from './server.ts';

export { ISSUE_READ_TIMEOUT_MS } from '../github/issues.ts';

/**
 * Production planning (#117): on for a review with a github block, never in a demo. It needs no runner block, since
 * planning only reads code, as Ask does. The issue text is read from GitHub for each request (current collaborators'
 * comments, or every comment under explicit author-bound trust), bounded like an execute prompt; approved lessons stay
 * empty until lessons exist (L1 to L4). The planning check (#164) starts with the server for the vendor chosen in
 * Settings (or, with none chosen then, with the first request after one is), and must pass before a request reads the
 * issue or records anything; a failed check refuses the request with its reason.
 */
export function productionPlanning(config: ReviewConfig, options: {
  /** The single-runner lock's check that the database path still names the locked file (runner/recovery.ts). */
  verifyLock: () => void;
  issues?: Pick<IssueTrustGateway, 'issueAccess' | 'issueText'>;
  agent?: (service: ReviewService) => PlanningAgent;
  /** How long a failed planning check refuses requests; `PLANNING_RECHECK_MS` by default. */
  recheckMs?: number;
  /** How long a request waits for a running check; `PLANNING_ADMIT_WAIT_MS` by default. */
  admitWaitMs?: number;
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
    // Started now, before the server listens. If startup fails after this, the CLI exits (web/cli.ts), and the next start's
    // planning recovery removes what the check left (its objects carry planning's owner). Another caller of startServer
    // is left with the check running: startServer does not close planning when a later startup step fails (#198).
    const check = new PlanningCheck((vendor, signal) => provider.probe(vendor, signal), () => service.store.questionProvider(),
      { recheckMs: options.recheckMs, waitMs: options.admitWaitMs });
    check.start();
    return {
      // Checked once more when the provider is invoked, as defence in depth: E3 invokes it in a microtask right after the
      // recorded action, where Settings cannot change, but a later caller might not. A refusal here settles the request as
      // failed.
      provider: { async invoke(request, signal) { check.assertPassed(); return provider.invoke(request, signal); } },
      async describe(signal) {
        // Only refusals leave the wait: anything else (an aborted request, a Store that cannot be read) would be recorded
        // by the server as a failed GitHub read, which this wait is not.
        try { await check.admit(signal); }
        catch (error) {
          if (error instanceof GuardRefusal) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          throw new GuardRefusal(error === signal.reason ? `${PLANNING_UNAVAILABLE} codeboost stopped waiting for the planning check: ${reason}`
            : `${PLANNING_UNAVAILABLE} codeboost could not check the planning agent: ${reason}`);
        }
        return withIssueReadDeadline(signal, async (readSignal, timeoutMs) => {
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
          // Run again just before the request starts: Settings may have chosen an unchecked vendor during the read.
          const admitted = () => { validate(); check.assertPassed(); };
          return { issue: { number: text.number, title: text.title, body: text.body, comments: [...text.comments] },
            approvedLessons: [], repo: { name: github.repository, baseRef }, validate: admitted };
        });
      },
      // The check runs in the provider's worker, so it stops before the worker does.
      close: async () => { await check.close(); await provider.close(); },
    };
  };
}

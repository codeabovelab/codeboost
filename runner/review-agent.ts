import type { InvocationInput, InvocationResult, StopReason } from '../agents/contract.ts';
import { PLANNING_MAX_TURNS } from '../agents/policy.ts';
import type { ReviewRequest } from '../core/review-prompt.ts';
import { PLANNING_STORAGE, removeFeatureRoot, structuredOutput } from './planning-provider.ts';
import { exceedsStorage, type Provider, type ReadOnlyFeature, type ReadOnlyRun, type RepositorySize } from './question-container.ts';

/**
 * The review agent (#201): one read-only Claude invocation per review round, in lane D's "review" phase (read, list
 * and search only; no commands) with vendor-only egress. The answer schema is the only file in the input mount; D
 * passes it to Claude as `--json-schema` and returns Claude's `structured_output` as JSON text, which is still
 * unvalidated: `prepareReview(...).validate` decides whether it is a list of problems.
 */
const stopMessages: Record<StopReason, string> = {
  cancelled: 'Review agent cancelled.', timeout: 'Review agent timed out.', shutdown: 'Server stopped during the review.',
  'output-limit': 'Review agent output exceeded its limit.', 'capture-failure': 'Review agent output could not be captured.',
};
/** Accept only this exact invocation's output, and only after a clean exit. The text is still unvalidated. */
export function reviewOutput(result: InvocationResult, invocation: InvocationInput): string {
  // A review shares planning's turn limit (#163).
  return structuredOutput(result, invocation, { agent: 'review agent', stops: stopMessages, failed: 'Claude could not review the plan items.',
    turnLimit: `The review stopped at its ${PLANNING_MAX_TURNS}-turn limit before Claude answered. Split the plan into smaller items, or review the task yourself.` });
}

/** Codex reads files only through its shell, and the review phase runs none (#93). */
export const CODEX_REVIEW_REFUSED = 'Codex cannot review plan items yet: it can read the code only by running commands, '
  + 'and the review runs none. Choose Claude Code in Settings, then retry.';
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const ROOT_PREFIX = 'codeboost-review-agent-';
/** Delete a review root: a direct child of the temporary directory named with the review's prefix, and nothing else. */
export function removeReviewRoot(root: string): void { removeFeatureRoot(root, ROOT_PREFIX, 'reviewed', 'review'); }
/**
 * A review as a read-only run outside the runner, for the recording script and the Docker probe. The review reads the
 * code and writes nothing, so it has planning's storage ceilings.
 */
export const REVIEW_FEATURE: ReadOnlyFeature = Object.freeze({
  phase: 'review', rootPrefix: ROOT_PREFIX, removeRoot: removeReviewRoot, storage: PLANNING_STORAGE,
  credential: (provider: Provider, env: Parameters<ReadOnlyFeature['credential']>[1]) => {
    if (provider === 'codex') throw new Error(CODEX_REVIEW_REFUSED);
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('Reviewing with Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Create one with `claude setup-token`.');
    return token;
  },
  timedOut: stopMessages.timeout,
  assertFits: (size: RepositorySize) => {
    if (exceedsStorage(size, PLANNING_STORAGE)) throw new Error('The repository is too large for the review.');
  },
  output: (_vendor: Provider, result: InvocationResult, invocation: InvocationInput) => reviewOutput(result, invocation),
  cleanupFailed: (failures: readonly unknown[], failure?: { error: unknown }) => failure
    ? new AggregateError([failure.error, ...failures], `${text(failure.error)} Cleanup also did not settle: ${failures.map(text).join('; ')}`)
    : new AggregateError(failures, 'Review container cleanup did not settle.'),
});

/** One review request as a read-only run of `repository` at the request's head, without its owner. */
export function reviewRun(request: ReviewRequest, source: { vendor: Provider; repository: string; snapshotId: string },
  deadline: number): Omit<ReadOnlyRun, 'runnerOwner'> {
  if (request.phase !== 'review' || request.access !== 'read-only') throw new Error('Review requests must be read-only.');
  return { provider: source.vendor, repository: source.repository, head: request.head, attemptId: request.attemptId,
    taskId: `review-${request.attemptId}`, deadline, prompt: request.prompt, schemaText: request.schemaText,
    context: { snapshotId: source.snapshotId, planId: request.identity.planId, planRevision: request.revision,
      assignmentId: `review-round-${request.round}`, referencedCodeHash: request.head, stateVersion: 0 } };
}

/**
 * Ownership labels on every Docker object lane D creates (#51 item 3). They let a runner find, after a crash, only the
 * resources of its own database (`io.codeboost.runner`), and map each one back to an attempt and an allocation that the
 * caller recorded before it asked D to allocate anything.
 */
export const RUNNER_LABEL = 'io.codeboost.runner';
export const ATTEMPT_LABEL = 'io.codeboost.attempt';
export const ALLOCATION_LABEL = 'io.codeboost.allocation';

/** Who owns an allocation: the database's runner token, the attempt, and the caller-chosen allocation ID. */
export interface ResourceOwner {
  /** 32 lowercase hex characters, created once per database by the runner. */
  readonly runnerOwner: string;
  readonly attemptId: string;
  /** A lowercase UUID v4 the caller records before the allocation starts. */
  readonly allocationId: string;
}

const RUNNER_OWNER = /^[0-9a-f]{32}$/;
const ALLOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Attempt IDs are UUIDs in the runner; any short printable value is accepted so other callers keep their own IDs.
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const isRunnerOwner = (value: unknown): value is string => typeof value === 'string' && RUNNER_OWNER.test(value);
/** Whether an attempt ID can be written as an ownership label. */
export const isLabelAttemptId = (value: unknown): value is string => typeof value === 'string' && ATTEMPT_ID.test(value);

/** Validate an owner before it is written into labels; returns a frozen copy. */
export function assertResourceOwner(owner: ResourceOwner): ResourceOwner {
  if (!owner || !isRunnerOwner(owner.runnerOwner)) throw new Error('runnerOwner must be 32 lowercase hex characters.');
  if (!isLabelAttemptId(owner.attemptId))
    throw new Error('attemptId cannot be written as an ownership label.');
  if (typeof owner.allocationId !== 'string' || !ALLOCATION_ID.test(owner.allocationId))
    throw new Error('allocationId must be a lowercase UUID v4 chosen by the caller.');
  return Object.freeze({ runnerOwner: owner.runnerOwner, attemptId: owner.attemptId, allocationId: owner.allocationId });
}

// Allocation IDs claimed by any allocator in this process. Recovery groups resources by allocation, so one ID must
// never name two allocations, whether two task storages or a task storage and a vendor network.
const claimedAllocations = new Set<string>();
/** Claim an allocation ID for one allocation. Refuses a reused ID; a claim is kept even if the allocation fails. */
export function claimAllocationId(allocationId: string): string {
  if (claimedAllocations.has(allocationId))
    throw new Error('allocationId was already used; every allocation needs a new allocation ID.');
  claimedAllocations.add(allocationId);
  return allocationId;
}

/** `docker create`/`run`/`volume create`/`network create` arguments that apply the owner labels. */
export const ownerLabelArgs = (owner: ResourceOwner): readonly string[] => Object.freeze([
  '--label', `${RUNNER_LABEL}=${owner.runnerOwner}`,
  '--label', `${ATTEMPT_LABEL}=${owner.attemptId}`,
  '--label', `${ALLOCATION_LABEL}=${owner.allocationId}`,
]);

/** Whether inspected labels carry exactly this owner. */
export const hasOwnerLabels = (labels: Readonly<Record<string, string>> | null | undefined, owner: ResourceOwner) =>
  labels?.[RUNNER_LABEL] === owner.runnerOwner && labels?.[ATTEMPT_LABEL] === owner.attemptId
  && labels?.[ALLOCATION_LABEL] === owner.allocationId;

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
/** Whether a value is an allocation ID as D writes it: a lowercase UUID v4. */
export const isAllocationId = (value: unknown): value is string => typeof value === 'string' && ALLOCATION_ID.test(value);
/** Whether an attempt ID can be written as an ownership label. */
export const isLabelAttemptId = (value: unknown): value is string => typeof value === 'string' && ATTEMPT_ID.test(value);

/** Validate an owner before it is written into labels; returns a frozen copy. */
export function assertResourceOwner(owner: ResourceOwner): ResourceOwner {
  if (!owner || !isRunnerOwner(owner.runnerOwner)) throw new Error('runnerOwner must be 32 lowercase hex characters.');
  if (!isLabelAttemptId(owner.attemptId))
    throw new Error('attemptId cannot be written as an ownership label.');
  if (!isAllocationId(owner.allocationId))
    throw new Error('allocationId must be a lowercase UUID v4 chosen by the caller.');
  return Object.freeze({ runnerOwner: owner.runnerOwner, attemptId: owner.attemptId, allocationId: owner.allocationId });
}

// One ID must never name two live allocations, whether two task storages or a task storage and a vendor network.
// Uniqueness is the caller's duty (a fresh UUID v4 per allocation); D catches mistakes with three checks: this set
// covers allocations in progress in this process (their objects may not exist yet), `allocationListCommands` before
// the first create covers every earlier process, and the same list right after the first create catches a concurrent
// process that passed the first check too (whichever checks second backs out). A rival that backs out but cannot
// remove its object leaves it labelled with its own attempt, and recovery matches runner, attempt and allocation
// together, so it is reported as unowned rather than merged. An entry is released once its allocation finished
// cleanly, so the set stays bounded.
const claimedAllocations = new Set<string>();
/** Claim an allocation ID for an allocation that is starting. Refuses an ID another allocation here holds. */
export function claimAllocationId(allocationId: string): string {
  if (claimedAllocations.has(allocationId))
    throw new Error('allocationId was already used; every allocation needs a new allocation ID.');
  claimedAllocations.add(allocationId);
  return allocationId;
}
/**
 * Release a claim once the allocation succeeded or its failure cleanup settled: from then on its objects (if any) are
 * found by the daemon check. Keep the claim when cleanup did not settle, since a killed create may still land.
 */
export function releaseAllocationId(allocationId: string): void { claimedAllocations.delete(allocationId); }
/** Docker commands that list any container, volume or network still labelled with this allocation ID. */
export const allocationListCommands = (allocationId: string): readonly (readonly string[])[] => {
  const filter = ['--quiet', '--filter', `label=${ALLOCATION_LABEL}=${allocationId}`];
  return Object.freeze([
    Object.freeze(['ps', '--all', ...filter]),
    Object.freeze(['volume', 'ls', ...filter]),
    Object.freeze(['network', 'ls', ...filter]),
  ]);
};
export const ALLOCATION_IN_USE = 'allocationId still labels a Docker object; every allocation needs a new allocation ID.';

/** `docker create`/`run`/`volume create`/`network create` arguments that apply the owner labels. */
export const ownerLabelArgs = (owner: ResourceOwner): readonly string[] => Object.freeze([
  '--label', `${RUNNER_LABEL}=${owner.runnerOwner}`,
  '--label', `${ATTEMPT_LABEL}=${owner.attemptId}`,
  '--label', `${ALLOCATION_LABEL}=${owner.allocationId}`,
]);

/** The owner as a label map, for reporting a resource whose removal is not confirmed. */
export const ownerLabels = (owner: ResourceOwner): Readonly<Record<string, string>> => Object.freeze({
  [RUNNER_LABEL]: owner.runnerOwner, [ATTEMPT_LABEL]: owner.attemptId, [ALLOCATION_LABEL]: owner.allocationId,
});

/** Whether inspected labels carry exactly this owner. */
export const hasOwnerLabels = (labels: Readonly<Record<string, string>> | null | undefined, owner: ResourceOwner) =>
  labels?.[RUNNER_LABEL] === owner.runnerOwner && labels?.[ATTEMPT_LABEL] === owner.attemptId
  && labels?.[ALLOCATION_LABEL] === owner.allocationId;

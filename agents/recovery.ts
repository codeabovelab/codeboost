import { DOCKER_ID } from './client-outcome.ts';
import { runDocker, type DockerOutcome } from './docker.ts';
import { ALLOCATION_LABEL, ATTEMPT_LABEL, isAllocationId, isLabelAttemptId, isRunnerOwner,
  RUNNER_LABEL } from './labels.ts';
import { adoptRecoveredTaskStorage, hasLiveTaskStorage, RecoveredStorageRejected, type RecoveredTaskStorage,
  type TaskStorageParts } from './container/storage.ts';

/** A Docker object recovery found, with the labels it carries. */
export interface RecoveredResource {
  readonly kind: 'container' | 'network' | 'volume';
  readonly name: string;
  /** Full Docker ID; absent for volumes, whose name is their identity. */
  readonly id?: string;
  readonly labels: Readonly<Record<string, string>>;
}
/**
 * A codeboost object recovery leaves alone:
 * - `no-runner-label`: from a build before runner labels (#51 item 3). No codeboost code removes it, since an older
 *   runner that takes no lock this build can see may still own it.
 * - `unknown-kind`: carries this runner's label but is not an object D creates.
 * - `inconsistent-storage`: task storage whose parts disagree on the attempt, or repeat a part.
 */
export interface UnownedResource extends RecoveredResource {
  readonly reason: 'no-runner-label' | 'unknown-kind' | 'inconsistent-storage';
}
export interface RecoveryReport {
  /**
   * Agent containers, egress proxies, seeders, export, inspection and commit containers and networks of this runner,
   * now confirmed gone.
   */
  readonly removed: readonly RecoveredResource[];
  /** One handle per task-storage allocation of this runner, kept whole for export and `removeTaskFilesystems`. */
  readonly storage: readonly RecoveredTaskStorage[];
  readonly unowned: readonly UnownedResource[];
}
/** Recovery could not confirm every removal. Nothing was adopted; running it again retries the rest. */
export class RecoveryError extends AggregateError {
  /** The objects this run did confirm removed before it gave up. */
  readonly removed: readonly RecoveredResource[];
  constructor(failures: unknown[], message: string, removed: readonly RecoveredResource[]) {
    super(failures, message);
    this.removed = Object.freeze([...removed]);
  }
}

const INVOCATION_LABEL = 'io.codeboost.invocation';
const EGRESS_LABEL = 'io.codeboost.egress';
const STORAGE_LABEL = 'io.codeboost.task-storage';
// Every label a codeboost object of any build carries at least one of; used to find objects without a runner label.
// Each Docker type is scanned for all of them, so an object with a label D never puts on its type is still found.
const KIND_LABELS = [INVOCATION_LABEL, EGRESS_LABEL, STORAGE_LABEL, ALLOCATION_LABEL] as const;
const DIAGNOSTIC_LIMIT = 1_000;
// Objects per `docker inspect`, so a daemon with many codeboost objects cannot exceed the argument-size limit.
const INSPECT_BATCH = 200;

const deadline = (timeoutMs: number) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Recovery deadline must be a positive integer.');
  const end = performance.now() + timeoutMs;
  return () => {
    const value = Math.ceil(end - performance.now());
    if (value <= 0) throw new Error('Recovery exceeded its overall deadline.');
    return value;
  };
};
const absent = (result: DockerOutcome) => result.status !== 0 && result.status !== null && !result.error
  && /(?:No such (?:object|container|network|volume)|network .* not found)/i.test(`${result.stdout}\n${result.stderr}`);

type Kind = RecoveredResource['kind'];
const listArgs = (kind: Kind, filter: string): string[] => kind === 'container'
  ? ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${filter}`]
  : kind === 'volume' ? ['volume', 'ls', '--quiet', '--filter', `label=${filter}`]
    : ['network', 'ls', '--quiet', '--no-trunc', '--filter', `label=${filter}`];

// Fails closed: an unanswered list or inspect cannot show what exists.
const list = async (kind: Kind, filter: string, remaining: () => number) => {
  const result = await runDocker(listArgs(kind, filter), { timeoutMs: remaining() });
  if (result.status !== 0) throw new Error(`Recovery could not list ${kind}s.`);
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
};
const inspect = async (kind: Kind, refs: readonly string[], remaining: () => number): Promise<RecoveredResource[]> => {
  const found: RecoveredResource[] = [];
  for (let start = 0; start < refs.length; start += INSPECT_BATCH)
    found.push(...await inspectBatch(kind, refs.slice(start, start + INSPECT_BATCH), remaining));
  return found;
};
type Inspected = { Id?: string; Name?: string; Labels?: Record<string, string> | null;
  Config?: { Labels?: Record<string, string> | null } };
// The daemon-wide scans list other runners' objects too, and those can be removed between the list and the inspect.
// A batch that fails is inspected one object at a time: an object Docker confirms is gone is skipped, and any other
// failure still fails closed.
const inspectBatch = async (kind: Kind, refs: readonly string[], remaining: () => number) => {
  const result = await runDocker([kind, 'inspect', ...refs], { timeoutMs: remaining() });
  let objects: Inspected[];
  if (result.status === 0) objects = JSON.parse(result.stdout || '[]') as Inspected[];
  else {
    objects = [];
    for (const ref of refs) {
      const single = await runDocker([kind, 'inspect', ref], { timeoutMs: remaining() });
      if (single.status === 0) objects.push(...JSON.parse(single.stdout || '[]') as Inspected[]);
      else if (!absent(single)) throw new Error(`Recovery could not inspect ${kind}s; run it again.`);
    }
  }
  return objects.map(object => {
    // Containers and networks are removed by ID, so a missing or short one fails closed.
    const id = kind === 'volume' ? undefined : object.Id;
    if (kind !== 'volume' && (typeof id !== 'string' || !DOCKER_ID.test(id)))
      throw new Error(`Recovery found a ${kind} without a full ID.`);
    return Object.freeze({ kind, name: String(object.Name ?? '').replace(/^\//, ''), ...(id ? { id } : {}),
      labels: Object.freeze({ ...(object.Labels ?? object.Config?.Labels ?? {}) }) });
  });
};
const unique = (values: readonly string[]) => [...new Set(values)];

// Remove one object by its full ID, and confirm it is gone.
const removeById = async (resource: RecoveredResource, remaining: () => number) => {
  const args = resource.kind === 'network' ? ['network', 'rm', resource.id!] : ['rm', '--force', resource.id!];
  const result = await runDocker(args, { timeoutMs: remaining() });
  if (result.status === 0) return;
  if (!absent(await runDocker([resource.kind, 'inspect', resource.id!], { timeoutMs: remaining() })))
    throw new Error(`Could not remove ${resource.kind} ${resource.name}: ${(result.error?.message ?? result.stderr).trim()}`);
};

/**
 * Crash recovery for one database (#51 item 4). Acts only on objects whose `io.codeboost.runner` label is
 * `runnerOwner`: it removes agent containers, egress proxies, seeders, export, inspection and commit containers and
 * networks, and resolves only once they are gone. It keeps task storage whole (volumes and keeper) and returns a recovery handle per
 * allocation. Objects from older builds without a runner label, and anything it does not recognise, are reported and
 * never touched.
 *
 * Call it only while holding the database's single-runner lock and before admitting work: it removes every agent
 * container of this runner. It refuses to run while this process holds task storage of the runner, which every agent
 * mounts, but cannot see other processes; the lock is what excludes them.
 *
 * Treat any rejection as "recovery did not finish": do not admit work, and run it again. It rejects with a
 * `RecoveryError` (message bounded to about 1 KB, plus `removed`) when a removal is not confirmed, and with a plain
 * `Error` when it refuses to run (a malformed token, or live storage of this runner here), when a list or inspect
 * fails, when a storage check cannot reach Docker, or when the deadline runs out. A rejection returns no handles.
 */
export async function recoverLeftovers(runnerOwner: string, timeoutMs = 120_000): Promise<RecoveryReport> {
  if (!isRunnerOwner(runnerOwner)) throw new Error('runnerOwner must be 32 lowercase hex characters.');
  // Every agent mounts task storage, so a runner with live storage here may have live agents recovery would remove.
  if (hasLiveTaskStorage(runnerOwner))
    throw new Error('This process still holds task storage of this runner; recovery runs only before admitting work.');
  const remaining = deadline(timeoutMs);
  const owned = { container: [] as RecoveredResource[], volume: [] as RecoveredResource[],
    network: [] as RecoveredResource[] };
  const unowned: UnownedResource[] = [];
  for (const kind of ['container', 'volume', 'network'] as const) {
    owned[kind] = await inspect(kind, await list(kind, `${RUNNER_LABEL}=${runnerOwner}`, remaining), remaining);
    // Docker cannot filter on a missing label, so list every codeboost object of this kind and keep those without one.
    const candidates = unique((await Promise.all(KIND_LABELS.map(label => list(kind, label, remaining)))).flat());
    for (const resource of await inspect(kind, candidates, remaining))
      if (!(RUNNER_LABEL in resource.labels)) unowned.push(Object.freeze({ ...resource, reason: 'no-runner-label' }));
  }

  const remove: RecoveredResource[] = [];
  const storage = new Map<string, { attemptId?: string; parts: Record<string, string>; resources: RecoveredResource[];
    consistent: boolean; keeperId?: string }>();
  const keep = (resource: RecoveredResource, part: keyof TaskStorageParts) => {
    const allocationId = resource.labels[ALLOCATION_LABEL] ?? '', attemptId = resource.labels[ATTEMPT_LABEL];
    const group = storage.get(allocationId) ?? { attemptId, parts: {}, resources: [], consistent: true };
    if (group.attemptId !== attemptId || part in group.parts) group.consistent = false;
    group.parts[part] = resource.name;
    // The keeper's ID from this scan: adoption checks that same object, not whatever holds the name by then.
    if (part === 'keeper') group.keeperId = resource.id;
    group.resources.push(resource);
    storage.set(allocationId, group);
  };
  // D writes exactly one kind label on each object, with complete owner labels (an egress object's egress label is its
  // allocation ID). Recovery has no creation-time ID to prove ownership, so any other combination is not D's and is
  // left alone.
  const kindOf = (resource: RecoveredResource) => {
    const labels = resource.labels;
    if (!isLabelAttemptId(labels[ATTEMPT_LABEL]) || !isAllocationId(labels[ALLOCATION_LABEL])) return undefined;
    const present = [INVOCATION_LABEL, EGRESS_LABEL, STORAGE_LABEL].filter(label => label in labels);
    if (present.length !== 1) return undefined;
    const label = present[0]!;
    if (label === STORAGE_LABEL) return `storage:${labels[STORAGE_LABEL]}`;
    // The invocation label is a UUID v4 D generates per profile, the same form as an allocation ID.
    if (label === INVOCATION_LABEL) return isAllocationId(labels[INVOCATION_LABEL]) ? 'agent' : undefined;
    return labels[EGRESS_LABEL] === labels[ALLOCATION_LABEL] ? 'egress' : undefined;
  };
  const unknown = (resource: RecoveredResource) => unowned.push(Object.freeze({ ...resource, reason: 'unknown-kind' }));
  for (const resource of owned.container) {
    const kind = kindOf(resource);
    if (kind === 'storage:keeper') keep(resource, 'keeper');
    // Seeders, export, inspection and commit containers are transient: a leftover one is removed, never kept with the
    // storage.
    else if (kind === 'storage:seeder' || kind === 'storage:export' || kind === 'storage:inspect' || kind === 'storage:commit'
      || kind === 'agent' || kind === 'egress')
      remove.push(resource);
    else unknown(resource);
  }
  for (const resource of owned.volume) {
    const kind = kindOf(resource);
    if (kind === 'storage:work') keep(resource, 'workVolume');
    else if (kind === 'storage:metadata') keep(resource, 'metadataVolume');
    else unknown(resource);
  }
  const networks = owned.network.filter(resource => {
    if (kindOf(resource) === 'egress') return true;
    unknown(resource);
    return false;
  });

  // Containers first: a network cannot be removed while an agent or proxy is still attached to it.
  const failures: unknown[] = [], confirmed: RecoveredResource[] = [];
  for (const resource of [...remove, ...networks]) {
    if (resource.kind === 'network' && failures.length) break;
    try {
      await removeById(resource, remaining);
      confirmed.push(resource);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const detail = failures.map(error => (error as Error).message).join('; ');
    throw new RecoveryError(failures, `Recovery could not remove ${failures.length} resource(s): `
      + (detail.length > DIAGNOSTIC_LIMIT ? `${detail.slice(0, DIAGNOSTIC_LIMIT)}…` : detail), confirmed);
  }

  const handles: RecoveredTaskStorage[] = [];
  for (const [allocationId, group] of storage) {
    if (!group.consistent || !group.attemptId) {
      for (const resource of group.resources) unowned.push(Object.freeze({ ...resource, reason: 'inconsistent-storage' }));
      continue;
    }
    // Adoption re-checks every part's labels and the owner's format. A group the daemon shows is not D's is reported,
    // not adopted; a failed or timed-out inspect is not evidence either way, so it fails recovery closed.
    const budget = remaining();
    try {
      handles.push(await adoptRecoveredTaskStorage({ runnerOwner, attemptId: group.attemptId, allocationId },
        group.parts, budget, group.keeperId));
    } catch (error) {
      if (!(error instanceof RecoveredStorageRejected)) throw error;
      for (const resource of group.resources) unowned.push(Object.freeze({ ...resource, reason: 'inconsistent-storage' }));
    }
  }
  return Object.freeze({ removed: Object.freeze([...remove, ...networks]), storage: Object.freeze(handles),
    unowned: Object.freeze(unowned) });
}

import { DOCKER_ID } from './client-outcome.ts';
import { runDocker, type DockerOutcome } from './docker.ts';
import { ALLOCATION_LABEL, ATTEMPT_LABEL, isRunnerOwner, RUNNER_LABEL } from './labels.ts';
import { adoptRecoveredTaskStorage, type RecoveredTaskStorage, type TaskStorageParts } from './container/storage.ts';

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
  /** Agent containers, egress proxies, seeders and networks of this runner, now confirmed gone. */
  readonly removed: readonly RecoveredResource[];
  /** One handle per task-storage allocation of this runner, kept whole for export and `removeTaskFilesystems`. */
  readonly storage: readonly RecoveredTaskStorage[];
  readonly unowned: readonly UnownedResource[];
}
/** Recovery could not confirm every removal. Nothing was adopted; running it again retries the rest. */
export class RecoveryError extends AggregateError {}

const INVOCATION_LABEL = 'io.codeboost.invocation';
const EGRESS_LABEL = 'io.codeboost.egress';
const STORAGE_LABEL = 'io.codeboost.task-storage';
// Every label a codeboost object of any build carries at least one of; used to find objects without a runner label.
const KIND_LABELS = {
  container: [INVOCATION_LABEL, EGRESS_LABEL, STORAGE_LABEL, ALLOCATION_LABEL],
  volume: [STORAGE_LABEL, ALLOCATION_LABEL],
  network: [EGRESS_LABEL, ALLOCATION_LABEL],
} as const;
const DIAGNOSTIC_LIMIT = 1_000;

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
  && /(?:No such (?:object|container|network)|network .* not found)/i.test(`${result.stdout}\n${result.stderr}`);

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
  if (!refs.length) return [];
  const result = await runDocker([kind, 'inspect', ...refs], { timeoutMs: remaining() });
  if (result.status !== 0) throw new Error(`Recovery could not inspect ${kind}s; run it again.`);
  const objects = JSON.parse(result.stdout || '[]') as Array<{ Id?: string; Name?: string;
    Labels?: Record<string, string> | null; Config?: { Labels?: Record<string, string> | null } }>;
  return objects.map(object => {
    const id = kind === 'volume' ? undefined : object.Id;
    if (id !== undefined && !DOCKER_ID.test(id)) throw new Error(`Recovery found a ${kind} without a full ID.`);
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
 * `runnerOwner`: it removes agent containers, egress proxies, seeders and networks, and resolves only once they are
 * gone. It keeps task storage whole (volumes and keeper) and returns a recovery handle per allocation. Objects from
 * older builds without a runner label, and anything it does not recognise, are reported and never touched.
 *
 * Call it only while holding the database's single-runner lock and before admitting work: it removes every agent
 * container of this runner, including one a live invocation of the same runner would still be using. It rejects
 * with a `RecoveryError` (message bounded to about 1 KB) when any removal is not confirmed, and then adopts nothing.
 */
export async function recoverLeftovers(runnerOwner: string, timeoutMs = 120_000): Promise<RecoveryReport> {
  if (!isRunnerOwner(runnerOwner)) throw new Error('runnerOwner must be 32 lowercase hex characters.');
  const remaining = deadline(timeoutMs);
  const owned = { container: [] as RecoveredResource[], volume: [] as RecoveredResource[],
    network: [] as RecoveredResource[] };
  const unowned: UnownedResource[] = [];
  for (const kind of ['container', 'volume', 'network'] as const) {
    owned[kind] = await inspect(kind, await list(kind, `${RUNNER_LABEL}=${runnerOwner}`, remaining), remaining);
    // Docker cannot filter on a missing label, so list every codeboost object of this kind and keep those without one.
    const candidates = unique((await Promise.all(KIND_LABELS[kind].map(label => list(kind, label, remaining)))).flat());
    for (const resource of await inspect(kind, candidates, remaining))
      if (!(RUNNER_LABEL in resource.labels)) unowned.push(Object.freeze({ ...resource, reason: 'no-runner-label' }));
  }

  const remove: RecoveredResource[] = [];
  const storage = new Map<string, { attemptId?: string; parts: Record<string, string>; resources: RecoveredResource[];
    consistent: boolean }>();
  const keep = (resource: RecoveredResource, part: keyof TaskStorageParts) => {
    const allocationId = resource.labels[ALLOCATION_LABEL] ?? '', attemptId = resource.labels[ATTEMPT_LABEL];
    const group = storage.get(allocationId) ?? { attemptId, parts: {}, resources: [], consistent: true };
    if (group.attemptId !== attemptId || part in group.parts) group.consistent = false;
    group.parts[part] = resource.name;
    group.resources.push(resource);
    storage.set(allocationId, group);
  };
  for (const resource of owned.container) {
    const storageKind = resource.labels[STORAGE_LABEL];
    if (storageKind === 'keeper') keep(resource, 'keeper');
    else if (storageKind === 'seeder' || INVOCATION_LABEL in resource.labels || EGRESS_LABEL in resource.labels)
      remove.push(resource);
    else unowned.push(Object.freeze({ ...resource, reason: 'unknown-kind' }));
  }
  for (const resource of owned.volume) {
    const storageKind = resource.labels[STORAGE_LABEL];
    if (storageKind === 'work') keep(resource, 'workVolume');
    else if (storageKind === 'metadata') keep(resource, 'metadataVolume');
    else unowned.push(Object.freeze({ ...resource, reason: 'unknown-kind' }));
  }
  const networks = owned.network.filter(resource => {
    if (EGRESS_LABEL in resource.labels) return true;
    unowned.push(Object.freeze({ ...resource, reason: 'unknown-kind' }));
    return false;
  });

  // Containers first: a network cannot be removed while an agent or proxy is still attached to it.
  const failures: unknown[] = [];
  for (const resource of [...remove, ...networks]) {
    if (resource.kind === 'network' && failures.length) break;
    try { await removeById(resource, remaining); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const detail = failures.map(error => (error as Error).message).join('; ');
    throw new RecoveryError(failures, `Recovery could not remove ${failures.length} resource(s): `
      + (detail.length > DIAGNOSTIC_LIMIT ? `${detail.slice(0, DIAGNOSTIC_LIMIT)}…` : detail));
  }

  const handles: RecoveredTaskStorage[] = [];
  for (const [allocationId, group] of storage) {
    if (!group.consistent || !group.attemptId) {
      for (const resource of group.resources) unowned.push(Object.freeze({ ...resource, reason: 'inconsistent-storage' }));
      continue;
    }
    // Adoption re-checks every part's labels, and the owner's format; a group that fails is reported, not adopted.
    const budget = remaining();
    try {
      handles.push(adoptRecoveredTaskStorage({ runnerOwner, attemptId: group.attemptId, allocationId }, group.parts,
        budget));
    } catch {
      for (const resource of group.resources) unowned.push(Object.freeze({ ...resource, reason: 'inconsistent-storage' }));
    }
  }
  return Object.freeze({ removed: Object.freeze([...remove, ...networks]), storage: Object.freeze(handles),
    unowned: Object.freeze(unowned) });
}

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Docker daemon behind both CLI entry points recovery uses: execFile (runDocker) and spawnSync (storage).
interface FakeObject { kind: 'container' | 'volume' | 'network'; id?: string; name: string; labels: Record<string, string> }
const daemon = vi.hoisted(() => ({ objects: [] as FakeObject[], refuseRemoval: new Set<string>(), calls: [] as string[][],
  failSingleInspect: new Set<string>() }));
const answer = (args: string[]): { status: number; stdout: string; stderr: string } => {
  daemon.calls.push(args);
  const kindOf = (word: string) => word === 'ps' || word === 'container' || word === 'rm' ? 'container' : word;
  const find = (kind: string, ref: string) => daemon.objects.find(object => object.kind === kind
    && (object.id === ref || object.name === ref));
  if (args[0] === 'ps' || args[1] === 'ls') {
    const kind = kindOf(args[0]!), filter = args[args.indexOf('--filter') + 1]!.replace(/^label=/, '');
    const [key, value] = filter.includes('=') ? [filter.slice(0, filter.indexOf('=')), filter.slice(filter.indexOf('=') + 1)]
      : [filter, undefined];
    const matches = daemon.objects.filter(object => object.kind === kind && key! in object.labels
      && (value === undefined || object.labels[key!] === value));
    return { status: 0, stdout: matches.map(object => kind === 'volume' ? object.name : object.id ?? object.name).join('\n'), stderr: '' };
  }
  if (args[1] === 'inspect') {
    // Only a one-object inspect (storage adoption) fails, as when the daemon stops answering mid-recovery.
    if (args.length === 3 && daemon.failSingleInspect.has(args[2]!))
      return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    const found = args.slice(2).map(ref => find(args[0]!, ref));
    const json = found.filter(Boolean).map(object => object!.kind === 'container'
      ? { Id: object!.id, Name: `/${object!.name}`, Config: { Labels: object!.labels } }
      : { ...(object!.kind === 'network' ? { Id: object!.id } : {}), Name: object!.name, Labels: object!.labels });
    return found.every(Boolean) ? { status: 0, stdout: JSON.stringify(json), stderr: '' }
      : { status: 1, stdout: JSON.stringify(json), stderr: 'Error: No such object' };
  }
  const [kind, ref] = args[0] === 'rm' ? ['container', args[2]!] : [args[0]!, args[args.length - 1]!];
  const object = find(kind, ref);
  if (!object) return { status: 1, stdout: '', stderr: 'Error: No such object' };
  if (daemon.refuseRemoval.has(object.name)) return { status: 1, stdout: '', stderr: 'Error: daemon refused removal' };
  daemon.objects.splice(daemon.objects.indexOf(object), 1);
  return { status: 0, stdout: ref, stderr: '' };
};
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn((_file: string, args: string[], _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void) => {
    const result = answer(args);
    queueMicrotask(() => callback(result.status === 0 ? null : Object.assign(new Error('Command failed'),
      { code: result.status, killed: false }), result.stdout, result.stderr));
    return {};
  }),
  spawnSync: vi.fn((_file: string, args: string[]) => ({ ...answer(args), error: undefined })),
}));
const { recoverLeftovers, RecoveryError } = await import('../agents/recovery.ts');
const { isRecoveredTaskStorage, removeTaskFilesystems } = await import('../agents/container/storage.ts');

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const id = () => randomUUID().replaceAll('-', '').repeat(2);
const owner = (runner: string, attempt: string, allocation: string) => ({ 'io.codeboost.runner': runner,
  'io.codeboost.attempt': attempt, 'io.codeboost.allocation': allocation });
/** One attempt's objects: storage (two volumes, keeper), a leftover seeder, agent container, proxy and network. */
const attempt = (runner: string, attemptId: string) => {
  const storage = randomUUID(), network = randomUUID(), labels = owner(runner, attemptId, storage);
  const netLabels = { ...owner(runner, attemptId, network), 'io.codeboost.egress': network };
  const objects: FakeObject[] = [
    { kind: 'volume', id: '', name: `codeboost-work-${randomUUID()}`, labels: { ...labels, 'io.codeboost.task-storage': 'work' } },
    { kind: 'volume', id: '', name: `codeboost-metadata-${randomUUID()}`, labels: { ...labels, 'io.codeboost.task-storage': 'metadata' } },
    { kind: 'container', id: id(), name: `codeboost-keeper-${randomUUID()}`, labels: { ...labels, 'io.codeboost.task-storage': 'keeper' } },
    { kind: 'container', id: id(), name: `codeboost-seeder-${randomUUID()}`, labels: { ...labels, 'io.codeboost.task-storage': 'seeder' } },
    { kind: 'container', id: id(), name: `codeboost-agent-${randomUUID()}`, labels: { ...owner(runner, `${attemptId}-agent`, storage), 'io.codeboost.invocation': randomUUID() } },
    { kind: 'container', id: id(), name: `codeboost-proxy-codex-${randomUUID()}`, labels: netLabels },
    { kind: 'network', id: id(), name: `codeboost-egress-codex-${randomUUID()}`, labels: netLabels },
  ];
  daemon.objects.push(...objects);
  return { storage, objects };
};
const names = (kind?: FakeObject['kind']) => daemon.objects.filter(object => !kind || object.kind === kind)
  .map(object => object.name).sort();

describe('recoverLeftovers', () => {
  beforeEach(() => {
    daemon.objects = []; daemon.refuseRemoval = new Set(); daemon.calls = []; daemon.failSingleInspect = new Set();
  });

  it('removes only its own runtime objects, keeps its storage whole, and never touches another runner', async () => {
    const mine = attempt(A, 'attempt-a'), theirs = attempt(B, 'attempt-b');
    const report = await recoverLeftovers(A);
    const [work, metadata, keeper, seeder, agent, proxy, network] = mine.objects;
    expect(report.removed.map(resource => resource.name).sort())
      .toEqual([seeder!.name, agent!.name, proxy!.name, network!.name].sort());
    // Only A's runtime objects are gone: A's storage and every object of B remain.
    expect(names()).toEqual([work!.name, metadata!.name, keeper!.name, ...theirs.objects.map(object => object.name)].sort());
    expect(report.storage).toHaveLength(1);
    expect(report.storage[0]).toEqual({ runnerOwner: A, attemptId: 'attempt-a', allocationId: mine.storage,
      workVolume: work!.name, metadataVolume: metadata!.name, keeper: keeper!.name });
    expect(isRecoveredTaskStorage(report.storage[0])).toBe(true);
    expect(report.unowned).toEqual([]);
    // Every removal was addressed by full ID, never by name.
    for (const call of daemon.calls.filter(args => args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')))
      expect(call[call.length - 1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts its recovery handle for storage removal once, after a restart lost the allocator handle', async () => {
    attempt(A, 'attempt-a');
    const { storage: [handle] } = await recoverLeftovers(A);
    removeTaskFilesystems(handle!);
    expect(names()).toEqual([]);
    expect(isRecoveredTaskStorage(handle)).toBe(false);
    expect(() => removeTaskFilesystems(handle!)).toThrow('trusted allocator');
  });

  it('reports objects without a runner label and never removes them', async () => {
    attempt(A, 'attempt-a');
    const legacy: FakeObject[] = [
      { kind: 'container', id: id(), name: 'codeboost-agent-old', labels: { 'io.codeboost.invocation': 'old' } },
      { kind: 'network', id: id(), name: 'codeboost-egress-old', labels: { 'io.codeboost.egress': 'old' } },
      { kind: 'volume', id: '', name: 'codeboost-work-old', labels: { 'io.codeboost.allocation': 'old', 'io.codeboost.task-storage': 'work' } },
    ];
    daemon.objects.push(...legacy);
    const report = await recoverLeftovers(A);
    expect(report.unowned.map(resource => [resource.name, resource.reason]).sort())
      .toEqual(legacy.map(object => [object.name, 'no-runner-label']).sort());
    for (const object of legacy) expect(names()).toContain(object.name);
  });

  it('reports task storage whose parts disagree on the attempt, and issues no handle for it', async () => {
    const mine = attempt(A, 'attempt-a');
    mine.objects[2]!.labels['io.codeboost.attempt'] = 'attempt-other';
    const report = await recoverLeftovers(A);
    expect(report.storage).toEqual([]);
    expect(report.unowned.map(resource => resource.reason)).toEqual(['inconsistent-storage', 'inconsistent-storage',
      'inconsistent-storage']);
    expect(names('volume')).toHaveLength(2);
  });

  it('reports an object of its runner that D does not create, and leaves it', async () => {
    daemon.objects.push({ kind: 'volume', id: '', name: 'someone-elses', labels: { 'io.codeboost.runner': A } });
    const report = await recoverLeftovers(A);
    expect(report.unowned).toMatchObject([{ name: 'someone-elses', reason: 'unknown-kind' }]);
    expect(names()).toEqual(['someone-elses']);
  });

  it('leaves an object whose kind labels D never writes together, even with this runner label', async () => {
    const odd: FakeObject[] = [
      { kind: 'container', id: id(), name: 'agent-and-storage', labels: { 'io.codeboost.runner': A,
        'io.codeboost.invocation': 'x', 'io.codeboost.task-storage': 'work' } },
      { kind: 'container', id: id(), name: 'agent-and-egress', labels: { 'io.codeboost.runner': A,
        'io.codeboost.invocation': 'x', 'io.codeboost.egress': 'y' } },
      { kind: 'network', id: id(), name: 'network-and-storage', labels: { 'io.codeboost.runner': A,
        'io.codeboost.egress': 'y', 'io.codeboost.task-storage': 'work' } },
      { kind: 'volume', id: '', name: 'volume-and-agent', labels: { 'io.codeboost.runner': A,
        'io.codeboost.task-storage': 'work', 'io.codeboost.invocation': 'x' } },
    ];
    daemon.objects.push(...odd);
    const report = await recoverLeftovers(A);
    expect(report.removed).toEqual([]);
    expect(report.unowned.map(resource => [resource.name, resource.reason]).sort())
      .toEqual(odd.map(object => [object.name, 'unknown-kind']).sort());
    expect(names()).toEqual(odd.map(object => object.name).sort());
  });

  it('leaves runtime objects of this runner whose owner labels are incomplete or disagree', async () => {
    const allocation = randomUUID();
    const odd: FakeObject[] = [
      { kind: 'network', id: id(), name: 'egress-without-owner', labels: { 'io.codeboost.runner': A,
        'io.codeboost.egress': allocation } },
      { kind: 'network', id: id(), name: 'egress-other-allocation', labels: { ...owner(A, 'attempt', allocation),
        'io.codeboost.egress': randomUUID() } },
      { kind: 'container', id: id(), name: 'proxy-without-attempt', labels: { 'io.codeboost.runner': A,
        'io.codeboost.allocation': allocation, 'io.codeboost.egress': allocation } },
      { kind: 'container', id: id(), name: 'agent-bad-allocation', labels: { ...owner(A, 'attempt', 'not-a-uuid'),
        'io.codeboost.invocation': randomUUID() } },
      { kind: 'container', id: id(), name: 'agent-bad-invocation', labels: { ...owner(A, 'attempt', allocation),
        'io.codeboost.invocation': 'not-a-uuid' } },
    ];
    daemon.objects.push(...odd);
    const report = await recoverLeftovers(A);
    expect(report.removed).toEqual([]);
    expect(report.unowned.map(resource => [resource.name, resource.reason]).sort())
      .toEqual(odd.map(object => [object.name, 'unknown-kind']).sort());
    expect(names()).toEqual(odd.map(object => object.name).sort());
  });

  it('fails closed, rather than reporting the storage as inconsistent, when checking it cannot reach Docker', async () => {
    const mine = attempt(A, 'attempt-a');
    daemon.failSingleInspect.add(mine.objects[0]!.name);
    await expect(recoverLeftovers(A)).rejects.toThrow('could not be inspected');
    expect(names('volume')).toHaveLength(2);
  });

  it('fails closed on a container the daemon reports without an ID', async () => {
    daemon.objects.push({ kind: 'container', name: 'no-full-id',
      labels: { 'io.codeboost.runner': A, 'io.codeboost.invocation': 'x' } });
    await expect(recoverLeftovers(A)).rejects.toThrow('without a full ID');
    expect(names()).toEqual(['no-full-id']);
  });

  it('issues a handle for storage left with a single volume, and removes it by that handle', async () => {
    const allocation = randomUUID(), work = `codeboost-work-${randomUUID()}`;
    daemon.objects.push({ kind: 'volume', id: '', name: work,
      labels: { ...owner(A, 'attempt-partial', allocation), 'io.codeboost.task-storage': 'work' } });
    const report = await recoverLeftovers(A);
    expect(report.storage).toEqual([{ runnerOwner: A, attemptId: 'attempt-partial', allocationId: allocation,
      workVolume: work }]);
    removeTaskFilesystems(report.storage[0]!);
    expect(names()).toEqual([]);
  });

  it('rejects with a bounded diagnostic and adopts nothing when a removal is not confirmed', async () => {
    const mine = attempt(A, 'attempt-a'), [, , , , agent, , network] = mine.objects;
    daemon.refuseRemoval.add(agent!.name);
    const error = await recoverLeftovers(A).then(() => undefined, caught => caught);
    expect(error).toBeInstanceOf(RecoveryError);
    expect((error as Error).message).toContain('daemon refused removal');
    // The error lists what this run did remove, so a caller can log it before running recovery again.
    const [, , , seeder, , proxy] = mine.objects;
    expect((error as InstanceType<typeof RecoveryError>).removed.map(resource => resource.name).sort())
      .toEqual([seeder!.name, proxy!.name].sort());
    expect((error as Error).message.length).toBeLessThan(1_200);
    // The network is not attempted while a container that may still use it remains.
    expect(names()).toContain(network!.name);
    expect(daemon.calls.some(args => args[0] === 'volume' && args[1] === 'inspect' && args.length === 3)).toBe(false);
  });

  it('inspects objects in bounded batches, however many codeboost objects the daemon holds', async () => {
    for (let index = 0; index < 450; index++)
      daemon.objects.push({ kind: 'volume', id: '', name: `codeboost-work-old-${index}`,
        labels: { 'io.codeboost.allocation': `old-${index}` } });
    const report = await recoverLeftovers(A);
    expect(report.unowned).toHaveLength(450);
    const inspects = daemon.calls.filter(args => args[1] === 'inspect');
    expect(inspects.length).toBeGreaterThanOrEqual(3);
    for (const args of inspects) expect(args.length - 2).toBeLessThanOrEqual(200);
  });

  it('refuses a malformed runner token before listing anything', async () => {
    await expect(recoverLeftovers('A'.repeat(32))).rejects.toThrow('32 lowercase hex');
    expect(daemon.calls).toEqual([]);
  });
});

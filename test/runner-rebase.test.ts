import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit as git } from './fixtures/git.ts';
import { GitRebaser, RebaseConflict, rebaseRef } from '../runner/rebase.ts';
import { ensureCommit, openRunnerRepository } from '../runner/runner-repository.ts';
import { verifyCheckout } from '../runner/verify-checkout.ts';

const OWNER = '0123456789abcdef0123456789abcdef';
const roots: string[] = [];
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commit(repository: string, path: string, text: string, message: string): string {
  writeFileSync(join(repository, path), text);
  git(repository, 'add', '--', path);
  git(repository, 'commit', '-qm', message);
  return git(repository, 'rev-parse', 'HEAD');
}

async function setup(conflict = false) {
  const root = mkdtempSync(join(tmpdir(), 'codeboost-rebase-')); roots.push(root);
  const source = join(root, 'source');
  git(root, 'init', '-q', '-b', 'main', source);
  git(source, 'config', 'user.name', 'Source'); git(source, 'config', 'user.email', 'source@example.invalid');
  const base = commit(source, 'a.txt', 'base\n', 'base');
  git(source, 'switch', '-qc', 'feature');
  const owned = commit(source, 'a.txt', 'feature\n', 'owned');
  const foreign = commit(source, 'feature.txt', 'collaborator\n', 'foreign');
  git(source, 'switch', '-q', 'main');
  const onto = commit(source, conflict ? 'a.txt' : 'base.txt', conflict ? 'main\n' : 'main moved\n', 'move base');
  const runnerRoot = join(root, 'runner');
  const repository = await openRunnerRepository({ runnerRoot, runnerOwner: OWNER, repositoryId: 'repo', source });
  await ensureCommit(repository, foreign); await ensureCommit(repository, onto);
  const rebaser = new GitRebaser({ repository, runnerRoot, runnerOwner: OWNER,
    committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
    onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
    onResultPrepared: () => {}, onResultState: () => {} });
  return { root, source, runnerRoot, repository, rebaser, base, owned, foreign, history: [owned, foreign], onto };
}

describe('trusted pre-merge rebase', () => {
  it('replays a complete linear history one-for-one and retains only its immutable result ref', async () => {
    const s = await setup(), attemptId = randomUUID();
    const result = await s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto });
    expect(result).toMatchObject({ oldHead: s.foreign, base: s.onto });
    expect(result.mappings.map(entry => entry.oldSha)).toEqual([s.owned, s.foreign]);
    expect(new Set(result.mappings.map(entry => entry.newSha)).size).toBe(2);
    expect(result.mappings.every(entry => entry.oldSha !== entry.newSha)).toBe(true);
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(result.head);
    expect(git(s.repository.path, 'rev-list', '--reverse', `${s.onto}..${result.head}`).split('\n')).toEqual(result.mappings.map(entry => entry.newSha));
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    // The source checkout is read-only to the rebaser.
    expect(git(s.source, 'rev-parse', 'feature')).toBe(s.foreign);
  });

  it('returns identity mappings without creating mutable state when the base is already current', async () => {
    const s = await setup(), attemptId = randomUUID();
    const result = await s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.base });
    expect(result).toEqual({ oldHead: s.foreign, base: s.base, head: s.foreign,
      mappings: [{ oldSha: s.owned, newSha: s.owned }, { oldSha: s.foreign, newSha: s.foreign }] });
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('rejects a result callback that blocks past the operation deadline', async () => {
    const s = await setup(), attemptId = randomUUID();
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
      onResultPrepared: () => vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER), onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.base }))
      .rejects.toThrow(/deadline expired while recording its result/);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('refuses when Git history no longer matches the durably captured ordered history', async () => {
    const s = await setup(), attemptId = randomUUID();
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign,
      oldHistory: [s.foreign], onto: s.onto })).rejects.toThrow(/no longer matches/);
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
  });

  it('never overwrites or deletes a retained result when an attempt ID is reused', async () => {
    const s = await setup(), attemptId = randomUUID();
    const first = await s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto });
    git(s.source, 'switch', '-q', 'main');
    const nextBase = commit(s.source, 'later.txt', 'later\n', 'move base again');
    await ensureCommit(s.repository, nextBase);
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: nextBase }))
      .rejects.toThrow(/already has a retained result/);
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.base }))
      .rejects.toThrow(/already has a retained result/);
    await s.rebaser.abort(attemptId); // A reused live/startup marker has no ownership value for the earlier result.
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(first.head);
  });

  it('accepts tracked files that a later commit adds to gitignore', async () => {
    const s = await setup(), attemptId = randomUUID();
    git(s.source, 'switch', '-q', '-C', 'ignored-feature', s.base);
    commit(s.source, 'kept.log', 'tracked\n', 'add tracked file');
    const head = commit(s.source, '.gitignore', '*.log\n', 'ignore later logs');
    await ensureCommit(s.repository, head);
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: head,
      oldHistory: git(s.repository.path, 'rev-list', '--reverse', `${s.base}..${head}`).split('\n'), onto: s.onto }))
      .resolves.toMatchObject({ oldHead: head, base: s.onto });
  });

  it('preserves an index-only gitlink whose byte-exact name ends in whitespace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-gitlink-')); roots.push(root);
    const template = join(root, 'empty-template'); mkdirSync(template);
    git(root, 'init', '-q', `--template=${template}`, '-b', 'main', 'source');
    const source = join(root, 'source');
    git(source, 'config', 'user.name', 'Source'); git(source, 'config', 'user.email', 'source@example.invalid');
    const base = commit(source, 'base.txt', 'base\n', 'base');
    git(source, 'update-index', '--add', '--cacheinfo', `160000,${base},sub `);
    git(source, 'commit', '-qm', 'gitlink');
    expect(() => verifyCheckout(source)).not.toThrow();
  });

  it('verifies regular tracked files whose byte-exact names end in whitespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-space-path-')); roots.push(root);
    const template = join(root, 'empty-template'); mkdirSync(template);
    git(root, 'init', '-q', `--template=${template}`, '-b', 'main', 'source');
    const source = join(root, 'source'), name = 'kept ';
    git(source, 'config', 'user.name', 'Source'); git(source, 'config', 'user.email', 'source@example.invalid');
    writeFileSync(join(source, name), 'tracked\n');
    git(source, 'add', '--', name);
    expect(() => verifyCheckout(source)).not.toThrow();
  });

  it('walks each checkout directory once instead of rejecting a normal large directory quadratically', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeboost-many-paths-')); roots.push(root);
    const template = join(root, 'empty-template'); mkdirSync(template);
    git(root, 'init', '-q', `--template=${template}`, '-b', 'main', 'source');
    const source = join(root, 'source'), many = join(source, 'many'); mkdirSync(many);
    for (let index = 0; index < 2_500; index++) writeFileSync(join(many, `f${String(index).padStart(4, '0')}.txt`), 'x');
    git(source, 'add', '--', 'many');
    expect(() => verifyCheckout(source)).not.toThrow();
  });

  it('reports every spawned process group as owned until that exact process settles', async () => {
    const s = await setup(), attemptId = randomUUID(), active = new Map<number, number>(), seen: number[] = [];
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {},
      onProcessGroup: (ownedAttempt, group) => {
        expect(ownedAttempt).toBe(attemptId); expect(active.size).toBe(0); active.set(group.pgid, group.startedAt); seen.push(group.pgid);
      },
      onProcessGroupSettled: (ownedAttempt, group) => {
        expect(ownedAttempt).toBe(attemptId);
        if (group !== 'spawning') { expect(active.get(group.pgid)).toBe(group.startedAt); active.delete(group.pgid); }
      }, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto });
    expect(seen.length).toBeGreaterThan(1);
    expect(active.size).toBe(0);
  });

  it('refuses an operation deadline too short to include process-group settlement', async () => {
    const s = await setup();
    expect(() => new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, timeoutMs: 43_000,
      onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
      onResultPrepared: () => {}, onResultState: () => {} })).toThrow(/Invalid rebase deadline/);
  });

  it('does not start Git when a synchronous ownership hook exhausts the work deadline', async () => {
    const s = await setup(), attemptId = randomUUID();
    let starts = 0, settled = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, timeoutMs: 43_001,
      onProcessStarting: () => { starts++; const until = performance.now() + 2; while (performance.now() < until) { /* block */ } },
      onProcessGroup: () => { throw new Error('Git must not spawn after the deadline.'); },
      onProcessGroupSettled: (_attempt, group) => { if (group === 'spawning') settled++; }, onProcessUnsettled: () => {},
      onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto })).rejects.toThrow(/deadline expired/);
    expect({ starts, settled }).toEqual({ starts: 1, settled: 1 });
  });

  it('clears a possibly committed spawning marker when its ownership hook throws before spawn', async () => {
    const s = await setup(), attemptId = randomUUID();
    let owner: 'none' | 'spawning' | 'group' = 'none', starts = 0, groups = 0, firstSettlement = true;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => { owner = 'spawning'; if (++starts === 1) throw new Error('ownership commit outcome unknown'); },
      onProcessGroup: () => { expect(owner).toBe('spawning'); owner = 'group'; groups++; },
      onProcessGroupSettled: () => {
        if (firstSettlement) { expect(groups).toBe(0); firstSettlement = false; }
        expect(owner).not.toBe('none'); owner = 'none';
      }, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto }))
      .rejects.toThrow('ownership commit outcome unknown');
    expect(owner).toBe('none');
    expect(groups).toBe(0);
  });

  it('preserves a pre-spawn deadline and its failed settlement write together', async () => {
    const s = await setup(), attemptId = randomUUID();
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, timeoutMs: 43_001,
      onProcessStarting: () => { const until = performance.now() + 2; while (performance.now() < until) { /* block */ } },
      onProcessGroup: () => { throw new Error('Git must not spawn after the deadline.'); },
      onProcessGroupSettled: () => { throw new Error('settlement write failed'); }, onProcessUnsettled: () => {},
      onResultPrepared: () => {}, onResultState: () => {} });
    const failure = await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto })
      .then(() => null, error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!failure) throw new Error('Expected the deadline and settlement write to fail.');
    expect(failure.errors.map(error => (error as Error).message)).toEqual([
      'The rebase deadline expired.', 'settlement write failed',
    ]);
  });

  it('rejects a successful Git call when its settlement hook exhausts the work deadline', async () => {
    const s = await setup(), attemptId = randomUUID();
    let settled = 0, overran = false;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => {},
      onProcessGroupSettled: () => {
        if (++settled === 2 && !overran) { overran = true; vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER); }
      },
      onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.base }))
      .rejects.toThrow(/deadline expired while recording process settlement/);
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
  });

  it('preserves a child failure when settlement also overruns the deadline', async () => {
    const s = await setup(true), attemptId = randomUUID();
    let processes = 0, overran = false;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, onProcessStarting: () => {},
      onProcessGroup: () => { processes++; },
      onProcessGroupSettled: () => {
        if (processes === 7 && !overran) { overran = true; vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER); }
      }, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    const failure = await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto })
      .then(() => null, error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!failure) throw new Error('Expected the child failure and deadline to be retained.');
    const primary = failure.cause as AggregateError;
    expect(primary).toBeInstanceOf(AggregateError);
    expect((primary.errors[0] as Error).message).toMatch(/CONFLICT|could not apply/i);
    expect((primary.errors[1] as Error).message).toMatch(/deadline expired while recording process settlement/);
  });

  it('reports a conflict, removes the mutable checkout, and retains no rewritten ref', async () => {
    const s = await setup(true), attemptId = randomUUID();
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto })).rejects.toBeInstanceOf(RebaseConflict);
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
    expect(git(s.source, 'rev-parse', 'feature')).toBe(s.foreign);
  });

  it('refuses a case-colliding reviewed tree when the host cannot check it out faithfully', async () => {
    const s = await setup(), attemptId = randomUUID();
    const probe = join(s.root, 'case-probe'); mkdirSync(probe);
    writeFileSync(join(probe, 'A'), 'upper'); writeFileSync(join(probe, 'a'), 'lower');
    const caseSensitive = readdirSync(probe).sort().join('\0') === 'A\0a';
    writeFileSync(join(s.source, 'upper-blob'), 'upper\n'); writeFileSync(join(s.source, 'lower-blob'), 'lower\n');
    const upper = git(s.source, 'hash-object', '-w', 'upper-blob'), lower = git(s.source, 'hash-object', '-w', 'lower-blob');
    git(s.source, 'read-tree', '--empty');
    git(s.source, 'update-index', '--add', '--cacheinfo', `100644,${upper},A`);
    git(s.source, 'update-index', '--add', '--cacheinfo', `100644,${lower},a`);
    const tree = git(s.source, 'write-tree');
    const collidingHead = git(s.source, 'commit-tree', tree, '-p', s.base, '-m', 'case-colliding feature');
    await ensureCommit(s.repository, collidingHead);
    const operation = s.rebaser.run({ attemptId, oldBase: s.base, oldHead: collidingHead, oldHistory: [collidingHead], onto: s.onto });
    if (caseSensitive) await expect(operation).resolves.toMatchObject({ oldHead: collidingHead, base: s.onto });
    else await expect(operation).rejects.toThrow(/cannot faithfully check out/);
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    if (!caseSensitive) expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('refuses a case collision introduced by the target base when the host cannot represent the rebased tree', async () => {
    const s = await setup(), attemptId = randomUUID();
    const probe = join(s.root, 'target-case-probe'); mkdirSync(probe);
    writeFileSync(join(probe, 'Case'), 'upper'); writeFileSync(join(probe, 'case'), 'lower');
    const caseSensitive = readdirSync(probe).sort().join('\0') === 'Case\0case';
    git(s.source, 'switch', '-q', '-C', 'collision-feature', s.base);
    const collidingHead = commit(s.source, 'Case', 'feature\n', 'add upper-case path');
    writeFileSync(join(s.source, 'lower-blob'), 'base\n');
    const lower = git(s.source, 'hash-object', '-w', 'lower-blob');
    git(s.source, 'read-tree', s.base);
    git(s.source, 'update-index', '--add', '--cacheinfo', `100644,${lower},case`);
    const tree = git(s.source, 'write-tree');
    const collidingBase = git(s.source, 'commit-tree', tree, '-p', s.base, '-m', 'add lower-case path');
    await ensureCommit(s.repository, collidingHead); await ensureCommit(s.repository, collidingBase);
    const operation = s.rebaser.run({ attemptId, oldBase: s.base, oldHead: collidingHead, oldHistory: [collidingHead], onto: collidingBase });
    if (caseSensitive) await expect(operation).resolves.toMatchObject({ oldHead: collidingHead, base: collidingBase });
    else await expect(operation).rejects.toThrow(/cannot faithfully check out the rebased head/);
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    if (!caseSensitive) expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('honours an already-aborted signal before the first Git write', async () => {
    const s = await setup(), attemptId = randomUUID(), stop = new AbortController();
    stop.abort(new Error('cancelled before rebase'));
    await expect(s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal }))
      .rejects.toThrow('cancelled before rebase');
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
  });

  it('settles a cancellation during rebase and removes the partially rewritten worktree', async () => {
    const s = await setup(), attemptId = randomUUID(), stop = new AbortController();
    let processes = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {},
      onProcessGroup: () => { if (++processes === 7) stop.abort(new Error('cancelled during rebase')); },
      onProcessGroupSettled: () => {}, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal }))
      .rejects.toThrow('cancelled during rebase');
    expect(processes).toBeGreaterThanOrEqual(9); // stopped rebase, worktree removal, then pruning
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('preserves cancellation while classifying a failed rebase conflict', async () => {
    const s = await setup(true), attemptId = randomUUID(), stop = new AbortController();
    let processes = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, onProcessStarting: () => {},
      onProcessGroup: () => { if (++processes === 8) stop.abort(new Error('cancelled during conflict classification')); },
      onProcessGroupSettled: () => {}, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal }))
      .rejects.toThrow('cancelled during conflict classification');
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
  });

  it('preserves cancellation and a settlement callback failure together', async () => {
    const s = await setup(), attemptId = randomUUID(), stop = new AbortController();
    let failed = false;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => stop.abort(new Error('cancelled by caller')),
      onProcessGroupSettled: () => { if (!failed) { failed = true; throw new Error('settlement write failed'); } },
      onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    const failure = await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal })
      .then(() => null, error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!failure) throw new Error('Expected cancellation and settlement recording to fail.');
    expect(failure.errors.map(error => (error as Error).message)).toEqual([
      'cancelled by caller', 'settlement write failed',
    ]);
  });

  it('preserves the original cancellation when cleanup also fails', async () => {
    const s = await setup(), attemptId = randomUUID(), stop = new AbortController();
    let starts = 0, processes = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => { if (++starts === 8) throw new Error('cleanup record failed'); },
      onProcessGroup: () => { if (++processes === 7) stop.abort(new Error('original cancellation')); },
      onProcessGroupSettled: () => {}, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    const failure = await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal })
      .then(() => null, error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!failure) throw new Error('Expected the rebase and cleanup to fail.');
    expect(failure.message).toContain('original cancellation');
    expect(failure.errors.map(error => (error as Error).message)).toEqual(expect.arrayContaining([
      'original cancellation', 'cleanup record failed',
    ]));
  });

  it('discards a completed rewrite when cancellation arrives during uninterruptible cleanup', async () => {
    const s = await setup(), attemptId = randomUUID(), stop = new AbortController();
    let processes = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' }, onProcessStarting: () => {},
      onProcessGroup: () => { if (++processes === 14) stop.abort(new Error('cancelled during cleanup')); },
      onProcessGroupSettled: () => {}, onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto, signal: stop.signal }))
      .rejects.toThrow('cancelled during cleanup');
    expect(processes).toBeGreaterThanOrEqual(16); // result ref, worktree cleanup, prune, then result-ref deletion
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
  });

  it('reports a ref-deletion failure after the result ref write has an ambiguous callback failure', async () => {
    const s = await setup(), attemptId = randomUUID();
    let settled = 0, starts = 0;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => { if (++starts === 16) throw new Error('ref deletion record failed'); },
      onProcessGroup: () => {},
      onProcessGroupSettled: () => {
        if (++settled === 13) {
          expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toMatch(/^[0-9a-f]{40,64}$/);
          throw new Error('result ref outcome unknown');
        }
      },
      onProcessUnsettled: () => {}, onResultPrepared: () => {}, onResultState: () => {} });
    const failure = await rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto })
      .then(() => null, error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!failure) throw new Error('Expected the ref write and its cleanup to fail.');
    expect(failure.errors.map(error => (error as Error).message)).toEqual(expect.arrayContaining([
      'result ref outcome unknown', 'ref deletion record failed',
    ]));
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).not.toThrow();
  });

  it('aborts only a retained ref whose exact value is durably owned by the attempt', async () => {
    const s = await setup(), attemptId = randomUUID();
    const result = await s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto });
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(result.head);
    await s.rebaser.abort(attemptId);
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(result.head);
    await expect(s.rebaser.abort(attemptId, result.head, 'prepared')).rejects.toThrow(/outcome is ambiguous/);
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(result.head);
    await s.rebaser.abort(attemptId, result.head);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
    await expect(s.rebaser.abort(attemptId, result.head)).resolves.toBeUndefined();
    await expect(s.rebaser.abort('../other')).rejects.toThrow(/UUID v4/);
  });

  it('fails closed when an attempt ref exists at a value other than the durably owned result', async () => {
    const s = await setup(), attemptId = randomUUID();
    const result = await s.rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto });
    git(s.repository.path, 'update-ref', rebaseRef(attemptId), s.foreign, result.head);
    await expect(s.rebaser.abort(attemptId, result.head)).rejects.toThrow(/Another retained result/);
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(s.foreign);
    await expect(s.rebaser.abort(attemptId, result.head, 'prepared')).resolves.toBeUndefined();
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(s.foreign);
  });

  it('records a definite same-head create refusal and preserves the winning ref during recovery', async () => {
    const s = await setup(), attemptId = randomUUID(), states: string[] = [];
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
      onResultPrepared: (_attempt, head) => git(s.repository.path, 'update-ref', rebaseRef(attemptId), head!),
      onResultState: (_attempt, state) => { states.push(state); } });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto }))
      .rejects.toThrow(/update-ref failed/);
    expect(states).toEqual(['refused']);
    const winner = git(s.repository.path, 'rev-parse', rebaseRef(attemptId));
    await expect(rebaser.abort(attemptId, winner, 'refused')).resolves.toBeUndefined();
    expect(git(s.repository.path, 'rev-parse', rebaseRef(attemptId))).toBe(winner);
  });

  it('removes its retained ref when durable result ownership cannot be recorded', async () => {
    const s = await setup(), attemptId = randomUUID();
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
      onResultPrepared: () => { throw new Error('result ownership write failed'); }, onResultState: () => {} });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto }))
      .rejects.toThrow('result ownership write failed');
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
    expect(existsSync(join(s.runnerRoot, OWNER, 'rebases', attemptId))).toBe(false);
  });

  it('keeps the intended head recoverable when readiness recording fails after ref creation', async () => {
    const s = await setup(), attemptId = randomUUID();
    let preparedHead: string | undefined;
    const rebaser = new GitRebaser({ repository: s.repository, runnerRoot: s.runnerRoot, runnerOwner: OWNER,
      committer: { name: 'Codeboost', email: 'codeboost@example.invalid' },
      onProcessStarting: () => {}, onProcessGroup: () => {}, onProcessGroupSettled: () => {}, onProcessUnsettled: () => {},
      onResultPrepared: (_attempt, head) => {
        expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
        preparedHead = head ?? undefined;
      },
      onResultState: () => { throw new Error('result readiness write failed'); } });
    await expect(rebaser.run({ attemptId, oldBase: s.base, oldHead: s.foreign, oldHistory: s.history, onto: s.onto }))
      .rejects.toThrow('result readiness write failed');
    expect(preparedHead).toMatch(/^[0-9a-f]{40,64}$/);
    expect(() => git(s.repository.path, 'show-ref', '--verify', rebaseRef(attemptId))).toThrow();
    await expect(rebaser.abort(attemptId, preparedHead, 'prepared')).resolves.toBeUndefined();
  });

  it('prunes an exact stale worktree registration even when its directory is already gone', async () => {
    const s = await setup(), attemptId = randomUUID(), path = join(s.runnerRoot, OWNER, 'rebases', attemptId);
    git(s.repository.path, 'worktree', 'add', '--detach', '--', path, s.foreign);
    rmSync(path, { recursive: true, force: true });
    expect(git(s.repository.path, 'worktree', 'list', '--porcelain')).toContain(path);
    await s.rebaser.abort(attemptId);
    expect(git(s.repository.path, 'worktree', 'list', '--porcelain')).not.toContain(path);
  });

  it('removes an unregistered interrupted workspace through the bounded subprocess path', async () => {
    const s = await setup(), attemptId = randomUUID(), path = join(s.runnerRoot, OWNER, 'rebases', attemptId);
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'partial'), 'left by interrupted worktree add');
    await s.rebaser.abort(attemptId);
    expect(existsSync(path)).toBe(false);
  });
});

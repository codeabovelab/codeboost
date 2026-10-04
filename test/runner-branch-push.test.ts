import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureGit as git } from './fixtures/git.ts';
import type { PlanIdentity } from '../core/identity.ts';
import { GH_ENV_ALLOWLIST } from '../github/gh-env.ts';
import { BranchPushRefused, CREDENTIAL_HELPER, GitBranchPusher, gitFailure, pushArguments, pushEnvironment, pushUrl, redact } from '../runner/branch-push.ts';
import { ensureCommit, fetchTaskCommit, openRunnerRepository, type RunnerRepository } from '../runner/runner-repository.ts';

const OWNER = '0123456789abcdef0123456789abcdef';
const IDENTITY: PlanIdentity = { repositoryId: 'repo-1', taskId: 'task-1', planId: 'plan-1' };
const BRANCH = 'codeboost/issue-7-task-1-0123456789abcdef', REF = `refs/heads/${BRANCH}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'branch-push-')); roots.push(root);
  const source = join(root, 'source'), remote = join(root, 'remote.git');
  git(root, 'init', '-q', source); git(source, 'config', 'user.name', 'T'); git(source, 'config', 'user.email', 't@e');
  writeFileSync(join(source, 'a.txt'), 'a\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  git(source, 'tag', 'v1');
  const base = git(source, 'rev-parse', 'HEAD');
  git(root, 'init', '-q', '--bare', remote);
  const repository = await openRunnerRepository({ runnerRoot: join(root, 'runner'), runnerOwner: OWNER, repositoryId: 'repo-1', source });
  await ensureCommit(repository, base);
  return { root, source, remote, base, repository };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A runner commit on `base`, taken into the runner repository the way execution does. */
async function runnerCommit(s: Setup, name: string): Promise<string> {
  const work = join(s.root, `work-${randomUUID()}`);
  git(s.root, '-c', 'protocol.file.allow=always', 'clone', '-q', s.source, work);
  git(work, 'config', 'user.name', 'R'); git(work, 'config', 'user.email', 'r@e');
  writeFileSync(join(work, `${name}.txt`), `${name}\n`); git(work, 'add', '.'); git(work, 'commit', '-qm', name);
  git(work, 'update-ref', 'refs/heads/codeboost', 'HEAD');
  const file = join(work, 'out.bundle');
  git(work, 'bundle', 'create', '-q', file, 'refs/heads/codeboost', `^${s.base}`);
  const head = git(work, 'rev-parse', 'HEAD');
  await fetchTaskCommit(s.repository, { bundle: readFileSync(file), base: s.base, head, attemptId: randomUUID() });
  return head;
}

function pusher(s: Setup, options: { owned?: (identity: PlanIdentity) => Iterable<string>; env?: NodeJS.ProcessEnv;
  repository?: RunnerRepository; onProcessGroup?: (group: { pgid: number }) => void } = {}) {
  const spawns: number[] = [];
  const instance = new GitBranchPusher({ repository: options.repository ?? s.repository, repositoryId: 'repo-1', remote: 'acme/app',
    url: s.remote, env: options.env ?? process.env, ownedCommits: options.owned ?? (() => []),
    onProcessGroup: group => { spawns.push(group.pgid); options.onProcessGroup?.(group); } });
  return { instance, spawns };
}
/** A person pushes the base commit to `ref` on the remote. */
const personPushes = (s: Setup, ref: string) => git(s.source, '-c', 'protocol.file.allow=always', 'push', '-qf', s.remote, `${s.base}:${ref}`);
const remoteRefs = (s: Setup) => git(s.remote, 'for-each-ref', '--format=%(objectname) %(refname)');

describe('GitBranchPusher', () => {
  it('creates the branch at the head, sending only that ref, and never writes the user\'s repository', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), sourceRefs = git(s.source, 'for-each-ref');
    await pusher(s).instance.push(IDENTITY, { head, branch: BRANCH });
    // No tags, no attempt refs, nothing else.
    expect(remoteRefs(s)).toBe(`${head} ${REF}`);
    expect(git(s.source, 'for-each-ref')).toBe(sourceRefs);
  });

  it('does nothing when the branch is already at the head, as after a push whose outcome was lost', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one');
    await pusher(s).instance.push(IDENTITY, { head, branch: BRANCH });
    const again = pusher(s, { owned: () => { throw new Error('the ledger is not read'); } });
    await again.instance.push(IDENTITY, { head, branch: BRANCH });
    // The commit check and one read of the remote; no push.
    expect(again.spawns).toHaveLength(2);
    expect(remoteRefs(s)).toBe(`${head} ${REF}`);
  });

  it('moves the branch over a commit codeboost made, even when the new head does not descend from it', async () => {
    const s = await setup(), first = await runnerCommit(s, 'one'), second = await runnerCommit(s, 'two');
    await pusher(s).instance.push(IDENTITY, { head: first, branch: BRANCH });
    const seen: PlanIdentity[] = [];
    await pusher(s, { owned: identity => { seen.push(identity); return [first]; } }).instance.push(IDENTITY, { head: second, branch: BRANCH });
    expect(seen).toEqual([IDENTITY]);
    expect(remoteRefs(s)).toBe(`${second} ${REF}`);
  });

  it('refuses a branch that holds a commit codeboost did not make, and pushes nothing', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), mine = await runnerCommit(s, 'two');
    personPushes(s, REF);
    const p = pusher(s, { owned: () => [mine] });
    await expect(p.instance.push(IDENTITY, { head, branch: BRANCH })).rejects.toThrow(BranchPushRefused);
    await expect(p.instance.push(IDENTITY, { head, branch: BRANCH })).rejects.toThrow(`holds commit ${s.base}, which codeboost did not make`);
    expect(remoteRefs(s)).toBe(`${s.base} ${REF}`);
  });

  it('refuses when the branch moves between the read and the push: the lease is the value read', async () => {
    const s = await setup(), first = await runnerCommit(s, 'one'), second = await runnerCommit(s, 'two');
    await pusher(s).instance.push(IDENTITY, { head: first, branch: BRANCH });
    // A person pushes while codeboost reads the ledger, after it read the remote.
    const moved = pusher(s, { owned: () => { git(s.remote, 'update-ref', REF, s.base); return [first]; } });
    await expect(moved.instance.push(IDENTITY, { head: second, branch: BRANCH })).rejects.toThrow(`The branch ${BRANCH} moved while codeboost pushed it`);
    expect(remoteRefs(s)).toBe(`${s.base} ${REF}`);
  });

  it('refuses when a branch that did not exist is created between the read and the push', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one');
    const created = pusher(s, { owned: () => { personPushes(s, REF); return []; } });
    await expect(created.instance.push(IDENTITY, { head, branch: BRANCH })).rejects.toThrow(BranchPushRefused);
    expect(remoteRefs(s)).toBe(`${s.base} ${REF}`);
  });

  describe('a push left running by a crashed codeboost (#112)', () => {
    /**
     * What such a process does: the pusher's own push arguments, from the runner repository, leased to the value that
     * run read. The process outlives its codeboost, so it lands at any point of a later publish.
     */
    const leftover = (s: Setup, head: string, read: string | null) => {
      try { git(s.repository.path, '-c', 'protocol.file.allow=always', ...pushArguments({ url: s.remote, ref: REF, read, head })); return 'landed'; }
      catch (error) {
        // Only the lease's own refusal counts; any other failure would prove nothing about the lease.
        const output = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`;
        if (/\[rejected\][^\n]*\(stale info\)/.test(output)) return 'refused';
        throw error;
      }
    };
    it('is refused by its lease when it lands after a newer publish, so it never overwrites the newer head', async () => {
      const s = await setup(), old = await runnerCommit(s, 'old'), newer = await runnerCommit(s, 'newer');
      // The crashed run read no branch; a restart's publish created it.
      await pusher(s, { owned: () => [old, newer] }).instance.push(IDENTITY, { head: newer, branch: BRANCH });
      expect(leftover(s, old, null)).toBe('refused');
      expect(remoteRefs(s)).toBe(`${newer} ${REF}`);
      // The crashed run read an earlier commit of its own; the restart's publish moved the branch on from it.
      const t = await setup(), a = await runnerCommit(t, 'first'), b = await runnerCommit(t, 'second'), c = await runnerCommit(t, 'third');
      await pusher(t).instance.push(IDENTITY, { head: a, branch: BRANCH });
      await pusher(t, { owned: () => [a, b, c] }).instance.push(IDENTITY, { head: c, branch: BRANCH });
      expect(leftover(t, b, a)).toBe('refused');
      expect(remoteRefs(t)).toBe(`${c} ${REF}`);
    });
    it('makes a newer publish refuse when it lands between that publish\'s read and its push, and the next publish moves on', async () => {
      const s = await setup(), old = await runnerCommit(s, 'old'), newer = await runnerCommit(s, 'newer');
      // It lands while the newer publish reads the ledger: after the newer publish's read, before its push.
      const between = pusher(s, { owned: () => { expect(leftover(s, old, null)).toBe('landed'); return [old, newer]; } });
      await expect(between.instance.push(IDENTITY, { head: newer, branch: BRANCH })).rejects.toThrow(`The branch ${BRANCH} moved while codeboost pushed it`);
      expect(remoteRefs(s)).toBe(`${old} ${REF}`);
      // The next publish reads the leftover's head, a commit the ledger records as codeboost's, and moves the branch on.
      await pusher(s, { owned: () => [old, newer] }).instance.push(IDENTITY, { head: newer, branch: BRANCH });
      expect(remoteRefs(s)).toBe(`${newer} ${REF}`);
    });
    it('recreates the branch when the run read none and the branch was deleted since a newer publish created it', async () => {
      const s = await setup(), old = await runnerCommit(s, 'old'), newer = await runnerCommit(s, 'newer');
      // The crashed run read no branch; a restart's publish created it; then it was deleted (by a person, or by GitHub
      // after the PR merged). The empty lease matches again, so the leftover lands.
      await pusher(s, { owned: () => [old, newer] }).instance.push(IDENTITY, { head: newer, branch: BRANCH });
      git(s.remote, 'update-ref', '-d', REF);
      expect(leftover(s, old, null)).toBe('landed');
      expect(remoteRefs(s)).toBe(`${old} ${REF}`);
    });
    it('is simply read as codeboost\'s commit when it lands before a newer publish reads the branch', async () => {
      const s = await setup(), old = await runnerCommit(s, 'old'), newer = await runnerCommit(s, 'newer');
      expect(leftover(s, old, null)).toBe('landed');
      await pusher(s, { owned: () => [old, newer] }).instance.push(IDENTITY, { head: newer, branch: BRANCH });
      expect(remoteRefs(s)).toBe(`${newer} ${REF}`);
    });
  });

  it('reads only the exact branch, not a longer ref that ends with its name', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one');
    personPushes(s, `refs/heads/other/${REF}`);
    await pusher(s).instance.push(IDENTITY, { head, branch: BRANCH });
    expect(git(s.remote, 'rev-parse', REF)).toBe(head);
  });

  it('refuses another repository\'s task, a branch outside codeboost/, and a head the runner repository lacks', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), { instance, spawns } = pusher(s);
    await expect(instance.push({ ...IDENTITY, repositoryId: 'repo-2' }, { head, branch: BRANCH })).rejects.toThrow('another repository');
    for (const branch of ['main', 'codeboost/../main', 'codeboost/x/y', 'refs/heads/codeboost/x', 'codeboost/x.lock', 'codeboost/'])
      await expect(instance.push(IDENTITY, { head, branch })).rejects.toThrow('Only a codeboost/ task branch');
    await expect(instance.push(IDENTITY, { head: 'HEAD', branch: BRANCH })).rejects.toThrow('full commit ID');
    expect(spawns).toHaveLength(0);
    await expect(instance.push(IDENTITY, { head: 'e'.repeat(40), branch: BRANCH })).rejects.toThrow(`has no commit ${'e'.repeat(40)}`);
    expect(remoteRefs(s)).toBe('');
  });

  it('ignores Git configuration from the environment it is given', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), elsewhere = join(s.root, 'elsewhere.git');
    git(s.root, 'init', '-q', '--bare', elsewhere);
    // If these reached Git, the push would go to `elsewhere` instead.
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${elsewhere}.insteadOf`, GIT_CONFIG_VALUE_0: s.remote,
      GIT_CONFIG_PARAMETERS: `'url.${elsewhere}.insteadof'='${s.remote}'` };
    await pusher(s, { env }).instance.push(IDENTITY, { head, branch: BRANCH });
    expect(remoteRefs(s)).toBe(`${head} ${REF}`);
    expect(git(elsewhere, 'for-each-ref')).toBe('');
  });

  it('settles a cancelled push only after Git has exited, and pushes nothing more', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), abort = new AbortController();
    let pushGroup: number | undefined, calls = 0;
    // The third Git call is the push: the commit check and the read come first.
    const p = pusher(s, { onProcessGroup: group => { if (++calls === 3) { pushGroup = group.pgid; abort.abort(); } } });
    await expect(p.instance.push(IDENTITY, { head, branch: BRANCH }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pushGroup).toBeDefined();
    expect(() => process.kill(-pushGroup!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(calls).toBe(3);
  });

  it('keeps the caller\'s abort reason, whether the abort lands during a Git call or between two', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one');
    class Closing extends Error {}
    for (const at of [1, 2, 3]) {
      const abort = new AbortController();
      let calls = 0;
      const p = pusher(s, { onProcessGroup: () => { if (++calls === at) abort.abort(new Closing(`closing at ${at}`)); } });
      await expect(p.instance.push(IDENTITY, { head, branch: BRANCH }, abort.signal)).rejects.toThrow(new Closing(`closing at ${at}`));
      expect(calls).toBe(at);
    }
    expect(remoteRefs(s)).toBe('');
  });

  it('gives every remote Git call gh as its credential helper, with no token in any argument or extra variable', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), bin = join(s.root, 'bin'), log = join(s.root, 'calls.log');
    const token = `ghp_${'B'.repeat(36)}`;
    // A Git that records its arguments and environment names, then runs the real Git.
    const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n{ printf 'ARGS'; printf ' %s' "$@"; printf '\\nENV'; env | sed 's/=.*//' | sort | tr '\\n' ' '; printf '\\n'; } >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: s.root, GH_TOKEN: token, AWS_SECRET_ACCESS_KEY: 'k', GIT_ASKPASS: '/x' };
    await pusher(s, { env }).instance.push(IDENTITY, { head, branch: BRANCH });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const args = lines.filter(line => line.startsWith('ARGS')), names = lines.filter(line => line.startsWith('ENV'));
    expect(args.map(line => line.split(' ').find(word => ['cat-file', 'ls-remote', 'push'].includes(word)))).toEqual(['cat-file', 'ls-remote', 'push', 'ls-remote']);
    for (const line of args.filter(line => / (ls-remote|push) /.test(line))) expect(line).toContain(CREDENTIAL_HELPER.join(' '));
    expect(lines.join('\n')).not.toContain(token);
    for (const line of names) {
      expect(line).not.toMatch(/\b(AWS_SECRET_ACCESS_KEY|GIT_ASKPASS)\b/);
      expect(line).toMatch(/\bGH_TOKEN\b/);
    }
    expect(remoteRefs(s)).toBe(`${head} ${REF}`);
  });

  it('requires the branch to be at the head after a push that exited 0', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), bin = join(s.root, 'bin');
    // A Git whose push reports success but changes nothing.
    const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    mkdirSync(bin); writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && exit 0; done\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const p = pusher(s, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    await expect(p.instance.push(IDENTITY, { head, branch: BRANCH })).rejects.toThrow(`After the push, the branch ${BRANCH} is at nothing, not ${head}`);
  });

  it('reports a broken runner repository as itself, not as a missing commit', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), broken = join(s.root, 'not-a-repository');
    mkdirSync(broken);
    const error = await pusher(s, { repository: { path: broken, source: s.source } }).instance.push(IDENTITY, { head, branch: BRANCH })
      .then(() => new Error('pushed'), (e: unknown) => e as Error);
    expect(error.message).toContain('git cat-file failed');
    expect(error.message).not.toContain('has no commit');
    expect(remoteRefs(s)).toBe('');
  });

  it('removes a configured enterprise token of any shape from Git\'s error text', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), token = 'enterprise-secret-0123456789';
    const missing = new GitBranchPusher({ repository: s.repository, repositoryId: 'repo-1', remote: 'acme/app',
      url: join(s.root, token), ownedCommits: () => [], env: { ...process.env, GH_ENTERPRISE_TOKEN: token } });
    const error = await missing.push(IDENTITY, { head, branch: BRANCH }).then(() => new Error('pushed'), (e: unknown) => e as Error);
    expect(error.message).toContain('git ls-remote failed');
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('0123456789');
  });

  it('removes a token from Git\'s error text', async () => {
    const s = await setup(), head = await runnerCommit(s, 'one'), token = `ghp_${'A'.repeat(36)}`;
    const missing = new GitBranchPusher({ repository: s.repository, repositoryId: 'repo-1', remote: 'acme/app',
      url: join(s.root, token), ownedCommits: () => [] });
    const error = await missing.push(IDENTITY, { head, branch: BRANCH }).then(() => new Error("pushed"), (e: unknown) => e as Error);
    expect(error.message).toContain('git ls-remote failed');
    expect(error.message).not.toContain(token);
    expect(error.message).toContain('[token]');
  });
});

describe('push invocation', () => {
  it('gives Git only the gh allowlist plus its hardened environment', () => {
    const env = pushEnvironment({ PATH: '/bin', HOME: '/h', GH_TOKEN: 't', GIT_ASKPASS: '/x', SSH_AUTH_SOCK: '/s',
      GIT_CONFIG_GLOBAL: '/home/.gitconfig', GIT_CONFIG_PARAMETERS: 'x', AWS_SECRET_ACCESS_KEY: 'k' });
    const git = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH', 'GIT_GRAFT_FILE'];
    const ghSet = ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'GH_PAGER', 'NO_COLOR'];
    for (const name of Object.keys(env)) expect([...GH_ENV_ALLOWLIST, ...git, ...ghSet]).toContain(name);
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', GH_TOKEN: 't', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
    expect(env).not.toHaveProperty('GIT_ASKPASS');
    expect(env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
  });

  it('uses gh as the only credential helper, with no secret in the arguments', () => {
    expect(CREDENTIAL_HELPER).toEqual(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']);
  });

  it('pushes to the repository on GitHub, or on GH_HOST', () => {
    expect(pushUrl('acme/app', {})).toBe('https://github.com/acme/app.git');
    expect(pushUrl('acme/app', { GH_HOST: 'ghe.example.com' })).toBe('https://ghe.example.com/acme/app.git');
    for (const remote of ['acme', 'acme/app/x', '../app', 'acme/..', 'acme/a b']) expect(() => pushUrl(remote, {})).toThrow('owner/name');
    expect(() => pushUrl('acme/app', { GH_HOST: 'evil.com/x?' })).toThrow('GH_HOST');
  });

  it('describes a failure in one line, names the workflow scope, and finds a stale lease in long output', () => {
    const workflow = gitFailure('push', 1, 'refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope');
    expect(workflow.message).toContain('needs the workflow scope');
    expect(workflow.staleLease).toBe(false);
    const long = gitFailure('push', 1, `${'x'.repeat(1000)}\nline two\n!\tabc:${REF}\t[rejected] (stale info)`);
    expect(long.staleLease).toBe(true);
    expect(long.message).not.toContain('\n');
    expect(gitFailure('push', 1, '!\tabc:refs/heads/x\t[remote rejected] (protected branch hook declined)').staleLease).toBe(false);
    // A name that merely contains the word is not GitHub's refusal, and only a push can be refused for it.
    expect(gitFailure('ls-remote', 128, "fatal: unable to access 'https://github.com/acme/workflow-engine.git/'").message).not.toContain('workflow scope');
    expect(gitFailure('ls-remote', 128, 'refusing to allow an OAuth App to create or update workflow').message).not.toContain('workflow scope');
    // A token across the 400-character cut leaves no part of itself.
    const token = `ghp_${'C'.repeat(36)}`;
    const cut = gitFailure('push', 1, `${'x'.repeat(390)}${token}`);
    expect(cut.message).not.toContain('ghp_');
    expect(cut.message).toContain('[token]');
    expect(redact(`a ${token} b secret-value-1 c`, ['secret-value-1', 'short'])).toBe('a [token] b [token] c');
    // A call that was killed keeps its cause beside Git's output.
    expect(gitFailure('push', null, 'partial output', 'git timed out after 120000 ms').message).toContain('timed out');
    expect(gitFailure('push', null, 'y'.repeat(1000), 'git timed out after 120000 ms').message).toContain('timed out');
  });
});

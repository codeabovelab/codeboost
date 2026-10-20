import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION, buildAgentImage } from '../agents/container/image.ts';
import { PATH_IDENTITY_SCRIPT, probeCleanupCallMs, probeTaskStoragePathIdentity } from '../agents/container/storage.ts';

// The probe's own handling of Docker's answers (#162), against a `docker` on PATH that answers as the daemon would. The
// measurement itself runs against real Docker in runner-workspace.test.ts.
const root = mkdtempSync(join(tmpdir(), 'codeboost-probe-')), bin = join(root, 'bin');
const calls = join(root, 'calls'), mode = join(root, 'mode'), landAt = join(root, 'land-at'), removed = join(root, 'removed');
const slowLand = join(root, 'slow-land'), slowAnswered = join(root, 'slow-answered'), inspects = join(root, 'inspects'), lateMark = join(root, 'late'), rmLog = join(root, 'rm-log'), slow = join(root, 'slow'), busy = join(root, 'busy'), oldCli = join(root, 'old-cli'), hangAt = join(root, 'hang-at'), hung = join(root, 'hung'), unreach = join(root, 'unreachable'), identity = join(root, 'identity');
const savedPath = process.env.PATH;
let imageId = '';
beforeAll(() => {
  mkdirSync(bin, { mode: 0o700 });
  const image = JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}`, Config: { User: '10001:10001', Labels: { 'org.opencontainers.image.base.name': BASE_IMAGE,
    'io.codeboost.codex.version': CODEX_VERSION, 'io.codeboost.claude.version': CLAUDE_VERSION, 'io.codeboost.profile.version': '1' } } }]);
  // `run`: per the mode file, answer (the identity file's line if there is one, as a filesystem other than tmpfs would
  // answer; otherwise tmpfs's), refuse as the daemon does, or hang until the client is killed. In `late` mode the
  // create lands just after the first inspect has answered that it is absent, after the client is gone. `rm --force` and `container inspect` answer as Docker 27
  // does: rm exits 0 whether or not the name exists (printing "No such container" when it does not); inspect exits 1.
  // While the busy file holds a count, rm of a container that exists refuses as Docker does while an auto-remove is in
  // progress, and inspect still reports it. From the time in the hang-at file, rm and inspect never answer (a daemon
  // that stopped); each such call is logged in the hung file. With the slow file, rm and inspect answer after 300 ms. With the slow-land file, the sixth inspect finds nothing, then the create lands while that answer takes 9 s to arrive (a daemon under load); the slow-answered file marks that the answer was given. Of rm and inspect, the code reads only the exit status
  // and, for a missing name, the "No such container" text; for an existing container this fake prints less stdout
  // than Docker (the name; the full inspect array), which nothing reads. `unreachable` is a daemon the client cannot
  // reach: run, rm and inspect answer as Docker 27.4.0 does with DOCKER_HOST=tcp://127.0.0.1:1 (run exit 125; rm
  // exit 1; inspect `[]` and exit 1, all with "Cannot connect"). `garbled` and `preceded` exit 0 with output that is not one line. Checked against Docker 27.4.0, as are `build` (only its exit status is read) and `image
  // inspect` (a one-element array; only `Id`, `Config.User` and `Config.Labels` are read, given in Docker's shape). With the old-cli file, rm of a missing name exits 1, as
  // CLIs before 20.10 did by the Docker 20.10.0 release notes (docker/cli#2678); no such CLI was run here, so its
  // stderr text (Docker 27's wording here) is not checked.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
exists() { [ ! -e '${removed}' ] && [ -e '${landAt}' ] && [ "$(date +%s)" -ge "$(cat '${landAt}')" ]; }
if [ "$1 $2" = "image inspect" ]; then printf '%s' '${image}'; exit 0; fi
if [ "$1" = run ]; then
  case "$(cat '${mode}')" in
    answer) if [ -e '${identity}' ]; then cat '${identity}'; else echo 'codeboost-path-identity true none'; fi;;
    garbled) printf '%s\\n' 'codeboost-path-identity true none' 'extra';;
    preceded) printf '%s\\n' 'noise' 'codeboost-path-identity true none';;
    unreachable) echo 1 > '${unreach}'; printf '%s\\n' 'docker: Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?.' "See 'docker run --help'." >&2; exit 125;;
    refused) printf '%s\\n' 'docker: Error response from daemon: unknown or invalid runtime name: x.' "See 'docker run --help'." >&2; exit 125;;
    created) echo 0 > '${landAt}'; exec sleep 30;;
    late) : > '${lateMark}'; exec sleep 30;;
    hang) exec sleep 30;;
  esac
fi
if [ -e '${hangAt}' ] && [ "$(date +%s)" -ge "$(cat '${hangAt}')" ] && { [ "$1" = rm ] || [ "$1 $2" = "container inspect" ]; }; then
  echo "$1" >> '${hung}'; exec sleep 30
fi
if [ -e '${unreach}' ] && { [ "$1" = rm ] || [ "$1 $2" = "container inspect" ]; }; then
  [ "$1" = rm ] || echo '[]'
  echo 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?' >&2; exit 1
fi
if [ -e '${slow}' ] && { [ "$1" = rm ] || [ "$1 $2" = "container inspect" ]; }; then sleep 0.3; fi
if [ "$1" = rm ]; then
  if exists && [ -s '${busy}' ] && [ "$(cat '${busy}')" -gt 0 ]; then
    echo $(( $(cat '${busy}') - 1 )) > '${busy}'
    echo "Error response from daemon: removal of container $4 is already in progress" >&2; exit 1
  fi
  if exists; then echo found >> '${rmLog}'; : > '${removed}'; exit 0; fi
  echo missing >> '${rmLog}'
  echo "Error response from daemon: No such container: $4" >&2
  if [ -e '${oldCli}' ]; then exit 1; fi
  exit 0
fi
if [ "$1 $2" = "container inspect" ]; then
  echo x >> '${inspects}'
  if [ -e '${slowLand}' ] && [ "$(wc -l < '${inspects}')" -eq 6 ]; then
    echo 0 > '${landAt}'; sleep 9
    : > '${slowAnswered}'; echo '[]'; echo "Error response from daemon: No such container: $3" >&2; exit 1
  fi
  if exists; then echo '[{}]'; exit 0; fi
  if [ -e '${lateMark}' ] && [ ! -e '${landAt}' ]; then echo 0 > '${landAt}'; fi
  echo '[]'; echo "Error response from daemon: No such container: $3" >&2; exit 1
fi
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  imageId = buildAgentImage();
});
afterAll(() => { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { for (const file of [calls, landAt, removed, slowLand, slowAnswered, inspects, lateMark, rmLog, slow, busy, oldCli, hangAt, hung, unreach, identity]) if (existsSync(file)) rmSync(file); });
const logged = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '').trim().split('\n').filter(line => !line.startsWith('build ') && !line.startsWith('image '));
const probeName = () => /--name (codeboost-path-identity-[0-9a-f-]{36}) /.exec(logged()[0]!)![1]!;

const removals = () => logged().slice(1);
const left = () => existsSync(landAt) && !existsSync(removed);

describe('task storage probe against Docker answers', () => {
  it('reads the identity from a probe that ran, and removes nothing by hand (--rm did)', async () => {
    writeFileSync(mode, 'answer');
    expect(await probeTaskStoragePathIdentity(imageId)).toEqual({ caseSensitive: true, unicodeNormalization: 'none' });
    expect(removals()).toEqual([]);
  });
  it('runs on a volume made like task storage, in a container hardened like the keeper', async () => {
    // Any Linux volume would answer `true none`, so only the arguments show the probe measures what task storage is.
    writeFileSync(mode, 'answer');
    await probeTaskStoragePathIdentity(imageId);
    const run = logged()[0]!, script = run.slice(run.indexOf(' -c ') + 4);
    expect(run.slice(0, run.indexOf(' -c '))).toBe(`run --rm --name ${probeName()} --read-only --user 10001:10001 --network=none --cap-drop=ALL`
      + ' --security-opt=no-new-privileges --security-opt=seccomp=builtin --runtime=runc --pids-limit=32 --memory=128m --cpus=.25'
      + ' --mount type=volume,target=/work,volume-driver=local,volume-opt=type=tmpfs,volume-opt=device=tmpfs,'
      + '"volume-opt=o=size=1048576,nr_inodes=64,uid=10001,gid=10001,mode=0755,nosuid,nodev"'
      + ` --entrypoint sh ${imageId}`);
    // The measuring script itself: a constant printed instead would pass on any Linux volume.
    expect(script).toBe(`${PATH_IDENTITY_SCRIPT} probe /work`);
  });
  it('removes its container and volume by name when the daemon refuses the run, and confirms it is gone', async () => {
    writeFileSync(mode, 'refused');
    await expect(probeTaskStoragePathIdentity(imageId)).rejects
      .toThrow(/^docker run failed \(exit 125\): docker: Error response from daemon: unknown or invalid runtime name: x\.\nSee 'docker run --help'\.$/);
    expect(removals()).toEqual([`rm --force --volumes ${probeName()}`, `container inspect ${probeName()}`]);
  });
  it('removes a container a killed client left created but never started', async () => {
    writeFileSync(mode, 'created');
    await expect(probeTaskStoragePathIdentity(imageId, 2_000)).rejects.toThrow('docker run failed (client killed or not started)');
    // The interleaving this test is about: the create landed before the client was killed.
    expect(existsSync(landAt)).toBe(true);
    expect(removals()).toContain(`rm --force --volumes ${probeName()}`);
    expect(left()).toBe(false);
  }, 60_000);
  it('removes a create that lands after the killed client, within the settle window', async () => {
    // The first rm and inspect find nothing (rm still exits 0); the create lands after that, so only asking again,
    // rm included, until the window closes removes it.
    writeFileSync(mode, 'late');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId, 2_000)).rejects.toThrow('client killed or not started');
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    // The interleaving this test is about: nothing at the first rm, and a later rm removed what landed.
    const rms = readFileSync(rmLog, 'utf8').trim().split('\n');
    expect(rms[0]).toBe('missing');
    expect(rms).toContain('found');
    expect(existsSync(removed)).toBe(true);
    expect(new Set(removals())).toEqual(new Set([`rm --force --volumes ${probeName()}`, `container inspect ${probeName()}`]));
  }, 60_000);
  it('removes nothing, and does not wait, when docker never started', async () => {
    writeFileSync(mode, 'answer');
    const empty = join(root, 'empty'); mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    const started = performance.now();
    try { await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('docker run failed (client killed or not started)'); }
    finally { process.env.PATH = `${bin}:${savedPath}`; }
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(existsSync(calls)).toBe(false);
  });
  it('gives up when Docker keeps reporting the container, and names it for the person to remove', async () => {
    writeFileSync(mode, 'created'); writeFileSync(busy, '100000');
    const failure = await probeTaskStoragePathIdentity(imageId, 2_000, 1_000).catch((error: Error) => error);
    // The interleaving this test is about: the create landed before the client was killed.
    expect(existsSync(landAt)).toBe(true);
    const name = probeName();
    expect((failure as Error).message).toBe('docker run failed (client killed or not started): docker run ETIMEDOUT after 2000 ms.'
      + ` The probe container ${name} may remain; remove it with docker rm --force --volumes ${name}.`);
    const cause = (failure as Error).cause as AggregateError;
    expect(cause.errors.map((error: Error) => error.message)).toEqual([expect.stringMatching(/^docker run failed/), `Docker did not confirm that ${name} is gone.`]);
    // The last thing Docker said: the inspect still found the container, or (when giving up fell due during the rm)
    // the rm's refusal while its removal was in progress.
    const said = cause.errors[1].cause as { status: number | null; stderr: string };
    expect(said.status === 0 || (said.status === 1 && /is already in progress/.test(said.stderr))).toBe(true);
  }, 60_000);
  it('removes nothing when the client was refused before it started', async () => {
    writeFileSync(mode, 'answer');
    // A deadline runInProcessGroup refuses (NOT_STARTED): nothing reached Docker.
    await expect(probeTaskStoragePathIdentity(imageId, 0)).rejects.toThrow('Process deadline must be a positive integer');
    expect(existsSync(calls)).toBe(false);
  });
  it('asks again while Docker refuses the removal of a container that exists', async () => {
    writeFileSync(mode, 'created'); writeFileSync(busy, '2');
    await expect(probeTaskStoragePathIdentity(imageId, 2_000)).rejects.toThrow('client killed or not started');
    // The interleaving this test is about: the create landed before the client was killed.
    expect(existsSync(landAt)).toBe(true);
    expect(removals().filter(call => call.startsWith('rm ')).length).toBeGreaterThanOrEqual(3);
    expect(left()).toBe(false);
  }, 60_000);
  it('settles at once on a CLI whose rm exits non-zero for a missing name', async () => {
    writeFileSync(mode, 'refused'); writeFileSync(oldCli, '');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('docker run failed (exit 125)');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(removals()).toEqual([`rm --force --volumes ${probeName()}`, `container inspect ${probeName()}`]);
  });
  it('gives up on time when the daemon stops answering the cleanup', async () => {
    // Every rm and inspect hangs: each call must be cut at the time left, not at its own 10 s deadline.
    writeFileSync(mode, 'refused'); writeFileSync(hangAt, '0');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId, 60_000, 1_000)).rejects.toThrow('may remain');
    expect(performance.now() - started).toBeLessThan(4_000);
  }, 60_000);
  it('starts no call after giving up is due, when the daemon stops answering partway', async () => {
    // Present (removal in progress) at first, then no answer from about four seconds before the give-up time. Only the
    // call that was running then may hang; starting another would stretch the bound by a second floor.
    writeFileSync(mode, 'created'); writeFileSync(busy, '100000');
    writeFileSync(hangAt, String(Math.floor(Date.now() / 1000) + 12));
    const failure = await probeTaskStoragePathIdentity(imageId, 2_000, 4_000).catch((error: Error) => error);
    // The interleaving this test is about: the create landed before the client was killed.
    expect(existsSync(landAt)).toBe(true);
    expect(readFileSync(hung, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(((failure as Error).cause as AggregateError).errors[1].message).toBe(`Docker did not confirm that ${probeName()} is gone.`);
  }, 60_000);
  it('gives up with the last outcome, not an earlier absent answer, when the daemon stops answering', async () => {
    // Absent at every answered ask (a killed client whose create never landed), then no answer before the window ends:
    // absence inside the settle window proves nothing, so this is a give-up whose cause is the unanswered call.
    writeFileSync(mode, 'hang'); writeFileSync(hangAt, String(Math.floor(Date.now() / 1000) + 5));
    const failure = await probeTaskStoragePathIdentity(imageId, 500, 2_000).catch((error: Error) => error);
    // The interleaving this test is about: an ask was answered "absent" before Docker stopped answering.
    expect(readFileSync(rmLog, 'utf8').trim().split('\n')[0]).toBe('missing');
    const cleanup = ((failure as Error).cause as AggregateError).errors[1] as Error;
    expect(cleanup.message).toBe(`Docker did not confirm that ${probeName()} is gone.`);
    expect(cleanup.cause).toMatchObject({ status: null, error: { code: 'ETIMEDOUT' } });
  }, 60_000);
  it('waits out the settle window, then gives up, when docker run exits without a daemon answer', async () => {
    // Exit 125 from the client itself: with no daemon answer, the probe cannot know no create was sent, and with the
    // daemon still unreachable nothing can confirm the container is gone.
    writeFileSync(mode, 'unreachable');
    const started = performance.now();
    const failure = await probeTaskStoragePathIdentity(imageId, 60_000, 1_000).catch((error: Error) => error);
    expect((failure as Error).message).toMatch(/^docker run failed \(exit 125\): docker: Cannot connect to the Docker daemon[^]* The probe container codeboost-path-identity-[0-9a-f-]+ may remain;/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
  }, 60_000);
  it.each(['garbled', 'preceded'])('refuses a probe that exits 0 without exactly one identity line (%s)', async garble => {
    writeFileSync(mode, garble);
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('The path identity probe did not report an identity.');
  });
  it.each([
    ['false none', { caseSensitive: false, unicodeNormalization: 'none' }],
    ['true NFC', { caseSensitive: true, unicodeNormalization: 'NFC' }],
    ['false NFC', { caseSensitive: false, unicodeNormalization: 'NFC' }],
  ] as const)('reports what the container measured: %s', async (line, expected) => {
    // Each field on its own: a probe that returned tmpfs's answer whatever the container said would fail here.
    writeFileSync(mode, 'answer'); writeFileSync(identity, `codeboost-path-identity ${line}\n`);
    expect(await probeTaskStoragePathIdentity(imageId)).toEqual(expected);
  });
  it('cuts each cleanup call at 10 s, so a daemon that answers again is asked again', async () => {
    // A killed client (10 s settle window), then every rm and inspect hangs. With the cap the first call is cut at
    // 10 s and a second runs until giving up; without it the first would hang all the way to the give-up time.
    writeFileSync(mode, 'hang'); writeFileSync(hangAt, '0');
    await expect(probeTaskStoragePathIdentity(imageId, 500, 2_000)).rejects.toThrow('may remain');
    expect(readFileSync(hung, 'utf8').trim().split('\n')).toEqual(['rm', 'container']);
  }, 60_000);
  it('gives each cleanup call at least 1 s, so a slow daemon is still heard at the give-up time', async () => {
    // Almost no time left: without the floor the first call would be cut before Docker could answer it.
    writeFileSync(mode, 'refused'); writeFileSync(slow, '');
    const failure = await probeTaskStoragePathIdentity(imageId, 60_000, 1).catch((error: Error) => error);
    const cleanup = ((failure as Error).cause as AggregateError).errors[1] as Error;
    expect((cleanup.cause as { status: number | null }).status).not.toBeNull();
  }, 60_000);
  it('judges the settle window by when an inspect was asked, not when it answered', async () => {
    // An absent answer asked inside the window, but arriving after it, while the create lands: not proof of absence.
    writeFileSync(mode, 'hang'); writeFileSync(slowLand, '');
    await expect(probeTaskStoragePathIdentity(imageId, 500)).rejects.toThrow('client killed or not started');
    // The interleaving this test is about: the slow inspect answered "absent" (it was not cut at its deadline), the
    // create landed while it ran, and cleanup asked again after it.
    expect(existsSync(slowAnswered)).toBe(true);
    expect(existsSync(landAt)).toBe(true);
    expect(readFileSync(inspects, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(6);
    // And a later rm removed it.
    expect(existsSync(removed)).toBe(true);
  }, 60_000);
  it('gives up 30 s after the settle window by default', async () => {
    // The production default: an unreachable daemon (no daemon answer, so the 10 s window applies), then 30 s of asks.
    writeFileSync(mode, 'unreachable');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('may remain');
    const elapsed = performance.now() - started;
    // 10 s settle + 30 s of asks; each fake call answers at once, so the overshoot is the last pause and call.
    expect(elapsed).toBeGreaterThanOrEqual(40_000);
    expect(elapsed).toBeLessThan(43_000);
  }, 90_000);
  it('gives each cleanup call the time left, capped at exactly 10 s and at least exactly 1 s', () => {
    // Pinned in both directions; the timing tests above show the call actually uses this deadline.
    expect([-5, 0, 1, 999, 999.2, 1_000, 1_001, 4_200.5, 9_999, 10_000, 10_001, 40_000].map(probeCleanupCallMs))
      .toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_001, 4_201, 9_999, 10_000, 10_000, 10_000]);
  });
});

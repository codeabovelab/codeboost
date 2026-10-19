import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION, buildAgentImage } from '../agents/container/image.ts';
import { probeTaskStoragePathIdentity } from '../agents/container/storage.ts';

// The probe's own handling of Docker's answers (#162), against a `docker` on PATH that answers as the daemon would. The
// measurement itself runs against real Docker in runner-workspace.test.ts.
const root = mkdtempSync(join(tmpdir(), 'codeboost-probe-')), bin = join(root, 'bin');
const calls = join(root, 'calls'), mode = join(root, 'mode'), landAt = join(root, 'land-at'), removed = join(root, 'removed');
const busy = join(root, 'busy'), stuck = join(root, 'stuck');
const savedPath = process.env.PATH;
let imageId = '';
beforeAll(() => {
  mkdirSync(bin, { mode: 0o700 });
  const image = JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}`, Config: { User: '10001:10001', Labels: { 'org.opencontainers.image.base.name': BASE_IMAGE,
    'io.codeboost.codex.version': CODEX_VERSION, 'io.codeboost.claude.version': CLAUDE_VERSION, 'io.codeboost.profile.version': '1' } } }]);
  // `run`: per the mode file, answer, refuse as the daemon does, or hang until the client is killed. In `late` mode the
  // create lands two seconds later, after the client is gone. `rm --force` and `container inspect` answer as Docker 27
  // does: rm exits 0 whether or not the name exists (printing "No such container" when it does not); inspect exits 1.
  // While the busy file holds a count, rm refuses as Docker does during an auto-remove; with the stuck file, a removed
  // container is still reported.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
exists() { { [ ! -e '${removed}' ] || [ -e '${stuck}' ]; } && [ -e '${landAt}' ] && [ "$(date +%s)" -ge "$(cat '${landAt}')" ]; }
if [ "$1 $2" = "image inspect" ]; then printf '%s' '${image}'; exit 0; fi
if [ "$1" = run ]; then
  case "$(cat '${mode}')" in
    answer) echo 'codeboost-path-identity true none';;
    refused) echo 'docker: Error response from daemon: no such runtime' >&2; exit 125;;
    created) echo 0 > '${landAt}'; exec sleep 30;;
    late) echo $(( $(date +%s) + 2 )) > '${landAt}'; exec sleep 30;;
    hang) exec sleep 30;;
  esac
fi
if [ "$1" = rm ]; then
  if [ -s '${busy}' ] && [ "$(cat '${busy}')" -gt 0 ]; then
    echo $(( $(cat '${busy}') - 1 )) > '${busy}'
    echo "Error response from daemon: removal of container $4 is already in progress" >&2; exit 1
  fi
  if exists; then : > '${removed}'; else echo "Error response from daemon: No such container: $4" >&2; fi
  exit 0
fi
if [ "$1 $2" = "container inspect" ]; then
  if exists; then echo '[{}]'; exit 0; fi
  echo "Error response from daemon: No such container: $3" >&2; exit 1
fi
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  imageId = buildAgentImage();
});
afterAll(() => { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { for (const file of [calls, landAt, removed, busy, stuck]) if (existsSync(file)) rmSync(file); });
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
  it('removes its container and volume by name when the daemon refuses the run, and confirms it is gone', async () => {
    writeFileSync(mode, 'refused');
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('docker run failed (exit 125): docker: Error response from daemon: no such runtime');
    expect(removals()).toEqual([`rm --force --volumes ${probeName()}`, `container inspect ${probeName()}`]);
  });
  it('removes a container a killed client left created but never started', async () => {
    writeFileSync(mode, 'created');
    await expect(probeTaskStoragePathIdentity(imageId, 500)).rejects.toThrow('docker run failed (client killed or not started)');
    expect(removals()).toContain(`rm --force --volumes ${probeName()}`);
    expect(left()).toBe(false);
  }, 60_000);
  it('removes a create that lands after the killed client, within the settle window', async () => {
    // The first removals find nothing (rm still exits 0); only asking until the window closes catches the late create.
    writeFileSync(mode, 'late');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId, 500)).rejects.toThrow('client killed or not started');
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
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
  it('asks again while Docker refuses the removal for now, and keeps the probe failure as the error', async () => {
    writeFileSync(mode, 'refused'); writeFileSync(busy, '2');
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('docker run failed (exit 125)');
    expect(removals()).toEqual([...Array(3).fill(`rm --force --volumes ${probeName()}`), `container inspect ${probeName()}`]);
  });
  it('gives up when Docker keeps reporting the container, and names it for the person to remove', async () => {
    writeFileSync(mode, 'created'); writeFileSync(stuck, '');
    const failure = await probeTaskStoragePathIdentity(imageId, 500, 1_000).catch((error: Error) => error);
    const name = probeName();
    expect((failure as Error).message).toBe('docker run failed (client killed or not started): docker run ETIMEDOUT after 500 ms.'
      + ` The probe container ${name} may remain; remove it with docker rm --force --volumes ${name}.`);
    const cause = (failure as Error).cause as AggregateError;
    expect(cause.errors.map((error: Error) => error.message)).toEqual([expect.stringMatching(/^docker run failed/), `Docker still reports ${name} after removing it.`]);
  }, 60_000);
  it('removes nothing when the client was refused before it started', async () => {
    writeFileSync(mode, 'answer');
    // A deadline runInProcessGroup refuses (NOT_STARTED): nothing reached Docker.
    await expect(probeTaskStoragePathIdentity(imageId, 0)).rejects.toThrow('Process deadline must be a positive integer');
    expect(existsSync(calls)).toBe(false);
  });
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE_IMAGE, CLAUDE_VERSION, CODEX_VERSION, buildAgentImage } from '../agents/container/image.ts';
import { probeTaskStoragePathIdentity } from '../agents/container/storage.ts';

// The probe's own handling of Docker's answers (#162), against a `docker` on PATH that answers as the daemon would. The
// measurement itself runs against real Docker in runner-workspace.test.ts.
const root = mkdtempSync(join(tmpdir(), 'codeboost-probe-')), bin = join(root, 'bin');
const calls = join(root, 'calls'), mode = join(root, 'mode'), removals = join(root, 'removals');
const savedPath = process.env.PATH;
let imageId = '';
beforeAll(() => {
  mkdirSync(bin, { mode: 0o700 });
  const image = JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}`, Config: { User: '10001:10001', Labels: { 'org.opencontainers.image.base.name': BASE_IMAGE,
    'io.codeboost.codex.version': CODEX_VERSION, 'io.codeboost.claude.version': CLAUDE_VERSION, 'io.codeboost.profile.version': '1' } } }]);
  // `run`: per the mode file, answer, refuse as the daemon does, or hang until the client is killed (a create that may have
  // landed). `rm`: per the removals file, report the container removed or absent.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ "$1 $2" = "image inspect" ]; then printf '%s' '${image}'; exit 0; fi
if [ "$1" = run ]; then
  case "$(cat '${mode}')" in
    answer) echo 'codeboost-path-identity true none';;
    refused) echo 'docker: Error response from daemon: no such runtime' >&2; exit 125;;
    hang) exec sleep 30;;
  esac
fi
if [ "$1" = rm ]; then
  if [ "$(cat '${removals}')" = removed ]; then exit 0; fi
  echo "Error response from daemon: No such container: $4" >&2; exit 1
fi
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  imageId = buildAgentImage();
});
afterAll(() => { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { if (existsSync(calls)) rmSync(calls); writeFileSync(removals, 'absent'); });
const logged = () => readFileSync(calls, 'utf8').trim().split('\n').filter(line => !line.startsWith('build ') && !line.startsWith('image '));
const probeName = () => /--name (codeboost-path-identity-[0-9a-f-]{36}) /.exec(logged()[0]!)![1]!;

describe('task storage probe against Docker answers', () => {
  it('reads the identity from a probe that ran, and removes nothing by hand (--rm did)', async () => {
    writeFileSync(mode, 'answer');
    expect(await probeTaskStoragePathIdentity(imageId)).toEqual({ caseSensitive: true, unicodeNormalization: 'none' });
    expect(logged()).toHaveLength(1);
  });
  it('removes its container and volume by name when the daemon refuses the run', async () => {
    writeFileSync(mode, 'refused');
    await expect(probeTaskStoragePathIdentity(imageId)).rejects.toThrow('docker run failed (exit 125): docker: Error response from daemon: no such runtime');
    expect(logged().slice(1)).toEqual([`rm --force --volumes ${probeName()}`]);
  });
  it('removes a container a killed client may have created but never started', async () => {
    writeFileSync(mode, 'hang'); writeFileSync(removals, 'removed');
    await expect(probeTaskStoragePathIdentity(imageId, 500)).rejects.toThrow('docker run failed (client killed or not started)');
    expect(logged().slice(1)).toEqual([`rm --force --volumes ${probeName()}`]);
  }, 30_000);
  it('keeps asking through the settle window while a killed create may still land', async () => {
    writeFileSync(mode, 'hang');
    const started = performance.now();
    await expect(probeTaskStoragePathIdentity(imageId, 500)).rejects.toThrow('client killed or not started');
    // Absent at every ask, so it asked until the window closed rather than trusting the first answer.
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(logged().slice(1).length).toBeGreaterThan(1);
    expect(new Set(logged().slice(1))).toEqual(new Set([`rm --force --volumes ${probeName()}`]));
  }, 60_000);
});

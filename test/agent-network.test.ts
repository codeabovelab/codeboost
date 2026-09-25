import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentImage } from '../agents/container/image.ts';
import { assertVendorNetwork, createVendorNetwork, removeVendorNetwork, VENDOR_HOSTS,
  type VendorNetwork } from '../agents/network/network.ts';
import { captureInvocation } from '../agents/contract.ts';

let imageId = '', network: VendorNetwork;
const invocation = captureInvocation({
  clone: { id: 'clone-network', taskId: 'task-network', directory: '/tmp/network', head: 'a'.repeat(40) },
  vendor: 'claude', phase: 'planning', approvedArgv: [], deadline: Date.now() + 60_000, attemptId: 'network-probe',
  context: { snapshotId: 's', planId: 'p', planRevision: 1, assignmentId: 'a', referencedCodeHash: 'c', stateVersion: 1 },
});
const docker = (...args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const curl = (url: string, direct = false) => spawnSync('docker', ['run', '--rm', `--network=${network.name}`,
  '--env', `HTTPS_PROXY=${network.proxyUrl}`, ...(direct ? ['--env', 'NO_PROXY=*'] : []),
  '--entrypoint', 'curl', imageId, '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}',
  '--max-time', '15', url], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  imageId = buildAgentImage();
  network = createVendorNetwork(invocation, imageId);
}, 10 * 60_000);
afterAll(() => removeVendorNetwork(network), 60_000);

describe('vendor-only egress', () => {
  it('keeps failed allocation and its cleanup inside the caller deadline', () => {
    const shim = mkdtempSync(join(tmpdir(), 'docker-shim-'));
    const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
    // Every network operation hangs, so both setup and cleanup can only end by deadline.
    writeFileSync(join(shim, 'docker'), ['#!/bin/sh', 'if [ "$1" = network ]; then exec sleep 30; fi',
      `exec '${realDocker}' "$@"`].join('\n'), { mode: 0o755 });
    const path = process.env.PATH, started = performance.now();
    process.env.PATH = `${shim}:${path}`;
    try { expect(() => createVendorNetwork(invocation, imageId, 3_000)).toThrow(); }
    finally { process.env.PATH = path; rmSync(shim, { recursive: true, force: true }); }
    expect(performance.now() - started).toBeLessThan(6_000);
  }, 60_000);

  it('pins the host list with each vendor profile', () => {
    expect(VENDOR_HOSTS).toEqual({ claude: ['api.anthropic.com'], codex: ['api.openai.com', 'chatgpt.com'] });
    expect(Object.isFrozen(VENDOR_HOSTS.claude)).toBe(true);
    expect(Object.isFrozen(VENDOR_HOSTS.codex)).toBe(true);
  });

  it('reaches the vendor through the proxy while blocking other and direct hosts', () => {
    const vendor = curl('https://api.anthropic.com/');
    expect(vendor.status).toBe(0);
    expect(vendor.stdout).toMatch(/^\d{3}$/);
    expect(vendor.stdout).not.toBe('000');

    const other = curl('https://example.com/');
    expect(other.status).not.toBe(0);
    expect(other.stdout).toBe('000');
    expect(other.stderr).toContain('response 403');

    const direct = curl('https://example.com/', true);
    expect(direct.status).not.toBe(0);
    expect(direct.stdout).toBe('000');
  }, 60_000);

  it('does not forward arbitrary DNS even when the embedded resolver is addressed directly', () => {
    const result = spawnSync('docker', ['run', '--rm', `--network=${network.name}`, '--dns=127.0.0.1',
      '--entrypoint', 'node', imageId, '-e', [
        "const dns=require('node:dns');dns.setServers(['127.0.0.11']);",
        "dns.resolve4('example.com',(error)=>process.exit(error?0:1));",
        'setTimeout(()=>process.exit(0),3000);',
      ].join('')], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(result.status).toBe(0);
  }, 30_000);

  it('rejects a copied network capability', () => {
    expect(() => createVendorNetwork(invocation, imageId, 0)).toThrow('positive integer');
    expect(() => assertVendorNetwork(network, invocation, undefined, 0)).toThrow('positive integer');
    expect(() => removeVendorNetwork({ ...network })).toThrow('trusted network builder');
    const otherInvocation = captureInvocation({ ...invocation, attemptId: 'other-network-probe',
      deadline: Date.now() + 60_000 });
    expect(() => assertVendorNetwork(network, otherInvocation)).toThrow('does not belong');
  });

  it('keeps concurrent invocations on separate internal networks', () => {
    const otherInvocation = captureInvocation({ ...invocation, attemptId: 'concurrent-network-probe',
      deadline: Date.now() + 60_000 });
    const other = createVendorNetwork(otherInvocation, imageId), peer = `codeboost-peer-${randomUUID()}`;
    try {
      docker('run', '--detach', '--name', peer, `--network=${network.name}`, '--network-alias', 'codeboost-peer',
        '--entrypoint', 'node', imageId, '-e', "require('node:net').createServer(()=>{}).listen(4567,'0.0.0.0');setInterval(()=>{},1000)");
      const result = spawnSync('docker', ['run', '--rm', `--network=${other.name}`, '--entrypoint', 'node', imageId,
        '-e', "const s=require('node:net').connect(4567,'codeboost-peer');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),3000)"],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(result.status).not.toBe(0);
    } finally {
      spawnSync('docker', ['rm', '--force', peer], { stdio: 'ignore' });
      removeVendorNetwork(other);
    }
  }, 60_000);

  it.each([
    ['host namespace', ['--pid=host']],
    ['extra Node environment', ['--env', 'NODE_OPTIONS=--trace-warnings']],
    ['DNS override', ['--dns=8.8.8.8']],
    ['host override', ['--add-host=api.anthropic.com:127.0.0.1']],
    ['published proxy port', ['--publish=127.0.0.1::3128']],
  ] as const)('rejects a proxy replaced with %s before launch', (_label, extra) => {
    const replacementInvocation = captureInvocation({ ...invocation, attemptId: `mutated-proxy-probe-${randomUUID()}`,
      deadline: Date.now() + 60_000 });
    const replacement = createVendorNetwork(replacementInvocation, imageId);
    const inspected = JSON.parse(docker('container', 'inspect', replacement.proxyContainer))[0] as
      { Config: { Labels: Record<string, string> } };
    const allocation = inspected.Config.Labels['io.codeboost.egress'];
    try {
      docker('rm', '--force', replacement.proxyContainer);
      docker('run', '--detach', '--name', replacement.proxyContainer, '--read-only', '--user', '10001:10001',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=64m', '--memory-swap=64m',
        '--cpus=.25', ...extra, '--network', replacement.name, '--network-alias', 'codeboost-proxy',
        '--label', `io.codeboost.egress=${allocation}`, '--env', `CODEBOOST_ALLOWED_HOSTS=${VENDOR_HOSTS.claude.join(',')}`,
        '--entrypoint', 'node', imageId, '/usr/local/lib/codeboost-egress-proxy.mjs');
      docker('network', 'connect', 'bridge', replacement.proxyContainer);
      expect(() => assertVendorNetwork(replacement, replacementInvocation)).toThrow('network or proxy changed');
    } finally { removeVendorNetwork(replacement); }
  }, 60_000);
});

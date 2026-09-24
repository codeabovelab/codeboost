import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentImage } from '../agents/container/image.ts';
import { createVendorNetwork, removeVendorNetwork, VENDOR_HOSTS, type VendorNetwork } from '../agents/network/network.ts';

let imageId = '', network: VendorNetwork;
const docker = (...args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const curl = (url: string, direct = false) => spawnSync('docker', ['run', '--rm', `--network=${network.name}`,
  '--env', `HTTPS_PROXY=${network.proxyUrl}`, ...(direct ? ['--env', 'NO_PROXY=*'] : []),
  '--entrypoint', 'curl', imageId, '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}',
  '--max-time', '15', url], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  imageId = buildAgentImage();
  network = createVendorNetwork('claude', imageId);
}, 10 * 60_000);
afterAll(() => removeVendorNetwork(network), 60_000);

describe('vendor-only egress', () => {
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

  it('rejects a copied network capability', () => {
    expect(() => createVendorNetwork('claude', imageId, 0)).toThrow('positive integer');
    expect(() => removeVendorNetwork({ ...network })).toThrow('trusted network builder');
  });
});

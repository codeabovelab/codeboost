import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_IMAGE = 'codeboost-agent:node26-codex0.153.4-claude2.1.281';
export const BASE_IMAGE = 'docker.io/library/node:26.7.0-bookworm@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1';
export const CODEX_VERSION = '0.153.4';
export const CLAUDE_VERSION = '2.1.281';

const context = dirname(fileURLToPath(import.meta.url));
const trustedImages = new Set<string>();

export function assertBuiltAgentImage(imageId: string): void {
  if (!trustedImages.has(imageId)) throw new Error('Agent image was not produced by the trusted validated builder.');
}

export function buildAgentImage(timeoutMs = 10 * 60_000): string {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Image build requires a finite positive deadline.');
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error('Agent image build exceeded its overall deadline.');
    return value;
  };
  execFileSync('docker', ['build', '--pull=false', '--tag', AGENT_IMAGE, context], {
    timeout: remaining(), killSignal: 'SIGKILL', stdio: ['ignore', 'inherit', 'inherit'],
  });
  const inspect = JSON.parse(execFileSync('docker', ['image', 'inspect', AGENT_IMAGE], {
    encoding: 'utf8', timeout: remaining(), stdio: ['ignore', 'pipe', 'pipe'],
  }))[0] as { Id?: string; Config?: { User?: string; Labels?: Record<string, string> } };
  remaining();
  const labels = inspect.Config?.Labels ?? {};
  if (!inspect.Id?.startsWith('sha256:') || inspect.Config?.User !== '10001:10001'
    || labels['org.opencontainers.image.base.name'] !== BASE_IMAGE
    || labels['io.codeboost.codex.version'] !== CODEX_VERSION
    || labels['io.codeboost.claude.version'] !== CLAUDE_VERSION
    || labels['io.codeboost.profile.version'] !== '1') throw new Error('Built agent image does not match the pinned profile.');
  trustedImages.add(inspect.Id);
  return inspect.Id;
}

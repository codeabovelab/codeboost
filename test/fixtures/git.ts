import { execFileSync } from 'node:child_process';

/**
 * Runs Git in a test fixture repository with the repository's hardened invocation: an allowlisted environment,
 * no user or system config, no hooks, no lazy fetch and no network protocols. Commit identity comes from the
 * fixture's own repository config.
 */
export function fixtureGit(repository: string, ...args: string[]): string {
  return execFileSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  }).trim();
}

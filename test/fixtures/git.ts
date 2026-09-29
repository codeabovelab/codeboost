import { execFileSync } from 'node:child_process';
import { HARDENED_GIT_OPTIONS, hardenedGitEnvironment } from '../../scripts/git-environment.ts';

/**
 * Runs Git in a test fixture repository with the scripts' hardened invocation: an allowlisted environment,
 * no user or system config, no hooks or lazy fetch, and no network protocols. Commit identity comes from the
 * fixture's own repository config.
 */
export function fixtureGit(repository: string, ...args: string[]): string {
  return execFileSync('git', [...HARDENED_GIT_OPTIONS, ...args],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hardenedGitEnvironment() }).trim();
}

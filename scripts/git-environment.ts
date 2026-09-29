/** Options for the repository's hardened Git invocation: no pager, replace objects, hooks or network protocols. */
export const HARDENED_GIT_OPTIONS = ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];

/**
 * An allowlisted Git environment: PATH plus settings that disable user and system config, prompts and lazy fetch.
 * Nothing else is inherited, because Git also reads variables outside the GIT_ namespace, such as HOME and
 * XDG_CONFIG_HOME for the user's ignore and attributes files.
 */
export function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

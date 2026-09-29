/**
 * The environment a `gh` subprocess gets: what it needs to find itself, authenticate, reach GitHub (including through a
 * proxy or custom CA) and read its own configuration. Nothing else from the server's environment is passed on.
 */
export const GH_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const;

export function ghEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of GH_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  // Never prompt, open a pager or check for updates inside a server.
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}

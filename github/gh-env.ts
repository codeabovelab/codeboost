/**
 * The environment a `gh` subprocess gets: what it needs to find itself, authenticate, reach GitHub (including through a
 * proxy or custom CA) and read its own configuration. Nothing else from the server's environment is passed on.
 */
export const GH_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  // On Linux, gh reads a token kept in the system keyring over the D-Bus session bus.
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows: process creation, gh's config and credential store, and executable lookup.
  'SYSTEMROOT', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
] as const;

export function ghEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of GH_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  // Never prompt, open a pager or check for updates inside a server.
  // `cat` does not exist on Windows; there an empty GH_PAGER turns the pager off.
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: platform === 'win32' ? '' : 'cat', NO_COLOR: '1' };
}

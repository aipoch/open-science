import { join } from 'node:path'
import type { CodeBuddySite } from '../../shared/codebuddy-subscription'
import { augmentedPathEnv } from './shell-path'

export function codeBuddyAccountEnvironment(
  storageRoot: string,
  site: CodeBuddySite
): Record<string, string> {
  const home =
    site === 'internal'
      ? join(storageRoot, 'codebuddy-cn')
      : join(storageRoot, 'codebuddy-accounts', site)
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEBUDDY_CONFIG_DIR: join(home, '.codebuddy'),
    CODEBUDDY_INTERNET_ENVIRONMENT: site,
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1'
  }
}

// The native account must not inherit a gateway, API key, or a vendor profile override.
export function codeBuddyHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = augmentedPathEnv(source)
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      /^(PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.+|SHELL|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)$/i.test(
        key
      )
    )
  )
}

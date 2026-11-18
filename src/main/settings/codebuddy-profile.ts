import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodeBuddyAuthMode, CodeBuddySite } from '../../shared/codebuddy-subscription'
import { augmentedPathEnv } from './shell-path'

export function codeBuddyAccountEnvironment(
  storageRoot: string,
  site: CodeBuddySite,
  mode: CodeBuddyAuthMode = 'isolated'
): Record<string, string> {
  const siteRoot = join(storageRoot, site === 'internal' ? 'codebuddy-cn' : 'codebuddy-intl')
  const home = mode === 'shared' ? homedir() : siteRoot
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEBUDDY_CONFIG_DIR: join(siteRoot, '.codebuddy'),
    CODEBUDDY_INTERNET_ENVIRONMENT: site,
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1'
  }
}

function codeBuddyAuthDirectory(home: string, platform: NodeJS.Platform): string {
  const data =
    platform === 'win32'
      ? join(home, 'AppData', 'Local')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : join(home, '.local', 'share')
  return join(data, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

// The desktop product owns a separate identity. Only check for the profile, never read its credentials.
export function hasWorkBuddyProfile(home = homedir(), platform = process.platform): boolean {
  return existsSync(join(codeBuddyAuthDirectory(home, platform), 'workbuddy-desktop.info'))
}

// CodeBuddy Code 2.185.0 also uses auth.domain during bootstrap. ACP getUserInfo
// identifies the current user but does not identify which regional site issued the login.
export function sharedCodeBuddySiteMatches(
  site: CodeBuddySite,
  home = homedir(),
  platform = process.platform
): boolean {
  const path = join(codeBuddyAuthDirectory(home, platform), 'Tencent-Cloud.coding-copilot.info')
  let record: string
  try {
    record = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('Could not check CodeBuddy sign-in status.')
  }
  // Keep only the issuer for routing. Never expose the record to IPC or logs.
  let domain: unknown
  try {
    domain = JSON.parse(record)?.auth?.domain
  } catch {
    throw new Error('Could not check CodeBuddy sign-in status.')
  }
  return site === 'internal'
    ? domain === 'copilot.tencent.com' ||
        domain === 'www.codebuddy.cn' ||
        domain === 'www.workbuddy.cn'
    : domain === 'www.codebuddy.ai'
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

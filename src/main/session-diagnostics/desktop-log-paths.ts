import { join } from 'node:path'
import { resolveElectronProfile } from '../storage/electron-profile'

export type DesktopLogPaths = { desktopLogPath?: string; legacyDesktopLogPath?: string }

/** Never throws: a missing or unresolvable Desktop profile only omits its log sources. */
export function resolveDesktopLogPaths(options: {
  configRoot: string
  packaged: boolean
  homePath: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): DesktopLogPaths {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  try {
    const profile = resolveElectronProfile({
      configRoot: options.configRoot,
      packaged: options.packaged,
      env,
      appData:
        platform === 'win32'
          ? env.APPDATA || join(options.homePath, 'AppData', 'Roaming')
          : platform === 'darwin'
            ? join(options.homePath, 'Library', 'Application Support')
            : env.XDG_CONFIG_HOME || join(options.homePath, '.config')
    })
    return {
      desktopLogPath: join(profile, 'desktop-logs', 'main.log'),
      legacyDesktopLogPath: join(profile, 'logs', 'main.log')
    }
  } catch {
    return {}
  }
}

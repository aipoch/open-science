import type { App } from 'electron'

// Development Electron must never replace an installed client's protocol association.
export function ensureWindowsProtocolRegistration(
  app: Pick<App, 'isPackaged' | 'isDefaultProtocolClient' | 'setAsDefaultProtocolClient'>,
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath
): boolean {
  if (platform !== 'win32' || !app.isPackaged) return true
  try {
    // isDefaultProtocolClient only compares the command, so also restore a missing URL Protocol
    // marker by refreshing the registration before checking it.
    return (
      app.setAsDefaultProtocolClient('open-science', executable, []) &&
      app.isDefaultProtocolClient('open-science', executable, [])
    )
  } catch {
    // Registry policy/permission failures must not prevent the client from starting.
    return false
  }
}

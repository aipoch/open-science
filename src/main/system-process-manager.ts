import { shell } from 'electron'
import { win32 } from 'node:path'

type OpenProcessManagerPath = (path: string) => Promise<string>

const processManagerPath = (platform: NodeJS.Platform, windowsRoot: string): string | undefined =>
  platform === 'win32' ? win32.join(windowsRoot, 'System32', 'Taskmgr.exe') : undefined

const openWithDesktopShell: OpenProcessManagerPath = (path) => shell.openPath(path)

export const openSystemProcessManager = async (
  platform: NodeJS.Platform = process.platform,
  openPath: OpenProcessManagerPath = openWithDesktopShell
): Promise<boolean> => {
  const path = processManagerPath(
    platform,
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  )
  if (!path) return false
  try {
    return (await openPath(path)).length === 0
  } catch {
    return false
  }
}

export type { OpenProcessManagerPath }

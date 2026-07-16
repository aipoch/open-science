import { app } from 'electron'

import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'
import type { UpdateStrategy } from './strategy'

export type CreateStrategyOptions = {
  // Whether this is a packaged (installed) build. Defaults to app.isPackaged; injectable for tests.
  isPackaged?: boolean
  // Running app version. Defaults to app.getVersion(); injectable for tests.
  version?: string
}

// macOS in-place auto-update (electron-updater / Squirrel.Mac) only works on a packaged build that is
// Developer ID signed. CI signs *stable* mac builds; nightly builds are ad-hoc and dev runs are
// unsigned/unpackaged — both would hit electron-updater's "could not get code signature" error. Gate
// on packaged + a non-prerelease version (nightly is `x.y.z-nightly.<sha>`) so only signed stable
// builds get the in-place path; everything else falls back to the manifest installer flow.
const macCanAutoUpdate = (isPackaged: boolean, version: string): boolean =>
  isPackaged && !version.includes('-')

// Picks the update strategy for the host platform. Windows/Linux always get true in-place auto-update
// via electron-updater. macOS gets it too on signed stable builds (see macCanAutoUpdate); otherwise
// (dev, nightly, or any other platform) it falls back to the manifest installer flow (UpdateService).
export const createUpdateStrategy = (
  platform: NodeJS.Platform = process.platform,
  opts: CreateStrategyOptions = {}
): UpdateStrategy => {
  if (platform === 'win32' || platform === 'linux') return new ElectronUpdaterStrategy()

  const isPackaged = opts.isPackaged ?? app?.isPackaged ?? false
  const version = opts.version ?? app?.getVersion?.() ?? '0.0.0'
  if (platform === 'darwin' && macCanAutoUpdate(isPackaged, version)) {
    return new ElectronUpdaterStrategy()
  }
  return new UpdateService()
}

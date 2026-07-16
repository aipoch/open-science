import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'
import type { UpdateStrategy } from './strategy'

// Picks the update strategy for the host platform. Windows/Linux get true in-place auto-update via
// electron-updater; macOS (and any other platform) falls back to the manifest installer flow because
// Squirrel.Mac auto-update needs a Developer ID signature this build doesn't have yet.
export const createUpdateStrategy = (
  platform: NodeJS.Platform = process.platform
): UpdateStrategy => {
  if (platform === 'win32' || platform === 'linux') return new ElectronUpdaterStrategy()
  return new UpdateService()
}

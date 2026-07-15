import { app } from 'electron'
import { isAbsolute, normalize } from 'node:path'

import {
  DEV_SESSION_DIR_NAME,
  PROD_SESSION_DIR_NAME,
  getSessionPersistenceDir
} from './session-persistence/repository'

// Single dev-aware resolver for the app storage root (DB, sessions, artifacts, notebook all live under
// it). A development-only absolute override supports truly isolated onboarding previews without
// changing HOME — changing HOME breaks the macOS default-keychain lookup and can trigger a dangerous
// "restore default keychain" dialog. Packaged builds always ignore the override.
const resolveStorageRoot = (): string => {
  const previewRoot = process.env.OPEN_SCIENCE_STORAGE_ROOT?.trim()

  if (!app.isPackaged && previewRoot) {
    if (!isAbsolute(previewRoot)) {
      throw new Error('OPEN_SCIENCE_STORAGE_ROOT must be an absolute path.')
    }

    return normalize(previewRoot)
  }

  return getSessionPersistenceDir(
    app.getPath('home'),
    app.isPackaged ? PROD_SESSION_DIR_NAME : DEV_SESSION_DIR_NAME
  )
}

export { resolveStorageRoot }

import { app } from 'electron'

import {
  DEV_SESSION_DIR_NAME,
  PROD_SESSION_DIR_NAME,
  getSessionPersistenceDir
} from './session-persistence/repository'

// Single dev-aware resolver for the app storage root (DB, sessions, artifacts, notebook all live under it).
// Dev builds isolate their data in ~/.open-science-project so parallel development does not pollute the
// real ~/.open-science tree; packaged builds always use the production directory. app.isPackaged is what
// @electron-toolkit/utils' is.dev wraps; using it directly keeps this module importable in unit tests.
const resolveStorageRoot = (): string =>
  getSessionPersistenceDir(
    app.getPath('home'),
    app.isPackaged ? PROD_SESSION_DIR_NAME : DEV_SESSION_DIR_NAME
  )

export { resolveStorageRoot }

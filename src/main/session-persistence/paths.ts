import { join } from 'node:path'

// Production storage lives under ~/.open-science; dev builds use an isolated sibling directory.
export const PROD_SESSION_DIR_NAME = '.open-science'
export const DEV_SESSION_DIR_NAME = '.open-science-project'

// Builds the app-owned session directory in the user's home folder. Kept pure (no electron) so it
// stays unit-testable; the dev/prod choice is applied by the main-only resolveConfigRoot helper.
export const getSessionPersistenceDir = (
  homePath: string,
  dirName: string = PROD_SESSION_DIR_NAME
): string => join(homePath, dirName)

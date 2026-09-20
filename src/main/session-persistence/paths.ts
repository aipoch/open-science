import { join } from 'node:path'

import { PROD_SESSION_DIR_NAME } from '../../shared/config-root'
export { PROD_SESSION_DIR_NAME, DEV_SESSION_DIR_NAME } from '../../shared/config-root'

// Builds the app-owned session directory in the user's home folder. Kept pure (no electron) so it
// stays unit-testable; the dev/prod choice is applied by the main-only resolveConfigRoot helper.
export const getSessionPersistenceDir = (
  homePath: string,
  dirName: string = PROD_SESSION_DIR_NAME
): string => join(homePath, dirName)

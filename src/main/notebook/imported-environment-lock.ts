import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { importedEnvironmentLockMarkerPath } from './runtime-paths'

const LOCK_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u

/**
 * Removes the durable lock material that authorizes exact reuse of an imported environment.
 * Invalid markers are only removed; their contents are never allowed to select filesystem paths.
 */
export const discardImportedEnvironmentLock = (runtimeRoot: string, prefix: string): void => {
  const markerPath = importedEnvironmentLockMarkerPath(prefix)
  if (!existsSync(markerPath)) return

  const checksum = readFileSync(markerPath, 'utf8').trim()
  if (LOCK_CHECKSUM_PATTERN.test(checksum)) {
    const lockDirectory = join(runtimeRoot, 'imported-locks')
    rmSync(join(lockDirectory, `${checksum}.txt`), { force: true })
    rmSync(join(lockDirectory, checksum), { recursive: true, force: true })
  }
  rmSync(markerPath, { force: true })
}

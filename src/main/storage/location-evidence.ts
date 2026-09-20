import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATABLE_DATA_DIRS } from './data-directories'

// Generic caches and uploads occur in unrelated folders, and runtime survives deliberate moves.
// These are content to preserve, but cannot establish a legacy application's research location.
export const hasLegacyResearchData = (root: string): boolean => {
  try {
    if (!lstatSync(root).isDirectory()) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return MIGRATABLE_DATA_DIRS.some(
    (dir) => !['models', 'uploads'].includes(dir) && directoryHasFiles(join(root, dir), 0, true)
  )
}

// Links are content to preserve, but only real directories and regular files establish ownership.
// Never traverse links or hide access failures, including at the initial candidate directory.
export const directoryHasFiles = (
  root: string,
  depth = 0,
  requireRegularFiles = false
): boolean => {
  if (depth > 128) throw new Error(`Cannot verify location: ${root}`)
  try {
    const info = lstatSync(root)
    if (info.isSymbolicLink()) return !requireRegularFiles
    if (!info.isDirectory()) return !requireRegularFiles && info.isFile()
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) =>
        entry.name !== '.DS_Store' &&
        entry.name !== 'desktop.ini' &&
        (entry.isDirectory()
          ? directoryHasFiles(join(root, entry.name), depth + 1, requireRegularFiles)
          : !requireRegularFiles || entry.isFile())
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

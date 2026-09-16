import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATABLE_DATA_DIRS } from './data-directories'

// Generic caches and uploads occur in unrelated folders, and runtime survives deliberate moves.
// These are content to preserve, but cannot establish a legacy application's research location.
export const hasLegacyResearchData = (root: string): boolean =>
  MIGRATABLE_DATA_DIRS.some(
    (dir) => !['models', 'uploads'].includes(dir) && directoryHasFiles(join(root, dir))
  )

// Empty scaffolding is not evidence. Do not follow symlinks or hide access failures.
export const directoryHasFiles = (
  root: string,
  depth = 0,
  ignoredRootEntries: ReadonlySet<string> = new Set()
): boolean => {
  if (depth > 128) throw new Error(`Cannot verify location: ${root}`)
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) =>
        !(depth === 0 && ignoredRootEntries.has(entry.name)) &&
        entry.name !== '.DS_Store' &&
        entry.name !== 'desktop.ini' &&
        (!entry.isDirectory() || directoryHasFiles(join(root, entry.name), depth + 1))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

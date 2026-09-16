import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { hasPendingMigrationMarker } from './migration-marker'
import { directoryHasFiles } from './location-evidence'
export class DataLocationSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataLocationSelectionError'
  }
}
const hasResearchData = (root: string): boolean =>
  MIGRATABLE_DATA_DIRS.some((dir) => directoryHasFiles(join(root, dir)))

// Runtime is relevant to explicit adoption/onboarding, but does not prove the active data root:
// migrations intentionally leave it behind at their source.
export const hasDataRootContent = (root: string): boolean =>
  [...MIGRATABLE_DATA_DIRS, 'runtime'].some((dir) => directoryHasFiles(join(root, dir)))
export const selectDefaultDataRoot = (
  configRoot: string,
  parent: string,
  packaged: boolean,
  existingInstallation?: boolean
): string => {
  // A cleanup journal may refer to a prepared or committed switch. Without settings there is no
  // authoritative pointer to disambiguate those states, even if its source still contains data.
  let entries: string[] = []
  try {
    entries = readdirSync(configRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (
    entries.some(
      (name) => name === 'data-root-cleanup.json' || name.startsWith('data-root-cleanup.json.')
    )
  ) {
    throw new DataLocationSelectionError(
      `A data location migration needs recovery. Restore ${join(configRoot, 'settings.json')} with the verified current dataRoot before restarting. Preserve ${join(configRoot, 'data-root-cleanup.json')} for recovery. No new data location was created.`
    )
  }
  const folder = packaged ? 'Open-Science' : 'Open-Science-DEV'
  const legacyFolder = packaged ? 'OpenScience' : 'OpenScience-DEV'
  const homeDefault = join(parent, folder)
  const roots = [
    ...new Set([
      homeDefault,
      join(parent, legacyFolder),
      join(configRoot, folder),
      join(configRoot, legacyFolder),
      configRoot
    ])
  ]
  const candidates = roots.filter(
    (root) => !hasPendingMigrationMarker(root) && hasResearchData(root)
  )
  const unrecognized = roots.filter(
    (root) =>
      root !== configRoot &&
      !hasPendingMigrationMarker(root) &&
      !hasResearchData(root) &&
      directoryHasFiles(root)
  )
  if (unrecognized.length)
    throw new DataLocationSelectionError(
      `Cannot verify existing data locations. Select or recover the original folder before restarting:\n${unrecognized.join('\n')}`
    )
  const physical = new Map(candidates.map((path) => [realpathSync(path), path]))
  if (physical.size > 1)
    throw new DataLocationSelectionError(
      `Multiple data locations exist. Set dataRoot in ${join(configRoot, 'settings.json')} to the verified existing folder before restarting:\n${candidates.join('\n')}`
    )
  if (candidates.length) return candidates[0]
  // Existing configuration without an identifiable location is a recovery case, not a fresh install.
  if (
    (existingInstallation ?? directoryHasFiles(configRoot)) ||
    roots.some(hasPendingMigrationMarker)
  )
    throw new DataLocationSelectionError(
      `The saved data location is missing. Set dataRoot in ${join(configRoot, 'settings.json')} to the verified existing folder before restarting. No new data location was created.`
    )
  return homeDefault
}

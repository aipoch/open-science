import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { directoryHasFiles, hasLegacyResearchData } from './location-evidence'
export class DataLocationSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataLocationSelectionError'
  }
}

// Runtime is relevant to explicit adoption/onboarding, but does not prove the active data root:
// migrations intentionally leave it behind at their source.
export const hasDataRootContent = (root: string): boolean =>
  [...MIGRATABLE_DATA_DIRS, 'runtime'].some((dir) => directoryHasFiles(join(root, dir)))
// Retain main's pre-dataRoot layout: research lived directly in the configuration root.
// Do not scan default/custom copies or derive a lost selection from profile state.
export const selectDefaultDataRoot = (
  configRoot: string,
  parent: string,
  packaged: boolean
): string => {
  const folder = packaged ? 'Open-Science' : 'Open-Science-DEV'
  const legacyFolder = packaged ? 'OpenScience' : 'OpenScience-DEV'
  const inPlaceLegacy =
    hasLegacyResearchData(configRoot) &&
    !existsSync(join(configRoot, folder)) &&
    !existsSync(join(configRoot, legacyFolder))
  return inPlaceLegacy ? configRoot : join(parent, folder)
}

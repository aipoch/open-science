import { join } from 'node:path'
import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { directoryHasFiles } from './location-evidence'
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

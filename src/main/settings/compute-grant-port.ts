import { SettingsRepository } from './repository'
import type { StoredComputeGrant } from './types'

type SettingsComputeGrantPort = {
  listComputeGrants(): Promise<StoredComputeGrant[]>
  clearComputeGrants(): Promise<void>
  hasComputeGrant(grant: StoredComputeGrant): Promise<boolean>
  addComputeGrant(grant: StoredComputeGrant): Promise<unknown>
}

// Compatibility factory for isolated Compute module construction. Production passes its shared
// repository explicitly, so this fallback never creates a second production arbitration owner.
const createSettingsComputeGrantPort = (storageRoot: string): SettingsComputeGrantPort => {
  const repository = new SettingsRepository(storageRoot)
  return {
    listComputeGrants: () => repository.listComputeGrants(),
    clearComputeGrants: () => repository.clearComputeGrants(),
    hasComputeGrant: (grant) => repository.hasComputeGrant(grant),
    addComputeGrant: (grant) => repository.addComputeGrant(grant)
  }
}

export { createSettingsComputeGrantPort }

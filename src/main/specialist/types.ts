// Main-process-only stored shapes for the specialist profile store (specialists.json).
// No secret fields; systemPrompt is considered non-secret user content.

import type {
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../shared/specialist'

export type SpecialistOrigin = 'local' | 'imported' | 'marketplace'

export type SpecialistImportBaseline = {
  importedAt: string
  archiveDigest: string
  contentDigest: string
  packageContentDigest?: string
  packageVersion?: string
}

// The persisted document stored in specialists.json.
export type StoredSpecialist = {
  id: string // immutable local/package identity
  name: string // public UPPER_SNAKE identifier
  displayName?: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  setupPending?: boolean
  capabilityMode: SpecialistCapabilityMode
  fullAccess: SpecialistFullAccessConfig
  selectedCapabilities: SpecialistSelectedConfig
  revision: number
  packageVersion: string
  origin: SpecialistOrigin
  ownedSkillIds: string[]
  importBaseline?: SpecialistImportBaseline
}

// The whole specialists.json document.
export type StoredSpecialists = {
  version: 2
  specialists: StoredSpecialist[]
}

export const SPECIALISTS_FILE_VERSION = 2 as const

export const createEmptySpecialists = (): StoredSpecialists => ({
  version: SPECIALISTS_FILE_VERSION,
  specialists: []
})

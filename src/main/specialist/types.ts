// Main-process-only stored shapes for the specialist profile store (specialists.json).
// No secret fields; systemPrompt is considered non-secret user content.

import type {
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../shared/specialist'

// The persisted document stored in specialists.json.
export type StoredSpecialist = {
  id: string // immutable UUID
  name: string // public UPPER_SNAKE identifier
  displayName?: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  capabilityMode: SpecialistCapabilityMode
  fullAccess: SpecialistFullAccessConfig
  selectedCapabilities: SpecialistSelectedConfig
  revision: number
}

// The whole specialists.json document.
export type StoredSpecialists = {
  version: 1
  specialists: StoredSpecialist[]
}

export const SPECIALISTS_FILE_VERSION = 1 as const

export const createEmptySpecialists = (): StoredSpecialists => ({
  version: SPECIALISTS_FILE_VERSION,
  specialists: []
})

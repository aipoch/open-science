import type { ClaudeInfo, ProviderType } from '../../shared/settings'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'

// Main-process-only stored shapes for settings.json. These carry the encrypted key reference and a
// non-secret masked hint; the plaintext key never lives here (only transiently in service memory).

// A single stored provider record. `keyRef` is a safeStorage ciphertext (see crypto.ts); `keyMask`
// is a non-secret display hint recomputed whenever the key changes.
export type StoredProvider = {
  id: string
  type: ProviderType
  name: string
  baseUrl?: string
  model?: string
  keyRef?: string
  keyMask?: string
  lastValidatedAt?: number
}

// The whole settings.json document.
export type StoredSettings = {
  version: typeof SETTINGS_FILE_VERSION
  claude?: ClaudeInfo
  activeProviderId?: string
  providers: StoredProvider[]
  // Set once the first-run onboarding wizard has been completed (or auto-completed for an
  // already-configured install). Absent means onboarding has never finished.
  onboardingCompletedAt?: number
}

// Canonical empty settings used for a first run or an unreadable file.
export const createEmptySettings = (): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: []
})

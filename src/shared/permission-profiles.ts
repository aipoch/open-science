// Provider-neutral approval profiles shown in the composer. These are application semantics rather
// than Claude-specific mode ids; the ACP runtime maps them onto capabilities advertised per session.
export const PERMISSION_PROFILE_IDS = ['ask', 'auto', 'full'] as const

export type PermissionProfileId = (typeof PERMISSION_PROFILE_IDS)[number]

export const DEFAULT_PERMISSION_PROFILE: PermissionProfileId = 'ask'

export type PermissionAutoReviewStrategy = 'native' | 'conservative'

// Runtime capability/effective-state projection for one attached session. The selected profile is
// durable chat state; this projection says how the current Agent can actually enforce it.
export type SessionPermissionProfileState = {
  selectedProfile: PermissionProfileId
  effectiveProfile: PermissionProfileId
  currentModeId?: string
  availableModeIds: string[]
  autoReviewStrategy?: PermissionAutoReviewStrategy
  fullAccessAvailable: boolean
  message?: string
}

export const isPermissionProfileId = (value: unknown): value is PermissionProfileId =>
  typeof value === 'string' && PERMISSION_PROFILE_IDS.includes(value as PermissionProfileId)

export const normalizePermissionProfile = (value: unknown): PermissionProfileId =>
  isPermissionProfileId(value) ? value : DEFAULT_PERMISSION_PROFILE

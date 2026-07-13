import type { SessionModeState } from '@agentclientprotocol/sdk'

import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../shared/permission-profiles'

const DEFAULT_MODE_ID = 'default'
const AUTO_MODE_ID = 'auto'
const FULL_ACCESS_MODE_ID = 'bypassPermissions'

type PermissionProfileApplication = {
  modeId?: string
  state: SessionPermissionProfileState
}

class PermissionProfileUnavailableError extends Error {
  constructor(profile: PermissionProfileId) {
    super(
      profile === 'full'
        ? 'Full access is not available for the current Agent session.'
        : `Permission profile is not available: ${profile}`
    )
    this.name = 'PermissionProfileUnavailableError'
  }
}

const availableModeIds = (modes: SessionModeState | null | undefined): string[] =>
  modes?.availableModes.map((mode) => mode.id) ?? []

// Maps stable application semantics onto the modes advertised by the active Agent. Auto has a
// conservative application fallback; Full access is offered only when bypass is genuinely available.
const resolvePermissionProfileApplication = (
  profile: PermissionProfileId,
  modes: SessionModeState | null | undefined
): PermissionProfileApplication => {
  const modeIds = availableModeIds(modes)
  const hasMode = (modeId: string): boolean => modeIds.includes(modeId)
  const fullAccessAvailable = hasMode(FULL_ACCESS_MODE_ID)

  if (profile === 'full' && !fullAccessAvailable) {
    throw new PermissionProfileUnavailableError(profile)
  }

  if (profile === 'auto') {
    const nativeAuto = hasMode(AUTO_MODE_ID)
    const modeId = nativeAuto
      ? AUTO_MODE_ID
      : hasMode(DEFAULT_MODE_ID)
        ? DEFAULT_MODE_ID
        : undefined

    return {
      modeId,
      state: {
        selectedProfile: profile,
        effectiveProfile: profile,
        currentModeId: modeId ?? modes?.currentModeId,
        availableModeIds: modeIds,
        autoReviewStrategy: nativeAuto ? 'native' : 'conservative',
        fullAccessAvailable,
        ...(!nativeAuto
          ? {
              message:
                'This model does not provide native auto review. Open Science will auto-approve only clearly low-risk workspace operations.'
            }
          : {})
      }
    }
  }

  const modeId = profile === 'full' ? FULL_ACCESS_MODE_ID : DEFAULT_MODE_ID
  const canSetMode = hasMode(modeId)

  return {
    modeId: canSetMode ? modeId : undefined,
    state: {
      selectedProfile: profile,
      effectiveProfile: profile,
      currentModeId: canSetMode ? modeId : modes?.currentModeId,
      availableModeIds: modeIds,
      fullAccessAvailable
    }
  }
}

// Keeps effective state truthful if the Agent changes modes autonomously or clamps a model switch.
const applyCurrentModeUpdate = (
  state: SessionPermissionProfileState,
  currentModeId: string
): SessionPermissionProfileState => {
  if (currentModeId === FULL_ACCESS_MODE_ID) {
    return {
      ...state,
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId,
      autoReviewStrategy: undefined,
      message: undefined
    }
  }

  if (currentModeId === AUTO_MODE_ID) {
    return {
      ...state,
      selectedProfile: 'auto',
      effectiveProfile: 'auto',
      currentModeId,
      autoReviewStrategy: 'native',
      message: undefined
    }
  }

  if (currentModeId === DEFAULT_MODE_ID && state.selectedProfile !== 'auto') {
    return {
      ...state,
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId,
      autoReviewStrategy: undefined,
      message: undefined
    }
  }

  return { ...state, currentModeId }
}

export {
  AUTO_MODE_ID,
  DEFAULT_MODE_ID,
  FULL_ACCESS_MODE_ID,
  PermissionProfileUnavailableError,
  applyCurrentModeUpdate,
  resolvePermissionProfileApplication
}
export type { PermissionProfileApplication }

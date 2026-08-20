import type { ComputeAuthenticationErrorCode } from '../../../shared/compute'
import {
  settingsPanelRoute,
  type SettingsPanelId,
  type SettingsRoute
} from '../pages/settings/settings-navigation'

export type SettingsNavigationIntent = Readonly<{
  requestId: number
  route: SettingsRoute
}>

let settingsNavigationRequestId = 0

export type SettingsNavigationState = {
  isSettingsOpen: boolean
  pendingSettingsIntent?: SettingsNavigationIntent
}

export type SettingsNavigationActions = {
  openSettings: () => void
  openSettingsToPanel: (panel: SettingsPanelId) => void
  closeSettings: () => void
  openSettingsToSkill: (skillId: string) => void
  openSettingsToSpecialist: (specialistId: string) => void
  openSettingsToCompute: () => void
  openSettingsToComputeHost: (providerId: string) => void
  openSettingsToComputeAuthentication: (
    providerId: string,
    errorCode: ComputeAuthenticationErrorCode
  ) => void
  consumePendingSettingsIntent: (requestId: number) => void
}

type SettingsNavigationSliceOptions = {
  getState: () => SettingsNavigationState
  setState: (patch: Partial<SettingsNavigationState>) => void
}

export const createInitialSettingsNavigationState = (): SettingsNavigationState => ({
  isSettingsOpen: false,
  pendingSettingsIntent: undefined
})

// Owns global dialog visibility and a one-shot landing intent. Caller-facing actions remain stable;
// route construction, mutual exclusion, and repeated-intent identity stay behind this module's seam.
export const createSettingsNavigationSlice = ({
  getState,
  setState
}: SettingsNavigationSliceOptions): SettingsNavigationActions => {
  const openTo = (route: SettingsRoute): void =>
    setState({
      isSettingsOpen: true,
      pendingSettingsIntent: { requestId: ++settingsNavigationRequestId, route }
    })

  return {
    openSettings: () => setState({ isSettingsOpen: true }),

    openSettingsToPanel: (panel) => openTo(settingsPanelRoute(panel)),

    closeSettings: () =>
      setState({
        isSettingsOpen: false,
        pendingSettingsIntent: undefined
      }),

    openSettingsToSkill: (skillId) =>
      openTo({ panel: 'skills', view: { kind: 'detail', id: skillId } }),

    openSettingsToSpecialist: (specialistId) =>
      openTo({ panel: 'specialists', view: { kind: 'edit', id: specialistId } }),

    openSettingsToCompute: () => openTo({ panel: 'compute', view: { kind: 'list' } }),

    openSettingsToComputeHost: (providerId) =>
      openTo({ panel: 'compute', view: { kind: 'detail', providerId } }),

    openSettingsToComputeAuthentication: (providerId, errorCode) => {
      const requestId = ++settingsNavigationRequestId
      setState({
        isSettingsOpen: true,
        pendingSettingsIntent: {
          requestId,
          route: {
            panel: 'compute',
            view: {
              kind: 'detail',
              providerId,
              authenticationFocus: errorCode,
              authenticationRequestId: requestId
            }
          }
        }
      })
    },

    consumePendingSettingsIntent: (requestId) => {
      if (getState().pendingSettingsIntent?.requestId !== requestId) return
      setState({ pendingSettingsIntent: undefined })
    }
  }
}

import type { ComputeAuthenticationErrorCode } from '@aipoch/compute'

import {
  settingsPanelRoute,
  type SettingsPanelId,
  type SettingsRoute
} from '@/lib/settings-navigation'
import { rememberSettingsReturnFocusTarget } from './settings-return-focus'

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
  openSettingsToProvider: (providerId: string, model?: string) => void
  openSettingsToConnector: (id: string) => void
  openSettingsToClassification: () => void
  openSettingsToOpenAlex: () => void
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
  openNative?: (route?: SettingsRoute) => boolean
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
  openNative,
  setState
}: SettingsNavigationSliceOptions): SettingsNavigationActions => {
  const openTo = (route: SettingsRoute, requestId = ++settingsNavigationRequestId): void => {
    if (openNative?.(route)) return
    rememberSettingsReturnFocusTarget(getState().isSettingsOpen)
    setState({
      isSettingsOpen: true,
      pendingSettingsIntent: { requestId, route }
    })
  }

  return {
    openSettings: () => {
      if (openNative?.()) return
      rememberSettingsReturnFocusTarget(getState().isSettingsOpen)
      setState({ isSettingsOpen: true })
    },

    openSettingsToPanel: (panel) => openTo(settingsPanelRoute(panel)),
    openSettingsToProvider: (providerId, model) =>
      openTo({
        panel: 'model',
        view: { kind: 'list', recoveryProviderId: providerId, recoveryModel: model }
      }),
    openSettingsToConnector: (id) =>
      openTo({ panel: 'connectors', view: { kind: 'list', recoveryConnectorId: id } }),
    openSettingsToClassification: () =>
      openTo({ panel: 'model', view: { kind: 'classification' } }),
    openSettingsToOpenAlex: () =>
      openTo({ panel: 'credentials', view: { kind: 'service', serviceId: 'openalex' } }),

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
      rememberSettingsReturnFocusTarget(getState().isSettingsOpen)
      const requestId = ++settingsNavigationRequestId
      openTo(
        {
          panel: 'compute',
          view: {
            kind: 'detail',
            providerId,
            authenticationFocus: errorCode,
            authenticationRequestId: requestId
          }
        },
        requestId
      )
    },

    consumePendingSettingsIntent: (requestId) => {
      if (getState().pendingSettingsIntent?.requestId !== requestId) return
      setState({ pendingSettingsIntent: undefined })
    }
  }
}

import type { SettingsPanelId } from '../pages/settings/settings-navigation'
import type { ComputeAuthenticationErrorCode } from '../../../shared/compute'

export type ComputeAuthenticationTarget = Readonly<{
  providerId: string
  errorCode: ComputeAuthenticationErrorCode
  requestId: number
}>

let computeAuthenticationRequestId = 0

export type SettingsNavigationState = {
  isSettingsOpen: boolean
  pendingSettingsPanel?: SettingsPanelId
  pendingSkillId?: string
  pendingSpecialistId?: string
  pendingComputeAuthentication?: ComputeAuthenticationTarget
}

export type SettingsNavigationActions = {
  openSettings: () => void
  openSettingsToPanel: (panel: SettingsPanelId) => void
  closeSettings: () => void
  openSettingsToSkill: (skillId: string) => void
  openSettingsToSpecialist: (specialistId: string) => void
  openSettingsToCompute: () => void
  openSettingsToComputeAuthentication: (
    providerId: string,
    errorCode: ComputeAuthenticationErrorCode
  ) => void
  consumePendingSettingsPanel: () => void
  consumePendingSkill: () => void
  consumePendingSpecialist: () => void
  consumePendingComputeAuthentication: () => void
}

type SettingsNavigationSliceOptions = {
  setState: (patch: Partial<SettingsNavigationState>) => void
}

export const createInitialSettingsNavigationState = (): SettingsNavigationState => ({
  isSettingsOpen: false,
  pendingSettingsPanel: undefined,
  pendingSkillId: undefined,
  pendingSpecialistId: undefined,
  pendingComputeAuthentication: undefined
})

// Owns only the global dialog visibility and one-shot external landing targets. SettingsPage keeps
// its local breadcrumb/history stack and consumes these targets through the compatibility store.
export const createSettingsNavigationSlice = ({
  setState
}: SettingsNavigationSliceOptions): SettingsNavigationActions => ({
  openSettings: () => setState({ isSettingsOpen: true }),

  openSettingsToPanel: (panel) =>
    setState({
      isSettingsOpen: true,
      pendingSettingsPanel: panel,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined,
      pendingComputeAuthentication: undefined
    }),

  closeSettings: () =>
    setState({
      isSettingsOpen: false,
      pendingSettingsPanel: undefined,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined,
      pendingComputeAuthentication: undefined
    }),

  openSettingsToSkill: (skillId) =>
    setState({
      isSettingsOpen: true,
      pendingSettingsPanel: undefined,
      pendingSkillId: skillId,
      pendingSpecialistId: undefined,
      pendingComputeAuthentication: undefined
    }),

  openSettingsToSpecialist: (specialistId) =>
    setState({
      isSettingsOpen: true,
      pendingSettingsPanel: undefined,
      pendingSkillId: undefined,
      pendingSpecialistId: specialistId,
      pendingComputeAuthentication: undefined
    }),

  openSettingsToCompute: () =>
    setState({
      isSettingsOpen: true,
      pendingSettingsPanel: 'compute',
      pendingSkillId: undefined,
      pendingSpecialistId: undefined,
      pendingComputeAuthentication: undefined
    }),

  openSettingsToComputeAuthentication: (providerId, errorCode) =>
    setState({
      isSettingsOpen: true,
      pendingSettingsPanel: undefined,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined,
      pendingComputeAuthentication: {
        providerId,
        errorCode,
        requestId: ++computeAuthenticationRequestId
      }
    }),

  consumePendingSettingsPanel: () => setState({ pendingSettingsPanel: undefined }),
  consumePendingSkill: () => setState({ pendingSkillId: undefined }),
  consumePendingSpecialist: () => setState({ pendingSpecialistId: undefined }),
  consumePendingComputeAuthentication: () => setState({ pendingComputeAuthentication: undefined })
})

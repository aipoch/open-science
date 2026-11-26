import type { useSettingsStore } from '@/stores/settings-store'
import type { SettingsSnapshot } from '../../../../shared/settings'
import { KILO_FREE_MODEL_ID } from '../../../../shared/provider-model-catalog'

// A failed refresh preserves the previous report for diagnostics. Only a current, successful
// check may unlock onboarding for the selected runtime.
export const selectAgentEnvironmentReady = (
  state: Pick<
    ReturnType<typeof useSettingsStore.getState>,
    'isCheckingEnvironment' | 'environmentCheckError' | 'environmentCheck' | 'agentFrameworkId'
  >
): boolean =>
  !state.isCheckingEnvironment &&
  !state.environmentCheckError &&
  state.environmentCheck?.ready === true &&
  state.environmentCheck.agentFrameworkId === state.agentFrameworkId

export const selectFreeKiloActive = (
  state: Pick<SettingsSnapshot, 'providers' | 'activeProviderId' | 'activeModel'>
): boolean => {
  const provider = state.providers.find(({ id }) => id === state.activeProviderId)
  return (
    provider?.type === 'official' &&
    provider.vendorId === 'kilo' &&
    (state.activeModel ?? provider.model) === KILO_FREE_MODEL_ID
  )
}

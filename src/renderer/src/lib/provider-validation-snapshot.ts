import { useSettingsStore } from '@/stores/settings-store'

export type ProviderValidationSnapshot = Record<string, number | undefined>

// Compare host-issued validation values, never the renderer's potentially different clock.
export const captureProviderValidationSnapshot = (): ProviderValidationSnapshot =>
  Object.fromEntries(
    useSettingsStore.getState().providers.map(({ id, lastValidatedAt }) => [id, lastValidatedAt])
  )

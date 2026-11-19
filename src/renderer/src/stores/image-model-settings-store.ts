import { create } from 'zustand'
import type {
  ImageModelSettingsSnapshot,
  ImageModelSettingsMutation
} from '../../../shared/image-model-settings'

type SettingsState = {
  snapshot?: ImageModelSettingsSnapshot
  loadFailed: boolean
  reload(): Promise<void>
  mutate(request: ImageModelSettingsMutation): Promise<void>
}

// Serialize writes with reads so an older response cannot replace newly saved settings.
let pending: Promise<void> | undefined
const load = (request?: ImageModelSettingsMutation): Promise<void> => {
  if (!request && pending) return pending
  const run = (pending ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        const snapshot = request
          ? await window.api.settings.updateImageModels(request)
          : await window.api.settings.getImageModels()
        useImageModelSettingsStore.setState({ snapshot, loadFailed: false })
      } catch (error) {
        if (!request) useImageModelSettingsStore.setState({ loadFailed: true })
        throw error
      }
    })
  pending = run
  void run
    .finally(() => {
      if (pending === run) pending = undefined
    })
    .catch(() => {})
  return run
}
export const useImageModelSettingsStore = create<SettingsState>(() => ({
  loadFailed: false,
  reload: () => load(),
  mutate: (request) => load(request)
}))

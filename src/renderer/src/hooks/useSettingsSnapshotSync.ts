import { useEffect } from 'react'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
// Both windows share Main's committed revision; neither installs another persistence writer.
export const useSettingsSnapshotSync = (): void => {
  useEffect(
    () => window.api.compute?.onHostsChanged?.(() => useComputeStore.getState().invalidateHosts()),
    []
  )
  useEffect(
    () =>
      window.api.settings.onChanged?.((snapshot) => {
        useSettingsStore.getState().acceptCommittedSnapshot(snapshot)
      }),
    []
  )
}

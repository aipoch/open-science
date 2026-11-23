import { useEffect, useRef, useState } from 'react'
import { useImageModelSettingsStore } from '@/stores/image-model-settings-store'
import type {
  ImageModelSettingsMutation,
  ImageModelSettingsSnapshot
} from '../../../../shared/image-model-settings'

export const useImageModelSettings = (): {
  snapshot?: ImageModelSettingsSnapshot
  busy: boolean
  saved?: { appliesNextTurn: boolean }
  failed?: 'load' | 'save'
  reload: () => Promise<void>
  mutate: (request: ImageModelSettingsMutation) => Promise<boolean>
} => {
  const snapshot = useImageModelSettingsStore((state) => state.snapshot)
  const [busy, setBusy] = useState(true)
  const [saved, setSaved] = useState<{ appliesNextTurn: boolean }>()
  const [failed, setFailed] = useState<'load' | 'save'>()
  const generation = useRef(0)
  const pending = useRef(false)
  const run = async (request?: ImageModelSettingsMutation): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    const token = ++generation.current
    setBusy(true)
    setFailed(undefined)
    setSaved(undefined)
    try {
      await (request
        ? useImageModelSettingsStore.getState().mutate(request)
        : useImageModelSettingsStore.getState().reload())
      if (token !== generation.current) return false
      if (request)
        setSaved({
          appliesNextTurn:
            request.kind === 'bind' ||
            snapshot?.imageModel?.serviceId === request.id ||
            useImageModelSettingsStore.getState().snapshot?.imageModel?.serviceId === request.id
        })
      return true
    } catch {
      if (token === generation.current) setFailed(request ? 'save' : 'load')
      return false
    } finally {
      if (token === generation.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  const reload = async (): Promise<void> => {
    await run()
  }
  useEffect(() => {
    const token = ++generation.current
    pending.current = true
    void useImageModelSettingsStore
      .getState()
      .reload()
      .then(
        () => {},
        () => {
          if (token === generation.current) setFailed('load')
        }
      )
      .finally(() => {
        if (token === generation.current) {
          pending.current = false
          setBusy(false)
        }
      })
    return () => {
      generation.current += 1
      pending.current = false
    }
  }, [])
  return { snapshot, busy, saved, failed, reload, mutate: run }
}

import { afterEach, expect, it, vi } from 'vitest'
import { useImageModelSettingsStore } from './image-model-settings-store'
import type { ImageModelSettingsSnapshot } from '../../../shared/image-model-settings'

afterEach(() => {
  vi.unstubAllGlobals()
  useImageModelSettingsStore.setState({ snapshot: undefined, loadFailed: false })
})
it('shares pending reads and orders saves after them without restoring stale settings', async () => {
  const old: ImageModelSettingsSnapshot = { services: [], availableProviders: [] }
  const next = { ...old, imageModel: { serviceId: 'service', modelId: 'model' } }
  let finish!: (value: ImageModelSettingsSnapshot) => void
  const get = vi.fn(
    () =>
      new Promise<ImageModelSettingsSnapshot>((resolve) => {
        finish = resolve
      })
  )
  const update = vi.fn(async () => next)
  vi.stubGlobal('window', { api: { settings: { getImageModels: get, updateImageModels: update } } })
  const owner = useImageModelSettingsStore.getState()
  const first = owner.reload()
  expect(owner.reload()).toBe(first)
  const save = owner.mutate({ kind: 'bind', binding: next.imageModel })
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  expect(update).not.toHaveBeenCalled()
  finish(old)
  await Promise.all([first, save])
  expect(useImageModelSettingsStore.getState().snapshot).toEqual(next)
  update.mockRejectedValueOnce(new Error('write failed'))
  await expect(owner.mutate({ kind: 'bind' })).rejects.toThrow('write failed')
  expect(useImageModelSettingsStore.getState().snapshot).toEqual(next)
})

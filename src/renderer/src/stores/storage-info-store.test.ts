import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StorageInfo, StorageStatus } from '../../../shared/storage'
import { STORAGE_INFO_FRESH_MS, useStorageInfoStore } from './storage-info-store'

const storageInfo = (totalBytes: number): StorageInfo => ({
  dataRoot: '/data',
  isDefault: true,
  defaultDataRoot: '/data',
  defaultParent: '/',
  dataRootMissing: false,
  legacyDataMovePrompt: false,
  cleanupPending: false,
  canAutoSelectDataDrive: false,
  usage: { categories: [], totalBytes },
  availableBytes: 1_000
})

const storageStatus = (): StorageStatus => ({
  dataRoot: '/data',
  isDefault: true,
  defaultDataRoot: '/data',
  defaultParent: '/',
  dataRootMissing: false,
  legacyDataMovePrompt: false,
  cleanupPending: false
})

const setStorageApi = (
  getInfo: ReturnType<typeof vi.fn>,
  getStatus: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(storageStatus())
): void => {
  ;(globalThis as unknown as { window: { api: { storage: unknown } } }).window = {
    api: { storage: { getInfo, getStatus } }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-20T00:00:00Z'))
  useStorageInfoStore.setState({
    status: null,
    info: null,
    scannedAt: null,
    isLoading: false,
    isRefreshing: false,
    loadError: undefined
  })
})

afterEach(() => vi.useRealTimers())

describe('storage info store', () => {
  it('exposes lightweight location status before the usage scan completes', async () => {
    let finishScan!: (info: StorageInfo) => void
    const getInfo = vi.fn(() => new Promise<StorageInfo>((resolve) => (finishScan = resolve)))
    const getStatus = vi.fn().mockResolvedValue(storageStatus())
    setStorageApi(getInfo, getStatus)

    const statusRequest = useStorageInfoStore.getState().loadStatus()
    const scanRequest = useStorageInfoStore.getState().load()
    await statusRequest

    expect(useStorageInfoStore.getState()).toMatchObject({
      status: storageStatus(),
      info: null,
      isLoading: true
    })
    finishScan(storageInfo(10))
    await scanRequest
  })

  it('falls back to the full scan only when an older backend lacks the status command', async () => {
    const getInfo = vi.fn().mockResolvedValue(storageInfo(10))
    const getStatus = vi
      .fn()
      .mockRejectedValue(new Error("No handler registered for 'storage:get-status'"))
    setStorageApi(getInfo, getStatus)

    await useStorageInfoStore.getState().loadStatus()

    expect(getInfo).toHaveBeenCalledOnce()
    expect(useStorageInfoStore.getState()).toMatchObject({
      status: storageInfo(10),
      info: storageInfo(10),
      scannedAt: Date.now()
    })
  })

  it('does not turn a transient status failure into an eager full scan', async () => {
    const getInfo = vi.fn().mockResolvedValue(storageInfo(10))
    const getStatus = vi.fn().mockRejectedValue(new Error('storage temporarily unavailable'))
    setStorageApi(getInfo, getStatus)

    await expect(useStorageInfoStore.getState().loadStatus()).rejects.toThrow(
      'storage temporarily unavailable'
    )

    expect(getInfo).not.toHaveBeenCalled()
  })

  it('reuses a successful usage scan for one day', async () => {
    const getInfo = vi.fn().mockResolvedValue(storageInfo(10))
    setStorageApi(getInfo)

    await useStorageInfoStore.getState().load()
    await useStorageInfoStore.getState().load()

    expect(getInfo).toHaveBeenCalledOnce()
    expect(useStorageInfoStore.getState()).toMatchObject({
      info: storageInfo(10),
      scannedAt: Date.now(),
      isLoading: false,
      isRefreshing: false
    })
  })

  it('keeps the previous snapshot visible while a day-old scan refreshes', async () => {
    let settleRefresh!: (info: StorageInfo) => void
    const getInfo = vi
      .fn()
      .mockResolvedValueOnce(storageInfo(10))
      .mockImplementationOnce(
        () => new Promise<StorageInfo>((resolve) => (settleRefresh = resolve))
      )
    setStorageApi(getInfo)
    await useStorageInfoStore.getState().load()

    vi.setSystemTime(Date.now() + STORAGE_INFO_FRESH_MS)
    const pending = useStorageInfoStore.getState().load()

    expect(useStorageInfoStore.getState()).toMatchObject({
      info: storageInfo(10),
      isRefreshing: true
    })
    settleRefresh(storageInfo(20))
    await pending
    expect(useStorageInfoStore.getState()).toMatchObject({
      info: storageInfo(20),
      isRefreshing: false
    })
  })

  it('forces a manual refresh and preserves the last successful scan on failure', async () => {
    const getInfo = vi
      .fn()
      .mockResolvedValueOnce(storageInfo(10))
      .mockRejectedValueOnce(new Error('scan failed'))
    setStorageApi(getInfo)
    await useStorageInfoStore.getState().load()

    await expect(useStorageInfoStore.getState().refresh()).rejects.toThrow('scan failed')

    expect(getInfo).toHaveBeenCalledTimes(2)
    expect(useStorageInfoStore.getState()).toMatchObject({
      info: storageInfo(10),
      isRefreshing: false,
      loadError: 'Could not scan storage usage. Try again.'
    })
  })
})

import { create } from 'zustand'

import type { StorageInfo, StorageStatus } from '../../../shared/storage'

const STORAGE_INFO_FRESH_MS = 24 * 60 * 60 * 1_000
const SAFE_STORAGE_LOAD_ERROR = 'Could not scan storage usage. Try again.'

type LoadStorageInfoOptions = Readonly<{ force?: boolean }>

type StorageInfoState = {
  status: StorageStatus | null
  info: StorageInfo | null
  scannedAt: number | null
  isLoading: boolean
  isRefreshing: boolean
  loadError: string | undefined
  loadStatus: () => Promise<StorageStatus>
  load: (options?: LoadStorageInfoOptions) => Promise<StorageInfo>
  refresh: () => Promise<StorageInfo>
}

let requestInFlight: Promise<StorageInfo> | undefined
let statusRequestInFlight: Promise<StorageStatus> | undefined
let requestGeneration = 0

const isUnsupportedStatusCommand = (error: unknown): boolean =>
  error instanceof Error &&
  /(?:No handler registered for|Unknown application command:|Unknown Web RPC channel:).*storage:get-status/i.test(
    error.message
  )

const useStorageInfoStore = create<StorageInfoState>((set, get) => {
  const loadStatus = (): Promise<StorageStatus> => {
    const current = get().status
    if (current) return Promise.resolve(current)
    if (statusRequestInFlight) return statusRequestInFlight

    const request = Promise.resolve()
      .then(() => window.api.storage.getStatus())
      // Mixed-version Web sessions can briefly use a backend that predates getStatus.
      .catch((error: unknown) => {
        if (!isUnsupportedStatusCommand(error)) throw error
        return requestInFlight ?? window.api.storage.getInfo()
      })
      .then((status) => {
        if ('usage' in status) {
          set({
            status,
            info: status,
            scannedAt: Date.now(),
            isLoading: false,
            isRefreshing: false,
            loadError: undefined
          })
        } else {
          set({ status })
        }
        return status
      })
    const trackedRequest = request.finally(() => {
      if (statusRequestInFlight === trackedRequest) statusRequestInFlight = undefined
    })
    statusRequestInFlight = trackedRequest
    void trackedRequest.catch(() => undefined)
    return trackedRequest
  }

  const load = (options: LoadStorageInfoOptions = {}): Promise<StorageInfo> => {
    const state = get()
    if (
      !options.force &&
      state.info &&
      state.scannedAt !== null &&
      Date.now() - state.scannedAt < STORAGE_INFO_FRESH_MS
    ) {
      return Promise.resolve(state.info)
    }
    if (requestInFlight) return requestInFlight

    const generation = ++requestGeneration
    set({
      isLoading: state.info === null,
      isRefreshing: state.info !== null,
      loadError: undefined
    })
    const request = window.api.storage.getInfo().then(
      (info) => {
        if (generation === requestGeneration) {
          set({
            status: info,
            info,
            scannedAt: Date.now(),
            isLoading: false,
            isRefreshing: false,
            loadError: undefined
          })
        }
        return info
      },
      (error: unknown) => {
        if (generation === requestGeneration) {
          set({
            isLoading: false,
            isRefreshing: false,
            loadError: SAFE_STORAGE_LOAD_ERROR
          })
        }
        throw error
      }
    )
    const trackedRequest = request.finally(() => {
      if (requestInFlight === trackedRequest) requestInFlight = undefined
    })
    requestInFlight = trackedRequest
    void requestInFlight.catch(() => undefined)
    return requestInFlight
  }

  return {
    status: null,
    info: null,
    scannedAt: null,
    isLoading: false,
    isRefreshing: false,
    loadError: undefined,
    loadStatus,
    load,
    refresh: () => load({ force: true })
  }
})

export { STORAGE_INFO_FRESH_MS, useStorageInfoStore }

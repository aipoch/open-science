// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from './update-store'

const resetStore = (): void =>
  useUpdateStore.setState({
    appInfo: null,
    status: { state: 'idle', current: '' },
    isDialogOpen: false
  })

describe('useUpdateStore', () => {
  beforeEach(() => {
    resetStore()
    vi.restoreAllMocks()
  })

  it('init loads app info and subscribes to status/progress', async () => {
    const onStatus = vi.fn()
    const onProgress = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      update: {
        getAppInfo: () =>
          Promise.resolve({
            name: 'Open Science',
            version: '0.2.0',
            copyright: '© 2026 AIPOCH. All rights reserved.'
          }),
        getStatus: () => Promise.resolve({ state: 'idle', current: '0.2.0' }),
        onStatus,
        onProgress,
        check: vi.fn(),
        download: vi.fn(),
        apply: vi.fn()
      }
    }

    useUpdateStore.getState().init()
    await Promise.resolve()

    expect(useUpdateStore.getState().appInfo?.version).toBe('0.2.0')
    expect(onStatus).toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalled()
  })

  it('init hydrates from getStatus when the store is still idle', async () => {
    ;(window as unknown as { api: unknown }).api = {
      update: {
        getAppInfo: () =>
          Promise.resolve({
            name: 'Open Science',
            version: '0.2.0',
            copyright: '© 2026 AIPOCH. All rights reserved.'
          }),
        getStatus: () => Promise.resolve({ state: 'available', current: '0.2.0', latest: '0.3.0' }),
        onStatus: vi.fn(),
        onProgress: vi.fn(),
        check: vi.fn(),
        download: vi.fn(),
        apply: vi.fn()
      }
    }

    useUpdateStore.getState().init()
    await Promise.resolve()
    await Promise.resolve()

    expect(useUpdateStore.getState().status.state).toBe('available')
    expect(useUpdateStore.getState().status.latest).toBe('0.3.0')
  })

  it('does not let the getStatus hydration clobber a live broadcast that arrived first', async () => {
    let statusListener: ((status: unknown) => void) | undefined
    let resolveGetStatus: ((status: unknown) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      update: {
        getAppInfo: () =>
          Promise.resolve({
            name: 'Open Science',
            version: '0.2.0',
            copyright: '© 2026 AIPOCH. All rights reserved.'
          }),
        // Resolved manually below, after the live broadcast fires, to force the race outcome.
        getStatus: () => new Promise((resolve) => (resolveGetStatus = resolve)),
        onStatus: (listener: (status: unknown) => void) => {
          statusListener = listener
        },
        onProgress: vi.fn(),
        check: vi.fn(),
        download: vi.fn(),
        openInstaller: vi.fn()
      }
    }

    useUpdateStore.getState().init()
    await Promise.resolve()

    // Simulate the live 'update:status' broadcast winning the race.
    statusListener?.({ state: 'downloading', current: '0.2.0', progress: 40 })
    // The startup getStatus() call resolves afterwards; the idle guard must reject it.
    resolveGetStatus?.({ state: 'available', current: '0.2.0', latest: '0.3.0' })
    await Promise.resolve()
    await Promise.resolve()

    expect(useUpdateStore.getState().status.state).toBe('downloading')
  })

  it('openDialog and closeDialog toggle the dialog flag', () => {
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
    useUpdateStore.getState().openDialog()
    expect(useUpdateStore.getState().isDialogOpen).toBe(true)
    useUpdateStore.getState().closeDialog()
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
  })

  it('closeDialog cancels an in-flight download', async () => {
    const cancel = vi.fn(() =>
      Promise.resolve({ state: 'available', current: '0.2.0', latest: '0.3.0' })
    )
    ;(window as unknown as { api: unknown }).api = {
      update: { onStatus: vi.fn(), onProgress: vi.fn(), cancel }
    }
    useUpdateStore.setState({
      status: { state: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 40 },
      isDialogOpen: true
    })

    useUpdateStore.getState().closeDialog()
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
    expect(useUpdateStore.getState().status.state).toBe('available')
  })

  it('closeDialog cancels unconditionally so a not-yet-broadcast download is still aborted', () => {
    // The 'downloading' broadcast may not have arrived when the user clicks Cancel right after
    // Download; closeDialog must still call cancel (a main-process no-op when nothing is downloading).
    const cancel = vi.fn(() => Promise.resolve({ state: 'available', current: '0.2.0' }))
    ;(window as unknown as { api: unknown }).api = {
      update: { onStatus: vi.fn(), onProgress: vi.fn(), cancel }
    }
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0' },
      isDialogOpen: true
    })

    useUpdateStore.getState().closeDialog()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
  })

  it('check stores the returned status', async () => {
    ;(window as unknown as { api: unknown }).api = {
      update: {
        getAppInfo: vi.fn(),
        onStatus: vi.fn(),
        onProgress: vi.fn(),
        check: () => Promise.resolve({ state: 'available', current: '0.2.0', latest: '0.3.0' }),
        download: vi.fn(),
        openInstaller: vi.fn()
      }
    }

    await useUpdateStore.getState().check()
    expect(useUpdateStore.getState().status.state).toBe('available')
    expect(useUpdateStore.getState().status.latest).toBe('0.3.0')
  })

  it('onProgress callback maps DownloadProgress payload into status fields', async () => {
    let progressListener: ((progress: unknown) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      update: {
        getAppInfo: () =>
          Promise.resolve({ name: 'Open Science', version: '0.2.0', copyright: '' }),
        getStatus: () => Promise.resolve({ state: 'idle', current: '0.2.0' }),
        onStatus: vi.fn(),
        onProgress: (listener: (progress: unknown) => void) => {
          progressListener = listener
        },
        check: vi.fn(),
        download: vi.fn(),
        apply: vi.fn()
      }
    }

    useUpdateStore.getState().init()
    await Promise.resolve()

    progressListener?.({ percent: 42, transferred: 4200, total: 10000 })

    const status = useUpdateStore.getState().status
    expect(status.progress).toBe(42)
    expect(status.downloadedBytes).toBe(4200)
    expect(status.totalBytes).toBe(10000)

    // A reconnecting event omits percent/total; the mirror must keep the last known size and
    // percent so the action button doesn't flip to "Downloading 0%" mid-reconnect.
    progressListener?.({ phase: 'reconnecting', transferred: 4200, bytesPerSecond: 0, attempt: 1 })
    const reconnecting = useUpdateStore.getState().status
    expect(reconnecting.progress).toBe(42)
    expect(reconnecting.totalBytes).toBe(10000)
    expect(reconnecting.downloadProgress?.phase).toBe('reconnecting')
  })
})

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
        openInstaller: vi.fn()
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
        openInstaller: vi.fn()
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
})

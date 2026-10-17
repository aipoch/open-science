// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { startNetworkMonitor, useNetworkStore } from './network-store'
import { useSettingsStore } from './settings-store'
import { useDesktopRuntimeRecoveryStore } from './desktop-runtime-recovery-store'

type CheckConnectivity = () => Promise<boolean>

// window.api is typed as the full preload bridge; tests replace it wholesale through an
// unknown cast and only model the one method under test.
const stubCheckConnectivity = (checkConnectivity?: CheckConnectivity): void => {
  ;(window as unknown as { api: unknown }).api =
    checkConnectivity === undefined ? undefined : { network: { checkConnectivity } }
}

const setNavigatorOnline = (online: boolean): void => {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true })
}

let systemResumed!: () => void
beforeAll(() => {
  ;(window as unknown as { api: unknown }).api = {
    network: {
      onSystemResumed: (listener: () => void) => {
        systemResumed = listener
        return () => {}
      },
      checkConnectivity: async () => true
    }
  }
  startNetworkMonitor()
})

afterEach(() => {
  stubCheckConnectivity()
  setNavigatorOnline(true)
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
})

describe('useNetworkStore', () => {
  it('seeds from navigator.onLine', () => {
    expect(useNetworkStore.getState().isOnline).toBe(navigator.onLine)
  })

  it('goes offline on the window offline event', () => {
    window.dispatchEvent(new Event('offline'))
    expect(useNetworkStore.getState().isOnline).toBe(false)
  })

  it('recovers on the window online event', () => {
    window.dispatchEvent(new Event('offline'))
    expect(useNetworkStore.getState().isOnline).toBe(false)

    window.dispatchEvent(new Event('online'))
    expect(useNetworkStore.getState().isOnline).toBe(true)
  })

  it('recheckOnline re-reads navigator.onLine on demand', () => {
    useNetworkStore.setState({ isOnline: false })

    useNetworkStore.getState().recheckOnline()

    expect(useNetworkStore.getState().isOnline).toBe(navigator.onLine)
  })
})

describe('probeConnectivity', () => {
  it('does not probe or report failure during planned runtime shutdown', async () => {
    const check = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(check)
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })
    try {
      useDesktopRuntimeRecoveryStore.setState({ closing: true })
      useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', epoch: 10 })
      systemResumed()
      window.dispatchEvent(new Event('online'))
      const pending = useNetworkStore
        .getState()
        .probeConnectivity({ announce: true, invalidate: true })
      await vi.advanceTimersByTimeAsync(500)
      await pending
      expect(check).not.toHaveBeenCalled()
      expect(useNetworkStore.getState().connectivity).toBe('reachable')
    } finally {
      stubCheckConnectivity(async () => true)
      useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', closing: false })
      await vi.advanceTimersByTimeAsync(500)
    }
  })

  it('ignores an in-flight probe rejection after planned shutdown begins', async () => {
    let reject!: (error: Error) => void
    const reportRendererFailure = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      network: {
        checkConnectivity: () =>
          new Promise<boolean>((_, no) => {
            reject = no
          })
      },
      diagnostics: { reportRendererFailure }
    }
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })
    const pending = useNetworkStore.getState().probeConnectivity({ invalidate: true })
    try {
      useDesktopRuntimeRecoveryStore.setState({ closing: true })
      reject(new Error('Desktop runtime is shutting down.'))
      await pending
      expect(useNetworkStore.getState().connectivity).toBe('unknown')
      expect(reportRendererFailure).not.toHaveBeenCalled()
    } finally {
      stubCheckConnectivity(async () => true)
      useDesktopRuntimeRecoveryStore.setState({ closing: false })
      await vi.advanceTimersByTimeAsync(500)
    }
  })

  it('rechecks when planned shutdown is cancelled without a connection epoch change', async () => {
    useDesktopRuntimeRecoveryStore.setState({ closing: true })
    const check = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(check)
    useNetworkStore.setState({ isOnline: true, connectivity: 'probe-failed' })
    useDesktopRuntimeRecoveryStore.setState({ closing: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(check).toHaveBeenCalledOnce()
    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('rejects a late network result after the backend disconnects', async () => {
    let finish!: (value: boolean) => void
    stubCheckConnectivity(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = useNetworkStore.getState().probeConnectivity({ invalidate: true })
    useDesktopRuntimeRecoveryStore.setState({
      phase: 'disconnected',
      epoch: useDesktopRuntimeRecoveryStore.getState().epoch + 1
    })
    finish(true)
    await pending
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected' })
    await vi.advanceTimersByTimeAsync(10_001)
  })

  it('invalidates a completed probe during its announced presentation delay', async () => {
    stubCheckConnectivity(async () => true)
    const pending = useNetworkStore
      .getState()
      .probeConnectivity({ announce: true, invalidate: true })
    await vi.advanceTimersByTimeAsync(1)
    useDesktopRuntimeRecoveryStore.setState({
      phase: 'disconnected',
      epoch: useDesktopRuntimeRecoveryStore.getState().epoch + 1
    })
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected' })
    await vi.advanceTimersByTimeAsync(500)
  })

  it('rechecks a previously healthy network after system resume', async () => {
    const check = vi.fn().mockResolvedValue(false)
    stubCheckConnectivity(check)
    useNetworkStore.setState({ connectivity: 'reachable', isOnline: true })
    expect(systemResumed).toBeTypeOf('function')
    systemResumed()
    await vi.advanceTimersByTimeAsync(500)
    expect(check).toHaveBeenCalledOnce()
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
  })

  it('settles a stalled connectivity check and ignores its late success', async () => {
    let finish!: (value: boolean) => void
    stubCheckConnectivity(
      vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          })
      )
    )
    const pending = useNetworkStore
      .getState()
      .probeConnectivity({ announce: true, invalidate: true })
    await vi.advanceTimersByTimeAsync(15_001)
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
    finish(true)
    await pending
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
  })

  it('coalesces repeated checks within the same network generation', async () => {
    let finish!: (value: boolean) => void
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    stubCheckConnectivity(check)
    const first = useNetworkStore.getState().probeConnectivity({ invalidate: true })
    const second = useNetworkStore.getState().probeConnectivity()
    expect(check).toHaveBeenCalledOnce()
    finish(true)
    await Promise.all([first, second])
  })

  it('revalidates stale network status when the desktop connection recovers without an OS online event', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    setNavigatorOnline(true)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })
    useDesktopRuntimeRecoveryStore.setState({
      phase: 'disconnected',
      epoch: 1,
      closing: false
    })
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 2 })
    await vi.advanceTimersByTimeAsync(500)

    expect(checkConnectivity).toHaveBeenCalledOnce()
    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it.each(['unreachable', 'probe-failed'] as const)(
    'rechecks a saved proxy and discards prior success on %s',
    async (result) => {
      const checkConnectivity = vi.fn().mockResolvedValueOnce(true)
      if (result === 'unreachable') checkConnectivity.mockResolvedValue(false)
      else checkConnectivity.mockRejectedValue(new Error('probe unavailable'))
      ;(window as unknown as { api: unknown }).api = {
        network: { checkConnectivity },
        settings: {
          setNetworkProxy: vi
            .fn()
            .mockResolvedValue({ mode: 'manual', server: `http://${result}.example:8080` })
        }
      }
      await useNetworkStore.getState().probeConnectivity()
      expect(useNetworkStore.getState().connectivity).toBe('reachable')
      await useSettingsStore
        .getState()
        .setNetworkProxy({ mode: 'manual', server: `http://${result}.example:8080` })
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(500)
      expect.soft(checkConnectivity).toHaveBeenCalledTimes(2)
      expect(useNetworkStore.getState().connectivity).toBe(result)
    }
  )

  it('ignores a delayed probe from before a proxy change', async () => {
    let finish!: (value: boolean) => void
    const checkConnectivity = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValue(false)
    ;(window as unknown as { api: unknown }).api = {
      network: { checkConnectivity },
      settings: { setNetworkProxy: vi.fn().mockResolvedValue({ mode: 'direct' }) }
    }
    const previous = useNetworkStore.getState().probeConnectivity()
    await useSettingsStore.getState().setNetworkProxy({ mode: 'direct' })
    await vi.advanceTimersByTimeAsync(500)
    finish(true)
    await previous
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
  })
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('an announced probe flips to unknown, then applies the result only after the minimum delay', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(false)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    const probe = useNetworkStore.getState().probeConnectivity({ announce: true })
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(499)
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(1)
    await probe
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
    expect(checkConnectivity).toHaveBeenCalledTimes(1)
  })

  it('a silent probe keeps the previous state while probing', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    const probe = useNetworkStore.getState().probeConnectivity()
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')

    await vi.advanceTimersByTimeAsync(500)
    await probe
    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('reports a failed check when a silent bridge call rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await useNetworkStore.getState().probeConnectivity()

    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
  })

  it('settles a rejected cold-start probe as a retryable terminal failure', async () => {
    stubCheckConnectivity(vi.fn().mockRejectedValue(new Error('bridge gone')))
    vi.resetModules()
    const { useNetworkStore: coldStartStore } = await import('./network-store')
    coldStartStore.setState({ isOnline: true, connectivity: 'unknown' })

    await coldStartStore.getState().probeConnectivity()

    expect(coldStartStore.getState().connectivity).toBe('probe-failed')
  })

  it('reports a failed check when an announced bridge call rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    const probe = useNetworkStore.getState().probeConnectivity({ announce: true })
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(499)
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(1)
    await probe
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
  })

  it('keeps the offline state when a pending announced probe rejects', async () => {
    let rejectProbe!: (reason: Error) => void
    const probeResult = new Promise<boolean>((_resolve, reject) => {
      rejectProbe = reject
    })
    stubCheckConnectivity(vi.fn().mockReturnValue(probeResult))
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    const probe = useNetworkStore.getState().probeConnectivity({ announce: true })
    window.dispatchEvent(new Event('offline'))
    rejectProbe(new Error('bridge gone'))

    await vi.advanceTimersByTimeAsync(500)
    await probe
    expect(useNetworkStore.getState()).toMatchObject({
      isOnline: false,
      connectivity: 'unreachable'
    })
  })

  it('does not let an older success erase a newer check failure', async () => {
    let resolveFirst!: (reachable: boolean) => void
    const firstResult = new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    })
    const checkConnectivity = vi
      .fn()
      .mockReturnValueOnce(firstResult)
      .mockRejectedValueOnce(new Error('bridge gone'))
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    const firstProbe = useNetworkStore.getState().probeConnectivity({ announce: true })
    const secondProbe = useNetworkStore
      .getState()
      .probeConnectivity({ announce: true, invalidate: true })

    await vi.advanceTimersByTimeAsync(500)
    await secondProbe
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')

    resolveFirst(true)
    await firstProbe
    expect(useNetworkStore.getState().connectivity).toBe('probe-failed')
    expect(checkConnectivity).toHaveBeenCalledTimes(2)
  })

  it('falls back to reachable when there is no probe bridge', async () => {
    stubCheckConnectivity()
    useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })

    await useNetworkStore.getState().probeConnectivity()

    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('short-circuits to unreachable without calling the bridge when the link is down', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    setNavigatorOnline(false)
    useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })

    const probe = useNetworkStore.getState().probeConnectivity({ announce: true })
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(500)
    await probe
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
    expect(checkConnectivity).not.toHaveBeenCalled()
  })

  it('applies silent probe results without the minimum delay', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })

    // Resolves on microtasks alone — no timer advance needed when not announced.
    await useNetworkStore.getState().probeConnectivity()

    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })
})

describe('startNetworkMonitor silent recovery', () => {
  it('silently re-probes when the window is focused while unreachable', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(useNetworkStore.getState().connectivity).toBe('reachable')
    })
    expect(checkConnectivity).toHaveBeenCalledTimes(1)
  })

  it('silently re-probes when the document becomes visible while probe-failed', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'probe-failed' })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => {
      expect(useNetworkStore.getState().connectivity).toBe('reachable')
    })
    expect(checkConnectivity).toHaveBeenCalledTimes(1)
  })

  it('does not re-probe on focus while already reachable', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(false)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    await Promise.resolve()

    expect(checkConnectivity).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('does not re-probe on focus while the link is down', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    setNavigatorOnline(false)
    useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    await Promise.resolve()

    expect(checkConnectivity).not.toHaveBeenCalled()
    expect(useNetworkStore.getState()).toMatchObject({
      isOnline: false,
      connectivity: 'unreachable'
    })
  })

  it('does not start a second silent probe while one is still in flight', async () => {
    let resolveFirst!: (reachable: boolean) => void
    const firstResult = new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    })
    const checkConnectivity = vi.fn().mockReturnValueOnce(firstResult).mockResolvedValueOnce(false)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(checkConnectivity).toHaveBeenCalledTimes(1)

    resolveFirst(true)
    await vi.waitFor(() => {
      expect(useNetworkStore.getState().connectivity).toBe('reachable')
    })
    expect(checkConnectivity).toHaveBeenCalledTimes(1)
  })

  it('does not re-probe when visibilitychange leaves the document hidden', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()

    expect(checkConnectivity).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
  })
})

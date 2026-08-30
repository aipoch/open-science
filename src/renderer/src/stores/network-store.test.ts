// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { startNetworkMonitor, useNetworkStore } from './network-store'

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

beforeAll(() => {
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

  it('keeps the last known state when the bridge call rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await useNetworkStore.getState().probeConnectivity()

    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('settles a rejected cold-start probe as a retryable terminal failure', async () => {
    stubCheckConnectivity(vi.fn().mockRejectedValue(new Error('bridge gone')))
    vi.resetModules()
    const { useNetworkStore: coldStartStore } = await import('./network-store')
    coldStartStore.setState({ isOnline: true, connectivity: 'unknown' })

    await coldStartStore.getState().probeConnectivity()

    expect(coldStartStore.getState().connectivity).toBe('probe-failed')
  })

  it('restores the last known state when an announced bridge call rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    stubCheckConnectivity(checkConnectivity)
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    const probe = useNetworkStore.getState().probeConnectivity({ announce: true })
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(499)
    expect(useNetworkStore.getState().connectivity).toBe('unknown')

    await vi.advanceTimersByTimeAsync(1)
    await probe
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
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

  it('does not restore transient unknown when overlapping announced probes reject', async () => {
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
    const secondProbe = useNetworkStore.getState().probeConnectivity({ announce: true })

    await vi.advanceTimersByTimeAsync(500)
    await secondProbe
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')

    resolveFirst(true)
    await firstProbe
    expect(useNetworkStore.getState().connectivity).toBe('unreachable')
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
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    stubCheckConnectivity(checkConnectivity)
    await useNetworkStore.getState().probeConnectivity()
    checkConnectivity.mockClear()

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    await Promise.resolve()

    expect(checkConnectivity).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().connectivity).toBe('reachable')
  })

  it('silently re-probes a reachable result that is stale when the window regains focus', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))
      const checkConnectivity = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      stubCheckConnectivity(checkConnectivity)

      await useNetworkStore.getState().probeConnectivity()
      expect(useNetworkStore.getState().connectivity).toBe('reachable')

      await vi.advanceTimersByTimeAsync(60_001)
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)

      expect(checkConnectivity).toHaveBeenCalledTimes(2)
      expect(useNetworkStore.getState().connectivity).toBe('unreachable')
    } finally {
      vi.useRealTimers()
      stubCheckConnectivity(vi.fn().mockResolvedValue(true))
      await useNetworkStore.getState().probeConnectivity()
    }
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

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

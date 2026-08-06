// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { useNetworkStore } from './network-store'

afterEach(() => {
  useNetworkStore.setState({ isOnline: true })
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

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { NetworkStatusIndicator } from './NetworkStatusIndicator'
import { startNetworkMonitor, useNetworkStore } from '@/stores/network-store'
import { useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  startNetworkMonitor()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
  useSettingsStore.setState({ isSettingsOpen: false, pendingSettingsIntent: undefined })
})

describe('NetworkStatusIndicator', () => {
  it('renders nothing while online', async () => {
    useNetworkStore.setState({ isOnline: true })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    expect(container.querySelector('button')).toBeNull()
  })

  it('renders the offline pill with a label', async () => {
    useNetworkStore.setState({ isOnline: false })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('No internet connection')
    expect(button?.textContent).toContain('Offline')
  })

  it('renders the icon variant without a label', async () => {
    useNetworkStore.setState({ isOnline: false })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="icon" />)
    })

    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('No internet connection')
    expect(button?.textContent).not.toContain('Offline')
  })

  it('opens the settings Network panel on click', async () => {
    useNetworkStore.setState({ isOnline: false })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    const button = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
      panel: 'network',
      view: { kind: 'list' }
    })
  })

  it('disappears when connectivity recovers', async () => {
    useNetworkStore.setState({ isOnline: false })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })
    expect(container.querySelector('button')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(container.querySelector('button')).toBeNull()
  })

  it('renders the amber unreachable pill when the link is up but the internet is unreachable', async () => {
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('Package registries unreachable')
    expect(button?.textContent).toContain('Unreachable')
  })

  it('clears the unreachable pill after a silent focus re-probe succeeds', async () => {
    const checkConnectivity = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { api: unknown }).api = { network: { checkConnectivity } }
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })
    expect(container.querySelector('button')?.textContent).toContain('Unreachable')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('button')).toBeNull()
      })
    })
    expect(checkConnectivity).toHaveBeenCalledTimes(1)
  })

  it('renders a retry entry point when the internet check fails', async () => {
    useNetworkStore.setState({ isOnline: true, connectivity: 'probe-failed' })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('Internet check failed')
    expect(button?.textContent).toContain('Check failed')
  })

  it('renders nothing while the internet is reachable', async () => {
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await act(async () => {
      root.render(<NetworkStatusIndicator variant="pill" />)
    })

    expect(container.querySelector('button')).toBeNull()
  })
})

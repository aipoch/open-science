// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { NetworkPanel } from './NetworkPanel'
import { useNetworkStore } from '@/stores/network-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
  useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
})

const buttonWithText = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement

describe('NetworkPanel offline retry', () => {
  it('shows a retry action for a failed cold-start probe', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'probe-failed' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })

    expect(container.textContent).toContain('Could not check whether the internet is reachable.')
    expect(buttonWithText('Check again')).not.toBeUndefined()
    expect(container.textContent).not.toContain('Checking…')
  })

  it('holds a checking state for at least 500ms when Check again is clicked while offline', async () => {
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    expect(container.textContent).toContain('This machine is offline.')

    await act(async () => {
      buttonWithText('Check again').click()
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(container.textContent).toContain('This machine is offline.')
  })

  it('restores the last known status when an online retry probe rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo: vi.fn().mockResolvedValue({ connectionType: 'wifi', ipAddress: '192.168.1.42' }),
        checkConnectivity
      }
    }
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    expect(container.textContent).toContain(
      'The network link is up, but the internet is unreachable.'
    )

    await act(async () => {
      buttonWithText('Check again').click()
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(container.textContent).toContain(
      'The network link is up, but the internet is unreachable.'
    )
    expect(buttonWithText('Check again')).not.toBeUndefined()
    expect(checkConnectivity).toHaveBeenCalledOnce()
  })
})

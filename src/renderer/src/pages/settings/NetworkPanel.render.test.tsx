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
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
})

const buttonWithText = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement

describe('NetworkPanel offline retry', () => {
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
})

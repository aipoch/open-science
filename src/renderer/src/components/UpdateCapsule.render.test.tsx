// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { UpdateCapsule } from './UpdateCapsule'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  useUpdateStore.setState({
    appInfo: null,
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' },
    isDialogOpen: false
  })
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UpdateCapsule', () => {
  it('renders nothing when there is no update', () => {
    act(() => {
      root.render(<UpdateCapsule />)
    })

    expect(container.textContent).toBe('')
    expect(container.children.length).toBe(0)
  })

  it('renders a compact Home action, exposes details on focus, and opens the update dialog', async () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0', notes: 'n' }
    })

    await act(async () => {
      root.render(<UpdateCapsule />)
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New version: Update (v0.3.0)"]'
    )
    expect(button).not.toBeNull()
    expect(button?.getAttribute('data-variant')).toBe('home')
    expect(button?.querySelector('.update-reminder-sheen')).not.toBeNull()
    expect(button?.querySelector('.update-reminder-orbit')).not.toBeNull()
    expect(button?.querySelector('.update-reminder-status-dot')).not.toBeNull()
    expect(button?.textContent).toBe('Update')

    await act(async () => button?.focus())

    const details = document.body.querySelector('[data-update-details]')
    expect(details?.textContent).toContain('New version')
    expect(details?.textContent).toContain('Update')

    act(() => button?.click())
    expect(useUpdateStore.getState().isDialogOpen).toBe(true)
  })

  it('shows download progress without replaying the available-update attention cue', () => {
    useUpdateStore.setState({
      status: { state: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 41.6 }
    })

    act(() => {
      root.render(<UpdateCapsule />)
    })

    const button = container.querySelector('button[aria-label="Downloading: 42% (v0.3.0)"]')
    expect(button?.textContent).toContain('42%')
    expect(button?.querySelector('.animate-spin')).not.toBeNull()
    expect(button?.querySelector('.update-reminder-attention')).toBeNull()
    expect(button?.querySelector('.update-reminder-status-dot')).toBeNull()
  })

  it('keeps a failed update visible when a retry target exists', () => {
    useUpdateStore.setState({
      status: {
        state: 'error',
        current: '0.2.0',
        latest: '0.3.0',
        error: 'Download failed'
      }
    })

    act(() => {
      root.render(<UpdateCapsule />)
    })

    const button = container.querySelector('button[aria-label="Update failed: Retry (v0.3.0)"]')
    expect(button?.textContent).toContain('Retry')
    expect(button?.querySelector('.update-reminder-attention')).toBeNull()
  })

  it('renders the persistent Session action with the ready-state copy', () => {
    useUpdateStore.setState({
      status: { state: 'ready', current: '0.2.0', latest: '0.3.0', applyKind: 'restart' }
    })

    act(() => {
      root.render(<UpdateCapsule variant="session" />)
    })

    const button = container.querySelector('button[aria-label="Update ready: Restart (v0.3.0)"]')
    expect(button?.getAttribute('data-variant')).toBe('session')
    expect(button?.textContent).toBe('Restart')
    expect(button?.querySelector('.update-reminder-sheen')).not.toBeNull()
  })

  it('replays the finite attention cue after a visible window regains focus past the cooldown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0' }
    })

    act(() => {
      root.render(
        <StrictMode>
          <UpdateCapsule />
        </StrictMode>
      )
    })

    const firstCue = container.querySelector('.update-reminder-attention')
    act(() => window.dispatchEvent(new Event('focus')))
    expect(container.querySelector('.update-reminder-attention')).toBe(firstCue)

    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000)
      window.dispatchEvent(new Event('focus'))
    })

    expect(container.querySelector('.update-reminder-attention')).not.toBe(firstCue)
  })
})

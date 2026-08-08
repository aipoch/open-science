// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { NotificationBell } from './NotificationBell'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useNotificationInboxStore.setState({
    revision: 1,
    unreadCount: 1,
    latestSequence: 7,
    status: 'ready',
    error: undefined,
    items: [
      {
        id: 'message-1',
        sequence: 7,
        dedupeKey: 'authorization:connector:request-1',
        kind: 'authorization.required',
        source: 'connector',
        originId: 'request-1',
        title: 'Approval needed',
        summary: 'A connector call needs your approval.',
        createdAt: Date.now(),
        actionState: 'pending'
      }
    ]
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const stubMobileViewport = (): void => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(max-width: 47.999rem)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  )
}

describe('NotificationBell', () => {
  it('renders a red-dot entry point with an accessible unread count and pending state', async () => {
    await act(async () => root.render(<NotificationBell />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Messages, 1 unread"]')
    expect(trigger).not.toBeNull()
    expect(container.querySelector('.bg-destructive')).not.toBeNull()
    await act(async () => trigger?.click())
    expect(document.body.textContent).toContain('Approval needed')
    expect(document.body.textContent).toContain('Needs approval')
    expect(
      document.body.querySelector('[aria-label="Message center"]')?.classList.contains('fixed')
    ).toBe(true)
  })

  it('distinguishes a rejected approval from a resolved one', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item ? [{ ...item, actionState: 'rejected' }] : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    expect(document.body.textContent).toContain('Rejected')
    expect(document.body.textContent).not.toContain('Resolved')
  })

  it('keeps opening passive and marks messages only through explicit actions', async () => {
    const markRead = vi.fn(async () => undefined)
    const markAllRead = vi.fn(async () => undefined)
    useNotificationInboxStore.setState({ markRead, markAllRead })
    await act(async () => root.render(<NotificationBell />))

    expect(markRead).not.toHaveBeenCalled()
    expect(markAllRead).not.toHaveBeenCalled()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const item = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => item?.click())
    expect(markRead).toHaveBeenCalledWith(['message-1'])

    const markAll = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Mark all read')
    )
    await act(async () => markAll?.click())
    expect(markAllRead).toHaveBeenCalledTimes(1)
  })

  it('uses a bottom drawer on mobile and notifies its host when opening', async () => {
    stubMobileViewport()
    const onOpen = vi.fn()
    await act(async () =>
      root.render(<NotificationBell side="top" align="start" onOpen={onOpen} />)
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')
    await act(async () => trigger?.click())

    const dialog = document.body.querySelector<HTMLElement>('[aria-label="Message center"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.classList.contains('inset-x-0')).toBe(true)
    expect(dialog?.classList.contains('bottom-0')).toBe(true)
    expect(dialog?.classList.contains('h-[min(82dvh,760px)]')).toBe(true)
    expect(dialog?.classList.contains('rounded-t-2xl')).toBe(true)
    expect(dialog?.classList.contains('inset-0')).toBe(false)
    expect(dialog?.hasAttribute('style')).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)

    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close messages"]')
    expect(close).not.toBeNull()
    await act(async () => close?.click())
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })
})

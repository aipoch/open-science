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
})

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
})

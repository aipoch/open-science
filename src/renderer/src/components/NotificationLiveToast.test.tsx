// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotificationInboxItem } from '../../../shared/notifications'
import type { Project } from '../../../shared/projects'
import type { ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { NotificationLiveToast } from './NotificationLiveToast'

let container: HTMLDivElement
let root: Root
let bell: HTMLButtonElement

const item = (
  sequence: number,
  overrides: Partial<NotificationInboxItem> = {}
): NotificationInboxItem => ({
  id: `notification-${sequence}`,
  sequence,
  dedupeKey: `task:event-${sequence}`,
  kind: 'task.completed' as const,
  source: 'agent-runtime' as const,
  sessionId: 'session-1',
  originId: `event-${sequence}`,
  title: 'Task completed',
  summary: 'A task completed.',
  createdAt: sequence * 100,
  ...overrides
})

const session = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analyze microscopy data',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Use a logarithmic scale for the chart.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
} as ChatSession

const flushToastPosition = async (): Promise<void> => {
  await act(
    async () => await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useNotificationInboxStore.setState({
    revision: 1,
    unreadCount: 1,
    latestSequence: 1,
    items: [item(1)],
    status: 'ready',
    error: undefined,
    markRead: vi.fn(async () => undefined)
  })
  useSessionStore.setState({ sessions: [session], selectedSessionId: undefined })
  useProjectStore.setState({
    projects: [{ id: 'project-1', name: 'Cell atlas' } as Project]
  })
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })

  bell = document.createElement('button')
  bell.dataset.notificationBellTrigger = 'true'
  bell.getBoundingClientRect = () =>
    ({
      left: 300,
      right: 332,
      top: 400,
      bottom: 432,
      width: 32,
      height: 32,
      x: 300,
      y: 400,
      toJSON: () => undefined
    }) as DOMRect
  document.body.appendChild(bell)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document
    .querySelectorAll('[data-notification-bell-trigger="true"]')
    .forEach((element) => element.remove())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NotificationLiveToast', () => {
  it('N03: shows a sessionless connector approval on the foreground Home page', async () => {
    await act(async () => root.render(<NotificationLiveToast />))
    const approval = item(2, {
      kind: 'authorization.required',
      source: 'connector',
      attentionReason: 'waiting-permission',
      actionState: 'pending',
      sessionId: undefined,
      title: 'Approval needed'
    })
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [approval, item(1)] })
    })
    await flushToastPosition()

    const toast = container.querySelector<HTMLElement>('[data-testid="notification-live-toast"]')
    expect(toast).not.toBeNull()
    expect(toast?.textContent).toContain('Approval needed')
    expect(toast?.classList.contains('invisible')).toBe(false)
  })

  it('N04: removes the shown toast when its target is invalidated without a new sequence', async () => {
    const openSessionById = vi.fn(() => true)
    const originalOpen = useNavigationStore.getState().openSessionById
    useNavigationStore.setState({ openSessionById })
    try {
      await act(async () => root.render(<NotificationLiveToast />))
      await act(async () => {
        useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
      })
      await flushToastPosition()
      expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()

      await act(async () => {
        useNotificationInboxStore.setState({
          revision: 3,
          latestSequence: 2,
          items: [item(2, { readAt: 3000, targetInvalidatedAt: 3000 }), item(1)]
        })
      })
      const openButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Open'
      )
      await act(async () => openButton?.click())
      expect(openSessionById).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    } finally {
      useNavigationStore.setState({ openSessionById: originalOpen })
    }
  })

  it('still suppresses an active-session notification without replaying it on Home', async () => {
    useNavigationStore.setState({ view: 'workspace' })
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    await act(async () => useNavigationStore.setState({ view: 'home' }))
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
  })

  it('withdraws a removed lead and does not carry its count into the next arrival', async () => {
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()
    await act(async () => {
      useNotificationInboxStore.setState({ items: [item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    // A refresh that restores the row must not replay an already-withdrawn arrival.
    await act(async () => {
      useNotificationInboxStore.setState({ items: [item(2), item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 3, items: [item(3), item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()
    expect(container.textContent).not.toContain('more message')
  })

  it('refreshes a settled lead without restarting its dismissal timer', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<NotificationLiveToast />))
    const approval = item(2, {
      kind: 'authorization.required',
      source: 'connector',
      actionState: 'pending'
    })
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [approval, item(1)] })
    })
    act(() => vi.advanceTimersByTime(3000))
    await act(async () => {
      useNotificationInboxStore.setState({
        items: [{ ...approval, actionState: 'expired', title: 'Approval needed' }, item(1)]
      })
    })
    const toast = container.querySelector('[data-testid="notification-live-toast"]')
    expect(toast?.textContent).toContain('Approval needed')
    expect(toast?.querySelector('.bg-bg-300')).not.toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
  })

  it('does not replay existing messages and anchors a newly arrived message above the bell', async () => {
    await act(async () => root.render(<NotificationLiveToast />))
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()

    await act(async () => {
      useNotificationInboxStore.setState({
        latestSequence: 2,
        unreadCount: 2,
        items: [item(2), item(1)]
      })
    })
    await flushToastPosition()

    const toast = container.querySelector<HTMLElement>('[data-testid="notification-live-toast"]')
    expect(toast?.textContent).toContain('Analyze microscopy data')
    expect(toast?.textContent).toContain('Cell atlas')
    expect(toast?.textContent).toContain('Use a logarithmic scale for the chart.')
    expect(Number.parseFloat(toast?.style.top ?? '')).toBeLessThan(400)
    expect(toast?.dataset.placement).toBe('above')
  })

  it('reanchors below the Home bell when navigation replaces the Workspace bell', async () => {
    useNavigationStore.setState({ view: 'workspace' })
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({
        latestSequence: 2,
        unreadCount: 2,
        items: [item(2), item(1)]
      })
    })
    await flushToastPosition()

    const toast = container.querySelector<HTMLElement>('[data-testid="notification-live-toast"]')
    const workspaceLeft = Number.parseFloat(toast?.style.left ?? '')
    if (toast) {
      toast.getBoundingClientRect = () =>
        ({ width: 360, height: 100, left: 0, right: 360, top: 0, bottom: 100 }) as DOMRect
    }
    bell.getBoundingClientRect = () =>
      ({
        left: -100,
        right: -68,
        top: 400,
        bottom: 432,
        width: 32,
        height: 32,
        x: -100,
        y: 400,
        toJSON: () => undefined
      }) as DOMRect
    const homeBell = document.createElement('button')
    homeBell.dataset.notificationBellTrigger = 'true'
    homeBell.getBoundingClientRect = () =>
      ({
        left: 900,
        right: 932,
        top: 20,
        bottom: 52,
        width: 32,
        height: 32,
        x: 900,
        y: 20,
        toJSON: () => undefined
      }) as DOMRect

    await act(async () => {
      document.body.appendChild(homeBell)
      useNavigationStore.setState({ view: 'home' })
    })
    await flushToastPosition()

    expect(Number.parseFloat(toast?.style.left ?? '')).toBeGreaterThan(workspaceLeft)
    expect(toast?.dataset.placement).toBe('below')
    expect(Number.parseFloat(toast?.style.top ?? '')).toBeGreaterThanOrEqual(52)
  })

  it('merges a burst into one toast and opens the message center for the remainder', async () => {
    await act(async () => root.render(<NotificationLiveToast />))
    const openCenter = vi.fn()
    window.addEventListener('open-science:open-notification-center', openCenter)

    await act(async () => {
      useNotificationInboxStore.setState({
        latestSequence: 3,
        unreadCount: 3,
        items: [item(3), item(2), item(1)]
      })
    })

    expect(container.querySelectorAll('[data-testid="notification-live-toast"]')).toHaveLength(1)
    const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('1 more message')
    )
    expect(more).toBeDefined()
    await act(async () => more?.click())
    expect(openCenter).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    window.removeEventListener('open-science:open-notification-center', openCenter)
  })

  it('auto-dismisses without marking the inbox message read', async () => {
    vi.useFakeTimers()
    const markRead = vi.fn(async () => undefined)
    useNotificationInboxStore.setState({ markRead })
    await act(async () => root.render(<NotificationLiveToast />))

    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })
    expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()

    act(() => vi.advanceTimersByTime(6000))
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
    expect(markRead).not.toHaveBeenCalled()
  })

  it('keeps the toast unread when opening its target is rejected', async () => {
    const markRead = vi.fn(async () => undefined)
    const openSessionById = vi.fn(() => false)
    useNotificationInboxStore.setState({ markRead })
    useNavigationStore.setState({ openSessionById })
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })

    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open'
    )
    expect(open).toBeDefined()
    await act(async () => open?.click())

    expect(openSessionById).toHaveBeenCalledWith('session-1', 'notification', expect.any(Function))
    expect(markRead).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()
  })

  it('dismisses and marks read after deferred preview confirmation', async () => {
    let resumeNavigation: (() => void) | undefined
    const markRead = vi.fn(async () => undefined)
    const openSessionById = vi.fn(
      (_sessionId: string, _origin: string, afterNavigate?: () => void) => {
        resumeNavigation = afterNavigate
        return false
      }
    )
    useNotificationInboxStore.setState({ markRead })
    useNavigationStore.setState({ openSessionById })
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })

    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open'
    )
    await act(async () => open?.click())

    expect(markRead).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="notification-live-toast"]')).not.toBeNull()

    await act(async () => resumeNavigation?.())

    expect(markRead).toHaveBeenCalledWith(['notification-2'])
    expect(container.querySelector('[data-testid="notification-live-toast"]')).toBeNull()
  })

  it('preserves a newer live notice after deferred preview confirmation', async () => {
    let resumeNavigation: (() => void) | undefined
    const markRead = vi.fn(async () => undefined)
    const openSessionById = vi.fn(
      (_sessionId: string, _origin: string, afterNavigate?: () => void) => {
        resumeNavigation = afterNavigate
        return false
      }
    )
    useNotificationInboxStore.setState({ markRead })
    useNavigationStore.setState({ openSessionById })
    await act(async () => root.render(<NotificationLiveToast />))
    await act(async () => {
      useNotificationInboxStore.setState({ latestSequence: 2, items: [item(2), item(1)] })
    })

    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open'
    )
    await act(async () => open?.click())
    await act(async () => {
      useNotificationInboxStore.setState({
        latestSequence: 3,
        unreadCount: 3,
        items: [item(3, { title: 'New task completed', sessionId: 'session-2' }), item(2), item(1)]
      })
    })

    await act(async () => resumeNavigation?.())

    expect(markRead).toHaveBeenCalledWith(['notification-2'])
    expect(
      container.querySelector('[data-testid="notification-live-toast"]')?.textContent
    ).toContain('New task completed')
  })
})

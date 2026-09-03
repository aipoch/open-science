// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../../shared/compute'
import type { Project } from '../../../shared/projects'
import type { ConnectorApprovalRequest } from '../../../shared/settings'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useComputeStore } from '@/stores/compute-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { NotificationBell } from './NotificationBell'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.api = {
    settings: { replayConnectorApproval: vi.fn(async () => null) },
    compute: { replayApproval: vi.fn(async () => null) }
  } as unknown as Window['api']
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

const stubMutableViewport = (): { setMobile: (mobile: boolean) => void } => {
  let matches = false
  const listeners = new Set<() => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(max-width: 47.999rem)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) =>
      listeners.delete(listener)
    ),
    dispatchEvent: vi.fn()
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media)
  )
  return {
    setMobile: (mobile) => {
      matches = mobile
      listeners.forEach((listener) => listener())
    }
  }
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

  it('keeps the subtle background and red-dot treatment on unread rows only', async () => {
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const unreadRow = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Approval needed')
    )
    expect(unreadRow?.className).toContain('bg-bg-100/70')
    expect(unreadRow?.querySelector('.size-1\\.5.bg-destructive')).not.toBeNull()

    const current = useNotificationInboxStore.getState().items[0]
    await act(async () => {
      useNotificationInboxStore.setState({
        unreadCount: 0,
        items: current ? [{ ...current, readAt: Date.now() }] : []
      })
    })

    const readRow = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Approval needed')
    )
    expect(readRow?.className).not.toContain('bg-bg-100/70')
    expect(readRow?.querySelector('.size-1\\.5.bg-destructive')).toBeNull()
  })

  it('uses the success color for completed task icons', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item
        ? [
            {
              ...item,
              kind: 'task.completed',
              title: 'Task completed',
              actionState: undefined
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const icon = document.body.querySelector('.lucide-circle-check')
    expect(icon?.parentElement?.classList.contains('text-success-000')).toBe(true)
  })

  it('gives failed and waiting items their own glyphs and tones', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item
        ? [
            {
              ...item,
              id: 'failed-1',
              kind: 'task.failed' as const,
              title: 'Task failed',
              actionState: undefined
            },
            {
              ...item,
              id: 'waiting-1',
              kind: 'task.needs-attention' as const,
              attentionReason: 'waiting-plan-approval' as const,
              title: 'Plan waiting',
              actionState: 'pending' as const
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const failedIcon = document.body.querySelector('.lucide-circle-x')
    expect(failedIcon?.parentElement?.classList.contains('text-danger-000')).toBe(true)
    const planIcon = document.body.querySelector('.lucide-clipboard-list')
    expect(planIcon?.parentElement?.classList.contains('text-session-waiting')).toBe(true)
  })

  it('neutralizes the icon tile and chip once the request is settled', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item ? [{ ...item, actionState: 'expired' }] : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const icon = document.body.querySelector('.lucide-shield-check')
    expect(icon?.parentElement?.classList.contains('text-text-300')).toBe(true)
    expect(icon?.parentElement?.classList.contains('text-session-waiting')).toBe(false)
    const chip = [...document.body.querySelectorAll('span')].find(
      (span) => span.textContent === 'Expired'
    )
    expect(chip?.className).toContain('rounded-full')
    expect(chip?.className).toContain('border')
    expect(chip?.className).toContain('text-text-300')
  })

  it('dims read titles and clamps detail previews to two lines', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      unreadCount: 0,
      items: item
        ? [{ ...item, readAt: Date.now(), summary: 'A long summary that should clamp.' }]
        : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const row = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    const title = row?.querySelector('.truncate.font-medium')
    expect(title?.classList.contains('text-text-100')).toBe(true)
    const detail = [...document.body.querySelectorAll('span')].find(
      (span) => span.textContent === 'A long summary that should clamp.'
    )
    expect(detail?.className).toContain('line-clamp-2')
  })

  it('keeps group headings sticky inside the scroll container', async () => {
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const heading = document.body.querySelector<HTMLElement>('[id$="-unread"]')
    expect(heading?.className).toContain('sticky')
    expect(heading?.className).toContain('bg-bg-000')
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

  it('labels pending agent questions as responses instead of approvals', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item
        ? [
            {
              ...item,
              kind: 'task.needs-attention',
              source: 'agent-question',
              title: 'Response needed'
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    expect(document.body.textContent).toContain('Needs response')
    expect(document.body.textContent).not.toContain('Needs approval')
  })

  it.each([
    ['waiting-for-user', 'Waiting for your answer'],
    ['waiting-permission', 'Waiting for permission'],
    ['waiting-plan-approval', 'Waiting for plan approval']
  ] as const)('uses the shared Home label for %s', async (attentionReason, label) => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item ? [{ ...item, attentionReason }] : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    expect(document.body.textContent).toContain(label)
    expect(document.body.textContent).not.toContain('Needs approval')
    expect(document.body.textContent).not.toContain('Needs response')
  })

  it('shows the settled action state instead of the original wait reason', async () => {
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      items: item
        ? [
            {
              ...item,
              source: 'agent-question',
              attentionReason: 'waiting-for-user',
              actionState: 'resolved'
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    expect(document.body.textContent).toContain('Answered')
    expect(document.body.textContent).not.toContain('Waiting for your answer')
  })

  it('loads Projects before deciding whether a project notification target is valid', async () => {
    const targetProject = { id: 'project-2', name: 'Fresh project' } as Project
    const listProjects = vi.fn(async () => [targetProject])
    window.api = {
      ...window.api,
      projects: { list: listProjects }
    } as unknown as Window['api']
    useProjectStore.setState(createInitialProjectState())
    const markRead = vi.fn(async () => undefined)
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, projectId: targetProject.id, sessionId: undefined }] : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const message = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Approval needed')
    )
    expect(message).toBeDefined()
    await act(async () => {
      message?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listProjects).toHaveBeenCalledOnce()
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: targetProject.id
    })
    expect(markRead).toHaveBeenCalledWith(['message-1'])
    expect(document.body.querySelector('[aria-label="Message center"]')).toBeNull()
  })

  it('makes target invalidation override pending labels, replay, and navigation', async () => {
    const replayConnectorApproval = vi.fn(async (): Promise<ConnectorApprovalRequest> => ({
      id: 'request-1',
      connector: 'pubchem',
      method: 'search',
      argsPreview: '{}',
      availableScopes: ['once']
    }))
    const openSessionById = vi.fn(() => true)
    const openProject = vi.fn(() => true)
    const markRead = vi.fn(async () => undefined)
    window.api.settings.replayConnectorApproval = replayConnectorApproval
    useNavigationStore.setState({ openSessionById, openProject })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item
        ? [
            {
              ...item,
              projectId: 'project-1',
              sessionId: 'session-1',
              attentionReason: 'waiting-permission',
              targetInvalidatedAt: Date.now()
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )
    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    expect(message?.disabled).toBe(true)
    expect(message?.textContent).toContain('Session no longer available')
    expect(message?.textContent).not.toContain('Needs approval')
    expect(message?.textContent?.match(/Session no longer available/g)).toHaveLength(1)

    if (message) message.disabled = false
    await act(async () => message?.click())
    expect(replayConnectorApproval).not.toHaveBeenCalled()
    expect(openSessionById).not.toHaveBeenCalled()
    expect(openProject).not.toHaveBeenCalled()
    expect(markRead).not.toHaveBeenCalled()
  })

  it('uses compact vertical spacing for message rows and group headings', async () => {
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const message = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Approval needed')
    )
    const heading = document.body.querySelector<HTMLElement>('[id$="-unread"]')

    expect(message?.className).toContain('py-2')
    expect(message?.className).not.toContain('py-2.5')
    expect(heading?.className).toContain('pt-1.5')
    expect(heading?.className).toContain('pb-0.5')
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

  it('keeps a message unread and the center open when target navigation is rejected', async () => {
    const openSessionById = vi.fn(() => false)
    const markRead = vi.fn(async () => undefined)
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, sessionId: 'session-missing' }] : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(openSessionById).toHaveBeenCalledWith(
      'session-missing',
      'notification',
      expect.any(Function)
    )
    expect(markRead).not.toHaveBeenCalled()
    expect(document.body.querySelector('[aria-label="Message center"]')).not.toBeNull()
  })

  it('finishes a notification action after deferred preview confirmation', async () => {
    let resumeNavigation: (() => void) | undefined
    const openSessionById = vi.fn(
      (_sessionId: string, _origin: string, afterNavigate?: () => void) => {
        resumeNavigation = afterNavigate
        return false
      }
    )
    const markRead = vi.fn(async () => undefined)
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, sessionId: 'session-1' }] : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )

    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(markRead).not.toHaveBeenCalled()
    expect(document.body.querySelector('[aria-label="Message center"]')).not.toBeNull()

    await act(async () => resumeNavigation?.())

    expect(markRead).toHaveBeenCalledWith(['message-1'])
    expect(document.body.querySelector('[aria-label="Message center"]')).toBeNull()
  })

  it('continues the notification action when marking the message as read fails', async () => {
    const connectorRequest = {
      id: 'request-1',
      connector: 'pubchem',
      method: 'search',
      argsPreview: '{}',
      availableScopes: ['once']
    } satisfies ConnectorApprovalRequest
    const replayConnectorApproval = vi.fn(async () => connectorRequest)
    const enqueueApproval = vi.fn()
    const openSessionById = vi.fn(() => true)
    const markRead = vi.fn(async () => {
      throw new Error('notification write failed')
    })
    window.api.settings.replayConnectorApproval = replayConnectorApproval
    useSettingsStore.setState({ enqueueApproval })
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, sessionId: 'session-1' }] : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )
    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(markRead).toHaveBeenCalledWith(['message-1'])
    expect(replayConnectorApproval).toHaveBeenCalledWith('request-1')
    expect(enqueueApproval).toHaveBeenCalledWith(connectorRequest)
    expect(openSessionById).toHaveBeenCalledWith('session-1', 'notification', expect.any(Function))
    expect(container.querySelector('[aria-label="Message center"]')).toBeNull()
  })

  it('continues navigation when approval replay fails', async () => {
    const openSessionById = vi.fn(() => true)
    const markRead = vi.fn(async () => undefined)
    window.api.settings.replayConnectorApproval = vi.fn(async () => {
      throw new Error('approval replay failed')
    })
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, sessionId: 'session-1' }] : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )
    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(openSessionById).toHaveBeenCalledWith('session-1', 'notification', expect.any(Function))
    expect(markRead).toHaveBeenCalledWith(['message-1'])
    expect(container.querySelector('[aria-label="Message center"]')).toBeNull()
  })

  it('opens a credential wait without replaying it as a connector approval', async () => {
    const replayConnectorApproval = vi.fn(async () => null)
    const openSessionById = vi.fn(() => true)
    window.api.settings.replayConnectorApproval = replayConnectorApproval
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead: vi.fn(async () => undefined),
      items: item
        ? [
            {
              ...item,
              kind: 'task.needs-attention',
              attentionReason: 'waiting-for-user',
              sessionId: 'session-1'
            }
          ]
        : []
    })
    await act(async () => root.render(<NotificationBell />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )
    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(replayConnectorApproval).not.toHaveBeenCalled()
    expect(openSessionById).toHaveBeenCalledWith('session-1', 'notification', expect.any(Function))
  })

  it('does not wait for the read write before navigating to the notification target', async () => {
    let completeMarkRead: (() => void) | undefined
    const markRead = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeMarkRead = resolve
        })
    )
    const openSessionById = vi.fn(() => true)
    useNavigationStore.setState({ openSessionById })
    const item = useNotificationInboxStore.getState().items[0]
    useNotificationInboxStore.setState({
      markRead,
      items: item ? [{ ...item, actionState: 'resolved', sessionId: 'session-1' }] : []
    })
    await act(async () => root.render(<NotificationBell />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
    )
    const message = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Approval needed')
    )
    await act(async () => message?.click())

    expect(markRead).toHaveBeenCalledWith(['message-1'])
    expect(openSessionById).toHaveBeenCalledWith('session-1', 'notification', expect.any(Function))
    expect(container.querySelector('[aria-label="Message center"]')).toBeNull()

    completeMarkRead?.()
  })

  it.each([
    ['connector', undefined],
    ['compute', undefined],
    ['connector', 'session-1'],
    ['compute', 'session-1']
  ] as const)(
    'reopens a pending %s approval with session %s from its in-memory broker request',
    async (source, sessionId) => {
      const connectorRequest = {
        id: 'request-1',
        connector: 'pubchem',
        method: 'search',
        argsPreview: '{}',
        availableScopes: ['once']
      } satisfies ConnectorApprovalRequest
      const computeRequest = {
        id: 'request-1',
        operation: 'call_command',
        provider_id: 'ssh:cluster',
        provider_name: 'Cluster',
        shape: 'direct_ssh',
        intent: 'Run a command',
        command_preview: 'pwd',
        command_full: 'pwd'
      } satisfies ComputeApprovalRequest
      const replayConnectorApproval = vi.fn(async () => connectorRequest)
      const replayApproval = vi.fn(async () => computeRequest)
      const enqueueConnector = vi.fn()
      const enqueueCompute = vi.fn()
      const openSessionById = vi.fn(() => true)
      window.api.settings.replayConnectorApproval = replayConnectorApproval
      window.api.compute.replayApproval = replayApproval
      useSettingsStore.setState({ enqueueApproval: enqueueConnector })
      useComputeStore.setState({ enqueueApproval: enqueueCompute })
      useNavigationStore.setState({ openSessionById })
      const item = useNotificationInboxStore.getState().items[0]
      useNotificationInboxStore.setState({
        markRead: vi.fn(async () => undefined),
        items: item ? [{ ...item, source, sessionId }] : []
      })
      await act(async () => root.render(<NotificationBell />))

      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')?.click()
      )
      const message = [...document.body.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Approval needed')
      )
      await act(async () => message?.click())

      if (source === 'connector') {
        expect(replayConnectorApproval).toHaveBeenCalledWith('request-1')
        expect(enqueueConnector).toHaveBeenCalledWith(connectorRequest)
      } else {
        expect(replayApproval).toHaveBeenCalledWith('request-1')
        expect(enqueueCompute).toHaveBeenCalledWith(computeRequest)
      }
      if (sessionId) {
        expect(openSessionById).toHaveBeenCalledWith(
          sessionId,
          'notification',
          expect.any(Function)
        )
      } else {
        expect(openSessionById).not.toHaveBeenCalled()
      }
      expect(container.querySelector('[aria-label="Message center"]')).toBeNull()
    }
  )

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

  it('keeps mobile message-center focus modal and restores its trigger on dismissal', async () => {
    stubMobileViewport()
    container.id = 'root'
    await act(async () =>
      root.render(
        <>
          <button type="button">Background action</button>
          <NotificationBell />
        </>
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')
    trigger?.focus()
    await act(async () => trigger?.click())

    const dialog = document.body.querySelector<HTMLElement>('[aria-label="Message center"]')
    expect(container.inert).toBe(true)
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(dialog?.contains(document.activeElement)).toBe(true)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.focus()
    })
    expect(dialog?.contains(document.activeElement)).toBe(true)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.activeElement).toBe(trigger)
    expect(container.inert).toBe(false)
    expect(container.getAttribute('aria-hidden')).toBeNull()

    trigger?.focus()
    await act(async () => trigger?.click())
    const dismiss = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss messages"]'
    )
    await act(async () => dismiss?.click())
    expect(document.activeElement).toBe(trigger)
  })

  it('restores a visible bell when the mobile opener becomes inert', async () => {
    stubMobileViewport()
    container.id = 'root'
    await act(async () =>
      root.render(
        <>
          <div data-testid="mobile-sidebar">
            <NotificationBell
              onOpen={() =>
                container.querySelector('[data-testid="mobile-sidebar"]')?.setAttribute('inert', '')
              }
            />
          </div>
          <NotificationBell />
        </>
      )
    )

    const [sidebarTrigger, visibleTrigger] = container.querySelectorAll<HTMLButtonElement>(
      '[data-notification-bell-trigger="true"]'
    )
    const visibleRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        width: 36,
        height: 36,
        top: 0,
        right: 36,
        bottom: 36,
        left: 0,
        toJSON: () => ({})
      }) as DOMRect
    sidebarTrigger!.getBoundingClientRect = visibleRect
    visibleTrigger!.getBoundingClientRect = visibleRect
    sidebarTrigger?.focus()
    await act(async () => sidebarTrigger?.click())

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.activeElement).toBe(visibleTrigger)
  })

  it.each([
    ['while still mobile', false],
    ['after becoming desktop', true]
  ])(
    'restores a visible bell when an open mobile center unmounts %s',
    async (_, becomesDesktop) => {
      const viewport = stubMutableViewport()
      viewport.setMobile(true)
      container.id = 'root'
      await act(async () =>
        root.render(
          <>
            <NotificationBell key="route-bell" />
            <NotificationBell key="persistent-bell" />
          </>
        )
      )

      const [routeTrigger, persistentTrigger] = container.querySelectorAll<HTMLButtonElement>(
        '[data-notification-bell-trigger="true"]'
      )
      persistentTrigger!.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          width: 36,
          height: 36,
          top: 0,
          right: 36,
          bottom: 36,
          left: 0,
          toJSON: () => ({})
        }) as DOMRect
      routeTrigger?.focus()
      await act(async () => routeTrigger?.click())
      if (becomesDesktop) await act(async () => viewport.setMobile(false))

      await act(async () => root.render(<NotificationBell key="persistent-bell" />))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(document.activeElement).toBe(persistentTrigger)
    }
  )

  it('moves focus into an open message center when the viewport becomes mobile', async () => {
    const viewport = stubMutableViewport()
    container.id = 'root'
    await act(async () => root.render(<NotificationBell />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Messages,"]')
    trigger?.focus()
    await act(async () => trigger?.click())
    expect(
      document.body
        .querySelector<HTMLElement>('[aria-label="Message center"]')
        ?.hasAttribute('aria-modal')
    ).toBe(false)

    await act(async () => viewport.setMobile(true))

    const dialog = document.body.querySelector<HTMLElement>('[aria-label="Message center"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(container.inert).toBe(true)
    expect(dialog?.contains(document.activeElement)).toBe(true)

    await act(async () => trigger?.focus())
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })
})

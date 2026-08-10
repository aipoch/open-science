// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act, Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Toolbox } from 'lucide-react'
import type { ChatSession } from '@/stores/session-store'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createMessage = (): ChatSession['messages'][number] => ({
  id: 'message-1',
  role: 'user',
  content: 'Ready',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})

const renderSidebar = async (sessions: ChatSession[]): Promise<string> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')

  return renderToStaticMarkup(
    <WorkspaceSidebar
      projectName="Example project"
      sessions={sessions}
      activeSessionId={sessions[0]?.id}
      canCreateConversation
      canMutateConversations
      canDeleteConversations
      onGoHome={vi.fn()}
      onNewConversation={vi.fn()}
      isFilesOpen={false}
      onOpenFiles={vi.fn()}
      onOpenSession={vi.fn()}
      onRenameSession={vi.fn()}
      canDownloadArtifacts
      onDownloadArtifacts={vi.fn()}
      onViewNotebook={vi.fn()}
      onExportSession={vi.fn()}
      onTogglePin={vi.fn()}
      onDeleteSession={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
}

type ElementWithProps = ReactElement<Record<string, unknown>>

const collectElements = (node: ReactNode): ElementWithProps[] => {
  const elements: ElementWithProps[] = []

  const visit = (value: ReactNode): void => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return

      const element = child as ElementWithProps
      elements.push(element)
      visit(element.props.children as ReactNode)
    })
  }

  visit(node)
  return elements
}

const getTextContent = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return ''

  return Children.toArray((node as ElementWithProps).props.children as ReactNode)
    .map(getTextContent)
    .join('')
}

describe('WorkspaceSidebar accessible render', () => {
  it('keeps the sidebar card inset even on both sides', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('m-2 flex min-h-0 flex-1 flex-col rounded-lg')
    expect(html).not.toContain('mr-0')
    expect(html).toContain('aria-label="Messages, no unread messages"')
  })

  it('softens the session list behind the footer controls', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('-top-12 h-12 bg-gradient-to-t from-rail-card-bg')
    expect(html).not.toContain('-top-6 h-6 bg-gradient-to-t from-rail-card-bg')
  })

  it('reserves header padding for the external panel toggle without spacer markup', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('flex items-start pr-9')
    expect(html).not.toContain('workspace-sidebar-toggle-slot')
  })

  it('renders non-visual session status text for assistive technology', async () => {
    const html = await renderSidebar([
      createSession({ id: 'running-session', status: 'running' }),
      createSession({
        id: 'permission-session',
        title: 'Permission session',
        status: 'waiting-permission'
      })
    ])

    expect(html).toContain('Session status: Running')
    expect(html).toContain('Session status: Waiting for permission')
  })

  it('gives each session action trigger a session-specific accessible name', async () => {
    const html = await renderSidebar([
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ])

    expect(html).toContain('aria-label="Open actions for Notebook review"')
    expect(html).toContain('aria-label="Open actions for Dataset cleanup"')
  })

  it('wires session open and row menu actions to the matching session', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ]
    const onOpenSession = vi.fn()
    const onRenameSession = vi.fn()
    const onDownloadArtifacts = vi.fn()
    const onDeleteSession = vi.fn()
    const onExportSession = vi.fn()
    const onArchiveSession = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession,
      onRenameSession,
      canDownloadArtifacts: true,
      onDownloadArtifacts,
      onViewNotebook: vi.fn(),
      onExportSession,
      onTogglePin: vi.fn(),
      canArchiveSession: () => true,
      onArchiveSession,
      onDeleteSession,
      onOpenSettings: vi.fn()
    })
    const elements = collectElements(tree)
    const notebookButton = elements.find(
      (element) =>
        element.type === 'button' &&
        getTextContent(element).includes('Notebook review') &&
        typeof element.props.onClick === 'function'
    )
    const renameItems = elements.filter((element) => getTextContent(element).trim() === 'Rename…')
    const downloadItems = elements.filter(
      (element) => getTextContent(element).trim() === 'Download all artifacts'
    )
    const deleteItems = elements.filter((element) => getTextContent(element).trim() === 'Delete')
    const archiveItems = elements.filter((element) => getTextContent(element).trim() === 'Archive')
    const markdownItems = elements.filter(
      (element) => getTextContent(element).trim() === 'Markdown'
    )
    const pdfItems = elements.filter((element) => getTextContent(element).trim() === 'PDF')

    expect(notebookButton?.props.onClick).toBeTypeOf('function')
    ;(notebookButton?.props.onClick as () => void)()
    expect(onOpenSession).toHaveBeenCalledWith('session-a')

    expect(renameItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(renameItems[1]?.props.onSelect as () => void)()
    expect(onRenameSession).toHaveBeenCalledWith(sessions[1])

    expect(downloadItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(downloadItems[1]?.props.onSelect as () => void)()
    expect(onDownloadArtifacts).toHaveBeenCalledWith(sessions[1])

    expect(markdownItems[0]?.props.onSelect).toBeTypeOf('function')
    ;(markdownItems[0]?.props.onSelect as () => void)()
    expect(onExportSession).toHaveBeenCalledWith(sessions[0], 'markdown')

    expect(pdfItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(pdfItems[1]?.props.onSelect as () => void)()
    expect(onExportSession).toHaveBeenCalledWith(sessions[1], 'pdf')

    expect(archiveItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(archiveItems[1]?.props.onSelect as () => void)()
    expect(onArchiveSession).toHaveBeenCalledWith(sessions[1])

    expect(deleteItems[0]?.props.onSelect).toBeTypeOf('function')
    ;(deleteItems[0]?.props.onSelect as () => void)()
    expect(onDeleteSession).toHaveBeenCalledWith(sessions[0])
  })

  it('renders Customize between New and Files and wires both entries', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const onOpenFiles = vi.fn()
    const onOpenSettings = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a', title: 'Notebook review' })],
      activeSessionId: 'session-a',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: true,
      onOpenFiles,
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings
    })
    const buttons = collectElements(tree).filter((element) => element.type === 'button')
    const newButtonIndex = buttons.findIndex((button) => getTextContent(button).trim() === 'New')
    const customizeButton = buttons.find((button) => getTextContent(button).trim() === 'Customize')
    const filesButton = buttons.find((button) => getTextContent(button).trim() === 'Files')

    expect(newButtonIndex).toBeGreaterThanOrEqual(0)
    expect(buttons[newButtonIndex + 1]).toBe(customizeButton)
    expect(buttons[newButtonIndex + 2]).toBe(filesButton)
    expect(collectElements(customizeButton).some((element) => element.type === Toolbox)).toBe(true)
    expect(filesButton?.props['aria-controls']).toBe('right-panel')
    expect(filesButton?.props['aria-pressed']).toBe(true)

    expect(customizeButton?.props.onClick).toBeTypeOf('function')
    ;(customizeButton?.props.onClick as () => void)()
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    expect(filesButton?.props.onClick).toBeTypeOf('function')
    ;(filesButton?.props.onClick as () => void)()
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
  })

  it('wires the View notebook menu item to the matching session', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ]
    const onViewNotebook = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onViewNotebook,
      onExportSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const viewNotebookItems = collectElements(tree).filter(
      (element) => getTextContent(element).trim() === 'View notebook'
    )

    expect(viewNotebookItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(viewNotebookItems[1]?.props.onSelect as () => void)()
    expect(onViewNotebook).toHaveBeenCalledWith(sessions[1])
  })

  it('renders a Pinned section above Active only when a session is pinned', async () => {
    const withoutPins = await renderSidebar([createSession({ id: 'session-a' })])
    expect(withoutPins).not.toContain('>Pinned<')
    expect(withoutPins).toContain('>Active<')

    const withPin = await renderSidebar([
      createSession({ id: 'pinned-session', title: 'Kept handy', pinned: true }),
      createSession({ id: 'plain-session', title: 'Everyday work' })
    ])
    // The pinned header must precede the active header so pinned conversations sit at the top.
    expect(withPin).toContain('>Pinned<')
    expect(withPin.indexOf('>Pinned<')).toBeLessThan(withPin.indexOf('>Active<'))
  })

  it('groups unpinned sessions by live activity, recent completion, and local date', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 7, 9, 13, 30).getTime()
    vi.setSystemTime(now)

    try {
      const html = await renderSidebar([
        createSession({
          id: 'older-session',
          title: 'Older conversation',
          status: 'idle',
          updatedAt: new Date(2026, 7, 2, 12).getTime()
        }),
        createSession({
          id: 'today-session',
          title: 'Earlier today',
          status: 'idle',
          updatedAt: now - 16 * 60_000
        }),
        createSession({
          id: 'failed-session',
          title: 'Failed today',
          status: 'error',
          updatedAt: now
        }),
        createSession({
          id: 'week-session',
          title: 'Earlier this week',
          status: 'idle',
          updatedAt: new Date(2026, 7, 4, 12).getTime()
        }),
        createSession({
          id: 'yesterday-session',
          title: 'Yesterday conversation',
          status: 'idle',
          updatedAt: new Date(2026, 7, 8, 12).getTime()
        }),
        createSession({
          id: 'recent-session',
          title: 'Just completed',
          status: 'idle',
          updatedAt: now - 14 * 60_000
        }),
        createSession({
          id: 'waiting-session',
          title: 'Waiting for approval',
          status: 'waiting-permission',
          updatedAt: new Date(2026, 7, 1, 12).getTime()
        }),
        createSession({
          id: 'waiting-user-session',
          title: 'Waiting for an answer',
          status: 'waiting-for-user',
          updatedAt: new Date(2026, 7, 1, 12).getTime()
        }),
        createSession({
          id: 'waiting-plan-session',
          title: 'Waiting for plan approval',
          status: 'waiting-plan-approval',
          updatedAt: new Date(2026, 7, 1, 12).getTime()
        }),
        createSession({
          id: 'pinned-session',
          title: 'Pinned running session',
          status: 'running',
          pinned: true,
          updatedAt: now
        })
      ])

      const headings = ['Pinned', 'Active', 'Today', 'Yesterday', 'This week', 'Older']
      headings.reduce((previousIndex, heading) => {
        const index = html.indexOf(`>${heading}<`)
        expect(index).toBeGreaterThan(previousIndex)
        return index
      }, -1)

      expect(html.indexOf('Pinned running session')).toBeLessThan(html.indexOf('>Active<'))
      expect(html.indexOf('Waiting for approval')).toBeLessThan(html.indexOf('>Today<'))
      expect(html.indexOf('Waiting for an answer')).toBeLessThan(html.indexOf('>Today<'))
      expect(html.indexOf('Waiting for plan approval')).toBeLessThan(html.indexOf('>Today<'))
      expect(html.indexOf('Just completed')).toBeLessThan(html.indexOf('>Today<'))
      expect(html.indexOf('Earlier today')).toBeGreaterThan(html.indexOf('>Today<'))
      expect(html.indexOf('Failed today')).toBeGreaterThan(html.indexOf('>Today<'))
      expect(html.indexOf('Older conversation')).toBeGreaterThan(html.indexOf('>Older<'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves a recently completed idle session to Today when its Active grace period expires', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 7, 9, 13, 30).getTime()
    vi.setSystemTime(now)
    const session = createSession({
      id: 'recent-session',
      title: 'Just completed',
      status: 'idle',
      updatedAt: now - 14 * 60_000
    })
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const container = document.createElement('div')
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebar
            projectName="Example project"
            sessions={[session]}
            activeSessionId={undefined}
            canCreateConversation
            canMutateConversations
            canDeleteConversations
            onGoHome={vi.fn()}
            onNewConversation={vi.fn()}
            isFilesOpen={false}
            onOpenFiles={vi.fn()}
            onOpenSession={vi.fn()}
            onRenameSession={vi.fn()}
            canDownloadArtifacts
            onDownloadArtifacts={vi.fn()}
            onViewNotebook={vi.fn()}
            onExportSession={vi.fn()}
            onTogglePin={vi.fn()}
            onDeleteSession={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        )
      })

      expect(container.textContent).toContain('Active')
      expect(container.textContent).not.toContain('Today')

      await act(async () => {
        vi.advanceTimersByTime(60_001)
      })

      expect(container.textContent).not.toContain('Active')
      expect(container.textContent).toContain('Today')
      expect(container.textContent).toContain('Just completed')
    } finally {
      act(() => root.unmount())
      vi.useRealTimers()
    }
  })

  it.each([
    {
      platform: 'darwin',
      modifierKey: 'Meta',
      modifier: { metaKey: true },
      hint: '⌘1',
      ariaShortcut: 'Meta+1'
    },
    {
      platform: 'win32',
      modifierKey: 'Control',
      modifier: { ctrlKey: true },
      hint: 'Ctrl+1',
      ariaShortcut: 'Control+1'
    },
    {
      platform: 'linux',
      modifierKey: 'Control',
      modifier: { ctrlKey: true },
      hint: 'Ctrl+1',
      ariaShortcut: 'Control+1'
    }
  ])(
    'shows and handles the first nine session shortcuts on $platform',
    async ({ platform, modifierKey, modifier, hint, ariaShortcut }) => {
      const originalApi = window.api
      window.api = { ...originalApi, platform } as never
      const sessions = [
        createSession({ id: 'active-first', title: 'Active first' }),
        createSession({ id: 'pinned-target', title: 'Pinned target', pinned: true }),
        ...Array.from({ length: 8 }, (_, index) =>
          createSession({ id: `active-${index + 2}`, title: `Active ${index + 2}` })
        )
      ]
      const onOpenSession = vi.fn()
      const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
      const container = document.createElement('div')
      const root = createRoot(container)
      let dialog: HTMLDivElement | undefined

      try {
        await act(async () => {
          root.render(
            <WorkspaceSidebar
              projectName="Example project"
              sessions={sessions}
              activeSessionId={undefined}
              canCreateConversation
              canMutateConversations
              canDeleteConversations
              onGoHome={vi.fn()}
              onNewConversation={vi.fn()}
              isFilesOpen={false}
              onOpenFiles={vi.fn()}
              onOpenSession={onOpenSession}
              onRenameSession={vi.fn()}
              canDownloadArtifacts
              onDownloadArtifacts={vi.fn()}
              onViewNotebook={vi.fn()}
              onExportSession={vi.fn()}
              onTogglePin={vi.fn()}
              onDeleteSession={vi.fn()}
              onOpenSettings={vi.fn()}
            />
          )
        })

        const shortcutButtons = container.querySelectorAll<HTMLButtonElement>(
          'button[aria-keyshortcuts]'
        )
        expect(shortcutButtons).toHaveLength(9)
        expect(shortcutButtons[0]?.textContent).toContain('Pinned target')
        expect(shortcutButtons[0]?.getAttribute('aria-keyshortcuts')).toBe(ariaShortcut)

        await act(async () => {
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: modifierKey, ...modifier, bubbles: true })
          )
        })
        expect(container.querySelectorAll('kbd')).toHaveLength(9)
        expect(container.textContent).toContain(hint)

        const openEvent = new KeyboardEvent('keydown', {
          key: '1',
          ...modifier,
          bubbles: true,
          cancelable: true
        })
        await act(async () => window.dispatchEvent(openEvent))
        expect(openEvent.defaultPrevented).toBe(true)
        expect(onOpenSession).toHaveBeenCalledWith('pinned-target')

        await act(async () => {
          window.dispatchEvent(new KeyboardEvent('keyup', { key: modifierKey, bubbles: true }))
        })
        expect(container.querySelector('kbd')).toBeNull()

        onOpenSession.mockClear()
        dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        document.body.appendChild(dialog)
        await act(async () => {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: '2',
              ...modifier,
              bubbles: true,
              cancelable: true
            })
          )
        })
        expect(onOpenSession).not.toHaveBeenCalled()
      } finally {
        dialog?.remove()
        act(() => root.unmount())
        window.api = originalApi
      }
    }
  )

  it('shows Pin for an unpinned session and Unpin for a pinned one, wired to the session', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Unpinned one' }),
      createSession({ id: 'session-b', title: 'Pinned one', pinned: true })
    ]
    const onTogglePin = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin,
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const elements = collectElements(tree)
    const pinItem = elements.find((element) => getTextContent(element).trim() === 'Pin')
    const unpinItem = elements.find((element) => getTextContent(element).trim() === 'Unpin')

    // The unpinned session-a shows "Pin"; the pinned session-b shows "Unpin".
    expect(pinItem?.props.onSelect).toBeTypeOf('function')
    ;(pinItem?.props.onSelect as () => void)()
    expect(onTogglePin).toHaveBeenCalledWith(sessions[0])

    onTogglePin.mockClear()
    expect(unpinItem?.props.onSelect).toBeTypeOf('function')
    ;(unpinItem?.props.onSelect as () => void)()
    expect(onTogglePin).toHaveBeenCalledWith(sessions[1])
  })

  it('keeps target-validated deletion available while other mutations are recovering', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [session],
      activeSessionId: session.id,
      canCreateConversation: false,
      canMutateConversations: false,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const elements = collectElements(tree)
    const pinItem = elements.find((element) => getTextContent(element).trim() === 'Pin')
    const renameItem = elements.find((element) => getTextContent(element).trim() === 'Rename…')
    const deleteItem = elements.find((element) => getTextContent(element).trim() === 'Delete')

    expect(pinItem?.props.disabled).toBe(true)
    expect(renameItem?.props.disabled).toBe(true)
    expect(deleteItem?.props.disabled).toBe(false)
  })

  it('disables conversation export for active, waiting, or empty sessions', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [
        createSession({ id: 'running', status: 'running', messages: [createMessage()] }),
        createSession({
          id: 'waiting-user',
          status: 'waiting-for-user',
          messages: [createMessage()]
        }),
        createSession({
          id: 'waiting',
          status: 'waiting-permission',
          messages: [createMessage()]
        }),
        createSession({ id: 'empty', status: 'idle', messages: [] }),
        createSession({ id: 'ready', status: 'idle', messages: [createMessage()] })
      ],
      activeSessionId: 'ready',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const exportTriggers = collectElements(tree).filter(
      (element) =>
        getTextContent(element).trim() === 'Export conversation' &&
        typeof element.props.disabled === 'boolean'
    )

    expect(exportTriggers).toHaveLength(5)
    expect(exportTriggers[0]?.props.disabled).toBe(true)
    expect(exportTriggers[1]?.props.disabled).toBe(true)
    expect(exportTriggers[2]?.props.disabled).toBe(true)
    expect(exportTriggers[3]?.props.disabled).toBe(true)
    expect(exportTriggers[4]?.props.disabled).toBe(false)
  })

  it('hides conversation export when the runtime does not expose that capability', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ status: 'idle', messages: [createMessage()] })],
      activeSessionId: 'session-1',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    expect(getTextContent(tree)).not.toContain('Export conversation')
  })

  it('hides artifact downloads when the runtime does not provide the desktop save capability', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [session],
      activeSessionId: session.id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    const downloadItem = collectElements(tree).find(
      (element) => getTextContent(element).trim() === 'Download all artifacts'
    )

    expect(downloadItem).toBeUndefined()
  })
})

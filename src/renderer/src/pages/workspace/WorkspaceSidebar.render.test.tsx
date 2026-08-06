import { renderToStaticMarkup } from 'react-dom/server'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { ChatSession } from '@/stores/session-store'
import { describe, expect, it, vi } from 'vitest'

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
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
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
    const tree = WorkspaceSidebar({
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

  it('renders Files directly after New and wires it to the preview opener', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const onOpenFiles = vi.fn()
    const tree = WorkspaceSidebar({
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
      onOpenSettings: vi.fn()
    })
    const buttons = collectElements(tree).filter((element) => element.type === 'button')
    const newButtonIndex = buttons.findIndex((button) => getTextContent(button).trim() === 'New')
    const filesButton = buttons.find((button) => getTextContent(button).trim() === 'Files')

    expect(newButtonIndex).toBeGreaterThanOrEqual(0)
    expect(buttons[newButtonIndex + 1]).toBe(filesButton)
    expect(filesButton?.props['aria-controls']).toBe('right-panel')
    expect(filesButton?.props['aria-pressed']).toBe(true)

    expect(filesButton?.props.onClick).toBeTypeOf('function')
    ;(filesButton?.props.onClick as () => void)()
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
  })

  it('wires the View notebook menu item to the matching session', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ]
    const onViewNotebook = vi.fn()
    const tree = WorkspaceSidebar({
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

  it('shows Pin for an unpinned session and Unpin for a pinned one, wired to the session', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Unpinned one' }),
      createSession({ id: 'session-b', title: 'Pinned one', pinned: true })
    ]
    const onTogglePin = vi.fn()
    const tree = WorkspaceSidebar({
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
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const tree = WorkspaceSidebar({
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

  it('disables conversation export for running, waiting-permission, or empty sessions', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebar({
      projectName: 'Example project',
      sessions: [
        createSession({ id: 'running', status: 'running', messages: [createMessage()] }),
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

    expect(exportTriggers).toHaveLength(4)
    expect(exportTriggers[0]?.props.disabled).toBe(true)
    expect(exportTriggers[1]?.props.disabled).toBe(true)
    expect(exportTriggers[2]?.props.disabled).toBe(true)
    expect(exportTriggers[3]?.props.disabled).toBe(false)
  })

  it('hides conversation export when the runtime does not expose that capability', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebar({
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
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const tree = WorkspaceSidebar({
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

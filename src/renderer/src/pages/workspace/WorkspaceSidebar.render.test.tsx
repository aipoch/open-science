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

const renderSidebar = async (sessions: ChatSession[]): Promise<string> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')

  return renderToStaticMarkup(
    <WorkspaceSidebar
      projectName="Example project"
      sessions={sessions}
      activeSessionId={sessions[0]?.id}
      canCreateConversation
      onGoHome={vi.fn()}
      onNewConversation={vi.fn()}
      isFilesOpen={false}
      onOpenFiles={vi.fn()}
      onOpenSession={vi.fn()}
      onRenameSession={vi.fn()}
      onViewNotebook={vi.fn()}
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
    const onDeleteSession = vi.fn()
    const tree = WorkspaceSidebar({
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession,
      onRenameSession,
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
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
    const deleteItems = elements.filter((element) => getTextContent(element).trim() === 'Delete')

    expect(notebookButton?.props.onClick).toBeTypeOf('function')
    ;(notebookButton?.props.onClick as () => void)()
    expect(onOpenSession).toHaveBeenCalledWith('session-a')

    expect(renameItems[1]?.props.onSelect).toBeTypeOf('function')
    ;(renameItems[1]?.props.onSelect as () => void)()
    expect(onRenameSession).toHaveBeenCalledWith(sessions[1])

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
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: true,
      onOpenFiles,
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      onViewNotebook: vi.fn(),
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
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onViewNotebook,
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
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      onViewNotebook: vi.fn(),
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
})

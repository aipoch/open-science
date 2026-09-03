// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act, Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Toolbox } from 'lucide-react'
import {
  resolveActionMenuEntries,
  type ActionMenuSpec,
  type ResolvedActionMenuEntry
} from '@/components/action-menu/action-menu-model'
import type { ChatSession } from '@/stores/session-store'
import { useUpdateStore } from '@/stores/update-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { clickRadixMenuItem, openRadixMenu } from '../settings/test-utils'
import type { SessionActionId, SessionActionInvocation } from './session-action-menu'

vi.mock('react-i18next', () => createI18nTestStub())
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

const deferred = <T,>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createDelegatedQuestionSession = (): ChatSession =>
  createSession({
    id: 'delegated-question',
    title: 'Delegated question',
    status: 'running',
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'running',
          activeBranchId: 'root-branch',
          createdAt: 1
        },
        {
          id: 'child',
          parentFrameId: 'root',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: 'Researcher',
          status: 'completed',
          activeBranchId: 'child-branch',
          createdAt: 2
        }
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'child-branch',
          agentFrameId: 'child',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Research this topic',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: 'root-branch',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    runtimeContext: {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: [],
        questionRequests: [
          {
            requestId: 'question-1',
            canonicalDigest: 'a'.repeat(64),
            sourceFrameId: 'child',
            sourceAttemptId: 'attempt-1',
            sourceRuntimeSegmentId: 'runtime-1',
            sourceMessageBranchId: 'child-branch',
            rootOriginMessageId: 'root-prompt',
            rootBranchId: 'root-branch',
            sourceName: 'Researcher',
            questions: [
              { question: 'Which scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }
            ],
            sequence: 1,
            askedAt: 2,
            status: 'pending',
            draftAnswers: [],
            draftQuestionIndex: 0
          }
        ]
      }
    }
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

const renderSidebar = async (
  sessions: ChatSession[],
  mobileMode = false,
  credentialPendingSessionIds?: ReadonlySet<string>
): Promise<string> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')

  return renderToStaticMarkup(
    <WorkspaceSidebar
      projectName="Example project"
      sessions={sessions}
      credentialPendingSessionIds={credentialPendingSessionIds}
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
      onOpenProjectSettings={vi.fn()}
      onNewProject={vi.fn()}
      canDownloadProjectArtifacts
      onDownloadProjectArtifacts={vi.fn()}
      mobileMode={mobileMode}
      isMobileOpen={mobileMode}
      onMobileClose={vi.fn()}
    />
  )
}

type SidebarProject = { id: string; name: string; description: string }

const mountProjectSidebar = async (
  otherProjects: readonly SidebarProject[],
  onOpenProject: (projectId: string) => void = vi.fn()
): Promise<{
  cleanup: () => void
  openMenu: () => void
  rerenderProjects: (projects: readonly SidebarProject[]) => Promise<void>
  rerenderSessions: (sessions: ChatSession[]) => Promise<void>
}> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let renderedProjects = otherProjects
  let renderedSessions = [createSession({ id: 'session-a' })]
  const render = (): void => {
    root.render(
      <WorkspaceSidebar
        projectName="Example project"
        otherProjects={renderedProjects}
        sessions={renderedSessions}
        activeSessionId="session-a"
        canCreateConversation
        canMutateConversations
        canDeleteConversations
        onGoHome={vi.fn()}
        onNewConversation={vi.fn()}
        isFilesOpen={false}
        onOpenFiles={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenProject={onOpenProject}
        onRenameSession={vi.fn()}
        canDownloadArtifacts
        onDownloadArtifacts={vi.fn()}
        onViewNotebook={vi.fn()}
        onTogglePin={vi.fn()}
        onDeleteSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onNewProject={vi.fn()}
      />
    )
  }

  await act(async () => {
    render()
  })

  return {
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
    openMenu: () =>
      openRadixMenu(container.querySelector<HTMLButtonElement>('[title="Example project"]')),
    rerenderProjects: async (projects) => {
      renderedProjects = projects
      await act(async () => render())
    },
    rerenderSessions: async (sessions) => {
      renderedSessions = sessions
      await act(async () => render())
    }
  }
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

type SessionActionTargetProps = ActionMenuSpec<SessionActionId, SessionActionInvocation> & {
  targetId: string
  invocation: SessionActionInvocation
}

const getSessionActionTargetProps = (
  tree: ReactNode,
  sessionId: string
): SessionActionTargetProps => {
  const target = collectElements(tree).find(
    (element) => element.props.targetId === `session:${sessionId}`
  )
  if (!target) throw new Error(`Session action target did not render: ${sessionId}`)
  return target.props as unknown as SessionActionTargetProps
}

const resolveSessionTargetEntries = (
  props: SessionActionTargetProps
): readonly ResolvedActionMenuEntry<SessionActionId>[] =>
  resolveActionMenuEntries(props, props.invocation)

const getTextContent = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return ''

  return Children.toArray((node as ElementWithProps).props.children as ReactNode)
    .map(getTextContent)
    .join('')
}

beforeEach(() => {
  useUpdateStore.setState({
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' },
    isDialogOpen: false
  })
})

describe('WorkspaceSidebar accessible render', () => {
  it('keeps the sidebar card inset even on both sides', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('m-[0.7px] flex min-h-0 flex-1 flex-col rounded-lg')
    expect(html).not.toContain('mr-0')
    expect(html).toContain('aria-label="Messages, no unread messages"')
  })

  it('places Settings before notifications in the footer controls', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])
    const settingsIndex = html.indexOf('aria-label="Settings"')
    const notificationsIndex = html.indexOf('aria-label="Messages, no unread messages"')

    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(notificationsIndex).toBeGreaterThanOrEqual(0)
    expect(settingsIndex).toBeLessThan(notificationsIndex)
  })

  it('softens the session list behind the footer controls', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('-top-12 h-12 bg-gradient-to-t from-rail-card-bg')
    expect(html).not.toContain('-top-6 h-6 bg-gradient-to-t from-rail-card-bg')
  })

  it('wraps desktop Session rows in the shared hover-preview provider only', async () => {
    const { SESSION_HOVER_PREVIEW_DELAY_MS, SESSION_HOVER_PREVIEW_SKIP_DELAY_MS } =
      await import('./SessionHoverPreview')
    const desktop = await renderSidebar([createSession({ id: 'session-a' })])
    const mobile = await renderSidebar([createSession({ id: 'session-a' })], true)
    const desktopContainer = document.createElement('div')
    const mobileContainer = document.createElement('div')
    desktopContainer.innerHTML = desktop
    mobileContainer.innerHTML = mobile
    const desktopSessionButton = desktopContainer.querySelector('[data-slot="session-open-button"]')
    const mobileSessionButton = mobileContainer.querySelector('[data-slot="session-open-button"]')

    expect(SESSION_HOVER_PREVIEW_DELAY_MS).toBe(0)
    expect(SESSION_HOVER_PREVIEW_SKIP_DELAY_MS).toBe(300)
    expect(desktopSessionButton?.closest('div.group')?.getAttribute('data-state')).toBe('closed')
    expect(desktopSessionButton?.closest('[title="Analysis session"]')).toBeNull()
    expect(mobileSessionButton?.closest('div.group')?.getAttribute('data-state')).toBeNull()
    expect(mobileSessionButton?.closest('[title="Analysis session"]')).not.toBeNull()
  })

  it('opens pointer previews immediately and switches directly to the next Session', async () => {
    vi.useFakeTimers()
    const {
      SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX,
      SessionHoverPreview,
      SessionHoverPreviewProvider
    } = await import('./SessionHoverPreview')
    const firstPreviewRequest = vi.fn().mockResolvedValue(undefined)
    const secondPreviewRequest = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const pointerOver = (target: Element, relatedTarget: EventTarget | null = null): void => {
      const event = new MouseEvent('pointerover', { bubbles: true, relatedTarget })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      target.dispatchEvent(event)
    }

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'first', title: 'First Session', description: 'First Description' }}
              onPreviewRequest={firstPreviewRequest}
            >
              <button type="button">First trigger</button>
            </SessionHoverPreview>
            <SessionHoverPreview
              session={{ id: 'second', title: 'Second Session', description: 'Second Description' }}
              onPreviewRequest={secondPreviewRequest}
            >
              <button type="button">Second trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const [first, second] = Array.from(container.querySelectorAll('button'))
      if (!first || !second) throw new Error('Session preview triggers did not render')

      await act(async () => pointerOver(first))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')?.textContent).toBe(
        'First SessionFirst Description'
      )
      const hoverRegion = document.body.querySelector<HTMLElement>(
        '[data-slot="hovercard-content"]'
      )
      expect(SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX).toBe(0)
      expect(hoverRegion?.classList).toContain('border-0')
      expect(hoverRegion?.classList).toContain('p-0')
      expect(firstPreviewRequest).toHaveBeenCalledOnce()

      const leave = new MouseEvent('pointerout', { bubbles: true, relatedTarget: second })
      Object.defineProperty(leave, 'pointerType', { value: 'mouse' })
      await act(async () => first.dispatchEvent(leave))
      await act(async () => pointerOver(second, first))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')?.textContent).toBe(
        'Second SessionSecond Description'
      )
      expect(secondPreviewRequest).toHaveBeenCalledOnce()
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.useRealTimers()
    }
  })

  it('closes a Session preview immediately after the pointer leaves its hover region', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview session={{ id: 'hovered', title: 'Hovered Session' }}>
              <button type="button">Hovered trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })

      await act(async () => trigger.dispatchEvent(pointerOver))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      const hoverRegion = document.body.querySelector<HTMLElement>(
        '[data-slot="hovercard-content"]'
      )
      if (!hoverRegion) throw new Error('Session preview hover region did not render')
      const leaveTrigger = new MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: hoverRegion
      })
      Object.defineProperty(leaveTrigger, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(leaveTrigger))

      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      const leaveHoverRegion = new MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: document.body
      })
      Object.defineProperty(leaveHoverRegion, 'pointerType', { value: 'mouse' })
      await act(async () => hoverRegion.dispatchEvent(leaveHoverRegion))

      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('closes the Session preview when its actions menu opens', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'menu-session', title: 'Menu Session' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebar
            projectName="Example project"
            sessions={[session]}
            activeSessionId={session.id}
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
            onOpenProjectSettings={vi.fn()}
            onNewProject={vi.fn()}
            canDownloadProjectArtifacts
            onDownloadProjectArtifacts={vi.fn()}
          />
        )
      })

      const actionsTrigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="Open actions for Menu Session"]'
      )
      if (!actionsTrigger) throw new Error('Session actions trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })

      await act(async () => actionsTrigger.dispatchEvent(pointerOver))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      await act(async () =>
        actionsTrigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      )

      expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()

      const actionsMenu = document.body.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-content"]'
      )
      if (!actionsMenu) throw new Error('Session actions menu did not render')
      await act(async () =>
        actionsMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )

      expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()

      await act(async () =>
        actionsTrigger.dispatchEvent(
          new FocusEvent('focusin', { bubbles: true, relatedTarget: actionsMenu })
        )
      )
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('opens the shared actions for the right-clicked Session without activating it', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const sessions = [
      createSession({ id: 'session-a', title: 'Active session', status: 'idle' }),
      createSession({ id: 'session-b', title: 'Context target', status: 'idle' })
    ]
    const onOpenSession = vi.fn()
    const onRenameSession = vi.fn()
    const onTogglePin = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebar
            projectName="Example project"
            sessions={sessions}
            activeSessionId="session-a"
            canCreateConversation
            canMutateConversations
            canDeleteConversations
            onGoHome={vi.fn()}
            onNewConversation={vi.fn()}
            isFilesOpen={false}
            onOpenFiles={vi.fn()}
            onOpenSession={onOpenSession}
            onRenameSession={onRenameSession}
            canDownloadArtifacts
            onDownloadArtifacts={vi.fn()}
            onViewNotebook={vi.fn()}
            onExportSession={vi.fn()}
            onTogglePin={onTogglePin}
            canArchiveSession={() => true}
            onArchiveSession={vi.fn()}
            onDeleteSession={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenProjectSettings={vi.fn()}
            onNewProject={vi.fn()}
          />
        )
      })

      const targetButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-slot="session-open-button"]')
      ).find((button) => button.textContent?.includes('Context target'))
      const targetRow = targetButton?.closest<HTMLElement>('.group')
      if (!targetRow) throw new Error('Context target row did not render')

      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => targetRow.dispatchEvent(pointerOver))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      await act(async () => {
        targetRow.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 41,
            clientY: 83
          })
        )
      })

      const menu = document.body.querySelector<HTMLElement>('[data-testid="session-context-menu"]')
      expect(menu).not.toBeNull()
      expect(
        Array.from(menu?.querySelectorAll<HTMLElement>('[data-action-id]') ?? []).map(
          (item) => item.dataset.actionId
        )
      ).toEqual([
        'toggle-pin',
        'edit',
        'download-artifacts',
        'view-notebook',
        'export',
        'archive',
        'delete'
      ])
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()
      expect(onOpenSession).not.toHaveBeenCalled()

      const edit = menu?.querySelector<HTMLElement>('[data-action-id="edit"]')
      if (!edit) throw new Error('Edit action did not render')
      await clickRadixMenuItem(edit)
      expect(onRenameSession).toHaveBeenCalledWith(sessions[1])
      expect(onOpenSession).not.toHaveBeenCalled()

      openRadixMenu(
        container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Context target"]')
      )
      const dropdown = document.body.querySelector<HTMLElement>('[aria-label="Session actions"]')
      expect(
        Array.from(dropdown?.querySelectorAll<HTMLElement>('[data-action-id]') ?? []).map(
          (item) => item.dataset.actionId
        )
      ).toEqual([
        'toggle-pin',
        'edit',
        'download-artifacts',
        'view-notebook',
        'export',
        'archive',
        'delete'
      ])
      await clickRadixMenuItem(
        dropdown?.querySelector<HTMLElement>('[data-action-id="toggle-pin"]')
      )
      expect(onTogglePin).toHaveBeenCalledWith(sessions[1])
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('applies Session hidden, disabled, and danger presentation to the right-click menu', async () => {
    const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'restricted', title: 'Restricted session', status: 'idle' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <WorkspaceSidebar
            projectName="Example project"
            sessions={[session]}
            activeSessionId={session.id}
            canCreateConversation={false}
            canMutateConversations={false}
            canDeleteConversations={false}
            onGoHome={vi.fn()}
            onNewConversation={vi.fn()}
            isFilesOpen={false}
            onOpenFiles={vi.fn()}
            onOpenSession={vi.fn()}
            onRenameSession={vi.fn()}
            canDownloadArtifacts={false}
            onDownloadArtifacts={vi.fn()}
            onViewNotebook={vi.fn()}
            onTogglePin={vi.fn()}
            onDeleteSession={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenProjectSettings={vi.fn()}
            onNewProject={vi.fn()}
          />
        )
      })

      const target = container.querySelector<HTMLElement>('[data-session-id="restricted"]')
      await act(async () => {
        target?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 30
          })
        )
      })
      const menu = document.body.querySelector<HTMLElement>('[data-testid="session-context-menu"]')
      const actions = Array.from(menu?.querySelectorAll<HTMLElement>('[data-action-id]') ?? [])

      expect(actions.map((item) => item.dataset.actionId)).toEqual([
        'toggle-pin',
        'edit',
        'view-notebook',
        'archive',
        'delete'
      ])
      for (const actionId of ['toggle-pin', 'edit', 'archive', 'delete']) {
        expect(
          actions.find((item) => item.dataset.actionId === actionId)?.getAttribute('aria-disabled')
        ).toBe('true')
      }
      expect(
        actions
          .find((item) => item.dataset.actionId === 'view-notebook')
          ?.getAttribute('aria-disabled')
      ).toBeNull()
      expect(actions.find((item) => item.dataset.actionId === 'delete')?.className).toContain(
        'text-danger-000'
      )
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('closes an active Session preview when its row is removed', async () => {
    vi.useFakeTimers()
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview session={{ id: 'removed', title: 'Removed Session' }}>
              <button type="button">Removed trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })

      await act(async () => trigger.dispatchEvent(pointerOver))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      await act(async () =>
        root.render(<SessionHoverPreviewProvider>{null}</SessionHoverPreviewProvider>)
      )

      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.useRealTimers()
    }
  })

  it('opens a Session preview immediately on keyboard focus', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{
                id: 'focused',
                title: 'Focused Session',
                description: 'Focused Description'
              }}
            >
              <button type="button">Focus trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const matches = trigger.matches.bind(trigger)
      vi.spyOn(trigger, 'matches').mockImplementation((selector) =>
        selector === ':focus-visible' ? true : matches(selector)
      )

      await act(async () => trigger.focus())

      expect(document.body.querySelector('[data-slot="session-hover-preview"]')?.textContent).toBe(
        'Focused SessionFocused Description'
      )
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('renames a Session from the hover card title and commits on Enter', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const onRenameTitle = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'renamed', title: 'Old title' }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Rename trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(pointerOver))

      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      if (!titleButton) throw new Error('Session preview title button did not render')
      await act(async () => titleButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))

      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      expect(input.value).toBe('Old title')
      expect(input.maxLength).toBe(80)

      input.value = '  Renamed title  '
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      )

      expect(onRenameTitle).toHaveBeenCalledWith('Renamed title', 'Old title')
      expect(onRenameTitle).toHaveBeenCalledOnce()
      expect(
        document.body.querySelector('[data-slot="hovercard-content"] [data-slot="input"]')
      ).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('submits the title visible when inline editing began after an external update', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const onRenameTitle = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const renderPreview = async (title: string): Promise<void> => {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'externally-renamed', title }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Rename trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
    }

    try {
      await renderPreview('Title when editing began')
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(pointerOver))
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      await act(async () => titleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      input.value = 'My stale draft'

      await renderPreview('Title updated in another window')
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      )

      expect(onRenameTitle).toHaveBeenCalledWith('My stale draft', 'Title when editing began')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps an inline rename open and announces a save failure', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const save = deferred<void>()
    void save.promise.catch(() => undefined)
    const onRenameTitle = vi.fn(() => save.promise)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'failed-rename', title: 'Old title' }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Rename trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(pointerOver))
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      await act(async () => titleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      input.value = 'Unsaved title'
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      )

      await act(async () => {
        save.reject(new Error('disk failure'))
        await save.promise.catch(() => undefined)
      })

      expect(
        document.body.querySelector('[data-slot="hovercard-content"] [data-slot="input"]')
      ).toBeInstanceOf(HTMLInputElement)
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not save session details.'
      )
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps an inline rename open without a save error when preparation could not load', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const onRenameTitle = vi.fn().mockResolvedValue(false)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'load-failed-rename', title: 'Old title' }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Rename trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(pointerOver))
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      await act(async () => titleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      input.value = 'Unsaved title'
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      )

      expect(
        document.body.querySelector('[data-slot="hovercard-content"] [data-slot="input"]')
      ).toBeInstanceOf(HTMLInputElement)
      expect(document.body.querySelector('[role="alert"]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('cancels the hover card title edit on Escape without renaming', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const onRenameTitle = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'cancelled', title: 'Keep me' }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Cancel trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })
      await act(async () => trigger.dispatchEvent(pointerOver))
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      if (!titleButton) throw new Error('Session preview title button did not render')
      await act(async () => titleButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))

      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      input.value = 'Discarded title'
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )

      expect(onRenameTitle).not.toHaveBeenCalled()
      expect(
        document.body.querySelector('[data-slot="hovercard-content"] [data-slot="input"]')
      ).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('commits the hover card title edit on blur and ignores blank titles', async () => {
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const onRenameTitle = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const openEditor = async (): Promise<HTMLInputElement> => {
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      if (!titleButton) throw new Error('Session preview title button did not render')
      await act(async () => titleButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const input = document.body.querySelector<HTMLInputElement>(
        '[data-slot="hovercard-content"] [data-slot="input"]'
      )
      if (!input) throw new Error('Session preview title editor did not render')
      return input
    }

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview
              session={{ id: 'blurred', title: 'Blur title' }}
              canRename
              onRenameTitle={onRenameTitle}
            >
              <button type="button">Blur trigger</button>
            </SessionHoverPreview>
          </SessionHoverPreviewProvider>
        )
      })
      const trigger = container.querySelector('button')
      if (!trigger) throw new Error('Session preview trigger did not render')
      const pointerOver = new MouseEvent('pointerover', { bubbles: true })
      Object.defineProperty(pointerOver, 'pointerType', { value: 'mouse' })

      await act(async () => trigger.dispatchEvent(pointerOver))
      const blankInput = await openEditor()
      blankInput.value = '   '
      await act(async () => blankInput.blur())
      expect(onRenameTitle).not.toHaveBeenCalled()

      await act(async () => trigger.dispatchEvent(pointerOver))
      const committedInput = await openEditor()
      committedInput.value = 'Blurred rename'
      await act(async () => committedInput.blur())
      expect(onRenameTitle).toHaveBeenCalledWith('Blurred rename', 'Blur title')
      expect(onRenameTitle).toHaveBeenCalledOnce()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps the hover card title read-only unless renaming is available', async () => {
    const { SessionHoverPreviewCard } = await import('./SessionHoverPreview')
    const readOnly = renderToStaticMarkup(
      <SessionHoverPreviewCard session={{ title: 'Read only title' }} />
    )
    const editable = renderToStaticMarkup(
      <SessionHoverPreviewCard session={{ title: 'Editable title' }} canRename />
    )

    expect(readOnly).toContain('<p class="truncate text-sm font-semibold leading-5">')
    expect(readOnly).not.toContain('session-hover-preview-title-button')
    expect(editable).toContain('data-slot="session-hover-preview-title-button"')
    expect(editable).toContain('aria-label="Rename session title"')
  })

  it('keeps the preview open when focus moves from the row into the card', async () => {
    vi.useFakeTimers()
    const { SessionHoverPreview, SessionHoverPreviewProvider } =
      await import('./SessionHoverPreview')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SessionHoverPreviewProvider>
            <SessionHoverPreview session={{ id: 'focus', title: 'Focus Session' }} canRename>
              <button type="button">Focus trigger</button>
            </SessionHoverPreview>
            <button type="button">Outside</button>
          </SessionHoverPreviewProvider>
        )
      })
      const [trigger, outside] = Array.from(container.querySelectorAll('button'))
      if (!trigger || !outside) throw new Error('Session preview triggers did not render')
      const matches = trigger.matches.bind(trigger)
      vi.spyOn(trigger, 'matches').mockImplementation((selector) =>
        selector === ':focus-visible' ? true : matches(selector)
      )

      await act(async () => trigger.focus())
      const titleButton = document.body.querySelector<HTMLElement>(
        '[data-slot="session-hover-preview-title-button"]'
      )
      if (!titleButton) throw new Error('Session preview title button did not render')

      // Internal transition with an explicit relatedTarget: Radix's composed trigger-blur close
      // is skipped and the card stays open past the close delay.
      await act(async () =>
        trigger.dispatchEvent(
          new FocusEvent('focusout', { bubbles: true, relatedTarget: titleButton })
        )
      )
      await act(async () => vi.advanceTimersByTime(400))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      // Programmatic focus into the card can carry a null relatedTarget; the deferred close
      // decision still sees the focus destination and keeps the card open.
      act(() => titleButton.focus())
      await act(async () =>
        trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      )
      await act(async () => vi.advanceTimersByTime(400))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).not.toBeNull()

      // Focus leaving the hover region entirely closes the card.
      act(() => outside.focus())
      await act(async () =>
        trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      )
      await act(async () => vi.advanceTimersByTime(400))
      expect(document.body.querySelector('[data-slot="session-hover-preview"]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.useRealTimers()
    }
  })

  it('truncates long Session titles to one line and Descriptions to three lines', async () => {
    const { SessionHoverPreviewCard } = await import('./SessionHoverPreview')
    const html = renderToStaticMarkup(
      <SessionHoverPreviewCard
        session={{ title: 'Complete analysis title', description: 'Compare both cohorts.' }}
      />
    )
    const withoutDescription = renderToStaticMarkup(
      <SessionHoverPreviewCard session={{ title: 'Title only', description: '   ' }} />
    )
    const loading = renderToStaticMarkup(
      <SessionHoverPreviewCard session={{ title: 'Loading details' }} descriptionLoading />
    )

    expect(html).toContain('data-slot="session-hover-preview"')
    expect(html).toContain('Complete analysis title')
    expect(html).toContain('Compare both cohorts.')
    expect(html).toContain('class="truncate text-sm font-semibold leading-5"')
    expect(html).toContain('text-xs leading-4')
    expect(html).not.toContain('text-[15px]')
    expect(html.match(/line-clamp-3/g)).toHaveLength(1)
    expect(withoutDescription).toContain('Title only')
    expect(withoutDescription).not.toContain('<p class="mt-2')
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('data-slot="session-hover-preview-description-loading"')
  })

  it('scrolls only an overflowing Session title and resets it on pointer leave', async () => {
    const { SessionTitleMarquee } = await import('./SessionHoverPreview')
    const container = document.createElement('div')
    const root = createRoot(container)
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue({ matches: false })

    try {
      await act(async () => {
        root.render(
          <button type="button">
            <SessionTitleMarquee title="A title wider than the Session row" />
          </button>
        )
      })
      const viewport = container.querySelector<HTMLElement>('[data-slot="session-title-marquee"]')
      const content = viewport?.firstElementChild as HTMLElement | null
      const trigger = viewport?.closest('button')
      const cancel = vi.fn()
      const animate = vi.fn().mockReturnValue({ cancel } as unknown as Animation)
      expect(viewport).not.toBeNull()
      expect(content).not.toBeNull()
      if (!viewport || !content) throw new Error('Session title marquee did not render')
      Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 })
      Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 180 })
      Object.defineProperty(content, 'animate', { configurable: true, value: animate })

      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerenter'))
      })
      expect(animate).toHaveBeenCalledWith(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-80px)' }],
        expect.objectContaining({ delay: 300, duration: 2_800, fill: 'forwards' })
      )

      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerleave'))
      })
      expect(cancel).toHaveBeenCalledTimes(1)

      animate.mockClear()
      Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 260 })
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerenter'))
      })
      expect(animate).toHaveBeenCalledWith(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-160px)' }],
        expect.objectContaining({ delay: 300, duration: 5_600, fill: 'forwards' })
      )

      animate.mockClear()
      Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 90 })
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerenter'))
      })
      expect(animate).not.toHaveBeenCalled()
    } finally {
      act(() => root.unmount())
      window.matchMedia = originalMatchMedia
    }
  })

  it('keeps overflowing Session titles still when reduced motion is requested', async () => {
    const { SessionTitleMarquee } = await import('./SessionHoverPreview')
    const container = document.createElement('div')
    const root = createRoot(container)
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue({ matches: true })

    try {
      await act(async () => {
        root.render(
          <button type="button">
            <SessionTitleMarquee title="A title wider than the Session row" />
          </button>
        )
      })
      const viewport = container.querySelector<HTMLElement>('[data-slot="session-title-marquee"]')
      const content = viewport?.firstElementChild as HTMLElement | null
      const trigger = viewport?.closest('button')
      const animate = vi.fn()
      if (!viewport || !content) throw new Error('Session title marquee did not render')
      Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 })
      Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 180 })
      Object.defineProperty(content, 'animate', { configurable: true, value: animate })

      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerenter'))
      })
      expect(animate).not.toHaveBeenCalled()
    } finally {
      act(() => root.unmount())
      window.matchMedia = originalMatchMedia
    }
  })

  it('docks the update action on the row above Settings', async () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0' }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      const { WorkspaceSidebar } = await import('./WorkspaceSidebar')
      await act(async () => {
        root.render(
          <WorkspaceSidebar
            projectName="Example project"
            sessions={[createSession({ id: 'session-a' })]}
            activeSessionId="session-a"
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
            onTogglePin={vi.fn()}
            onDeleteSession={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenProjectSettings={vi.fn()}
            onNewProject={vi.fn()}
          />
        )
      })
      const update = container.querySelector('[data-variant="session"]')
      const settings = container.querySelector('[aria-label="Settings"]')

      expect(update).not.toBeNull()
      expect(settings).not.toBeNull()
      expect(update?.compareDocumentPosition(settings!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps the header row free of floating-toggle padding now that the toggle sits inline', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('class="flex items-center"')
    expect(html).not.toContain('pr-9')
    expect(html).not.toContain('flex items-start')
    expect(html).toContain('aria-label="All projects"')
    expect(html).toContain('title="All projects"')
    expect(html).not.toContain('workspace-sidebar-toggle-slot')
  })

  it('renders the single-row header with a project menu trigger and wires every menu item', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const onGoHome = vi.fn()
    const onOpenProjectSettings = vi.fn()
    const onDownloadProjectArtifacts = vi.fn()
    const onNewProject = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a' })],
      activeSessionId: 'session-a',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome,
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings,
      onNewProject,
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts
    })
    const elements = collectElements(tree)

    const backButton = elements.find((element) => element.props['aria-label'] === 'All projects')
    expect(backButton).toBeDefined()
    ;(backButton?.props.onClick as () => void)()
    expect(onGoHome).toHaveBeenCalledTimes(1)

    const trigger = elements.find(
      (element) => element.type === 'button' && element.props.title === 'Example project'
    )
    expect(trigger).toBeDefined()

    const settingsItem = elements.find(
      (element) => getTextContent(element).trim() === 'Project settings'
    )
    ;(settingsItem?.props.onSelect as () => void)()
    expect(onOpenProjectSettings).toHaveBeenCalledTimes(1)

    const downloadItem = elements.find(
      (element) => getTextContent(element).trim() === 'Download artifacts…'
    )
    expect(downloadItem?.props.disabled).toBe(false)
    ;(downloadItem?.props.onSelect as () => void)()
    expect(onDownloadProjectArtifacts).toHaveBeenCalledTimes(1)

    const newProjectItem = elements.find(
      (element) => getTextContent(element).trim() === 'New project'
    )
    ;(newProjectItem?.props.onSelect as () => void)()
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  it('shows project search only when more than five other projects are available', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const fiveProjects = await mountProjectSidebar(projects.slice(0, 5))
    try {
      fiveProjects.openMenu()
      expect(document.body.querySelector('[aria-label="Search projects"]')).toBeNull()
    } finally {
      fiveProjects.cleanup()
    }

    const sixProjects = await mountProjectSidebar(projects)
    try {
      sixProjects.openMenu()
      expect(document.body.querySelector('[aria-label="Search projects"]')).not.toBeNull()
    } finally {
      sixProjects.cleanup()
    }
  })

  it('keeps menu-item arrow navigation when project search is hidden', async () => {
    const projects = Array.from({ length: 5 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      mounted.openMenu()
      const settings = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Project settings')
      const firstProject = document.body.querySelector<HTMLElement>('[data-project-id]')

      await act(async () => {
        settings?.focus()
        settings?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })

      expect(document.activeElement).toBe(firstProject)

      await act(async () => {
        firstProject?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })

      expect(document.activeElement).toBe(settings)
    } finally {
      mounted.cleanup()
    }
  })

  it('centers project search and uses the shared clear button treatment', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const searchContainer = search?.parentElement
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

      expect(searchContainer?.className).toContain('mx-1')
      expect(search?.className).toContain('[&::-webkit-search-cancel-button]:hidden')
      expect(search?.className).toContain('pr-8')
      expect(document.body.querySelector('[aria-label="Clear search"]')).toBeNull()

      await act(async () => {
        valueSetter?.call(search, 'Project')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const clearButton = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Clear search"]'
      )
      expect(clearButton?.getAttribute('data-slot')).toBe('button')
      expect(clearButton?.getAttribute('data-variant')).toBe('ghost')
      expect(clearButton?.getAttribute('data-size')).toBe('icon-xs')
      expect(clearButton?.className).toContain('text-text-100')
      expect(clearButton?.className).toContain('hover:bg-bg-200')
      expect(clearButton?.className).toContain('focus-visible:ring-3')

      const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      await act(async () => {
        search?.focus()
        clearButton?.dispatchEvent(mouseDown)
        clearButton?.click()
      })
      expect(mouseDown.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(search)
      expect(search?.value).toBe('')
      expect(document.body.querySelector('[aria-label="Clear search"]')).toBeNull()
      expect(document.body.querySelector('[aria-label="Project actions"]')).not.toBeNull()
    } finally {
      mounted.cleanup()
    }
  })

  it('returns keyboard focus to project search after clearing', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 'Project')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const clearButton = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Clear search"]'
      )
      await act(async () => {
        search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      })
      expect(document.activeElement).toBe(clearButton)

      await act(async () => {
        clearButton?.click()
      })

      expect(search?.value).toBe('')
      expect(document.activeElement).toBe(search)
      expect(document.body.querySelector('[aria-label="Project actions"]')).not.toBeNull()
    } finally {
      mounted.cleanup()
    }
  })

  it('keeps keyboard navigation moving when project search has no results', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 'no matches')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const clearButton = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Clear search"]'
      )
      const newProjectItem = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'New project')

      await act(async () => {
        search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      })
      expect(document.activeElement).toBe(clearButton)

      await act(async () => {
        clearButton?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
        )
      })
      expect(document.activeElement).toBe(newProjectItem)

      await act(async () => {
        newProjectItem?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
        )
      })
      expect(document.activeElement).toBe(search)
    } finally {
      mounted.cleanup()
    }
  })

  it('clears a hidden project query when the search threshold is no longer met', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 'Project 6')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(document.body.querySelectorAll('[data-project-id]')).toHaveLength(1)

      await mounted.rerenderProjects(projects.slice(0, 5))
      expect(document.body.querySelector('[aria-label="Search projects"]')).toBeNull()
      expect(document.body.querySelectorAll('[data-project-id]')).toHaveLength(5)

      await mounted.rerenderProjects(projects)
      expect(
        document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')?.value
      ).toBe('')
    } finally {
      mounted.cleanup()
    }
  })

  it('does not recompute project matches for session-only rerenders', async () => {
    let descriptionReadCount = 0
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      get description(): string {
        descriptionReadCount += 1
        return `Description ${index + 1}`
      }
    }))
    const mounted = await mountProjectSidebar(projects)

    try {
      const readsAfterMount = descriptionReadCount
      await mounted.rerenderSessions([
        createSession({ id: 'session-a', title: 'Updated session title' })
      ])
      expect(descriptionReadCount).toBe(readsAfterMount)
    } finally {
      mounted.cleanup()
    }
  })

  it('fuzzy matches project titles before descriptions without reordering either group', async () => {
    const otherProjects = [
      { id: 'title-first', name: 'Alpha Lab', description: 'Alpha outcomes' },
      { id: 'description-first', name: 'Genome Atlas', description: 'Alpha description' },
      { id: 'title-second', name: 'Alpine Study', description: 'Clinical cohort' },
      { id: 'description-second', name: 'Signal Cohort', description: 'Alpine follow-up' },
      { id: 'unmatched-1', name: 'Control Study', description: 'Baseline cohort' },
      { id: 'unmatched-2', name: 'Reference Set', description: 'Control samples' }
    ]
    const mounted = await mountProjectSidebar(otherProjects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, ' aLp ')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const projectItems = Array.from(
        document.body.querySelectorAll<HTMLElement>('[data-project-id]')
      )
      expect(projectItems.map((item) => item.dataset.projectId)).toEqual([
        'title-first',
        'title-second',
        'description-first',
        'description-second'
      ])

      const titleFirst = projectItems[0]
      const descriptionFirst = projectItems[2]
      expect(titleFirst?.querySelector('[data-project-title] .text-primary')?.textContent).toBe(
        'Alp'
      )
      expect(
        titleFirst?.querySelector('[data-project-description] .text-primary')?.textContent
      ).toBe('Alp')
      expect(descriptionFirst?.querySelector('[data-project-title] .text-primary')).toBeNull()
      expect(
        descriptionFirst?.querySelector('[data-project-description] .text-primary')?.textContent
      ).toBe('Alp')
      expect(document.body.textContent).not.toContain('Show remaining')

      await act(async () => {
        valueSetter?.call(search, 'zzzz')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(document.body.querySelectorAll('[data-project-id]')).toHaveLength(0)
      expect(document.body.textContent).toContain('No matching projects')
    } finally {
      mounted.cleanup()
    }
  })

  it('highlights Unicode matches at their original text positions', async () => {
    const otherProjects = [
      { id: 'project-1', name: 'İstanbul', description: 'City study' },
      { id: 'project-2', name: 'Alpha', description: 'First cohort' },
      { id: 'project-3', name: 'Beta', description: 'Second cohort' },
      { id: 'project-4', name: 'Gamma', description: 'Third cohort' },
      { id: 'project-5', name: 'Delta', description: 'Fourth cohort' },
      { id: 'project-6', name: 'Epsilon', description: 'Fifth cohort' }
    ]
    const mounted = await mountProjectSidebar(otherProjects)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 's')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const istanbul = document.body.querySelector<HTMLElement>('[data-project-id="project-1"]')
      expect(istanbul?.querySelector('[data-project-title] .text-primary')?.textContent).toBe('s')
    } finally {
      mounted.cleanup()
    }
  })

  it('moves from project search into the first result and opens it with the keyboard', async () => {
    const onOpenProject = vi.fn()
    const otherProjects = [
      { id: 'project-1', name: 'Alpha', description: 'First cohort' },
      { id: 'project-2', name: 'Beta', description: 'Second cohort' },
      { id: 'project-3', name: 'Gamma', description: 'Third cohort' },
      { id: 'project-4', name: 'Delta', description: 'Fourth cohort' },
      { id: 'project-5', name: 'Epsilon', description: 'Fifth cohort' },
      { id: 'project-6', name: 'Target Project', description: 'Selected cohort' }
    ]
    const mounted = await mountProjectSidebar(otherProjects, onOpenProject)

    try {
      mounted.openMenu()
      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      expect(document.activeElement).toBe(search)
      await act(async () => {
        search?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, isComposing: true })
        )
      })
      expect(document.activeElement).toBe(search)
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 'TARGET')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })

      const firstResult = document.body.querySelector<HTMLElement>('[data-project-id]')
      expect(firstResult?.dataset.projectId).toBe('project-6')
      expect(document.activeElement).toBe(firstResult)

      await act(async () => {
        firstResult?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      })
      expect(document.activeElement).toBe(search)

      await act(async () => {
        search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      expect(document.activeElement).toBe(firstResult)

      await act(async () => {
        firstResult?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(onOpenProject).toHaveBeenCalledWith('project-6')

      mounted.openMenu()
      const reopenedSearch = document.body.querySelector<HTMLInputElement>(
        '[aria-label="Search projects"]'
      )
      expect(reopenedSearch?.value).toBe('')
      expect(document.activeElement).toBe(reopenedSearch)
      await act(async () => {
        reopenedSearch?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      })
      expect(document.body.querySelector('[aria-label="Project actions"]')).toBeNull()
    } finally {
      mounted.cleanup()
    }
  })

  it('keeps keyboard focus on project results after expanding the menu', async () => {
    const otherProjects = Array.from({ length: 7 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(otherProjects)

    try {
      mounted.openMenu()
      const showRemaining = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Show remaining 2 projects')

      await act(async () => {
        showRemaining?.focus()
        showRemaining?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })

      expect(document.body.querySelectorAll('[data-project-id]')).toHaveLength(7)
      expect(document.activeElement).toBe(
        document.body.querySelector<HTMLElement>('[data-project-id]')
      )
    } finally {
      mounted.cleanup()
    }
  })

  it('shows five other projects, expands in place, switches projects, and resets after close', async () => {
    const onOpenProject = vi.fn()
    const otherProjects = Array.from({ length: 7 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: index === 4 ? '' : `Description ${index + 1}`
    }))
    const mounted = await mountProjectSidebar(otherProjects, onOpenProject)

    try {
      mounted.openMenu()

      let projectItems = Array.from(
        document.body.querySelectorAll<HTMLElement>('[data-project-id]')
      )
      expect(projectItems.map((item) => item.dataset.projectId)).toEqual([
        'project-1',
        'project-2',
        'project-3',
        'project-4',
        'project-5'
      ])
      expect(projectItems[0]?.textContent).toContain('Project 1')
      expect(projectItems[0]?.textContent).toContain('Description 1')
      expect(projectItems[4]?.textContent).not.toContain('Description')

      const showRemainingItem = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Show remaining 2 projects')
      expect(showRemainingItem).toBeDefined()

      clickRadixMenuItem(showRemainingItem)

      projectItems = Array.from(document.body.querySelectorAll<HTMLElement>('[data-project-id]'))
      expect(projectItems).toHaveLength(7)
      expect(document.body.querySelector('[aria-label="Project actions"]')).not.toBeNull()

      const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        valueSetter?.call(search, 'Description')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      projectItems = Array.from(document.body.querySelectorAll<HTMLElement>('[data-project-id]'))
      expect(projectItems).toHaveLength(5)
      const filteredShowRemaining = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find((item) => item.textContent?.trim() === 'Show remaining 1 project')
      expect(filteredShowRemaining).toBeDefined()

      clickRadixMenuItem(filteredShowRemaining)
      projectItems = Array.from(document.body.querySelectorAll<HTMLElement>('[data-project-id]'))
      expect(projectItems).toHaveLength(6)
      expect(document.body.querySelector('[aria-label="Search projects"]')).not.toBeNull()

      clickRadixMenuItem(projectItems[5])
      expect(onOpenProject).toHaveBeenCalledWith('project-7')

      mounted.openMenu()
      expect(document.body.querySelectorAll('[data-project-id]')).toHaveLength(5)
      expect(
        document.body.querySelector<HTMLInputElement>('[aria-label="Search projects"]')?.value
      ).toBe('')
      expect(document.body.textContent).toContain('Show remaining 2 projects')
    } finally {
      mounted.cleanup()
    }
  })

  it('disables Download artifacts when the project has no downloadable files', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a' })],
      activeSessionId: 'session-a',
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
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: false,
      onDownloadProjectArtifacts: vi.fn()
    })

    const downloadItem = collectElements(tree).find(
      (element) => getTextContent(element).trim() === 'Download artifacts…'
    )
    expect(downloadItem?.props.disabled).toBe(true)
  })

  it('disables Download artifacts when the download handler is not wired', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a' })],
      activeSessionId: 'session-a',
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
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true
    })

    const downloadItem = collectElements(tree).find(
      (element) => getTextContent(element).trim() === 'Download artifacts…'
    )
    expect(downloadItem?.props.disabled).toBe(true)
  })

  it('renders the sidebar toggle inline right after the project menu', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const onSidebarToggle = vi.fn()
    const tree = WorkspaceSidebarView({
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a' })],
      activeSessionId: 'session-a',
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
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn(),
      sidebarToggle: { state: 'open' as const, onToggle: onSidebarToggle }
    })
    const elements = collectElements(tree)

    const backButton = elements.find((element) => element.props['aria-label'] === 'All projects')
    const projectTrigger = elements.find(
      (element) => element.type === 'button' && element.props.title === 'Example project'
    )
    const sidebarToggle = elements.find(
      (element) => element.props['data-testid'] === 'workspace-sidebar-toggle'
    )

    expect(backButton).toBeDefined()
    expect(projectTrigger).toBeDefined()
    expect(sidebarToggle).toBeDefined()

    // Header order: back, project menu, sidebar toggle. The preview toggle no longer lives in
    // the header row — it stays a floating button owned by the panel layout.
    const order = [backButton, projectTrigger, sidebarToggle].map((element) =>
      elements.indexOf(element as ElementWithProps)
    )
    expect(order[1]).toBeGreaterThan(order[0] as number)
    expect(order[2]).toBeGreaterThan(order[1] as number)
    expect(
      elements.find((element) => element.props['data-testid'] === 'workspace-preview-toggle')
    ).toBeUndefined()

    // The header row shares one hover background token across every clickable element.
    expect(backButton?.props.className).toContain('hover:bg-bg-300')
    expect(projectTrigger?.props.className).toContain('hover:bg-bg-300')
    expect(projectTrigger?.props.className).toContain('data-[state=open]:bg-bg-300')
    expect(projectTrigger?.props.className).not.toContain('hover:bg-surface-control-hover')

    expect(sidebarToggle?.props['aria-label']).toBe('Collapse sidebar panel')
    expect(sidebarToggle?.props['aria-expanded']).toBe(true)
    expect(sidebarToggle?.props['aria-controls']).toBe('left-panel')
    expect(sidebarToggle?.props['aria-keyshortcuts']).toBe(
      window.api?.platform === 'darwin' ? 'Meta+B' : 'Control+B'
    )
    expect(sidebarToggle?.props.title).toBe('Collapse sidebar panel')
    expect(sidebarToggle?.props.className).toContain('text-action-panel-toggle')
    expect(sidebarToggle?.props.className).toContain('hover:bg-bg-300')
    expect(sidebarToggle?.props.className).not.toContain('absolute')
    ;(sidebarToggle?.props.onClick as () => void)()
    expect(onSidebarToggle).toHaveBeenCalledTimes(1)
  })

  it('omits the header sidebar toggle while collapsed or in mobile mode', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const baseProps = {
      now: Date.now(),
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a' })],
      activeSessionId: 'session-a',
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
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    }

    // The panel layout mounts the floating fallback while collapsed; the header instance must
    // stay unmounted so the workspace-sidebar-toggle testid never duplicates.
    const collapsedTree = WorkspaceSidebarView({
      ...baseProps,
      sidebarToggle: { state: 'collapsed' as const, onToggle: vi.fn() }
    })
    expect(
      collectElements(collapsedTree).find(
        (element) => element.props['data-testid'] === 'workspace-sidebar-toggle'
      )
    ).toBeUndefined()

    const mobileTree = WorkspaceSidebarView({
      ...baseProps,
      mobileMode: true,
      isMobileOpen: true,
      onMobileClose: vi.fn(),
      sidebarToggle: { state: 'open' as const, onToggle: vi.fn() }
    })
    const mobileElements = collectElements(mobileTree)
    expect(
      mobileElements.find((element) => element.props['data-testid'] === 'workspace-sidebar-toggle')
    ).toBeUndefined()
    expect(
      mobileElements.find((element) => element.props['aria-label'] === 'Close navigation')
    ).toBeDefined()
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

  it('uses the shared answer wait reason for an active delegated question', async () => {
    const html = await renderSidebar([createDelegatedQuestionSession()])

    expect(html).toContain('Session status: Waiting for your answer')
    expect(html).toContain('bg-session-waiting')
    expect(html).not.toContain('Session status: Running')
  })

  it('gives each session action trigger a session-specific accessible name', async () => {
    const html = await renderSidebar([
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ])

    expect(html).toContain('aria-label="Open actions for Notebook review"')
    expect(html).toContain('aria-label="Open actions for Dataset cleanup"')
  })

  it('raises Session pointer actions above the mobile sidebar only in mobile mode', async () => {
    const { WorkspaceSidebarView } = await import('./WorkspaceSidebar')
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const sharedProps = {
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
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn()
    }

    const desktopProvider = collectElements(WorkspaceSidebarView(sharedProps)).find(
      (element) => element.props.testId === 'session-context-menu'
    )
    const mobileProvider = collectElements(
      WorkspaceSidebarView({
        ...sharedProps,
        mobileMode: true,
        isMobileOpen: true,
        onMobileClose: vi.fn()
      })
    ).find((element) => element.props.testId === 'session-context-menu')

    expect(desktopProvider).toBeDefined()
    expect(desktopProvider?.props.contentClassName).toBeUndefined()
    expect(mobileProvider).toBeDefined()
    expect(mobileProvider?.props.contentClassName).toBe('z-[80]')
  })

  it('reveals session actions on interaction without keeping the selected row action visible', async () => {
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const desktop = document.createElement('div')
    desktop.innerHTML = await renderSidebar([session])
    const desktopTrigger = desktop.querySelector<HTMLButtonElement>(
      '[aria-label="Open actions for Notebook review"]'
    )

    expect(desktopTrigger?.classList).toContain('opacity-0')
    expect(desktopTrigger?.classList).not.toContain('opacity-100')
    expect(desktopTrigger?.classList).toContain('group-hover:opacity-100')
    expect(desktopTrigger?.classList).toContain('focus-visible:opacity-100')
    expect(desktopTrigger?.classList).toContain('data-[state=open]:opacity-100')

    const mobile = document.createElement('div')
    mobile.innerHTML = await renderSidebar([session], true)
    const mobileTrigger = mobile.querySelector<HTMLButtonElement>(
      '[aria-label="Open actions for Notebook review"]'
    )
    expect(mobileTrigger?.classList).toContain('opacity-100')
  })

  it('fades overflowing titles and emphasizes only live sessions in Active', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 7, 9, 13, 30).getTime()
    vi.setSystemTime(now)

    try {
      const runningTitle = 'Running session with a title that reaches the row action'
      const completedTitle = 'Recently completed session'
      const container = document.createElement('div')
      container.innerHTML = await renderSidebar([
        createSession({ id: 'running', title: runningTitle, status: 'running', updatedAt: now }),
        createSession({
          id: 'completed',
          title: completedTitle,
          status: 'idle',
          updatedAt: now - 60_000
        })
      ])
      const titleSpans = Array.from(container.querySelectorAll('span'))
      const running = titleSpans.find((element) => element.textContent === runningTitle)
      const completed = titleSpans.find((element) => element.textContent === completedTitle)
      const fade = container.querySelector<HTMLElement>('.bg-gradient-to-r')

      expect(running?.classList).toContain('overflow-hidden')
      expect(running?.classList).toContain('whitespace-nowrap')
      expect(running?.classList).not.toContain('truncate')
      expect(running?.classList).toContain('font-semibold')
      expect(completed?.classList).not.toContain('font-semibold')
      expect(fade?.classList).toContain('w-12')
      expect(fade?.classList).toContain('from-transparent')
      expect(fade?.classList).toContain('via-rail-card-bg')
      expect(fade?.classList).toContain('to-rail-card-bg')
      expect(fade?.classList).toContain('group-hover:via-bg-300')
      expect(fade?.classList).toContain('group-hover:to-bg-300')
    } finally {
      vi.useRealTimers()
    }
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })
    const elements = collectElements(tree)
    const notebookButton = elements.find(
      (element) =>
        element.type === 'button' &&
        element.props['data-slot'] === 'session-open-button' &&
        typeof element.props.onClick === 'function'
    )
    const firstTarget = getSessionActionTargetProps(tree, sessions[0].id)
    const secondTarget = getSessionActionTargetProps(tree, sessions[1].id)

    expect(notebookButton?.props.onClick).toBeTypeOf('function')
    ;(notebookButton?.props.onClick as () => void)()
    expect(onOpenSession).toHaveBeenCalledWith('session-a')

    await secondTarget.bindings.edit?.execute(secondTarget.invocation)
    expect(onRenameSession).toHaveBeenCalledWith(sessions[1])

    await secondTarget.bindings['download-artifacts']?.execute(secondTarget.invocation)
    expect(onDownloadArtifacts).toHaveBeenCalledWith(sessions[1])

    await firstTarget.bindings.export?.execute(firstTarget.invocation)
    expect(onExportSession).toHaveBeenCalledWith(sessions[0])

    await secondTarget.bindings.export?.execute(secondTarget.invocation)
    expect(onExportSession).toHaveBeenCalledWith(sessions[1])

    await secondTarget.bindings.archive?.execute(secondTarget.invocation)
    expect(onArchiveSession).toHaveBeenCalledWith(sessions[1])

    await firstTarget.bindings.delete?.execute(firstTarget.invocation)
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
      onOpenSettings,
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })
    const target = getSessionActionTargetProps(tree, sessions[1].id)
    await target.bindings['view-notebook']?.execute(target.invocation)
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

  it('presents an in-memory credential request as an active Session needing input', async () => {
    const html = await renderSidebar(
      [
        createSession({
          id: 'credential-session',
          title: 'OpenAlex lookup',
          status: 'running',
          updatedAt: 1
        })
      ],
      false,
      new Set(['credential-session'])
    )

    expect(html).toContain('>Active<')
    expect(html).toContain('Session status: Waiting for your answer')
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
            onOpenProjectSettings={vi.fn()}
            onNewProject={vi.fn()}
            canDownloadProjectArtifacts
            onDownloadProjectArtifacts={vi.fn()}
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
              onOpenProjectSettings={vi.fn()}
              onNewProject={vi.fn()}
              canDownloadProjectArtifacts
              onDownloadProjectArtifacts={vi.fn()}
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })
    const unpinnedTarget = getSessionActionTargetProps(tree, sessions[0].id)
    const pinnedTarget = getSessionActionTargetProps(tree, sessions[1].id)
    const pinItem = resolveSessionTargetEntries(unpinnedTarget).find(
      (entry) => entry.kind === 'action' && entry.action === 'toggle-pin'
    )
    const unpinItem = resolveSessionTargetEntries(pinnedTarget).find(
      (entry) => entry.kind === 'action' && entry.action === 'toggle-pin'
    )

    // The unpinned session-a shows "Pin"; the pinned session-b shows "Unpin".
    expect(pinItem).toMatchObject({ labelKey: 'Pin' })
    await unpinnedTarget.bindings['toggle-pin']?.execute(unpinnedTarget.invocation)
    expect(onTogglePin).toHaveBeenCalledWith(sessions[0])

    onTogglePin.mockClear()
    expect(unpinItem).toMatchObject({ labelKey: 'Unpin' })
    await pinnedTarget.bindings['toggle-pin']?.execute(pinnedTarget.invocation)
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })
    const target = getSessionActionTargetProps(tree, session.id)
    const entries = resolveSessionTargetEntries(target)
    const pinItem = entries.find(
      (entry) => entry.kind === 'action' && entry.action === 'toggle-pin'
    )
    const renameItem = entries.find((entry) => entry.kind === 'action' && entry.action === 'edit')
    const deleteItem = entries.find((entry) => entry.kind === 'action' && entry.action === 'delete')

    expect(pinItem).toMatchObject({ disabled: true })
    expect(renameItem).toMatchObject({ disabled: true })
    expect(deleteItem).toMatchObject({ disabled: false })
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
        createSession({
          id: 'waiting-plan',
          status: 'waiting-plan-approval',
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })
    const exportTriggers = ['running', 'waiting-user', 'waiting', 'waiting-plan', 'empty', 'ready']
      .map((sessionId) => resolveSessionTargetEntries(getSessionActionTargetProps(tree, sessionId)))
      .map((entries) =>
        entries.find((entry) => entry.kind === 'action' && entry.action === 'export')
      )

    expect(exportTriggers).toHaveLength(6)
    expect(exportTriggers[0]).toMatchObject({ disabled: true })
    expect(exportTriggers[1]).toMatchObject({ disabled: true })
    expect(exportTriggers[2]).toMatchObject({ disabled: true })
    expect(exportTriggers[3]).toMatchObject({ disabled: true })
    expect(exportTriggers[4]).toMatchObject({ disabled: true })
    expect(exportTriggers[5]).toMatchObject({ disabled: false })
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })

    const entries = resolveSessionTargetEntries(getSessionActionTargetProps(tree, 'session-1'))
    expect(entries.some((entry) => entry.kind === 'action' && entry.action === 'export')).toBe(
      false
    )
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
      onOpenSettings: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onNewProject: vi.fn(),
      canDownloadProjectArtifacts: true,
      onDownloadProjectArtifacts: vi.fn()
    })

    const entries = resolveSessionTargetEntries(getSessionActionTargetProps(tree, session.id))
    expect(
      entries.some((entry) => entry.kind === 'action' && entry.action === 'download-artifacts')
    ).toBe(false)
  })
})

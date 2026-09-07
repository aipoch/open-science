// @vitest-environment jsdom
// Pins the inline edit-resend flow: the gate follows the same settled-run conditions as sending, and
// confirming an inline edit resends the adjusted prompt as a new turn without attachments.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'

import { emptyDoc, type ComposerDoc } from './composer/composer-doc'
import {
  markWorkspaceReviewHistoryLoaded,
  setDefaultWorkspaceAgentSettings
} from './workspace-page-test-fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Capture the ConversationPanel props the page computes, notably canEditMessage and the resend handler.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  resendEditedMessage: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: null,
    pendingPermissions: [],
    sendMessage: runtime.sendMessage,
    resendEditedMessage: runtime.resendEditedMessage,
    cancelRun: runtime.cancelRun,
    deleteRuntimeSession: runtime.deleteRuntimeSession,
    respondToPermission: runtime.respondToPermission
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (props: typeof conversationProps): React.JSX.Element => {
    conversationProps = props
    return <section data-testid="conversation" />
  }
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => <div data-testid="preview-panel" />
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now()

  return {
    id: 'sess-a',
    projectId: 'proj-1',
    title: 'sess-a',
    cwd: '/workspace/proj-1',
    status: 'idle',
    messages: [],
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'completed',
          activeBranchId: 'branch-a',
          createdAt: now
        }
      ],
      branches: [
        {
          id: 'branch-a',
          agentFrameId: 'root',
          headMessageId: 'message-1',
          createdAt: now,
          updatedAt: now
        }
      ],
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Run /forecast now',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: 'branch-a',
          createdAt: now,
          updatedAt: now
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

const promptMessage: ChatMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Run /forecast now',
  status: 'complete',
  eventIds: [],
  parts: [
    { type: 'text', text: 'Run ' },
    { type: 'skill', id: 'skill-forecast', name: 'forecast' },
    { type: 'text', text: ' now' }
  ],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}

const editedDoc: ComposerDoc = {
  nodes: [
    { type: 'text', text: 'Run ' },
    { type: 'skill', id: 'skill-forecast', name: 'forecast' },
    { type: 'text', text: ' tomorrow' }
  ]
}

const setSession = (overrides: Partial<ChatSession>): void => {
  useSessionStore.setState({
    sessions: [createSession(overrides)],
    selectedSessionId: 'sess-a'
  })
}

describe('WorkspacePage inline edit resend', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setDefaultWorkspaceAgentSettings()
    markWorkspaceReviewHistoryLoaded({ projectId: 'proj-1', sessionId: 'sess-a' })
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ messages: [promptMessage] })],
      selectedSessionId: 'sess-a'
    })
    vi.clearAllMocks()

    window.api = {
      acp: { getPlanProjection: vi.fn(() => Promise.resolve(null)) },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(({ expectedRevision }: { expectedRevision: number }) =>
          Promise.resolve({ status: 'saved', revision: expectedRevision + 1 })
        )
      },
      uploads: { deleteUpload: vi.fn() },
      reviewer: {
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      },
      compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) }
    } as never

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
  }

  it('routes the edited prompt through the truncate-and-resend runtime flow', async () => {
    await renderPage()

    expect(conversationProps.conversation.availability.revise).toBe(true)

    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', editedDoc, [])
    })

    // The runtime receives the truncation point plus the adjusted prompt with its mentions resolved.
    expect(runtime.resendEditedMessage).toHaveBeenCalledWith('sess-a', 'message-1', {
      text: 'Run /forecast tomorrow',
      annotations: [],
      parts: editedDoc.nodes,
      forcedSkillIds: ['skill-forecast'],
      referencedArtifacts: []
    })
  })

  it('Q01 preserves an independent draft when editing a queued historical revision', async () => {
    await renderPage()
    const draft: ComposerDoc = { nodes: [{ type: 'text', text: 'Unsent independent draft' }] }
    await act(async () => {
      conversationProps.composer.actions.changeDoc(draft)
      setSession({ status: 'running', messages: [promptMessage] })
    })
    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', editedDoc, [])
    })
    expect(conversationProps.composer.view.doc).toEqual(draft)
    const queued = conversationProps.conversation.queue.items[0]
    expect(queued).toMatchObject({ text: 'Run /forecast tomorrow', phase: 'queued' })

    await act(async () => conversationProps.conversation.queue.actions.edit(queued.id))

    expect.soft(conversationProps.composer.view.doc).toEqual(draft)
    expect
      .soft(conversationProps.conversation.queue.items)
      .toEqual([expect.objectContaining({ id: queued.id, error: { kind: 'edit' } })])
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('Q01 retains the historical revision target after queue editing and submitting', async () => {
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'new-message' })
    runtime.resendEditedMessage.mockResolvedValue(true)
    await renderPage()
    await act(async () => setSession({ status: 'running', messages: [promptMessage] }))
    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', editedDoc, [])
    })
    const queued = conversationProps.conversation.queue.items[0]
    await act(async () => conversationProps.conversation.queue.actions.edit(queued.id))
    expect(conversationProps.composer.view.doc).toEqual(editedDoc)
    expect(conversationProps.conversation.queue.items).toEqual([])
    await act(async () => setSession({ messages: [promptMessage] }))
    await act(async () => {
      await conversationProps.conversation.actions.submit.draft({
        forcedSkillIds: ['skill-forecast']
      })
    })

    expect
      .soft(runtime.resendEditedMessage)
      .toHaveBeenCalledWith(
        'sess-a',
        'message-1',
        expect.objectContaining({ text: 'Run /forecast tomorrow' })
      )
    expect.soft(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('Q01 retains a restored revision when its original branch is no longer active', async () => {
    await renderPage()
    await act(async () => setSession({ status: 'running', messages: [promptMessage] }))
    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', editedDoc, [])
    })
    await act(async () =>
      conversationProps.conversation.queue.actions.edit(
        conversationProps.conversation.queue.items[0].id
      )
    )
    const graph = createSession().conversationGraph!
    await act(async () =>
      setSession({
        messages: [promptMessage],
        conversationGraph: {
          ...graph,
          frames: graph.frames.map((frame) => ({ ...frame, activeBranchId: 'branch-b' }))
        }
      })
    )
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(conversationProps.composer.view.doc).toEqual(editedDoc)
    expect(conversationProps.composer.view.queuedEdit?.revisionMessageId).toBe('message-1')
    expect(conversationProps.composer.view.error).toContain('no longer matches')
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('queues a revision while a run is active and still rejects an empty edit', async () => {
    await renderPage()

    await act(async () => {
      setSession({ status: 'running', messages: [promptMessage] })
    })
    expect(conversationProps.conversation.availability.revise).toBe(true)

    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', editedDoc, [])
    })
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()
    expect(conversationProps.conversation.queue.items).toEqual([
      expect.objectContaining({ text: 'Run /forecast tomorrow', phase: 'queued' })
    ])

    await act(async () => {
      setSession({ messages: [promptMessage] })
    })
    expect(conversationProps.conversation.availability.revise).toBe(true)
    await vi.waitFor(() => expect(runtime.resendEditedMessage).toHaveBeenCalledOnce())
    runtime.resendEditedMessage.mockClear()

    await act(async () => {
      await conversationProps.conversation.actions.revise('message-1', emptyDoc, [])
    })
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('allows queued editing during a run but gates permission, Fix Loop, and compaction', async () => {
    await renderPage()

    expect(conversationProps.conversation.availability.revise).toBe(true)

    await act(async () => {
      setSession({ status: 'running', messages: [promptMessage] })
    })
    expect(conversationProps.conversation.availability.revise).toBe(true)

    await act(async () => {
      setSession({ status: 'waiting-permission', messages: [promptMessage] })
    })
    expect(conversationProps.conversation.availability.revise).toBe(false)

    await act(async () => {
      setSession({ fixLoopActive: true, messages: [promptMessage] })
    })
    expect(conversationProps.conversation.availability.revise).toBe(false)

    // Compaction recovery idles the session but must keep the gate closed until the replay finishes.
    await act(async () => {
      setSession({ messages: [promptMessage] })
    })
    await act(async () => {
      useSessionStore.getState().beginCompaction('sess-a')
    })
    expect(conversationProps.conversation.availability.revise).toBe(false)

    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    expect(conversationProps.conversation.availability.revise).toBe(true)
  })

  it('keeps the resend handler stable when only the branch-switch operation gate changes', async () => {
    await renderPage()

    const initialHandler = conversationProps.conversation.actions.revise

    await act(async () => {
      useSessionStore.getState().setBranchSwitchBlocked('sess-a', true)
    })

    expect(conversationProps.conversation.availability.revise).toBe(true)
    expect(conversationProps.conversation.actions.revise).toBe(initialHandler)
  })
})

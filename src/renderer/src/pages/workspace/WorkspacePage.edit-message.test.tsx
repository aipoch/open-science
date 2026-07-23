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

// Capture the ConversationPanel props the page computes, notably canEditMessage and the resend handler.
let conversationProps: {
  canEditMessage: boolean
  onSendEditedMessage: (messageId: string, doc: ComposerDoc) => void
}

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  resendEditedMessage: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

vi.mock('@/components/ui/resizable', () => ({
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

vi.mock('./RenameSessionDialog', () => ({
  RenameSessionDialog: (): React.JSX.Element => <div />
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
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: { deleteUpload: vi.fn(), stageFiles: vi.fn() },
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
      root.render(<WorkspacePage isSessionPersistenceReady={true} />)
    })
  }

  it('routes the edited prompt through the truncate-and-resend runtime flow', async () => {
    await renderPage()

    expect(conversationProps.canEditMessage).toBe(true)

    await act(async () => {
      conversationProps.onSendEditedMessage('message-1', editedDoc)
    })

    // The runtime receives the truncation point plus the adjusted prompt with its mentions resolved.
    expect(runtime.resendEditedMessage).toHaveBeenCalledWith('sess-a', 'message-1', {
      text: 'Run /forecast tomorrow',
      parts: editedDoc.nodes,
      forcedSkillIds: ['skill-forecast'],
      referencedArtifacts: []
    })
  })

  it('refuses to resend while a run is active or the edited doc is empty', async () => {
    await renderPage()

    await act(async () => {
      setSession({ status: 'running', messages: [promptMessage] })
    })
    expect(conversationProps.canEditMessage).toBe(false)

    await act(async () => {
      conversationProps.onSendEditedMessage('message-1', editedDoc)
    })
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()

    await act(async () => {
      setSession({ messages: [promptMessage] })
    })
    expect(conversationProps.canEditMessage).toBe(true)

    await act(async () => {
      conversationProps.onSendEditedMessage('message-1', emptyDoc)
    })
    expect(runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('gates editing while a run is active and restores it once settled', async () => {
    await renderPage()

    expect(conversationProps.canEditMessage).toBe(true)

    await act(async () => {
      setSession({ status: 'running', messages: [promptMessage] })
    })
    expect(conversationProps.canEditMessage).toBe(false)

    await act(async () => {
      setSession({ status: 'waiting-permission', messages: [promptMessage] })
    })
    expect(conversationProps.canEditMessage).toBe(false)

    await act(async () => {
      setSession({ fixLoopActive: true, messages: [promptMessage] })
    })
    expect(conversationProps.canEditMessage).toBe(false)

    // Compaction recovery idles the session but must keep the gate closed until the replay finishes.
    await act(async () => {
      setSession({ messages: [promptMessage] })
    })
    await act(async () => {
      useSessionStore.getState().beginCompaction('sess-a')
    })
    expect(conversationProps.canEditMessage).toBe(false)

    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    expect(conversationProps.canEditMessage).toBe(true)
  })
})

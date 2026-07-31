// @vitest-environment jsdom
// Pins that WorkspacePage disables sending while the active session is auto-compacting after a
// request-size overflow. ConversationPanel only renders the note; the canSendMessage gate is computed
// here, so without this a manual prompt could race the recovery resend into the same session.
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
import { createInitialReviewState, useReviewStore } from '@/stores/review-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import type { ReviewWithChecks } from '../../../../shared/reviewer'

import { type ComposerDoc } from './composer/composer-doc'

// Capture the ConversationPanel props the page computes, notably canSendMessage and the draft callback.
let conversationProps: {
  draftDoc: ComposerDoc
  canEditDraft: boolean
  canSendMessage: boolean
  canEditMessage: boolean
  canCompactContext: boolean
  compactContextDisabledReason?: string
  onDraftDocChange: (doc: ComposerDoc) => void
}

const runtime = vi.hoisted(() => ({
  promptInFlightSessionIds: [] as string[],
  sendPreparationInFlightSessionIds: [] as string[],
  nativeContextCompactionSessionIds: ['sess-a'] as string[],
  sendMessage: vi.fn(),
  compactContext: vi.fn(),
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
    promptInFlightSessionIds: runtime.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds: runtime.sendPreparationInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.nativeContextCompactionSessionIds,
    sendMessage: runtime.sendMessage,
    compactContext: runtime.compactContext,
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

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

describe('WorkspacePage send gate while compacting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    useReviewStore.setState(createInitialReviewState())
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    vi.clearAllMocks()
    runtime.promptInFlightSessionIds = []
    runtime.sendPreparationInFlightSessionIds = []
    runtime.nativeContextCompactionSessionIds = ['sess-a']

    window.api = {
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
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

  it('disables sending while the active session is compacting, and re-enables after', async () => {
    await renderPage()

    // A non-empty draft on an idle session is normally sendable — this is the control.
    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('retry this'))
    })
    expect(conversationProps.canSendMessage).toBe(true)

    // Entering the compacting recovery state must gate the composer even though the status is idle and the
    // draft is unchanged, so a manual prompt can't race the recovery resend.
    await act(async () => {
      useSessionStore.getState().beginCompaction('sess-a')
    })
    expect(conversationProps.canSendMessage).toBe(false)

    // Once the replay turn starts (running) and the recovery clears the flag, sending is governed by the
    // normal status rules again. Finishing the run returns to idle with the draft still sendable.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    expect(conversationProps.canSendMessage).toBe(true)
  })

  it('blocks message-branch changes only while the project-scoped review is running', async () => {
    await renderPage()
    expect(conversationProps.canEditMessage).toBe(true)

    const runningReview: ReviewWithChecks = {
      id: 'review-1',
      projectId: 'proj-1',
      sessionId: 'sess-a',
      turnMessageId: 'reply-1',
      scope: {
        turnMessageId: 'reply-1',
        messageBranchId: 'message-branch-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'running',
      outcome: null,
      model: 'test-model',
      reviewerLog: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      checks: []
    }

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({ review: runningReview })
    })
    expect(conversationProps.canEditMessage).toBe(false)
    expect(useSessionStore.getState().sessions[0]?.branchSwitchBlocked).toBe(true)

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({
        review: {
          ...runningReview,
          lifecycle: 'complete',
          outcome: 'pass',
          updatedAt: 2_000
        }
      })
    })
    expect(conversationProps.canEditMessage).toBe(true)
    expect(useSessionStore.getState().sessions[0]?.branchSwitchBlocked).not.toBe(true)
  })

  it('disables sending while the runtime owns an otherwise idle session', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('wait for compaction'))
    })
    expect(conversationProps.canSendMessage).toBe(true)

    runtime.promptInFlightSessionIds = ['sess-a']
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
    expect(conversationProps.canSendMessage).toBe(false)

    runtime.promptInFlightSessionIds = []
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
    expect(conversationProps.canSendMessage).toBe(true)
  })

  it('locks draft submission and message editing while a send prepares runtime adoption', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('wait for adoption'))
    })
    expect(conversationProps.canEditDraft).toBe(true)
    expect(conversationProps.canSendMessage).toBe(true)
    expect(conversationProps.canEditMessage).toBe(true)

    runtime.sendPreparationInFlightSessionIds = ['sess-a']
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })

    expect(conversationProps.canEditDraft).toBe(false)
    expect(conversationProps.canSendMessage).toBe(false)
    expect(conversationProps.canEditMessage).toBe(false)
  })

  it('blocks new prompts after terminal conversation graph synchronization fails', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'error',
        error: 'Conversation history could not be finalized safely.',
        conversationGraphSyncBlocked: true
      }))
    }))
    await renderPage()

    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('do not overwrite the durable graph'))
    })

    expect(conversationProps.canSendMessage).toBe(false)
    expect(conversationProps.canEditMessage).toBe(false)
  })

  it('allows manual compaction only for an idle session, not an unresolved error', async () => {
    await renderPage()

    expect(conversationProps.canCompactContext).toBe(true)

    await act(async () => {
      useSessionStore.getState().failRun('sess-a', 'Keep this failure visible')
    })

    expect(conversationProps.canCompactContext).toBe(false)
    expect(conversationProps.compactContextDisabledReason).toBe(
      'Resolve the current session error before compacting.'
    )
  })
})

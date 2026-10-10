// @vitest-environment jsdom
import { act, useContext, useState } from 'react'
import { literatureItemInputSchema } from '../../../../shared/literature'
import {
  LibraryPreviewNavigationContext,
  useLibraryReferenceActions
} from './previews/library-reference-actions'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  PROJECT_LIBRARY_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards, workbenchPreviewGuardScope } from '@/stores/preview-leave-guard'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { TextAnnotation } from '../../../../shared/annotations'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type {
  LiteratureReference,
  ResearchMembership,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'
import { researchDraftKey } from './research-draft-identity'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'
import {
  readResearchProjectDestination,
  resolveResearchProjectDestination
} from '@/lib/research-project-entry'
import {
  markWorkspaceReviewHistoryLoaded,
  setDefaultWorkspaceAgentSettings
} from './workspace-page-test-fixtures'

// Capture the props passed to the heavy child components so the test can drive selection and drafts.
let openLibraryPreview: React.ContextType<typeof LibraryPreviewNavigationContext>
let libraryActions: ReturnType<typeof useLibraryReferenceActions>
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]
let sidebarProps: {
  canDeleteConversations: boolean
  onOpenSession: (id: string) => void
  onNewConversation: () => void
  onOpenLiterature?: () => boolean
  onDownloadArtifacts: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
}
let downloadArtifactsDialogProps: {
  session: ChatSession | undefined
  onClose: () => void
}
let deleteDialogProps: Parameters<
  (typeof import('./DeleteSessionDialog'))['DeleteSessionDialog']
>[0]

// The runtime bridge is stubbed; sendMessage resolves truthy so the success path clears the composer.
const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancelRun: vi.fn(),
  resumeInterruptedSession: vi.fn(),
  respondToPermission: vi.fn()
}))
const deleteSession = vi.hoisted(() => vi.fn())
const loadDiscussionContext = vi.hoisted(() => vi.fn())
vi.mock('./workspace-session-actions', async (original) => ({
  ...(await original<typeof import('./workspace-session-actions')>()),
  loadSessionDiscussionContext: loadDiscussionContext
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
    cancelRun: runtime.cancelRun,
    resumeInterruptedSession: runtime.resumeInterruptedSession,
    respondToPermission: runtime.respondToPermission
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (props: typeof sidebarProps): React.JSX.Element => {
    sidebarProps = props
    const [localCount, setLocalCount] = useState(0)
    return (
      <aside>
        <button data-testid="sidebar-local-state" onClick={() => setLocalCount(localCount + 1)}>
          {localCount}
        </button>
      </aside>
    )
  }
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (props: typeof conversationProps): React.JSX.Element => {
    conversationProps = props
    openLibraryPreview = useContext(LibraryPreviewNavigationContext)
    const [localDetailOpen, setLocalDetailOpen] = useState(false)
    return (
      <section data-testid="conversation">
        <button data-testid="open-local-detail" onClick={() => setLocalDetailOpen(true)}>
          Open detail
        </button>
        {localDetailOpen ? (
          <div data-testid="local-detail-session">{props.view.activeSession?.id}</div>
        ) : null}
      </section>
    )
  }
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => {
    libraryActions = useLibraryReferenceActions()
    return <div data-testid="preview-panel" />
  }
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', async () => {
  const actual =
    await vi.importActual<typeof import('./DeleteSessionDialog')>('./DeleteSessionDialog')
  return {
    DeleteSessionDialog: (props: typeof deleteDialogProps): React.JSX.Element => {
      deleteDialogProps = props
      return <actual.DeleteSessionDialog {...props} />
    }
  }
})

vi.mock('./DownloadSessionArtifactsDialog', () => ({
  DownloadSessionArtifactsDialog: (
    props: typeof downloadArtifactsDialogProps
  ): React.JSX.Element => {
    downloadArtifactsDialogProps = props
    return <div />
  }
}))

const { WorkspacePage } = await import('./WorkspacePage')

// Builds a minimal persisted-shape session that belongs to a given project.
const createSession = (id: string, projectId: string): ChatSession => {
  const now = Date.now()

  return {
    id,
    projectId,
    title: id,
    cwd: `/workspace/${projectId}`,
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

// Builds a staged-attachment record with a known path so file deletion can be asserted.
const createAttachment = (id: string): UploadedAttachment => ({
  id,
  sessionId: '.pending',
  name: `${id}.txt`,
  originalName: `${id}.txt`,
  path: `/uploads/.pending/${id}.txt`,
  size: 4
})

// Deterministic doc containing a single text run.
const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const userMessage = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user' as const,
  content,
  status: 'complete' as const,
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})

const createTextAnnotation = (): TextAnnotation => ({
  id: 'annotation-1',
  kind: 'text' as const,
  target: 'agent' as const,
  quote: 'Quoted Agent evidence',
  note: 'Explain why this matters.',
  source: {
    kind: 'agent-message' as const,
    sessionId: 'sess-a',
    messageId: 'agent-message-1'
  }
})

const createDeferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const deleteUpload = vi.fn(() => Promise.resolve())
const stageLocalFile = vi.fn()
const claimLocalFile = vi.fn(() => Promise.resolve())
const abortTransfer = vi.fn(() => Promise.resolve())

describe('WorkspacePage draft preservation', () => {
  let container: HTMLDivElement
  let root: Root
  let originalFileReader: typeof FileReader

  beforeEach(() => {
    useSessionReplayStore.setState({
      pendingDiscussion: undefined,
      discussionDestination: undefined,
      draftDiscussion: undefined
    })
    useResearchWorkspaceStore.setState({ draftResearchByProject: {}, lastDiscussionByResearch: {} })
    loadDiscussionContext.mockReset().mockResolvedValue(undefined)
    setDefaultWorkspaceAgentSettings()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Project',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useNavigationStore.setState({
      view: 'workspace',
      activeProjectId: 'proj-1',
      userNavigationRevision: 0,
      explicitNavigationRevision: 0
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession('sess-a', 'proj-1'), createSession('sess-b', 'proj-1')],
      selectedSessionId: 'sess-a'
    })
    markWorkspaceReviewHistoryLoaded(
      { projectId: 'proj-1', sessionId: 'sess-a' },
      { projectId: 'proj-1', sessionId: 'sess-b' }
    )
    useSettingsStore.setState({ skills: [], defaultPermissionProfile: 'ask' })
    useSpecialistStore.setState({ items: [], isLoaded: false })
    vi.clearAllMocks()
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'm1' })
    deleteSession.mockReset().mockImplementation(({ sessionId }: { sessionId: string }) => {
      useSessionStore.getState().deleteSession(sessionId)
      return Promise.resolve({ status: 'deleted', runtimeDetached: true })
    })
    deleteUpload.mockResolvedValue(undefined)

    // A deterministic FileReader keeps the async staging pipeline within the microtask queue.
    originalFileReader = globalThis.FileReader
    class MockFileReader {
      result = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.result = 'data:text/plain;base64,ZmFrZQ=='
        queueMicrotask(() => this.onload?.())
      }
    }
    globalThis.FileReader = MockFileReader as never

    window.api = {
      sessionReplay: { saveSelectionSnapshot: vi.fn().mockResolvedValue(undefined) },
      acp: { getPlanProjection: vi.fn(() => Promise.resolve(null)) },
      sessions: { deleteSession },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: {
        deleteUpload,
        stageLocalFile,
        claimLocalFile,
        beginTransfer: vi.fn(),
        appendTransfer: vi.fn(),
        getTransferStatus: vi.fn(),
        finishTransfer: vi.fn(),
        abortTransfer,
        onTransferProgress: vi.fn(() => vi.fn())
      },
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
    globalThis.FileReader = originalFileReader
    vi.restoreAllMocks()
    container.remove()
  })

  const renderPage = async (
    isSessionPersistenceReady = true,
    canDeleteConversations = true
  ): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={isSessionPersistenceReady}
          canDeleteConversations={canDeleteConversations}
        />
      )
    })
  }

  // Drives the composer's real staging pipeline so a per-session attachment lands in page state.
  const stageAttachment = async (attachment: UploadedAttachment): Promise<void> => {
    stageLocalFile.mockResolvedValueOnce(attachment)
    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File(['data'], `${attachment.id}.txt`, { type: 'text/plain' })
      ])
    })
  }

  const openSession = async (id: string): Promise<void> => {
    await act(async () => {
      sidebarProps.onOpenSession(id)
    })
  }

  const makeImported = (id = 'sess-a'): ChatSession => ({
    ...createSession(id, 'proj-1'),
    title: 'Imported research',
    packageOrigin: {
      importId: `import-${id}`,
      sourceProjectId: 'author',
      sourceSessionId: 'author-session',
      importedAt: 1,
      manifestChecksum: 'a'.repeat(64)
    }
  })
  const membershipFor = (source: ChatSession): ResearchMembership => ({
    sourceProjectId: source.projectId,
    sourceSessionId: source.id,
    sourceTitle: source.title,
    sourceImportId: source.packageOrigin!.importId
  })

  it('renders original research with an isolated question draft and never sends to the imported Session', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source, createSession('sess-b', 'proj-1')] })
    const before = structuredClone(source)
    loadDiscussionContext.mockResolvedValue({
      projectId: source.projectId,
      sourceSessionId: source.id,
      sourceTitle: source.title,
      scope: 'session',
      fingerprint: 'fp',
      branchId: 'main',
      stepId: 'first',
      stepOffsetMs: 0,
      evidence: [
        {
          kind: 'message',
          id: 'original-message',
          projectId: source.projectId,
          sessionId: source.id,
          part: 'record'
        }
      ],
      excerpt: 'Original result'
    })
    await renderPage()
    expect(conversationProps.view.researchSourceSession).toEqual(source)
    expect(conversationProps.view.activeSession).toBeUndefined()
    expect(conversationProps.view.canEditDraft).toBe(true)
    expect(conversationProps.view.composerFocusKey).toBe(researchDraftKey(membershipFor(source)))
    await act(async () =>
      conversationProps.composer.actions.changeDoc(textDoc('Question for research'))
    )
    await openSession('sess-b')
    await act(async () =>
      conversationProps.composer.actions.changeDoc(textDoc('Ordinary question'))
    )
    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('Question for research'))
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(conversationProps.composer.view.annotations).toHaveLength(1)
    runtime.sendMessage.mockImplementationOnce(async (input) => {
      const pending = {
        ...createSession('new-discussion', source.projectId),
        isPending: true,
        researchMembership: input.researchMembership,
        messages: [userMessage('first-question', input.text)]
      }
      useSessionStore.setState((state) => ({
        sessions: [...state.sessions, pending],
        selectedSessionId: pending.id
      }))
      input.onMessageAppended?.({ sessionId: pending.id, messageId: 'first-question' })
      return { sessionId: pending.id, messageId: 'first-question' }
    })
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        projectId: source.projectId,
        text: 'Question for research',
        researchMembership: membershipFor(source)
      })
    )
    expect(useSessionStore.getState().sessions.find((row) => row.id === source.id)).toEqual(before)
    expect(conversationProps.view.activeSession?.id).toBe('new-discussion')
    expect(conversationProps.view.researchSourceSession).toBeUndefined()
    expect(useSessionStore.getState().sessions).toHaveLength(3)
    await act(async () =>
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'new-discussion'
            ? { ...session, id: 'saved-discussion', isPending: false }
            : session
        ),
        selectedSessionId: 'saved-discussion'
      }))
    )
    expect(readResearchProjectDestination(source.projectId)).toEqual({
      kind: 'session',
      sessionId: 'saved-discussion'
    })
    expect(
      resolveResearchProjectDestination(
        source.projectId,
        useSessionStore.getState().sessions,
        readResearchProjectDestination(source.projectId)
      )
    ).toEqual({ kind: 'session', sessionId: 'saved-discussion' })
  })

  it('blocks first Send until original research context is ready and retains typed text across retry', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source] })
    const loading = createDeferred<undefined>()
    loadDiscussionContext.mockReturnValue(loading.promise)
    await renderPage()
    await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Keep my question')))
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    loadDiscussionContext.mockRejectedValue(new Error('Source unavailable'))
    await act(async () => {
      loading.resolve(undefined)
    })
    // Re-enter with a different import identity to exercise a fresh failed preparation.
    await act(async () =>
      useSessionStore.setState({
        sessions: [
          { ...source, packageOrigin: { ...source.packageOrigin!, importId: 'new-import' } }
        ]
      })
    )
    expect(conversationProps.view.researchSourceContextError).toBe('Source unavailable')
    await act(async () =>
      conversationProps.composer.actions.changeDoc(textDoc('Keep retry question'))
    )
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    loadDiscussionContext.mockResolvedValue(undefined)
    await act(async () => conversationProps.view.retryResearchSourceContext?.())
    expect(conversationProps.view.researchSourceContextError).toBeUndefined()
    expect(conversationProps.composer.view.doc).toEqual(textDoc('Keep retry question'))
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined, text: 'Keep retry question' })
    )
  })

  it('keeps Send blocked when the source snapshot cannot be saved and retries without losing the question', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source] })
    loadDiscussionContext.mockResolvedValue({
      projectId: source.projectId,
      sourceSessionId: source.id,
      sourceTitle: source.title,
      scope: 'session',
      fingerprint: 'fp',
      branchId: 'main',
      stepId: 'first',
      stepOffsetMs: 0,
      evidence: [
        {
          kind: 'message',
          id: 'original-message',
          projectId: source.projectId,
          sessionId: source.id,
          part: 'record'
        }
      ],
      excerpt: 'Original result'
    })
    vi.mocked(window.api.sessionReplay.saveSelectionSnapshot).mockRejectedValue(
      new Error('Snapshot unavailable')
    )
    await renderPage()
    expect(conversationProps.view.researchSourceContextError).toBe('Snapshot unavailable')
    await act(async () =>
      conversationProps.composer.actions.changeDoc(textDoc('Retain snapshot question'))
    )
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    vi.mocked(window.api.sessionReplay.saveSelectionSnapshot).mockResolvedValue(undefined)
    await act(async () => conversationProps.view.retryResearchSourceContext?.())
    expect(conversationProps.view.researchSourceContextError).toBeUndefined()
    expect(conversationProps.composer.view.doc).toEqual(textDoc('Retain snapshot question'))
    expect(conversationProps.composer.view.annotations).toHaveLength(1)
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        text: 'Retain snapshot question',
        annotations: [expect.anything()]
      })
    )
  })

  it('retains source Notebook access and adds Library references to the visible question draft', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source] })
    await renderPage()
    expect(window.api.notebook.getReference).toHaveBeenCalledWith({
      sessionId: source.id,
      projectId: source.projectId,
      workspaceCwd: source.cwd
    })
    expect(libraryActions!.currentSessionId).toBeUndefined()
    expect(libraryActions!.canAddToCurrent).toBe(true)
    const reference = libraryReference()
    await act(async () => libraryActions!.add([reference], null))
    expect(useSessionStore.getState().selectedSessionId).toBe(source.id)
    expect(conversationProps.view.composerFocusKey).toBe(researchDraftKey(membershipFor(source)))
    expect(conversationProps.composer.view.doc.nodes).toContainEqual(reference)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('waits for a newly selected step even when the source draft already references the research', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source] })
    const context = {
      projectId: source.projectId,
      sourceSessionId: source.id,
      sourceTitle: source.title,
      scope: 'session' as const,
      fingerprint: 'fp',
      branchId: 'main',
      stepId: 'first',
      stepOffsetMs: 0,
      evidence: [
        {
          kind: 'message' as const,
          id: 'original-message',
          projectId: source.projectId,
          sessionId: source.id,
          part: 'record' as const
        }
      ],
      excerpt: 'Original result'
    }
    loadDiscussionContext.mockResolvedValue(context)
    await renderPage()
    expect(conversationProps.composer.view.annotations).toHaveLength(1)
    const snapshot = createDeferred<void>()
    vi.mocked(window.api.sessionReplay.saveSelectionSnapshot).mockReturnValue(snapshot.promise)
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('Ask about this exact step'))
      useSessionReplayStore.getState().ask(
        { ...context, scope: 'step', stepId: 'second' },
        {
          projectId: source.projectId,
          draftKey: researchDraftKey(membershipFor(source)),
          navigationRevision: useNavigationStore.getState().explicitNavigationRevision
        }
      )
    })
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    await act(async () => snapshot.resolve())
    expect(conversationProps.composer.view.annotations).toHaveLength(1)
    expect(replayAnnotationTarget(conversationProps.composer.view.annotations[0])?.stepId).toBe(
      'second'
    )
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined, text: 'Ask about this exact step' })
    )
  })

  it('does not admit a context-free send when the same source is reopened during initial snapshot storage', async () => {
    const source = makeImported()
    useSessionStore.setState({ sessions: [source] })
    loadDiscussionContext.mockResolvedValue({
      projectId: source.projectId,
      sourceSessionId: source.id,
      sourceTitle: source.title,
      scope: 'session',
      fingerprint: 'fp',
      branchId: 'main',
      stepId: 'first',
      stepOffsetMs: 0,
      evidence: [
        {
          kind: 'message',
          id: 'original-message',
          projectId: source.projectId,
          sessionId: source.id,
          part: 'record'
        }
      ],
      excerpt: 'Original result'
    })
    const saving = createDeferred<void>()
    vi.mocked(window.api.sessionReplay.saveSelectionSnapshot).mockReturnValueOnce(saving.promise)
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('Question during reentry'))
      useNavigationStore.getState().recordUserNavigation()
    })
    await act(async () => saving.resolve())
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    for (const [input] of runtime.sendMessage.mock.calls) expect(input.annotations).toHaveLength(1)
  })

  it('starts desktop drafts with application settings despite automation Project defaults', async () => {
    useProjectStore.setState({
      projects: useProjectStore.getState().projects.map((project) => ({
        ...project,
        sessionDefaults: { autoReviewEnabled: true, permissionProfile: 'full' as const }
      }))
    })
    useSessionStore.setState({ selectedSessionId: undefined })
    await renderPage()
    expect(conversationProps.agentControls.autoReviewEnabled).toBe(false)
    expect(conversationProps.permissions.permissionProfile).toBe('ask')
    await act(async () => sidebarProps.onNewConversation())
    expect(conversationProps.agentControls.autoReviewEnabled).toBe(false)
    expect(conversationProps.permissions.permissionProfile).toBe('ask')
  })

  it('opens and closes the Artifact download dialog for the selected sidebar Session', async () => {
    await renderPage()
    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!

    await act(async () => {
      sidebarProps.onDownloadArtifacts(sessionB)
    })
    expect(downloadArtifactsDialogProps.session?.id).toBe('sess-b')

    await act(async () => {
      downloadArtifactsDialogProps.onClose()
    })
    expect(downloadArtifactsDialogProps.session).toBeUndefined()
  })

  it('routes Library batches into the chosen draft without sending or overwriting other drafts', async () => {
    await renderPage()
    await act(async () => sidebarProps.onOpenLiterature!())
    const reference = {
      type: 'literature' as const,
      itemId: 'paper',
      metadataRevision: 1,
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' })
    }
    await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Draft A')))
    await openSession('sess-b')
    await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Draft B')))
    await openSession('sess-a')
    await act(async () => libraryActions!.add([reference, reference], 'sess-b'))
    expect(conversationProps.view.composerFocusKey).toBe('sess-b')
    expect(conversationProps.composer.view.doc.nodes).toEqual([
      { type: 'text', text: 'Draft B' },
      { type: 'text', text: ' ' },
      reference
    ])
    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('Draft A'))
    await act(async () => libraryActions!.add([reference], null))
    expect(conversationProps.view.composerFocusKey).toBe('new:proj-1')
    expect(conversationProps.composer.view.doc.nodes).toEqual([reference])
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  const libraryReference = (itemId = 'paper'): LiteratureReference => ({
    type: 'literature' as const,
    itemId,
    metadataRevision: 1,
    item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: itemId })
  })
  const prepareSummaryLoad = (
    sessionId = 'sess-b'
  ): {
    loaded: ReturnType<typeof createDeferred<PersistedChatSession | undefined>>
    persisted: PersistedChatSession
  } => {
    const loaded = createDeferred<ReturnType<typeof toPersistedSession> | undefined>()
    const persisted = toPersistedSession(createSession(sessionId, 'proj-1'))
    window.api.sessions.loadOne = vi.fn(() => loaded.promise)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, contentLoaded: false } : session
      )
    }))
    return { loaded, persisted }
  }

  it.each([
    ['sess-a', false],
    ['sess-b', false],
    ['sess-a', true],
    ['sess-b', true]
  ] as const)(
    'validates a summary destination before inserting references (%s, imported: %s)',
    async (sessionId, imported) => {
      const { loaded, persisted } = prepareSummaryLoad(sessionId)
      await renderPage()
      await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Draft A')))
      if (sessionId === 'sess-a') expect(libraryActions!.canAddToCurrent).toBe(false)
      const reference = libraryReference()
      await act(async () => libraryActions!.add([reference], sessionId))
      expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
      expect(conversationProps.composer.view.doc).toEqual(textDoc('Draft A'))
      await act(async () =>
        loaded.resolve({
          ...persisted,
          ...(imported
            ? {
                packageOrigin: {
                  importId: 'import-1',
                  sourceProjectId: 'source-project',
                  sourceSessionId: 'source-session',
                  importedAt: 1,
                  manifestChecksum: 'a'.repeat(64)
                }
              }
            : {})
        })
      )
      if (imported) {
        expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
        if (sessionId === 'sess-a') {
          // Hydration reveals an imported record: its question draft is separate from the
          // prior unidentified Session draft and never admits a Library write to the source.
          expect(conversationProps.view.researchSourceSession?.id).toBe('sess-a')
          expect(conversationProps.view.activeSession).toBeUndefined()
          expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
        } else expect(conversationProps.composer.view.doc).toEqual(textDoc('Draft A'))
        expect(conversationProps.composer.view.error).toBe(
          'This conversation cannot accept references right now.'
        )
      } else {
        expect(useSessionStore.getState().selectedSessionId).toBe(sessionId)
        expect(conversationProps.composer.view.doc.nodes).toContainEqual(reference)
      }
      expect(runtime.sendMessage).not.toHaveBeenCalled()
    }
  )

  it('keeps the current draft when loading a Library destination fails', async () => {
    prepareSummaryLoad()
    window.api.sessions.loadOne = vi.fn().mockRejectedValue(new Error('Unavailable'))
    await renderPage()
    await act(async () => libraryActions!.add([libraryReference()], 'sess-b'))
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    expect(conversationProps.composer.view.error).toBe(
      'This conversation cannot accept references right now.'
    )
  })

  it('accumulates references for the same destination while its summary is loading', async () => {
    const { loaded, persisted } = prepareSummaryLoad()
    await renderPage()
    const references = [libraryReference('one'), libraryReference('two')]
    await act(async () => {
      libraryActions!.add([references[0]], 'sess-b')
      libraryActions!.add([references[1]], 'sess-b')
    })
    await act(async () => loaded.resolve(persisted))
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-b')
    expect(
      conversationProps.composer.view.doc.nodes.filter((node) => node.type === 'literature')
    ).toEqual(references)
  })

  it('does not let a late Library destination load override a newer insertion', async () => {
    const { loaded, persisted } = prepareSummaryLoad()
    await renderPage()
    await act(async () => libraryActions!.add([libraryReference('old')], 'sess-b'))
    const newer = libraryReference('new')
    await act(async () => libraryActions!.add([newer], null))
    await act(async () => loaded.resolve(persisted))
    expect(conversationProps.view.composerFocusKey).toBe('new:proj-1')
    expect(conversationProps.composer.view.doc.nodes).toEqual([newer])
  })

  it('cancels a Library destination load when the user navigates away and back', async () => {
    const { loaded, persisted } = prepareSummaryLoad()
    await renderPage()
    await act(async () => libraryActions!.add([libraryReference()], 'sess-b'))
    await act(async () => useNavigationStore.getState().openLibrary('user'))
    await act(async () => useNavigationStore.getState().openSession('proj-1', 'sess-a', 'user'))
    await act(async () => loaded.resolve(persisted))
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
  })

  it.each([null, 'sess-b'])(
    'sends Library references without enabling Reading (destination: %s)',
    async (destination) => {
      await renderPage()
      await act(async () => sidebarProps.onOpenLiterature!())
      const references = [
        {
          type: 'literature' as const,
          itemId: 'paper-with-pdf',
          metadataRevision: 1,
          item: literatureItemInputSchema.parse({
            itemType: 'journalArticle',
            title: 'Paper with PDF'
          }),
          attachmentVersionId: 'pdf-version-1'
        },
        {
          type: 'literature' as const,
          itemId: 'paper-without-pdf',
          metadataRevision: 2,
          item: literatureItemInputSchema.parse({
            itemType: 'journalArticle',
            title: 'Metadata paper'
          })
        }
      ]
      await act(async () => libraryActions!.add(references, destination))
      expect(conversationProps.composer.view.readingContext.bindings).toEqual([])
      const preview = container.querySelector('[data-testid="preview-panel"]')
      runtime.sendMessage.mockImplementationOnce(async () => {
        const sessionId = destination ?? 'created-session'
        if (!destination) {
          useSessionStore.setState((state) => ({
            sessions: [...state.sessions, createSession(sessionId, 'proj-1')],
            selectedSessionId: sessionId
          }))
        }
        return { sessionId, messageId: 'm1' }
      })
      await act(async () =>
        conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      )
      expect(container.querySelector('[data-testid="preview-panel"]')).toBe(preview)
      expect(runtime.sendMessage).toHaveBeenCalledOnce()
      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: destination ?? undefined,
          parts: expect.arrayContaining(references),
          pdfContext: undefined,
          pendingPdfContextVersions: undefined,
          pendingPdfContextAttachmentIds: undefined
        })
      )
    }
  )

  it('preserves each session doc independently when switching away and back', async () => {
    await renderPage()
    expect(conversationProps.view.composerFocusKey).toBe('sess-a')

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('draft for A'))
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('draft for A'))

    // Switching to session B clears the composer to B's own (empty) doc.
    await openSession('sess-b')
    expect(conversationProps.view.composerFocusKey).toBe('sess-b')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('draft for B'))
    })

    // Switching back to session A restores A's doc, and B keeps its own.
    await openSession('sess-a')
    expect(conversationProps.view.composerFocusKey).toBe('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('draft for A'))

    await openSession('sess-b')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('draft for B'))
  })

  it('resets main-panel local detail state without remounting the sidebar or losing drafts', async () => {
    await renderPage()
    const sidebarButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-local-state"]'
    )!
    const mainPanel = container.querySelector<HTMLElement>('[data-testid="conversation"]')!
    await act(async () => {
      sidebarButton.click()
      container.querySelector<HTMLButtonElement>('[data-testid="open-local-detail"]')!.click()
      conversationProps.composer.actions.changeDoc(textDoc('draft for A'))
    })
    expect(sidebarButton.textContent).toBe('1')
    expect(container.querySelector('[data-testid="local-detail-session"]')?.textContent).toBe(
      'sess-a'
    )

    await openSession('sess-b')
    expect(container.querySelector('[data-testid="sidebar-local-state"]')).toBe(sidebarButton)
    expect(sidebarButton.textContent).toBe('1')
    expect(container.querySelector('[data-testid="conversation"]')).not.toBe(mainPanel)
    expect(container.querySelector('[data-testid="local-detail-session"]')).toBeNull()
    expect(conversationProps.view.activeSession?.id).toBe('sess-b')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)

    await openSession('sess-a')
    expect(container.querySelector('[data-testid="sidebar-local-state"]')).toBe(sidebarButton)
    expect(container.querySelector('[data-testid="local-detail-session"]')).toBeNull()
    expect(conversationProps.composer.view.doc).toEqual(textDoc('draft for A'))
  })

  it('preserves the new panel through pending Session binding and resets it on another selection', async () => {
    await renderPage()
    await act(async () => sidebarProps.onNewConversation())
    const panel = container.querySelector('[data-testid="conversation"]')
    const pending: ChatSession = {
      id: 'pending-new',
      projectId: 'proj-1',
      title: 'First prompt',
      cwd: '/workspace',
      status: 'running',
      isPending: true,
      messages: [
        {
          id: 'new-prompt',
          role: 'user',
          content: 'Research this',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }
    // Use the current Project identity from the live new-conversation props.
    pending.projectId = useNavigationStore.getState().activeProjectId!
    runtime.sendMessage.mockImplementationOnce(async (input) => {
      useSessionStore.setState((state) => ({
        sessions: [...state.sessions, pending],
        selectedSessionId: pending.id
      }))
      input.onMessageAppended?.({ sessionId: pending.id, messageId: 'new-prompt' })
      return { sessionId: pending.id, messageId: 'new-prompt' }
    })
    await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Research this')))
    await act(async () =>
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    )
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-testid="conversation"]')).toBe(panel)
    await act(async () =>
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === pending.id ? { ...session, id: 'bound-new', isPending: false } : session
        ),
        selectedSessionId: 'bound-new'
      }))
    )
    expect(container.querySelector('[data-testid="conversation"]')).toBe(panel)
    await openSession('sess-a')
    expect(container.querySelector('[data-testid="conversation"]')).not.toBe(panel)
  })

  it.each([
    ['selected', true],
    ['automatic', true],
    ['selected', false],
    ['automatic', false],
    ['filtered', true],
    ['filtered', false],
    ['none', true]
  ] as const)(
    'keeps first-send context (%s Reading, Discussion: %s) across real pending-to-durable identities before a response',
    async (reading, includeDiscussion) => {
      await renderPage()
      await act(async () => sidebarProps.onNewConversation())
      const projectId = useNavigationStore.getState().activeProjectId!
      const discussion = createSessionDiscussionAnnotation(
        {
          projectId,
          sourceSessionId: 'source',
          sourceTitle: 'Study',
          fingerprint: 'fp',
          branchId: 'main',
          stepId: 'step',
          stepOffsetMs: 0,
          excerpt: '',
          evidence: [{ kind: 'message', id: 'step', projectId, sessionId: 'source' }]
        },
        'selection'
      )!
      await act(async () => {
        if (includeDiscussion) conversationProps.composer.actions.addAnnotation(discussion)
        conversationProps.composer.actions.changeDoc(textDoc('Research this'))
      })
      if (reading === 'selected') {
        await act(async () => {
          const preview = usePreviewWorkbenchStore.getState()
          preview.upsertItem({
            id: 'literature:version',
            projectId,
            sessionId: 'literature-library',
            type: 'file',
            source: 'literature',
            title: 'paper.pdf',
            name: 'paper.pdf',
            format: 'pdf',
            path: 'literature-attachment-version:version',
            mimeType: 'application/pdf',
            size: 100
          })
          preview.setPendingPdfContext(projectId, {
            kind: 'version',
            sourceKind: 'literature-attachment-version',
            sourceVersionId: 'version',
            previewItemId: 'literature:version'
          })
        })
      } else if (reading === 'automatic' || reading === 'filtered') {
        await stageAttachment({
          id: 'pdf-upload',
          sessionId: '.pending',
          name: 'paper.pdf',
          originalName: 'paper.pdf',
          path: '/uploads/paper.pdf',
          mimeType: 'application/pdf',
          size: 100
        })
      }
      const pending: ChatSession = {
        ...createSession('pending-new', projectId),
        isPending: true,
        status: 'running',
        messages: [
          {
            id: 'first-prompt',
            role: 'user',
            content: 'Research this',
            status: 'complete',
            annotations: includeDiscussion ? [discussion] : [],
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
      let finish!: (value: { sessionId: string; messageId: string }) => void
      runtime.sendMessage.mockImplementationOnce((input) => {
        useSessionStore.setState((state) => ({
          sessions: [...state.sessions, pending],
          selectedSessionId: pending.id
        }))
        input.onMessageAppended?.({ sessionId: pending.id, messageId: 'first-prompt' })
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const assertContext = (prepared = false): void => {
        expect(conversationProps.composer.view.annotations).toEqual(
          includeDiscussion ? [discussion] : []
        )
        if (reading === 'selected')
          expect(conversationProps.composer.view.readingContext.bindings).toMatchObject([
            { name: 'paper.pdf' }
          ])
        else {
          expect(conversationProps.composer.view.readingContext.automaticAttachmentCount).toBe(
            reading === 'automatic' || (reading === 'filtered' && !prepared) ? 1 : 0
          )
          expect(conversationProps.composer.view.readingContext.automaticAttachments).toEqual(
            reading === 'automatic' || (reading === 'filtered' && !prepared)
              ? [{ id: 'pdf-upload', name: 'paper.pdf' }]
              : []
          )
        }
        expect(conversationProps.composer.view.readingContext.isPending).toBe(
          includeDiscussion || reading === 'selected' || reading === 'automatic' || !prepared
        )
      }
      await act(async () =>
        conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      )
      assertContext()
      await act(async () =>
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((row) =>
            row.id === pending.id
              ? {
                  ...row,
                  id: 'durable-new',
                  isPending: false,
                  // Runtime preparation publishes the immutable PDF snapshot before binding.
                  messages: row.messages.map((message) => ({
                    ...message,
                    ...(reading === 'selected' || reading === 'automatic'
                      ? {
                          pdfContext: {
                            version: 1 as const,
                            bindings: [
                              {
                                version: 1 as const,
                                bindingId: 'binding-1',
                                sourceKind: 'upload-version' as const,
                                sourceSessionId: 'durable-new',
                                sourceFileId: 'pdf-upload',
                                sourceVersionId: 'pdf-version',
                                name: 'paper.pdf',
                                mimeType: 'application/pdf' as const,
                                sizeBytes: 100,
                                checksum: 'a'.repeat(64),
                                linkedAt: 1
                              }
                            ]
                          }
                        }
                      : {})
                  }))
                }
              : row
          ),
          selectedSessionId: 'durable-new'
        }))
      )
      assertContext(true)
      // Admission can finish before runtimeContext is broadcast to the renderer.
      await act(async () => finish({ sessionId: 'durable-new', messageId: 'first-prompt' }))
      assertContext(true)
      if (reading === 'filtered' && !includeDiscussion) {
        await act(async () => conversationProps.composer.actions.changeDoc(textDoc('Follow up')))
        expect(conversationProps.composer.view).toMatchObject({
          doc: textDoc('Follow up'),
          attachments: [],
          annotations: []
        })
      }
      await openSession('sess-a')
      expect(conversationProps.composer.view.annotations).toEqual([])
      expect(conversationProps.composer.view.readingContext.bindings).toEqual([])
      expect(conversationProps.composer.view.readingContext.automaticAttachmentCount).toBe(0)
    }
  )

  it('remounts the new panel when selecting an existing pending Session', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'sess-a' ? { ...session, isPending: true, status: 'running' } : session
      )
    }))
    await renderPage()
    await act(async () => sidebarProps.onNewConversation())
    const panel = container.querySelector('[data-testid="conversation"]')
    const detail = container.querySelector<HTMLButtonElement>('[data-testid="open-local-detail"]')!
    await act(async () => detail.click())
    expect(container.querySelector('[data-testid="local-detail-session"]')).not.toBeNull()
    await openSession('sess-a')
    expect(container.querySelector('[data-testid="conversation"]')).not.toBe(panel)
    expect(container.querySelector('[data-testid="local-detail-session"]')).toBeNull()
  })

  it('keeps pending Stop and Resume guards across a Session round trip', async () => {
    await renderPage()
    let finishStop: (() => void) | undefined
    let finishResume: (() => void) | undefined
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        })
    )
    const resume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishResume = resolve
        })
    )

    await act(async () => {
      conversationProps.submissions.submitStop('sess-a', stop)
      void conversationProps.submissions.submitResume('sess-a', resume)
    })
    await openSession('sess-b')
    await openSession('sess-a')
    expect(conversationProps.submissions.stopBySessionId.get('sess-a')?.pending).toBe(true)
    expect(conversationProps.submissions.resumePendingSessionIds.has('sess-a')).toBe(true)

    await act(async () => {
      conversationProps.submissions.submitStop('sess-a', stop)
      void conversationProps.submissions.submitResume('sess-a', resume)
    })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishStop!()
      finishResume!()
    })
    expect(conversationProps.submissions.stopBySessionId.has('sess-a')).toBe(false)
    expect(conversationProps.submissions.resumePendingSessionIds.has('sess-a')).toBe(false)
  })

  it('keeps a late Stop error visible after returning to its Session', async () => {
    await renderPage()
    let failStop: ((error: Error) => void) | undefined
    await act(async () => {
      conversationProps.submissions.submitStop(
        'sess-a',
        () =>
          new Promise<void>((_resolve, reject) => {
            failStop = reject
          })
      )
    })
    await openSession('sess-b')
    await act(async () => {
      failStop!(new Error('Stop request failed'))
    })
    await openSession('sess-a')
    expect(conversationProps.submissions.stopBySessionId.get('sess-a')).toEqual({
      pending: false,
      error: 'Stop request failed'
    })
  })

  it('uses the configured profile only for new conversations', async () => {
    useSettingsStore.setState({ defaultPermissionProfile: 'auto' })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'sess-a' ? { ...session, permissionProfile: 'full' } : session
      ),
      selectedSessionId: 'sess-a'
    }))
    await renderPage()

    expect(conversationProps.permissions.permissionProfile).toBe('full')

    await act(async () => {
      sidebarProps.onNewConversation()
    })

    expect(conversationProps.permissions.permissionProfile).toBe('auto')
    expect(conversationProps.view.composerFocusKey).toBe('new:proj-1')
  })

  it('targets the new-conversation composer after the keyboard shortcut', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'sess-a'
          ? { ...session, messages: [userMessage('prompt', 'Start a new conversation')] }
          : session
      )
    }))
    await renderPage()

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, cancelable: true })
      )
    })

    expect(conversationProps.view.composerFocusKey).toBe('new:proj-1')
  })

  it('browses visible Session prompts and restores the unsent scratch draft', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === 'sess-a'
          ? {
              ...candidate,
              messages: [
                userMessage('first', 'first prompt'),
                userMessage('latest', 'latest prompt')
              ]
            }
          : candidate
      )
    }))
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('unsent scratch'))
    })
    await act(async () => {
      expect(conversationProps.composer.actions.navigateHistory('previous')).toBe(true)
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('latest prompt'))
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(true)
    expect(conversationProps.composer.view.historyStatus).toBe('History item 1 of 2')

    await act(async () => {
      expect(conversationProps.composer.actions.navigateHistory('previous')).toBe(true)
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('first prompt'))

    await act(async () => {
      expect(conversationProps.composer.actions.navigateHistory('next')).toBe(true)
      expect(conversationProps.composer.actions.navigateHistory('next')).toBe(true)
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('unsent scratch'))
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(false)
    expect(conversationProps.composer.view.historyStatus).toBe('Draft restored')
  })

  it('does not enter history while a top-level attachment is staged', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === 'sess-a'
          ? { ...candidate, messages: [userMessage('prompt', 'historical prompt')] }
          : candidate
      )
    }))
    await renderPage()
    await stageAttachment(createAttachment('history-blocker'))

    expect(conversationProps.composer.actions.navigateHistory('previous')).toBe(false)
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(false)
  })

  it('restores scratch and exits history when switching Sessions', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === 'sess-a'
          ? { ...candidate, messages: [userMessage('prompt', 'historical prompt')] }
          : candidate
      )
    }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('session scratch'))
    })
    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('historical prompt'))

    await openSession('sess-b')
    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('session scratch'))
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(false)
  })

  it('restores New Conversation scratch when a frozen opener source is deleted', async () => {
    useSessionStore.setState((state) => ({
      ...state,
      selectedSessionId: undefined,
      sessions: state.sessions.map((candidate, index) => ({
        ...candidate,
        messages: [userMessage(`opener-${index}`, `opener ${index}`)],
        updatedAt: 10 - index
      }))
    }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('new scratch'))
    })
    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(true)

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.filter((candidate) => candidate.id !== 'sess-a')
      }))
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('new scratch'))
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(false)
  })

  it('keeps a New Conversation browsing round frozen when a new Session appears', async () => {
    useSessionStore.setState((state) => ({
      ...state,
      selectedSessionId: undefined,
      sessions: state.sessions.map((candidate, index) => ({
        ...candidate,
        messages: [userMessage(`opener-${index}`, `opener ${index}`)],
        updatedAt: 10 - index
      }))
    }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('opener 0'))

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            ...createSession('sess-new', 'proj-1'),
            messages: [userMessage('new-opener', 'new opener')],
            updatedAt: 100
          }
        ]
      }))
    })
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(true)
    expect(conversationProps.composer.view.doc).toEqual(textDoc('opener 0'))

    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('opener 1'))
  })

  it('downgrades a recalled Skill when the selected Specialist disallows it', async () => {
    useSettingsStore.setState({
      skills: [
        {
          id: 'lit',
          name: 'Literature',
          displayName: 'Literature',
          description: 'Search papers',
          source: 'featured',
          enabled: true,
          updatedAt: '2026-08-05T00:00:00.000Z'
        }
      ]
    })
    useSpecialistStore.setState({
      isLoaded: true,
      items: [
        {
          kind: 'custom',
          id: 'restricted',
          name: 'Restricted',
          description: '',
          systemPrompt: '',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ]
    })
    window.api = {
      ...window.api,
      specialist: {
        setSessionSpecialist: vi.fn(() =>
          Promise.resolve({ status: 'applied', contextReset: false })
        )
      }
    } as never
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === 'sess-a'
          ? {
              ...candidate,
              messages: [
                {
                  ...userMessage('skill-prompt', '/Literature analyze'),
                  parts: [
                    { type: 'skill', id: 'lit', name: 'Literature' },
                    { type: 'text', text: ' analyze' }
                  ]
                }
              ]
            }
          : candidate
      )
    }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.doc.nodes[0]).toMatchObject({ type: 'skill', id: 'lit' })

    await act(async () => {
      conversationProps.specialist.actions.selectSpecialist?.('restricted')
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('/Literature analyze'))
    expect(conversationProps.composer.view.historyStatus).toContain('/Literature unavailable')

    await act(async () => {
      conversationProps.specialist.actions.selectSpecialist?.(undefined)
    })
    expect(conversationProps.composer.view.doc.nodes[0]).toMatchObject({ type: 'skill', id: 'lit' })
    expect(conversationProps.composer.view.historyStatus).toBe('History item 1 of 1')
  })

  it('does not downgrade Skill history when the catalog fails to load', async () => {
    const listSkills = vi.fn().mockRejectedValue(new Error('catalog unavailable'))
    window.api = {
      ...window.api,
      settings: { listSkills, onSkillCatalogChanged: vi.fn(() => vi.fn()) }
    } as never
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === 'sess-a'
          ? {
              ...candidate,
              messages: [
                {
                  ...userMessage('skill-prompt', '/Literature analyze'),
                  parts: [
                    { type: 'skill', id: 'lit', name: 'Literature' },
                    { type: 'text', text: ' analyze' }
                  ]
                }
              ]
            }
          : candidate
      )
    }))
    await renderPage()

    await act(async () => {
      expect(conversationProps.composer.actions.navigateHistory('previous')).toBe(false)
      await Promise.resolve()
    })
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    expect(conversationProps.composer.view.historyStatus).toContain('loading')
    expect(listSkills).toHaveBeenCalled()
  })

  it('keeps New Conversation drafts isolated by Project', async () => {
    useSessionStore.setState((state) => ({ ...state, selectedSessionId: undefined }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('project one draft'))
    })

    await act(async () => {
      useNavigationStore.setState({ activeProjectId: 'proj-2' })
    })
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('project two draft'))
      useNavigationStore.setState({ activeProjectId: 'proj-1' })
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('project one draft'))
  })

  it('preserves the new-conversation draft across session switches', async () => {
    await renderPage()

    await act(async () => {
      sidebarProps.onNewConversation()
    })
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('draft for new conversation'))
    })

    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)

    await act(async () => {
      sidebarProps.onNewConversation()
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('draft for new conversation'))
  })

  it.each([
    ['Cmd+N on macOS', 'darwin', { metaKey: true }],
    ['Ctrl+N on Windows', 'win32', { ctrlKey: true }]
  ])('opens a new conversation with %s', async (_label, platform, modifiers) => {
    window.api = { ...window.api, platform } as never
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'sess-a'
          ? { ...session, messages: [userMessage('prompt', 'existing conversation')] }
          : session
      )
    }))
    await renderPage()

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      bubbles: true,
      cancelable: true,
      ...modifiers
    })
    await act(async () => window.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('keeps the draft when the current conversation has no messages', async () => {
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('unsent draft'))
    })

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => window.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('unsent draft'))
  })

  it('preserves a skill chip as a structured node when switching away and back', async () => {
    await renderPage()

    const skillDoc: ComposerDoc = {
      nodes: [
        { type: 'skill', id: 'lit', name: 'Literature' },
        { type: 'text', text: ' review please' }
      ]
    }
    await act(async () => {
      conversationProps.composer.actions.changeDoc(skillDoc)
    })

    await openSession('sess-b')
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)

    // On return the chip must survive as a skill node with its id, not be flattened to `/Literature`.
    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(skillDoc)
    expect(conversationProps.composer.view.doc.nodes[0]).toEqual({
      type: 'skill',
      id: 'lit',
      name: 'Literature'
    })
  })

  it('preserves staged attachments per session without deleting files on switch', async () => {
    await renderPage()

    const attachmentA = createAttachment('att-a')
    await stageAttachment(attachmentA)
    expect(conversationProps.composer.view.attachments).toEqual([attachmentA])
    expect(claimLocalFile).toHaveBeenCalledWith({ transferId: expect.any(String) })

    // Switching away must not delete the staged file and must clear the composer for B.
    await openSession('sess-b')
    expect(conversationProps.composer.view.attachments).toEqual([])
    expect(deleteUpload).not.toHaveBeenCalled()

    const attachmentB = createAttachment('att-b')
    await stageAttachment(attachmentB)
    expect(conversationProps.composer.view.attachments).toEqual([attachmentB])

    // Returning to A restores A's own attachment; B keeps its independent attachment.
    await openSession('sess-a')
    expect(conversationProps.composer.view.attachments).toEqual([attachmentA])

    await openSession('sess-b')
    expect(conversationProps.composer.view.attachments).toEqual([attachmentB])

    expect(deleteUpload).not.toHaveBeenCalled()
  })

  it('clears the doc and attachments on a successful send without deleting staged files', async () => {
    await renderPage()

    const attachment = createAttachment('att-send')
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('send me'))
    })
    await stageAttachment(attachment)

    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'send me', attachments: [attachment] })
    )
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
    expect(conversationProps.composer.view.attachments).toEqual([])
    // The runtime consumes (moves) the staged files, so the page must not delete them itself.
    expect(deleteUpload).not.toHaveBeenCalled()
  })

  it('routes an annotation-only draft through the Workspace seam and clears it after admission', async () => {
    const admitted = createDeferred<{ sessionId: string; messageId: string }>()
    runtime.sendMessage.mockReturnValueOnce(admitted.promise)
    await renderPage()
    const annotation = createTextAnnotation()

    await act(async () => {
      expect(conversationProps.composer.actions.addAnnotation(annotation)).toBeUndefined()
    })
    expect(conversationProps.composer.view.annotations).toEqual([annotation])

    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '', annotations: [annotation] })
    )
    expect(conversationProps.conversation.optimisticMessage).toMatchObject({
      content: '',
      annotations: [annotation]
    })
    expect(conversationProps.composer.view.annotations).toEqual([annotation])

    await act(async () => {
      admitted.resolve({ sessionId: 'sess-a', messageId: 'annotation-message-1' })
      await admitted.promise
    })
    expect(conversationProps.composer.view.annotations).toEqual([])
  })

  it('routes the split-send branch action to a fresh Session snapshot instead of continuing the source', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('try a different approach'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' })
    })

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        branchSourceSessionId: 'sess-a',
        text: 'try a different approach',
        projectId: 'proj-1'
      })
    )
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
  })

  it('preserves a different draft submitted while the first send is preparing', async () => {
    const firstSend = createDeferred<{ sessionId: string; messageId: string }>()
    runtime.sendMessage.mockReturnValueOnce(firstSend.promise)
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('first prompt'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('keep this second prompt'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'first prompt' })
    )
    expect(conversationProps.composer.view.doc).toEqual(textDoc('keep this second prompt'))
    expect(conversationProps.composer.view.attachments).toEqual([])

    await act(async () => {
      firstSend.resolve({ sessionId: 'sess-a', messageId: 'm1' })
      await firstSend.promise
    })
    expect(conversationProps.composer.view.doc).toEqual(textDoc('keep this second prompt'))
  })

  it('restores a failed prepared send only to its original conversation draft', async () => {
    const failedSend = createDeferred<{ sessionId: string; messageId: string } | undefined>()
    const attachment = createAttachment('failed-send-a')
    runtime.sendMessage.mockReturnValueOnce(failedSend.promise)
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('restore to session A'))
      conversationProps.composer.actions.addAnnotation(createTextAnnotation())
    })
    await stageAttachment(attachment)
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [attachment] })
    )
    await openSession('sess-b')
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('keep session B draft'))
    })

    await act(async () => {
      failedSend.resolve(undefined)
      await failedSend.promise
    })

    expect(conversationProps.composer.view.doc).toEqual(textDoc('keep session B draft'))
    expect(conversationProps.composer.view.attachments).toEqual([])
    await openSession('sess-a')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('restore to session A'))
    expect(conversationProps.composer.view.annotations).toEqual([createTextAnnotation()])
    expect(conversationProps.composer.view.attachments).toEqual([attachment])
  })

  it('preserves a newer same-conversation draft when prepared send restoration finishes', async () => {
    const failedSend = createDeferred<{ sessionId: string; messageId: string } | undefined>()
    const firstAttachment = createAttachment('failed-send-first')
    const newerAttachment = createAttachment('failed-send-newer')
    runtime.sendMessage.mockReturnValueOnce(failedSend.promise)
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('first prompt'))
    })
    await stageAttachment(firstAttachment)
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('keep this newer prompt'))
    })
    await stageAttachment(newerAttachment)

    await act(async () => {
      failedSend.resolve(undefined)
      await failedSend.promise
    })

    expect(conversationProps.composer.view.doc).toEqual(textDoc('keep this newer prompt'))
    expect(conversationProps.composer.view.attachments).toEqual([newerAttachment])
    expect(deleteUpload).toHaveBeenCalledWith({ path: firstAttachment.path })
    expect(deleteUpload).not.toHaveBeenCalledWith({ path: newerAttachment.path })
  })

  it.each(['proj-1', 'proj-2'])(
    'identifies the owning Project in the delete modal for %s',
    async (projectId) => {
      const first = { ...useProjectStore.getState().projects[0], name: 'Alpha biology' }
      const second = { ...first, id: 'proj-2', name: 'Beta physics' }
      useProjectStore.setState({ projects: [first, second] })
      const target = { ...createSession('same-title-target', projectId), title: 'Experiment notes' }
      useSessionStore.setState((state) => ({ sessions: [...state.sessions, target] }))
      await renderPage()
      await act(async () => sidebarProps.onDeleteSession(target))
      const dialog = document.querySelector('[role="alertdialog"]')
      const projectName = projectId === 'proj-1' ? first.name : second.name
      expect(dialog?.textContent).toContain('Experiment notes')
      expect(dialog?.textContent).toContain(`Project: ${projectName}`)

      await act(async () => useNavigationStore.setState({ activeProjectId: 'proj-2' }))
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        `Project: ${projectName}`
      )
    }
  )

  it('drops a stored draft and deletes its staged files when the session is deleted', async () => {
    await renderPage()

    // Give session B an unsent draft with a staged attachment, then leave it for session A.
    await openSession('sess-b')
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('draft for B'))
    })
    const attachmentB = createAttachment('att-del')
    await stageAttachment(attachmentB)
    await openSession('sess-a')

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })

    // B's abandoned staged file is deleted and its draft entry is dropped; A stays untouched.
    expect(deleteUpload).toHaveBeenCalledWith({ path: attachmentB.path })
    expect(deleteSession).toHaveBeenCalledWith({ projectId: 'proj-1', sessionId: 'sess-b' })
    expect(conversationProps.composer.view.doc).toEqual(emptyDoc)
  })

  it('keeps project Literature accessible while session persistence is recovering', async () => {
    await renderPage(false)
    const navigate = vi.spyOn(useNavigationStore.getState(), 'openProjectLiterature')

    expect(sidebarProps.onOpenLiterature).toBeTypeOf('function')
    await act(async () => sidebarProps.onOpenLiterature!())

    expect(navigate).toHaveBeenCalledWith('proj-1', 'user')
    expect(useNavigationStore.getState().view).toBe('library')
    expect(useNavigationStore.getState().pendingLiteratureProjectId).toBe('proj-1')
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('opens Library Preview without leaving the conversation when persistence is ready', async () => {
    await renderPage()
    await act(async () => sidebarProps.onOpenLiterature!())

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(PROJECT_LIBRARY_PREVIEW_ID)
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')
  })

  it.each([
    { collectionId: 'collection-1', collectionName: 'TP53 evidence' },
    { section: 'inbox' as const }
  ])('opens the latest Library scope after restoration: %j', async (scope) => {
    const pendingLoad = createDeferred<undefined>()
    const load = vi.fn(() => pendingLoad.promise)
    window.api.preview.load = load as never
    await renderPage(false)

    act(() => {
      conversationProps.layout.onOpenLibraryMention!({})
      openLibraryPreview!(scope)
    })
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated
          isSessionPersistenceReady
          canDeleteConversations
        />
      )
    })
    expect(load).toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    await act(async () => pendingLoad.resolve(undefined))
    const preview = usePreviewWorkbenchStore.getState()
    expect(preview.activeProjectId).toBe('proj-1')
    expect(preview.activeItemId).toBe(PROJECT_LIBRARY_PREVIEW_ID)
    expect(preview.items.find((item) => item.id === PROJECT_LIBRARY_PREVIEW_ID)).toEqual(
      expect.objectContaining({
        libraryScopeRequest: scope
      })
    )
    expect(useNavigationStore.getState().view).toBe('workspace')
  })

  it('reports blocked Library activation so the mobile sidebar stays open', async () => {
    await renderPage()
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
        id: 'edited-file',
        type: 'file',
        sessionId: 'sess-a',
        title: 'notes.txt',
        source: 'artifact',
        format: 'text',
        name: 'notes.txt',
        path: '/notes.txt'
      })
    })
    const state = usePreviewWorkbenchStore.getState()
    const unregister = previewLeaveGuards.register(
      workbenchPreviewGuardScope(state.activeProjectId, state.activeItemId)!,
      () => false
    )
    try {
      await act(async () => {
        expect(sidebarProps.onOpenLiterature!()).toBe(false)
      })
      expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('edited-file')
    } finally {
      unregister()
    }
    await act(async () => {
      expect(sidebarProps.onOpenLiterature!()).toBe(true)
    })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(PROJECT_LIBRARY_PREVIEW_ID)
  })

  it('allows target-validated session deletion while other persistence is recovering', async () => {
    await renderPage(false, true)

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })

    expect(deleteSession).toHaveBeenCalledWith({ projectId: 'proj-1', sessionId: 'sess-b' })
    expect(useSessionStore.getState().sessions).not.toContainEqual(
      expect.objectContaining({ id: 'sess-b' })
    )
  })

  it('blocks interrupted-session resume while Session persistence is recovering', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'sess-a' ? { ...session, interrupted: true } : session
      )
    }))

    await renderPage(false)

    expect(conversationProps.conversation.availability.resume).toBe(false)
    await act(async () => {
      await conversationProps.conversation.actions.resume()
    })
    expect(runtime.resumeInterruptedSession).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })

    expect(conversationProps.conversation.availability.resume).toBe(true)
    await act(async () => {
      await conversationProps.conversation.actions.resume()
    })
    expect(runtime.resumeInterruptedSession).toHaveBeenCalledWith('sess-a')
  })

  it('blocks session deletion when Project deletion recovery is incomplete', async () => {
    await renderPage(false, false)

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })

    expect(sidebarProps.canDeleteConversations).toBe(false)
    expect(deleteDialogProps.session).toBeUndefined()
    expect(deleteDialogProps.canDelete).toBe(false)
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('disables an open delete dialog when Project deletion recovery becomes incomplete', async () => {
    await renderPage(false, true)

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    expect(deleteDialogProps.session?.id).toBe('sess-b')
    expect(deleteDialogProps.canDelete).toBe(true)

    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={false}
          canDeleteConversations={false}
        />
      )
    })
    expect(deleteDialogProps.session?.id).toBe('sess-b')
    expect(deleteDialogProps.canDelete).toBe(false)

    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('records explicit user takeover before starting Session deletion', async () => {
    await renderPage(false)

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })

    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    expect(deleteSession).toHaveBeenCalledWith({ projectId: 'proj-1', sessionId: 'sess-b' })
  })

  it('cancels in-flight and queued transfers before deleting their session draft', async () => {
    await renderPage()

    let rejectFirstUpload: ((reason?: unknown) => void) | undefined
    stageLocalFile.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstUpload = reject
        })
    )
    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File(['first'], 'first.txt', { type: 'text/plain' }),
        new File(['second'], 'second.txt', { type: 'text/plain' })
      ])
      await Promise.resolve()
    })

    const transferIds = conversationProps.composer.view.transfers.map(
      ({ transferId }) => transferId
    )
    expect(transferIds).toHaveLength(2)
    expect(stageLocalFile).toHaveBeenCalledTimes(1)

    const sessionA = useSessionStore.getState().sessions.find((session) => session.id === 'sess-a')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionA)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
      await Promise.resolve()
    })

    for (const transferId of transferIds) {
      expect(abortTransfer).toHaveBeenCalledWith({ transferId })
    }

    await act(async () => {
      rejectFirstUpload?.(new Error('Upload cancelled'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stageLocalFile).toHaveBeenCalledTimes(1)
  })

  it('deletes an attachment that finishes while active-session deletion is pending', async () => {
    await renderPage()

    // Returning to A leaves an inactive-draft snapshot in composerDraftsRef; active live state must
    // win over that older snapshot when deletion eventually succeeds.
    await openSession('sess-b')
    await openSession('sess-a')

    const attachment = createAttachment('att-finished-during-delete')
    let finishUpload: ((value: UploadedAttachment) => void) | undefined
    stageLocalFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve
        })
    )
    let finishDeletion: (() => void) | undefined
    deleteSession.mockImplementationOnce(
      ({ sessionId }: { sessionId: string }) =>
        new Promise((resolve) => {
          finishDeletion = () => {
            useSessionStore.getState().deleteSession(sessionId)
            resolve({ status: 'deleted', runtimeDetached: true })
          }
        })
    )

    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File(['data'], 'late.txt', { type: 'text/plain' })
      ])
      await Promise.resolve()
    })

    const sessionA = useSessionStore.getState().sessions.find((session) => session.id === 'sess-a')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionA)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
      await Promise.resolve()
    })

    await act(async () => {
      finishUpload?.(attachment)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(conversationProps.composer.view.attachments).toEqual([attachment])

    await act(async () => {
      finishDeletion?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
  })

  it('deletes a staged attachment when deletion settles before the upload continuation', async () => {
    await renderPage()

    const attachment = createAttachment('att-resolved-before-continuation')
    let finishUpload: ((value: UploadedAttachment) => void) | undefined
    stageLocalFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve
        })
    )
    let finishDeletion: (() => void) | undefined
    deleteSession.mockImplementationOnce(
      ({ sessionId }: { sessionId: string }) =>
        new Promise((resolve) => {
          finishDeletion = () => {
            useSessionStore.getState().deleteSession(sessionId)
            resolve({ status: 'deleted', runtimeDetached: true })
          }
        })
    )

    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File(['data'], 'late-continuation.txt', { type: 'text/plain' })
      ])
      await Promise.resolve()
    })
    const sessionA = useSessionStore.getState().sessions.find((session) => session.id === 'sess-a')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionA)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
      await Promise.resolve()
    })

    await act(async () => {
      // Resolving in this order queues the upload's inner continuation, then deletion. Deletion
      // aborts the controller before WorkspacePage receives the staged attachment.
      finishUpload?.(attachment)
      finishDeletion?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
  })

  it('ignores a duplicate deletion request while the same session deletion is pending', async () => {
    await renderPage()

    const finishDeletions: Array<
      (result: { status: 'failed'; reason: 'runtime'; runtimeDetached: false }) => void
    > = []
    deleteSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDeletions.push(resolve)
        })
    )
    const sessionA = useSessionStore.getState().sessions.find((session) => session.id === 'sess-a')!

    await act(async () => {
      sidebarProps.onDeleteSession(sessionA)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
      await Promise.resolve()
    })
    await act(async () => {
      sidebarProps.onDeleteSession(sessionA)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
      await Promise.resolve()
    })

    expect(deleteSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishDeletions[0]?.({
        status: 'failed',
        reason: 'runtime',
        runtimeDetached: false
      })
      await Promise.resolve()
    })
  })

  it('keeps a stored draft and its staged files when session deletion fails', async () => {
    await renderPage()

    await openSession('sess-b')
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('keep draft B'))
    })
    const attachmentB = createAttachment('att-keep')
    await stageAttachment(attachmentB)
    await openSession('sess-a')
    deleteSession.mockResolvedValueOnce({
      status: 'failed',
      reason: 'runtime',
      runtimeDetached: false
    })

    const sessionB = useSessionStore.getState().sessions.find((session) => session.id === 'sess-b')!
    await act(async () => {
      sidebarProps.onDeleteSession(sessionB)
    })
    await act(async () => {
      deleteDialogProps.onConfirmDelete()
    })

    expect(deleteUpload).not.toHaveBeenCalled()
    expect(deleteDialogProps).toMatchObject({
      session: { id: 'sess-b' },
      isDeleting: false,
      error: 'runtime'
    })
    await openSession('sess-b')
    expect(conversationProps.composer.view.doc).toEqual(textDoc('keep draft B'))
    expect(conversationProps.composer.view.attachments).toEqual([attachmentB])
  })
})

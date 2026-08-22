// @vitest-environment jsdom
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
import { useSettingsStore } from '@/stores/settings-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'
import { setDefaultWorkspaceAgentSettings } from './workspace-page-test-fixtures'

// Capture the props passed to the heavy child components so the test can drive selection and drafts.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]
let sidebarProps: {
  canDeleteConversations: boolean
  onOpenSession: (id: string) => void
  onNewConversation: () => void
  onDownloadArtifacts: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
}
let downloadArtifactsDialogProps: {
  session: ChatSession | undefined
  onClose: () => void
}
let deleteDialogProps: {
  session: ChatSession | undefined
  canDelete: boolean
  isDeleting?: boolean
  error?: 'runtime' | 'persistence'
  onConfirmDelete: () => void
}

// The runtime bridge is stubbed; sendMessage resolves truthy so the success path clears the composer.
const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancelRun: vi.fn(),
  resumeInterruptedSession: vi.fn(),
  respondToPermission: vi.fn()
}))
const deleteSession = vi.hoisted(() => vi.fn())

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
    return <aside />
  }
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
  DeleteSessionDialog: (props: typeof deleteDialogProps): React.JSX.Element => {
    deleteDialogProps = props
    return <div />
  }
}))

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

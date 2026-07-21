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
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'

import { emptyDoc, type ComposerDoc } from './composer/composer-doc'

// Capture the props passed to the heavy child components so the test can drive selection and drafts.
let conversationProps: {
  draftDoc: ComposerDoc
  attachments: UploadedAttachment[]
  onDraftDocChange: (doc: ComposerDoc) => void
  onSendMessage: (forcedSkillIds: string[]) => void
  onStageAttachmentFiles: (files: File[]) => void
}
let sidebarProps: {
  onOpenSession: (id: string) => void
  onNewConversation: () => void
  onDeleteSession: (session: ChatSession) => void
}
let deleteDialogProps: { session: ChatSession | undefined; onConfirmDelete: () => void }

// The runtime bridge is stubbed; sendMessage resolves truthy so the success path clears the composer.
const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
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
    cancelRun: runtime.cancelRun,
    deleteRuntimeSession: runtime.deleteRuntimeSession,
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

const deleteUpload = vi.fn(() => Promise.resolve())
const stageFiles = vi.fn()

describe('WorkspacePage draft preservation', () => {
  let container: HTMLDivElement
  let root: Root
  let originalFileReader: typeof FileReader

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession('sess-a', 'proj-1'), createSession('sess-b', 'proj-1')],
      selectedSessionId: 'sess-a'
    })
    vi.clearAllMocks()
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'm1' })
    runtime.deleteRuntimeSession.mockImplementation((id: string) => {
      useSessionStore.getState().deleteSession(id)
      return Promise.resolve()
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
        stageFiles
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

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspacePage isSessionPersistenceReady={true} />)
    })
  }

  // Drives the composer's real staging pipeline so a per-session attachment lands in page state.
  const stageAttachment = async (attachment: UploadedAttachment): Promise<void> => {
    stageFiles.mockResolvedValueOnce([attachment])
    await act(async () => {
      conversationProps.onStageAttachmentFiles([
        new File(['data'], `${attachment.id}.txt`, { type: 'text/plain' })
      ])
    })
  }

  const openSession = async (id: string): Promise<void> => {
    await act(async () => {
      sidebarProps.onOpenSession(id)
    })
  }

  it('preserves each session doc independently when switching away and back', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('draft for A'))
    })
    expect(conversationProps.draftDoc).toEqual(textDoc('draft for A'))

    // Switching to session B clears the composer to B's own (empty) doc.
    await openSession('sess-b')
    expect(conversationProps.draftDoc).toEqual(emptyDoc)

    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('draft for B'))
    })

    // Switching back to session A restores A's doc, and B keeps its own.
    await openSession('sess-a')
    expect(conversationProps.draftDoc).toEqual(textDoc('draft for A'))

    await openSession('sess-b')
    expect(conversationProps.draftDoc).toEqual(textDoc('draft for B'))
  })

  it('preserves the new-conversation draft across session switches', async () => {
    await renderPage()

    await act(async () => {
      sidebarProps.onNewConversation()
    })
    expect(conversationProps.draftDoc).toEqual(emptyDoc)
    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('draft for new conversation'))
    })

    await openSession('sess-a')
    expect(conversationProps.draftDoc).toEqual(emptyDoc)

    await act(async () => {
      sidebarProps.onNewConversation()
    })
    expect(conversationProps.draftDoc).toEqual(textDoc('draft for new conversation'))
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
      conversationProps.onDraftDocChange(skillDoc)
    })

    await openSession('sess-b')
    expect(conversationProps.draftDoc).toEqual(emptyDoc)

    // On return the chip must survive as a skill node with its id, not be flattened to `/Literature`.
    await openSession('sess-a')
    expect(conversationProps.draftDoc).toEqual(skillDoc)
    expect(conversationProps.draftDoc.nodes[0]).toEqual({
      type: 'skill',
      id: 'lit',
      name: 'Literature'
    })
  })

  it('preserves staged attachments per session without deleting files on switch', async () => {
    await renderPage()

    const attachmentA = createAttachment('att-a')
    await stageAttachment(attachmentA)
    expect(conversationProps.attachments).toEqual([attachmentA])

    // Switching away must not delete the staged file and must clear the composer for B.
    await openSession('sess-b')
    expect(conversationProps.attachments).toEqual([])
    expect(deleteUpload).not.toHaveBeenCalled()

    const attachmentB = createAttachment('att-b')
    await stageAttachment(attachmentB)
    expect(conversationProps.attachments).toEqual([attachmentB])

    // Returning to A restores A's own attachment; B keeps its independent attachment.
    await openSession('sess-a')
    expect(conversationProps.attachments).toEqual([attachmentA])

    await openSession('sess-b')
    expect(conversationProps.attachments).toEqual([attachmentB])

    expect(deleteUpload).not.toHaveBeenCalled()
  })

  it('clears the doc and attachments on a successful send without deleting staged files', async () => {
    await renderPage()

    const attachment = createAttachment('att-send')
    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('send me'))
    })
    await stageAttachment(attachment)

    await act(async () => {
      conversationProps.onSendMessage([])
    })

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'send me', attachments: [attachment] })
    )
    expect(conversationProps.draftDoc).toEqual(emptyDoc)
    expect(conversationProps.attachments).toEqual([])
    // The runtime consumes (moves) the staged files, so the page must not delete them itself.
    expect(deleteUpload).not.toHaveBeenCalled()
  })

  it('drops a stored draft and deletes its staged files when the session is deleted', async () => {
    await renderPage()

    // Give session B an unsent draft with a staged attachment, then leave it for session A.
    await openSession('sess-b')
    await act(async () => {
      conversationProps.onDraftDocChange(textDoc('draft for B'))
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
    expect(runtime.deleteRuntimeSession).toHaveBeenCalledWith('sess-b')
    expect(conversationProps.draftDoc).toEqual(emptyDoc)
  })
})

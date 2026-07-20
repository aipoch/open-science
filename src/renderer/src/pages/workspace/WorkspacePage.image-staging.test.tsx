// @vitest-environment jsdom
// Pins how WorkspacePage gates image attachments on the active provider's supportsImageInput flag,
// in both the staging path (onStageAttachmentFiles) and the final send path (onSendMessage).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

// Opt into React's act environment so state flushes deterministically between waitFor polls.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { ProviderView } from '../../../../shared/settings'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'

// Capture the ConversationPanel props the page computes on each render.
let conversationProps: {
  attachments: UploadedAttachment[]
  actionError: string | null
  canSendMessage: boolean
  onStageAttachmentFiles: (files: File[]) => void
  onSendMessage: (forcedSkillIds: string[]) => void
}

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

const stageFiles = vi.hoisted(() => vi.fn())

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

vi.mock('./RenameSessionDialog', () => ({ RenameSessionDialog: (): React.JSX.Element => <div /> }))
vi.mock('./DeleteSessionDialog', () => ({ DeleteSessionDialog: (): React.JSX.Element => <div /> }))
vi.mock('./SessionNotebookDialog', () => ({
  SessionNotebookDialog: (): React.JSX.Element => <div />
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

const createProvider = (supportsImageInput: boolean): ProviderView => ({
  id: 'prov-1',
  type: 'custom',
  name: 'Test Provider',
  supportsImageInput,
  models: ['test-model'],
  hasKey: true,
  needsKey: false
})

const imageFile = (): File =>
  new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })

const IMAGE_BLOCKED_MESSAGE = 'The selected model is not configured for image input.'

describe('WorkspacePage image attachment gating', () => {
  let container: HTMLDivElement
  let root: Root
  let originalFileReader: typeof FileReader

  const setActiveProviderImageSupport = (supportsImageInput: boolean): void => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      activeProviderId: 'prov-1',
      providers: [createProvider(supportsImageInput)]
    })
  }

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    vi.clearAllMocks()

    // A deterministic FileReader keeps the async staging pipeline on the microtask queue so state
    // updates flush inside act(); the real reader fires onload on a macrotask, which left the prior
    // fixed-tick waits racing the FileReader + upload IPC + re-render (the source of the flakiness).
    originalFileReader = globalThis.FileReader
    class MockFileReader {
      result = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.result = 'data:image/png;base64,AQID'
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
      uploads: { deleteUpload: vi.fn(), stageFiles },
      reviewer: {
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      }
    } as never

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    globalThis.FileReader = originalFileReader
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspacePage isSessionPersistenceReady={true} />)
    })
  }

  it('stages and sends an image when the active model supports image input', async () => {
    setActiveProviderImageSupport(true)
    const staged: UploadedAttachment = {
      id: 'att-1',
      sessionId: '.pending',
      name: 'pic.png',
      originalName: 'pic.png',
      path: '/uploads/pic.png',
      mimeType: 'image/png',
      size: 3
    }
    stageFiles.mockResolvedValue([staged])
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a' })

    await renderPage()

    await act(async () => {
      conversationProps.onStageAttachmentFiles([imageFile()])
    })

    // The image is read (FileReader) and forwarded to the upload IPC, then surfaced as a composer
    // attachment — wait on that observable state instead of a fixed tick so the async pipeline settles.
    await act(async () => {
      await vi.waitFor(() => {
        expect(stageFiles).toHaveBeenCalledTimes(1)
        expect(conversationProps.attachments).toEqual([staged])
      })
    })
    expect(conversationProps.actionError).toBeNull()
    expect(conversationProps.canSendMessage).toBe(true)

    // Sending forwards the staged image attachment to the runtime bridge.
    await act(async () => {
      conversationProps.onSendMessage([])
    })
    await act(async () => {
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1))
    })
    expect(runtime.sendMessage.mock.calls[0][0].attachments).toEqual([staged])
  })

  it('blocks staging an image when the active model does not support image input', async () => {
    setActiveProviderImageSupport(false)

    await renderPage()

    // The guard rejects the batch before any read/upload happens and surfaces the reason.
    await act(async () => {
      conversationProps.onStageAttachmentFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.actionError).toBe(IMAGE_BLOCKED_MESSAGE))
    })
    expect(stageFiles).not.toHaveBeenCalled()
    expect(conversationProps.attachments).toEqual([])
  })

  it('blocks sending a previously staged image after the model loses image support', async () => {
    // Stage while the model supports images so the attachment lands in composer state...
    setActiveProviderImageSupport(true)
    const staged: UploadedAttachment = {
      id: 'att-2',
      sessionId: '.pending',
      name: 'pic.png',
      originalName: 'pic.png',
      path: '/uploads/pic.png',
      mimeType: 'image/png',
      size: 3
    }
    stageFiles.mockResolvedValue([staged])

    await renderPage()

    await act(async () => {
      conversationProps.onStageAttachmentFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.attachments).toEqual([staged]))
    })

    // ...then switch to a model without image support and attempt to send.
    await act(async () => {
      setActiveProviderImageSupport(false)
    })

    // The send-path guard blocks the image and never reaches the runtime bridge.
    await act(async () => {
      conversationProps.onSendMessage([])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.actionError).toBe(IMAGE_BLOCKED_MESSAGE))
    })
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })
})

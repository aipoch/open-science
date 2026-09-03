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
import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
import { usePdfContextAction } from './use-pdf-context-action'
import { markWorkspaceReviewHistoryLoaded } from './workspace-page-test-fixtures'

// Capture the ConversationPanel props the page computes on each render.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

const stageLocalFile = vi.hoisted(() => vi.fn())

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

vi.mock('./EditSessionDialog', () => ({ EditSessionDialog: (): React.JSX.Element => <div /> }))
vi.mock('./DeleteSessionDialog', () => ({ DeleteSessionDialog: (): React.JSX.Element => <div /> }))
vi.mock('./SessionNotebookDialog', () => ({
  SessionNotebookDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

// Renders the shared link action for a preview item exactly as the header pill and tab menu do.
const PdfContextActionProbe = ({ itemId }: { itemId: string }): React.JSX.Element => {
  const item = usePreviewWorkbenchStore((state) =>
    state.items.find((candidate) => candidate.id === itemId)
  )
  const { action } = usePdfContextAction(item?.type === 'file' ? item : undefined)
  return (
    <button
      type="button"
      data-testid="pdf-context-action-probe"
      data-state={action?.state ?? 'none'}
      disabled={action?.disabled}
      onClick={() => action?.run()}
    >
      {action?.label ?? 'none'}
    </button>
  )
}

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

const pdfFile = (name = 'paper.pdf'): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' })

const IMAGE_BLOCKED_MESSAGE = VISION_MODEL_NOT_CONFIGURED_MESSAGE

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
    markWorkspaceReviewHistoryLoaded({ projectId: 'proj-1', sessionId: 'sess-a' })
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
      acp: { getPlanProjection: vi.fn(() => Promise.resolve(null)) },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: {
        stageLocalFile,
        beginTransfer: vi.fn(),
        appendTransfer: vi.fn(),
        getTransferStatus: vi.fn(),
        finishTransfer: vi.fn(),
        abortTransfer: vi.fn(() => Promise.resolve()),
        deleteUpload: vi.fn(() => Promise.resolve()),
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
    stageLocalFile.mockResolvedValue(staged)
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a' })

    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.stageFiles([imageFile()])
    })

    // The image takes the native-path upload adapter and then surfaces as a composer attachment.
    await act(async () => {
      await vi.waitFor(() => {
        expect(stageLocalFile).toHaveBeenCalledTimes(1)
        expect(conversationProps.composer.view.attachments).toEqual([staged])
      })
    })
    expect(conversationProps.view.actionError).toBeNull()
    expect(conversationProps.conversation.availability.submit).toBe(true)

    // Sending forwards the staged image attachment to the runtime bridge.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
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
      conversationProps.composer.actions.stageFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.view.actionError).toBe(IMAGE_BLOCKED_MESSAGE))
    })
    expect(stageLocalFile).not.toHaveBeenCalled()
    expect(conversationProps.composer.view.attachments).toEqual([])
  })

  it('blocks a raster image with missing MIME before staging starts', async () => {
    setActiveProviderImageSupport(false)

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File([new Uint8Array([1, 2, 3])], 'pic.png')
      ])
    })

    expect(conversationProps.view.actionError).toBe(IMAGE_BLOCKED_MESSAGE)
    expect(stageLocalFile).not.toHaveBeenCalled()
  })

  it('stages and sends SVG as an ordinary file without image input support', async () => {
    setActiveProviderImageSupport(false)
    const staged: UploadedAttachment = {
      id: 'att-svg',
      sessionId: '.pending',
      name: 'diagram.svg',
      originalName: 'diagram.svg',
      path: '/uploads/diagram.svg',
      mimeType: 'image/svg+xml',
      size: 3
    }
    stageLocalFile.mockResolvedValue(staged)
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a' })

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        new File([new Uint8Array([1, 2, 3])], 'diagram.svg', { type: 'image/svg+xml' })
      ])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toEqual([staged]))
    })

    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    await act(async () => {
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1))
    })
    expect(runtime.sendMessage.mock.calls[0][0].attachments).toEqual([staged])
  })

  it('stages and sends an image through a configured Vision model', async () => {
    setActiveProviderImageSupport(false)
    useSettingsStore.setState((state) => ({
      providers: [
        ...state.providers,
        {
          ...createProvider(true),
          id: 'vision-provider',
          name: 'Vision Provider',
          models: ['vision-model']
        }
      ],
      visionModel: {
        providerId: 'vision-provider',
        model: 'vision-model',
        reasoningEffort: 'default'
      }
    }))
    const staged: UploadedAttachment = {
      id: 'att-relay',
      sessionId: '.pending',
      name: 'pic.png',
      originalName: 'pic.png',
      path: '/uploads/pic.png',
      mimeType: 'image/png',
      size: 3
    }
    stageLocalFile.mockResolvedValue(staged)
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a' })

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toEqual([staged]))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    await act(async () => {
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1))
    })
    expect(runtime.sendMessage.mock.calls[0][0].attachments).toEqual([staged])
  })

  it('keeps image staging blocked when the configured Vision model is unavailable', async () => {
    setActiveProviderImageSupport(false)
    useSettingsStore.setState({
      visionModel: {
        providerId: 'removed-provider',
        model: 'vision-model',
        reasoningEffort: 'default'
      }
    })

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.view.actionError).toBe(IMAGE_BLOCKED_MESSAGE))
    })
    expect(stageLocalFile).not.toHaveBeenCalled()
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
    stageLocalFile.mockResolvedValue(staged)

    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.stageFiles([imageFile()])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toEqual([staged]))
    })

    // ...then switch to a model without image support and attempt to send.
    await act(async () => {
      setActiveProviderImageSupport(false)
    })

    // The send-path guard blocks the image and never reaches the runtime bridge.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.view.actionError).toBe(IMAGE_BLOCKED_MESSAGE))
    })
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps one to three staged PDFs as ordinary attachments until the first send', async () => {
    setActiveProviderImageSupport(false)
    useSessionStore.setState(createInitialSessionState())
    const staged = ['paper-a.pdf', 'paper-b.pdf', 'paper-c.pdf'].map((name, index) => ({
      id: `pdf-${index + 1}`,
      sessionId: '.pending',
      name,
      originalName: name,
      path: `/uploads/.pending/${name}`,
      mimeType: 'application/pdf',
      size: 3
    })) satisfies UploadedAttachment[]
    staged.forEach((attachment) => stageLocalFile.mockResolvedValueOnce(attachment))

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([
        pdfFile('paper-a.pdf'),
        pdfFile('paper-b.pdf'),
        pdfFile('paper-c.pdf')
      ])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toHaveLength(3))
    })

    const preview = usePreviewWorkbenchStore.getState()
    expect(preview.items).toEqual([])
    expect(preview.activeItemId).toBeUndefined()
    expect(preview.panelState).toBe('collapsed')
    expect(preview.pendingPdfContextByProject['proj-1']).toBeUndefined()
    expect(conversationProps.composer.view.readingContext.bindings).toEqual([])
  })

  it('keeps a manually picked pending PDF context when PDFs are staged', async () => {
    setActiveProviderImageSupport(false)
    useSessionStore.setState(createInitialSessionState())
    const manualSelection = {
      kind: 'version' as const,
      sourceKind: 'artifact-version' as const,
      sourceFileId: 'artifact-9',
      sourceVersionId: 'version-9',
      previewItemId: 'other-preview'
    }
    usePreviewWorkbenchStore.setState({
      pendingPdfContextByProject: { 'proj-1': manualSelection }
    })
    stageLocalFile.mockResolvedValueOnce({
      id: 'pdf-1',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    } satisfies UploadedAttachment)

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([pdfFile('paper.pdf')])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toHaveLength(1))
    })

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['proj-1']).toEqual(
      manualSelection
    )
  })

  it('does not auto-link staged PDFs while a Session is active', async () => {
    setActiveProviderImageSupport(false)
    stageLocalFile.mockResolvedValueOnce({
      id: 'pdf-1',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    } satisfies UploadedAttachment)

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.stageFiles([pdfFile('paper.pdf')])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toHaveLength(1))
    })

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['proj-1']).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('allows explicitly linking a staged PDF from the preview surface', async () => {
    setActiveProviderImageSupport(false)
    useSessionStore.setState(createInitialSessionState())
    stageLocalFile.mockResolvedValueOnce({
      id: 'current-pdf',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    } satisfies UploadedAttachment)

    await renderPage()
    act(() => {
      usePreviewWorkbenchStore.getState().upsertItem({
        id: 'upload:stale-pdf',
        type: 'file',
        source: 'upload',
        projectId: 'proj-1',
        sessionId: '.pending',
        title: 'paper.pdf',
        name: 'paper.pdf',
        path: '/uploads/.pending/stale-pdf/paper.pdf',
        format: 'pdf',
        mimeType: 'application/pdf'
      })
    })
    await act(async () => {
      conversationProps.composer.actions.stageFiles([pdfFile('paper.pdf')])
    })
    await act(async () => {
      await vi.waitFor(() => expect(conversationProps.composer.view.attachments).toHaveLength(1))
    })

    act(() => {
      usePreviewWorkbenchStore.getState().upsertItem({
        id: 'upload:current-pdf',
        type: 'file',
        source: 'upload',
        projectId: 'proj-1',
        sessionId: '.pending',
        title: 'paper.pdf',
        name: 'paper.pdf',
        path: '/uploads/.pending/paper.pdf',
        format: 'pdf',
        mimeType: 'application/pdf'
      })
    })
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['proj-1']).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().draftStagedUploadIds).toEqual(['current-pdf'])

    // The attached upload's preview tab offers the link action — enabled. A stale
    // same-named preview item must remain unavailable instead of borrowing the current attachment.
    const probeContainer = document.createElement('div')
    document.body.appendChild(probeContainer)
    const probeRoot = createRoot(probeContainer)
    await act(async () => {
      probeRoot.render(
        <>
          <PdfContextActionProbe itemId="upload:current-pdf" />
          <PdfContextActionProbe itemId="upload:stale-pdf" />
        </>
      )
    })
    const [currentProbe, staleProbe] = probeContainer.querySelectorAll<HTMLButtonElement>(
      '[data-testid="pdf-context-action-probe"]'
    )
    expect(currentProbe?.dataset.state).toBe('link')
    expect(currentProbe?.disabled).toBe(false)
    expect(staleProbe?.dataset.state).toBe('link')
    expect(staleProbe?.disabled).toBe(true)

    // And running it re-establishes the pending draft selection.
    await act(async () => currentProbe?.click())
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['proj-1']).toEqual({
      kind: 'staged-upload',
      attachmentId: 'current-pdf',
      previewItemId: 'upload:current-pdf'
    })

    await act(async () => {
      probeRoot.unmount()
    })
    probeContainer.remove()
  })
})

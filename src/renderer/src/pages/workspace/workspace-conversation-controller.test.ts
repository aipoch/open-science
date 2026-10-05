// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  projectSessionActionability,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import type { TextAnnotation } from '../../../../shared/annotations'

import type { ComposerDoc } from './composer/composer-doc'
import { useWorkspaceComposerController } from './workspace-composer-controller'
import { WorkspaceComposerDraftsProvider } from './workspace-composer-drafts'
import {
  useWorkspaceConversationController,
  type WorkspaceConversationController,
  type WorkspaceConversationControllerOptions
} from './workspace-conversation-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const quotedAnnotation = (): TextAnnotation => ({
  id: 'annotation-side-chat',
  kind: 'text',
  target: 'agent',
  quote: 'The confidence intervals overlap.',
  note: 'Explain this caveat.',
  source: { kind: 'agent-message', sessionId: 'session-a', messageId: 'agent-message-a' }
})

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-a',
  projectId: 'project-a',
  title: 'Session A',
  cwd: '/workspace/project-a',
  status: 'idle',
  permissionProfile: 'full',
  messages: [
    {
      id: 'message-user-a',
      role: 'user',
      content: 'First main prompt',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const runningSession = (): ChatSession =>
  session({
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
          activeBranchId: 'branch-a',
          createdAt: 1
        }
      ],
      branches: [
        {
          id: 'branch-a',
          agentFrameId: 'root',
          headMessageId: 'message-user-a',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      messages: session().messages.map((message) => ({
        ...message,
        agentFrameId: 'root',
        introducedOnBranchId: 'branch-a'
      })),
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    }
  })

const options = (
  overrides: Partial<WorkspaceConversationControllerOptions> = {}
): WorkspaceConversationControllerOptions => {
  const doc = textDoc('hello')
  const activeSession = overrides.activeSession ?? session()
  return {
    activeSession,
    projectId: 'project-a',
    currentDraftKey: 'session-a',
    persistenceBlockedSessionIds: [],
    isPersistenceReady: true,
    supportsImageInput: true,
    agentConfiguration: {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'medium'
    },
    agentConfigurationReady: true,
    permissionProfile: 'full',
    isReviewing: false,
    isTurnAdmissionBlocked: false,
    promptInFlightSessionIds: [],
    sendPreparationInFlightSessionIds: [],
    saveAsSkillInFlightSessionIds: [],
    actionability: projectSessionActionability(activeSession),
    hasPendingPermissionRequest: vi.fn(() => false),
    newConversationAutoReviewEnabled: false,
    newConversationEnabledComputeHosts: [],
    composer: {
      view: {
        doc,
        annotations: [],
        attachments: [],
        transfers: [],
        readingContext: {
          bindings: [],
          pendingBindingId: undefined,
          isPending: false,
          automaticAttachments: [],
          automaticAttachmentCount: 0
        }
      },
      actions: { setError: vi.fn() },
      lifecycle: {
        captureSend: vi.fn(() => ({
          draftKey: 'session-a',
          version: 1,
          doc,
          annotations: [],
          attachments: []
        })),
        preserveAdmissionContext: vi.fn(),
        bindAdmissionContext: vi.fn(),
        captureRevision: vi.fn((revisionDoc, annotations) => ({
          draftKey: 'session-a',
          version: 1,
          doc: revisionDoc,
          annotations,
          attachments: []
        })),
        clearDraft: vi.fn(),
        restoreFailedSend: vi.fn(() => true),
        discardSnapshot: vi.fn()
      }
    },
    session: {
      view: {
        deletingIds: new Set(),
        specialist: { barrierInFlight: false, sendAvailable: true }
      },
      actions: {
        beginReconfigureRetry: vi.fn(() => true),
        resetNewConversationSpecialist: vi.fn(),
        confirmDelete: vi.fn()
      },
      lifecycle: {
        canStartSend: vi.fn(() => true),
        captureSendIntent: vi.fn(() => ({
          draftSpecialistId: undefined,
          hasPendingSwitch: false,
          pendingSpecialistId: undefined
        })),
        prepareSpecialistSend: vi.fn(() => Promise.resolve(true)),
        isBarrierInFlight: vi.fn(() => false)
      }
    },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({ sessionId: 'session-a', messageId: 'message-a' })),
      resendEditedMessage: vi.fn(() => Promise.resolve(true)),
      cancelRun: vi.fn(() => Promise.resolve()),
      resumeInterruptedSession: vi.fn(() => Promise.resolve()),
      ensureSessionReady: vi.fn(() => Promise.resolve())
    },
    sideChatOpen: false,
    resetNewConversationSettings: vi.fn(),
    abortFixLoop: vi.fn(() => Promise.resolve()),
    getSession: (sessionId) => (sessionId === 'session-a' ? session() : undefined),
    subscribeSessionChanges: () => () => undefined,
    onSessionSizeLimit: vi.fn(),
    ...overrides
  }
}

type Hook = {
  result: { current: WorkspaceConversationController }
  rerender: (next: WorkspaceConversationControllerOptions) => void
  unmount: () => void
}

const renderController = (initial: WorkspaceConversationControllerOptions): Hook => {
  let current = initial
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  const result = { current: undefined as unknown as WorkspaceConversationController }
  const Harness = (): null => {
    result.current = useWorkspaceConversationController(current)
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  render()
  return {
    result,
    rerender: (next): void => {
      current = next
      render()
    },
    unmount: (): void => act(() => root.unmount())
  }
}

const mounted: Hook[] = []

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount()
  vi.restoreAllMocks()
})

describe('workspace conversation controller', () => {
  it.each([
    ['claude-code', 'claude-code', 'claude-code:anthropic'],
    ['opencode', 'opencode', 'opencode:provider-1'],
    ['codebuddy', 'codebuddy', 'codebuddy:provider-1'],
    ['codex-response', 'codex', 'codex:responses-provider'],
    ['codex-bridge', 'codex', 'codex:bridge-provider']
  ] as const)(
    'allows a new message after a failed initial session connection (%s)',
    async (_path, agentFrameworkId, agentBackendId) => {
      const failedSession = session({
        status: 'error',
        isPending: true,
        agentFrameworkId,
        agentBackendId,
        error: 'Agent startup failed'
      })
      const input = options({
        activeSession: failedSession,
        actionability: projectSessionActionability(failedSession)
      })
      const hook = renderController(input)
      mounted.push(hook)

      expect(hook.result.current.availability.submit).toBe(true)
      await act(async () => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
      expect(input.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: failedSession.id, text: 'hello' })
      )
    }
  )

  it('admits and sends a structured annotation without message text', async () => {
    const annotation = {
      id: 'annotation-1',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted Agent response',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-a',
        messageId: 'agent-message-a'
      }
    }
    const input = options()
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    input.runtime.sendMessage = vi.fn(
      () =>
        new Promise<{ sessionId: string; messageId: string }>((resolve) => {
          resolveAdmission = resolve
        })
    )
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 1,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: [],
      pdfReadingPosition: { pageNumber: 2, pageCount: 14 },
      pdfReadingPositionSource: {
        sourceKind: 'artifact-version' as const,
        sourceVersionId: 'version-1'
      }
    }))
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.submit).toBe(true)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '',
        annotations: [annotation],
        pdfReadingPosition: { pageNumber: 2, pageCount: 14 },
        pdfReadingPositionSource: { sourceKind: 'artifact-version', sourceVersionId: 'version-1' }
      })
    )
    expect(hook.result.current.optimisticMessage).toMatchObject({
      content: '',
      annotations: [annotation]
    })
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()

    await act(async () =>
      resolveAdmission({ sessionId: 'session-a', messageId: 'annotation-message-1' })
    )
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
  })

  it('blocks an image-point annotation before capture when the model cannot read images', () => {
    const input = options()
    const annotation = {
      id: 'point-1',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this point',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-1',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-1',
        mimeType: 'image/png'
      },
      point: { x: 0.5, y: 0.5 },
      naturalSize: { width: 100, height: 100 }
    }
    input.supportsImageInput = false
    input.composer.view.annotations = [annotation]
    const hook = renderController(input)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    )
    expect(input.composer.lifecycle.captureSend).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('sends an annotation-only New Conversation to the current project without a Session id', async () => {
    const annotation = {
      id: 'new-conversation-annotation',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted project evidence',
      source: {
        kind: 'project-file' as const,
        projectId: 'project-a',
        path: 'results/report.md',
        versionId: 'version-a'
      }
    }
    const input = options({
      activeSession: undefined,
      currentDraftKey: 'new:project-a'
    })
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'new:project-a',
      version: 3,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        projectId: 'project-a',
        text: '',
        annotations: [annotation]
      })
    )
    await vi.waitFor(() =>
      expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('new:project-a', 3)
    )
  })

  it.each(['success', 'undefined', 'rejection'])(
    'admits a distinct new draft and keeps its guard after the earlier send settles with %s',
    async (outcome) => {
      const first = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
      first.composer.lifecycle.captureSend = vi.fn(() => ({
        draftKey: 'new:project-a',
        version: 1,
        doc: textDoc('first'),
        annotations: [],
        attachments: []
      }))
      let finish!: (value: { sessionId: string; messageId: string } | undefined) => void
      let fail!: (error: Error) => void
      first.runtime.sendMessage = vi.fn<
        WorkspaceConversationControllerOptions['runtime']['sendMessage']
      >(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve
            fail = reject
          })
      )
      const hook = renderController(first)
      mounted.push(hook)
      act(() => {
        hook.result.current.actions.submit.draft({ forcedSkillIds: [] })
        hook.result.current.actions.submit.draft({ forcedSkillIds: [] })
      })
      expect(first.runtime.sendMessage).toHaveBeenCalledOnce()
      const second = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
      second.composer.lifecycle.captureSend = vi.fn(() => ({
        draftKey: 'new:project-a',
        version: 2,
        doc: textDoc('second'),
        annotations: [],
        attachments: []
      }))
      second.runtime.sendMessage = vi.fn<
        WorkspaceConversationControllerOptions['runtime']['sendMessage']
      >(() => new Promise(() => undefined))
      hook.rerender(second)
      act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
      expect(second.runtime.sendMessage).toHaveBeenCalledOnce()
      await act(async () => {
        if (outcome === 'rejection') fail(new Error('preparation failed'))
        else
          finish(
            outcome === 'success'
              ? { sessionId: 'first-session', messageId: 'first-message' }
              : undefined
          )
      })
      act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
      expect(second.runtime.sendMessage).toHaveBeenCalledOnce()
    }
  )

  it('restores an inactive failed Session draft without showing its error on another Session', async () => {
    const input = options()
    let rejected:
      | NonNullable<Parameters<typeof input.runtime.sendMessage>[0]['onPreparationRejected']>
      | undefined
    input.runtime.sendMessage = vi.fn(async (request) => {
      rejected = request.onPreparationRejected
      return { sessionId: 'session-a', messageId: 'prompt-a' }
    })
    let composer!: ReturnType<typeof useWorkspaceComposerController>
    let controller!: WorkspaceConversationController
    const root = createRoot(document.createElement('div'))
    const Harness = (): null => {
      composer = useWorkspaceComposerController({
        currentDraftKey: input.currentDraftKey,
        newConversationDraftKey: input.currentDraftKey,
        activeProjectId: input.projectId,
        activeSession: undefined,
        pendingCustomizePrefill: undefined,
        onCustomizePrefillApplied: vi.fn(),
        historyEntries: [],
        historyPolicy: {
          catalogSkillIds: new Set(),
          allowedSkillIds: undefined,
          skillCatalogReady: true,
          refreshSkillCatalog: false,
          specialistCatalogReady: true,
          specialistId: undefined,
          loadSkills: vi.fn(),
          loadSpecialists: vi.fn()
        },
        canStageAttachments: true,
        supportsImageInput: true,
        uploads: {
          stageLocalFile: vi.fn(),
          beginTransfer: vi.fn(),
          appendTransfer: vi.fn(),
          getTransferStatus: vi.fn(),
          finishTransfer: vi.fn(),
          abortTransfer: vi.fn().mockResolvedValue(undefined),
          deleteUpload: vi.fn(),
          onTransferProgress: vi.fn(() => () => undefined)
        }
      })
      controller = useWorkspaceConversationController({ ...input, composer })
      return null
    }
    const render = (): void =>
      act(() =>
        root.render(createElement(WorkspaceComposerDraftsProvider, null, createElement(Harness)))
      )
    try {
      render()
      act(() => composer.actions.changeDoc(textDoc('Session A rejected draft')))
      await act(async () => controller.actions.submit.draft({ forcedSkillIds: [] }))
      input.currentDraftKey = 'session-b'
      input.activeSession = session({ id: 'session-b' })
      render()
      act(() => rejected?.('Session A operation failed', 'session-a'))
      expect(composer.view.error).toBeNull()
      expect(composer.view.doc).toEqual({ nodes: [] })
      input.currentDraftKey = 'session-a'
      input.activeSession = session()
      render()
      expect(composer.view.doc).toEqual(textDoc('Session A rejected draft'))
    } finally {
      act(() => root.unmount())
    }
  })

  it('retries a restored new-conversation snapshot only in its exact existing Session owner', async () => {
    const input = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
    const snapshot = input.composer.lifecycle.captureSend()
    snapshot.retrySessionOwner = { sessionId: 'bound-session', projectId: 'project-a' }
    vi.mocked(input.composer.lifecycle.captureSend).mockReturnValue(snapshot)
    input.getSession = vi.fn(() => session({ id: 'bound-session' }))
    const hook = renderController(input)
    mounted.push(hook)
    await act(async () => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'bound-session' })
    )
  })

  it.each(['missing', 'wrong-project', 'archived', 'busy'] as const)(
    'keeps a retry snapshot when its exact owner is %s',
    async (condition) => {
      const input = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
      const snapshot = input.composer.lifecycle.captureSend()
      snapshot.retrySessionOwner = { sessionId: 'bound-session', projectId: 'project-a' }
      vi.mocked(input.composer.lifecycle.captureSend).mockReturnValue(snapshot)
      input.getSession = vi.fn(() =>
        condition === 'missing'
          ? undefined
          : session({
              id: 'bound-session',
              ...(condition === 'wrong-project' ? { projectId: 'other-project' } : {}),
              ...(condition === 'archived' ? { archivedAt: 10 } : {}),
              ...(condition === 'busy'
                ? { activeRun: { promptMessageId: 'other', startedAt: 2 }, status: 'running' }
                : {})
            })
      )
      const hook = renderController(input)
      mounted.push(hook)
      await act(async () => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
      expect(input.runtime.sendMessage).not.toHaveBeenCalled()
      expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    }
  )

  it('keeps the original operation error after receipt rejection restores the real composer', async () => {
    const input = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
    input.runtime.sendMessage = vi.fn(async (request) => {
      request.onPreparationRejected?.('Synthetic submission write failure')
      return undefined
    })
    let composer!: ReturnType<typeof useWorkspaceComposerController>
    let controller!: WorkspaceConversationController
    const root = createRoot(document.createElement('div'))
    const Harness = (): null => {
      composer = useWorkspaceComposerController({
        currentDraftKey: input.currentDraftKey,
        newConversationDraftKey: input.currentDraftKey,
        activeProjectId: input.projectId,
        activeSession: undefined,
        pendingCustomizePrefill: undefined,
        onCustomizePrefillApplied: vi.fn(),
        historyEntries: [],
        historyPolicy: {
          catalogSkillIds: new Set(),
          allowedSkillIds: undefined,
          skillCatalogReady: true,
          refreshSkillCatalog: false,
          specialistCatalogReady: true,
          specialistId: undefined,
          loadSkills: vi.fn(),
          loadSpecialists: vi.fn()
        },
        canStageAttachments: true,
        supportsImageInput: true,
        uploads: {
          stageLocalFile: vi.fn(),
          beginTransfer: vi.fn(),
          appendTransfer: vi.fn(),
          getTransferStatus: vi.fn(),
          finishTransfer: vi.fn(),
          abortTransfer: vi.fn().mockResolvedValue(undefined),
          deleteUpload: vi.fn(),
          onTransferProgress: vi.fn(() => () => undefined)
        }
      })
      controller = useWorkspaceConversationController({ ...input, composer })
      return null
    }
    try {
      act(() =>
        root.render(createElement(WorkspaceComposerDraftsProvider, null, createElement(Harness)))
      )
      act(() => composer.actions.changeDoc(textDoc('Rejected message')))
      await act(async () => controller.actions.submit.draft({ forcedSkillIds: [] }))
      expect(composer.view.doc).toEqual(textDoc('Rejected message'))
      expect(composer.view.error).toBe('Synthetic submission write failure')
      expect(composer.view.errorDetail).toBeUndefined()
    } finally {
      act(() => root.unmount())
    }
  })

  it('suppresses synchronous duplicate clicks after the real composer clears a new draft', () => {
    const input = options({ activeSession: undefined, currentDraftKey: 'new:project-a' })
    input.runtime.sendMessage = vi.fn<
      WorkspaceConversationControllerOptions['runtime']['sendMessage']
    >(() => new Promise(() => undefined))
    let composer!: ReturnType<typeof useWorkspaceComposerController>
    let controller!: WorkspaceConversationController
    const root = createRoot(document.createElement('div'))
    const Harness = (): null => {
      composer = useWorkspaceComposerController({
        currentDraftKey: input.currentDraftKey,
        newConversationDraftKey: input.currentDraftKey,
        activeProjectId: input.projectId,
        activeSession: undefined,
        pendingCustomizePrefill: undefined,
        onCustomizePrefillApplied: vi.fn(),
        historyEntries: [],
        historyPolicy: {
          catalogSkillIds: new Set(),
          allowedSkillIds: undefined,
          skillCatalogReady: true,
          refreshSkillCatalog: false,
          specialistCatalogReady: true,
          specialistId: undefined,
          loadSkills: vi.fn(),
          loadSpecialists: vi.fn()
        },
        canStageAttachments: true,
        supportsImageInput: true,
        uploads: {
          stageLocalFile: vi.fn(),
          beginTransfer: vi.fn(),
          appendTransfer: vi.fn(),
          getTransferStatus: vi.fn(),
          finishTransfer: vi.fn(),
          abortTransfer: vi.fn().mockResolvedValue(undefined),
          deleteUpload: vi.fn(),
          onTransferProgress: vi.fn(() => () => undefined)
        }
      })
      controller = useWorkspaceConversationController({ ...input, composer })
      return null
    }
    try {
      act(() =>
        root.render(createElement(WorkspaceComposerDraftsProvider, null, createElement(Harness)))
      )
      act(() => composer.actions.changeDoc(textDoc('same text')))
      const firstVersion = composer.lifecycle.captureSend().version
      act(() => {
        controller.actions.submit.draft({ forcedSkillIds: [] })
        controller.actions.submit.draft({ forcedSkillIds: [] })
      })
      expect(input.runtime.sendMessage).toHaveBeenCalledOnce()
      expect(composer.lifecycle.captureSend().version).toBe(firstVersion)
      act(() => composer.actions.changeDoc(textDoc('same text')))
      expect(composer.lifecycle.captureSend().version).toBeGreaterThan(firstVersion)
      act(() => controller.actions.submit.draft({ forcedSkillIds: [] }))
      expect(input.runtime.sendMessage).toHaveBeenCalledTimes(2)
    } finally {
      act(() => root.unmount())
    }
  })

  it('exposes the submitted draft immediately while runtime admission is pending', async () => {
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    const admission = new Promise<{ sessionId: string; messageId: string }>((resolve) => {
      resolveAdmission = resolve
    })
    const input = options()
    input.runtime.sendMessage = vi.fn(() => admission)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(hook.result.current.optimisticMessage).toMatchObject({
      role: 'user',
      content: 'hello',
      parts: textDoc('hello').nodes,
      uploads: []
    })

    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'message-a' }))
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('removes only this send preview when its real message appears before admission settles', async () => {
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    let onMessageAppended: ((message: { sessionId: string; messageId: string }) => void) | undefined
    const input = options()
    input.runtime.sendMessage = vi.fn((request) => {
      onMessageAppended = request.onMessageAppended
      return new Promise<{ sessionId: string; messageId: string }>((resolve) => {
        resolveAdmission = resolve
      })
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(hook.result.current.optimisticMessage?.content).toBe('hello')

    act(() => onMessageAppended?.({ sessionId: 'session-a', messageId: 'real-message-1' }))
    expect(hook.result.current.optimisticMessage).toBeUndefined()
    // Clearing the preview must not unlock a send that is still in flight.
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).toHaveBeenCalledOnce()
    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'real-message-1' }))

    const previousNotification = onMessageAppended
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(hook.result.current.optimisticMessage?.content).toBe('hello')
    // Identical text (even a reused draft version) is a different submission.
    act(() => previousNotification?.({ sessionId: 'session-a', messageId: 'real-message-1' }))
    expect(hook.result.current.optimisticMessage?.content).toBe('hello')
    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'real-message-2' }))
  })

  it('restores a failed draft even after its preview handed off to the real message', async () => {
    let rejectAdmission!: (error: Error) => void
    let onMessageAppended: (() => void) | undefined
    const input = options()
    input.runtime.sendMessage = vi.fn((request) => {
      onMessageAppended = () =>
        request.onMessageAppended?.({ sessionId: 'session-a', messageId: 'real-message' })
      return new Promise<{ sessionId: string; messageId: string }>((_resolve, reject) => {
        rejectAdmission = reject
      })
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => onMessageAppended?.())
    expect(hook.result.current.optimisticMessage).toBeUndefined()
    await act(async () => rejectAdmission(new Error('save failed')))
    expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledOnce()
    expect(input.composer.actions.setError).toHaveBeenCalledWith('save failed')
  })

  it('restores the complete captured draft after an asynchronous pre-admission rejection', async () => {
    const input = options()
    const snapshot = input.composer.lifecycle.captureSend()
    snapshot.attachments = [
      {
        id: 'original-upload',
        sessionId: '.pending',
        name: 'research.pdf',
        originalName: 'research.pdf',
        path: '/data/.pending/research.pdf',
        mimeType: 'application/pdf',
        size: 123
      }
    ]
    snapshot.pendingPdfContextAttachmentIds = ['original-upload']
    snapshot.pendingPdfContextVersions = [
      { sourceKind: 'artifact-version', sourceFileId: 'paper', sourceVersionId: 'paper-version' }
    ]
    vi.mocked(input.composer.lifecycle.captureSend).mockReturnValue(snapshot)
    let rejected: ((message: string) => void) | undefined
    input.runtime.sendMessage = vi.fn(async (request) => {
      rejected = request.onPreparationRejected
      request.onMessageAppended?.({ sessionId: 'session-a', messageId: 'optimistic-prompt' })
      return { sessionId: 'session-a', messageId: 'optimistic-prompt' }
    })
    const hook = renderController(input)
    mounted.push(hook)
    await act(async () => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.composer.lifecycle.restoreFailedSend).not.toHaveBeenCalled()
    act(() => rejected?.('Provider admission failed'))
    expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledExactlyOnceWith(
      snapshot,
      true,
      undefined,
      true
    )
    expect(snapshot.attachments[0].id).toBe('original-upload')
    expect(snapshot.pendingPdfContextAttachmentIds).toEqual(['original-upload'])
    expect(snapshot.pendingPdfContextVersions?.[0].sourceVersionId).toBe('paper-version')
    expect(input.composer.actions.setError).toHaveBeenCalledWith('Provider admission failed')
  })

  it('restores through the composer that is current when the preparation is rejected', async () => {
    const input = options()
    let rejected: ((message: string) => void) | undefined
    input.runtime.sendMessage = vi.fn(async (request) => {
      rejected = request.onPreparationRejected
      return { sessionId: 'session-a', messageId: 'optimistic-prompt' }
    })
    const hook = renderController(input)
    mounted.push(hook)
    await act(async () => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    const latestComposer = {
      ...input.composer,
      actions: { setError: vi.fn() },
      lifecycle: { ...input.composer.lifecycle, restoreFailedSend: vi.fn(() => true) }
    }
    hook.rerender({ ...input, composer: latestComposer })
    act(() => rejected?.('Provider admission failed'))
    expect(input.composer.lifecycle.restoreFailedSend).not.toHaveBeenCalled()
    expect(input.composer.actions.setError).not.toHaveBeenCalled()
    expect(latestComposer.lifecycle.restoreFailedSend).toHaveBeenCalledOnce()
    expect(latestComposer.actions.setError).toHaveBeenCalledWith('Provider admission failed')
  })

  it('branches from a completed Agent Message without consuming the composer draft', async () => {
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(true)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith({
      branchSourceSessionId: 'session-a',
      branchSourceMessageId: 'agent-message-a',
      text: '',
      agentConfiguration: input.agentConfiguration,
      delegationPolicy: 'allow',
      specialistId: undefined
    })
    expect(input.composer.lifecycle.captureSend).not.toHaveBeenCalled()
    expect(input.resetNewConversationSettings).toHaveBeenCalledOnce()
    expect(input.session.actions.resetNewConversationSpecialist).toHaveBeenCalledOnce()
  })

  it('retains new-Session settings when Agent Message branching fails', async () => {
    const input = options({ newConversationDelegationPolicyOverride: 'deny' })
    input.runtime.sendMessage = vi.fn().mockRejectedValue(new Error('Branch unavailable'))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() =>
      expect(input.composer.actions.setError).toHaveBeenCalledWith('Branch unavailable')
    )

    expect(input.resetNewConversationSettings).not.toHaveBeenCalled()
    expect(input.session.actions.resetNewConversationSpecialist).not.toHaveBeenCalled()
  })

  it('inherits a denied source policy when branching the current draft', async () => {
    const source = session({ delegationPolicy: 'deny' })
    const input = options({
      activeSession: source,
      actionability: projectSessionActionability(source)
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        branchSourceSessionId: 'session-a',
        delegationPolicy: 'deny'
      })
    )
  })

  it('uses an explicit new-Session Delegation override when branching', async () => {
    const source = session({ delegationPolicy: 'allow' })
    const input = options({
      activeSession: source,
      actionability: projectSessionActionability(source),
      newConversationDelegationPolicyOverride: 'deny'
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSourceSessionId: 'session-a',
        delegationPolicy: 'deny'
      })
    )
  })

  it('uses the pending Specialist intent for the branched child Session', async () => {
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: 'specialist-b',
      hasPendingSwitch: false,
      pendingSpecialistId: 'specialist-b'
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.session.lifecycle.captureSendIntent).toHaveBeenCalledWith(true)
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ specialistId: 'specialist-b' })
    )
  })

  it('disables Agent Message branching while the source Session is running', () => {
    const input = options({
      activeSession: session({
        status: 'running',
        activeRun: { promptMessageId: 'message-user-a', startedAt: 2 }
      })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching while the source Session awaits Plan approval', () => {
    const input = options({
      activeSession: session({ status: 'waiting-plan-approval' })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching while the Specialist barrier is in flight', () => {
    const input = options()
    input.session.view.specialist.barrierInFlight = true
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('checks Specialist admission again before creating the branched Session', () => {
    const input = options()
    input.session.lifecycle.canStartSend = vi.fn(() => false)
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(true)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.session.lifecycle.canStartSend).toHaveBeenCalledOnce()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching when the Specialist is not ready to send', () => {
    const input = options()
    input.session.view.specialist.sendAvailable = false
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('submits a restored Plan approval through the human-gated Plan command', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: {
        schema_version: 1,
        task_summary: 'Analyze the dataset',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    } as const
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    const getPlanProjection = vi.fn(async () => ({
      ...pendingPlan,
      revision: 4,
      approval: 'approved' as const,
      lifecycle: 'approved' as const
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { respondPlan, getPlanProjection } }
    })
    useSessionStore.setState({ sessions: [pendingSession] })
    const input = options({
      activeSession: pendingSession,
      getSession: (sessionId) => (sessionId === pendingSession.id ? pendingSession : undefined)
    })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.submit.restoredPlan({ decision: 'approved' }))

    expect(respondPlan).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 'session-a',
      artifactVersionId: 'version-plan-a',
      expectedRevision: 3,
      decision: 'approved'
    })
    expect(input.runtime.ensureSessionReady).toHaveBeenCalledWith('session-a')
    expect(input.runtime.ensureSessionReady).toHaveBeenCalledBefore(respondPlan)
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses a restored Plan response when the Session model is unavailable', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: {
        schema_version: 1,
        task_summary: 'Analyze the dataset',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    } as const
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        acp: {
          respondPlan,
          getPlanProjection: vi.fn(async () => pendingPlan)
        }
      }
    })
    useSessionStore.setState({ sessions: [pendingSession] })
    const input = options({
      activeSession: pendingSession,
      agentConfigurationReady: false,
      getSession: (sessionId) => (sessionId === pendingSession.id ? pendingSession : undefined)
    })
    const hook = renderController(input)
    mounted.push(hook)

    await expect(
      hook.result.current.actions.submit.restoredPlan({ decision: 'approved' })
    ).rejects.toThrow('The Session model is unavailable.')
    expect(input.runtime.ensureSessionReady).not.toHaveBeenCalled()
    expect(respondPlan).not.toHaveBeenCalled()
  })

  it('refuses a restored Plan response for a persistence-blocked Session', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending' as const,
      lifecycle: 'awaiting_approval' as const,
      requiresExplicitContinuation: false,
      document: {
        schema_version: 1 as const,
        task_summary: 'Review the plan',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high' as const, rationale: 'Ready.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    }
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { respondPlan } }
    })
    const input = options({
      activeSession: pendingSession,
      persistenceBlockedSessionIds: [pendingSession.id],
      isPersistenceReady: false,
      getSession: () => pendingSession
    })
    const hook = renderController(input)
    mounted.push(hook)

    await expect(
      hook.result.current.actions.submit.restoredPlan({ decision: 'approved' })
    ).rejects.toThrow('Session persistence is unavailable.')
    expect(input.runtime.ensureSessionReady).not.toHaveBeenCalled()
    expect(respondPlan).not.toHaveBeenCalled()
  })

  it('blocks submit and revision while waiting for a user answer', () => {
    const input = options({ activeSession: session({ status: 'waiting-for-user' }) })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('keeps send and message branching available while history replay is pending', async () => {
    const replaySession = session({ pendingHistoryReplay: { kind: 'all' } })
    const startSideChat = vi.fn(async () => true)
    const input = options({
      activeSession: replaySession,
      actionability: projectSessionActionability(replaySession),
      sideChat: { start: startSideChat }
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({
      submit: true,
      branch: true
    })
    act(() => hook.result.current.actions.branch('agent-message-a'))
    await act(async () => hook.result.current.actions.sideChat.start())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSourceSessionId: 'session-a',
        branchSourceMessageId: 'agent-message-a'
      })
    )
    expect(startSideChat).toHaveBeenCalledOnce()

    vi.mocked(input.runtime.sendMessage).mockClear()
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        text: 'hello',
        agentConfiguration: input.agentConfiguration
      })
    )
  })

  it('blocks submit while a selected branched Session is still binding', () => {
    const pendingSession = session({ isPending: true })
    const input = options({
      activeSession: pendingSession,
      actionability: projectSessionActionability(pendingSession)
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.submit).toBe(false)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps the main Turn available for a delegated Permission', () => {
    const delegatedWait = session({
      status: 'waiting-permission',
      interactionState: { permission: true, elicitation: false, plan: false }
    })
    const input = options({
      activeSession: delegatedWait,
      actionability: projectSessionActionability(delegatedWait, {
        rootPermissionPending: false
      })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: true, revise: true })
  })

  it('queues an ordinary submit during a running turn without overlapping the runtime prompt', () => {
    const running = runningSession()
    const input = options({
      activeSession: running,
      promptInFlightSessionIds: [running.id],
      getSession: () => running
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({
      submit: true,
      submitMode: 'queue'
    })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: ['skill-a'] }))

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['idle', 'draft'],
    ['error', 'draft'],
    ['idle', 'revision'],
    ['error', 'revision']
  ] as const)(
    'keeps %s projection %s queued until Main releases ownership',
    async (status, kind) => {
      let currentSession = { ...runningSession(), status, agentPromptInFlight: true }
      const input = options({
        activeSession: currentSession,
        // The store may accept live ownership before React receives the runtime snapshot.
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
      const hook = renderController(input)
      mounted.push(hook)

      expect(hook.result.current.availability).toMatchObject({
        submit: true,
        submitMode: 'queue',
        revise: true
      })
      await act(async () => {
        if (kind === 'draft') hook.result.current.actions.submit.draft({ forcedSkillIds: [] })
        else {
          expect(
            await hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
          ).toEqual({ ok: true, disposition: 'queued' })
        }
      })
      expect(hook.result.current.queue.items).toEqual([
        expect.objectContaining({ text: kind === 'draft' ? 'hello' : 'changed', phase: 'queued' })
      ])
      expect(input.runtime.sendMessage).not.toHaveBeenCalled()
      expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

      // A state-only release must drain the queue without requiring another provider stop event.
      currentSession = { ...currentSession, agentPromptInFlight: false }
      hook.rerender({
        ...input,
        activeSession: currentSession,
        actionability: projectSessionActionability(currentSession)
      })
      await vi.waitFor(() =>
        expect(
          kind === 'draft' ? input.runtime.sendMessage : input.runtime.resendEditedMessage
        ).toHaveBeenCalledOnce()
      )
    }
  )

  it.each(['waiting-for-user', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'does not queue over %s even while Main owns the prompt',
    async (status) => {
      const activeSession = { ...runningSession(), status, agentPromptInFlight: true }
      const input = options({ activeSession, getSession: () => activeSession })
      const hook = renderController(input)
      mounted.push(hook)

      expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
      await act(async () => {
        hook.result.current.actions.submit.draft({ forcedSkillIds: [] })
        expect(
          await hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
        ).toEqual({ ok: false })
      })
      expect(hook.result.current.queue.items).toEqual([])
      expect(input.runtime.sendMessage).not.toHaveBeenCalled()
      expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
    }
  )

  it('blocks sending and queueing while a Reading context mutation is pending', () => {
    const idleInput = options()
    Object.assign(idleInput.composer.view, {
      readingContext: { bindings: [], pendingBindingId: 'binding-1', isPending: true }
    })
    const idleHook = renderController(idleInput)
    mounted.push(idleHook)

    expect(idleHook.result.current.availability.submit).toBe(false)

    const running = runningSession()
    const runningInput = options({
      activeSession: running,
      promptInFlightSessionIds: [running.id],
      getSession: () => running
    })
    Object.assign(runningInput.composer.view, {
      readingContext: { bindings: [], pendingBindingId: 'binding-1', isPending: true }
    })
    const runningHook = renderController(runningInput)
    mounted.push(runningHook)

    expect(runningHook.result.current.availability.submit).toBe(false)

    idleInput.composer.view.readingContext.isPending = false
    idleHook.rerender(idleInput)
    expect(idleHook.result.current.availability.submit).toBe(true)
    expect(idleHook.result.current.availability.submitMode).toBe('send')

    runningInput.composer.view.readingContext.isPending = false
    runningHook.rerender(runningInput)
    expect(runningHook.result.current.availability.submit).toBe(true)
    expect(runningHook.result.current.availability.submitMode).toBe('queue')
  })

  it('queues without dispatching while the selected Specialist is not ready', () => {
    const running = runningSession()
    const input = options({ activeSession: running, getSession: () => running })
    input.session.lifecycle.canStartSend = vi.fn(() => false)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('captures the active Session Specialist when queueing', async () => {
    let currentSession = { ...runningSession(), specialistId: 'specialist-a' }
    const input = options({ activeSession: currentSession, getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    currentSession = { ...currentSession, status: 'idle' }
    hook.rerender({ ...input, activeSession: currentSession, getSession: () => currentSession })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ specialistId: 'specialist-a' })
    )
  })

  it('drains queued work after another Session becomes active', async () => {
    const queuedSession = runningSession()
    const activeSession = session({ id: 'session-b' })
    const input = options({
      activeSession: queuedSession,
      promptInFlightSessionIds: [queuedSession.id],
      getSession: (sessionId) => (sessionId === queuedSession.id ? queuedSession : activeSession)
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    const settledQueuedSession = { ...queuedSession, status: 'idle' as const }
    hook.rerender({
      ...input,
      activeSession,
      promptInFlightSessionIds: [],
      getSession: (sessionId) =>
        sessionId === queuedSession.id ? settledQueuedSession : activeSession
    })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.session.lifecycle.canStartSend).toHaveBeenCalledWith(queuedSession.id)
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: queuedSession.id })
    )
  })

  it('keeps queued work deferred after a Session becomes persistence-blocked', async () => {
    let queuedSession = runningSession()
    const input = options({
      activeSession: queuedSession,
      promptInFlightSessionIds: [queuedSession.id],
      getSession: () => queuedSession
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    queuedSession = { ...queuedSession, status: 'error' }
    hook.rerender({
      ...input,
      activeSession: queuedSession,
      promptInFlightSessionIds: [],
      persistenceBlockedSessionIds: [queuedSession.id],
      isPersistenceReady: false,
      getSession: () => queuedSession
    })

    await act(async () => Promise.resolve())
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
  })

  it('blocks immediate submit and revision while the queued head is being admitted', async () => {
    let currentSession = runningSession()
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    const admission = new Promise<{ sessionId: string; messageId: string }>((resolve) => {
      resolveAdmission = resolve
    })
    const input = options({
      activeSession: currentSession,
      promptInFlightSessionIds: [currentSession.id],
      getSession: () => currentSession
    })
    input.runtime.sendMessage = vi.fn(() => admission)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    currentSession = { ...currentSession, status: 'idle' }
    hook.rerender({
      ...input,
      activeSession: currentSession,
      promptInFlightSessionIds: [],
      getSession: () => currentSession
    })
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).toHaveBeenCalledOnce()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'queued-message' }))
  })

  it('blocks submit and revision while Save as skill owns prompt admission', () => {
    const input = options({ saveAsSkillInFlightSessionIds: ['session-a'] })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('moves the captured draft into Side chat and clears only its admitted version', async () => {
    const annotation = quotedAnnotation()
    const input = options({ sideChat: { start: vi.fn(async () => true) } })
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 7,
      doc: textDoc('Compare these observations.'),
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() =>
      expect(input.sideChat?.start).toHaveBeenCalledWith(
        'Compare these observations.\n\n[Annotations]\n' +
          '{"items":[{"type":"quote","content":"The confidence intervals overlap.","source":{"kind":"agent-message","sessionId":"session-a","messageId":"agent-message-a"},"instruction":"Explain this caveat."}]}'
      )
    )

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 7)
  })

  it('uses independent Side chat admission when the main model and main preparation are unavailable', async () => {
    const input = options({
      agentConfigurationReady: false,
      sendPreparationInFlightSessionIds: ['session-a'],
      sideChat: { start: vi.fn(async () => true) }
    })
    const hook = renderController(input)
    mounted.push(hook)
    await act(async () => hook.result.current.actions.sideChat.start())
    expect(input.sideChat?.start).toHaveBeenCalledOnce()
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith(
      'session-a',
      expect.any(Number)
    )
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('starts Side chat from an annotation-only captured draft', async () => {
    const annotation = quotedAnnotation()
    const input = options({ sideChat: { start: vi.fn(async () => true) } })
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 3,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())

    await vi.waitFor(() =>
      expect(input.sideChat?.start).toHaveBeenCalledWith(
        '[Annotations]\n' +
          '{"items":[{"type":"quote","content":"The confidence intervals overlap.","source":{"kind":"agent-message","sessionId":"session-a","messageId":"agent-message-a"},"instruction":"Explain this caveat."}]}'
      )
    )
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 3)
  })

  it('keeps the draft when Side chat is unavailable or not admitted', async () => {
    const input = options({ sideChat: { start: vi.fn(async () => false) } })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() => expect(input.sideChat?.start).toHaveBeenCalledOnce())

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it('keeps the captured draft and reports the existing error when Side chat start throws', async () => {
    const input = options({
      sideChat: { start: vi.fn(async () => Promise.reject(new Error('Side chat is unavailable.'))) }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() =>
      expect(input.composer.actions.setError).toHaveBeenCalledWith('Side chat is unavailable.')
    )

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it('starts a captured draft only once while Side chat admission is pending', async () => {
    let resolveAdmission!: (admitted: boolean) => void
    const admission = new Promise<boolean>((resolve) => {
      resolveAdmission = resolve
    })
    const input = options({ sideChat: { start: vi.fn(() => admission) } })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.actions.sideChat.start()
      hook.result.current.actions.sideChat.start()
    })

    expect(input.sideChat?.start).toHaveBeenCalledOnce()
    await act(async () => resolveAdmission(true))
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledOnce()
  })

  it('does not start Side chat for a Session without a prior main user message', () => {
    const input = options({
      activeSession: session({ messages: [] }),
      sideChat: { start: vi.fn(async () => true) }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())

    expect(input.sideChat?.start).not.toHaveBeenCalled()
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it.each(['waiting-for-user', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'starts Side chat while the main Session is %s',
    (status) => {
      const input = options({
        activeSession: session({ status }),
        sideChat: { start: vi.fn(async () => true) }
      })
      const hook = renderController(input)
      mounted.push(hook)

      act(() => hook.result.current.actions.sideChat.start())

      expect(input.sideChat?.start).toHaveBeenCalledOnce()
      expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    }
  )

  it('allows main submit, revise, resume, and cancel while Side chat is open', async () => {
    const input = options({ sideChatOpen: true })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
    })
    await act(async () => hook.result.current.actions.resume())
    await act(async () => hook.result.current.actions.cancel())

    expect(hook.result.current.availability).toMatchObject({
      submit: true,
      revise: true,
      resume: true
    })
    expect(input.runtime.sendMessage).toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).toHaveBeenCalled()
    expect(input.runtime.resumeInterruptedSession).toHaveBeenCalled()
    expect(input.runtime.cancelRun).toHaveBeenCalled()
  })

  it('orders Specialist preparation before draft clear and runtime submit', async () => {
    const order: string[] = []
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: undefined,
      hasPendingSwitch: true,
      pendingSpecialistId: 'specialist-b'
    }))
    input.session.lifecycle.prepareSpecialistSend = vi.fn(async () => {
      order.push('barrier')
      return true
    })
    input.composer.lifecycle.clearDraft = vi.fn(() => {
      order.push('clear')
      return true
    })
    input.runtime.sendMessage = vi.fn(async () => {
      order.push('send')
      return { sessionId: 'session-a', messageId: 'message-a' }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(order).toEqual(['barrier', 'clear', 'send'])
    expect(input.session.lifecycle.prepareSpecialistSend).toHaveBeenCalledWith(
      'session-a',
      'specialist-b'
    )
  })

  it('fails closed without clearing or dispatching when Specialist preparation fails', async () => {
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: undefined,
      hasPendingSwitch: true,
      pendingSpecialistId: 'specialist-b'
    }))
    input.session.lifecycle.prepareSpecialistSend = vi.fn(() => Promise.resolve(false))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.session.lifecycle.prepareSpecialistSend).toHaveBeenCalled())

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    expect(input.composer.lifecycle.restoreFailedSend).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('restores the captured draft when runtime submit has no result', async () => {
    const input = options()
    input.runtime.sendMessage = vi.fn(() => Promise.resolve(undefined))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: ['skill-a'] }))
    await vi.waitFor(() => expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalled())

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a')
    expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledWith(
      expect.objectContaining({ draftKey: 'session-a', version: 1 })
    )
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('preserves the complete image annotation draft when fixed-source preflight rejects', async () => {
    const annotation = {
      id: 'point-fixed',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this fixed point.',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-deleted',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-deleted',
        mimeType: 'image/png'
      },
      point: { x: 0.25, y: 0.75 },
      naturalSize: { width: 800, height: 600 }
    }
    const input = options()
    const snapshot = {
      draftKey: 'session-a',
      version: 1,
      doc: textDoc('keep this explanation'),
      annotations: [annotation],
      attachments: []
    }
    input.composer.view = { ...input.composer.view, doc: snapshot.doc, annotations: [annotation] }
    input.composer.lifecycle.captureSend = vi.fn(() => snapshot)
    input.runtime.sendMessage = vi.fn(() =>
      Promise.reject(
        new Error(
          'An annotated image is no longer available. Restore access to its fixed version or remove the annotation, then try again.'
        )
      )
    )
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() =>
      expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledWith(snapshot)
    )

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      expect.stringContaining('fixed version')
    )
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('includes new-Session Review, Memory and Compute intent in the initial send', async () => {
    const input = options({
      activeSession: undefined,
      currentDraftKey: 'new:project-a',
      newConversationAutoReviewEnabled: true,
      newConversationMemoryEnabled: false,
      newConversationDelegationPolicyOverride: 'deny',
      newConversationEnabledComputeHosts: ['ssh:lab', 'ssh:available'],
      newConversationSelectedComputeHosts: ['ssh:lab']
    })
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'new:project-a',
      version: 1,
      doc: textDoc('new'),
      annotations: [],
      attachments: []
    }))
    input.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ sessionId: 'pending-session', messageId: 'message-a' })
    )
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.resetNewConversationSettings).toHaveBeenCalled())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfiguration: input.agentConfiguration,
        memoryEnabled: false,
        autoReviewEnabled: true,
        delegationPolicy: 'deny',
        enabledComputeHosts: ['ssh:lab', 'ssh:available'],
        selectedComputeHosts: ['ssh:lab']
      })
    )
    expect(input.session.actions.resetNewConversationSpecialist).toHaveBeenCalledOnce()
  })

  it('sends an explicit disabled Review setting for a new conversation', async () => {
    const input = options({ activeSession: undefined, newConversationAutoReviewEnabled: false })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalled())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ autoReviewEnabled: false })
    )
  })

  it('does not apply the new-conversation Review preference to an existing Session', async () => {
    const input = options({ newConversationAutoReviewEnabled: true })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalled())
    expect(vi.mocked(input.runtime.sendMessage).mock.calls[0][0]).not.toHaveProperty(
      'autoReviewEnabled'
    )
  })

  it('keeps revise stable while applying the latest gate and runtime mapping', async () => {
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)
    const revise = hook.result.current.actions.revise

    const blocked = options({
      ...input,
      activeSession: session({ status: 'running' }),
      actionability: projectSessionActionability(session({ status: 'running' })),
      runtime: input.runtime,
      composer: input.composer,
      session: input.session
    })
    hook.rerender(blocked)
    act(() => {
      void revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

    hook.rerender(input)
    act(() => {
      void revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-a', {
      text: 'changed',
      annotations: [],
      parts: textDoc('changed').nodes,
      forcedSkillIds: [],
      referencedArtifacts: []
    })
    expect(hook.result.current.actions.revise).toBe(revise)
  })

  it('resends an annotation-only edit through the existing message revision seam', async () => {
    const annotations = [
      {
        id: 'quote-1',
        kind: 'text' as const,
        target: 'agent' as const,
        quote: 'Quoted evidence',
        note: 'Updated note',
        source: {
          kind: 'project-file' as const,
          projectId: 'project-a',
          path: 'results/report.md',
          versionId: 'version-1'
        }
      }
    ]
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)

    let result: Awaited<ReturnType<WorkspaceConversationController['actions']['revise']>> = {
      ok: false
    }
    await act(async () => {
      result = await hook.result.current.actions.revise(
        'message-user-a',
        { nodes: [] },
        annotations
      )
    })

    expect(result).toEqual({ ok: true, disposition: 'sent' })
    expect(input.runtime.resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-user-a', {
      text: '',
      annotations,
      parts: [],
      forcedSkillIds: [],
      referencedArtifacts: []
    })
  })

  it('captures an edited annotation message for the existing queue while a turn is running', async () => {
    const activeSession = runningSession()
    const input = options({
      activeSession,
      getSession: (sessionId) => (sessionId === activeSession.id ? activeSession : undefined)
    })
    const annotation = {
      id: 'queued-quote',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Queued evidence',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-a',
        messageId: 'agent-message-a'
      }
    }
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.revise).toBe(true)
    await expect(
      hook.result.current.actions.revise('message-user-a', { nodes: [] }, [annotation])
    ).resolves.toEqual({ ok: true, disposition: 'queued' })

    expect(input.composer.lifecycle.captureRevision).toHaveBeenCalledWith({ nodes: [] }, [
      annotation
    ])
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: '', attachmentCount: 0, phase: 'queued' })
    ])
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('blocks an edited image annotation when the selected model cannot read images', async () => {
    const input = options({ supportsImageInput: false })
    const hook = renderController(input)
    mounted.push(hook)
    const annotation = {
      id: 'point-1',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this point.',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-1',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-1',
        mimeType: 'image/png'
      },
      point: { x: 0.5, y: 0.25 },
      naturalSize: { width: 800, height: 400 }
    }

    await expect(
      hook.result.current.actions.revise('message-user-a', { nodes: [] }, [annotation])
    ).resolves.toEqual({
      ok: false,
      displayMessage:
        "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    })

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    )
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('aborts an active Fix Loop before cancelling the runtime run', async () => {
    const order: string[] = []
    const input = options({ activeSession: session({ fixLoopActive: true }) })
    input.abortFixLoop = vi.fn(() => {
      order.push('review')
      return Promise.resolve()
    })
    input.runtime.cancelRun = vi.fn(() => {
      order.push('runtime')
      return Promise.resolve()
    })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.cancel())

    expect(order).toEqual(['review', 'runtime'])
  })

  it.each(['configuration', 'prompt', 'preparation', 'permission', 'graph', 'compaction'] as const)(
    'keeps interrupted recovery blocked by current %s ownership',
    async (blocker) => {
      const activeSession = session({
        status: 'error',
        interrupted: true,
        conversationGraphSyncBlocked: blocker === 'graph' || undefined,
        compacting: blocker === 'compaction' || undefined
      })
      const input = options({
        activeSession,
        agentConfigurationReady: blocker !== 'configuration',
        promptInFlightSessionIds: blocker === 'prompt' ? ['session-a'] : [],
        sendPreparationInFlightSessionIds: blocker === 'preparation' ? ['session-a'] : [],
        actionability: projectSessionActionability(activeSession, {
          rootPermissionPending: blocker === 'permission'
        })
      })
      const hook = renderController(input)
      mounted.push(hook)
      expect(hook.result.current.availability.resume).toBe(false)
      await act(async () => hook.result.current.actions.resume())
      expect(input.runtime.resumeInterruptedSession).not.toHaveBeenCalled()
    }
  )

  it('gates resume and delegates deletion to the Session transaction owner', async () => {
    const input = options({ isPersistenceReady: false })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.resume())
    expect(input.runtime.resumeInterruptedSession).not.toHaveBeenCalled()

    hook.rerender({ ...input, isPersistenceReady: true })
    await act(async () => hook.result.current.actions.resume())
    act(() => hook.result.current.actions.delete())

    expect(input.runtime.resumeInterruptedSession).toHaveBeenCalledWith('session-a')
    expect(input.session.actions.confirmDelete).toHaveBeenCalledOnce()
  })
})

it('keeps persistent Plan read failures in one background retry chain and stops on unmount', async () => {
  vi.useFakeTimers()
  const activeSession = session({ status: 'waiting-plan-approval' })
  const ports = {
    getProjection: vi.fn().mockRejectedValue(new Error('Offline')),
    getSession: () => activeSession,
    setProjection: vi.fn(),
    finishRun: vi.fn()
  }
  const input = options({ activeSession, planProjectionRecovery: ports })
  const hook = renderController(input)
  try {
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.planProjectionRecoveryError).toBe(true)
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expect(vi.getTimerCount()).toBe(1)
      await act(async () => vi.advanceTimersByTimeAsync(delay))
    }
    expect(ports.getProjection).toHaveBeenCalledTimes(8)
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.composer.actions.setError).not.toHaveBeenCalled()
    expect(ports.finishRun).not.toHaveBeenCalled()
    hook.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(120000))
    expect(ports.getProjection).toHaveBeenCalledTimes(8)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    hook.unmount()
    vi.useRealTimers()
  }
})

it('does not overlap a hanging Plan read or apply its result after leaving the Session', async () => {
  vi.useFakeTimers()
  let reject!: (error: Error) => void
  const activeSession = session({ status: 'waiting-plan-approval' })
  const ports = {
    getProjection: vi.fn(
      () =>
        new Promise<null>((_, fail) => {
          reject = fail
        })
    ),
    getSession: () => activeSession,
    setProjection: vi.fn(),
    finishRun: vi.fn()
  }
  const input = options({ activeSession, planProjectionRecovery: ports })
  const hook = renderController(input)
  try {
    await act(async () => vi.advanceTimersByTimeAsync(120000))
    expect(ports.getProjection).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    hook.rerender(
      options({ activeSession: session({ id: 'other-session' }), planProjectionRecovery: ports })
    )
    await act(async () => reject(new Error('Late failure')))
    expect(hook.result.current.planProjectionRecoveryError).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(ports.setProjection).not.toHaveBeenCalled()
    expect(ports.finishRun).not.toHaveBeenCalled()
  } finally {
    hook.unmount()
    vi.useRealTimers()
  }
})

it.each(['idle', 'waiting-plan-approval'] as const)(
  'does not recover a runtime Plan or show its blocking notice for %s imported research',
  async (status) => {
    vi.useFakeTimers()
    const activeSession = session({
      status,
      packageOrigin: {
        importId: 'import-1',
        sourceProjectId: 'source-project',
        sourceSessionId: 'source-session',
        importedAt: 1,
        manifestChecksum: 'a'.repeat(64)
      },
      runtimeContext: {
        version: 1,
        revision: 12,
        plan: {
          artifactId: 'artifact-1',
          artifactVersionId: 'version-1',
          artifactChecksum: 'a'.repeat(64),
          originatingPromptMessageId: 'message-user-a',
          approval: 'approved',
          stepStatuses: {}
        }
      }
    })
    const ports = {
      getProjection: vi.fn().mockRejectedValue(new Error('Imported Session is read-only')),
      getSession: () => activeSession,
      setProjection: vi.fn(),
      finishRun: vi.fn()
    }
    const hook = renderController(options({ activeSession, planProjectionRecovery: ports }))
    try {
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(hook.result.current.planProjectionRecoveryError).toBe(false)
      expect(hook.result.current.availability.planResponse).toBe(false)
      expect(ports.getProjection).not.toHaveBeenCalled()
      expect(ports.setProjection).not.toHaveBeenCalled()
      expect(ports.finishRun).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      hook.unmount()
      vi.useRealTimers()
    }
  }
)

it.each(['retrying', 'pending'] as const)(
  'cancels %s Plan recovery when the same Session becomes imported',
  async (phase) => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    let activeSession = session({ status: 'waiting-plan-approval' })
    const ports = {
      getProjection: vi.fn(
        () =>
          new Promise<null>((_resolve, fail) => {
            reject = fail
          })
      ),
      getSession: () => activeSession,
      setProjection: vi.fn(),
      finishRun: vi.fn()
    }
    const hook = renderController(options({ activeSession, planProjectionRecovery: ports }))
    try {
      if (phase === 'retrying') {
        await act(async () => reject(new Error('Unavailable Plan')))
        expect(hook.result.current.planProjectionRecoveryError).toBe(true)
        expect(vi.getTimerCount()).toBe(1)
      }
      activeSession = {
        ...activeSession,
        packageOrigin: {
          importId: 'import-1',
          sourceProjectId: 'source-project',
          sourceSessionId: 'source-session',
          importedAt: 1,
          manifestChecksum: 'a'.repeat(64)
        }
      }
      hook.rerender(options({ activeSession, planProjectionRecovery: ports }))
      if (phase === 'pending') await act(async () => reject(new Error('Late failure')))
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(hook.result.current.planProjectionRecoveryError).toBe(false)
      expect(ports.getProjection).toHaveBeenCalledTimes(1)
      expect(ports.setProjection).not.toHaveBeenCalled()
      expect(ports.finishRun).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      hook.unmount()
      vi.useRealTimers()
    }
  }
)

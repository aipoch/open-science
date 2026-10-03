import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { continueInterruptedTurn } from '../../../../main/acp/interrupted-turn-continuation'
import { RuntimeSessionOwner } from '../../../../main/session-persistence/runtime-session-owner'
import { SessionPersistenceStateOwner } from '../../../../main/session-persistence/state-owner'
import type {
  AcpContinueInterruptedTurnRequest,
  AcpPromptRequest,
  AcpStateSnapshot
} from '../../../../shared/acp'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type SaveSessionOptions
} from '../../../../shared/session-persistence'
import {
  acknowledgeSessionConversationCommands,
  pendingSessionConversationCommands,
  resetSessionConversationIntentsForTests
} from '../../stores/session-conversation-intents'
import { toPersistedSession, useSessionStore, type ChatSession } from '../../stores/session-store'
import { resetWorkspacePromptRollbacksForTests } from './workspace-prompt-preparation'
import { useWorkspaceOperationErrors } from './workspace-operation-error'
import { createWorkspaceRuntimeSessionLifecycleOwner } from './workspace-runtime-session-lifecycle-owner'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'

// Exercise the renderer intent boundary and Main admission against the same durable authority.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (contextReset = false, withRoutedMessages = false) => {
  let durable: PersistedChatSession = materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Interrupted',
    cwd: '/workspace',
    status: 'error',
    agentFrameworkId: 'codex',
    providerSessionId: 'provider-old',
    runtimeTranscriptOwner: 'main',
    revision: 1,
    resumeRecovery: { kind: 'resume-required', cause: 'app-restart', promptMessageId: 'prompt-1' },
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Continue research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      ...(withRoutedMessages
        ? ['steering-1', 'steering-2'].map((id, index) => ({
            id,
            role: 'user' as const,
            content: 'Additional instruction',
            responseToMessageId: 'prompt-1',
            status: 'complete' as const,
            eventIds: [],
            createdAt: 2 + index,
            updatedAt: 2 + index
          }))
        : [])
    ],
    createdAt: 1,
    updatedAt: 2
  } satisfies PersistedChatSession)
  const originalSegment = durable.conversationGraph!.messages[0].runtimeSegmentId
  useSessionStore.setState({
    sessions: [structuredClone(durable) as ChatSession],
    selectedSessionId: durable.id
  })
  const saveSession = vi.fn(async (candidate: PersistedChatSession) => {
    durable = structuredClone({ ...candidate, revision: (durable.revision ?? 0) + 1 })
    return structuredClone(durable)
  })
  const persistence = new SessionPersistenceStateOwner({
    repository: {
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      saveSession
    },
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  vi.stubGlobal('window', {
    api: {
      sessions: {
        saveSession: (session: PersistedChatSession, options?: SaveSessionOptions) =>
          persistence.saveSession(session, options),
        loadOne: async () => structuredClone(durable)
      }
    }
  })
  const admission = new RuntimeSessionOwner({
    loadSession: async () => structuredClone(durable),
    mutateSession: (scope, mutate) => persistence.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: vi.fn(async () => [])
  })
  const providerDispatch = vi.fn<(request: AcpPromptRequest) => Promise<void>>(
    async () => undefined
  )
  const state: AcpStateSnapshot = {
    status: 'connected',
    cwd: '/workspace',
    sessionIds: [],
    events: [],
    pendingPermissions: [],
    permissionProfiles: {},
    permissionGrants: {},
    contextUsageBySession: {},
    promptInFlight: false,
    promptInFlightSessionIds: [],
    agentPromptInFlightSessionIds: []
  }
  const continuation = vi.fn(async (request: AcpContinueInterruptedTurnRequest) =>
    continueInterruptedTurn(
      {
        loadSession: async () => structuredClone(durable),
        runtime: {
          getState: () => state,
          getLatestUserPrompt: () => undefined,
          startContinuation: async (prompt) => {
            await admission.begin({
              promptMessageId: prompt.provenanceContext!.promptMessageId,
              agentFrameId: prompt.provenanceContext!.agentFrameId!,
              messageBranchId: prompt.provenanceContext!.messageBranchId!,
              runtimeSegmentId: prompt.provenanceContext!.runtimeSegmentId!,
              projectId: durable.projectId!,
              sessionId: durable.id,
              executionId: 'recovery-execution'
            })
            await providerDispatch(prompt)
          }
        }
      },
      request
    )
  )
  const flush = vi.fn(async () => {
    const current = useSessionStore.getState().sessions[0]
    const saved = await persistence.saveSession(toPersistedSession(current), {
      conversationCommands: pendingSessionConversationCommands(current.id)
    })
    await receiveSaveResponse()
    acknowledgeSessionConversationCommands(saved)
    useSessionStore.getState().applyDurableSessionProjection({
      source: current,
      session: saved,
      mode: 'runtime-transcript-authority'
    })
  })
  const receiveSaveResponse = vi.fn(async () => {})
  const runtime = {
    state,
    createSession: vi.fn(),
    resetSessionContext: vi.fn(),
    sendPrompt: vi.fn(),
    resumeSession: vi.fn(async () => ({
      sessionId: durable.id,
      frameworkId: 'codex',
      providerSessionId: contextReset ? 'provider-new' : 'provider-old',
      contextReset
    })),
    continueInterruptedTurn: continuation
  }
  const owner = createWorkspaceRuntimeSessionLifecycleOwner()
  return {
    runtime,
    durable: () => durable,
    originalSegment,
    providerDispatch,
    continuation,
    flush,
    saveSession,
    receiveSaveResponse,
    admission,
    resume: (drain = async (): Promise<void> => {}) =>
      owner.resume(runtime as never, 'session-1', drain, { flushPersistence: flush })
  }
}

describe('interrupted workspace recovery across renderer and Main authority', () => {
  beforeEach(() => {
    resetWorkspacePromptRollbacksForTests()
    resetSessionConversationIntentsForTests()
    useWorkspaceOperationErrors.setState({ errors: {} })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([false, true])(
    'resumes the owning prompt after routed replies with contextReset=%s',
    async (contextReset) => {
      const h = harness(contextReset, true)
      await h.resume()
      expect(h.continuation).toHaveBeenCalledOnce()
      expect(h.providerDispatch).toHaveBeenCalledOnce()
      expect(h.providerDispatch.mock.calls[0][0].provenanceContext?.promptMessageId).toBe(
        'prompt-1'
      )
      expect(
        h
          .durable()
          .messages.filter(({ role }) => role === 'user')
          .map(({ id }) => id)
      ).toEqual(['prompt-1', 'steering-1', 'steering-2'])
      expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
      expect(h.durable().promptPreparation).toBeUndefined()
    }
  )

  it('releases an abandoned Resume preparation before the next stable submission', async () => {
    const h = harness()
    const originalSave = window.api.sessions.saveSession
    let editedBranchId: string | undefined
    window.api.sessions.saveSession = async (session, options) => {
      const saved = await originalSave(session, options)
      if (options?.conversationCommands?.some((command) => command.kind === 'prepare-prompt')) {
        useSessionStore.getState().truncateSessionFromMessage('session-1', 'prompt-1')
        const graph = useSessionStore.getState().sessions[0].conversationGraph!
        editedBranchId = graph.frames.find(({ id }) => id === graph.activeFrameId)!.activeBranchId
        window.api.sessions.saveSession = originalSave
      }
      return saved
    }

    await h.resume()
    expect(h.continuation).not.toHaveBeenCalled()
    h.runtime.state.sessionIds = ['session-1']
    h.runtime.sendPrompt.mockImplementationOnce(async (...args: unknown[]) => {
      const provenance = args[9] as NonNullable<AcpPromptRequest['provenanceContext']>
      await h.admission.begin({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: provenance.promptMessageId,
        agentFrameId: provenance.agentFrameId!,
        messageBranchId: provenance.messageBranchId!,
        runtimeSegmentId: provenance.runtimeSegmentId!,
        executionId: 'next-execution'
      })
    })
    // Application-owned stable submissions do not rely on an unrelated metadata preflush.
    const submitted = await sendWorkspaceMessage(
      h.runtime as never,
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        messageId: 'next-prompt',
        text: 'Revised research question'
      },
      { flushPersistence: h.flush, awaitPromptAdmission: true }
    )
    expect(submitted).toEqual({ sessionId: 'session-1', messageId: 'next-prompt' })
    expect(h.runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(h.durable().activeRun?.promptMessageId).toBe('next-prompt')
    expect(h.durable().promptPreparation).toBeUndefined()
    const graph = h.durable().conversationGraph!
    expect(graph.frames.find(({ id }) => id === graph.activeFrameId)!.activeBranchId).toBe(
      editedBranchId
    )
    expect(graph.messages.some(({ id }) => id === 'prompt-1')).toBe(true)
    expect(h.durable().messages.map(({ id }) => id)).toEqual(['next-prompt'])
  })

  it.each(['attach', 'drain', 'attached'] as const)(
    'recovers the prompt restored after a stale metadata acknowledgement during %s',
    async (phase) => {
      const h = harness(true)
      useSessionStore.setState({
        sessions: [{ ...useSessionStore.getState().sessions[0], interrupted: true }]
      })
      useSessionStore.getState().upsertPersistedSession({
        ...h.durable(),
        revision: 2,
        updatedAt: 3,
        resumeRecovery: undefined,
        status: 'running',
        activeRun: { promptMessageId: 'prompt-1', startedAt: 1 }
      })
      expect(useSessionStore.getState().sessions[0].interrupted).toBe(true)
      expect(useSessionStore.getState().sessions[0].resumeRecovery).toBeUndefined()
      const restore = (): void => {
        Object.assign(h.durable(), {
          revision: 3,
          updatedAt: 4,
          pendingHistoryReplay: { kind: 'all' }
        })
        useSessionStore.getState().applyDurableSessionProjection({
          source: useSessionStore.getState().sessions[0],
          mode: 'runtime-transcript-authority',
          session: structuredClone(h.durable())
        })
      }
      if (phase === 'attach')
        h.runtime.resumeSession.mockImplementationOnce(async () => {
          restore()
          return {
            sessionId: 'session-1',
            frameworkId: 'codex',
            providerSessionId: 'provider-new',
            contextReset: true
          }
        })
      if (phase === 'attached') h.runtime.state.sessionIds = ['session-1']
      await h.resume(async () => {
        if (phase !== 'attach') restore()
      })
      expect(h.providerDispatch).toHaveBeenCalledOnce()
      expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
    }
  )

  it.each(['frame', 'branch', 'prompt'] as const)(
    'does not continue or clear recovery when the selected %s changes while attaching',
    async (changed) => {
      const h = harness(true)
      await h.resume(async () => {
        const current = structuredClone(useSessionStore.getState().sessions[0])
        if (changed === 'frame') current.conversationGraph!.activeFrameId = 'another-frame'
        if (changed === 'branch')
          current.conversationGraph!.frames[0].activeBranchId = 'another-branch'
        if (changed === 'prompt') current.resumeRecovery!.promptMessageId = 'another-prompt'
        useSessionStore.setState({ sessions: [current] })
      })
      expect(h.continuation).not.toHaveBeenCalled()
      expect(h.flush).not.toHaveBeenCalled()
      expect(useSessionStore.getState().sessions[0].resumeRecovery?.promptMessageId).toBe(
        changed === 'prompt' ? 'another-prompt' : 'prompt-1'
      )
      expect(useSessionStore.getState().sessions[0].status).toBe('error')
    }
  )

  it.each([false, true])(
    'records reset context after truncation without clearing a newer error: %s',
    async (newError) => {
      const h = harness(true)
      await h.resume(async () => {
        useSessionStore.getState().truncateSessionFromMessage('session-1', 'prompt-1')
        if (newError) useSessionStore.getState().failRun('session-1', 'New unrelated error')
      })
      expect(h.continuation).not.toHaveBeenCalled()
      const current = useSessionStore.getState().sessions[0]
      if (newError) {
        expect(current.status).toBe('error')
        expect(current.error).toBe('New unrelated error')
      } else {
        expect(current.status).toBe('idle')
        expect(current.pendingHistoryReplay).toEqual({ kind: 'all' })
        expect(current.providerSessionId).toBe('provider-new')
      }
    }
  )

  it('preserves Main outcome when attachment has no recovery marker', async () => {
    const h = harness(true)
    delete h.durable().resumeRecovery
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], resumeRecovery: undefined }]
    })
    await h.resume()
    expect(h.runtime.resumeSession).toHaveBeenCalledOnce()
    expect(h.continuation).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].status).toBe('error')
  })

  it('coalesces concurrent recovery requests until dispatch settles', async () => {
    const h = harness(true)
    let release!: () => void
    h.providerDispatch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = h.resume()
    const second = h.resume()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(h.providerDispatch).toHaveBeenCalledOnce())
    expect(h.flush).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
  })

  it('admits context reset even when the clock has not advanced past the old segment', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const h = harness(true)
    h.durable().runtimeTranscriptLastRun = { promptMessageId: 'prompt-1', startedAt: 1 }
    useSessionStore.setState({ sessions: [structuredClone(h.durable()) as ChatSession] })
    await h.resume()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
    expect(h.durable().activeRun!.startedAt).toBeGreaterThan(1)
    expect(h.durable().conversationGraph!.runtimeSegments.at(-1)!.startedAt).toBeGreaterThan(1)
  })

  it.each([false, true])(
    'persists run admission before provider dispatch (context reset: %s)',
    async (contextReset) => {
      const h = harness(contextReset)
      await h.resume()
      expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
      expect(h.providerDispatch).toHaveBeenCalledOnce()
      const provenance = h.providerDispatch.mock.calls[0][0].provenanceContext!
      expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
      expect(
        h
          .durable()
          .conversationGraph!.runtimeSegments.some(({ id }) => id === provenance.runtimeSegmentId)
      ).toBe(true)
      expect(h.durable().conversationGraph!.messages[0].runtimeSegmentId).toBe(h.originalSegment)
      if (contextReset) expect(provenance.runtimeSegmentId).not.toBe(h.originalSegment)
      else expect(provenance.runtimeSegmentId).toBe(h.originalSegment)
      expect(h.durable().runtimeConversationCommandIds?.length).toBeGreaterThan(0)
      expect(pendingSessionConversationCommands('session-1')).toEqual([])
      expect(h.flush.mock.invocationCallOrder[0]).toBeLessThan(
        h.providerDispatch.mock.invocationCallOrder[0]
      )
    }
  )

  it('keeps failed persistence retryable and never dispatches before admission commits', async () => {
    const h = harness(true)
    h.saveSession.mockRejectedValueOnce(new Error('disk full'))
    await h.resume()
    expect(h.providerDispatch).not.toHaveBeenCalled()
    expect(h.continuation).not.toHaveBeenCalled()
    expect(h.durable().activeRun).toBeUndefined()
    expect(pendingSessionConversationCommands('session-1')).toEqual([])
    expect(useSessionStore.getState().sessions[0].resumeRecovery?.promptMessageId).toBe('prompt-1')
    await h.resume()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
    expect(pendingSessionConversationCommands('session-1')).toEqual([])
  })

  it('retries after a committed save loses its response without dispatching the failed attempt', async () => {
    const h = harness(true)
    h.receiveSaveResponse.mockRejectedValueOnce(new Error('response lost'))
    await h.resume()
    expect(h.durable().activeRun).toBeUndefined()
    expect(h.providerDispatch).not.toHaveBeenCalled()
    expect(h.continuation).not.toHaveBeenCalled()
    expect(h.durable().resumeRecovery?.promptMessageId).toBe('prompt-1')
    expect(h.durable().promptPreparation).toBeUndefined()
    expect(pendingSessionConversationCommands('session-1')).toEqual([])
    await h.resume()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
    expect(pendingSessionConversationCommands('session-1')).toEqual([])
    expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
    expect(useSessionStore.getState().sessions[0].activeRun).toEqual(h.durable().activeRun)
  })

  it('keeps the original Resume failure when its rollback also fails and retries the exact rollback', async () => {
    const h = harness()
    h.continuation.mockRejectedValueOnce(new Error('Provider unreachable'))
    const originalSave = window.api.sessions.saveSession
    let failRollback = true
    window.api.sessions.saveSession = async (session, options) => {
      if (
        failRollback &&
        options?.conversationCommands?.some((command) => command.kind === 'rollback-prompt')
      ) {
        throw new Error('No space left on device')
      }
      return originalSave(session, options)
    }
    await h.resume()
    const reported = useWorkspaceOperationErrors.getState().errors['session-1']
    expect(reported).toContain('Provider unreachable')
    expect(reported).toContain('No space left on device')
    expect(reported).toMatch(/rolled back/i)
    expect(h.durable().promptPreparation).toBeDefined()
    failRollback = false
    await h.resume()
    expect(useWorkspaceOperationErrors.getState().errors['session-1']).toBeUndefined()
    expect(h.durable().promptPreparation).toBeUndefined()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
  })

  it('does not report an admitted Resume as failed when only the authority refresh fails', async () => {
    const h = harness()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const originalSave = window.api.sessions.saveSession
    const rollbackCommands: string[] = []
    window.api.sessions.saveSession = async (session, options) => {
      for (const command of options?.conversationCommands ?? [])
        if (command.kind === 'rollback-prompt') rollbackCommands.push(command.id)
      return originalSave(session, options)
    }
    window.api.sessions.loadOne = async () => {
      throw new Error('Session read unavailable')
    }
    await h.resume()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
    expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
    expect(useWorkspaceOperationErrors.getState().errors['session-1']).toBeUndefined()
    expect(rollbackCommands).toEqual([])
    expect(h.durable().promptPreparation).toBeUndefined()
  })
})

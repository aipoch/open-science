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
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import {
  acknowledgeSessionConversationCommands,
  pendingSessionConversationCommands,
  resetSessionConversationIntentsForTests
} from '../../stores/session-conversation-intents'
import { toPersistedSession, useSessionStore, type ChatSession } from '../../stores/session-store'
import { createWorkspaceRuntimeSessionLifecycleOwner } from './workspace-runtime-session-lifecycle-owner'

// Exercise the renderer intent boundary and Main admission against the same durable authority.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (contextReset = false) => {
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
      }
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
    resume: (drain = async (): Promise<void> => {}) =>
      owner.resume(runtime as never, 'session-1', drain, { flushPersistence: flush })
  }
}

describe('interrupted workspace recovery across renderer and Main authority', () => {
  beforeEach(() => resetSessionConversationIntentsForTests())
  afterEach(() => vi.restoreAllMocks())

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

  it('retains attachment-only recovery when no prompt marker exists before or after attachment', async () => {
    const h = harness(true)
    delete h.durable().resumeRecovery
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], resumeRecovery: undefined }]
    })
    await h.resume()
    expect(h.runtime.resumeSession).toHaveBeenCalledOnce()
    expect(h.continuation).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
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
    expect(
      pendingSessionConversationCommands('session-1').some(({ kind }) => kind === 'resume-run')
    ).toBe(true)
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
    expect(h.durable().activeRun?.promptMessageId).toBe('prompt-1')
    expect(h.providerDispatch).not.toHaveBeenCalled()
    expect(h.continuation).not.toHaveBeenCalled()
    const committedRun = h.durable().activeRun
    expect(pendingSessionConversationCommands('session-1').length).toBeGreaterThan(0)
    await h.resume()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(h.providerDispatch).toHaveBeenCalledOnce()
    expect(pendingSessionConversationCommands('session-1')).toEqual([])
    expect(h.durable().activeRun).toEqual(committedRun)
    expect(useSessionStore.getState().sessions[0].activeRun).toEqual(committedRun)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeSessionOwner } from '../../../../main/session-persistence/runtime-session-owner'
import { SessionPersistenceStateOwner } from '../../../../main/session-persistence/state-owner'
import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type {
  PersistedChatSession,
  SaveSessionOptions
} from '../../../../shared/session-persistence'
import {
  pendingSessionConversationCommands,
  resetSessionConversationIntentsForTests
} from '../../stores/session-conversation-intents'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import {
  createOrderedSessionPersistence,
  flushSessionPersistence,
  saveSessionInOrder
} from '../session-persistence/session-persistence'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'
import { applyWorkspaceRuntimeEvent } from './workspace-events'

// Join the public renderer send/intent boundary to Main's actual save and runtime writers.
// Only storage I/O, provider dispatch, and the existing runtime flush scheduler are controlled.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = async () => {
  const appended = useSessionStore.getState().appendUserMessage({
    sessionId: 'session-1',
    projectId: 'project-1',
    cwd: '/workspace',
    content: 'First question',
    agentFrameworkId: 'codex'
  })!
  let durable: PersistedChatSession = {
    ...toPersistedSession(useSessionStore.getState().sessions[0]),
    revision: 1
  }
  const persistence = new SessionPersistenceStateOwner({
    repository: {
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      saveSession: async (candidate, expected) => {
        expect(expected ?? candidate.revision).toBe(durable.revision)
        durable = structuredClone({ ...candidate, revision: (durable.revision ?? 0) + 1 })
        return structuredClone(durable)
      }
    },
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: (session) => {
      useSessionStore.getState().applyDurableSessionProjection({
        source: useSessionStore.getState().sessions[0],
        session,
        mode: 'runtime-transcript-authority'
      })
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  const transcript = new RuntimeSessionOwner({
    loadSession: async () => structuredClone(durable),
    mutateSession: (scope, mutate) => persistence.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: vi.fn(async () => []),
    scheduleFlush: () => () => {}
  })
  const ordered = createOrderedSessionPersistence({
    saveSession: (session, options) => persistence.saveSession(session, options),
    saveManifest: vi.fn(async () => {})
  })
  const graph = durable.conversationGraph!
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
  const prompt = graph.messages.find(({ id }) => id === appended.messageId)!
  await transcript.begin({
    projectId: durable.projectId,
    sessionId: durable.id,
    promptMessageId: appended.messageId,
    agentFrameId: frame.id,
    messageBranchId: frame.activeBranchId,
    runtimeSegmentId: prompt.runtimeSegmentId!,
    executionId: 'first-execution'
  })
  useSessionStore.getState().hydrateSessions([durable])
  const state: AcpStateSnapshot = {
    status: 'connected',
    cwd: '/workspace',
    sessionIds: [durable.id],
    events: [],
    pendingPermissions: [],
    permissionProfiles: {},
    permissionGrants: {},
    contextUsageBySession: {},
    promptInFlight: false,
    promptInFlightSessionIds: []
  }
  const runtime = {
    state,
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    resetSessionContext: vi.fn(),
    sendPrompt: vi.fn(async () => {})
  }
  const saveErrors: string[] = []
  const flushTargets: Array<string | undefined> = []
  const flush = async (target?: string): Promise<void> => {
    flushTargets.push(target)
    const source = useSessionStore.getState().sessions[0]
    try {
      const saved = await ordered.saveSession(toPersistedSession(source), {
        conversationCommands: pendingSessionConversationCommands(source.id)
      })
      useSessionStore.getState().applyDurableSessionProjection({
        source,
        session: saved,
        mode: 'runtime-transcript-authority'
      })
      await ordered.flush(target)
    } catch (error) {
      saveErrors.push((error as Error).message)
      throw error
    }
  }
  return {
    runtime,
    saveErrors,
    flushTargets,
    flush,
    durable: () => durable,
    terminal: async (kind: 'error' | 'stop') => {
      const event: AcpRuntimeEvent = {
        id: 'terminal-event',
        kind,
        level: kind === 'error' ? 'error' : 'info',
        timestamp: Date.now(),
        sessionId: durable.id,
        promptMessageId: appended.messageId,
        text: kind === 'error' ? 'Provider connection failed' : 'end_turn'
      }
      transcript.accept(event)
      await applyWorkspaceRuntimeEvent(event)
    },
    commitTerminal: () => transcript.flush(durable.id, appended.messageId),
    ordered,
    send: () =>
      sendWorkspaceMessage(
        runtime as never,
        { sessionId: durable.id, projectId: durable.projectId, text: 'Next question' },
        { flushPersistence: flush }
      )
  }
}

describe('workspace send while the previous Main terminal projection is queued', () => {
  beforeEach(() => {
    resetSessionConversationIntentsForTests()
    useSessionStore.setState(createInitialSessionState())
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps a pending user intent retryable when it meets Main activeRun', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
    const h = await harness()
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: 'project-1',
      cwd: '/workspace',
      content: 'Next question',
      agentFrameworkId: 'codex'
    })!
    // The renderer can settle its local copy while the resumed Main runtime still owns the prior run.
    useSessionStore.getState().finishRun('session-1')
    expect(pendingSessionConversationCommands('session-1')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'append-user' })])
    )

    await expect(h.flush()).rejects.toMatchObject({ code: 'session-conversation-deferred' })
    expect(h.saveErrors).toEqual([
      'Session conversation changes are waiting for the active run to finish.'
    ])
    await expect(h.send()).resolves.toBeUndefined()
    expect(h.runtime.sendPrompt).not.toHaveBeenCalled()
    expect(h.flushTargets).toContain('session:session-1')
  })

  it.each([0, -1000])(
    'retries a deferred command after Main finishes with a clock offset of %s ms',
    async (offset) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
      const h = await harness()
      clock.mockReturnValue(1_790_000_000_000 + offset)
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace',
        content: 'Next question',
        agentFrameworkId: 'codex'
      })!
      useSessionStore.getState().finishRun('session-1')
      const deferredCommand = pendingSessionConversationCommands('session-1')[0]
      const saveSession = vi.fn((session: PersistedChatSession, options?: SaveSessionOptions) =>
        h.ordered.saveSession(session, options)
      )
      vi.stubGlobal('window', { api: { sessions: { saveSession } } })

      try {
        await expect(
          saveSessionInOrder(toPersistedSession(useSessionStore.getState().sessions[0]))
        ).rejects.toMatchObject({ code: 'session-conversation-deferred' })
        // Only prompt creation is under clock skew; the terminal event follows the prior run.
        clock.mockReturnValue(1_790_000_000_100)
        await h.terminal('stop')
        await h.commitTerminal()
        await expect(flushSessionPersistence('session:session-1')).resolves.toBeUndefined()
        expect(h.durable().runtimeConversationCommandIds).toContain(deferredCommand.id)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it.each(['stop', 'error'] as const)(
    'does not create a storage failure when the %s event arrives before its durable projection',
    async (kind) => {
      const h = await harness()
      await h.terminal(kind)
      await h.send()
      expect(h.saveErrors).toEqual([])
      await h.commitTerminal()
      await h.send()
      expect(h.runtime.sendPrompt).toHaveBeenCalledOnce()
      expect(h.durable().messages.at(-1)?.content).toBe('Next question')
    }
  )

  it('admits a new prompt when the error projection has already committed', async () => {
    const h = await harness()
    await h.terminal('error')
    await h.commitTerminal()
    await h.send()
    expect(h.saveErrors).toEqual([])
    expect(h.runtime.sendPrompt).toHaveBeenCalledOnce()
  })
})

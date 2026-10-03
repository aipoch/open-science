import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeSessionConversationCommands } from '../../../../shared/session-conversation-command'
import { SessionPromptPreparationOwner } from '../../../../main/session-persistence/prompt-preparation-owner'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import type {
  AcpStateSnapshot,
  AcpCreateSessionResponse,
  AcpRuntimeState
} from '../../../../shared/acp'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { resetSessionConversationIntentsForTests } from '../../stores/session-conversation-intents'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  resetSessionPersistenceWriteFailuresForTests,
  type SessionPersistenceApi
} from '../session-persistence/session-persistence'
import {
  sendWorkspaceMessage,
  type SendWorkspaceMessageIntent
} from './workspace-runtime-command-owner'
import { cancelWorkspaceRun } from './workspace-runtime-session-lifecycle-owner'
import { finalizeWorkspaceAttachments } from './workspace-runtime-attachment-owner'
import { initI18n, prepareI18nLocale } from '../../i18n'
import {
  clearWorkspaceOperationError,
  useWorkspaceOperationErrors
} from './workspace-operation-error'

const gate = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}
const snapshot = {
  sessionIds: ['bound-session'],
  status: 'connected',
  events: [],
  permissions: []
} as unknown as AcpStateSnapshot
const runtime = (): {
  state: AcpStateSnapshot
  createSession: ReturnType<
    typeof vi.fn<() => Promise<{ sessionId: string; cwd: string; frameworkId: 'codex' }>>
  >
  resumeSession: ReturnType<typeof vi.fn<() => Promise<AcpCreateSessionResponse>>>
  resetSessionContext: ReturnType<typeof vi.fn<() => Promise<AcpCreateSessionResponse>>>
  sendPrompt: ReturnType<typeof vi.fn<() => Promise<AcpStateSnapshot>>>
  cancel: ReturnType<typeof vi.fn<() => Promise<AcpRuntimeState | undefined>>>
} => ({
  state: snapshot,
  createSession: vi.fn(async () => ({
    sessionId: 'bound-session',
    cwd: '/workspace',
    frameworkId: 'codex' as const
  })),
  resumeSession: vi.fn(async () => ({ sessionId: 'bound-session', cwd: '/workspace' })),
  resetSessionContext: vi.fn(async () => ({ sessionId: 'bound-session', cwd: '/workspace' })),
  cancel: vi.fn(async () => undefined),
  sendPrompt: vi.fn(async () => snapshot)
})
const mainBoundary = (
  pause?: 'seed' | 'prepare',
  publish = true,
  failPrepare = false
): {
  waiting: ReturnType<typeof gate>
  saveSession: ReturnType<typeof vi.fn<SessionPersistenceApi['saveSession']>>
  deleteSession: ReturnType<typeof vi.fn>
  read: (id?: string) => PersistedChatSession | undefined
} => {
  const owner = new SessionPromptPreparationOwner()
  const waiting = gate()
  const durable = new Map<string, PersistedChatSession>()
  const saveSession = vi.fn<SessionPersistenceApi['saveSession']>(async (candidate, options) => {
    const commands = options?.conversationCommands ?? []
    if (failPrepare && commands.some(({ kind }) => kind === 'prepare-prompt')) {
      throw new Error('Preparation write failed')
    }
    if (
      (pause === 'seed' && !durable.has(candidate.id)) ||
      (pause === 'prepare' && commands.some(({ kind }) => kind === 'prepare-prompt'))
    )
      await waiting.promise
    const authority = durable.get(candidate.id) ?? materializeSessionConversationGraph(candidate)
    // The production sanitizer requires every append's exact Message in its submitted payload.
    for (const command of commands)
      if (command.kind === 'append-user')
        expect(
          candidate.conversationGraph?.messages.some(({ id }) => id === command.message.id)
        ).toBe(true)
    const applied = owner.apply(authority, sanitizeSessionConversationCommands(commands, candidate))
    const saved = {
      ...applied,
      revision: (authority.revision ?? 0) + 1,
      runtimeTranscriptOwner: 'main' as const
    }
    durable.set(candidate.id, saved)
    owner.observe(saved)
    if (publish) useSessionStore.getState().upsertPersistedSession(structuredClone(saved))
    return structuredClone(saved)
  })
  const deleteSession = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    durable.delete(sessionId)
    return { status: 'deleted', runtimeDetached: true }
  })
  vi.stubGlobal('window', {
    api: {
      sessions: {
        saveSession,
        deleteSession,
        saveManifest: vi.fn(async () => undefined),
        loadOne: async (id: string) => structuredClone(durable.get(id))
      }
    }
  })
  return {
    waiting,
    saveSession,
    deleteSession,
    read: (id = 'bound-session') => durable.get(id)
  }
}

beforeEach(() => {
  resetSessionConversationIntentsForTests()
  resetSessionPersistenceWriteFailuresForTests()
  useSessionStore.setState(createInitialSessionState())
  useWorkspaceOperationErrors.setState({ errors: {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('prompt admission across Main preparation and pending binding', () => {
  it('deduplicates a Main seed push before binding and dispatches the exact tagged prompt', async () => {
    const main = mainBoundary()
    const agent = runtime()
    const result = await sendWorkspaceMessage(
      agent,
      { text: 'New question', projectId: 'project', cwd: '/workspace' },
      { awaitPendingPreparation: true }
    )
    expect(result?.sessionId).toBe('bound-session')
    expect(
      useSessionStore.getState().sessions.filter(({ id }) => id === 'bound-session')
    ).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].messages[0].content).toBe('New question')
    expect(main.read()?.messages[0].id).toBe(result?.messageId)
    expect(agent.sendPrompt).toHaveBeenCalledOnce()
    expect(useWorkspaceOperationErrors.getState().errors).toEqual({})
  })

  it.each(['seed', 'prepare'] as const)(
    'does not bind or publish an unadmitted prompt after cancellation during %s persistence',
    async (phase) => {
      const main = mainBoundary(phase)
      const agent = runtime()
      const sending = sendWorkspaceMessage(
        agent,
        { text: 'Cancelled question', projectId: 'project', cwd: '/workspace' },
        { awaitPendingPreparation: true }
      )
      await vi.waitFor(() =>
        expect(main.saveSession.mock.calls.length).toBe(phase === 'seed' ? 1 : 2)
      )
      const pending = useSessionStore.getState().sessions.find(({ isPending }) => isPending)!
      await cancelWorkspaceRun(agent, pending.id)
      main.waiting.resolve()
      expect(await sending).toBeUndefined()
      expect(agent.sendPrompt).not.toHaveBeenCalled()
      expect(main.read()?.messages).toEqual([])
      expect(main.read()?.conversationGraph?.messages).toEqual([])
      expect(main.read()?.activeRun).toBeUndefined()
      expect(
        useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.messages
      ).toEqual([])
    }
  )

  it('returns immutable finalized attachment identities when dispatch is rejected, reusable in another new Session', async () => {
    const main = mainBoundary()
    const staged: UploadedAttachment = {
      id: 'pdf-upload',
      sessionId: '.pending',
      path: '/uploads/.pending/paper.pdf',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    }
    const finalized: UploadedAttachment = {
      ...staged,
      sessionId: 'bound-session',
      path: 'upload-version:project/bound-session/pdf-upload/pdf-v1',
      versionId: 'pdf-v1',
      versionNumber: 1,
      checksum: 'a'.repeat(64)
    }
    const finalizeSession = vi.fn(async () => [finalized])
    Object.assign(window.api, { uploads: { finalizeSession } })
    const agent = runtime()
    agent.sendPrompt.mockRejectedValueOnce(new Error('Admission rejected'))
    const rejected = vi.fn<NonNullable<SendWorkspaceMessageIntent['onPreparationRejected']>>()
    await sendWorkspaceMessage(
      agent,
      {
        text: 'Read my PDF',
        attachments: [staged],
        projectId: 'project',
        cwd: '/workspace',
        onPreparationRejected: rejected
      },
      { awaitPendingPreparation: true }
    )
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
    expect(rejected).toHaveBeenCalledWith('Admission rejected', 'bound-session', [finalized])
    expect(main.read()?.messages).toEqual([])
    // A newer draft can retain the rejected snapshot in the new-conversation slot. Native Upload
    // Versions are stable cross-Session references, and retry must never republish their identities.
    expect(
      await finalizeWorkspaceAttachments({
        sessionId: 'another-new-session',
        projectId: 'project',
        attachments: rejected.mock.calls[0][2]!
      })
    ).toEqual([finalized])
    expect(finalizeSession).toHaveBeenCalledOnce()
  })

  it('discards the persisted seed and runtime Session when preparation fails, so a retry adds no ghost', async () => {
    const main = mainBoundary(undefined, true, true)
    const agent = runtime()
    const rejected = vi.fn<NonNullable<SendWorkspaceMessageIntent['onPreparationRejected']>>()
    await sendWorkspaceMessage(
      agent,
      {
        text: 'Unprepared question',
        projectId: 'project',
        cwd: '/workspace',
        onPreparationRejected: rejected
      },
      { awaitPendingPreparation: true }
    )
    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected.mock.calls[0][0]).toBe('Preparation write failed')
    expect(main.deleteSession).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'bound-session'
    })
    expect(main.read()).toBeUndefined()
    expect(agent.sendPrompt).not.toHaveBeenCalled()
    expect(useWorkspaceOperationErrors.getState().errors[rejected.mock.calls[0][1]!]).toBe(
      'Preparation write failed'
    )
  })

  it('reports an Operation Error that includes a failed seed cleanup', async () => {
    const main = mainBoundary(undefined, true, true)
    main.deleteSession.mockResolvedValueOnce({
      status: 'failed',
      reason: 'persistence',
      runtimeDetached: true
    })
    const agent = runtime()
    await sendWorkspaceMessage(
      agent,
      { text: 'Unprepared question', projectId: 'project', cwd: '/workspace' },
      { awaitPendingPreparation: true }
    )
    const reported = Object.values(useWorkspaceOperationErrors.getState().errors)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('Preparation write failed')
    expect(reported[0]).toMatch(/could not be removed/i)
    expect(main.deleteSession).toHaveBeenCalledTimes(1)
    expect(main.deleteSession.mock.calls[0][0].sessionId).toBe('bound-session')
  })

  it('localizes the failed seed cleanup sentence and its Session cleanup fragment', async () => {
    await prepareI18nLocale('zh-Hans')
    initI18n('zh-Hans')
    try {
      const main = mainBoundary(undefined, true, true)
      main.deleteSession.mockResolvedValueOnce({
        status: 'failed',
        reason: 'persistence',
        runtimeDetached: true
      })
      await sendWorkspaceMessage(
        runtime(),
        { text: 'Unprepared question', projectId: 'project', cwd: '/workspace' },
        { awaitPendingPreparation: true }
      )
      const reported = Object.values(useWorkspaceOperationErrors.getState().errors)
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('Preparation write failed')
      expect(reported[0]).toContain('未发送的会话无法移除（智能体会话清理未完成。）')
      expect(reported[0]).not.toMatch(/could not be removed/i)
    } finally {
      initI18n('en')
    }
  })

  it('keeps a rejected Branch draft sendable after its Operation Error is cleared elsewhere', async () => {
    mainBoundary()
    const source = materializeSessionConversationGraph({
      id: 'source-session',
      projectId: 'project',
      title: 'Source',
      cwd: '/workspace',
      status: 'idle',
      agentFrameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'source-prompt',
          role: 'user',
          content: 'Source question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useSessionStore.getState().hydrateSessions([structuredClone(source)])
    const agent = runtime()
    agent.createSession.mockRejectedValueOnce(new Error('Agent unavailable'))
    const rejected = vi.fn<NonNullable<SendWorkspaceMessageIntent['onPreparationRejected']>>()
    await sendWorkspaceMessage(
      agent,
      {
        text: 'Branch draft',
        projectId: 'project',
        cwd: '/workspace',
        branchSourceSessionId: 'source-session',
        onPreparationRejected: rejected
      },
      { awaitPendingPreparation: true }
    )
    expect(rejected).toHaveBeenCalledOnce()
    const pendingId = rejected.mock.calls[0][1]!
    const pending = useSessionStore.getState().sessions.find(({ id }) => id === pendingId)!
    expect(pending.isPending).toBe(true)
    expect(pending.branchSource).toBeDefined()
    // Cancel and unrelated retries clear Operation Errors; the retained draft must stay sendable.
    clearWorkspaceOperationError(pendingId)
    const retried = await sendWorkspaceMessage(
      agent,
      { sessionId: pendingId, text: 'Branch draft', projectId: 'project', cwd: '/workspace' },
      { awaitPendingPreparation: true }
    )
    expect(retried).toBeDefined()
    expect(agent.createSession).toHaveBeenCalledTimes(2)
    expect(agent.sendPrompt).toHaveBeenCalledOnce()
  })

  it('removes only the new Session when a Branch seed fails, leaving its source untouched', async () => {
    const main = mainBoundary(undefined, true, true)
    const source = materializeSessionConversationGraph({
      id: 'source-session',
      projectId: 'project',
      title: 'Source',
      cwd: '/workspace',
      status: 'idle',
      agentFrameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'source-prompt',
          role: 'user',
          content: 'Source question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useSessionStore.getState().hydrateSessions([structuredClone(source)])
    await sendWorkspaceMessage(
      runtime(),
      {
        text: 'Branch draft',
        projectId: 'project',
        cwd: '/workspace',
        branchSourceSessionId: 'source-session'
      },
      { awaitPendingPreparation: true }
    )
    expect(main.deleteSession.mock.calls.map(([{ sessionId }]) => sessionId)).toEqual([
      'bound-session'
    ])
    const sourceAfter = useSessionStore
      .getState()
      .sessions.find(({ id }) => id === 'source-session')
    expect(sourceAfter?.messages.map(({ id }) => id)).toEqual(['source-prompt'])
    expect(main.read('source-session')).toBeUndefined()
  })
})

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
import { resetSessionConversationIntentsForTests } from '../../stores/session-conversation-intents'
import {
  createInitialSessionState,
  useSessionStore,
  toPersistedSession,
  hydrateSession,
  retainSessionRecoveryDrafts
} from '../../stores/session-store'
import {
  resetSessionPersistenceWriteFailuresForTests,
  type SessionPersistenceApi
} from '../session-persistence/session-persistence'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'
import { cancelWorkspaceRun } from './workspace-runtime-session-lifecycle-owner'
import { retryPendingWorkspacePromptRollback } from './workspace-prompt-preparation'
import { resetWorkspacePromptRollbacksForTests } from './workspace-prompt-preparation'
import { useWorkspaceOperationErrors } from './workspace-operation-error'

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
  permissions: [],
  pendingPermissions: [],
  pendingElicitations: [],
  promptInFlightSessionIds: []
} as unknown as AcpStateSnapshot
const runtime = (): {
  state: AcpStateSnapshot
  createSession: ReturnType<
    typeof vi.fn<() => Promise<{ sessionId: string; cwd: string; frameworkId: 'codex' }>>
  >
  resumeSession: ReturnType<typeof vi.fn<() => Promise<AcpCreateSessionResponse>>>
  resetSessionContext: ReturnType<typeof vi.fn<() => Promise<AcpCreateSessionResponse>>>
  sendPrompt: ReturnType<typeof vi.fn<(sessionId: string) => Promise<AcpStateSnapshot>>>
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
  resetWorkspacePromptRollbacksForTests()
  resetSessionConversationIntentsForTests()
  resetSessionPersistenceWriteFailuresForTests()
  useSessionStore.setState(createInitialSessionState())
  useWorkspaceOperationErrors.setState({ errors: {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 150; i++) await Promise.resolve()
}
const input = { text: 'First message', projectId: 'project', cwd: '/workspace' }

describe('first prompt preparation boundaries', () => {
  it('keeps a silent create pending without any application timeout', async () => {
    vi.useFakeTimers()
    mainBoundary()
    const agent = runtime()
    const created = gate()
    agent.createSession.mockImplementationOnce(async () => {
      await created.promise
      return { sessionId: 'bound-session', cwd: '/workspace', frameworkId: 'codex' }
    })
    const appended = vi.fn()
    const rejected = vi.fn()
    const changed = vi.fn()
    const sending = sendWorkspaceMessage(
      agent,
      { ...input, onMessageAppended: appended, onPreparationRejected: rejected },
      {
        awaitPendingPreparation: true,
        onSendPreparationStateChange: changed
      }
    )
    await flush()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(rejected).not.toHaveBeenCalled()
    expect(changed.mock.calls).toEqual([[appended.mock.calls[0][0].sessionId, true]])
    expect(agent.sendPrompt).not.toHaveBeenCalled()
    await cancelWorkspaceRun(agent, appended.mock.calls[0][0].sessionId)
    created.resolve()
    await sending
    await flush()
  })

  it.each(['create', 'seed', 'prepare'] as const)(
    'stops %s without waiting, restores once, and rejects late results',
    async (pause) => {
      const main = mainBoundary(pause === 'create' ? undefined : pause)
      const agent = runtime()
      const creation = gate()
      if (pause === 'create')
        agent.createSession.mockImplementationOnce(async () => {
          await creation.promise
          return { sessionId: 'bound-session', cwd: '/workspace', frameworkId: 'codex' }
        })
      const stopped = vi.fn()
      const rejected = vi.fn()
      const changed = vi.fn()
      const appended = vi.fn()
      const sending = sendWorkspaceMessage(
        agent,
        {
          ...input,
          onMessageAppended: appended,
          onPreparationCancelled: stopped,
          onPreparationRejected: rejected
        },
        { awaitPendingPreparation: true, onSendPreparationStateChange: changed }
      )
      await flush()
      const pendingId = appended.mock.calls[0][0].sessionId
      expect(changed).toHaveBeenCalledWith(pendingId, true)
      await cancelWorkspaceRun(agent, pendingId)
      expect(stopped).toHaveBeenCalledOnce()
      expect(rejected).not.toHaveBeenCalled()
      expect(
        useSessionStore.getState().sessions.find(({ id }) => id === pendingId)?.messages
      ).toEqual([])
      expect(changed).toHaveBeenCalledWith(pendingId, false)
      expect(await sending).toBeUndefined()
      creation.resolve()
      main.waiting.resolve()
      await flush()
      expect(agent.sendPrompt).not.toHaveBeenCalled()
      expect(agent.cancel).not.toHaveBeenCalled()
      expect(stopped).toHaveBeenCalledOnce()
      expect(main.deleteSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'bound-session' })
      )
      expect(Object.values(useWorkspaceOperationErrors.getState().errors)).toEqual([])
    }
  )

  it('reports a known preparation error before unbound deletion finishes', async () => {
    const main = mainBoundary(undefined, true, true)
    const cleanup = gate()
    main.deleteSession.mockImplementationOnce(async () => {
      await cleanup.promise
      return { status: 'deleted', runtimeDetached: true }
    })
    const rejected = vi.fn()
    const agent = runtime()
    const sending = sendWorkspaceMessage(
      agent,
      { ...input, onPreparationRejected: rejected },
      { awaitPendingPreparation: true }
    )
    await flush()
    expect(rejected).toHaveBeenCalledWith('Preparation write failed', expect.any(String), undefined)
    expect(
      useSessionStore.getState().sessions.find(({ isPending }) => isPending)?.activeRun
    ).toBeUndefined()
    expect(await sending).toBeUndefined()
    cleanup.resolve()
    await flush()
    expect(rejected).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject', 'rejected-contender'])(
    'keeps a submitted message after Stop and a late send %s',
    async (outcome) => {
      mainBoundary()
      const agent = runtime()
      const response = gate()
      agent.sendPrompt.mockImplementationOnce(async () => {
        await response.promise
        if (outcome !== 'resolve') throw new Error('Stopped before provider acceptance')
        return snapshot
      })
      agent.cancel.mockResolvedValueOnce(snapshot)
      const stopped = vi.fn()
      const changed = vi.fn()
      const sending = sendWorkspaceMessage(
        agent,
        { ...input, onPreparationCancelled: stopped },
        { awaitPendingPreparation: true, onSendPreparationStateChange: changed }
      )
      await flush()
      expect(agent.sendPrompt).toHaveBeenCalledOnce()
      expect(
        useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')
          ?.firstPromptDraft
      ).toBeUndefined()
      if (outcome === 'rejected-contender')
        expect(
          await sendWorkspaceMessage(agent, {
            ...input,
            sessionId: 'bound-session',
            text: 'Another message'
          })
        ).toBeUndefined()
      await cancelWorkspaceRun(agent, 'bound-session')
      expect(agent.cancel).toHaveBeenCalledWith('bound-session')
      expect(stopped).not.toHaveBeenCalled()
      expect(
        useSessionStore
          .getState()
          .sessions.find(({ id }) => id === 'bound-session')
          ?.messages.map(({ content }) => content)
      ).toEqual(['First message'])
      expect(changed).toHaveBeenCalledWith('bound-session', false)
      response.resolve()
      await sending
      await flush()
      expect(stopped).not.toHaveBeenCalled()
      expect(
        useSessionStore
          .getState()
          .sessions.find(({ id }) => id === 'bound-session')
          ?.messages.map(({ content }) => content)
      ).toEqual(['First message'])
    }
  )

  it('routes Stop at the synchronous sendPrompt boundary to provider cancellation exactly once', async () => {
    mainBoundary()
    const agent = runtime()
    agent.cancel.mockResolvedValueOnce(snapshot)
    agent.sendPrompt.mockImplementationOnce(async () => {
      await cancelWorkspaceRun(agent, 'bound-session')
      return snapshot
    })
    const stopped = vi.fn()
    await sendWorkspaceMessage(
      agent,
      { ...input, onPreparationCancelled: stopped },
      { awaitPendingPreparation: true }
    )
    await flush()
    expect(agent.cancel).toHaveBeenCalledExactlyOnceWith('bound-session')
    expect(stopped).not.toHaveBeenCalled()
    expect(
      useSessionStore
        .getState()
        .sessions.find(({ id }) => id === 'bound-session')
        ?.messages.map(({ content }) => content)
    ).toEqual(['First message'])
  })

  it('keeps preparation presentation across binding and stops a bound save before submission', async () => {
    const main = mainBoundary()
    const saving = gate()
    const originalSave = main.saveSession.getMockImplementation()!
    main.saveSession.mockImplementation(async (candidate, options) => {
      if (options?.conversationCommands?.some(({ kind }) => kind === 'append-user'))
        await saving.promise
      return originalSave(candidate, options)
    })
    const agent = runtime()
    const stopped = vi.fn()
    const changed = vi.fn()
    const sending = sendWorkspaceMessage(
      agent,
      { ...input, onPreparationCancelled: stopped },
      {
        awaitPendingPreparation: true,
        onSendPreparationStateChange: changed
      }
    )
    await flush()
    const pendingId = changed.mock.calls[0][0]
    expect(changed.mock.calls).toEqual([
      [pendingId, true],
      ['bound-session', true],
      [pendingId, false]
    ])
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.isPending
    ).toBe(false)
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.firstPromptDraft
    ).toBe(true)
    await cancelWorkspaceRun(agent, 'bound-session')
    expect(stopped).toHaveBeenCalledOnce()
    expect(await sending).toBeUndefined()
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.messages
    ).toEqual([])
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.firstPromptDraft
    ).toBe(true)
    const draftOwner = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    const persisted = toPersistedSession(draftOwner)
    expect(persisted).not.toHaveProperty('firstPromptDraft')
    expect(
      retainSessionRecoveryDrafts(hydrateSession(persisted), draftOwner).firstPromptDraft
    ).toBe(true)
    // The write still owns admission even though Stop has returned and the draft is restored.
    expect(
      await sendWorkspaceMessage(agent, { ...input, sessionId: 'bound-session' })
    ).toBeUndefined()
    saving.resolve()
    await flush()
    expect(agent.sendPrompt).not.toHaveBeenCalled()
    expect(main.read()?.messages).toEqual([])
    expect(main.read()?.promptPreparation).toBeUndefined()
  })

  it('reports failure while rollback hangs and shares that rollback with retry', async () => {
    const main = mainBoundary()
    const rollback = gate()
    const originalSave = main.saveSession.getMockImplementation()!
    main.saveSession.mockImplementation(async (candidate, options) => {
      if (options?.conversationCommands?.some(({ kind }) => kind === 'rollback-prompt'))
        await rollback.promise
      return originalSave(candidate, options)
    })
    const agent = runtime()
    agent.sendPrompt.mockRejectedValueOnce(new Error('Provider rejected the prompt'))
    const rejected = vi.fn()
    await sendWorkspaceMessage(
      agent,
      { ...input, onPreparationRejected: rejected },
      { awaitPendingPreparation: true }
    )
    await flush()
    expect(rejected).toHaveBeenCalledOnce()
    expect(useWorkspaceOperationErrors.getState().errors['bound-session']).toBe(
      'Provider rejected the prompt'
    )
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')?.activeRun
    ).toBeUndefined()
    const sameRollback = retryPendingWorkspacePromptRollback('bound-session')
    const retry = sendWorkspaceMessage(
      agent,
      { ...input, sessionId: 'bound-session' },
      { awaitPromptAdmission: true }
    )
    await flush()
    expect(agent.sendPrompt).toHaveBeenCalledOnce()
    expect(
      main.saveSession.mock.calls.filter(([, options]) =>
        options?.conversationCommands?.some(({ kind }) => kind === 'rollback-prompt')
      )
    ).toHaveLength(1)
    rollback.resolve()
    await sameRollback
    await retry
    await flush()
    await sendWorkspaceMessage(
      agent,
      { ...input, sessionId: 'bound-session' },
      { awaitPromptAdmission: true }
    )
    expect(agent.sendPrompt).toHaveBeenCalledTimes(2)
    expect(rejected).toHaveBeenCalledOnce()
  })

  it('does not let a late old create touch a different new request', async () => {
    const main = mainBoundary()
    const oldCreate = gate()
    const agent = runtime()
    agent.createSession.mockImplementationOnce(async () => {
      await oldCreate.promise
      return { sessionId: 'old-session', cwd: '/workspace', frameworkId: 'codex' }
    })
    const appended = vi.fn()
    const old = sendWorkspaceMessage(
      agent,
      { ...input, onMessageAppended: appended },
      { awaitPendingPreparation: true }
    )
    await flush()
    await cancelWorkspaceRun(agent, appended.mock.calls[0][0].sessionId)
    await old
    const fresh = await sendWorkspaceMessage(
      agent,
      { ...input, text: 'New draft' },
      { awaitPendingPreparation: true }
    )
    oldCreate.resolve()
    await flush()
    expect(fresh?.sessionId).toBe('bound-session')
    expect(agent.sendPrompt).toHaveBeenCalledOnce()
    expect(agent.sendPrompt.mock.calls[0][0]).toBe('bound-session')
    expect(main.deleteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'old-session' })
    )
    expect(main.deleteSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'bound-session' })
    )
  })
})

it('keeps a stopped bound prompt withdrawn during late save publication and pending rollback', async () => {
  const main = mainBoundary()
  const saving = gate()
  const rolling = gate()
  const originalSave = main.saveSession.getMockImplementation()!
  main.saveSession.mockImplementation(async (candidate, options) => {
    if (options?.conversationCommands?.some(({ kind }) => kind === 'append-user'))
      await saving.promise
    if (options?.conversationCommands?.some(({ kind }) => kind === 'rollback-prompt'))
      await rolling.promise
    return originalSave(candidate, options)
  })
  const agent = runtime()
  const sending = sendWorkspaceMessage(agent, input, { awaitPendingPreparation: true })
  await flush()
  await cancelWorkspaceRun(agent, 'bound-session')
  await sending
  saving.resolve()
  await flush()
  const pendingCleanup = useSessionStore
    .getState()
    .sessions.find(({ id }) => id === 'bound-session')
  try {
    expect(pendingCleanup?.activeRun).toBeUndefined()
    expect(pendingCleanup?.messages).toEqual([])
  } finally {
    rolling.resolve()
    await flush()
  }
})

it('restores staged uploads immediately and retries late finalized uploads under the same owner', async () => {
  const main = mainBoundary()
  const finalizing = gate()
  const staged = {
    id: 'upload-one',
    sessionId: '.pending',
    name: 'note.txt',
    originalName: 'note.txt',
    path: '/pending/note.txt',
    size: 5,
    mimeType: 'text/plain'
  }
  const finalized = {
    ...staged,
    sessionId: 'bound-session',
    path: '/durable/note.txt',
    versionId: 'version-one'
  }
  const finalizeSession = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    // Main's immutable upload identity cannot be moved into a different retry Session.
    expect(sessionId).toBe('bound-session')
    await finalizing.promise
    return [finalized]
  })
  Object.assign(window.api, { uploads: { finalizeSession } })
  const agent = runtime()
  const appended = vi.fn()
  const stopped = vi.fn()
  const sending = sendWorkspaceMessage(
    agent,
    {
      ...input,
      attachments: [staged],
      onMessageAppended: appended,
      onPreparationCancelled: stopped
    },
    { awaitPendingPreparation: true }
  )
  await flush()
  expect(finalizeSession).toHaveBeenCalledOnce()
  await cancelWorkspaceRun(agent, appended.mock.calls[0][0].sessionId)
  expect(stopped).toHaveBeenCalledExactlyOnceWith('bound-session', [staged])
  await sending
  finalizing.resolve()
  await flush()
  expect(main.deleteSession).not.toHaveBeenCalled()
  expect(agent.sendPrompt).not.toHaveBeenCalled()
  const retried = await sendWorkspaceMessage(
    agent,
    { ...input, sessionId: stopped.mock.calls[0][0], attachments: stopped.mock.calls[0][1] },
    { awaitPromptAdmission: true }
  )
  expect(retried?.sessionId).toBe('bound-session')
  expect(agent.createSession).toHaveBeenCalledOnce()
  expect(finalizeSession).toHaveBeenCalledTimes(2)
  expect(agent.sendPrompt).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledOnce()
})

it.each(['finalize', 'policy'] as const)(
  'restores raw pending uploads and reports the original %s failure',
  async (stage) => {
    mainBoundary()
    const failure = new Error('Original preparation failure')
    const staged = {
      id: 'upload-one',
      sessionId: '.pending',
      name: 'note.txt',
      originalName: 'note.txt',
      path: '/pending/note.txt',
      size: 5,
      mimeType: 'text/plain'
    }
    const finalizeSession = vi.fn(async () => {
      throw failure
    })
    Object.assign(window.api, { uploads: { finalizeSession } })
    Object.assign(window.api.sessions, {
      setDelegationPolicy: vi.fn(async () => {
        throw failure
      })
    })
    const agent = runtime()
    const rejected = vi.fn()
    await expect(
      sendWorkspaceMessage(
        agent,
        {
          ...input,
          attachments: [staged],
          onPreparationRejected: rejected,
          ...(stage === 'policy' ? { delegationPolicy: 'deny' as const } : {})
        },
        { awaitPendingPreparation: true }
      )
    ).resolves.toBeUndefined()
    await flush()
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      'Original preparation failure',
      'bound-session',
      [staged]
    )
    expect(useWorkspaceOperationErrors.getState().errors['bound-session']).toBe(
      'Original preparation failure'
    )
    expect(agent.sendPrompt).not.toHaveBeenCalled()
  }
)

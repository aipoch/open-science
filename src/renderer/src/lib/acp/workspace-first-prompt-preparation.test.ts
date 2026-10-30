import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeSessionConversationCommands } from '../../../../shared/session-conversation-command'
import { parseUploadVersionReference } from '../../../../shared/uploads'
import { SessionPromptPreparationOwner } from '../../../../main/session-persistence/prompt-preparation-owner'
import { AcpRuntimeCoordinator } from '../../../../main/acp/runtime-coordinator'
import type { AcpRuntime } from '../../../../main/acp/runtime'
import type { RootDelegatedWorkControl } from '../../../../main/delegation/production-composition'
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
  saveSessionInOrder,
  type SessionPersistenceApi
} from '../session-persistence/session-persistence'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'
import { cancelWorkspaceRun } from './workspace-runtime-session-lifecycle-owner'
import { retryPendingWorkspacePromptRollback } from './workspace-prompt-preparation'
import { resetWorkspacePromptRollbacksForTests } from './workspace-prompt-preparation'
import { useWorkspaceOperationErrors } from './workspace-operation-error'
import {
  configureComposerDraftStorage,
  readComposerDraft,
  revokeComposerDraftStorage,
  writeComposerDraft
} from '../../pages/workspace/composer-draft-storage'

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
  revokeComposerDraftStorage()
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

  it('settles a stopped dispatch rejected before Main admission and permits the next prompt', async () => {
    const main = mainBoundary()
    const agent = runtime()
    const response = gate()
    agent.sendPrompt.mockImplementationOnce(async () => {
      await response.promise
      throw new Error('ACP prompt start was cancelled before runtime turn admission')
    })
    agent.cancel.mockResolvedValueOnce(snapshot)
    await sendWorkspaceMessage(agent, input, { awaitPendingPreparation: true })
    await flush()
    expect(main.read()?.runtimeSessionAdmissions ?? []).toEqual([])
    await cancelWorkspaceRun(agent, 'bound-session')
    response.resolve()
    await flush()
    const session = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    expect(session.messages.map(({ content }) => content)).toEqual(['First message'])
    expect(session.activeRun).toBeUndefined()
    expect(session.promptPreparation).toBeUndefined()
    expect(main.read()?.activeRun).toBeUndefined()
    expect(main.read()?.promptPreparation).toBeUndefined()
    expect(main.read()?.messages.map(({ content }) => content)).toEqual(['First message'])
    await sendWorkspaceMessage(
      agent,
      { ...input, sessionId: 'bound-session', text: 'Next message' },
      { awaitPromptAdmission: true }
    )
    expect(agent.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('releases preparation on actual coordinator pre-admission cancellation while old settlement drains', async () => {
    const main = mainBoundary()
    const settlement = gate()
    const providerDispatch = vi.fn()
    const rootTurnStarted = vi.fn(async () => {
      await settlement.promise
      return 'settlement-lease'
    })
    const rootTurnEnded = vi.fn(async () => undefined)
    const delegatedWork: RootDelegatedWorkControl = {
      pendingPermissions: () => [],
      subscribe: () => () => undefined,
      respondToPermission: async () => false,
      setPermissionProfile: async () => undefined,
      stopSession: async () => undefined,
      stopAll: async () => undefined,
      shutdown: async () => undefined,
      shutdownForQuit: async () => undefined,
      shutdownForUpdateGate: async () => undefined,
      deleteSession: async () => undefined,
      deleteProject: async () => undefined,
      rootTurnStarted,
      rootTurnEnded
    }
    const state = { ...snapshot, contextUsageBySession: {} }
    const coordinator = new AcpRuntimeCoordinator(
      () =>
        ({
          getState: () => state,
          getSnapshot: () => state,
          cancelPrompt: async () => state,
          sendPrompt: providerDispatch
        }) as unknown as AcpRuntime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      delegatedWork
    )
    const agent = runtime()
    agent.sendPrompt.mockImplementationOnce(async (sessionId) => {
      const promptMessageId = useSessionStore
        .getState()
        .sessions.find(({ id }) => id === sessionId)!.activeRun!.promptMessageId
      await coordinator.startPrompt({
        sessionId,
        text: input.text,
        provenanceContext: { promptMessageId }
      })
      return snapshot
    })
    agent.cancel.mockImplementationOnce(() =>
      coordinator.cancelPrompt({ sessionId: 'bound-session' })
    )
    await sendWorkspaceMessage(agent, input, { awaitPendingPreparation: true })
    await flush()
    expect(rootTurnStarted).toHaveBeenCalledOnce()
    expect(main.read()?.runtimeSessionAdmissions ?? []).toEqual([])
    expect(providerDispatch).not.toHaveBeenCalled()
    await cancelWorkspaceRun(agent, 'bound-session')
    await flush()
    expect(main.read()?.activeRun).toBeUndefined()
    expect(main.read()?.promptPreparation).toBeUndefined()
    expect(main.read()?.messages.map(({ content }) => content)).toEqual(['First message'])
    await sendWorkspaceMessage(
      agent,
      { ...input, sessionId: 'bound-session', text: 'Next message' },
      { awaitPromptAdmission: true }
    )
    const fresh = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    expect(fresh.activeRun).toBeDefined()
    expect(fresh.promptPreparation).toBeDefined()
    expect(agent.sendPrompt).toHaveBeenCalledTimes(2)
    settlement.resolve()
    await flush()
    expect(rootTurnEnded).toHaveBeenCalledOnce()
    expect(providerDispatch).not.toHaveBeenCalled()
    const after = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    expect(after.activeRun).toEqual(fresh.activeRun)
    expect(after.promptPreparation).toEqual(fresh.promptPreparation)
    expect(after.messages.map(({ content }) => content)).toEqual(['First message', 'Next message'])
  })

  it('retains the submitted message when a failed cancellation release is retried', async () => {
    const main = mainBoundary()
    const originalSave = main.saveSession.getMockImplementation()!
    let failed = false
    main.saveSession.mockImplementation(async (candidate, options) => {
      if (
        !failed &&
        options?.conversationCommands?.some(
          (command) => command.kind === 'rollback-prompt' && command.preserveSubmittedMessage
        )
      ) {
        failed = true
        throw new Error('Storage temporarily unavailable')
      }
      return originalSave(candidate, options)
    })
    const agent = runtime()
    const response = gate()
    agent.sendPrompt.mockImplementationOnce(async () => {
      await response.promise
      throw new Error('Cancelled before admission')
    })
    agent.cancel.mockResolvedValueOnce(snapshot)
    await sendWorkspaceMessage(agent, input, { awaitPendingPreparation: true })
    await cancelWorkspaceRun(agent, 'bound-session')
    response.resolve()
    await flush()
    expect(failed).toBe(true)
    expect(main.read()?.activeRun).toBeDefined()
    expect(await retryPendingWorkspacePromptRollback('bound-session')).toEqual({ rolledBack: true })
    expect(main.read()?.activeRun).toBeUndefined()
    expect(main.read()?.promptPreparation).toBeUndefined()
    expect(main.read()?.messages.map(({ content }) => content)).toEqual(['First message'])
  })

  it('appends after a stopped branch dispatch without replacing the submitted replay prompt', async () => {
    const main = mainBoundary()
    Object.assign(window.api.sessions, {
      setDelegationPolicy: async () => structuredClone(main.read())
    })
    useSessionStore.getState().upsertPersistedSession(
      materializeSessionConversationGraph({
        id: 'source',
        projectId: 'project',
        cwd: '/workspace',
        status: 'idle',
        title: 'Source',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'history',
            role: 'user',
            content: 'History',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const agent = runtime()
    const response = gate()
    agent.sendPrompt.mockImplementationOnce(async () => {
      await response.promise
      throw new Error('ACP prompt start was cancelled before runtime turn admission')
    })
    agent.cancel.mockResolvedValueOnce(snapshot)
    await sendWorkspaceMessage(
      agent,
      { ...input, branchSourceSessionId: 'source' },
      { awaitPendingPreparation: true }
    )
    await cancelWorkspaceRun(agent, 'bound-session')
    response.resolve()
    await flush()
    const released = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    expect(released.messages.map(({ content }) => content)).toEqual(['History', 'First message'])
    expect(released.activeRun).toBeUndefined()
    expect(released.pendingContextReplayMessageId).toBeUndefined()
    await sendWorkspaceMessage(
      agent,
      { ...input, sessionId: 'bound-session', text: 'Next message' },
      { awaitPromptAdmission: true }
    )
    const after = useSessionStore.getState().sessions.find(({ id }) => id === 'bound-session')!
    expect(after.messages.map(({ content }) => content)).toEqual([
      'History',
      'First message',
      'Next message'
    ])
    await saveSessionInOrder(toPersistedSession(after))
    expect(main.read()?.messages.map(({ content }) => content)).toEqual([
      'History',
      'First message',
      'Next message'
    ])
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
    draftReceipt: 'signed-recovery-receipt',
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

it('preserves the Web upload receipt through pre-create Stop and draft storage recovery', async () => {
  mainBoundary()
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
  configureComposerDraftStorage('host/principal')
  const creating = gate()
  const agent = runtime()
  agent.createSession.mockImplementationOnce(async () => {
    await creating.promise
    return { sessionId: 'bound-session', cwd: '/workspace', frameworkId: 'codex' }
  })
  const staged = {
    id: 'upload-one',
    sessionId: '.pending',
    name: 'data.csv',
    originalName: 'data.csv',
    path: '/pending/data.csv',
    size: 5,
    draftReceipt: 'signed-recovery-receipt'
  }
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
  const pendingId = appended.mock.calls[0][0].sessionId
  await cancelWorkspaceRun(agent, pendingId)
  expect(stopped).toHaveBeenCalledExactlyOnceWith(pendingId, [staged])
  writeComposerDraft('project', pendingId, {
    doc: { nodes: [{ type: 'text', text: input.text }] },
    annotations: [],
    attachments: stopped.mock.calls[0][1],
    attachmentTransfers: [],
    automaticReadingEnabled: true
  })
  configureComposerDraftStorage('host/principal')
  expect(readComposerDraft('project', pendingId, 'Retry')?.attachmentTransfers).toEqual([
    expect.objectContaining({ recoveryReceipt: staged.draftReceipt })
  ])
  creating.resolve()
  await sending
  await flush()
  expect(agent.sendPrompt).not.toHaveBeenCalled()
})

it('restores a finalized upload with its current identity and original Web receipt', async () => {
  const main = mainBoundary()
  const saving = gate()
  const originalSave = main.saveSession.getMockImplementation()!
  main.saveSession.mockImplementation(async (candidate, options) => {
    if (options?.conversationCommands?.some(({ kind }) => kind === 'append-user'))
      await saving.promise
    return originalSave(candidate, options)
  })
  const staged = {
    id: 'upload-one',
    sessionId: '.pending',
    name: 'data.csv',
    originalName: 'data.csv',
    path: '/pending/data.csv',
    size: 5,
    draftReceipt: 'signed-recovery-receipt'
  }
  const finalized = {
    id: staged.id,
    sessionId: 'bound-session',
    name: staged.name,
    originalName: staged.originalName,
    path: '/durable/data.csv',
    size: 5,
    versionId: 'version-one',
    versionNumber: 1
  }
  Object.assign(window.api, { uploads: { finalizeSession: vi.fn(async () => [finalized]) } })
  const agent = runtime()
  const stopped = vi.fn()
  const sending = sendWorkspaceMessage(
    agent,
    { ...input, attachments: [staged], onPreparationCancelled: stopped },
    { awaitPendingPreparation: true }
  )
  await flush()
  await cancelWorkspaceRun(agent, 'bound-session')
  const recovered = stopped.mock.calls[0][1][0]
  expect(recovered).toMatchObject({
    id: staged.id,
    sessionId: 'bound-session',
    versionId: 'version-one',
    versionNumber: 1,
    draftReceipt: staged.draftReceipt
  })
  expect(parseUploadVersionReference(recovered.path)).toEqual({
    projectId: 'project',
    sessionId: 'bound-session',
    fileId: staged.id,
    versionId: 'version-one'
  })
  saving.resolve()
  await sending
  await flush()
  expect(agent.sendPrompt).not.toHaveBeenCalled()
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

describe('composer prompt admission callback', () => {
  it.each([false, true])(
    'reports only successful Main admission, provider rejection=%s',
    async (rejected) => {
      mainBoundary()
      const agent = runtime()
      if (rejected) agent.sendPrompt.mockRejectedValueOnce(new Error('Admission refused'))
      const appended = vi.fn()
      const accepted = vi.fn()
      await sendWorkspaceMessage(
        agent,
        { ...input, onMessageAppended: appended, onPromptAccepted: accepted },
        { awaitPendingPreparation: true }
      )
      await flush()
      expect(appended).toHaveBeenCalledOnce()
      expect(accepted).toHaveBeenCalledTimes(rejected ? 0 : 1)
    }
  )
})

it('notifies admission from Main before the model response finishes, exactly once', async () => {
  mainBoundary()
  const agent = runtime()
  const response = gate()
  agent.sendPrompt.mockImplementationOnce(async () => {
    await response.promise
    return snapshot
  })
  const accepted = vi.fn()
  const result = await sendWorkspaceMessage(
    agent,
    { ...input, onPromptAccepted: accepted },
    { awaitPendingPreparation: true }
  )
  expect(result).toBeDefined()
  expect(accepted).not.toHaveBeenCalled()
  const current = useSessionStore.getState().sessions.find(({ id }) => id === result!.sessionId)!
  const graph = current.conversationGraph!
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === current.id
        ? {
            ...session,
            runtimeSessionAdmissions: [
              {
                executionId: 'main-admitted',
                promptMessageId: result!.messageId,
                rootFrameId: graph.rootFrameId,
                agentFrameId: graph.rootFrameId,
                messageBranchId: graph.frames[0].activeBranchId,
                runtimeSegmentId: 'admitted-segment',
                promptRuntimeSegmentId: 'admitted-segment'
              }
            ]
          }
        : session
    )
  }))
  await flush()
  expect(accepted).toHaveBeenCalledOnce()
  response.resolve()
  await flush()
  expect(accepted).toHaveBeenCalledOnce()
})

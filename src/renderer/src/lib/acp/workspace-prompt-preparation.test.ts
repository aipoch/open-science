import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPromptPreparationOwner } from '../../../../main/session-persistence/prompt-preparation-owner'
import type { SessionConversationCommand } from '../../../../shared/session-conversation-command'
import {
  activateConversationBranch,
  forkEditedConversationMessage
} from '../../../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type PersistedRuntimeSessionAdmission
} from '../../../../shared/session-persistence'
import {
  discardPreparedSessionConversationIntents,
  captureSessionConversationIntents,
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
  resetSessionPersistenceWriteFailuresForTests,
  saveSessionInOrder,
  type SessionPersistenceApi
} from '../session-persistence/session-persistence'
import { prepareWorkspacePrompt, rollbackWorkspacePrompt } from './workspace-prompt-preparation'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'preparation-session',
    projectId: 'project',
    title: 'Existing history',
    cwd: '/workspace',
    status: 'error',
    error: 'Historical failure',
    errorReportable: false,
    agentFrameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    runtimeTranscriptOwner: 'main',
    messages: [
      {
        id: 'old',
        role: 'user',
        content: 'Existing question',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'failed', settledAt: 2, error: 'Historical failure' }
      }
    ]
  })
const current = (): PersistedChatSession =>
  toPersistedSession(useSessionStore.getState().sessions[0])
const branchId = (session: PersistedChatSession): string =>
  session.conversationGraph!.frames[0].activeBranchId
const admission = (
  session: PersistedChatSession,
  executionId: string
): PersistedRuntimeSessionAdmission => ({
  executionId,
  promptMessageId: 'old',
  promptRuntimeSegmentId: 'old-segment',
  rootFrameId: session.conversationGraph!.rootFrameId,
  agentFrameId: session.conversationGraph!.rootFrameId,
  messageBranchId: branchId(session),
  runtimeSegmentId: 'old-segment'
})
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Only the native save boundary is substituted: actual Main receipt/conditional rollback logic,
// renderer ordered queues, intent registry and durable projection all remain in the test path.
const mainAdapter = (
  initial = fixture()
): {
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
  read: () => PersistedChatSession
  commitConcurrent: (session: PersistedChatSession) => void
} => {
  const owner = new SessionPromptPreparationOwner()
  let durable = structuredClone(initial)
  const api = {
    saveSession: vi.fn<SessionPersistenceApi['saveSession']>(async (_candidate, options) => {
      const result = owner.apply(durable, options?.conversationCommands ?? [])
      durable = { ...result, runtimeTranscriptOwner: 'main', revision: (durable.revision ?? 0) + 1 }
      owner.observe(durable)
      return structuredClone(durable)
    }),
    saveManifest: vi.fn<SessionPersistenceApi['saveManifest']>(async () => undefined)
  }
  vi.stubGlobal('window', {
    api: { sessions: { ...api, loadOne: async () => structuredClone(durable) } }
  })
  useSessionStore.getState().hydrateSessions([structuredClone(initial)])
  return {
    api,
    read: () => structuredClone(durable),
    commitConcurrent: (session) => {
      durable = structuredClone(session)
      owner.observe(durable)
    }
  }
}

beforeEach(() => {
  resetSessionConversationIntentsForTests()
  resetSessionPersistenceWriteFailuresForTests()
  useSessionStore.setState(createInitialSessionState())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('workspace prompt preparation with Main rollback authority', () => {
  it('rolls back rearm of an existing failed prompt without requiring resumeRecovery', async () => {
    const original = fixture()
    const main = mainAdapter(original)
    const prep = await prepareWorkspacePrompt(current(), 'old', 'rearm')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'old',
      content: 'Existing question',
      rearmExisting: true,
      preparationId: prep.id
    })
    await saveSessionInOrder(current())
    expect(main.read().activeRun?.promptMessageId).toBe('old')
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(current().status).toBe('error')
    expect(current().error).toBe(original.error)
    expect(current().activeRun).toBeUndefined()
    expect(current().resumeRecovery).toBeUndefined()
    expect(current().conversationGraph?.messages).toEqual(original.conversationGraph?.messages)
  })

  it('preserves existing Branches and Artifacts plus an independently committed historical reply', async () => {
    const original = fixture()
    const originalBranch = branchId(original)
    const oldNode = original.conversationGraph!.messages[0]
    original.conversationGraph!.branches.push({
      id: 'parallel-history',
      agentFrameId: oldNode.agentFrameId,
      parentBranchId: originalBranch,
      forkMessageId: 'old',
      headMessageId: 'old',
      createdAt: 2,
      updatedAt: 2
    })
    original.artifacts = [
      {
        id: 'existing-artifact',
        kind: 'managed-file',
        name: 'existing.txt',
        path: '/artifacts/existing.txt'
      }
    ]
    const main = mainAdapter(original)
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    await saveSessionInOrder(current())
    const concurrent = main.read()
    const reply = {
      id: 'concurrent-reply',
      role: 'agent' as const,
      content: 'Committed response to prior question',
      status: 'complete' as const,
      eventIds: ['committed-event'],
      createdAt: 3,
      updatedAt: 3,
      agentFrameId: oldNode.agentFrameId,
      introducedOnBranchId: 'parallel-history',
      runtimeSegmentId: oldNode.runtimeSegmentId,
      parentMessageId: 'old',
      responseToMessageId: 'old',
      artifactIds: ['concurrent-artifact']
    }
    concurrent.conversationGraph!.messages.push(reply)
    concurrent.conversationGraph!.branches.find(
      ({ id }) => id === 'parallel-history'
    )!.headMessageId = reply.id
    concurrent.artifacts = [
      ...concurrent.artifacts!,
      {
        id: 'concurrent-artifact',
        kind: 'managed-file',
        name: 'committed.txt',
        path: '/artifacts/committed.txt'
      }
    ]
    main.commitConcurrent(concurrent)
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(current().conversationGraph!.messages.find(({ id }) => id === reply.id)).toEqual(reply)
    expect(current().conversationGraph!.messages.some(({ id }) => id === 'new')).toBe(false)
    expect(current().conversationGraph!.branches.map(({ id }) => id)).toEqual(
      original.conversationGraph!.branches.map(({ id }) => id)
    )
    expect(current().artifacts).toEqual(concurrent.artifacts)
    expect(main.read().conversationGraph!.messages.find(({ id }) => id === reply.id)).toEqual(reply)
  })
  it('preserves an unrelated pending Branch selection when discarding the submission intents', async () => {
    const original = fixture()
    const originalBranch = branchId(original)
    original.conversationGraph = activateConversationBranch(
      forkEditedConversationMessage(original.conversationGraph!, 'old', 'independent-branch', 2),
      originalBranch
    )
    const main = mainAdapter(original)
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    const selectionBaseline = main.read()
    captureSessionConversationIntents(selectionBaseline, {
      ...selectionBaseline,
      updatedAt: Date.now(),
      conversationGraph: activateConversationBranch(
        selectionBaseline.conversationGraph!,
        'independent-branch'
      )
    })
    const selection = pendingSessionConversationCommands(prep.sessionId).find(
      ({ kind }) => kind === 'select-branch'
    )!
    expect(selection.preparationId).toBeUndefined()
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(main.read().runtimeConversationCommandIds).toContain(selection.id)
    expect(branchId(main.read())).toBe('independent-branch')
    expect(current().conversationGraph?.messages.map(({ id }) => id)).toEqual(['old'])
    expect(pendingSessionConversationCommands(prep.sessionId)).toEqual([])
  })
  it('filters an already queued rejected preparation while retaining unrelated commands', async () => {
    const main = mainAdapter()
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    const tagged = pendingSessionConversationCommands(prep.sessionId)
    expect(tagged.map(({ kind }) => kind)).toEqual(['append-user', 'start-run'])
    expect(tagged.every(({ preparationId }) => preparationId === prep.id)).toBe(true)
    const unrelated: SessionConversationCommand = {
      kind: 'select-branch',
      id: 'independent-selection',
      timestamp: Date.now(),
      branchId: branchId(main.read()),
      previousBranchId: branchId(main.read())
    }
    const gate = deferred()
    let first = true
    const queueApi = {
      ...main.api,
      saveSession: vi.fn<SessionPersistenceApi['saveSession']>(async (snapshot, options) => {
        if (first) {
          first = false
          await gate.promise
        }
        return main.api.saveSession(snapshot, options)
      })
    }
    const queue = createOrderedSessionPersistence(queueApi)
    const blocker = queue.saveSession(main.read())
    const lateSave = queue.saveSession(current(), { conversationCommands: [...tagged, unrelated] })
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(pendingSessionConversationCommands(prep.sessionId)).toEqual([])
    gate.resolve()
    await Promise.all([blocker, lateSave])
    await queue.flush()
    expect(queueApi.saveSession.mock.calls[1][1]?.conversationCommands).toEqual([unrelated])
    expect(main.read().runtimeConversationCommandIds).toContain(unrelated.id)
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old'])
    expect(current().conversationGraph?.messages.map(({ id }) => id)).toEqual(['old'])
  })

  it('filters a failed queued snapshot when explicitly retried after rollback', async () => {
    const main = mainAdapter()
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    const submitted = current()
    const unrelated: SessionConversationCommand = {
      kind: 'select-branch',
      id: 'retained-selection',
      timestamp: Date.now(),
      branchId: branchId(main.read()),
      previousBranchId: branchId(main.read())
    }
    const staleOptions = {
      conversationCommands: [...pendingSessionConversationCommands(prep.sessionId), unrelated]
    }
    const failure = new Error('Native write rejected before commit')
    const queueApi = {
      ...main.api,
      saveSession: vi
        .fn<SessionPersistenceApi['saveSession']>()
        .mockRejectedValueOnce(failure)
        .mockImplementation(main.api.saveSession)
    }
    const queue = createOrderedSessionPersistence(queueApi)
    await expect(queue.saveSession(submitted, staleOptions)).rejects.toBe(failure)
    await expect(queue.flush()).rejects.toBe(failure)
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    await queue.saveSession(submitted, staleOptions)
    await queue.flush()
    expect(queueApi.saveSession.mock.calls[1][1]?.conversationCommands).toEqual([unrelated])
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old'])
    expect(main.read().runtimeConversationCommandIds).toContain(unrelated.id)
  })

  it.each([false, true])(
    'distinguishes a new same-prompt admission from historical executions (%s)',
    async (hasNewAdmission) => {
      const original = fixture()
      original.resumeRecovery = {
        kind: 'resume-required',
        promptMessageId: 'old',
        cause: 'app-restart'
      }
      original.runtimeSessionAdmissions = [admission(original, 'historical-execution')]
      const main = mainAdapter(original)
      const prep = await prepareWorkspacePrompt(current(), 'old', 'resume')
      useSessionStore.getState().appendUserMessage({
        sessionId: prep.sessionId,
        messageId: 'old',
        content: 'Existing question',
        rearmExisting: true,
        preparationId: prep.id
      })
      await saveSessionInOrder(current())
      if (hasNewAdmission)
        main.commitConcurrent({
          ...main.read(),
          runtimeSessionAdmissions: [
            ...main.read().runtimeSessionAdmissions!,
            admission(original, 'new-execution')
          ]
        })
      expect(await rollbackWorkspacePrompt(prep)).toBe(!hasNewAdmission)
      expect(main.read().messages.map(({ id }) => id)).toEqual(['old'])
      expect(current().messages.map(({ id }) => id)).toEqual(['old'])
      expect(main.read().runtimeSessionAdmissions?.map(({ executionId }) => executionId)).toEqual(
        hasNewAdmission ? ['historical-execution', 'new-execution'] : ['historical-execution']
      )
      expect(main.read().activeRun !== undefined).toBe(hasNewAdmission)
      if (!hasNewAdmission) expect(main.read().resumeRecovery).toEqual(original.resumeRecovery)
    }
  )

  it('uses Main rollback projection without reuniting a deleted optimistic node or losing history', async () => {
    const original = fixture()
    const main = mainAdapter(original)
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    await saveSessionInOrder(current())
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old', 'new'])
    main.commitConcurrent({ ...main.read(), title: 'Concurrent Main rename' })
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(current().title).toBe('Concurrent Main rename')
    expect(current().conversationGraph?.messages).toEqual(original.conversationGraph?.messages)
    expect(current().messages).toEqual(original.messages)
    expect(current().activeRun).toBeUndefined()
    expect(current().error).toBe(original.error)
    // Even replaying the pre-rollback snapshot cannot resurrect its discarded command identities.
    const snapshot = {
      ...current(),
      messages: [
        ...current().messages,
        {
          id: 'new',
          role: 'user' as const,
          content: 'Rejected question',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        }
      ]
    }
    discardPreparedSessionConversationIntents(prep.sessionId, prep.id)
    await saveSessionInOrder(snapshot)
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old'])
  })

  it('adopts Main rollback authority and reports it when a pending command conflicts with it', async () => {
    const main = mainAdapter()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    await saveSessionInOrder(current())
    const realSave = vi.mocked(main.api.saveSession).getMockImplementation()!
    let followUp: SessionConversationCommand | undefined
    vi.mocked(main.api.saveSession).mockImplementation(async (candidate, options) => {
      const saved = await realSave(candidate, options)
      if (options?.conversationCommands?.some(({ kind }) => kind === 'rollback-prompt')) {
        // A follow-up queued on top of the rejected prompt while the rollback write was in flight
        // has a parent that Main's committed authority no longer contains.
        const graph = saved.conversationGraph!
        const template = graph.messages[0]
        captureSessionConversationIntents(saved, {
          ...saved,
          updatedAt: Date.now(),
          conversationGraph: {
            ...graph,
            messages: [
              ...graph.messages,
              {
                ...template,
                id: 'follow-up',
                content: 'Follow-up on the rejected prompt',
                parentMessageId: 'new'
              }
            ]
          }
        })
        followUp = pendingSessionConversationCommands(prep.sessionId).find(
          ({ kind }) => kind === 'append-user'
        )
      }
      return saved
    })
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(current().conversationGraph?.messages.some(({ id }) => id === 'new')).toBe(false)
    expect(current().messages.some(({ id }) => id === 'new')).toBe(false)
    expect(current().activeRun).toBeUndefined()
    expect(current().status).not.toBe('running')
    expect(warn).toHaveBeenCalledWith(
      'Pending conversation commands could not replay on the rollback authority',
      expect.anything()
    )
    // Only the conflicting command stays unapplied; it is not acknowledged or erased.
    expect(followUp).toBeDefined()
    expect(pendingSessionConversationCommands(prep.sessionId).map(({ id }) => id)).toContain(
      followUp!.id
    )
  })

  it('retains rollback authority when the rollback write fails and succeeds on explicit retry', async () => {
    const main = mainAdapter()
    const prep = await prepareWorkspacePrompt(current(), 'new', 'new')
    useSessionStore.getState().appendUserMessage({
      sessionId: prep.sessionId,
      messageId: 'new',
      content: 'Rejected question',
      preparationId: prep.id
    })
    await saveSessionInOrder(current())
    const failure = new Error('Rollback save unavailable')
    vi.mocked(main.api.saveSession).mockRejectedValueOnce(failure)
    await expect(rollbackWorkspacePrompt(prep)).rejects.toBe(failure)
    expect(pendingSessionConversationCommands(prep.sessionId)).toEqual([])
    expect(current().messages.some(({ id }) => id === 'new')).toBe(true)
    expect(await rollbackWorkspacePrompt(prep)).toBe(true)
    expect(current().messages.map(({ id }) => id)).toEqual(['old'])
    expect(main.read().messages.map(({ id }) => id)).toEqual(['old'])
  })
})

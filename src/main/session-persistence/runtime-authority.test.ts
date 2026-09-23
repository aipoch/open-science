import { describe, expect, it, vi } from 'vitest'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { SessionPersistenceStateOwner } from './state-owner'
import { SessionProjectionAfterCommitError } from './save-session'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { forkEditedConversationMessage } from '../../shared/conversation-graph'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'running',
    agentFrameworkId: 'codex',
    revision: 7,
    createdAt: 1,
    updatedAt: 2,
    activeRun: { promptMessageId: 'prompt', startedAt: 2 },
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  } satisfies PersistedChatSession)

// Test harness exposes typed Vitest spies whose signatures are inferred together.
const harness = (
  initial: PersistedChatSession = fixture(),
  uploads?: ConstructorParameters<typeof SessionPersistenceStateOwner>[0]['uploads']
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
) => {
  let durable = structuredClone(initial)
  let projectionFailure = false
  const saveSession = vi.fn(async (candidate: PersistedChatSession, expected?: number) => {
    expect(expected ?? candidate.revision).toBe(durable.revision)
    durable = structuredClone({ ...candidate, revision: (durable.revision ?? 0) + 1 })
    if (projectionFailure) throw new SessionProjectionAfterCommitError(durable, new Error('secret'))
    return structuredClone(durable)
  })
  const syncSession = vi.fn(async () => [])
  const publish = vi.fn()
  const owner = new SessionPersistenceStateOwner({
    repository: {
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      saveSession
    },
    fileIndex: { syncSession },
    ...(uploads ? { uploads } : {}),
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: publish,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  return {
    owner,
    saveSession,
    syncSession,
    publish,
    durable: () => structuredClone(durable),
    failProjection: () => {
      projectionFailure = true
    }
  }
}
const scope = { projectId: 'p', sessionId: 's' }

describe('Main runtime Session authority', () => {
  it('rejects stale snapshot replacement while applying only explicit preference intent', async () => {
    const h = harness()
    const stale = h.durable()
    const owned = await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined,
      artifacts: [{ id: 'version', kind: 'managed-file', versionId: 'version', path: '/result' }],
      filesRevision: 1
    }))
    const saved = await h.owner.saveSession(
      { ...stale, title: 'Renamed', status: 'error', error: 'stale error' },
      { conflictRebaseFields: ['title'] }
    )
    expect(saved).toMatchObject({
      title: 'Renamed',
      status: 'idle',
      runtimeTranscriptOwner: 'main',
      artifacts: owned.artifacts,
      filesRevision: 1,
      runtimeTranscriptLastRun: stale.activeRun
    })
    expect(saved.activeRun).toBeUndefined()
    expect(saved.error).toBeUndefined()
    expect(saved.conversationGraph).toEqual(owned.conversationGraph)
    const revision = saved.revision
    expect((await h.owner.saveSession(stale)).revision).toBe(revision)
  })

  it('preserves known commits when catalog, file index, or observer updates fail', async () => {
    const h = harness()
    h.failProjection()
    h.syncSession.mockRejectedValueOnce(new Error('index unavailable'))
    h.publish.mockImplementationOnce(() => {
      throw new Error('observer unavailable')
    })
    const committed = await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined
    }))
    expect(committed).toEqual(h.durable())
    expect(committed).toMatchObject({ revision: 8, runtimeTranscriptOwner: 'main', status: 'idle' })
    expect(h.saveSession).toHaveBeenCalledTimes(1)
    await h.owner.mutateRuntimeSession(scope, (latest) => latest)
    expect(h.saveSession).toHaveBeenCalledTimes(1)
  })

  it('admits the next Task prompt and provider binding through Main after adoption', async () => {
    const h = harness()
    await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined
    }))
    const bound = await h.owner.bindTaskSession({
      session: { ...h.durable(), providerSessionId: 'provider-new' },
      contextReset: true
    })
    expect(bound.providerSessionId).toBe('provider-new')
    const prepared = {
      ...bound,
      activeRun: { promptMessageId: 'next', startedAt: 10 },
      messages: [
        ...bound.messages,
        {
          id: 'next',
          role: 'user' as const,
          content: 'Continue',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 10,
          updatedAt: 10
        }
      ]
    }
    const admitted = await h.owner.admitTaskTurn({ session: prepared, contextReset: true })
    expect(admitted.activeRun?.promptMessageId).toBe('next')
    expect(admitted.messages.at(-1)?.id).toBe('next')
    expect(admitted.conversationGraph?.messages.some(({ id }) => id === 'next')).toBe(true)
  })

  it('Task settlement only writes its witness and does not change a superseding run', async () => {
    const h = harness()
    const settled = await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined
    }))
    const command = {
      ...scope,
      promptMessageId: 'prompt',
      taskRunCommitId: 'task-1',
      artifacts: [],
      updatedAt: 12
    }
    const receipt = await h.owner.settleTaskCompletion(command)
    expect(receipt).toEqual({ ...settled, revision: 9, taskRunCommitId: 'task-1' })
    const newer = await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      activeRun: { promptMessageId: 'next', startedAt: 13 },
      status: 'running'
    }))
    expect(
      await h.owner.failTaskRun({ ...command, taskRunCommitId: 'late-task', error: 'late failure' })
    ).toEqual(newer)
    expect(h.durable()).toEqual(newer)
  })

  it('accepts an exact hidden Main reply without overwriting a newer completed turn witness', async () => {
    const seed = fixture()
    const prompt = seed.conversationGraph!.messages[0]
    const runScope = {
      promptMessageId: prompt.id,
      agentFrameId: prompt.agentFrameId,
      messageBranchId: prompt.introducedOnBranchId,
      runtimeSegmentId: prompt.runtimeSegmentId!
    }
    const completed = applyRuntimeSessionEvents(seed, runScope, [
      {
        id: 'old-reply-chunk',
        kind: 'message',
        level: 'info',
        sessionId: 's',
        promptMessageId: prompt.id,
        messageId: 'old-reply',
        role: 'assistant',
        text: 'Old result',
        timestamp: 3
      },
      {
        id: 'old-stop',
        kind: 'stop',
        level: 'info',
        sessionId: 's',
        promptMessageId: prompt.id,
        timestamp: 4
      }
    ])
    completed.runtimeTranscriptOwner = 'main'
    completed.runtimeTranscriptLastRun = { promptMessageId: 'newer-prompt', startedAt: 20 }
    completed.taskRunCommitId = 'newer-task'
    completed.messages = []
    const oldReplyId = completed.conversationGraph!.messages.find(
      (message) => message.role === 'agent' && message.responseToMessageId === prompt.id
    )!.id
    const h = harness(completed)

    const receipt = await h.owner.settleTaskCompletion({
      ...scope,
      promptMessageId: prompt.id,
      taskRunCommitId: 'old-task',
      messageId: oldReplyId,
      artifacts: [],
      updatedAt: 30
    })

    expect(receipt).toEqual(completed)
    expect(h.durable()).toEqual(completed)
    expect(h.saveSession).not.toHaveBeenCalled()
  })

  it('does not downgrade a completed Task after its witness JSON commits but catalog update fails', async () => {
    const h = harness()
    await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined
    }))
    h.failProjection()
    const saved = await h.owner.settleTaskCompletion({
      ...scope,
      promptMessageId: 'prompt',
      taskRunCommitId: 'task-commit',
      artifacts: [],
      updatedAt: 12
    })
    expect(saved).toMatchObject({ taskRunCommitId: 'task-commit', status: 'idle' })
    expect(saved).toEqual(h.durable())
  })

  it('terminalizes interrupted Main messages and tools without losing their files', async () => {
    const seed = fixture()
    const prompt = seed.conversationGraph!.messages[0]
    const runScope = {
      promptMessageId: prompt.id,
      agentFrameId: prompt.agentFrameId,
      messageBranchId: prompt.introducedOnBranchId,
      runtimeSegmentId: prompt.runtimeSegmentId!
    }
    const active = applyRuntimeSessionEvents(seed, runScope, [
      {
        id: 'chunk',
        kind: 'message',
        level: 'info',
        sessionId: 's',
        promptMessageId: 'prompt',
        messageId: 'stream',
        role: 'assistant',
        text: 'Partial result',
        timestamp: 3
      },
      {
        id: 'tool-event',
        kind: 'tool',
        level: 'info',
        sessionId: 's',
        promptMessageId: 'prompt',
        toolCallId: 'tool',
        title: 'Analysis',
        status: 'in_progress',
        timestamp: 4
      }
    ])
    active.runtimeTranscriptOwner = 'main'
    active.artifacts = [
      { id: 'file-version', versionId: 'file-version', kind: 'managed-file', path: '/result' }
    ]
    const h = harness(active)
    const failed = await h.owner.failTaskRun({
      ...scope,
      promptMessageId: 'prompt',
      taskRunCommitId: 'interrupted-task',
      artifacts: [],
      error: 'Interrupted',
      errorReportable: false,
      updatedAt: 20
    })
    expect(failed.messages.find((message) => message.role === 'agent')).toMatchObject({
      content: 'Partial result',
      status: 'error',
      failedAt: 20
    })
    expect(failed.activities).toContainEqual(expect.objectContaining({ status: 'failed' }))
    expect(failed.artifacts).toEqual(active.artifacts)
    expect(failed).toMatchObject({
      status: 'error',
      errorReportable: false,
      taskRunCommitId: 'interrupted-task',
      runtimeTranscriptLastRun: active.activeRun
    })
    expect(failed.activeRun).toBeUndefined()
  })
  it('preserves abc when a stale renderer submits ab from the same stream', async () => {
    const seed = fixture()
    const prompt = seed.conversationGraph!.messages[0]
    const runScope = {
      promptMessageId: prompt.id,
      agentFrameId: prompt.agentFrameId,
      messageBranchId: prompt.introducedOnBranchId,
      runtimeSegmentId: prompt.runtimeSegmentId!
    }
    const base = applyRuntimeSessionEvents(seed, runScope, [
      {
        id: 'a',
        kind: 'message',
        level: 'info',
        sessionId: 's',
        promptMessageId: 'prompt',
        messageId: 'stream',
        role: 'assistant',
        text: 'a',
        timestamp: 3
      }
    ])
    base.runtimeTranscriptOwner = 'main'
    const h = harness(base)
    await h.owner.mutateRuntimeSession(scope, (latest) =>
      applyRuntimeSessionEvents(latest, runScope, [
        {
          id: 'bc',
          kind: 'message',
          level: 'info',
          sessionId: 's',
          promptMessageId: 'prompt',
          messageId: 'stream',
          role: 'assistant',
          text: 'bc',
          timestamp: 5
        }
      ])
    )
    const stale = structuredClone(base)
    stale.messages.at(-1)!.content = 'ab'
    stale.messages.at(-1)!.updatedAt = 9999
    const saved = await h.owner.saveSession(stale)
    expect(saved.messages.at(-1)?.content).toBe('abc')
    expect(saved.conversationGraph!.messages.at(-1)?.eventIds).toEqual(['a', 'bc'])
    expect(h.saveSession).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy Upload lifecycle validation in user-command admission', async () => {
    const initial = {
      ...fixture(),
      runtimeTranscriptOwner: 'main' as const,
      activeRun: undefined,
      status: 'idle' as const
    }
    const upgrade = vi.fn(async (candidate: PersistedChatSession) => candidate)
    const h = harness(initial, { upgradeLegacySessionUploads: upgrade })
    const message = {
      id: 'next-upload',
      role: 'user' as const,
      content: 'Read file',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 10,
      updatedAt: 10,
      uploads: [
        {
          id: 'legacy-upload',
          sessionId: 's',
          name: 'data.txt',
          originalName: 'data.txt',
          path: '/legacy/data.txt',
          size: 5
        }
      ]
    }
    const branch = initial.conversationGraph!.branches[0]
    const options = {
      conversationCommands: [
        {
          id: 'append-upload',
          kind: 'append-user' as const,
          timestamp: 10,
          branchId: branch.id,
          parentMessageId: branch.headMessageId,
          message
        }
      ]
    }
    upgrade.mockRejectedValueOnce(new Error('Legacy source cannot be verified'))
    await expect(h.owner.saveSession(initial, options)).rejects.toThrow(
      'Legacy source cannot be verified'
    )
    expect(h.saveSession).not.toHaveBeenCalled()
    const saved = await h.owner.saveSession(initial, options)
    expect(saved.messages.at(-1)?.uploads).toEqual(message.uploads)
    expect(upgrade).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeTranscriptOwner: 'main' }),
      { mode: 'live-save' }
    )
  })

  it('defers an edited Branch until Main commits the active run terminal state', async () => {
    const h = harness({ ...fixture(), runtimeTranscriptOwner: 'main' })
    const initial = h.durable()
    const parentBranchId = initial.conversationGraph!.branches[0].id
    const branchId = 'edited-branch'
    const localGraph = forkEditedConversationMessage(
      initial.conversationGraph!,
      'prompt',
      branchId,
      10
    )
    const edited = {
      ...initial,
      status: 'idle' as const,
      activeRun: undefined,
      conversationGraph: localGraph
    }
    const options = {
      conversationCommands: [
        {
          id: 'edit-while-terminal-save-races',
          kind: 'fork-message' as const,
          branchId,
          parentBranchId,
          messageId: 'prompt',
          timestamp: 10
        }
      ]
    }

    await expect(h.owner.saveSession(edited, options)).resolves.toMatchObject({
      activeRun: { promptMessageId: 'prompt' },
      conversationGraph: initial.conversationGraph
    })
    expect(h.saveSession).not.toHaveBeenCalled()

    await h.owner.mutateRuntimeSession(scope, (latest) => ({
      ...latest,
      status: 'idle',
      activeRun: undefined
    }))
    const saved = await h.owner.saveSession(edited, options)
    expect(saved.conversationGraph?.branches).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: branchId })])
    )
  })
})

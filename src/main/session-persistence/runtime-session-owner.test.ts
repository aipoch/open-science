import { describe, expect, it, vi } from 'vitest'

import { AcpPermissionWaitOwner } from '../acp/permission-wait-owner'
import { continueInterruptedTurn } from '../acp/interrupted-turn-continuation'
import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import {
  normalizeSessionFile,
  type DelegatedMessageCommand,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  RuntimeSessionArtifactPublicationError,
  RuntimeSessionOwner,
  type RuntimeSessionTurnScope
} from './runtime-session-owner'

const scope = (suffix = '1'): RuntimeSessionTurnScope => ({
  projectId: 'project-1',
  sessionId: `session-${suffix}`,
  promptMessageId: `prompt-${suffix}`,
  agentFrameId: `frame-${suffix}`,
  messageBranchId: `branch-${suffix}`,
  runtimeSegmentId: `segment-${suffix}`,
  executionId: `execution-${suffix}`
})

const session = (turn = scope()): PersistedChatSession => ({
  id: turn.sessionId,
  projectId: turn.projectId,
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  messages: [
    {
      id: turn.promptMessageId,
      role: 'user',
      content: 'Prompt',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  activeRun: { promptMessageId: turn.promptMessageId, startedAt: 1 },
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: turn.agentFrameId,
    activeFrameId: turn.agentFrameId,
    frames: [
      {
        id: turn.agentFrameId,
        originBindingState: 'root',
        kind: 'root',
        status: 'running',
        activeBranchId: turn.messageBranchId,
        createdAt: 1
      }
    ],
    branches: [
      {
        id: turn.messageBranchId,
        agentFrameId: turn.agentFrameId,
        headMessageId: turn.promptMessageId,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    messages: [
      {
        id: turn.promptMessageId,
        role: 'user',
        content: 'Prompt',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        agentFrameId: turn.agentFrameId,
        introducedOnBranchId: turn.messageBranchId,
        revisionRootMessageId: turn.promptMessageId,
        runtimeSegmentId: turn.runtimeSegmentId
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: [
      {
        id: turn.runtimeSegmentId,
        agentFrameId: turn.agentFrameId,
        frameworkId: 'codex',
        startedAt: 1
      }
    ]
  },
  createdAt: 1,
  updatedAt: 1
})

const messageEvent = (
  turn: RuntimeSessionTurnScope,
  id: string,
  text: string
): AcpRuntimeEvent => ({
  id,
  timestamp: 2,
  kind: 'message',
  level: 'info',
  sessionId: turn.sessionId,
  promptMessageId: turn.promptMessageId,
  messageId: `stream-${turn.promptMessageId}`,
  role: 'assistant',
  text
})

// The app-owned `ask_user_question` activity as it reaches the runtime: pending while the card
// waits, answered once the user submits an answer.
const questionEvent = (
  turn: RuntimeSessionTurnScope,
  state: 'pending' | 'answered',
  timestamp: number
): AcpRuntimeEvent => ({
  id: `question-${state}`,
  timestamp,
  kind: 'tool',
  level: 'info',
  sessionId: turn.sessionId,
  promptMessageId: turn.promptMessageId,
  toolCallId: 'call-ask-user-question',
  title: 'Ask the user to choose',
  status: state === 'pending' ? 'in_progress' : 'completed',
  providerToolName: 'ask_user_question',
  elicitation: {
    state,
    message: 'Which dataset?',
    fields: [{ id: 'answer', label: 'Dataset', kind: 'text' }],
    ...(state === 'answered' ? { respondedAt: timestamp } : {}),
    durable: {
      kind: 'agent-user-choice',
      requestId: 'request-1',
      promptMessageId: turn.promptMessageId
    }
  }
})

const stopEvent = (turn: RuntimeSessionTurnScope, timestamp: number): AcpRuntimeEvent => ({
  id: 'question-stop',
  timestamp,
  kind: 'stop',
  level: 'info',
  sessionId: turn.sessionId,
  promptMessageId: turn.promptMessageId,
  title: 'Prompt stopped',
  text: 'end_turn'
})

const artifact = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'pending-version',
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'run-1',
  name: 'result.txt',
  path: '/workspace/.pending/result.txt',
  fileUrl: 'artifact://pending-version',
  size: 5,
  mtimeMs: 3,
  ...overrides
})

// The inferred return preserves the concrete Vitest mock call signatures used by failure tests.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (initial = [session()]) => {
  const sessions = new Map(initial.map((value) => [value.id, structuredClone(value)]))
  const scheduled: Array<() => void> = []
  const mutateSession = vi.fn(
    async (
      turn: RuntimeSessionTurnScope,
      mutate: (latest: PersistedChatSession) => PersistedChatSession
    ) => {
      const latest = sessions.get(turn.sessionId)
      if (!latest) throw new Error('missing')
      const next = mutate(structuredClone(latest))
      sessions.set(turn.sessionId, structuredClone(next))
      return next
    }
  )
  const finalizeArtifacts = vi.fn(async () => [
    artifact({
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      path: '/workspace/result.txt',
      fileUrl: 'artifact://version-1'
    })
  ])
  const owner = new RuntimeSessionOwner({
    loadSession: async (turn) => structuredClone(sessions.get(turn.sessionId)),
    mutateSession,
    finalizeArtifacts,
    scheduleFlush: (flush) => {
      scheduled.push(flush)
      return () => undefined
    },
    now: () => 10
  })
  return { owner, sessions, scheduled, mutateSession, finalizeArtifacts }
}

const parentMessageSession = (): PersistedChatSession => {
  const turn = scope()
  const durable = session()
  delete durable.activeRun
  durable.status = 'idle'
  durable.runtimeContext = {
    version: 1,
    revision: 1,
    delegatedWork: {
      records: [],
      messageCommands: [
        {
          messageId: 'message-1',
          requestId: 'request-1',
          sourcePrincipal: 'child',
          canonicalDigest: 'digest',
          sourceFrameId: 'child-1',
          sourceAttemptId: 'attempt-1',
          targetFrameId: turn.agentFrameId,
          rootOriginMessageId: turn.promptMessageId,
          callerRootMessageId: turn.promptMessageId,
          rootBranchId: turn.messageBranchId,
          rootBranchRevision: 'branch-1:1',
          direction: 'to_parent',
          disposition: 'message',
          text: 'Child question',
          kind: 'question',
          laneSequence: 1,
          queuedAt: 2,
          receipt: { status: 'queued', dispatchStartedAt: 3, dispatchEpoch: 'epoch-1' }
        }
      ]
    }
  }
  return durable
}

describe('RuntimeSessionOwner', () => {
  it('durably admits a fenced parent message without adding a user message', async () => {
    const turn = { ...scope(), runtimeSegmentId: 'delegated-message-message-1' }
    const durable = parentMessageSession()
    const { owner, sessions } = harness([durable])
    await owner.begin(turn, { delegatedMessageId: 'message-1', agentFrameworkId: 'opencode' })
    const admitted = sessions.get(turn.sessionId)!
    expect(admitted.activeRun).toEqual({ promptMessageId: turn.promptMessageId, startedAt: 10 })
    expect(admitted.conversationGraph!.runtimeSegments.at(-1)).toMatchObject({
      id: turn.runtimeSegmentId,
      frameworkId: 'opencode',
      startedAt: 10
    })
    expect(admitted.conversationGraph!.messages).toEqual(durable.conversationGraph!.messages)
    expect(admitted).not.toHaveProperty('delegatedMessageId')
    owner.accept({ ...messageEvent(turn, 'continued-message', 'Main answer'), timestamp: 11 })
    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(
      sessions.get(turn.sessionId)!.messages.some(({ content }) => content === 'Main answer')
    ).toBe(true)
    await expect(
      owner.begin({ ...turn, executionId: 'replay' }, { delegatedMessageId: 'message-1' })
    ).rejects.toThrow()
  })

  it.each(['missing', 'unfenced', 'accepted', 'uncertain', 'wrong-origin', 'inactive-branch'])(
    'rejects %s parent-message admission',
    async (scenario) => {
      const turn = { ...scope(), runtimeSegmentId: 'delegated-message-message-1' }
      const durable = parentMessageSession()
      const existing = durable.runtimeContext!.delegatedWork!.messageCommands![0]
      const command: DelegatedMessageCommand = {
        ...existing,
        rootOriginMessageId: scenario === 'wrong-origin' ? 'other' : turn.promptMessageId,
        receipt:
          scenario === 'accepted'
            ? { status: 'accepted', acceptedAt: 4, evidence: 'provider_prompt_accepted' }
            : scenario === 'uncertain'
              ? { status: 'uncertain', uncertainAt: 4, resolution: 'pending' }
              : scenario === 'unfenced'
                ? { status: 'queued' }
                : existing.receipt
      }
      durable.runtimeContext = {
        version: 1,
        revision: 1,
        delegatedWork: { records: [], messageCommands: scenario === 'missing' ? [] : [command] }
      }
      if (scenario === 'inactive-branch')
        durable.conversationGraph!.frames[0].activeBranchId = 'other'
      const { owner, mutateSession } = harness([durable])
      await expect(owner.begin(turn, { delegatedMessageId: 'message-1' })).rejects.toThrow()
      expect(mutateSession).not.toHaveBeenCalled()
    }
  )

  it('revalidates the parent branch in the serialized admission write', async () => {
    const turn = { ...scope(), runtimeSegmentId: 'delegated-message-message-1' }
    const { owner, sessions, mutateSession } = harness([parentMessageSession()])
    const mutate = mutateSession.getMockImplementation()!
    mutateSession.mockImplementationOnce(async (scope, update) => {
      sessions.get(scope.sessionId)!.conversationGraph!.frames[0].activeBranchId = 'other'
      return mutate(scope, update)
    })
    await expect(owner.begin(turn, { delegatedMessageId: 'message-1' })).rejects.toThrow(
      'no admissible parent message'
    )
    expect(sessions.get(turn.sessionId)!.activeRun).toBeUndefined()
    expect(sessions.get(turn.sessionId)!.conversationGraph!.runtimeSegments).toHaveLength(1)
  })

  it('rejects a turn whose exact durable prompt path is missing', async () => {
    const turn = scope()
    const malformed = session(turn)
    malformed.conversationGraph!.runtimeSegments = []
    const { owner } = harness([malformed])

    await expect(owner.begin(turn)).rejects.toThrow('no durable prompt path')
  })

  it('commits provider binding at admission and consumes replay only after acceptance', async () => {
    const turn = scope()
    const durable = session(turn)
    durable.pendingHistoryReplay = { kind: 'all' }
    durable.branchContextResetRequired = true
    const { owner, sessions } = harness([durable])

    await owner.begin(turn, {
      providerSessionId: 'provider-1',
      providerContinuityToken: 'continuity-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'backend-1',
      agentModel: 'model-1',
      reviewOwner: 'task'
    })
    expect(sessions.get(turn.sessionId)).toMatchObject({
      providerSessionId: 'provider-1',
      providerContinuityToken: 'continuity-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'backend-1',
      agentModel: 'model-1',
      runtimeTranscriptReviewOwner: {
        promptMessageId: turn.promptMessageId,
        owner: 'task'
      },
      pendingHistoryReplay: { kind: 'all' },
      branchContextResetRequired: true
    })

    await owner.consumeReplay(turn.sessionId, turn.promptMessageId)
    expect(sessions.get(turn.sessionId)?.pendingHistoryReplay).toBeUndefined()
    expect(sessions.get(turn.sessionId)?.branchContextResetRequired).toBeUndefined()
  })

  it('defaults direct runtime turns to renderer review ownership', async () => {
    const turn = scope()
    const { owner, sessions } = harness()

    await owner.begin(turn)

    expect(sessions.get(turn.sessionId)?.runtimeTranscriptReviewOwner).toEqual({
      promptMessageId: turn.promptMessageId,
      owner: 'renderer'
    })
  })

  it('retains a failed replay-consumption intent until the terminal transcript flush', async () => {
    const turn = scope()
    const durable = session(turn)
    durable.pendingHistoryReplay = { kind: 'all' }
    durable.branchContextResetRequired = true
    const { owner, mutateSession, sessions } = harness([durable])
    await owner.begin(turn)
    mutateSession.mockRejectedValueOnce(new Error('temporary Session write failure'))

    await expect(owner.consumeReplay(turn.sessionId, turn.promptMessageId)).rejects.toThrow(
      'temporary Session write failure'
    )
    owner.accept({
      id: 'terminal-after-accepted-provider',
      timestamp: 5,
      kind: 'stop',
      level: 'info',
      sessionId: turn.sessionId,
      promptMessageId: turn.promptMessageId,
      title: 'Prompt stopped',
      text: 'end_turn'
    })
    await owner.flush(turn.sessionId, turn.promptMessageId)

    expect(sessions.get(turn.sessionId)?.pendingHistoryReplay).toBeUndefined()
    expect(sessions.get(turn.sessionId)?.branchContextResetRequired).toBeUndefined()
    expect(sessions.get(turn.sessionId)?.status).toBe('idle')
  })

  it('batches, deduplicates, and isolates events by registered turn', async () => {
    const first = scope('1')
    const second = scope('2')
    const { owner, mutateSession, sessions } = harness([session(first), session(second)])
    await owner.begin(first)
    await owner.begin(second)

    owner.accept(messageEvent(first, 'event-1', 'a'))
    owner.accept(messageEvent(first, 'event-1', 'a'))
    owner.accept(messageEvent(first, 'event-2', 'b'))
    owner.accept(messageEvent({ ...first, promptMessageId: 'stale' }, 'stale', 'no'))
    owner.accept(messageEvent(second, 'event-3', 'other'))

    await owner.flush(first.sessionId, first.promptMessageId)
    expect(mutateSession).toHaveBeenCalledTimes(3)
    expect(sessions.get(first.sessionId)?.messages.at(-1)?.content).toBe('ab')
    expect(sessions.get(second.sessionId)?.messages).toHaveLength(1)

    await owner.flush(second.sessionId, second.promptMessageId)
    expect(mutateSession).toHaveBeenCalledTimes(4)
    expect(sessions.get(second.sessionId)?.messages.at(-1)?.content).toBe('other')
  })

  it('releases streaming event identities after their durable batch commits', async () => {
    const turn = scope()
    const { owner, mutateSession } = harness()
    await owner.begin(turn)
    for (let index = 0; index < 1_000; index += 1) {
      owner.accept(messageEvent(turn, `event-${index}`, 'x'))
    }

    await owner.flush(turn.sessionId, turn.promptMessageId)

    expect(mutateSession).toHaveBeenCalledTimes(2)
    const retained = owner as unknown as {
      turns: Map<string, { acceptedEventIds: Set<string> }>
    }
    expect([...retained.turns.values()][0]?.acceptedEventIds.size).toBe(0)
  })

  it('ignores a republished main-owned terminal after flush when a newer durable run begins', async () => {
    const first = scope()
    const second: RuntimeSessionTurnScope = {
      ...first,
      promptMessageId: 'prompt-2',
      executionId: 'execution-2'
    }
    const { owner, sessions, mutateSession } = harness()
    const terminal: AcpRuntimeEvent = {
      id: 'terminal-1',
      timestamp: 5,
      kind: 'stop',
      level: 'info',
      sessionId: first.sessionId,
      promptMessageId: first.promptMessageId,
      title: 'Prompt stopped',
      text: 'end_turn'
    }
    await owner.begin(first)
    owner.accept(terminal)
    await owner.flush(first.sessionId, first.promptMessageId)
    expect(mutateSession).toHaveBeenCalledTimes(2)

    // A transport that preserves the original identity but omits the ownership marker must still
    // not enqueue the already-durable terminal after streaming IDs have been released.
    owner.accept(terminal)
    await owner.flush(first.sessionId, first.promptMessageId)
    expect(mutateSession).toHaveBeenCalledTimes(2)

    // Coordinator publication scopes the already-durable event with a runtime-specific identity.
    // Main ownership, rather than the transport ID, fences it from durability a second time.
    owner.accept({
      ...terminal,
      id: `runtime-2:${terminal.id}`,
      publicationOwner: 'main'
    })
    const durable = sessions.get(first.sessionId)!
    const secondPrompt = {
      id: second.promptMessageId,
      role: 'user' as const,
      content: 'Next prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 10,
      updatedAt: 10
    }
    durable.messages.push(secondPrompt)
    durable.conversationGraph!.messages.push({
      ...secondPrompt,
      agentFrameId: second.agentFrameId,
      introducedOnBranchId: second.messageBranchId,
      revisionRootMessageId: second.promptMessageId,
      runtimeSegmentId: second.runtimeSegmentId
    })
    durable.conversationGraph!.branches[0].headMessageId = second.promptMessageId
    durable.activeRun = { promptMessageId: second.promptMessageId, startedAt: 10 }
    durable.status = 'running'

    await expect(owner.begin(second)).resolves.toMatchObject({
      activeRun: { promptMessageId: second.promptMessageId }
    })
    await owner.flush(first.sessionId, first.promptMessageId)
    expect(sessions.get(first.sessionId)?.activeRun?.promptMessageId).toBe(second.promptMessageId)
  })

  it('retains the same failed batch for an explicit flush replay', async () => {
    const turn = scope()
    const { owner, mutateSession, sessions } = harness()
    await owner.begin(turn)
    owner.accept(messageEvent(turn, 'event-1', 'kept'))
    mutateSession.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(owner.flush(turn.sessionId, turn.promptMessageId)).rejects.toThrow(
      'disk unavailable'
    )
    expect(sessions.get(turn.sessionId)?.messages).toHaveLength(1)

    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(mutateSession).toHaveBeenCalledTimes(3)
    expect(sessions.get(turn.sessionId)?.messages.at(-1)?.content).toBe('kept')
  })

  it('stages proof, finalizes once, and reports a committed fact when final projection fails', async () => {
    const turn = scope()
    const { owner, mutateSession, finalizeArtifacts, sessions } = harness()
    await owner.begin(turn)
    mutateSession.mockImplementationOnce(mutateSession.getMockImplementation()!)
    mutateSession.mockRejectedValueOnce(new Error('index unavailable'))
    const publication = {
      appSessionId: turn.sessionId,
      artifactClaimId: 'claim-1',
      runId: 'run-1',
      executionId: turn.executionId,
      promptMessageId: turn.promptMessageId,
      artifacts: [artifact()]
    }

    const first = owner.publish(publication, { eventId: 'artifact-event', timestamp: 4 })
    await expect(first).rejects.toMatchObject({
      committed: {
        artifactClaimId: 'claim-1',
        runId: 'run-1',
        messageId: expect.any(String),
        artifacts: [expect.objectContaining({ versionId: 'version-1' })]
      }
    })
    await expect(first).rejects.toBeInstanceOf(RuntimeSessionArtifactPublicationError)
    await expect(first).rejects.toThrow(
      'Artifacts were finalized; Session attachment is unconfirmed. Recovery identities: runId="run-1", messageId='
    )

    const receipt = await owner.publish(publication, { eventId: 'artifact-event', timestamp: 4 })
    expect(finalizeArtifacts).toHaveBeenCalledExactlyOnceWith({
      claimId: 'claim-1',
      messageId: receipt.messageId
    })
    const durableAfterRetry = sessions.get(turn.sessionId)!
    expect(durableAfterRetry.artifacts).toContainEqual(
      expect.objectContaining({ id: 'version-1', artifactId: 'artifact-1' })
    )
    expect(
      durableAfterRetry.messages.find(({ id }) => id === receipt.messageId)?.artifactIds
    ).toEqual(expect.arrayContaining(['version-1']))
    expect(durableAfterRetry.messages.find(({ id }) => id === receipt.messageId)?.eventIds).toEqual(
      expect.arrayContaining(['artifact-claim:claim-1', 'artifact-event'])
    )
  })

  it('rejects in-flight and completed claim replays with different descriptor facts', async () => {
    const turn = scope()
    const { owner, finalizeArtifacts } = harness()
    await owner.begin(turn)
    let releaseFinalization!: () => void
    finalizeArtifacts.mockImplementationOnce(
      () =>
        new Promise<ArtifactFile[]>((resolve) => {
          releaseFinalization = () => resolve([artifact({ id: 'version-1' })])
        })
    )
    const publication = {
      appSessionId: turn.sessionId,
      artifactClaimId: 'claim-collision',
      runId: 'run-1',
      executionId: turn.executionId,
      promptMessageId: turn.promptMessageId,
      artifacts: [artifact()]
    }

    const pending = owner.publish(publication)
    await vi.waitFor(() => expect(finalizeArtifacts).toHaveBeenCalledOnce())
    await expect(
      owner.publish({
        ...publication,
        artifacts: [artifact({ checksum: 'different-checksum' })]
      })
    ).rejects.toThrow('different publication facts')

    releaseFinalization()
    await pending
    await expect(
      owner.publish({
        ...publication,
        artifacts: [artifact({ path: '/workspace/other.txt' })]
      })
    ).rejects.toThrow('different publication facts')
    expect(finalizeArtifacts).toHaveBeenCalledOnce()
  })

  it('does not let observer notification failure erase a commit', async () => {
    const turn = scope()
    const durable = session(turn)
    const owner = new RuntimeSessionOwner({
      loadSession: async () => durable,
      mutateSession: async (_scope, mutate) => {
        Object.assign(durable, mutate(durable))
        return durable
      },
      finalizeArtifacts: async () => [],
      onCommitted: () => {
        throw new Error('observer failed')
      }
    })
    await owner.begin(turn)
    owner.accept(messageEvent(turn, 'event-1', 'committed'))

    await expect(owner.flush(turn.sessionId, turn.promptMessageId)).resolves.toBe(durable)
    expect(durable.messages.at(-1)?.content).toBe('committed')
  })

  it('keeps the registered scope usable for an artifact that arrives after cancellation', async () => {
    const turn = scope()
    const { owner, sessions } = harness()
    await owner.begin(turn)
    owner.accept({
      id: 'cancelled',
      timestamp: 5,
      kind: 'stop',
      level: 'info',
      sessionId: turn.sessionId,
      promptMessageId: turn.promptMessageId,
      title: 'Prompt stopped',
      text: 'cancelled'
    })
    await owner.flush(turn.sessionId, turn.promptMessageId)

    const receipt = await owner.publish({
      appSessionId: turn.sessionId,
      artifactClaimId: 'late-claim',
      runId: 'run-1',
      executionId: turn.executionId,
      promptMessageId: turn.promptMessageId,
      artifacts: [artifact()]
    })

    expect(sessions.get(turn.sessionId)?.status).toBe('error')
    expect(receipt.messageId).toBeTruthy()
    expect(receipt.artifacts).toContainEqual(expect.objectContaining({ versionId: 'version-1' }))
  })

  it('admits a resumed execution only after a newer durable run and fences stale output', async () => {
    const first = scope()
    const { owner, sessions } = harness()
    await owner.begin(first)
    owner.accept({
      id: 'cancelled',
      timestamp: 5,
      kind: 'stop',
      level: 'info',
      sessionId: first.sessionId,
      promptMessageId: first.promptMessageId,
      title: 'Prompt stopped',
      text: 'cancelled'
    })
    await owner.flush(first.sessionId, first.promptMessageId)

    const durable = sessions.get(first.sessionId)!
    durable.status = 'running'
    durable.activeRun = { promptMessageId: first.promptMessageId, startedAt: 10 }
    const resumed = {
      ...first,
      runtimeSegmentId: 'segment-resumed',
      executionId: 'execution-resumed'
    }
    durable.conversationGraph!.runtimeSegments.push({
      id: resumed.runtimeSegmentId,
      agentFrameId: resumed.agentFrameId,
      frameworkId: 'codex',
      startedAt: 10
    })
    durable.conversationGraph!.messages.find(
      ({ id }) => id === resumed.promptMessageId
    )!.runtimeSegmentId = resumed.runtimeSegmentId
    await owner.begin(resumed)

    owner.accept(messageEvent(first, 'stale-chunk', 'stale'))
    owner.accept({ ...messageEvent(resumed, 'current-chunk', 'current'), timestamp: 11 })
    await owner.flush(resumed.sessionId, resumed.promptMessageId)
    expect(
      sessions
        .get(resumed.sessionId)
        ?.conversationGraph?.messages.find(
          ({ responseToMessageId }) => responseToMessageId === resumed.promptMessageId
        )?.content
    ).toBe('current')
    await expect(
      owner.publish({
        appSessionId: first.sessionId,
        promptMessageId: first.promptMessageId,
        artifactClaimId: 'stale-claim',
        runId: 'stale-run',
        executionId: first.executionId,
        artifacts: [artifact()]
      })
    ).rejects.toThrow('superseded Runtime Session execution')
  })

  it.each([
    {
      recoverable: 'context-overflow' as const,
      text: 'request too large',
      providerError: false,
      contextReset: false
    },
    {
      recoverable: undefined,
      text: 'API Error: Connection closed mid-response',
      providerError: true,
      contextReset: false
    },
    {
      recoverable: undefined,
      text: 'API Error: Connection closed mid-response',
      providerError: true,
      contextReset: true
    }
  ])(
    'persists a recoverable attempt before admitting its retry: $text reset=$contextReset',
    async (failure) => {
      const turn = scope()
      const { owner, sessions } = harness()
      await owner.begin(turn)
      owner.accept(messageEvent(turn, 'partial', 'partial output'))
      owner.accept({
        id: 'recoverable-failure',
        timestamp: 5,
        kind: 'error',
        level: 'error',
        sessionId: turn.sessionId,
        promptMessageId: turn.promptMessageId,
        title: 'Prompt failed',
        ...failure
      })
      await owner.flush(turn.sessionId, turn.promptMessageId)
      const interrupted = sessions.get(turn.sessionId)!
      expect(interrupted.activeRun).toBeUndefined()
      expect(interrupted.messages.at(-1)?.status).toBe('error')
      if (failure.providerError) {
        expect(interrupted.resumeRecovery).toEqual({
          kind: 'resume-required',
          cause: 'connection-lost',
          promptMessageId: turn.promptMessageId
        })
      }
      const withSegment = failure.contextReset
        ? applySessionConversationCommands(interrupted, [
            {
              id: 'replacement-segment',
              kind: 'open-segment',
              timestamp: 9,
              segment: { id: 'segment-replacement', frameworkId: 'codex', startedAt: 9 }
            }
          ])
        : interrupted
      const prepared = applySessionConversationCommands(withSegment, [
        {
          id: 'retry-command',
          kind: 'start-run',
          timestamp: 10,
          run: { promptMessageId: turn.promptMessageId, startedAt: 10 }
        }
      ])
      if (failure.providerError) expect(prepared.resumeRecovery).toEqual(interrupted.resumeRecovery)
      sessions.set(turn.sessionId, prepared)
      const admitRetry = async (): Promise<void> => {
        await owner.begin({
          ...turn,
          runtimeSegmentId: failure.contextReset ? 'segment-replacement' : turn.runtimeSegmentId,
          executionId: 'retry-execution'
        })
      }
      if (failure.providerError) {
        await continueInterruptedTurn(
          {
            loadSession: async () => structuredClone(sessions.get(turn.sessionId)),
            runtime: {
              getState: () => ({
                status: 'connected',
                cwd: '/workspace',
                sessionIds: [turn.sessionId],
                pendingPermissions: [],
                permissionProfiles: {},
                permissionGrants: {},
                contextUsageBySession: {},
                promptInFlight: false,
                promptInFlightSessionIds: []
              }),
              getLatestUserPrompt: () => undefined,
              startContinuation: admitRetry
            },
            startDispatchAdmittedContinuation: async (_request, validate) => {
              await validate()
              await admitRetry()
            }
          },
          {
            sessionId: turn.sessionId,
            projectId: turn.projectId,
            promptMessageId: turn.promptMessageId,
            ...(failure.contextReset
              ? {
                  contextReset: {
                    runtimeSegmentId: 'segment-replacement',
                    historyReplayTarget: 'codex-response' as const
                  }
                }
              : {})
          }
        )
      } else {
        await admitRetry()
      }
      if (failure.contextReset) {
        const receipt = await owner.publish({
          appSessionId: turn.sessionId,
          promptMessageId: turn.promptMessageId,
          artifactClaimId: 'resumed-claim',
          runId: 'resumed-run',
          executionId: 'retry-execution',
          artifacts: [artifact()]
        })
        const graph = sessions.get(turn.sessionId)!.conversationGraph!
        expect(graph.messages.find(({ id }) => id === receipt.messageId)?.runtimeSegmentId).toBe(
          'segment-replacement'
        )
        expect(graph.messages.find(({ id }) => id === turn.promptMessageId)?.runtimeSegmentId).toBe(
          turn.runtimeSegmentId
        )
      }
      owner.accept({ ...messageEvent(turn, 'late-old-output', 'stale'), timestamp: 4 })
      owner.accept({
        ...messageEvent(turn, 'retry-output', 'recovered'),
        messageId: 'retry-stream',
        timestamp: 11
      })
      await owner.flush(turn.sessionId, turn.promptMessageId)
      expect(sessions.get(turn.sessionId)?.messages.at(-1)?.content).toBe('recovered')
      expect(
        sessions.get(turn.sessionId)?.messages.some(({ content }) => content.includes('stale'))
      ).toBe(false)
      expect(sessions.get(turn.sessionId)?.resumeRecovery).toBeUndefined()
      await expect(
        owner.publish({
          appSessionId: turn.sessionId,
          promptMessageId: turn.promptMessageId,
          artifactClaimId: 'old-claim',
          runId: 'old-run',
          executionId: turn.executionId,
          artifacts: [artifact()]
        })
      ).rejects.toThrow('superseded Runtime Session execution')
    }
  )

  it.each(['missing-marker', 'old-segment', 'different-branch'])(
    'rejects an unauthorized recovery Segment: %s',
    async (invalid) => {
      const turn = scope()
      const durable = session(turn)
      durable.resumeRecovery = {
        kind: 'resume-required',
        cause: 'connection-lost',
        promptMessageId: turn.promptMessageId
      }
      durable.conversationGraph!.runtimeSegments.push(
        {
          id: 'older-replacement',
          agentFrameId: turn.agentFrameId,
          frameworkId: 'codex',
          startedAt: 5,
          endedAt: 9
        },
        {
          id: 'current-replacement',
          agentFrameId: turn.agentFrameId,
          frameworkId: 'codex',
          startedAt: 9
        }
      )
      if (invalid === 'missing-marker') delete durable.resumeRecovery
      if (invalid === 'different-branch') {
        durable.conversationGraph!.branches.push({
          id: 'other-branch',
          agentFrameId: turn.agentFrameId,
          createdAt: 9,
          updatedAt: 9
        })
        durable.conversationGraph!.frames[0].activeBranchId = 'other-branch'
      }
      const { owner } = harness([durable])
      await expect(
        owner.begin({
          ...turn,
          runtimeSegmentId: invalid === 'old-segment' ? 'older-replacement' : 'current-replacement'
        })
      ).rejects.toThrow('no durable recovery Segment binding')
    }
  )

  it('flushes late chunks after terminal commit without reopening the run', async () => {
    const turn = scope()
    const { owner, sessions } = harness()
    await owner.begin(turn)
    owner.accept({
      id: 'stopped',
      timestamp: 5,
      kind: 'stop',
      level: 'info',
      sessionId: turn.sessionId,
      promptMessageId: turn.promptMessageId,
      title: 'Prompt stopped',
      text: 'end_turn'
    })
    await owner.flush(turn.sessionId, turn.promptMessageId)
    owner.accept(messageEvent(turn, 'late-chunk', 'late'))
    await owner.flush(turn.sessionId, turn.promptMessageId)

    expect(sessions.get(turn.sessionId)?.status).toBe('idle')
    expect(sessions.get(turn.sessionId)?.activeRun).toBeUndefined()
    expect(sessions.get(turn.sessionId)?.messages.at(-1)?.content).toBe('late')
  })

  it('admits the answer to a pending user choice as the continuation of the same turn', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(sessions.get(turn.sessionId)?.status).toBe('waiting-for-user')
    expect(sessions.get(turn.sessionId)?.activeRun).toBeUndefined()

    // The user's answer arrives as Main's own continuation prompt for the same Conversation Turn.
    const continuation: RuntimeSessionTurnScope = {
      ...turn,
      executionId: 'execution-answer'
    }
    await owner.begin(continuation, { reviewOwner: 'renderer' })

    const durable = sessions.get(turn.sessionId)!
    expect(durable.status).toBe('running')
    expect(durable.activeRun).toEqual({
      promptMessageId: turn.promptMessageId,
      startedAt: expect.any(Number)
    })

    // The admitted continuation owns the provider stream, so its output commits to the turn.
    owner.accept({
      id: 'continuation-chunk',
      timestamp: 11,
      kind: 'message',
      level: 'info',
      sessionId: turn.sessionId,
      promptMessageId: turn.promptMessageId,
      messageId: 'stream-continuation',
      role: 'assistant',
      text: 'Continuing with the chosen dataset.'
    })
    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(sessions.get(turn.sessionId)?.messages.at(-1)?.content).toBe(
      'Continuing with the chosen dataset.'
    )
  })

  it('admits the answer after the question is recorded as answered', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)

    // The answer is durable before the continuation is dispatched: Main records the decision, then
    // restarts the turn. The parked Session therefore still waits on the user while its question is
    // already answered.
    owner.accept(questionEvent(turn, 'answered', 4))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(sessions.get(turn.sessionId)?.status).toBe('waiting-for-user')
    expect(
      sessions
        .get(turn.sessionId)
        ?.conversationGraph?.activities.find(({ id }) => id === 'call-ask-user-question')
        ?.elicitation?.state
    ).toBe('answered')

    await owner.begin({ ...turn, executionId: 'execution-answer' }, { reviewOwner: 'renderer' })

    expect(sessions.get(turn.sessionId)?.activeRun).toEqual({
      promptMessageId: turn.promptMessageId,
      startedAt: expect.any(Number)
    })
  })

  it('flushes an answer queued after terminal settlement before admitting its continuation', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    owner.accept(questionEvent(turn, 'answered', 4))

    await owner.begin({ ...turn, executionId: 'execution-answer' })

    expect(sessions.get(turn.sessionId)?.status).toBe('running')
    expect(sessions.get(turn.sessionId)?.activities?.[0].elicitation?.state).toBe('answered')
  })

  it('settles only the answer delivered by the accepted continuation', async () => {
    const turn = scope()
    const { owner, sessions } = harness([{ ...session(turn), runtimeTranscriptOwner: 'main' }])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    const answer = questionEvent(turn, 'answered', 4)
    answer.elicitation!.continuationPending = true
    owner.accept(answer)
    await owner.begin({ ...turn, executionId: 'execution-answer' })

    const notAccepted = normalizeSessionFile(structuredClone(sessions.get(turn.sessionId)))!
    expect(notAccepted.status).toBe('waiting-for-user')
    expect(notAccepted.activities?.[0].elicitation?.state).toBe('pending')

    const nextAnswer = questionEvent(turn, 'answered', 11)
    nextAnswer.id = 'next-answer'
    nextAnswer.toolCallId = 'next-choice'
    nextAnswer.elicitation!.continuationPending = true
    owner.accept(nextAnswer)
    await owner.consumeReplay(turn.sessionId, turn.promptMessageId)
    const accepted = sessions.get(turn.sessionId)!
    expect(
      accepted.activities?.find(({ id }) => id === 'next-choice')?.elicitation?.continuationPending
    ).toBe(true)
    expect(accepted.activities?.[0].elicitation?.state).toBe('answered')
    expect(accepted.activities?.[0].elicitation?.continuationPending).toBeUndefined()
    expect(accepted.conversationGraph?.activities[0].elicitation).toEqual(
      accepted.activities?.[0].elicitation
    )
    expect(normalizeSessionFile(accepted)?.activities?.[0].elicitation?.state).toBe('answered')
  })

  it('retains the unanswered card through disk decoding and admits its restored turn', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    const restored = normalizeSessionFile(JSON.parse(JSON.stringify(sessions.get(turn.sessionId))))!
    expect(restored.activities?.[0].elicitation?.state).toBe('pending')
    expect(restored.status).toBe('waiting-for-user')
    const restarted = harness([restored])
    await restarted.owner.begin({ ...turn, executionId: 'restarted' })
    expect(restarted.sessions.get(turn.sessionId)?.status).toBe('running')
  })

  it('admits a recorded answer after disk normalization clears the waiting status', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(stopEvent(turn, 3))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    owner.accept(questionEvent(turn, 'answered', 4))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    const value = sessions.get(turn.sessionId)!
    value.runtimeTranscriptOwner = 'main'
    value.runtimeTranscriptLastRun = { promptMessageId: turn.promptMessageId, startedAt: 1 }
    const restored = normalizeSessionFile(JSON.parse(JSON.stringify(value)))!
    expect(restored.status).toBe('idle')
    const restarted = harness([restored])
    await restarted.owner.begin({ ...turn, executionId: 'restarted' })
    expect(restarted.sessions.get(turn.sessionId)?.status).toBe('running')
  })

  it.each([
    ['approved-plan', 'approved'],
    ['rejected-plan', 'rejected'],
    ['review-feedback', 'pending']
  ] as const)(
    'resumes a restarted Plan %s delivery after the decision is committed',
    async (kind, approval) => {
      const turn = scope()
      const restored = session(turn)
      delete restored.activeRun
      restored.status = approval === 'pending' ? 'waiting-plan-approval' : 'idle'
      restored.runtimeContext = {
        version: 1,
        revision: 1,
        plan: {
          artifactId: 'plan-artifact',
          artifactVersionId: 'plan-version',
          artifactChecksum: 'a'.repeat(64),
          approval,
          originatingPromptMessageId:
            kind === 'review-feedback' ? 'earlier-plan-prompt' : turn.promptMessageId,
          ...(kind === 'review-feedback' ? { reviewFeedbackMessageId: turn.promptMessageId } : {}),
          stepStatuses: {},
          delivery: {
            commandId: 'plan-delivery',
            kind,
            state: 'delivering',
            originatingPromptMessageId: turn.promptMessageId,
            createdAt: 3
          }
        }
      }
      for (const state of ['queued', 'accepted', 'interrupted'] as const) {
        const stale = structuredClone(restored)
        stale.runtimeContext = {
          ...stale.runtimeContext!,
          plan: {
            ...stale.runtimeContext!.plan!,
            delivery: { ...stale.runtimeContext!.plan!.delivery!, state }
          }
        }
        await expect(
          harness([stale]).owner.begin(turn, {
            planDeliveryCommandId: 'plan-delivery'
          })
        ).rejects.toThrow('unknown or superseded')
      }
      await expect(
        harness([restored]).owner.begin(turn, {
          planDeliveryCommandId: 'another-command'
        })
      ).rejects.toThrow('unknown or superseded')
      const { owner, sessions } = harness([restored])
      await owner.begin(turn, { planDeliveryCommandId: 'plan-delivery' })
      expect(sessions.get(turn.sessionId)?.status).toBe('running')
      owner.accept({
        ...messageEvent(turn, 'plan-response', 'Continuing after review'),
        timestamp: 11
      })
      await owner.flush(turn.sessionId, turn.promptMessageId)
      expect(sessions.get(turn.sessionId)?.messages.at(-1)?.content).toBe('Continuing after review')
    }
  )

  it.each([
    'shutdown',
    'end_turn',
    'cancelled',
    'flush-failure',
    'permission-before-tool',
    'credential-preview',
    'oversized-preview'
  ] as const)('restores a Main-projected pending MCP permission after %s', async (terminal) => {
    const turn = scope()
    const initial = session(turn)
    initial.runtimeTranscriptOwner = 'main'
    const { owner, sessions, mutateSession } = harness([initial])
    await owner.begin(turn)
    if (!['permission-before-tool', 'credential-preview', 'oversized-preview'].includes(terminal))
      owner.accept({
        id: 'permission-tool',
        kind: 'tool',
        level: 'info',
        timestamp: 2,
        sessionId: turn.sessionId,
        promptMessageId: turn.promptMessageId,
        toolCallId: 'permission-tool-call',
        title: 'Run command',
        providerToolName: 'Bash',
        status: 'in_progress',
        rawInput: { command: 'echo permission' }
      })
    owner.accept({
      id: 'unrelated-tool',
      kind: 'tool',
      level: 'info',
      timestamp: 2,
      sessionId: turn.sessionId,
      promptMessageId: turn.promptMessageId,
      toolCallId: 'unrelated-tool-call',
      title: 'Read file',
      status: 'in_progress'
    })
    // The batching timer has deliberately not run when permission admission starts.
    expect(sessions.get(turn.sessionId)?.activities).toBeUndefined()
    const publish = vi.fn()
    const permissionOwner = new AcpPermissionWaitOwner(
      {
        containsMessageOnActiveBranch: async () => true,
        loadSessionForContinuation: async () => structuredClone(sessions.get(turn.sessionId)!),
        readSessionRuntimeContext: async () =>
          sessions.get(turn.sessionId)!.runtimeContext ?? { version: 1, revision: 0 },
        patchSessionRuntimeContext: async (command) => {
          const latest = sessions.get(turn.sessionId)!
          const context = {
            ...latest.runtimeContext,
            version: 1 as const,
            revision: (latest.runtimeContext?.revision ?? 0) + 1,
            ...command.patch
          }
          sessions.set(turn.sessionId, {
            ...latest,
            status: command.sessionStatus ?? latest.status,
            runtimeContext: context
          })
          return context
        }
      },
      publish,
      (candidate) =>
        owner.preparePermissionTranscript(candidate.request, candidate.promptMessageId!)
    )
    if (terminal === 'flush-failure')
      mutateSession.mockRejectedValueOnce(new Error('transcript unavailable'))
    const persistence = permissionOwner.persist({
      projectId: turn.projectId,
      promptMessageId: turn.promptMessageId,
      fingerprint: 'a'.repeat(64),
      request: {
        requestId: 'permission-request',
        sessionId: turn.sessionId,
        toolCallId: 'permission-tool-call',
        title: 'Run command',
        isMcp: true,
        providerToolName: 'Bash',
        rawInput:
          terminal === 'credential-preview'
            ? { query: 'safe input', connection: { password: 'test-password-secret' } }
            : terminal === 'oversized-preview'
              ? { content: 'x'.repeat(9_000) }
              : { command: 'echo permission' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once', scope: 'once' }]
      }
    })
    if (terminal === 'flush-failure') {
      await expect(persistence).rejects.toThrow('transcript unavailable')
      expect(sessions.get(turn.sessionId)?.runtimeContext?.permission).toBeUndefined()
      expect(publish).not.toHaveBeenCalled()
      return
    }
    await expect(persistence).resolves.toBe(true)
    const waiting = sessions.get(turn.sessionId)!
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: expect.arrayContaining([
          expect.objectContaining({ id: 'permission-tool-call', status: 'in_progress' })
        ])
      })
    )
    const witness = waiting.conversationGraph!.activities.find(
      ({ id }) => id === 'permission-tool-call'
    )!
    if (terminal === 'credential-preview') {
      expect(witness.rawInput).toEqual({
        query: 'safe input',
        connection: { password: '[redacted]' }
      })
      expect(JSON.stringify(witness)).not.toContain('test-password-secret')
    }
    if (terminal === 'oversized-preview') expect(witness.rawInput).toBeUndefined()
    expect(waiting.runtimeContext?.permission?.fingerprint).toBe('a'.repeat(64))
    expect(waiting.activities?.[0].promptMessageId).toBeUndefined()
    if (terminal === 'end_turn' || terminal === 'cancelled') {
      owner.accept({ ...stopEvent(turn, 4), text: terminal })
      await owner.flush(turn.sessionId, turn.promptMessageId)
    }
    const stored = sessions.get(turn.sessionId)!
    expect(
      stored.conversationGraph?.activities.find(({ id }) => id === 'permission-tool-call')?.status
    ).toBe('in_progress')
    const restored = normalizeSessionFile(JSON.parse(JSON.stringify(stored)))!
    expect(restored.status).toBe('waiting-permission')
    expect(restored.runtimeContext?.permission?.state).toBe('pending')
    expect(restored.activities?.find(({ id }) => id === 'permission-tool-call')?.status).toBe(
      'in_progress'
    )
    if (terminal === 'permission-before-tool') {
      owner.accept({
        id: 'delayed-permission-tool',
        kind: 'tool',
        level: 'info',
        timestamp: 11,
        sessionId: turn.sessionId,
        promptMessageId: turn.promptMessageId,
        toolCallId: 'permission-tool-call',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'echo permission' }
      })
      await owner.flush(turn.sessionId, turn.promptMessageId)
      expect(
        sessions
          .get(turn.sessionId)
          ?.conversationGraph?.activities.filter(({ id }) => id === 'permission-tool-call')
      ).toHaveLength(1)
    }
    expect(restored.resumeRecovery).toBeUndefined()
    expect(restored.activities?.find(({ id }) => id === 'unrelated-tool-call')?.status).toBe(
      terminal === 'end_turn' ? 'completed' : 'failed'
    )
  })

  it.each([
    'terminal',
    'other-prompt',
    'other-branch',
    'superseded-run',
    'missing-execution'
  ] as const)(
    'refuses to create permission authority over a conflicting tool witness: %s',
    async (conflict) => {
      const turn = scope()
      const { owner, sessions } = harness()
      if (conflict !== 'missing-execution') {
        await owner.begin(turn)
        owner.accept({
          id: 'existing-tool',
          kind: 'tool',
          level: 'info',
          timestamp: 2,
          sessionId: turn.sessionId,
          promptMessageId: turn.promptMessageId,
          toolCallId: 'tool-1',
          title: 'Existing call',
          status: 'in_progress'
        })
        await owner.flush(turn.sessionId, turn.promptMessageId)
        const durable = sessions.get(turn.sessionId)!
        const activity = durable.conversationGraph!.activities[0]
        if (conflict === 'terminal') activity.status = 'completed'
        if (conflict === 'other-prompt') activity.promptMessageId = 'other-prompt'
        if (conflict === 'other-branch') activity.messageBranchId = 'other-branch'
        if (conflict === 'superseded-run') durable.activeRun!.startedAt += 1
      }
      const before = structuredClone(sessions.get(turn.sessionId))
      await expect(
        owner.preparePermissionTranscript(
          {
            requestId: 'permission-1',
            sessionId: turn.sessionId,
            toolCallId: 'tool-1',
            title: 'Permission',
            isMcp: true,
            options: []
          },
          turn.promptMessageId
        )
      ).rejects.toThrow(/conflicts|superseded|no registered/)
      expect(sessions.get(turn.sessionId)).toEqual(before)
    }
  )

  it('does not create a restorable MCP tool witness for a non-MCP request', async () => {
    const turn = scope()
    const { owner, sessions } = harness()
    await owner.begin(turn)
    await owner.preparePermissionTranscript(
      {
        requestId: 'non-mcp',
        sessionId: turn.sessionId,
        toolCallId: 'tool-1',
        title: 'Native permission',
        isMcp: false,
        options: []
      },
      turn.promptMessageId
    )
    expect(sessions.get(turn.sessionId)?.conversationGraph?.activities).toEqual([])
  })

  it('admits a restored permission continuation only for the turn that owns the approval', async () => {
    const turn = scope()
    const continuingPermission = (
      originatingPromptMessageId: string
    ): NonNullable<PersistedChatSession['runtimeContext']> => ({
      version: 1,
      revision: 1,
      permission: {
        state: 'continuing',
        request: {
          requestId: 'permission-1',
          sessionId: turn.sessionId,
          toolCallId: 'tool-1',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' }
          ]
        },
        originatingPromptMessageId,
        fingerprint: 'a'.repeat(64),
        createdAt: 2
      }
    })
    const owned = session(turn)
    // Main records the approval and reports the Session running before restarting the turn.
    owned.status = 'running'
    owned.activeRun = undefined
    owned.runtimeContext = continuingPermission(turn.promptMessageId)
    const { owner, sessions } = harness([owned])

    await owner.begin({ ...turn, executionId: 'execution-continuation' })

    expect(sessions.get(turn.sessionId)?.activeRun?.promptMessageId).toBe(turn.promptMessageId)

    const other = session(turn)
    other.status = 'running'
    other.activeRun = undefined
    other.runtimeContext = continuingPermission('prompt-other')
    const refused = harness([other])

    await expect(
      refused.owner.begin({ ...turn, executionId: 'execution-continuation' })
    ).rejects.toThrow('Runtime Session turn is unknown or superseded.')
  })

  it('refuses to continue a turn whose pending question is already settled', async () => {
    const turn = scope()
    const { owner, sessions } = harness([session(turn)])
    await owner.begin(turn)
    owner.accept(questionEvent(turn, 'pending', 2))
    owner.accept(questionEvent(turn, 'answered', 3))
    owner.accept(stopEvent(turn, 4))
    await owner.flush(turn.sessionId, turn.promptMessageId)
    expect(sessions.get(turn.sessionId)?.status).toBe('idle')

    await expect(owner.begin({ ...turn, executionId: 'execution-answer' })).rejects.toThrow(
      'Runtime Session turn is unknown or superseded.'
    )
  })

  it('refuses to continue a turn while another turn owns the pending interaction', async () => {
    const turn = scope()
    const durable = session(turn)
    durable.status = 'waiting-plan-approval'
    durable.activeRun = undefined
    durable.runtimeContext = {
      version: 1,
      revision: 1,
      plan: {
        artifactId: 'plan-artifact',
        artifactVersionId: 'plan-version',
        artifactChecksum: 'plan-checksum',
        originatingPromptMessageId: 'prompt-other',
        approval: 'pending',
        stepStatuses: {}
      }
    }
    const { owner } = harness([durable])

    await expect(owner.begin({ ...turn, executionId: 'execution-answer' })).rejects.toThrow(
      'Runtime Session turn is unknown or superseded.'
    )
  })
})

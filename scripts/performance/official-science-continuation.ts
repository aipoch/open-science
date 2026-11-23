import { DEFAULT_AGENT_FRAMEWORK_ID } from '../../src/shared/agent-framework-id'
import { toAcpRuntimeEvent } from '../../src/main/acp/runtime-events'
import { AcpRuntimeSnapshotOwner } from '../../src/main/acp/runtime-snapshot-owner'
import type { AcpRuntimeEvent } from '../../src/shared/acp'
import {
  ensureConversationRuntimeSegment,
  getActiveConversationContext,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages,
  validateConversationGraph
} from '../../src/shared/conversation-graph'
import { applyRuntimeSessionEvents } from '../../src/shared/runtime-session-projection'
import { createRuntimeAgentMessageId } from '../../src/shared/runtime-message-identity'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../src/shared/session-persistence'

const PREFIX = 'official-science-benchmark:'
const PROMPT_ID = `${PREFIX}prompt`
const STREAM_ID = `${PREFIX}reply`
const SEGMENT_ID = `${PREFIX}runtime`
const TEXT_BYTES = 32 * 1024
const TEXT_BATCHES = 192
const BATCH_INTERVAL_MS = 500
const BATCH_COUNT = TEXT_BATCHES + 2

export type OfficialScienceContinuationBatch = {
  kind: 'prompt' | 'message' | 'terminal'
  virtualTimeMs: number
  events: readonly AcpRuntimeEvent[]
  apply(session: PersistedChatSession): PersistedChatSession
}

export type OfficialScienceContinuation = {
  batches: OfficialScienceContinuationBatch[]
  metadata: {
    description: string
    expectedAddedUserMessages: 1
    expectedAddedAgentMessages: 1
    expectedAddedToolActivities: 0
    expectedAddedModelCalls: 1
    replyBytes: number
    messageBatches: number
    batchCount: number
    batchIntervalMs: number
    virtualDurationMs: number
    promptMessageId: string
    responseMessageId: string
    startedAt: number
  }
}

const assertWritable = (session: PersistedChatSession): void => {
  if (session.packageOrigin)
    throw new Error(
      'Official benchmark continuation requires a writable fork; import is read-only.'
    )
  const graph = session.conversationGraph
  if (!graph) throw new Error('Official benchmark continuation requires a conversation graph.')
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)
  if (!frame || frame.id !== graph.rootFrameId || frame.kind !== 'root')
    throw new Error('Official benchmark continuation requires the active root Frame.')
}

const assertNoReservedIds = (session: PersistedChatSession, responseId: string): void => {
  const pending: unknown[] = [session]
  const visited = new WeakSet<object>()
  const collides = (value: unknown): boolean =>
    typeof value === 'string' && (value.startsWith(PREFIX) || value === responseId)
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(id|.*Id|eventIds)$/.test(key) &&
        (collides(child) || (Array.isArray(child) && child.some(collides)))
      )
        throw new Error('Official benchmark identity already exists in the input history.')
      if (child && typeof child === 'object') pending.push(child)
    }
  }
}

// A static export contains history, not the original provider chunk schedule. This adds one
// explicitly synthetic continuation to a writable fork without replacing any historical output.
export const createOfficialScienceContinuation = (
  input: PersistedChatSession
): OfficialScienceContinuation => {
  assertWritable(input)
  validateConversationGraph(input.conversationGraph!)
  if (input.status !== 'idle' || input.activeRun)
    throw new Error('Official benchmark continuation requires settled history.')
  const responseMessageId = createRuntimeAgentMessageId(input.id, STREAM_ID, PROMPT_ID)
  assertNoReservedIds(input, responseMessageId)
  let latestTime = Math.max(input.createdAt, input.updatedAt)
  for (const message of [...input.messages, ...input.conversationGraph!.messages]) {
    latestTime = Math.max(
      latestTime,
      message.createdAt,
      message.updatedAt,
      message.completedAt ?? 0
    )
  }
  for (const activity of input.conversationGraph!.activities)
    latestTime = Math.max(latestTime, activity.createdAt, activity.updatedAt)
  const baseTime = Math.floor(latestTime)
  if (
    !Number.isSafeInteger(baseTime) ||
    !Number.isSafeInteger(baseTime + BATCH_COUNT * BATCH_INTERVAL_MS)
  )
    throw new Error('Official benchmark history timestamp exceeds its supported range.')
  const startedAt = baseTime + BATCH_INTERVAL_MS
  const assertTarget = (session: PersistedChatSession): void => {
    assertWritable(session)
    if (session.id !== input.id || session.projectId !== input.projectId)
      throw new Error('Official benchmark continuation cannot switch Session identity.')
  }
  const prompt: PersistedChatMessage = {
    id: PROMPT_ID,
    role: 'user',
    content:
      'Benchmark continuation: summarize the preserved research evidence, explain its limitations and propose a follow-up analysis. This is a synthetic continuation, not a replay of the original conversation.',
    status: 'complete',
    eventIds: [],
    createdAt: startedAt,
    updatedAt: startedAt
  }
  const batches: OfficialScienceContinuationBatch[] = [
    {
      kind: 'prompt',
      virtualTimeMs: BATCH_INTERVAL_MS,
      events: [],
      apply: (session) => {
        assertTarget(session)
        if (session.status !== 'idle' || session.activeRun)
          throw new Error('Official benchmark continuation requires settled history.')
        assertNoReservedIds(session, responseMessageId)
        const graph = session.conversationGraph!
        const currentSegment = graph.runtimeSegments.findLast(
          ({ agentFrameId }) => agentFrameId === graph.activeFrameId
        )
        const runtimeGraph = ensureConversationRuntimeSegment(graph, {
          id: SEGMENT_ID,
          frameworkId: session.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
          providerId: session.agentConfiguration?.providerId,
          backendId: session.agentBackendId,
          model: session.agentModel,
          startedAt,
          forceNew: Boolean(
            session.branchContextResetRequired || currentSegment?.endedAt !== undefined
          )
        })
        const conversationGraph = synchronizeActiveConversationMessages(
          runtimeGraph,
          [...resolveActiveConversationMessages(runtimeGraph), prompt],
          startedAt
        )
        return {
          ...session,
          status: 'running',
          activeRun: { promptMessageId: PROMPT_ID, startedAt },
          conversationGraph,
          messages: resolveActiveConversationMessages(conversationGraph),
          updatedAt: startedAt
        }
      }
    }
  ]
  const snapshot = new AcpRuntimeSnapshotOwner(input.cwd)
  const line =
    'Synthetic continuation: compare observations, uncertainty and controls; preserve the original evidence and propose reproducible follow-up measurements.\n'
  const text = line.repeat(Math.ceil(TEXT_BYTES / line.length)).slice(0, TEXT_BYTES)
  const appendEvents = (kind: 'message' | 'terminal', events: AcpRuntimeEvent[]): void => {
    batches.push({
      kind,
      virtualTimeMs: (batches.length + 1) * BATCH_INTERVAL_MS,
      events,
      apply: (session) => {
        assertTarget(session)
        return applyRuntimeSessionEvents(
          session,
          getActiveConversationContext(session.conversationGraph!, PROMPT_ID),
          events
        )
      }
    })
  }
  for (let batch = 0; batch < TEXT_BATCHES; batch++) {
    const slice = text.slice(
      Math.floor((TEXT_BYTES * batch) / TEXT_BATCHES),
      Math.floor((TEXT_BYTES * (batch + 1)) / TEXT_BATCHES)
    )
    const timestamp = baseTime + (batch + 2) * BATCH_INTERVAL_MS
    appendEvents(
      'message',
      Array.from({ length: 4 }, (_, chunk) =>
        snapshot.appendEvent({
          ...toAcpRuntimeEvent(
            {
              sessionId: input.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: STREAM_ID,
                content: {
                  type: 'text',
                  text: slice.slice(
                    Math.floor((slice.length * chunk) / 4),
                    Math.floor((slice.length * (chunk + 1)) / 4)
                  )
                }
              }
            },
            `${PREFIX}event-${batch * 4 + chunk + 1}`,
            timestamp - 400 + chunk * 100
          ),
          promptMessageId: PROMPT_ID
        })
      )
    )
  }
  appendEvents('terminal', [
    snapshot.appendEvent({
      id: `${PREFIX}stop`,
      kind: 'stop',
      level: 'info',
      sessionId: input.id,
      promptMessageId: PROMPT_ID,
      timestamp: baseTime + BATCH_COUNT * BATCH_INTERVAL_MS,
      turnUsage: {
        inputTokens: 4096,
        cacheTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: TEXT_BYTES / 4,
        turnCount: 1
      },
      modelCallUsage: [
        {
          id: `${PREFIX}model-call`,
          index: 0,
          inputTokens: 4096,
          cacheTokens: 0,
          outputTokens: TEXT_BYTES / 4
        }
      ]
    })
  ])
  return {
    batches,
    metadata: {
      description:
        'One controlled synthetic continuation over preserved official sample history; not original event replay.',
      expectedAddedUserMessages: 1,
      expectedAddedAgentMessages: 1,
      expectedAddedToolActivities: 0,
      expectedAddedModelCalls: 1,
      replyBytes: TEXT_BYTES,
      messageBatches: TEXT_BATCHES,
      batchCount: BATCH_COUNT,
      batchIntervalMs: BATCH_INTERVAL_MS,
      virtualDurationMs: BATCH_COUNT * BATCH_INTERVAL_MS,
      promptMessageId: PROMPT_ID,
      responseMessageId,
      startedAt
    }
  }
}

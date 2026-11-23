import { DEFAULT_AGENT_FRAMEWORK_ID } from '../../src/shared/agent-framework-id'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { toAcpRuntimeEvent } from '../../src/main/acp/runtime-events'
import { AcpRuntimeSnapshotOwner } from '../../src/main/acp/runtime-snapshot-owner'
import type { AcpModelCallUsage, AcpRuntimeEvent } from '../../src/shared/acp'
import {
  createLinearConversationGraph,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../src/shared/conversation-graph'
import {
  applyRuntimeSessionEvents,
  type RuntimeSessionScope
} from '../../src/shared/runtime-session-projection'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../src/shared/session-persistence'

export type RealisticSessionWorkloadOptions = {
  toolOutputBytes: number
  rounds?: number
  replyBytes?: number
  sessionId?: string
  projectId?: string
}

export type RealisticSessionBatch = {
  kind: 'prompt' | 'message' | 'tool-start' | 'tool-result' | 'terminal'
  round: number
  virtualTimeMs: number
  events: readonly AcpRuntimeEvent[]
  apply(session: PersistedChatSession): PersistedChatSession
}

export type RealisticSessionWorkload = {
  initialSession: PersistedChatSession
  batches: RealisticSessionBatch[]
  metadata: {
    rounds: number
    batchesPerRound: number
    batchIntervalMs: number
    virtualDurationMs: number
    expectedUserMessages: number
    expectedAgentMessages: number
    expectedToolActivities: number
    expectedUsageOwners: number
    expectedModelCalls: number
    expectedRunRows: number
    replyBytesPerRound: number
    providerToolOutputBytesPerCall: number
    providerToolOutputBytesTotal: number
    retainedToolContentTextBytesTotal: number
    maxRetainedToolContentTextBytes: number
    retainedRawOutputJsonBytesTotal: number
    maxRetainedRawOutputJsonBytes: number
    omittedRawOutputCount: number
  }
}

const STARTED_AT = 1_700_000_000_000
const BATCH_INTERVAL_MS = 500
const TOOLS_PER_ROUND = 6
const REPLY_BATCHES = 16
const BATCHES_PER_ROUND = 33

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`)
  return value
}

// ASCII makes requested byte counts exact, while varied record text avoids all-zero payloads.
const payload = (bytes: number, label: string): string => {
  const row = `${label}: sample observation, measurement=12.75, control=10.25; compare replicated results.\n`
  return row.repeat(Math.ceil(bytes / row.length)).slice(0, bytes)
}

const scopeFor = (session: PersistedChatSession, promptMessageId: string): RuntimeSessionScope => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const segment = graph?.runtimeSegments.findLast(({ agentFrameId }) => agentFrameId === frame?.id)
  if (!graph || !frame || !segment)
    throw new Error('Workload requires an active conversation graph.')
  return {
    promptMessageId,
    agentFrameId: frame.id,
    messageBranchId: frame.activeBranchId,
    runtimeSegmentId: segment.id
  }
}

// This fixture has no journal dependency and can run unchanged against the snapshot baseline.
// Provider events pass through the real ACP mapper and runtime sanitizer before projection.
// It deliberately does not create artifact bytes or invent durable 64 KiB raw tool payloads.
export const createRealisticSessionWorkload = (
  options: RealisticSessionWorkloadOptions
): RealisticSessionWorkload => {
  const rounds = positiveInteger(options.rounds ?? 15, 'round count')
  const replyBytes = positiveInteger(options.replyBytes ?? 8192, 'reply byte count')
  if (replyBytes < REPLY_BATCHES) throw new Error('Replies require at least 16 bytes.')
  const toolOutputBytes = positiveInteger(options.toolOutputBytes, 'tool output byte count')
  const sessionId = options.sessionId ?? 'realistic-session'
  const projectId = options.projectId ?? 'realistic-project'
  const graph = createLinearConversationGraph({
    sessionId,
    messages: [],
    frameworkId: DEFAULT_AGENT_FRAMEWORK_ID,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT
  })
  const initialSession: PersistedChatSession = {
    id: sessionId,
    projectId,
    title: 'Deterministic research conversation',
    cwd: '',
    agentFrameworkId: DEFAULT_AGENT_FRAMEWORK_ID,
    status: 'idle',
    permissionProfile: 'ask',
    messages: [],
    conversationGraph: graph,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT
  }
  const snapshot = new AcpRuntimeSnapshotOwner('')
  const batches: RealisticSessionBatch[] = []
  const metadata: RealisticSessionWorkload['metadata'] = {
    rounds,
    batchesPerRound: BATCHES_PER_ROUND,
    batchIntervalMs: BATCH_INTERVAL_MS,
    virtualDurationMs: rounds * BATCHES_PER_ROUND * BATCH_INTERVAL_MS,
    expectedUserMessages: rounds,
    expectedAgentMessages: rounds * 3,
    expectedToolActivities: rounds * TOOLS_PER_ROUND,
    expectedUsageOwners: rounds,
    expectedModelCalls: rounds * (TOOLS_PER_ROUND + 1),
    expectedRunRows: rounds,
    replyBytesPerRound: replyBytes,
    providerToolOutputBytesPerCall: toolOutputBytes,
    providerToolOutputBytesTotal: rounds * TOOLS_PER_ROUND * toolOutputBytes,
    retainedToolContentTextBytesTotal: 0,
    maxRetainedToolContentTextBytes: 0,
    retainedRawOutputJsonBytesTotal: 0,
    maxRetainedRawOutputJsonBytes: 0,
    omittedRawOutputCount: 0
  }
  let eventSequence = 0
  const mappedEvent = (
    update: SessionNotification['update'],
    timestamp: number,
    promptMessageId: string
  ): AcpRuntimeEvent =>
    snapshot.appendEvent({
      ...toAcpRuntimeEvent({ sessionId, update }, `workload-event-${++eventSequence}`, timestamp),
      promptMessageId
    })

  for (let round = 1; round <= rounds; round++) {
    const promptMessageId = `prompt-${round}`
    const nextBatchTime = (): number => STARTED_AT + (batches.length + 1) * BATCH_INTERVAL_MS
    const addEvents = (
      kind: Exclude<RealisticSessionBatch['kind'], 'prompt'>,
      events: AcpRuntimeEvent[]
    ): void => {
      batches.push({
        kind,
        round,
        virtualTimeMs: nextBatchTime() - STARTED_AT,
        events,
        apply: (session) =>
          applyRuntimeSessionEvents(session, scopeFor(session, promptMessageId), events)
      })
    }
    const prompt: PersistedChatMessage = {
      id: promptMessageId,
      role: 'user',
      content: `Round ${round}: inspect six independent measurements, compare controls, explain the evidence and propose the next analysis.`,
      status: 'complete',
      eventIds: [],
      createdAt: nextBatchTime(),
      updatedAt: nextBatchTime()
    }
    batches.push({
      kind: 'prompt',
      round,
      virtualTimeMs: nextBatchTime() - STARTED_AT,
      events: [],
      apply: (session) => {
        if (!session.conversationGraph) throw new Error('Workload requires a conversation graph.')
        const conversationGraph = synchronizeActiveConversationMessages(
          session.conversationGraph,
          [...session.messages, prompt],
          prompt.updatedAt
        )
        return {
          ...session,
          status: 'running',
          activeRun: { promptMessageId, startedAt: prompt.createdAt },
          conversationGraph,
          messages: resolveActiveConversationMessages(conversationGraph),
          updatedAt: prompt.updatedAt
        }
      }
    })
    const addMessage = (part: string, text: string, batchCount: number): void => {
      for (let batch = 0; batch < batchCount; batch++) {
        const slice = text.slice(
          Math.floor((text.length * batch) / batchCount),
          Math.floor((text.length * (batch + 1)) / batchCount)
        )
        const timestamp = nextBatchTime()
        const count = Math.min(4, slice.length)
        const chunks = Array.from({ length: count }, (_, index) => {
          // Four provider chunks per 500 ms batch model coalescing without per-token saves.
          return mappedEvent(
            {
              sessionUpdate: 'agent_message_chunk',
              messageId: `round-${round}-${part}`,
              content: {
                type: 'text',
                text: slice.slice(
                  Math.floor((slice.length * index) / count),
                  Math.floor((slice.length * (index + 1)) / count)
                )
              }
            },
            timestamp - 400 + index * 100,
            promptMessageId
          )
        })
        addEvents('message', chunks)
      }
    }
    addMessage('plan', payload(512, `Round ${round} plan`), 1)
    for (let tool = 1; tool <= TOOLS_PER_ROUND; tool++) {
      const toolCallId = `round-${round}-tool-${tool}`
      const meta = { toolName: tool % 2 ? 'Read' : 'Bash' }
      addEvents('tool-start', [
        mappedEvent(
          {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Inspect measurement ${tool}`,
            kind: tool % 2 ? 'read' : 'execute',
            status: 'in_progress',
            rawInput: { dataset: `round-${round}-sample-${tool}`, operation: 'summarize' },
            _meta: meta
          },
          nextBatchTime() - 100,
          promptMessageId
        )
      ])
      const output = payload(toolOutputBytes, `Round ${round} tool ${tool}`)
      const result = mappedEvent(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: { stdout: output },
          content: [{ type: 'content', content: { type: 'text', text: output } }],
          _meta: meta
        },
        nextBatchTime() - 100,
        promptMessageId
      )
      const retainedTextBytes = (result.toolContent ?? []).reduce(
        (sum, block) =>
          sum +
          (block.type === 'content' && block.content.type === 'text'
            ? Buffer.byteLength(block.content.text)
            : 0),
        0
      )
      const retainedRawBytes =
        result.rawOutput === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.rawOutput))
      metadata.retainedToolContentTextBytesTotal += retainedTextBytes
      metadata.maxRetainedToolContentTextBytes = Math.max(
        metadata.maxRetainedToolContentTextBytes,
        retainedTextBytes
      )
      metadata.retainedRawOutputJsonBytesTotal += retainedRawBytes
      metadata.maxRetainedRawOutputJsonBytes = Math.max(
        metadata.maxRetainedRawOutputJsonBytes,
        retainedRawBytes
      )
      if (result.rawOutput === undefined) metadata.omittedRawOutputCount++
      addEvents('tool-result', [result])
      if (tool === 3) addMessage('progress', payload(1024, `Round ${round} interim findings`), 2)
    }
    addMessage('answer', payload(replyBytes, `Round ${round} final analysis`), REPLY_BATCHES)
    const modelCallUsage: AcpModelCallUsage[] = Array.from(
      { length: TOOLS_PER_ROUND + 1 },
      (_, index) => ({
        id: `round-${round}-model-call-${index}`,
        index,
        inputTokens: 1000 + round * 100 + index * 32,
        cacheTokens: 256,
        cachedReadTokens: 256,
        cachedWriteTokens: 0,
        outputTokens: index === TOOLS_PER_ROUND ? Math.ceil(replyBytes / 4) : 128
      })
    )
    const turnUsage = modelCallUsage.reduce(
      (sum, call) => ({
        inputTokens: sum.inputTokens + call.inputTokens,
        cacheTokens: sum.cacheTokens + call.cacheTokens,
        cachedReadTokens: sum.cachedReadTokens + (call.cachedReadTokens ?? 0),
        cachedWriteTokens: 0,
        outputTokens: sum.outputTokens + call.outputTokens,
        turnCount: modelCallUsage.length
      }),
      {
        inputTokens: 0,
        cacheTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 0,
        turnCount: modelCallUsage.length
      }
    )
    addEvents('terminal', [
      snapshot.appendEvent({
        id: `workload-event-${++eventSequence}`,
        kind: 'stop',
        level: 'info',
        sessionId,
        promptMessageId,
        timestamp: nextBatchTime(),
        turnUsage,
        modelCallUsage
      })
    ])
  }
  return { initialSession, batches, metadata }
}

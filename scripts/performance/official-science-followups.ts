import { DEFAULT_AGENT_FRAMEWORK_ID } from '../../src/shared/agent-framework-id'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { toAcpRuntimeEvent } from '../../src/main/acp/runtime-events'
import { AcpRuntimeSnapshotOwner } from '../../src/main/acp/runtime-snapshot-owner'
import type { AcpModelCallUsage, AcpRuntimeEvent } from '../../src/shared/acp'
import {
  ensureConversationRuntimeSegment,
  getActiveConversationContext,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages,
  validateConversationGraph
} from '../../src/shared/conversation-graph'
import { createRuntimeAgentMessageId } from '../../src/shared/runtime-message-identity'
import { applyRuntimeSessionEvents } from '../../src/shared/runtime-session-projection'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../src/shared/session-persistence'

const PREFIX = 'official-science-followup:'
const BATCH_INTERVAL_MS = 500
const MESSAGE_BYTES_PER_BATCH = 192
type ToolKind = Extract<SessionNotification['update'], { sessionUpdate: 'tool_call' }>['kind']

export type OfficialScienceFollowupBatch = {
  kind: 'prompt' | 'message' | 'tool-start' | 'tool-result' | 'terminal'
  virtualTimeMs: number
  events: readonly AcpRuntimeEvent[]
  apply(session: PersistedChatSession): PersistedChatSession
}

type ToolExpectation = Pick<PersistedToolActivity, 'id' | 'status' | 'promptMessageId'> &
  Partial<Pick<PersistedToolActivity, 'rawInput' | 'rawOutput' | 'toolContent' | 'toolKind'>>

export type OfficialScienceFollowup = {
  batches: OfficialScienceFollowupBatch[]
  metadata: {
    description: string
    turnNumber: number
    templateTurnIndex: number
    templatePromptMessageId: string
    templateUserMessages: number
    initialUserMessages: number
    expectedTotalUserMessages: number
    promptMessageId: string
    startedAt: number
    expectedAddedUserMessages: 1
    expectedAddedAgentMessages: number
    expectedAddedToolActivities: number
    expectedAddedModelCalls: number
    agentReplyBytes: number
    agentMessageBytes: number[]
    sourceRawInputJsonBytes: number
    sourceRawOutputJsonBytes: number
    sourceToolContentJsonBytes: number
    providerRawInputJsonBytes: number
    providerRawOutputJsonBytes: number
    providerToolContentJsonBytes: number
    retainedRawInputJsonBytes: number
    retainedRawOutputJsonBytes: number
    retainedToolContentJsonBytes: number
    omittedRawInputCount: number
    omittedRawOutputCount: number
    messageBatches: number
    batchCount: number
    batchIntervalMs: number
    messageBytesPerBatch: number
    virtualDurationMs: number
  }
  expected: {
    messages: Array<Pick<PersistedChatMessage, 'id' | 'content' | 'responseToMessageId'>>
    tools: ToolExpectation[]
  }
}

const jsonBytes = (value: unknown): number =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))
const textBytes = (text: string): number => Buffer.byteLength(text)
const syntheticText = (bytes: number, label: string): string => {
  const row = `Simulated ${label}: compare preserved observations and controls; no model or tool was executed. `
  return row.repeat(Math.ceil(bytes / row.length)).slice(0, bytes)
}

// Keep the source JSON shape and encoded byte budget, replacing string values with synthetic
// ASCII. Protocol discriminators remain valid. These are simulated inputs, never executable calls.
const syntheticPayload = (value: unknown, label: string, key?: string): unknown => {
  if (typeof value === 'string')
    return key === 'type' || key === 'mimeType' ? value : syntheticText(jsonBytes(value) - 2, label)
  if (Array.isArray(value)) return value.map((item) => syntheticPayload(item, label))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([field, child]) => [field, syntheticPayload(child, label, field)])
    )
  return value
}

const activeMessages = (session: PersistedChatSession): PersistedChatMessage[] => {
  if (!session.conversationGraph) throw new Error('Follow-up requires a conversation graph.')
  validateConversationGraph(session.conversationGraph)
  return resolveActiveConversationMessages(session.conversationGraph)
}
const assertWritable = (session: PersistedChatSession): void => {
  if (session.packageOrigin)
    throw new Error('Follow-up requires a writable fork; import is read-only.')
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  if (!graph || !frame || frame.kind !== 'root' || frame.id !== graph.rootFrameId)
    throw new Error('Follow-up requires the active root Frame.')
}
const assertPrefixUnused = (session: PersistedChatSession, prefix: string): void => {
  const pending: unknown[] = [session]
  const visited = new WeakSet<object>()
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (/^(id|.*Id|eventIds)$/.test(key)) {
        const values = Array.isArray(child) ? child : [child]
        if (values.some((item) => typeof item === 'string' && item.startsWith(prefix)))
          throw new Error('Follow-up identity already exists in the input history.')
      }
      if (child && typeof child === 'object') pending.push(child)
    }
  }
}

// The template is always the original static seed, while input includes the preceding controlled
// 32 KiB turn and any earlier follow-ups. Original provider chunks/timing are unavailable: this
// cycles observed round shapes with explicit 500 ms synthetic batches, not historical event replay.
export const createOfficialScienceFollowup = (
  input: PersistedChatSession,
  options: { templateSession: PersistedChatSession; turnNumber: number }
): OfficialScienceFollowup => {
  assertWritable(input)
  const currentMessages = activeMessages(input)
  if (input.status !== 'idle' || input.activeRun)
    throw new Error('Follow-up requires settled history.')
  const initialUserMessages = currentMessages.filter(({ role }) => role === 'user').length
  const sourceMessages = activeMessages(options.templateSession)
  const prompts = sourceMessages.filter(({ role }) => role === 'user')
  const { turnNumber } = options
  if (
    !Number.isSafeInteger(turnNumber) ||
    turnNumber !== initialUserMessages + 1 ||
    turnNumber < prompts.length + 2 ||
    prompts.length === 0
  )
    throw new Error('Follow-up must extend the controlled turn by exactly one user message.')
  const templateTurnIndex = (turnNumber - prompts.length - 2) % prompts.length
  const templatePrompt = prompts[templateTurnIndex]
  const sourceAgents = sourceMessages.filter(
    ({ role, responseToMessageId }) => role === 'agent' && responseToMessageId === templatePrompt.id
  )
  if (!sourceAgents.length || sourceAgents.some(({ content }) => !content.length))
    throw new Error('Follow-up template requires nonempty agent text segments.')
  const sourceTools = options.templateSession.conversationGraph!.activities.filter(
    ({ promptMessageId }) => promptMessageId === templatePrompt.id
  )
  const prefix = `${PREFIX}turn-${turnNumber}:`
  assertPrefixUnused(input, prefix)
  const promptMessageId = `${prefix}prompt`
  const graph = input.conversationGraph!
  const times = [input.createdAt, input.updatedAt]
  for (const message of graph.messages)
    times.push(message.createdAt, message.updatedAt, message.completedAt ?? 0)
  for (const activity of graph.activities) times.push(activity.createdAt, activity.updatedAt)
  const baseTime = Math.floor(Math.max(...times))
  if (!Number.isSafeInteger(baseTime))
    throw new Error('Follow-up timestamp exceeds its supported range.')
  const startedAt = baseTime + BATCH_INTERVAL_MS
  const snapshot = new AcpRuntimeSnapshotOwner(input.cwd)
  const expected: OfficialScienceFollowup['expected'] = { messages: [], tools: [] }
  const metadata: OfficialScienceFollowup['metadata'] = {
    description:
      'Synthetic follow-up sized and ordered from an original official sample round; no tools or model executed.',
    turnNumber,
    templateTurnIndex,
    templatePromptMessageId: templatePrompt.id,
    templateUserMessages: prompts.length,
    initialUserMessages,
    expectedTotalUserMessages: turnNumber,
    promptMessageId,
    startedAt,
    expectedAddedUserMessages: 1,
    expectedAddedAgentMessages: sourceAgents.length,
    expectedAddedToolActivities: sourceTools.length,
    expectedAddedModelCalls: 0,
    agentReplyBytes: sourceAgents.reduce((sum, message) => sum + textBytes(message.content), 0),
    agentMessageBytes: sourceAgents.map(({ content }) => textBytes(content)),
    sourceRawInputJsonBytes: 0,
    sourceRawOutputJsonBytes: 0,
    sourceToolContentJsonBytes: 0,
    providerRawInputJsonBytes: 0,
    providerRawOutputJsonBytes: 0,
    providerToolContentJsonBytes: 0,
    retainedRawInputJsonBytes: 0,
    retainedRawOutputJsonBytes: 0,
    retainedToolContentJsonBytes: 0,
    omittedRawInputCount: 0,
    omittedRawOutputCount: 0,
    messageBatches: 0,
    batchCount: 0,
    batchIntervalMs: BATCH_INTERVAL_MS,
    messageBytesPerBatch: MESSAGE_BYTES_PER_BATCH,
    virtualDurationMs: 0
  }
  const assertTarget = (session: PersistedChatSession): void => {
    assertWritable(session)
    if (session.id !== input.id || session.projectId !== input.projectId)
      throw new Error('Follow-up cannot switch Session identity.')
  }
  const prompt: PersistedChatMessage = {
    id: promptMessageId,
    role: 'user',
    content: `Simulated follow-up ${turnNumber}: revisit the preserved research using the workload shape of original turn ${templateTurnIndex + 1}. This is a benchmark, not new research evidence.`,
    status: 'complete',
    eventIds: [],
    createdAt: startedAt,
    updatedAt: startedAt
  }
  const batches: OfficialScienceFollowupBatch[] = [
    {
      kind: 'prompt',
      virtualTimeMs: BATCH_INTERVAL_MS,
      events: [],
      apply: (session) => {
        assertTarget(session)
        if (session.status !== 'idle' || session.activeRun)
          throw new Error('Follow-up requires settled history.')
        if (
          activeMessages(session).filter(({ role }) => role === 'user').length !==
          initialUserMessages
        )
          throw new Error('Follow-up user count changed after preparation.')
        assertPrefixUnused(session, prefix)
        const current = session.conversationGraph!
        const lastSegment = current.runtimeSegments.findLast(
          ({ agentFrameId }) => agentFrameId === current.activeFrameId
        )
        const runtimeGraph = ensureConversationRuntimeSegment(current, {
          id: `${prefix}runtime`,
          frameworkId: session.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
          providerId: session.agentConfiguration?.providerId,
          backendId: session.agentBackendId,
          model: session.agentModel,
          startedAt,
          forceNew: Boolean(
            session.branchContextResetRequired || lastSegment?.endedAt !== undefined
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
          activeRun: { promptMessageId, startedAt },
          conversationGraph,
          messages: resolveActiveConversationMessages(conversationGraph),
          updatedAt: startedAt
        }
      }
    }
  ]
  let eventSequence = 0
  const nextTime = (): number => baseTime + (batches.length + 1) * BATCH_INTERVAL_MS
  const mapped = (update: SessionNotification['update'], timestamp: number): AcpRuntimeEvent =>
    snapshot.appendEvent({
      ...toAcpRuntimeEvent(
        { sessionId: input.id, update },
        `${prefix}event-${++eventSequence}`,
        timestamp
      ),
      promptMessageId
    })
  const append = (
    kind: Exclude<OfficialScienceFollowupBatch['kind'], 'prompt'>,
    events: AcpRuntimeEvent[]
  ): void => {
    batches.push({
      kind,
      virtualTimeMs: nextTime() - baseTime,
      events,
      apply: (session) => {
        assertTarget(session)
        return applyRuntimeSessionEvents(
          session,
          getActiveConversationContext(session.conversationGraph!, promptMessageId),
          events
        )
      }
    })
  }
  type Step = { time: number; order: number } & (
    | { kind: 'message'; source: PersistedChatMessage; index: number }
    | { kind: 'tool-start' | 'tool-result'; source: PersistedToolActivity; index: number }
  )
  const steps: Step[] = sourceAgents.map((source, index) => ({
    kind: 'message',
    source,
    index,
    time: source.createdAt,
    order: index * 3
  }))
  sourceTools.forEach((source, index) => {
    steps.push({
      kind: 'tool-start',
      source,
      index,
      time: source.createdAt,
      order: sourceAgents.length * 3 + index * 2
    })
    steps.push({
      kind: 'tool-result',
      source,
      index,
      time: Math.max(source.createdAt, source.updatedAt),
      order: sourceAgents.length * 3 + index * 2 + 1
    })
  })
  const toolStarts = new Map<number, AcpRuntimeEvent>()
  for (const step of steps.sort((a, b) => a.time - b.time || a.order - b.order)) {
    if (step.kind === 'message') {
      const streamId = `${prefix}reply-${step.index + 1}`
      const text = syntheticText(
        textBytes(step.source.content),
        `turn ${turnNumber} response ${step.index + 1}`
      )
      const id = createRuntimeAgentMessageId(input.id, streamId, promptMessageId)
      if (graph.messages.some((message) => message.id === id))
        throw new Error('Follow-up response identity already exists.')
      expected.messages.push({ id, content: text, responseToMessageId: promptMessageId })
      const count = Math.ceil(text.length / MESSAGE_BYTES_PER_BATCH)
      for (let index = 0; index < count; index++) {
        const slice = text.slice(
          index * MESSAGE_BYTES_PER_BATCH,
          (index + 1) * MESSAGE_BYTES_PER_BATCH
        )
        const chunkCount = Math.min(4, slice.length)
        append(
          'message',
          Array.from({ length: chunkCount }, (_, chunk) =>
            mapped(
              {
                sessionUpdate: 'agent_message_chunk',
                messageId: streamId,
                content: {
                  type: 'text',
                  text: slice.slice(
                    Math.floor((slice.length * chunk) / chunkCount),
                    Math.floor((slice.length * (chunk + 1)) / chunkCount)
                  )
                }
              },
              nextTime() - 400 + chunk * 100
            )
          )
        )
        metadata.messageBatches++
      }
    } else {
      const source = step.source
      const toolCallId = `${prefix}tool-${step.index + 1}`
      if (step.kind === 'tool-start') {
        const rawInput = syntheticPayload(source.rawInput, `tool ${step.index + 1} input`)
        const start = mapped(
          {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Simulated research tool ${step.index + 1}`,
            kind: (source.toolKind ?? 'other') as ToolKind,
            status: 'in_progress',
            rawInput,
            _meta: { toolName: 'BenchmarkResearchTool' }
          },
          nextTime() - 100
        )
        metadata.sourceRawInputJsonBytes += jsonBytes(source.rawInput)
        metadata.providerRawInputJsonBytes += jsonBytes(rawInput)
        metadata.retainedRawInputJsonBytes += jsonBytes(start.rawInput)
        if (rawInput !== undefined && start.rawInput === undefined) metadata.omittedRawInputCount++
        toolStarts.set(step.index, start)
        append('tool-start', [start])
      } else {
        const rawOutput = syntheticPayload(source.rawOutput, `tool ${step.index + 1} output`)
        const content = syntheticPayload(
          source.toolContent,
          `tool ${step.index + 1} content`
        ) as Extract<
          SessionNotification['update'],
          { sessionUpdate: 'tool_call_update' }
        >['content']
        const result = mapped(
          {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: source.status === 'failed' ? 'failed' : 'completed',
            rawOutput,
            content,
            _meta: { toolName: 'BenchmarkResearchTool' }
          },
          nextTime() - 100
        )
        const start = toolStarts.get(step.index)
        if (!start) throw new Error('Follow-up tool result precedes its start.')
        metadata.sourceRawOutputJsonBytes += jsonBytes(source.rawOutput)
        metadata.sourceToolContentJsonBytes += jsonBytes(source.toolContent)
        metadata.providerRawOutputJsonBytes += jsonBytes(rawOutput)
        metadata.providerToolContentJsonBytes += jsonBytes(content)
        metadata.retainedRawOutputJsonBytes += jsonBytes(result.rawOutput)
        metadata.retainedToolContentJsonBytes += jsonBytes(result.toolContent)
        if (rawOutput !== undefined && result.rawOutput === undefined)
          metadata.omittedRawOutputCount++
        expected.tools.push({
          id: toolCallId,
          status: source.status === 'failed' ? 'failed' : 'completed',
          promptMessageId,
          rawInput: start.rawInput,
          rawOutput: result.rawOutput,
          toolContent: result.toolContent,
          toolKind: start.toolKind
        })
        append('tool-result', [result])
      }
    }
  }
  const modelCallUsage: AcpModelCallUsage[] = sourceAgents
    .flatMap((message) => message.modelCallUsage ?? [])
    .map((call, index) => ({
      ...call,
      id: `${prefix}model-call-${index + 1}`,
      index,
      ...(call.sourceInvocationId ? { sourceInvocationId: `${prefix}invocation-${index + 1}` } : {})
    }))
  const turnUsage = sourceAgents.findLast((message) => message.turnUsage)?.turnUsage
  metadata.expectedAddedModelCalls = modelCallUsage.length
  append('terminal', [
    snapshot.appendEvent({
      id: `${prefix}event-${++eventSequence}`,
      kind: 'stop',
      level: 'info',
      sessionId: input.id,
      promptMessageId,
      timestamp: nextTime(),
      turnUsage,
      modelCallUsage: modelCallUsage.length ? modelCallUsage : undefined
    })
  ])
  metadata.batchCount = batches.length
  metadata.virtualDurationMs = batches.length * BATCH_INTERVAL_MS
  if (!Number.isSafeInteger(baseTime + metadata.virtualDurationMs))
    throw new Error('Follow-up timestamp exceeds its supported range.')
  return { batches, metadata, expected }
}

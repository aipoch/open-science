import {
  ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
  type AcpContextWindowSample,
  type AcpModelCallUsage
} from '../../../../shared/acp'
import type { PersistedRuntimeSegment } from '../../../../shared/conversation-graph'
import type { ChatSession } from '@/stores/session-store'

type ContextWindowTrendSession = Pick<ChatSession, 'activities' | 'conversationGraph' | 'messages'>

export type ContextWindowTrendPoint = Readonly<{
  runNumber: number
  messageNumber: number
  promptMessageId: string
  prompt: string
  sample: AcpContextWindowSample
  runtime?: PersistedRuntimeSegment
  agentName?: string
  compactedAfter: boolean
}>

export type ContextWindowCallPoint = Readonly<{
  callNumber: number
  turnNumber: number
  messageNumber: number
  messageId: string
  promptMessageId?: string
  prompt: string
  call: AcpModelCallUsage
  runtime?: PersistedRuntimeSegment
  agentName?: string
}>

export type ContextWindowCallTurnBand = Readonly<{
  turnNumber: number
  messageNumber: number
  calls: ContextWindowCallPoint[]
}>

export type ContextWindowCallSummary = Readonly<{
  callCount: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  peakContextUsedTokens?: number
  contextWindowSize?: number
}>

const resolveAgentName = (
  runtime: PersistedRuntimeSegment | undefined,
  frameById: ReadonlyMap<string, NonNullable<ChatSession['conversationGraph']>['frames'][number]>
): string | undefined => {
  const frame = runtime ? frameById.get(runtime.agentFrameId) : undefined
  return (
    runtime?.agentName ??
    frame?.agentName ??
    frame?.delegateName ??
    (frame?.kind === 'root' ? 'Main Agent' : undefined)
  )
}

const latestCompletedSample = (
  samples: readonly AcpContextWindowSample[]
): AcpContextWindowSample | undefined =>
  samples
    .filter(
      (sample) => sample.termination.kind === 'stop' && sample.termination.stopReason === 'end_turn'
    )
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .at(-1)

const visibleMessageSamples = (
  samples: readonly AcpContextWindowSample[]
): AcpContextWindowSample[] => {
  const completed = latestCompletedSample(samples)
  return samples.filter(
    (sample) =>
      !(sample.termination.kind === 'stop' && sample.termination.stopReason === 'end_turn') ||
      sample === completed
  )
}

export const selectContextWindowTrendPoints = (
  session: ContextWindowTrendSession | undefined
): ContextWindowTrendPoint[] => {
  if (!session) return []

  const graph = session.conversationGraph
  const runtimeById = new Map(graph?.runtimeSegments.map((segment) => [segment.id, segment]) ?? [])
  const messageNodeById = new Map(graph?.messages.map((message) => [message.id, message]) ?? [])
  const frameById = new Map(graph?.frames.map((frame) => [frame.id, frame]) ?? [])
  const unsorted = session.messages.flatMap((message, messageIndex) => {
    if (message.role !== 'user') return []
    const messageNode = messageNodeById.get(message.id)
    return visibleMessageSamples(message.contextWindowSamples ?? []).map((sample) => {
      const runtime = runtimeById.get(
        sample.runtimeSegmentId ?? messageNode?.runtimeSegmentId ?? ''
      )
      const agentName = resolveAgentName(runtime, frameById)
      return {
        runNumber: 0,
        messageNumber: messageIndex + 1,
        promptMessageId: message.id,
        prompt: message.content,
        sample,
        runtime,
        ...(agentName ? { agentName } : {})
      }
    })
  })

  const points = unsorted
    .sort(
      (left, right) =>
        left.sample.timestamp - right.sample.timestamp ||
        left.sample.id.localeCompare(right.sample.id)
    )
    .map((point, index) => ({ ...point, runNumber: index + 1 }))

  const compactedPromptIds = new Set(
    session.activities
      ?.filter(
        (activity) =>
          activity.providerToolName === ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME &&
          activity.status === 'completed' &&
          activity.title === 'Context compacted' &&
          activity.promptMessageId
      )
      .map((activity) => activity.promptMessageId as string) ?? []
  )
  const lastPointByPromptId = new Map<string, number>()
  points.forEach((point, index) => lastPointByPromptId.set(point.promptMessageId, index))

  return points.map((point, index) => ({
    ...point,
    compactedAfter:
      compactedPromptIds.has(point.promptMessageId) &&
      lastPointByPromptId.get(point.promptMessageId) === index
  }))
}

export const selectContextWindowCallPoints = (
  session: ContextWindowTrendSession | undefined
): ContextWindowCallPoint[] => {
  if (!session) return []
  const graph = session.conversationGraph
  const runtimeById = new Map(graph?.runtimeSegments.map((segment) => [segment.id, segment]) ?? [])
  const messageNodeById = new Map(graph?.messages.map((message) => [message.id, message]) ?? [])
  const frameById = new Map(graph?.frames.map((frame) => [frame.id, frame]) ?? [])
  const promptById = new Map(
    session.messages
      .filter((message) => message.role === 'user')
      .map((message) => [message.id, message] as const)
  )
  let turnNumber = 0
  const points: ContextWindowCallPoint[] = []

  session.messages.forEach((message, messageIndex) => {
    if (message.role !== 'agent' || !message.turnUsage) return
    turnNumber += 1
    if (!message.modelCallUsage?.length) return
    const messageNode = messageNodeById.get(message.id)
    const runtime = runtimeById.get(messageNode?.runtimeSegmentId ?? '')
    const agentName = resolveAgentName(runtime, frameById)
    const prompt = message.responseToMessageId
      ? (promptById.get(message.responseToMessageId)?.content ?? '')
      : ''
    for (const call of [...message.modelCallUsage].sort(
      (left, right) => left.index - right.index
    )) {
      points.push({
        callNumber: points.length + 1,
        turnNumber,
        messageNumber: messageIndex + 1,
        messageId: message.id,
        ...(message.responseToMessageId ? { promptMessageId: message.responseToMessageId } : {}),
        prompt,
        call,
        ...(runtime ? { runtime } : {}),
        ...(agentName ? { agentName } : {})
      })
    }
  })

  return points
}

// Bands are runs of consecutive calls sharing one turn. selectContextWindowCallPoints emits calls in
// session order and turn numbers never decrease, so equal turn numbers are always adjacent.
export const groupContextWindowCallsByTurn = (
  points: readonly ContextWindowCallPoint[]
): ContextWindowCallTurnBand[] => {
  const bands: { turnNumber: number; messageNumber: number; calls: ContextWindowCallPoint[] }[] = []
  for (const point of points) {
    const band = bands.at(-1)
    if (band && band.turnNumber === point.turnNumber) {
      band.calls.push(point)
    } else {
      bands.push({
        turnNumber: point.turnNumber,
        messageNumber: point.messageNumber,
        calls: [point]
      })
    }
  }
  return bands
}

// Peak is the maximum reported contextUsedTokens; on ties the latest call wins. The window size
// comes from that peak call, falling back to the latest call that reported any size when the peak
// call did not report one.
export const summarizeContextWindowCallPoints = (
  points: readonly ContextWindowCallPoint[]
): ContextWindowCallSummary => {
  let peak: ContextWindowCallPoint | undefined
  let latestKnownSize: number | undefined
  for (const point of points) {
    if (point.call.contextWindowSize !== undefined) latestKnownSize = point.call.contextWindowSize
    const used = point.call.contextUsedTokens
    if (used !== undefined && (peak?.call.contextUsedTokens ?? -1) <= used) peak = point
  }
  const contextWindowSize = peak?.call.contextWindowSize ?? latestKnownSize
  return {
    callCount: points.length,
    inputTokens: points.reduce((sum, point) => sum + point.call.inputTokens, 0),
    cacheTokens: points.reduce((sum, point) => sum + point.call.cacheTokens, 0),
    outputTokens: points.reduce((sum, point) => sum + point.call.outputTokens, 0),
    ...(peak?.call.contextUsedTokens !== undefined
      ? { peakContextUsedTokens: peak.call.contextUsedTokens }
      : {}),
    ...(contextWindowSize !== undefined ? { contextWindowSize } : {})
  }
}

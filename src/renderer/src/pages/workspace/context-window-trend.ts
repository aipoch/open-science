import type { AcpContextWindowSample } from '../../../../shared/acp'
import type { PersistedRuntimeSegment } from '../../../../shared/conversation-graph'
import type { ChatSession } from '@/stores/session-store'

export type ContextWindowTrendPoint = Readonly<{
  runNumber: number
  messageNumber: number
  promptMessageId: string
  prompt: string
  sample: AcpContextWindowSample
  runtime?: PersistedRuntimeSegment
  agentName?: string
}>

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
  session: ChatSession | undefined
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
      const frame = runtime ? frameById.get(runtime.agentFrameId) : undefined
      const agentName =
        runtime?.agentName ??
        frame?.agentName ??
        frame?.delegateName ??
        (frame?.kind === 'root' ? 'Main Agent' : undefined)
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

  return unsorted
    .sort(
      (left, right) =>
        left.sample.timestamp - right.sample.timestamp ||
        left.sample.id.localeCompare(right.sample.id)
    )
    .map((point, index) => ({ ...point, runNumber: index + 1 }))
}

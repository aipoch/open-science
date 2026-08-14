import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../shared/activity-groups'
import {
  getAcpRuntimeEventText,
  type AcpAgentRuntimeUpdate,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import type {
  PersistedActivityGroup,
  PersistedToolActivity,
  PersistedToolActivityStatus
} from '../../shared/session-persistence'
import type { DelegatedWorkDurableRecords, DurableMessage } from './delegated-work-record-types'

type AttemptRuntimeTranscript = Readonly<{
  messages: readonly DurableMessage[]
  activities: readonly PersistedToolActivity[]
  activityGroups: readonly PersistedActivityGroup[]
  terminalMessage?: DurableMessage
}>

type ProjectAttemptRuntimeTranscriptInput = Readonly<{
  updates: readonly AcpAgentRuntimeUpdate[]
  frameId: string
  promptMessageId: string
  runtimeSegmentId?: string
  fallbackResponse: string
  endedAt: number
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
  terminalStatus?: 'completed' | 'error' | 'cancelled'
  createMessageId(): string
}>

type StageAttemptRuntimeTranscriptInput = Readonly<{
  terminalStatus: 'completed' | 'error' | 'cancelled'
  endedAt: number
  fallbackResponse?: string
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
}>

type AttemptRuntimeTranscriptLane = Readonly<{
  runtimeSegmentId: string
  promptMessageId: string
}>

type AttemptRuntimeTranscriptStager = Readonly<{
  observe(update: AcpAgentRuntimeUpdate): Promise<void>
  settle(
    lane: AttemptRuntimeTranscriptLane,
    input: StageAttemptRuntimeTranscriptInput
  ): Promise<AttemptRuntimeTranscript>
  flush(): Promise<void>
}>

type AttemptCancellationReason = 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'

const TOOL_STATUSES = new Set<PersistedToolActivityStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed'
])

const normalizeToolStatus = (value: string | undefined): PersistedToolActivityStatus | undefined =>
  value && TOOL_STATUSES.has(value as PersistedToolActivityStatus)
    ? (value as PersistedToolActivityStatus)
    : undefined

const isTerminalToolStatus = (value: PersistedToolActivityStatus): boolean =>
  value === 'completed' || value === 'failed'

const toolTitle = (title: string | undefined, kind: string | undefined): string => {
  const trimmed = title?.trim()
  if (trimmed) return trimmed
  return kind === 'fetch' || kind === 'search' ? '' : 'Tool activity'
}

const appOwnedToolCallId = (runtimeSegmentId: string, providerToolCallId: string): string =>
  `agent-runtime:${encodeURIComponent(runtimeSegmentId)}:${encodeURIComponent(providerToolCallId)}`

const projectAttemptRuntimeTranscript = (
  input: ProjectAttemptRuntimeTranscriptInput
): AttemptRuntimeTranscript => {
  const messagesByStream = new Map<string, DurableMessage>()
  const activitiesById = new Map<string, PersistedToolActivity>()
  const groupsById = new Map<string, PersistedActivityGroup>()
  const groupToolCallIds = new Set<string>()
  let activeGroupId: string | undefined
  let sortIndex = 0
  const promptMessageId = input.promptMessageId
  const frameId = input.frameId

  for (const { event, scope } of input.updates) {
    if (event.kind === 'message' && event.role === 'assistant') {
      activeGroupId = undefined
      const text = getAcpRuntimeEventText(event) ?? ''
      if (!text && !event.image) continue
      const streamId = event.messageId ?? event.id
      const existing = messagesByStream.get(streamId)
      if (existing?.eventIds?.includes(event.id)) continue
      if (existing) {
        existing.content += text
        existing.eventIds = [...(existing.eventIds ?? []), event.id]
        existing.updatedAt = event.timestamp
        if (event.image) {
          existing.images = [...(existing.images ?? []), { id: event.id, ...event.image }]
        }
        continue
      }
      messagesByStream.set(streamId, {
        id: input.createMessageId(),
        frameId: scope.agentFrameId,
        role: 'assistant',
        content: text,
        responseToMessageId: promptMessageId,
        runtimeSegmentId: scope.runtimeSegmentId,
        eventIds: [event.id],
        ...(event.image ? { images: [{ id: event.id, ...event.image }] } : {}),
        createdAt: event.timestamp,
        updatedAt: event.timestamp
      })
      continue
    }

    if (event.kind !== 'tool' || !event.toolCallId) continue
    const toolCallId = appOwnedToolCallId(scope.runtimeSegmentId, event.toolCallId)
    if (isActivityGroupToolEvent(event)) {
      groupToolCallIds.add(toolCallId)
      const title = getActivityGroupTitleFromToolEvent(event)
      if (title && !groupsById.has(toolCallId)) {
        sortIndex += 1
        groupsById.set(toolCallId, {
          id: toolCallId,
          title,
          sortIndex,
          activityIds: [],
          promptMessageId: scope.promptMessageId,
          createdAt: event.timestamp,
          updatedAt: event.timestamp
        })
        activeGroupId = toolCallId
      }
      continue
    }
    if (groupToolCallIds.has(toolCallId)) continue

    const existing = activitiesById.get(toolCallId)
    if (existing?.eventIds.includes(event.id)) continue
    const nextStatus = normalizeToolStatus(event.status)
    if (existing) {
      const wasTerminal = isTerminalToolStatus(existing.status)
      Object.assign(existing, {
        title: event.title?.trim() || existing.title,
        status: wasTerminal ? existing.status : (nextStatus ?? existing.status),
        providerToolName: event.providerToolName ?? existing.providerToolName,
        toolKind: event.toolKind ?? existing.toolKind,
        toolContent: event.toolContent ?? existing.toolContent,
        toolLocations: event.toolLocations ?? existing.toolLocations,
        rawInput: event.rawInput ?? existing.rawInput,
        rawOutput: event.rawOutput ?? existing.rawOutput,
        terminalOutput: event.terminalOutput ?? existing.terminalOutput,
        terminalExitCode: event.terminalExitCode ?? existing.terminalExitCode,
        eventIds: [...existing.eventIds, event.id],
        updatedAt: wasTerminal ? existing.updatedAt : event.timestamp
      })
      continue
    }

    sortIndex += 1
    const activity: PersistedToolActivity = {
      id: toolCallId,
      kind: 'tool',
      title: toolTitle(event.title, event.toolKind),
      ...(activeGroupId ? { activityGroupId: activeGroupId } : {}),
      promptMessageId: scope.promptMessageId,
      status: nextStatus ?? 'pending',
      sortIndex,
      eventIds: [event.id],
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      terminalOutput: event.terminalOutput,
      terminalExitCode: event.terminalExitCode,
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    }
    activitiesById.set(activity.id, activity)
    if (activeGroupId) {
      const group = groupsById.get(activeGroupId)
      if (group) {
        groupsById.set(activeGroupId, {
          ...group,
          activityIds: [...group.activityIds, activity.id],
          updatedAt: event.timestamp
        })
      }
    }
  }

  const messages = [...messagesByStream.values()]
  const terminalStatus = input.terminalStatus
  if (messages.length === 0 && terminalStatus === 'completed') {
    messages.push({
      id: input.createMessageId(),
      frameId,
      role: 'assistant',
      content: input.fallbackResponse,
      responseToMessageId: promptMessageId,
      runtimeSegmentId: input.runtimeSegmentId,
      eventIds: [],
      createdAt: input.endedAt,
      updatedAt: input.endedAt,
      completedAt: input.endedAt
    })
  }
  const terminalMessage = messages[messages.length - 1]
  for (const message of messages) {
    if (!terminalStatus) {
      message.status = 'streaming'
      continue
    }
    const isTerminalMessage = message === terminalMessage
    message.status = isTerminalMessage && terminalStatus !== 'completed' ? 'error' : 'complete'
    message.completedAt = isTerminalMessage ? input.endedAt : message.updatedAt
    message.updatedAt = message.completedAt
    if (isTerminalMessage && terminalStatus === 'completed') {
      if (input.turnUsage) message.turnUsage = input.turnUsage
      else if (input.turnUsageUnavailable) message.turnUsageUnavailable = true
    }
  }

  const activities = [...activitiesById.values()].map((activity) =>
    !terminalStatus || isTerminalToolStatus(activity.status)
      ? activity
      : {
          ...activity,
          status: terminalStatus === 'completed' ? ('completed' as const) : ('failed' as const),
          updatedAt: input.endedAt
        }
  )
  const activityGroups = [...groupsById.values()].map((group) =>
    terminalStatus
      ? {
          ...group,
          promptMessageId: group.promptMessageId ?? promptMessageId,
          completedAt: input.endedAt,
          updatedAt: input.endedAt
        }
      : group
  )

  return { messages, activities, activityGroups, terminalMessage }
}

const stageAttemptRuntimeTranscript = async (
  records: DelegatedWorkDurableRecords,
  frameId: string,
  attemptId: string,
  input: ProjectAttemptRuntimeTranscriptInput
): Promise<AttemptRuntimeTranscript> => {
  const transcript = projectAttemptRuntimeTranscript(input)
  for (const message of transcript.messages) {
    await records.stageTerminalMessage(frameId, attemptId, message)
  }
  await records.stageTerminalActivities?.(
    frameId,
    attemptId,
    input.runtimeSegmentId ?? input.updates[0]?.scope.runtimeSegmentId ?? '',
    transcript.activities,
    transcript.activityGroups
  )
  return transcript
}

const createAttemptRuntimeTranscriptStager = (options: {
  records: DelegatedWorkDurableRecords
  frameId: string
  attemptId: string
  createMessageId(): string
}): AttemptRuntimeTranscriptStager => {
  type LaneState = {
    updates: AcpAgentRuntimeUpdate[]
    messageIds: string[]
    terminalStatus?: StageAttemptRuntimeTranscriptInput['terminalStatus']
  }
  const lanes = new Map<string, LaneState>()
  let stagingTail: Promise<unknown> = Promise.resolve()
  const laneKey = (lane: AttemptRuntimeTranscriptLane): string =>
    `${lane.runtimeSegmentId}\u0000${lane.promptMessageId}`
  const laneState = (lane: AttemptRuntimeTranscriptLane): LaneState => {
    const key = laneKey(lane)
    const existing = lanes.get(key)
    if (existing) return existing
    const created: LaneState = { updates: [], messageIds: [] }
    lanes.set(key, created)
    return created
  }
  const stage = async (
    lane: AttemptRuntimeTranscriptLane,
    state: LaneState,
    input: Omit<StageAttemptRuntimeTranscriptInput, 'terminalStatus'> & {
      terminalStatus?: StageAttemptRuntimeTranscriptInput['terminalStatus']
    }
  ): Promise<AttemptRuntimeTranscript> => {
    let messageIndex = 0
    return stageAttemptRuntimeTranscript(options.records, options.frameId, options.attemptId, {
      updates: state.updates,
      frameId: options.frameId,
      promptMessageId: lane.promptMessageId,
      runtimeSegmentId: lane.runtimeSegmentId,
      fallbackResponse: input.fallbackResponse ?? '',
      endedAt: input.endedAt,
      terminalStatus: input.terminalStatus,
      ...(input.turnUsage
        ? { turnUsage: input.turnUsage }
        : input.turnUsageUnavailable
          ? { turnUsageUnavailable: true }
          : {}),
      createMessageId: () => {
        const index = messageIndex++
        return (state.messageIds[index] ??= options.createMessageId())
      }
    })
  }
  const observe = async (update: AcpAgentRuntimeUpdate): Promise<void> => {
    if (
      update.scope.agentFrameId !== options.frameId ||
      update.scope.attemptId !== options.attemptId
    ) {
      throw new Error('Runtime evidence does not belong to the transcript Attempt.')
    }
    const lane = {
      runtimeSegmentId: update.scope.runtimeSegmentId,
      promptMessageId: update.scope.promptMessageId
    }
    const state = laneState(lane)
    const next = stagingTail.then(async () => {
      if (!state.updates.some((candidate) => candidate.event.id === update.event.id)) {
        state.updates.push(update)
      }
      await stage(lane, state, {
        ...(state.terminalStatus ? { terminalStatus: state.terminalStatus } : {}),
        endedAt: update.event.timestamp,
        fallbackResponse: ''
      })
    })
    stagingTail = next
    return next
  }
  const settle = (
    lane: AttemptRuntimeTranscriptLane,
    input: StageAttemptRuntimeTranscriptInput
  ): Promise<AttemptRuntimeTranscript> => {
    const state = laneState(lane)
    state.terminalStatus = input.terminalStatus
    const settled = stagingTail.then(() => stage(lane, state, input))
    stagingTail = settled
    return settled
  }
  return {
    observe,
    settle,
    async flush() {
      await stagingTail
    }
  }
}

const terminalizeUnsuccessfulAttempt = async (
  records: DelegatedWorkDurableRecords,
  stageTranscript: AttemptRuntimeTranscriptStager,
  input: Readonly<{
    frameId: string
    attemptId: string
    endedAt: number
    error: unknown
    lane?: AttemptRuntimeTranscriptLane
    cancellationReason?: AttemptCancellationReason
  }>
): Promise<void> => {
  let terminalError = input.error
  try {
    if (input.lane) {
      await stageTranscript.settle(input.lane, {
        terminalStatus: input.cancellationReason ? 'cancelled' : 'error',
        endedAt: input.endedAt
      })
    }
  } catch (stagingError) {
    if (input.cancellationReason) throw stagingError
    terminalError = stagingError
  }
  if (input.cancellationReason) {
    await records.terminalize({
      frameId: input.frameId,
      attemptId: input.attemptId,
      status: 'cancelled',
      endedAt: input.endedAt,
      cancellationReason: input.cancellationReason
    })
    return
  }
  await records.terminalize({
    frameId: input.frameId,
    attemptId: input.attemptId,
    status: 'error',
    endedAt: input.endedAt,
    error: {
      code: 'execution_failure',
      message: terminalError instanceof Error ? terminalError.message : String(terminalError)
    }
  })
}

export {
  createAttemptRuntimeTranscriptStager,
  projectAttemptRuntimeTranscript,
  stageAttemptRuntimeTranscript,
  terminalizeUnsuccessfulAttempt
}
export type {
  AttemptRuntimeTranscript,
  AttemptRuntimeTranscriptLane,
  AttemptRuntimeTranscriptStager,
  ProjectAttemptRuntimeTranscriptInput,
  StageAttemptRuntimeTranscriptInput
}

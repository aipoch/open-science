import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../shared/activity-groups'
import {
  getAcpRuntimeEventText,
  type AcpAgentRuntimeUpdate,
  type AcpModelCallUsage,
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
  modelCallUsage?: readonly AcpModelCallUsage[]
  turnUsageUnavailable?: true
  terminalStatus?: 'completed' | 'error' | 'cancelled'
  createMessageId(): string
}>

type StageAttemptRuntimeTranscriptInput = Readonly<{
  terminalStatus: 'completed' | 'error' | 'cancelled'
  endedAt: number
  fallbackResponse?: string
  turnUsage?: AcpTurnTokenUsage
  modelCallUsage?: readonly AcpModelCallUsage[]
  turnUsageUnavailable?: true
}>

type AttemptRuntimeTranscriptStager = (
  input: StageAttemptRuntimeTranscriptInput
) => Promise<AttemptRuntimeTranscript | undefined>

type AttemptRuntimeTranscriptScope = Readonly<{
  runtimeSegmentId: string
  promptMessageId: string
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

const selectRuntimeScopeUpdates = (
  updates: readonly AcpAgentRuntimeUpdate[],
  scope: AttemptRuntimeTranscriptScope
): AcpAgentRuntimeUpdate[] =>
  updates.filter(
    (update) =>
      update.scope.runtimeSegmentId === scope.runtimeSegmentId &&
      update.scope.promptMessageId === scope.promptMessageId
  )

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
  const terminalStatus = input.terminalStatus ?? 'completed'
  if (messages.length === 0 && terminalStatus === 'completed') {
    messages.push({
      id: input.createMessageId(),
      frameId,
      role: 'assistant',
      content: input.fallbackResponse,
      responseToMessageId: promptMessageId,
      eventIds: [],
      createdAt: input.endedAt,
      updatedAt: input.endedAt,
      completedAt: input.endedAt
    })
  }
  const terminalMessage = messages[messages.length - 1]
  for (const message of messages) {
    const isTerminalMessage = message === terminalMessage
    message.status = isTerminalMessage && terminalStatus !== 'completed' ? 'error' : 'complete'
    message.completedAt = isTerminalMessage ? input.endedAt : message.updatedAt
    message.updatedAt = message.completedAt
    if (isTerminalMessage && terminalStatus === 'completed') {
      if (input.turnUsage) {
        message.turnUsage = input.turnUsage
        if (input.modelCallUsage) message.modelCallUsage = [...input.modelCallUsage]
      } else if (input.turnUsageUnavailable) message.turnUsageUnavailable = true
    }
  }

  const activities = [...activitiesById.values()].map((activity) =>
    isTerminalToolStatus(activity.status)
      ? activity
      : {
          ...activity,
          status: terminalStatus === 'completed' ? ('completed' as const) : ('failed' as const),
          updatedAt: input.endedAt
        }
  )
  const activityGroups = [...groupsById.values()].map((group) => ({
    ...group,
    promptMessageId: group.promptMessageId ?? promptMessageId,
    completedAt: input.endedAt,
    updatedAt: input.endedAt
  }))

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
  updates: readonly AcpAgentRuntimeUpdate[]
  runtimeScope(): AttemptRuntimeTranscriptScope | undefined
  createMessageId(): string
}): AttemptRuntimeTranscriptStager => {
  let stagingStarted = false
  return async (input) => {
    const runtimeScope = options.runtimeScope()
    if (!runtimeScope || stagingStarted) return undefined
    stagingStarted = true
    return stageAttemptRuntimeTranscript(options.records, options.frameId, options.attemptId, {
      updates: selectRuntimeScopeUpdates(options.updates, runtimeScope),
      frameId: options.frameId,
      promptMessageId: runtimeScope.promptMessageId,
      runtimeSegmentId: runtimeScope.runtimeSegmentId,
      fallbackResponse: input.fallbackResponse ?? '',
      endedAt: input.endedAt,
      terminalStatus: input.terminalStatus,
      ...(input.turnUsage
        ? {
            turnUsage: input.turnUsage,
            ...(input.modelCallUsage ? { modelCallUsage: input.modelCallUsage } : {})
          }
        : input.turnUsageUnavailable
          ? { turnUsageUnavailable: true }
          : {}),
      createMessageId: options.createMessageId
    })
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
    cancellationReason?: AttemptCancellationReason
  }>
): Promise<void> => {
  let terminalError = input.error
  try {
    await stageTranscript({
      terminalStatus: input.cancellationReason ? 'cancelled' : 'error',
      endedAt: input.endedAt
    })
  } catch (stagingError) {
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
  selectRuntimeScopeUpdates,
  stageAttemptRuntimeTranscript,
  terminalizeUnsuccessfulAttempt
}
export type {
  AttemptRuntimeTranscript,
  AttemptRuntimeTranscriptStager,
  ProjectAttemptRuntimeTranscriptInput,
  StageAttemptRuntimeTranscriptInput
}

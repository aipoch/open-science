import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'

import type { ElicitationAnswer, ElicitationProjection } from '../../../shared/acp'
import { sanitizeActivityGroupTitle } from '../../../shared/activity-groups'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import type { PersistedActivityGroup } from '../../../shared/session-persistence'
import { createSortIndex } from './session-store-message-graph-owner'
import { inferSessionInteractionState } from './session-store-interaction-state'
import type {
  ChatSession,
  SessionStatus,
  ToolActivity,
  ToolActivityStatus
} from './session-store-persistence-owner'

export type UpsertToolActivityInput = {
  sessionId: string
  toolCallId: string
  eventId: string
  timestamp?: number
  promptMessageId?: string
  title?: string
  status?: string
  toolDisposition?: 'declined' | 'permission-closed'
  executionInvocationId?: string
  providerToolName?: string
  toolKind?: ToolKind
  toolContent?: ToolCallContent[]
  toolLocations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
  elicitation?: ElicitationProjection
}

export const completeOpenActivityGroups = (
  groups: PersistedActivityGroup[] | undefined,
  now: number
): PersistedActivityGroup[] | undefined => {
  const completed = groups
    ?.filter((group) => group.completedAt !== undefined || group.activityIds.length > 0)
    .map((group) =>
      group.completedAt === undefined ? { ...group, completedAt: now, updatedAt: now } : group
    )
  return completed && completed.length > 0 ? completed : undefined
}

export const canStartActivityGroup = (groupId: string, title: string): boolean =>
  Boolean(groupId && sanitizeActivityGroupTitle(title))

const TOOL_ACTIVITY_STATUSES = new Set<ToolActivityStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed'
])

const normalizeToolActivityStatus = (status: string | undefined): ToolActivityStatus | undefined =>
  status && TOOL_ACTIVITY_STATUSES.has(status as ToolActivityStatus)
    ? (status as ToolActivityStatus)
    : undefined

const isTerminalToolActivityStatus = (status: ToolActivityStatus): boolean =>
  status === 'completed' || status === 'failed'

const mergeToolActivityStatus = (
  currentStatus: ToolActivityStatus,
  nextStatus: ToolActivityStatus | undefined
): ToolActivityStatus => {
  if (!nextStatus || isTerminalToolActivityStatus(currentStatus)) return currentStatus
  return nextStatus
}

const createToolActivityTitle = (
  title: string | undefined,
  toolKind: ToolKind | undefined
): string => {
  const trimmedTitle = title?.trim()
  if (trimmedTitle) return trimmedTitle
  if (toolKind === 'fetch' || toolKind === 'search') return ''
  return 'Tool activity'
}

const hasKnownPrompt = (session: ChatSession, promptMessageId: string | undefined): boolean =>
  promptMessageId
    ? session.messages.some((message) => message.id === promptMessageId && message.role === 'user')
    : Boolean(session.activeRun)

const getToolActivitySessionStatus = (session: ChatSession): SessionStatus => {
  if (
    session.status === 'waiting-for-user' ||
    session.status === 'waiting-permission' ||
    session.status === 'waiting-plan-approval'
  ) {
    return session.status
  }
  return session.activeRun ? 'running' : session.status
}

export const completeOpenActivities = (
  activities: ToolActivity[] | undefined
): ToolActivity[] | undefined =>
  activities?.map((activity) =>
    activity.status === 'pending' || activity.status === 'in_progress'
      ? { ...activity, status: 'completed', updatedAt: Date.now() }
      : activity
  )

export const failOpenActivities = (
  activities: ToolActivity[] | undefined
): ToolActivity[] | undefined =>
  activities?.map((activity) =>
    activity.status === 'pending' || activity.status === 'in_progress'
      ? { ...activity, status: 'failed', updatedAt: Date.now() }
      : activity
  )

export const projectActivePlan = (
  session: ChatSession,
  projection: ActivePlanProjection
): ChatSession => {
  const previous = session.activePlanProjection
  const replaced =
    previous && previous.artifactVersionId !== projection.artifactVersionId
      ? [
          ...(session.planHistoryProjections ?? []).filter(
            (item) => item.artifactVersionId !== previous.artifactVersionId
          ),
          previous
        ]
      : session.planHistoryProjections
  const interactionState = inferSessionInteractionState(session)
  const planWaiting = projection.lifecycle === 'awaiting_approval'
  const interactionStatus = interactionState.permission
    ? 'waiting-permission'
    : interactionState.elicitation
      ? 'waiting-for-user'
      : planWaiting
        ? 'waiting-plan-approval'
        : undefined
  return {
    ...session,
    ...(replaced ? { planHistoryProjections: replaced } : {}),
    activePlanProjection: projection,
    interactionState: {
      ...interactionState,
      plan: planWaiting
    },
    status: session.compacting
      ? session.status
      : (interactionStatus ??
        (projection.lifecycle === 'rejected'
          ? session.activeRun
            ? 'running'
            : 'idle'
          : projection.lifecycle === 'blocked'
            ? 'idle'
            : projection.lifecycle === 'completed'
              ? session.activeRun
                ? 'running'
                : 'idle'
              : projection.approval === 'approved'
                ? session.activeRun
                  ? 'running'
                  : 'idle'
                : session.status)),
    updatedAt: Date.now()
  }
}

export const projectToolActivity = (
  session: ChatSession,
  input: UpsertToolActivityInput
): ChatSession => {
  const nextStatus = normalizeToolActivityStatus(input.status)
  const now = Date.now()
  const eventTimestamp = input.timestamp ?? now
  const activities = session.activities ?? []
  const existingActivity = activities.find((activity) => activity.id === input.toolCallId)

  if (existingActivity) {
    if (existingActivity.eventIds.includes(input.eventId)) return session
    const activityWasTerminal = isTerminalToolActivityStatus(existingActivity.status)
    return {
      ...session,
      status: getToolActivitySessionStatus(session),
      activities: activities.map((activity) =>
        activity.id === input.toolCallId
          ? {
              ...activity,
              promptMessageId: input.promptMessageId ?? activity.promptMessageId,
              title: input.title?.trim() || activity.title,
              status: mergeToolActivityStatus(activity.status, nextStatus),
              toolDisposition: input.toolDisposition ?? activity.toolDisposition,
              executionInvocationId: input.executionInvocationId ?? activity.executionInvocationId,
              providerToolName: input.providerToolName ?? activity.providerToolName,
              toolKind: input.toolKind ?? activity.toolKind,
              toolContent: input.toolContent ?? activity.toolContent,
              toolLocations: input.toolLocations ?? activity.toolLocations,
              rawInput: input.rawInput ?? activity.rawInput,
              rawOutput: input.rawOutput ?? activity.rawOutput,
              terminalOutput: input.terminalOutput ?? activity.terminalOutput,
              terminalExitCode: input.terminalExitCode ?? activity.terminalExitCode,
              elicitation: input.elicitation ?? activity.elicitation,
              eventIds: [...activity.eventIds, input.eventId],
              updatedAt: activityWasTerminal ? activity.updatedAt : eventTimestamp
            }
          : activity
      ),
      updatedAt: now
    }
  }

  if (!hasKnownPrompt(session, input.promptMessageId)) return session
  const activeGroup = session.activityGroups?.findLast(
    (group) =>
      group.completedAt === undefined &&
      (!input.promptMessageId || group.promptMessageId === input.promptMessageId)
  )
  const activity: ToolActivity = {
    id: input.toolCallId,
    kind: 'tool',
    title: createToolActivityTitle(input.title, input.toolKind),
    status: nextStatus ?? 'pending',
    toolDisposition: input.toolDisposition,
    executionInvocationId: input.executionInvocationId,
    eventIds: [input.eventId],
    sortIndex: createSortIndex(),
    activityGroupId: activeGroup?.id,
    promptMessageId: input.promptMessageId ?? session.activeRun?.promptMessageId,
    providerToolName: input.providerToolName,
    toolKind: input.toolKind,
    toolContent: input.toolContent,
    toolLocations: input.toolLocations,
    rawInput: input.rawInput,
    rawOutput: input.rawOutput,
    terminalOutput: input.terminalOutput,
    terminalExitCode: input.terminalExitCode,
    elicitation: input.elicitation,
    createdAt: eventTimestamp,
    updatedAt: eventTimestamp
  }
  return {
    ...session,
    status: getToolActivitySessionStatus(session),
    activities: [...activities, activity],
    activityGroups: activeGroup
      ? session.activityGroups?.map((group) =>
          group.id === activeGroup.id
            ? { ...group, activityIds: [...group.activityIds, activity.id], updatedAt: now }
            : group
        )
      : session.activityGroups,
    updatedAt: now
  }
}

// Saves completed steps from a pending multi-question choice without resolving the Agent request.
// The final answer still crosses the elicitation response boundary after every step is answered.
export const projectElicitationDraftAnswers = (
  session: ChatSession,
  activityId: string,
  answers: ElicitationAnswer[]
): ChatSession => {
  const target = session.activities?.find((activity) => activity.id === activityId)
  if (target?.elicitation?.state !== 'pending') return session

  const now = Date.now()
  return {
    ...session,
    activities: session.activities?.map((activity) =>
      activity.id === activityId && activity.elicitation
        ? {
            ...activity,
            elicitation: {
              ...activity.elicitation,
              draftAnswers: answers.length > 0 ? structuredClone(answers) : undefined
            },
            updatedAt: now
          }
        : activity
    ),
    updatedAt: now
  }
}

export const projectActivityGroupStart = (
  session: ChatSession,
  groupId: string,
  title: string,
  promptMessageId?: string
): ChatSession => {
  const groupTitle = sanitizeActivityGroupTitle(title)
  if (!groupId || !groupTitle || !hasKnownPrompt(session, promptMessageId)) return session
  if (session.activityGroups?.some((group) => group.id === groupId)) return session

  const now = Date.now()
  return {
    ...session,
    activityGroups: [
      ...(completeOpenActivityGroups(session.activityGroups, now) ?? []),
      {
        id: groupId,
        title: groupTitle,
        promptMessageId: promptMessageId ?? session.activeRun?.promptMessageId,
        sortIndex: createSortIndex(),
        activityIds: [],
        createdAt: now,
        updatedAt: now
      }
    ],
    updatedAt: now
  }
}

export const projectActivityGroupCompletion = (
  session: ChatSession,
  promptMessageId: string | undefined,
  now: number
): ChatSession => {
  const hasStartedOpenGroup = session.activityGroups?.some(
    (group) =>
      group.completedAt === undefined &&
      group.activityIds.length > 0 &&
      (!promptMessageId || group.promptMessageId === promptMessageId)
  )
  if (!hasStartedOpenGroup) return session

  return {
    ...session,
    activityGroups: session.activityGroups?.map((group) =>
      group.completedAt === undefined &&
      group.activityIds.length > 0 &&
      (!promptMessageId || group.promptMessageId === promptMessageId)
        ? { ...group, completedAt: now, updatedAt: now }
        : group
    ),
    updatedAt: now
  }
}

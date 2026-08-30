import {
  createLinearConversationGraph,
  ensureConversationRuntimeSegment,
  forkConversationAfterActivity,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import type { MessagePart } from '../../../shared/session-persistence'
import type { Annotation } from '../../../shared/annotations'
import {
  sanitizeActivityGroup,
  sanitizeToolActivity,
  type PersistedActivityGroup,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedToolActivity,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../../shared/uploads'
import {
  hydrateToolActivity,
  stripTransientMessageState,
  type ChatMessage,
  type ChatMessageRole,
  type ChatMessageStatus,
  type ChatSession,
  type ToolActivity
} from './session-store-persistence-owner'
import { formatSessionDetailsTitle } from '../../../shared/session-details'

export type AppendUserMessageInput = {
  sessionId: string
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  annotations?: Annotation[]
  pdfContext?: PersistedChatMessage['pdfContext']
  turnIntent?: PersistedChatMessage['turnIntent']
  cwd?: string
  projectId?: string
  permissionProfile?: ChatSession['permissionProfile']
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  agentConfiguration?: PersistedChatSession['agentConfiguration']
  memoryEnabled?: boolean
  // Resolved send target stamped onto the user Message; drives config-change timeline markers.
  agentTarget?: PersistedChatMessage['agentTarget']
  isPending?: boolean
  specialistId?: string
  enabledComputeHosts?: string[]
  selectedComputeHosts?: string[]
  preserveSelection?: boolean
}

export type AppendPendingUserMessageInput = Omit<AppendUserMessageInput, 'sessionId' | 'isPending'>

export type BranchInNewSessionInput = {
  sourceSessionId: string
  sourceMessageId?: string
  content?: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  annotations?: Annotation[]
  turnIntent?: PersistedChatMessage['turnIntent']
  permissionProfile?: ChatSession['permissionProfile']
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  agentConfiguration?: PersistedChatSession['agentConfiguration']
  memoryEnabled?: boolean
  agentTarget?: PersistedChatMessage['agentTarget']
  specialistId?: string | null
}

export type BindPendingSessionInput = {
  pendingSessionId: string
  sessionId: string
  cwd?: string
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  providerSessionId?: PersistedChatSession['providerSessionId']
  providerContinuityToken?: PersistedChatSession['providerContinuityToken']
}

export type AppendMessageResult = {
  sessionId: string
  messageId: string
}

export type BranchInNewSessionResult = {
  sessionId: string
  messageId?: string
}

export type AppendRoutedUserMessageInput = {
  sessionId: string
  messageId: string
  eventId: string
  content: string
  attribution?: PersistedChatMessage['attribution']
  createdAt: number
  responseToMessageId?: string
  relayedFrom?: PersistedChatMessage['relayedFrom']
  uploads?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  annotations?: Annotation[]
}

export type SessionMessageGraphActions = {
  appendUserMessage: (input: AppendUserMessageInput) => AppendMessageResult | undefined
  appendRoutedUserMessage: (input: AppendRoutedUserMessageInput) => AppendMessageResult | undefined
  appendPendingUserMessage: (
    input: AppendPendingUserMessageInput
  ) => AppendMessageResult | undefined
  branchInNewSession: (input: BranchInNewSessionInput) => BranchInNewSessionResult | undefined
  bindPendingSession: (input: BindPendingSessionInput) => BranchInNewSessionResult | undefined
  clearPendingContextReplay: (sessionId: string, messageId: string) => void
  removeMessage: (sessionId: string, messageId: string) => void
  truncateSessionFromMessage: (sessionId: string, messageId: string) => void
  reviseSessionFromElicitation: (sessionId: string, activityId: string) => boolean
  setElicitationHistoryReplayRequest: (sessionId: string, requestId?: string) => void
  activateMessageBranch: (sessionId: string, branchId: string) => void
  openContextResetRuntimeSegment: (sessionId: string) => string | undefined
}

let runtimeSegmentSequence = 0

export const createRuntimeSegmentId = (): string => {
  runtimeSegmentSequence += 1
  return `runtime-segment-${Date.now()}-${runtimeSegmentSequence}`
}

export const isBeforeTimelineItem = (
  item: { createdAt: number; sortIndex?: number },
  boundary: { createdAt: number; sortIndex?: number }
): boolean =>
  item.createdAt < boundary.createdAt ||
  (item.createdAt === boundary.createdAt &&
    item.sortIndex !== undefined &&
    boundary.sortIndex !== undefined &&
    item.sortIndex < boundary.sortIndex)

export const projectSessionGraph = (
  session: ChatSession,
  messages: ChatMessage[],
  now: number,
  runtimeSegmentId: string,
  frameworkId = session.agentFrameworkId ?? 'claude-code',
  backendId = session.agentBackendId,
  model = session.agentModel,
  forceRuntimeSegment = false
): NonNullable<PersistedChatSession['conversationGraph']> => {
  const projection = messages.map(stripTransientMessageState)
  const initial =
    session.conversationGraph ??
    createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages.map(stripTransientMessageState),
      frameworkId: session.agentFrameworkId,
      providerId: session.agentConfiguration?.providerId,
      backendId: session.agentBackendId,
      model: session.agentModel,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })
  const withSegment = ensureConversationRuntimeSegment(initial, {
    id: runtimeSegmentId,
    frameworkId,
    providerId: session.agentConfiguration?.providerId,
    backendId,
    model,
    startedAt: now,
    forceNew: forceRuntimeSegment
  })
  const withMessages = synchronizeActiveConversationMessages(
    withSegment,
    projection,
    now,
    session.activeRunRuntimeSegmentId
  )
  const persistedActivities = (session.activities ?? [])
    .map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => Boolean(activity))
  const persistedGroups = (session.activityGroups ?? [])
    .map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => Boolean(group))
  return synchronizeActiveConversationActivities(
    withMessages,
    persistedActivities,
    persistedGroups,
    session.activeRunRuntimeSegmentId
  )
}

export const synchronizeSessionGraph = (
  session: ChatSession,
  messages: ChatMessage[],
  now: number,
  frameworkId = session.agentFrameworkId ?? 'claude-code',
  backendId = session.agentBackendId,
  model = session.agentModel,
  forceRuntimeSegment = false
): NonNullable<PersistedChatSession['conversationGraph']> =>
  projectSessionGraph(
    session,
    messages,
    now,
    createRuntimeSegmentId(),
    frameworkId,
    backendId,
    model,
    forceRuntimeSegment
  )

// Rewind immediately before a completed structured question while preserving the superseded
// downstream transcript on its Message Branch. Main later projects the replacement activity with
// a fresh toolCallId after accepting the revised answer.
export const projectElicitationRevision = (
  session: ChatSession,
  activityId: string,
  branchId: string,
  now: number
): ChatSession | undefined => {
  const target = session.activities?.find((activity) => activity.id === activityId)
  if (!target?.elicitation?.durable) return undefined

  const promptMessageId = target.promptMessageId ?? target.elicitation.durable.promptMessageId
  const promptIndex = promptMessageId
    ? session.messages.findIndex((message) => message.id === promptMessageId)
    : -1
  const recordedForkMessageId = session.conversationGraph?.branches.find(
    (branch) =>
      branch.forkActivityId === target.id &&
      branch.forkMessageId &&
      session.messages.some((message) => message.id === branch.forkMessageId)
  )?.forkMessageId
  const recordedForkIndex = recordedForkMessageId
    ? session.messages.findIndex((message) => message.id === recordedForkMessageId)
    : -1
  const messages = session.messages.filter(
    (message, index) =>
      (recordedForkIndex >= 0
        ? index <= recordedForkIndex
        : isBeforeTimelineItem(message, target)) || index <= promptIndex
  )
  const forkMessage = messages.at(-1)
  if (!forkMessage) return undefined

  const activities = session.activities?.filter((activity) =>
    isBeforeTimelineItem(activity, target)
  )
  const retainedActivityIds = new Set(activities?.map((activity) => activity.id) ?? [])
  const activityGroups = session.activityGroups
    ?.map((group) => ({
      ...group,
      activityIds: group.activityIds.filter((id) => retainedActivityIds.has(id))
    }))
    .filter((group) => group.activityIds.length > 0)
  const retainedMessageIds = new Set(messages.map((message) => message.id))
  const removedMessages = session.messages.filter((message) => !retainedMessageIds.has(message.id))
  const hasFiles = removedMessages.some(
    (message) => (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
  )
  let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
  try {
    conversationGraph = forkConversationAfterActivity(
      synchronizeSessionGraph(session, session.messages, now),
      forkMessage.id,
      target.id,
      branchId,
      now
    )
  } catch {
    return undefined
  }

  return {
    ...session,
    status: 'idle',
    messages,
    activities,
    activityGroups,
    conversationGraph,
    activeRun: undefined,
    agentStatus: undefined,
    error: undefined,
    errorReportable: undefined,
    interrupted: undefined,
    filesRevision: hasFiles ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
    updatedAt: now
  }
}

export const createTitleFromMessage = (content: string): string => {
  return formatSessionDetailsTitle({ content })
}

export const createBranchTitleFromMessage = (content: string): string =>
  content.replace(/\s+/g, ' ').trim()

export const createTitleFromUploads = (uploads: PersistedUploadedAttachment[]): string => {
  if (uploads.length === 1) return `Attached ${uploads[0].originalName || uploads[0].name}`
  return `Attached ${uploads.length} files`
}

export const createPersistedUpload = (
  attachment: PersistedUploadedAttachment
): PersistedUploadedAttachment => ({
  id: attachment.id,
  sessionId: attachment.sessionId,
  name: attachment.name,
  originalName: attachment.originalName,
  mimeType: attachment.mimeType,
  size: attachment.size,
  versionId: attachment.versionId,
  versionNumber: attachment.versionNumber,
  createdAt: attachment.createdAt,
  sha256: attachment.sha256 ?? attachment.checksum,
  ...(!attachment.versionId && attachment.sessionId === PENDING_UPLOAD_SESSION_ID && attachment.path
    ? { path: attachment.path }
    : {})
})

const copySnapshotUpload = (
  attachment: PersistedUploadedAttachment
): PersistedUploadedAttachment => ({
  ...createPersistedUpload(attachment),
  ...(!attachment.versionId && attachment.path ? { path: attachment.path } : {})
})

export const buildMessage = (input: {
  id: string
  role: ChatMessageRole
  content: string
  status: ChatMessageStatus
  streamId?: string
  eventIds: string[]
  uploads: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  annotations?: Annotation[]
  pdfContext?: PersistedChatMessage['pdfContext']
  turnIntent?: PersistedChatMessage['turnIntent']
  sortIndex: number
  now: number
}): ChatMessage => {
  const persistedUploads = input.uploads.map(createPersistedUpload)
  return {
    id: input.id,
    role: input.role,
    content: input.content,
    status: input.status,
    streamId: input.streamId,
    eventIds: input.eventIds,
    uploads: persistedUploads.length > 0 ? persistedUploads : undefined,
    parts: input.parts && input.parts.length > 0 ? input.parts : undefined,
    annotations: input.annotations?.length ? input.annotations : undefined,
    pdfContext: input.pdfContext,
    turnIntent: input.turnIntent,
    sortIndex: input.sortIndex,
    createdAt: input.now,
    updatedAt: input.now
  }
}

export const buildUserMessage = (
  input: Omit<
    Parameters<typeof buildMessage>[0],
    'role' | 'status' | 'streamId' | 'eventIds' | 'now'
  >
): ChatMessage =>
  buildMessage({
    ...input,
    role: 'user',
    status: 'complete',
    eventIds: [],
    now: Date.now()
  })

export const copySnapshotMessage = (
  message: PersistedChatMessage,
  sortIndex: number
): ChatMessage => ({
  ...message,
  streamId: undefined,
  eventIds: [],
  artifactIds: message.artifactIds ? [...message.artifactIds] : undefined,
  uploads: message.uploads?.map(copySnapshotUpload),
  images: message.images?.map((image) => ({ ...image })),
  parts: message.parts?.map((part) => ({ ...part })),
  annotations: message.annotations?.map((annotation) => structuredClone(annotation)),
  turnUsage: message.turnUsage ? { ...message.turnUsage } : undefined,
  modelCallUsage: message.modelCallUsage?.map((call) => ({ ...call })),
  sortIndex
})

const createSnapshotActivityId = (sessionId: string, id: string): string =>
  `history:${sessionId}:${id}`

export const copySnapshotActivity = (
  activity: PersistedToolActivity,
  sessionId: string
): ToolActivity =>
  hydrateToolActivity({
    ...activity,
    id: createSnapshotActivityId(sessionId, activity.id),
    activityGroupId: activity.activityGroupId
      ? createSnapshotActivityId(sessionId, activity.activityGroupId)
      : undefined,
    eventIds: [],
    toolContent: activity.toolContent ? [...activity.toolContent] : undefined,
    toolLocations: activity.toolLocations?.map((location) => ({ ...location }))
  })

export const copySnapshotActivityGroup = (
  group: PersistedActivityGroup,
  sessionId: string
): PersistedActivityGroup => ({
  ...group,
  id: createSnapshotActivityId(sessionId, group.id),
  activityIds: group.activityIds.map((id) => createSnapshotActivityId(sessionId, id))
})

export const projectSessionBranchSnapshot = (
  source: ChatSession,
  sourceMessageId?: string
):
  | {
      sourceMessage: ChatMessage | undefined
      messages: Array<{ message: PersistedChatMessage; sortIndex: number }>
      activities: PersistedToolActivity[]
      activityGroups: PersistedActivityGroup[]
    }
  | undefined => {
  const sourceMessageIndex = sourceMessageId
    ? source.messages.findIndex((message) => message.id === sourceMessageId)
    : -1
  const sourceMessage = source.messages[sourceMessageIndex]
  if (
    sourceMessageId &&
    (!sourceMessage || sourceMessage.role !== 'agent' || sourceMessage.status !== 'complete')
  ) {
    return undefined
  }

  const messages = (
    sourceMessage ? source.messages.slice(0, sourceMessageIndex + 1) : source.messages
  ).map((message, index) => ({
    message: stripTransientMessageState(message),
    sortIndex: message.sortIndex ?? index
  }))
  const activities = (source.activities ?? [])
    .map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => Boolean(activity))
    .filter((activity) => !sourceMessage || isBeforeTimelineItem(activity, sourceMessage))
  const activityIds = new Set(activities.map((activity) => activity.id))
  const activityGroups = (source.activityGroups ?? [])
    .map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => Boolean(group))
    .map((group) => ({
      ...group,
      activityIds: group.activityIds.filter((id) => activityIds.has(id))
    }))
    .filter((group) => group.activityIds.length > 0)

  return { sourceMessage, messages, activities, activityGroups }
}

export const canBranchInNewSession = (session: ChatSession): boolean =>
  !session.isPending &&
  !session.activeRun &&
  session.status !== 'running' &&
  session.status !== 'waiting-for-user' &&
  session.status !== 'waiting-permission' &&
  session.status !== 'waiting-plan-approval' &&
  !session.fixLoopActive &&
  !session.compacting &&
  !session.branchSwitchBlocked &&
  !session.conversationGraphSyncBlocked

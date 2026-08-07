import {
  createLinearConversationGraph,
  ensureConversationRuntimeSegment,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import type { MessagePart } from '../../../shared/session-persistence'
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

export type AppendUserMessageInput = {
  sessionId: string
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  cwd?: string
  projectId?: string
  permissionProfile?: ChatSession['permissionProfile']
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  isPending?: boolean
  specialistId?: string
}

export type AppendPendingUserMessageInput = Omit<AppendUserMessageInput, 'sessionId' | 'isPending'>

export type BranchInNewSessionInput = {
  sourceSessionId: string
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  permissionProfile?: ChatSession['permissionProfile']
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  specialistId?: string | null
}

export type BindPendingSessionInput = {
  pendingSessionId: string
  sessionId: string
  cwd?: string
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
}

export type AppendMessageResult = {
  sessionId: string
  messageId: string
}

export type AppendRoutedUserMessageInput = {
  sessionId: string
  messageId: string
  eventId: string
  content: string
  createdAt: number
  responseToMessageId?: string
}

export type SessionMessageGraphActions = {
  appendUserMessage: (input: AppendUserMessageInput) => AppendMessageResult | undefined
  appendRoutedUserMessage: (input: AppendRoutedUserMessageInput) => AppendMessageResult | undefined
  appendPendingUserMessage: (
    input: AppendPendingUserMessageInput
  ) => AppendMessageResult | undefined
  branchInNewSession: (input: BranchInNewSessionInput) => AppendMessageResult | undefined
  bindPendingSession: (input: BindPendingSessionInput) => AppendMessageResult | undefined
  clearPendingContextReplay: (sessionId: string, messageId: string) => void
  removeMessage: (sessionId: string, messageId: string) => void
  truncateSessionFromMessage: (sessionId: string, messageId: string) => void
  activateMessageBranch: (sessionId: string, branchId: string) => void
}

export const projectSessionGraph = (
  session: ChatSession,
  messages: ChatMessage[],
  now: number,
  runtimeSegmentId: string,
  frameworkId = session.agentFrameworkId ?? 'claude-code',
  backendId = session.agentBackendId,
  model = session.agentModel
): NonNullable<PersistedChatSession['conversationGraph']> => {
  const projection = messages.map(stripTransientMessageState)
  const initial =
    session.conversationGraph ??
    createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages.map(stripTransientMessageState),
      frameworkId: session.agentFrameworkId,
      backendId: session.agentBackendId,
      model: session.agentModel,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })
  const withSegment = ensureConversationRuntimeSegment(initial, {
    id: runtimeSegmentId,
    frameworkId,
    backendId,
    model,
    startedAt: now
  })
  const withMessages = synchronizeActiveConversationMessages(withSegment, projection, now)
  const persistedActivities = (session.activities ?? [])
    .map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => Boolean(activity))
  const persistedGroups = (session.activityGroups ?? [])
    .map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => Boolean(group))
  return synchronizeActiveConversationActivities(withMessages, persistedActivities, persistedGroups)
}

export const createTitleFromMessage = (content: string): string => {
  const normalizedTitle = content.replace(/\s+/g, ' ').trim()
  return normalizedTitle.length > 48 ? `${normalizedTitle.slice(0, 48)}...` : normalizedTitle
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
    sortIndex: input.sortIndex,
    createdAt: input.now,
    updatedAt: input.now
  }
}

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
  turnUsage: message.turnUsage ? { ...message.turnUsage } : undefined,
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

export const canBranchInNewSession = (session: ChatSession): boolean =>
  !session.activeRun &&
  session.status !== 'running' &&
  session.status !== 'waiting-permission' &&
  !session.fixLoopActive &&
  !session.compacting &&
  !session.branchSwitchBlocked &&
  !session.conversationGraphSyncBlocked

import type { StoreApi } from 'zustand'
import {
  activateConversationBranch,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../../shared/conversation-graph'
import { DEFAULT_PERMISSION_PROFILE } from '../../../shared/permission-profiles'
import {
  sanitizeActivityGroup,
  sanitizeToolActivity,
  type MessagePart,
  type PersistedActivityGroup,
  type PersistedToolActivity,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'
import {
  buildMessage,
  canBranchInNewSession,
  copySnapshotActivity,
  copySnapshotActivityGroup,
  copySnapshotMessage,
  createBranchTitleFromMessage,
  createPersistedUpload,
  createTitleFromMessage,
  createTitleFromUploads,
  isBeforeTimelineItem,
  projectElicitationRevision,
  synchronizeSessionGraph,
  type SessionMessageGraphActions
} from './session-store-message-graph-helpers'
import {
  hydrateToolActivity,
  stripTransientMessageState,
  type ActiveRun,
  type ChatMessage,
  type ChatMessageRole,
  type ChatMessageStatus,
  type ChatSession,
  type SessionStoreData
} from './session-store-persistence-owner'

let messageSequence = 0
let pendingSessionSequence = 0
let timelineSequence = 0
let conversationBranchSequence = 0
export const createMessageId = (): string => {
  messageSequence += 1
  return `message-${Date.now()}-${messageSequence}`
}
const createPendingSessionId = (): string => {
  pendingSessionSequence += 1
  return `pending-session-${Date.now()}-${pendingSessionSequence}`
}

export const createSortIndex = (): number => {
  timelineSequence += 1
  return timelineSequence
}
const createConversationBranchId = (): string => {
  conversationBranchSequence += 1
  return `message-branch-${Date.now()}-${conversationBranchSequence}`
}
const createMessage = (
  role: ChatMessageRole,
  content: string,
  status: ChatMessageStatus,
  streamId?: string,
  eventIds: string[] = [],
  uploads: PersistedUploadedAttachment[] = [],
  parts?: MessagePart[],
  turnIntent?: ChatMessage['turnIntent']
): ChatMessage => {
  const now = Date.now()
  return buildMessage({
    id: createMessageId(),
    role,
    content,
    status,
    streamId,
    eventIds,
    uploads,
    parts,
    turnIntent,
    sortIndex: createSortIndex(),
    now
  })
}

export const createSessionMessageGraphOwner = <
  State extends SessionStoreData & SessionMessageGraphActions
>(
  set: StoreApi<State>['setState'],
  get: StoreApi<State>['getState']
): SessionMessageGraphActions => ({
  appendRoutedUserMessage: ({
    sessionId,
    messageId,
    eventId,
    content,
    createdAt,
    responseToMessageId,
    relayedFrom
  }) => {
    const trimmedContent = content.trim()
    const session = get().sessions.find((candidate) => candidate.id === sessionId)
    if (!session || !trimmedContent) return undefined
    if (session.messages.some((message) => message.id === messageId)) {
      return { sessionId, messageId }
    }
    const matchingFeedbackIndex = relayedFrom
      ? -1
      : session.messages.findIndex(
          (message) =>
            !message.relayedFrom &&
            message.role === 'user' &&
            message.content.trim() === trimmedContent &&
            (message.id.startsWith('local-user-message-') ||
              messageId.startsWith('local-user-message-'))
        )
    const matchingFeedback = session.messages[matchingFeedbackIndex]
    const isLocalMessage = messageId.startsWith('local-user-message-')
    if (
      matchingFeedback &&
      (!matchingFeedback.id.startsWith('local-user-message-') || isLocalMessage)
    ) {
      return { sessionId, messageId: matchingFeedback.id }
    }
    const message: ChatMessage = {
      id: messageId,
      role: 'user',
      content: trimmedContent,
      status: 'complete',
      eventIds: [eventId],
      sortIndex: createSortIndex(),
      createdAt,
      updatedAt: createdAt,
      ...(relayedFrom ? { relayedFrom } : {}),
      ...(responseToMessageId ? { responseToMessageId } : {})
    }
    const messages = matchingFeedback
      ? session.messages.map((existing, index) =>
          index === matchingFeedbackIndex
            ? { ...message, sortIndex: matchingFeedback.sortIndex }
            : existing
        )
      : [...session.messages, message]
    set({
      sessions: get().sessions.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              status: candidate.activeRun ? 'running' : candidate.status,
              messages,
              conversationGraph: synchronizeSessionGraph(candidate, messages, createdAt),
              updatedAt: Math.max(candidate.updatedAt, createdAt)
            }
          : candidate
      )
    } as Partial<State>)
    return { sessionId, messageId }
  },
  appendUserMessage: ({
    sessionId,
    content,
    attachments = [],
    parts,
    turnIntent,
    cwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    isPending,
    specialistId
  }) => {
    const trimmedContent = content.trim()
    const normalizedAgentBackendId = agentBackendId?.trim() || undefined
    const normalizedAgentModel = agentModel?.trim() || undefined
    const uploads = attachments.map(createPersistedUpload)

    if (!sessionId || (!trimmedContent && uploads.length === 0)) return undefined

    const state = get()
    const existingSession = state.sessions.find((session) => session.id === sessionId)
    const now = Date.now()
    const userMessage = createMessage(
      'user',
      trimmedContent,
      'complete',
      undefined,
      [],
      uploads,
      parts,
      turnIntent
    )
    const activeRun: ActiveRun = {
      promptMessageId: userMessage.id,
      startedAt: now
    }

    if (existingSession) {
      const replayPromptIndex = existingSession.pendingContextReplayMessageId
        ? existingSession.messages.findIndex(
            (message) => message.id === existingSession.pendingContextReplayMessageId
          )
        : -1
      const nextMessages =
        replayPromptIndex >= 0
          ? existingSession.messages.map((message, index) =>
              index === replayPromptIndex ? userMessage : message
            )
          : [...existingSession.messages, userMessage]
      set({
        selectedSessionId: sessionId,
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                status: 'running',
                activeRun,
                activeRunRuntimeSegmentId: undefined,
                interrupted: undefined,
                resumeRecovery: undefined,
                ...(session.isPending
                  ? {
                      agentFrameworkId,
                      agentBackendId: normalizedAgentBackendId
                    }
                  : {}),
                agentModel: normalizedAgentModel,
                agentStatus: undefined,
                error: undefined,
                errorReportable: undefined,
                compacting: undefined,
                messages: nextMessages,
                pendingContextReplayMessageId: replayPromptIndex >= 0 ? userMessage.id : undefined,
                conversationGraph: synchronizeSessionGraph(
                  replayPromptIndex >= 0
                    ? { ...session, messages: nextMessages, conversationGraph: undefined }
                    : session,
                  nextMessages,
                  now,
                  agentFrameworkId ?? session.agentFrameworkId ?? 'claude-code',
                  normalizedAgentBackendId ?? session.agentBackendId,
                  normalizedAgentModel
                ),
                updatedAt: now
              }
            : session
        )
      } as Partial<State>)
    } else {
      const newSession: ChatSession = {
        id: sessionId,
        projectId: projectId ?? '',
        isPending: isPending ? true : undefined,
        title: createTitleFromMessage(trimmedContent || createTitleFromUploads(uploads)),
        cwd: cwd ?? '',
        status: 'running',
        permissionProfile: permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        agentFrameworkId,
        agentBackendId: normalizedAgentBackendId,
        agentModel: normalizedAgentModel,
        ...(specialistId ? { specialistId } : {}),
        messages: [userMessage],
        activeRun,
        createdAt: now,
        updatedAt: now
      }
      newSession.conversationGraph = synchronizeSessionGraph(
        newSession,
        newSession.messages,
        now,
        agentFrameworkId ?? 'claude-code',
        normalizedAgentBackendId,
        normalizedAgentModel
      )

      set({
        selectedSessionId: sessionId,
        sessions: [newSession, ...state.sessions]
      } as Partial<State>)
    }

    return { sessionId, messageId: userMessage.id }
  },
  appendPendingUserMessage: ({
    content,
    attachments = [],
    parts,
    turnIntent,
    cwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    specialistId
  }) =>
    get().appendUserMessage({
      sessionId: createPendingSessionId(),
      content,
      attachments,
      parts,
      turnIntent,
      cwd,
      projectId,
      permissionProfile,
      agentFrameworkId,
      agentBackendId,
      agentModel,
      specialistId,
      isPending: true
    }),
  branchInNewSession: ({
    sourceSessionId,
    content,
    attachments = [],
    parts,
    turnIntent,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    specialistId
  }) => {
    const trimmedContent = content.trim()
    const uploads = attachments.map(createPersistedUpload)
    if (!sourceSessionId || (!trimmedContent && uploads.length === 0)) return undefined

    const state = get()
    const source = state.sessions.find((session) => session.id === sourceSessionId)
    if (!source || !canBranchInNewSession(source)) return undefined

    const sourceMessages = source.messages.map((message, index) => ({
      message: stripTransientMessageState(message),
      sortIndex: message.sortIndex ?? index
    }))
    const sourceActivities = (source.activities ?? [])
      .map(sanitizeToolActivity)
      .filter((activity): activity is PersistedToolActivity => Boolean(activity))
    const sourceActivityGroups = (source.activityGroups ?? [])
      .map(sanitizeActivityGroup)
      .filter((group): group is PersistedActivityGroup => Boolean(group))

    const now = Date.now()
    const sessionId = createPendingSessionId()
    const userMessage = createMessage(
      'user',
      trimmedContent,
      'complete',
      undefined,
      [],
      uploads,
      parts,
      turnIntent
    )
    const messages = [
      ...sourceMessages.map(({ message, sortIndex }) => copySnapshotMessage(message, sortIndex)),
      userMessage
    ]
    const normalizedAgentBackendId = agentBackendId?.trim() || source.agentBackendId
    const normalizedAgentModel = agentModel?.trim() || source.agentModel
    const normalizedFrameworkId = agentFrameworkId ?? source.agentFrameworkId
    const nextSpecialistId =
      specialistId === undefined ? source.specialistId : specialistId || undefined
    const newSession: ChatSession = {
      id: sessionId,
      projectId: source.projectId,
      isPending: true,
      title: trimmedContent
        ? createBranchTitleFromMessage(trimmedContent)
        : createTitleFromUploads(uploads),
      cwd: source.cwd,
      status: 'running',
      permissionProfile:
        permissionProfile ?? source.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      agentFrameworkId: normalizedFrameworkId,
      agentBackendId: normalizedAgentBackendId,
      agentModel: normalizedAgentModel,
      ...(source.autoReviewEnabled !== undefined
        ? { autoReviewEnabled: source.autoReviewEnabled }
        : {}),
      ...(source.enabledComputeHosts
        ? { enabledComputeHosts: [...source.enabledComputeHosts] }
        : {}),
      ...(nextSpecialistId ? { specialistId: nextSpecialistId } : {}),
      messages,
      activities: sourceActivities.map((activity) => copySnapshotActivity(activity, sessionId)),
      activityGroups: sourceActivityGroups.map((group) =>
        copySnapshotActivityGroup(group, sessionId)
      ),
      pendingContextReplayMessageId: userMessage.id,
      activeRun: { promptMessageId: userMessage.id, startedAt: now },
      createdAt: now,
      updatedAt: now
    }
    newSession.conversationGraph = synchronizeSessionGraph(
      newSession,
      messages,
      now,
      normalizedFrameworkId ?? 'claude-code',
      normalizedAgentBackendId,
      normalizedAgentModel
    )

    set({
      selectedSessionId: sessionId,
      sessions: [newSession, ...state.sessions]
    } as Partial<State>)

    return { sessionId, messageId: userMessage.id }
  },

  bindPendingSession: ({
    pendingSessionId,
    sessionId,
    cwd,
    agentFrameworkId,
    agentBackendId,
    providerSessionId,
    providerContinuityToken
  }) => {
    if (!pendingSessionId || !sessionId) return undefined

    const state = get()
    const pendingSession = state.sessions.find(
      (session) => session.id === pendingSessionId && session.isPending
    )
    if (!pendingSession?.activeRun) return undefined

    const now = Date.now()
    set({
      selectedSessionId:
        state.selectedSessionId === pendingSessionId ? sessionId : state.selectedSessionId,
      sessions: state.sessions.map((session) =>
        session.id === pendingSessionId
          ? {
              ...session,
              id: sessionId,
              isPending: false,
              cwd: cwd ?? session.cwd,
              agentFrameworkId: agentFrameworkId ?? session.agentFrameworkId,
              agentBackendId: agentBackendId ?? session.agentBackendId,
              providerSessionId: providerSessionId ?? session.providerSessionId,
              providerContinuityToken: providerContinuityToken ?? session.providerContinuityToken,
              updatedAt: now
            }
          : session
      )
    } as Partial<State>)

    return { sessionId, messageId: pendingSession.activeRun.promptMessageId }
  },

  clearPendingContextReplay: (sessionId, messageId) => {
    set(
      (state) =>
        ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId && session.pendingContextReplayMessageId === messageId
              ? { ...session, pendingContextReplayMessageId: undefined }
              : session
          )
        }) as Partial<State>
    )
  },

  removeMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set(
      (state) =>
        ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session
            const cutIndex = session.messages.findIndex((message) => message.id === messageId)
            if (cutIndex < 0) return session
            const removedMessages = session.messages.slice(cutIndex)
            const hasFiles = removedMessages.some(
              (message) =>
                (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
            )
            const now = Date.now()
            const currentGraph = synchronizeSessionGraph(session, session.messages, now)
            const conversationGraph = forkEditedConversationMessage(
              currentGraph,
              messageId,
              createConversationBranchId(),
              now
            )

            return {
              ...session,
              messages: session.messages.slice(0, cutIndex),
              conversationGraph,
              pendingContextReplayMessageId: removedMessages.some(
                (message) => message.id === session.pendingContextReplayMessageId
              )
                ? undefined
                : session.pendingContextReplayMessageId,
              filesRevision: hasFiles ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
              updatedAt: now
            }
          })
        }) as Partial<State>
    )
  },

  truncateSessionFromMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set(
      (state) =>
        ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session
            const cutIndex = session.messages.findIndex((message) => message.id === messageId)
            if (cutIndex < 0) return session

            const cutMessage = session.messages[cutIndex]
            const removed = session.messages.slice(cutIndex)
            const hasFiles = removed.some(
              (message) =>
                (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
            )
            const activities = session.activities?.filter((activity) =>
              isBeforeTimelineItem(activity, cutMessage)
            )
            const retainedActivityIds = new Set(activities?.map((activity) => activity.id) ?? [])
            const activityGroups = session.activityGroups
              ?.map((group) => ({
                ...group,
                activityIds: group.activityIds.filter((id) => retainedActivityIds.has(id))
              }))
              .filter((group) => group.activityIds.length > 0)
            const now = Date.now()
            const currentGraph = synchronizeSessionGraph(session, session.messages, now)
            const conversationGraph = forkEditedConversationMessage(
              currentGraph,
              messageId,
              createConversationBranchId(),
              now
            )

            return {
              ...session,
              status: 'idle',
              messages: session.messages.slice(0, cutIndex),
              activities,
              activityGroups,
              conversationGraph,
              activeRun: undefined,
              agentStatus: undefined,
              error: undefined,
              errorReportable: undefined,
              interrupted: undefined,
              branchContextResetRequired: true,
              pendingContextReplayMessageId: removed.some(
                (message) => message.id === session.pendingContextReplayMessageId
              )
                ? undefined
                : session.pendingContextReplayMessageId,
              filesRevision: hasFiles ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
              updatedAt: now
            }
          })
        }) as Partial<State>
    )
  },

  setElicitationHistoryReplayRequest: (sessionId, requestId) => {
    const state = get()
    set({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, elicitationHistoryReplayRequestId: requestId }
          : session
      )
    } as Partial<State>)
  },

  reviseSessionFromElicitation: (sessionId, activityId) => {
    if (!sessionId || !activityId) return false
    let revised = false
    set(
      (state) =>
        ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId) return session
            const projection = projectElicitationRevision(
              session,
              activityId,
              createConversationBranchId(),
              Date.now()
            )
            revised = Boolean(projection)
            return projection ?? session
          })
        }) as Partial<State>
    )
    return revised
  },

  activateMessageBranch: (sessionId, branchId) => {
    if (!sessionId || !branchId) return
    set(
      (state) =>
        ({
          sessions: state.sessions.map((session) => {
            if (
              session.id !== sessionId ||
              !session.conversationGraph ||
              session.activeRun ||
              session.status === 'running' ||
              session.status === 'waiting-for-user' ||
              session.status === 'waiting-permission' ||
              session.fixLoopActive ||
              session.compacting ||
              session.branchSwitchBlocked
            ) {
              return session
            }
            const activeFrame = session.conversationGraph.frames.find(
              (frame) => frame.id === session.conversationGraph?.activeFrameId
            )
            if (activeFrame?.activeBranchId === branchId) return session
            const conversationGraph = activateConversationBranch(
              session.conversationGraph,
              branchId
            )
            const messages = resolveActiveConversationMessages(conversationGraph).map(
              (message, index): ChatMessage => ({
                ...projectConversationMessage(message),
                sortIndex: index + 1
              })
            )
            const projected = resolveActiveConversationActivities(conversationGraph)
            return {
              ...session,
              conversationGraph,
              messages,
              activities: projected.activities.map(hydrateToolActivity),
              activityGroups: projected.activityGroups,
              status: 'idle',
              activeRun: undefined,
              error: undefined,
              errorReportable: undefined,
              branchContextResetRequired: true,
              filesRevision: (session.filesRevision ?? 0) + 1,
              updatedAt: Date.now()
            }
          })
        }) as Partial<State>
    )
  }
})

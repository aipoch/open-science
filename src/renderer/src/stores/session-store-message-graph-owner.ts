import type { StoreApi } from 'zustand'
import {
  activateConversationBranch,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../../shared/conversation-graph'
import { normalizeDelegationPolicy } from '../../../shared/session-persistence'
import { DEFAULT_PERMISSION_PROFILE } from '../../../shared/permission-profiles'
import {
  buildUserMessage,
  canBranchInNewSession,
  copySnapshotActivity,
  copySnapshotActivityGroup,
  copySnapshotMessage,
  createBranchTitleFromMessage,
  createPersistedUpload,
  createTitleFromMessage,
  createTitleFromUploads,
  isBeforeTimelineItem,
  projectSessionBranchSnapshot,
  projectElicitationRevision,
  synchronizeSessionGraph,
  type SessionMessageGraphActions
} from './session-store-message-graph-helpers'
import {
  hydrateToolActivity,
  pruneStreamingMessageContent,
  type ActiveRun,
  type ChatMessage,
  type ChatSession,
  type SessionStoreData
} from './session-store-persistence-owner'
import * as sessionDetails from './session-store-session-details'
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
const createSessionBranchSource = (
  source: ChatSession,
  headMessageId?: string
): NonNullable<ChatSession['branchSource']> => {
  const graph = source.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
  const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)

  return {
    sessionId: source.id,
    ...(frame ? { agentFrameId: frame.id } : {}),
    ...(branch ? { messageBranchId: branch.id } : {}),
    ...((headMessageId ?? branch?.headMessageId)
      ? { headMessageId: headMessageId ?? branch?.headMessageId }
      : {})
  }
}

export const createSortIndex = (): number => {
  timelineSequence += 1
  return timelineSequence
}
const createConversationBranchId = (): string => {
  conversationBranchSequence += 1
  return `message-branch-${Date.now()}-${conversationBranchSequence}`
}
export const createSessionMessageGraphOwner = <
  State extends SessionStoreData & SessionMessageGraphActions
>(
  set: StoreApi<State>['setState'],
  get: StoreApi<State>['getState']
): SessionMessageGraphActions => ({
  openContextResetRuntimeSegment: (sessionId) => {
    let runtimeSegmentId: string | undefined
    const now = Date.now()
    set({
      sessions: get().sessions.map((session) => {
        if (session.id !== sessionId) return session
        const conversationGraph = synchronizeSessionGraph(
          session,
          session.messages,
          now,
          session.agentFrameworkId ?? 'claude-code',
          session.agentBackendId,
          session.agentModel,
          true
        )
        runtimeSegmentId = conversationGraph.runtimeSegments
          .filter((segment) => segment.agentFrameId === conversationGraph.activeFrameId)
          .at(-1)?.id
        return {
          ...session,
          pendingHistoryReplay: session.pendingHistoryReplay ?? { kind: 'all' },
          conversationGraph,
          updatedAt: now
        }
      })
    } as Partial<State>)
    return runtimeSegmentId
  },
  appendRoutedUserMessage: ({
    sessionId,
    messageId,
    eventId,
    content,
    createdAt,
    attribution,
    responseToMessageId,
    relayedFrom,
    uploads,
    parts,
    annotations
  }) => {
    const trimmedContent = content.trim()
    const persistedUploads = (uploads ?? []).map(createPersistedUpload)
    const session = get().sessions.find((candidate) => candidate.id === sessionId)
    const hasFollowUpBody =
      Boolean(trimmedContent) ||
      persistedUploads.length > 0 ||
      Boolean(parts?.length) ||
      Boolean(annotations?.length)
    if (!session || !hasFollowUpBody) return undefined
    if (session.messages.some((message) => message.id === messageId)) {
      return { sessionId, messageId }
    }
    const matchingFeedbackIndex =
      relayedFrom || !trimmedContent
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
      ...(attribution ? { attribution } : {}),
      ...(relayedFrom ? { relayedFrom } : {}),
      ...(responseToMessageId ? { responseToMessageId } : {}),
      ...(persistedUploads.length > 0 ? { uploads: persistedUploads } : {}),
      ...(parts && parts.length > 0 ? { parts } : {}),
      ...(annotations && annotations.length > 0 ? { annotations } : {})
    }
    const messages = matchingFeedback
      ? session.messages.map((existing, index) =>
          index === matchingFeedbackIndex
            ? {
                ...message,
                sortIndex: matchingFeedback.sortIndex,
                // The provider echo cannot know renderer-stamped send markers; keep the local
                // copy's target snapshot and turn intent when it replaces the local Message.
                ...(matchingFeedback.agentTarget
                  ? { agentTarget: matchingFeedback.agentTarget }
                  : {}),
                ...(matchingFeedback.turnIntent ? { turnIntent: matchingFeedback.turnIntent } : {})
              }
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
    messageId,
    rearmExisting,
    content,
    attachments = [],
    parts,
    annotations,
    pdfContext,
    turnIntent,
    attribution,
    cwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    agentConfiguration,
    memoryEnabled,
    delegationPolicy,
    isPending,
    specialistId,
    enabledComputeHosts,
    selectedComputeHosts,
    preserveSelection,
    agentTarget
  }) => {
    const trimmedContent = content.trim()
    const normalizedAgentBackendId = agentBackendId?.trim() || undefined
    const normalizedAgentModel = agentModel?.trim() || undefined
    const uploads = attachments.map(createPersistedUpload)
    if (!sessionId || (!trimmedContent && uploads.length === 0 && !annotations?.length)) {
      return undefined
    }

    const state = get()
    const existingSession = state.sessions.find((session) => session.id === sessionId)
    const stableMessageId = messageId?.trim()
    if (messageId !== undefined && !stableMessageId) return undefined
    const existingMessage = stableMessageId
      ? existingSession?.messages.find((message) => message.id === stableMessageId)
      : undefined
    if (existingMessage) {
      if (existingMessage.role !== 'user' || existingMessage.content !== trimmedContent) {
        return undefined
      }
      if (rearmExisting && existingSession) {
        const now = Date.now()
        const activeRun: ActiveRun = {
          promptMessageId: existingMessage.id,
          startedAt: now
        }
        set({
          selectedSessionId: preserveSelection ? state.selectedSessionId : sessionId,
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  status: 'running',
                  activeRun,
                  activeRunRuntimeSegmentId: undefined,
                  interrupted: undefined,
                  resumeRecovery: undefined,
                  agentStatus: undefined,
                  error: undefined,
                  errorReportable: undefined,
                  compacting: undefined,
                  messages: session.messages.map((message) =>
                    message.id === existingMessage.id
                      ? { ...message, interrupted: undefined }
                      : message
                  ),
                  updatedAt: now
                }
              : session
          )
        } as Partial<State>)
      }
      return { sessionId, messageId: existingMessage.id }
    }
    const now = Date.now()
    const userMessage: ChatMessage = {
      ...buildUserMessage({
        id: stableMessageId ?? createMessageId(),
        content: trimmedContent,
        uploads,
        parts,
        annotations,
        pdfContext,
        turnIntent,
        sortIndex: createSortIndex()
      }),
      ...(attribution ? { attribution } : {}),
      ...(agentTarget ? { agentTarget } : {})
    }
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
        selectedSessionId: preserveSelection ? state.selectedSessionId : sessionId,
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
                ...(agentConfiguration && !session.agentConfiguration
                  ? { agentConfiguration }
                  : {}),
                ...sessionDetails.prepareExistingSessionDetails(existingSession, userMessage),
                agentStatus: undefined,
                error: undefined,
                errorReportable: undefined,
                compacting: undefined,
                messages: nextMessages,
                pendingContextReplayMessageId: replayPromptIndex >= 0 ? userMessage.id : undefined,
                conversationGraph: synchronizeSessionGraph(
                  session,
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
        delegationPolicyAuthorityPending:
          isPending && delegationPolicy !== undefined ? true : undefined,
        ...sessionDetails.prepareNewRootSessionDetails(
          userMessage,
          createTitleFromMessage(trimmedContent || createTitleFromUploads(uploads))
        ),
        cwd: cwd ?? '',
        status: 'running',
        permissionProfile: permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        agentFrameworkId,
        agentBackendId: normalizedAgentBackendId,
        agentModel: normalizedAgentModel,
        ...(agentConfiguration ? { agentConfiguration } : {}),
        memoryEnabled: memoryEnabled !== false,
        ...(delegationPolicy ? { delegationPolicy } : {}),
        ...(specialistId ? { specialistId } : {}),
        ...(enabledComputeHosts?.length
          ? {
              enabledComputeHosts: [...enabledComputeHosts],
              selectedComputeHosts: [...(selectedComputeHosts ?? [])]
            }
          : {}),
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
        selectedSessionId: preserveSelection ? state.selectedSessionId : sessionId,
        sessions: [newSession, ...state.sessions]
      } as Partial<State>)
    }

    return { sessionId, messageId: userMessage.id }
  },
  appendPendingUserMessage: (input) =>
    get().appendUserMessage({
      ...input,
      sessionId: createPendingSessionId(),
      isPending: true
    }),
  branchInNewSession: ({
    sourceSessionId,
    sourceMessageId,
    content,
    attachments = [],
    parts,
    annotations,
    turnIntent,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    agentConfiguration,
    memoryEnabled,
    delegationPolicy,
    specialistId,
    agentTarget
  }) => {
    const trimmedContent = content?.trim() ?? ''
    const uploads = attachments.map(createPersistedUpload)
    if (
      !sourceSessionId ||
      (!sourceMessageId && !trimmedContent && uploads.length === 0 && !annotations?.length)
    ) {
      return undefined
    }

    const state = get()
    const source = state.sessions.find((session) => session.id === sourceSessionId)
    if (!source || !canBranchInNewSession(source)) return undefined

    const snapshot = projectSessionBranchSnapshot(source, sourceMessageId)
    if (!snapshot) return undefined
    const {
      sourceMessage,
      messages: sourceMessages,
      activities: sourceActivities,
      activityGroups: sourceActivityGroups
    } = snapshot

    const now = Date.now()
    const sessionId = createPendingSessionId()
    const userMessage = sourceMessage
      ? undefined
      : {
          ...buildUserMessage({
            id: createMessageId(),
            content: trimmedContent,
            uploads,
            parts,
            annotations,
            turnIntent,
            sortIndex: createSortIndex()
          }),
          ...(agentTarget ? { agentTarget } : {})
        }
    const messages = [
      ...sourceMessages.map(({ message, sortIndex }) => copySnapshotMessage(message, sortIndex)),
      ...(userMessage ? [userMessage] : [])
    ]
    const normalizedAgentBackendId = agentBackendId?.trim() || source.agentBackendId
    const normalizedAgentModel = agentModel?.trim() || source.agentModel
    const normalizedFrameworkId = agentFrameworkId ?? source.agentFrameworkId
    const nextSpecialistId =
      specialistId === undefined ? source.specialistId : specialistId || undefined
    const newSession: ChatSession = {
      id: sessionId,
      projectId: source.projectId,
      branchSource: createSessionBranchSource(source, sourceMessage?.id),
      isPending: true,
      delegationPolicyAuthorityPending: true,
      title: sourceMessage
        ? source.title
        : trimmedContent
          ? createBranchTitleFromMessage(trimmedContent)
          : createTitleFromUploads(uploads),
      cwd: source.cwd,
      status: userMessage ? 'running' : 'idle',
      permissionProfile:
        permissionProfile ?? source.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      agentFrameworkId: normalizedFrameworkId,
      agentBackendId: normalizedAgentBackendId,
      agentModel: normalizedAgentModel,
      agentConfiguration: agentConfiguration ?? source.agentConfiguration,
      ...(source.autoReviewEnabled !== undefined
        ? { autoReviewEnabled: source.autoReviewEnabled }
        : {}),
      delegationPolicy: delegationPolicy ?? normalizeDelegationPolicy(source.delegationPolicy),
      memoryEnabled: memoryEnabled ?? source.memoryEnabled ?? true,
      ...(source.enabledComputeHosts
        ? { enabledComputeHosts: [...source.enabledComputeHosts] }
        : {}),
      ...(source.selectedComputeHosts
        ? { selectedComputeHosts: [...source.selectedComputeHosts] }
        : {}),
      ...(source.computeConcurrencyLimit !== undefined
        ? { computeConcurrencyLimit: source.computeConcurrencyLimit }
        : {}),
      ...(nextSpecialistId ? { specialistId: nextSpecialistId } : {}),
      messages,
      activities: sourceActivities.map((activity) => copySnapshotActivity(activity, sessionId)),
      activityGroups: sourceActivityGroups.map((group) =>
        copySnapshotActivityGroup(group, sessionId)
      ),
      ...(userMessage
        ? {
            pendingContextReplayMessageId: userMessage.id,
            activeRun: { promptMessageId: userMessage.id, startedAt: now }
          }
        : { pendingHistoryReplay: { kind: 'all' as const } }),
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

    return userMessage ? { sessionId, messageId: userMessage.id } : { sessionId }
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
    if (!pendingSession) return undefined

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

    return pendingSession.activeRun
      ? { sessionId, messageId: pendingSession.activeRun.promptMessageId }
      : { sessionId }
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

    set((state) => {
      let retainedMessageIds: Set<string> | undefined
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const cutIndex = session.messages.findIndex((message) => message.id === messageId)
        if (cutIndex < 0) return session
        const removedMessages = session.messages.slice(cutIndex)
        const hasFiles = removedMessages.some(
          (message) => (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
        )
        const now = Date.now()
        const currentGraph = synchronizeSessionGraph(session, session.messages, now)
        const conversationGraph = forkEditedConversationMessage(
          currentGraph,
          messageId,
          createConversationBranchId(),
          now
        )
        const retained = session.messages.slice(0, cutIndex)
        retainedMessageIds = new Set(retained.map((message) => message.id))

        return {
          ...session,
          messages: retained,
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
      return {
        sessions,
        ...(retainedMessageIds
          ? {
              streamingMessages: pruneStreamingMessageContent(
                state.streamingMessages,
                sessionId,
                retainedMessageIds
              )
            }
          : {})
      } as Partial<State>
    })
  },

  truncateSessionFromMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set((state) => {
      let retainedMessageIds: Set<string> | undefined
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const cutIndex = session.messages.findIndex((message) => message.id === messageId)
        if (cutIndex < 0) return session

        const cutMessage = session.messages[cutIndex]
        const removed = session.messages.slice(cutIndex)
        const hasFiles = removed.some(
          (message) => (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
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
        const retained = session.messages.slice(0, cutIndex)
        retainedMessageIds = new Set(retained.map((message) => message.id))

        return {
          ...session,
          status: 'idle',
          messages: retained,
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
      return {
        sessions,
        ...(retainedMessageIds
          ? {
              streamingMessages: pruneStreamingMessageContent(
                state.streamingMessages,
                sessionId,
                retainedMessageIds
              )
            }
          : {})
      } as Partial<State>
    })
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
    set((state) => {
      let retainedMessageIds: Set<string> | undefined
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const projection = projectElicitationRevision(
          session,
          activityId,
          createConversationBranchId(),
          Date.now()
        )
        revised = Boolean(projection)
        if (projection) {
          retainedMessageIds = new Set(projection.messages.map((message) => message.id))
        }
        return projection ?? session
      })
      return {
        sessions,
        ...(retainedMessageIds
          ? {
              streamingMessages: pruneStreamingMessageContent(
                state.streamingMessages,
                sessionId,
                retainedMessageIds
              )
            }
          : {})
      } as Partial<State>
    })
    return revised
  },

  activateMessageBranch: (sessionId, branchId) => {
    if (!sessionId || !branchId) return
    set((state) => {
      let retainedMessageIds: Set<string> | undefined
      const sessions = state.sessions.map((session) => {
        if (
          session.id !== sessionId ||
          !session.conversationGraph ||
          session.activeRun ||
          session.status === 'running' ||
          session.status === 'waiting-for-user' ||
          session.status === 'waiting-permission' ||
          session.status === 'waiting-plan-approval' ||
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
        const conversationGraph = activateConversationBranch(session.conversationGraph, branchId)
        const messages = resolveActiveConversationMessages(conversationGraph).map(
          (message, index): ChatMessage => ({
            ...projectConversationMessage(message),
            sortIndex: index + 1
          })
        )
        retainedMessageIds = new Set(messages.map((message) => message.id))
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
      return {
        sessions,
        ...(retainedMessageIds
          ? {
              streamingMessages: pruneStreamingMessageContent(
                state.streamingMessages,
                sessionId,
                retainedMessageIds
              )
            }
          : {})
      } as Partial<State>
    })
  }
})

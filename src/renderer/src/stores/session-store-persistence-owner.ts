import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'
import type { StoreApi } from 'zustand'

import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  materializeSessionConversationGraph,
  sanitizeActivityGroup,
  sanitizePlanHistoryProjections,
  sanitizeToolActivity,
  type PersistedActiveRun,
  type PersistedActivityGroup,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageRole,
  type PersistedMessageStatus,
  type PersistedSessionManifest,
  type PersistedSessionStatus,
  type PersistedToolActivity,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'

export type SessionStatus = PersistedSessionStatus
export type ChatMessageRole = PersistedMessageRole
export type ChatMessageStatus = PersistedMessageStatus
export type ChatMessage = PersistedChatMessage & {
  sortIndex?: number
}
export type ActiveRun = PersistedActiveRun
export type ToolActivityStatus = ToolCallStatus
export type ToolActivity = {
  id: string
  kind: 'tool'
  title: string
  activityGroupId?: string
  promptMessageId?: string
  status: ToolActivityStatus
  eventIds: string[]
  sortIndex: number
  providerToolName?: string
  toolKind?: ToolKind
  toolContent?: ToolCallContent[]
  toolLocations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
  createdAt: number
  updatedAt: number
}
export type ChatSession = Omit<
  PersistedChatSession,
  'messages' | 'activities' | 'permissionProfile'
> & {
  permissionProfile?: PermissionProfileId
  messages: ChatMessage[]
  activities?: ToolActivity[]
  activePlanProjection?: ActivePlanProjection
  planHistoryProjections?: ActivePlanProjection[]
  isPending?: boolean
  interrupted?: boolean
  fixLoopActive?: boolean
  compacting?: boolean
  agentStatus?: string
  awaitingFirstAgentOutput?: boolean
  agentPromptInFlight?: boolean
  branchContextResetRequired?: boolean
  specialistSwitchResetRequired?: boolean
  branchSwitchBlocked?: boolean
  conversationGraphSyncBlocked?: boolean
  pendingContextReplayMessageId?: string
}

export type SessionStoreData = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
}

export type SessionHydrationSelection = {
  sessionId: string | undefined
}

export type ApplyDurableSessionProjectionInput = {
  source: ChatSession
  session: PersistedChatSession
  mode?: 'merge-upload-identities' | 'replace-persisted-if-current'
}

export type SessionPersistenceActions = {
  hydrateSessions: (
    sessions: PersistedChatSession[],
    manifest?: PersistedSessionManifest,
    selection?: SessionHydrationSelection
  ) => void
  upsertPersistedSession: (session: PersistedChatSession) => void
  applyDurableSessionProjection: (input: ApplyDurableSessionProjectionInput) => void
}

const externallyHydratedSessions = new WeakSet<ChatSession>()

// Builds the empty in-memory state used by the app and isolated tests.
export const createInitialSessionState = (): SessionStoreData => ({
  sessions: [],
  selectedSessionId: undefined
})

export const stripTransientMessageState = (message: ChatMessage): PersistedChatMessage => {
  const { sortIndex, ...persistedMessage } = message

  void sortIndex

  return persistedMessage
}

// Serializes one in-memory session into the durable per-file projection saved by the main process.
export const toPersistedSession = (session: ChatSession): PersistedChatSession => {
  if (session.conversationGraphSyncBlocked) {
    throw new Error(
      'Session persistence is blocked after conversation graph synchronization failed.'
    )
  }

  const {
    activities,
    activityGroups,
    isPending,
    interrupted,
    fixLoopActive,
    compacting,
    agentStatus,
    awaitingFirstAgentOutput,
    agentPromptInFlight,
    branchContextResetRequired,
    specialistSwitchResetRequired,
    branchSwitchBlocked,
    conversationGraphSyncBlocked,
    pendingContextReplayMessageId,
    activePlanProjection,
    planHistoryProjections,
    runtimeContext,
    messages,
    ...persistedSession
  } = session

  void isPending
  void interrupted
  void fixLoopActive
  void compacting
  void agentStatus
  void awaitingFirstAgentOutput
  void agentPromptInFlight
  void branchContextResetRequired
  void specialistSwitchResetRequired
  void branchSwitchBlocked
  void conversationGraphSyncBlocked
  void pendingContextReplayMessageId
  void activePlanProjection
  void runtimeContext

  const persistedPlanHistory = sanitizePlanHistoryProjections(planHistoryProjections)
  const persistedActivities = activities
    ?.map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => !!activity)
  const persistedActivityGroups = activityGroups
    ?.map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => !!group)

  return materializeSessionConversationGraph({
    ...persistedSession,
    messages: messages.map(stripTransientMessageState),
    ...(persistedPlanHistory ? { planHistoryProjections: persistedPlanHistory } : {}),
    ...(persistedActivities && persistedActivities.length > 0
      ? { activities: persistedActivities }
      : {}),
    ...(persistedActivityGroups && persistedActivityGroups.length > 0
      ? { activityGroups: persistedActivityGroups }
      : {})
  })
}

// Restores a persisted tool activity into the richer runtime shape the UI derives its rows from.
export const hydrateToolActivity = (activity: PersistedToolActivity): ToolActivity => ({
  ...activity,
  toolKind: activity.toolKind as ToolKind | undefined,
  toolContent: activity.toolContent as ToolCallContent[] | undefined,
  toolLocations: activity.toolLocations as ToolCallLocation[] | undefined
})

// Maps a persisted session (with bounded activities) back into the in-memory chat session shape.
export const hydrateSession = (session: PersistedChatSession): ChatSession => ({
  ...session,
  permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
  activities: session.activities?.map(hydrateToolActivity),
  interrupted: session.error === INTERRUPTED_SESSION_ERROR ? true : undefined
})

const matchesPersistedPlanProjection = (
  projection: ActivePlanProjection | undefined,
  session: PersistedChatSession
): projection is ActivePlanProjection => {
  const runtimeContext = session.runtimeContext
  const plan = runtimeContext?.plan
  return Boolean(
    projection &&
    plan &&
    projection.revision === runtimeContext.revision &&
    projection.artifactId === plan.artifactId &&
    projection.artifactVersionId === plan.artifactVersionId &&
    projection.artifactChecksum === plan.artifactChecksum &&
    projection.approval === plan.approval
  )
}

const withTransientSessionState = (
  session: PersistedChatSession,
  source: ChatSession
): ChatSession => {
  const sourceMessages = new Map(source.messages.map((message) => [message.id, message]))
  const hydrated = hydrateSession(session)
  return {
    ...hydrated,
    messages: hydrated.messages.map((message) => ({
      ...message,
      sortIndex: sourceMessages.get(message.id)?.sortIndex
    })),
    isPending: source.isPending,
    interrupted: source.interrupted,
    fixLoopActive: source.fixLoopActive,
    compacting: source.compacting,
    agentStatus: source.agentStatus,
    awaitingFirstAgentOutput: source.awaitingFirstAgentOutput,
    agentPromptInFlight: source.agentPromptInFlight,
    branchContextResetRequired: source.branchContextResetRequired,
    specialistSwitchResetRequired: source.specialistSwitchResetRequired,
    branchSwitchBlocked: source.branchSwitchBlocked,
    conversationGraphSyncBlocked: source.conversationGraphSyncBlocked,
    pendingContextReplayMessageId: source.pendingContextReplayMessageId
  }
}

const isSameSubmittedUpload = (
  current: PersistedUploadedAttachment,
  submitted: PersistedUploadedAttachment
): boolean =>
  current.id === submitted.id &&
  current.versionId === submitted.versionId &&
  current.sessionId === submitted.sessionId &&
  current.name === submitted.name &&
  current.originalName === submitted.originalName &&
  current.path === submitted.path &&
  current.mimeType === submitted.mimeType &&
  current.size === submitted.size

const mergeDurableUploadProjection = <Message extends PersistedChatMessage>(
  currentMessages: Message[],
  submittedMessages: PersistedChatMessage[],
  durableMessages: PersistedChatMessage[]
): { messages: Message[]; changed: boolean } => {
  const submittedById = new Map(submittedMessages.map((message) => [message.id, message]))
  const durableById = new Map(durableMessages.map((message) => [message.id, message]))
  let changed = false
  const messages = currentMessages.map((message) => {
    const submitted = submittedById.get(message.id)
    const durable = durableById.get(message.id)
    if (!message.uploads || !submitted?.uploads || !durable?.uploads) return message
    const submittedUploads = new Map(submitted.uploads.map((upload) => [upload.id, upload]))
    const durableUploads = new Map(durable.uploads.map((upload) => [upload.id, upload]))
    let uploadsChanged = false
    const uploads = message.uploads.map((upload) => {
      const submittedUpload = submittedUploads.get(upload.id)
      const durableUpload = durableUploads.get(upload.id)
      if (
        !submittedUpload ||
        !durableUpload?.versionId ||
        submittedUpload.versionId ||
        !isSameSubmittedUpload(upload, submittedUpload)
      ) {
        return upload
      }
      uploadsChanged = true
      return durableUpload
    })
    if (!uploadsChanged) return message
    changed = true
    return { ...message, uploads } as Message
  })
  return { messages, changed }
}

export const createSessionPersistenceOwner = <State extends SessionStoreData>(
  set: StoreApi<State>['setState']
): SessionPersistenceActions => ({
  hydrateSessions: (sessions, manifest, selection) => {
    const hydrated = [...sessions]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(hydrateSession)
    const hasExplicitSelection = selection !== undefined
    const requestedSelection = hasExplicitSelection ? selection.sessionId : manifest?.lastSessionId
    const selectedSessionId = hydrated.some((session) => session.id === requestedSelection)
      ? requestedSelection
      : hasExplicitSelection
        ? undefined
        : hydrated[0]?.id

    set({ sessions: hydrated, selectedSessionId } as Partial<State>)
  },

  upsertPersistedSession: (session) => {
    set((state) => {
      const existing = state.sessions.find((candidate) => candidate.id === session.id)
      if (existing && existing.updatedAt > session.updatedAt) {
        if (existing.archivedAt === session.archivedAt) return state
        const withoutPreviousArchive = { ...existing }
        delete withoutPreviousArchive.archivedAt
        const projected: ChatSession = {
          ...withoutPreviousArchive,
          ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt })
        }
        externallyHydratedSessions.add(projected)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }
      if (existing && existing.updatedAt === session.updatedAt) {
        const flat = mergeDurableUploadProjection(
          existing.messages,
          existing.messages,
          session.messages
        )
        const graph = existing.conversationGraph
          ? mergeDurableUploadProjection(
              existing.conversationGraph.messages,
              existing.conversationGraph.messages,
              session.conversationGraph?.messages ?? session.messages
            )
          : undefined
        const archiveChanged = existing.archivedAt !== session.archivedAt
        if (!flat.changed && !graph?.changed && !archiveChanged) return state
        const withoutPreviousArchive = { ...existing }
        delete withoutPreviousArchive.archivedAt
        const projected: ChatSession = {
          ...withoutPreviousArchive,
          ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
          messages: flat.messages,
          ...(graph?.changed
            ? {
                conversationGraph: {
                  ...existing.conversationGraph!,
                  messages: graph.messages
                }
              }
            : {})
        }
        externallyHydratedSessions.add(projected)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      const hydratedSession = hydrateSession(session)
      const currentPlanProjection = matchesPersistedPlanProjection(
        existing?.activePlanProjection,
        session
      )
        ? { activePlanProjection: existing.activePlanProjection }
        : {}
      const retainedPlanHistory =
        !hydratedSession.planHistoryProjections && existing?.planHistoryProjections
          ? { planHistoryProjections: existing.planHistoryProjections }
          : {}
      const hydratedWithTransientState = {
        ...hydratedSession,
        ...retainedPlanHistory,
        ...currentPlanProjection
      }
      externallyHydratedSessions.add(hydratedWithTransientState)
      const nextSessions = [
        hydratedWithTransientState,
        ...state.sessions.filter((candidate) => candidate.id !== session.id)
      ].sort((left, right) => right.updatedAt - left.updatedAt)

      return { sessions: nextSessions } as Partial<State>
    })
  },

  applyDurableSessionProjection: ({ source, session, mode = 'merge-upload-identities' }) => {
    set((state) => {
      const current = state.sessions.find((candidate) => candidate.id === session.id)
      if (!current) return state

      let projected: ChatSession
      if (current === source && mode === 'replace-persisted-if-current') {
        projected = withTransientSessionState(session, current)
      } else if (current === source) {
        const flat = mergeDurableUploadProjection(
          source.messages,
          source.messages,
          session.messages
        )
        const graph = source.conversationGraph
          ? mergeDurableUploadProjection(
              source.conversationGraph.messages,
              source.conversationGraph.messages,
              session.conversationGraph?.messages ?? session.messages
            )
          : undefined
        if (!flat.changed && !graph?.changed) return state
        projected = withTransientSessionState(session, current)
      } else {
        const flat = mergeDurableUploadProjection(
          current.messages,
          source.messages,
          session.messages
        )
        const graph = current.conversationGraph
          ? mergeDurableUploadProjection(
              current.conversationGraph.messages,
              source.conversationGraph?.messages ?? source.messages,
              session.conversationGraph?.messages ?? session.messages
            )
          : undefined
        if (!flat.changed && !graph?.changed) return state
        projected = {
          ...current,
          messages: flat.messages,
          ...(graph?.changed
            ? {
                conversationGraph: {
                  ...current.conversationGraph!,
                  messages: graph.messages
                }
              }
            : {})
        }
      }

      externallyHydratedSessions.add(projected)
      return {
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id ? projected : candidate
        )
      } as Partial<State>
    })
  }
})

export const isExternallyHydratedSession = (session: ChatSession): boolean =>
  externallyHydratedSessions.has(session)

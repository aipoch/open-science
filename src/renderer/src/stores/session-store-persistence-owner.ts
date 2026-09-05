import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'
import type { StoreApi } from 'zustand'

import type { ElicitationProjection } from '../../../shared/acp'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import { DEFAULT_PERMISSION_PROFILE } from '../../../shared/permission-profiles'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  materializeSessionConversationGraph,
  normalizeDelegationPolicy,
  sanitizeActivityGroup,
  sanitizePlanHistoryProjections,
  sessionRevision,
  sanitizeToolActivity,
  type PersistedArtifact,
  type PersistedActiveRun,
  type PersistedActivityGroup,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageRole,
  type PersistedMessageStatus,
  type PersistedSessionManifest,
  type PersistedSessionStatus,
  type PersistedToolActivity,
  type SessionSummary
} from '../../../shared/session-persistence'
import {
  inferSessionInteractionState,
  resolveSessionInteractionStatus,
  type SessionInteractionState
} from './session-store-interaction-state'
import {
  mergeDelegatedWorkAuthorityProjection,
  mergeDurableUploadProjection,
  mergeNewerPersistedSessionByIdentity,
  mergePersistedRuntimeIdentityProjection,
  mergeRuntimeConversationAuthority,
  retainRuntimePlanProjection
} from './session-store-persistence-merge'
import * as sessionDetails from './session-store-session-details'

export type SessionStatus = PersistedSessionStatus
export type ChatMessageRole = PersistedMessageRole
export type ChatMessageStatus = PersistedMessageStatus
export type ChatMessage = PersistedChatMessage & { sortIndex?: number }
export type ActiveRun = PersistedActiveRun
export type ToolActivityStatus = ToolCallStatus
export type ToolActivity = {
  id: string
  kind: 'tool'
  title: string
  activityGroupId?: string
  promptMessageId?: string
  status: ToolActivityStatus
  toolDisposition?: 'declined' | 'permission-closed'
  executionInvocationId?: string
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
  elicitation?: ElicitationProjection
  createdAt: number
  updatedAt: number
}
export type ChatArtifact = PersistedArtifact & { isPublished?: boolean }

export type ChatSession = Omit<
  PersistedChatSession,
  'messages' | 'activities' | 'permissionProfile' | 'artifacts'
> & {
  artifacts?: ChatArtifact[]
  permissionProfile?: PermissionProfileId
  messages: ChatMessage[]
  activities?: ToolActivity[]
  activePlanProjection?: ActivePlanProjection
  planHistoryProjections?: ActivePlanProjection[]
  isPending?: boolean
  // Transient: the first send has captured Delegation, but Main has not acknowledged the new
  // Session policy yet. Binding an Agent Session does not make this policy authoritative.
  delegationPolicyAuthorityPending?: true
  // Transient: renameSession wrote a title that disk has not acknowledged.
  unsavedTitle?: true
  interrupted?: boolean
  fixLoopActive?: boolean
  compacting?: boolean
  agentStatus?: string
  awaitingFirstAgentOutput?: boolean
  agentPromptInFlight?: boolean
  // Transient provenance owner for responses emitted while an interrupted turn is resumed.
  activeRunRuntimeSegmentId?: string
  branchContextResetRequired?: boolean
  specialistSwitchResetRequired?: boolean
  // Transient: a restored durable choice resumed into a fresh Agent context. Keep the request id
  // until its hidden continuation is accepted so a renderer/IPC retry replays the same history.
  elicitationHistoryReplayRequestId?: string
  branchSwitchBlocked?: boolean
  conversationGraphSyncBlocked?: boolean
  pendingContextReplayMessageId?: string
  // Transient independent facts for the blocking lane. Plan remains owned by its durable
  // projection, while Side chat remains an overlay that never settles these facts.
  interactionState?: SessionInteractionState
  // False only for a SQLite-backed startup row whose transcript JSON has not been opened yet.
  contentLoaded?: false
  activeMessageCount?: number
  artifactCount?: number
  presentedActivityAt?: number
}

export type StreamingMessageContent = {
  sessionId: string
  // Full in-flight text (the base Message content plus every chunk appended since the Message
  // last changed identity), held outside session.messages so pure text-growth ticks keep the
  // Session object and messages array referentially stable.
  content: string
  // Full applied event id list (the base Message's eventIds plus in-flight ids) for replay dedup.
  eventIds: string[]
  updatedAt: number
}

// Keyed by message id. Agent message ids are deterministic per (session, stream, prompt), so the
// key is known before the Message object exists and is unique across Sessions.
export type StreamingMessageContentByMessageId = Record<string, StreamingMessageContent>

export type SessionStoreData = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
  streamingMessages: StreamingMessageContentByMessageId
}

export type SessionHydrationSelection = { sessionId: string | undefined }

export type ApplyDurableSessionProjectionInput = {
  source: ChatSession
  session: PersistedChatSession
  mode?:
    | 'merge-upload-identities'
    | 'replace-persisted-if-current'
    | 'permission-authority'
    | 'runtime-context-authority'
    | 'compute-host-access-authority'
    | 'delegated-authority'
    | 'session-details-authority'
}

export type SessionPersistenceActions = {
  applyDelegationPolicyAuthority: (session: PersistedChatSession) => void
  applyDurableSessionProjection: (input: ApplyDurableSessionProjectionInput) => void
  hydrateSessions: (
    sessions: PersistedChatSession[],
    manifest?: PersistedSessionManifest,
    selection?: SessionHydrationSelection
  ) => void
  hydrateSessionSummaries: (
    summaries: SessionSummary[],
    selected: PersistedChatSession | undefined,
    manifest?: PersistedSessionManifest,
    selection?: SessionHydrationSelection
  ) => void
  upsertPersistedSession: (session: PersistedChatSession) => void
}

const externallyHydratedSessionAuthorities = new WeakMap<ChatSession, PersistedChatSession>()

const markExternallyHydratedSession = (
  session: ChatSession,
  authority: PersistedChatSession
): void => {
  externallyHydratedSessionAuthorities.set(session, structuredClone(authority))
}

export const createInitialSessionState = (): SessionStoreData => ({
  sessions: [],
  selectedSessionId: undefined,
  streamingMessages: {}
})

// Folds one Session's in-flight streaming entries back into its Message objects. Terminal
// projections (finish/interrupt/fail) call this first so the final Message content, event ids,
// and conversation-graph sync observe the complete turn exactly as if chunks had been committed
// to the Message directly.
export const materializeStreamingMessageContent = (
  session: ChatSession,
  streamingMessages: StreamingMessageContentByMessageId
): ChatSession => {
  let messages: ChatMessage[] | undefined
  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index]
    const entry = streamingMessages[message.id]
    if (!entry) continue
    if (!messages) messages = session.messages.slice()
    messages[index] = {
      ...message,
      content: entry.content,
      eventIds: entry.eventIds,
      updatedAt: Math.max(message.updatedAt, entry.updatedAt)
    }
  }
  return messages ? { ...session, messages } : session
}

export const removeStreamingMessageContentForSession = (
  streamingMessages: StreamingMessageContentByMessageId,
  sessionId: string
): StreamingMessageContentByMessageId => {
  const keys = Object.keys(streamingMessages).filter(
    (key) => streamingMessages[key].sessionId === sessionId
  )
  if (keys.length === 0) return streamingMessages
  const next = { ...streamingMessages }
  for (const key of keys) delete next[key]
  return next
}

// Drops a Session's entries whose Message no longer exists (edit/truncate/branch activation), so a
// later turn that reuses the deterministic Message id cannot resurrect superseded text.
export const pruneStreamingMessageContent = (
  streamingMessages: StreamingMessageContentByMessageId,
  sessionId: string,
  retainedMessageIds: ReadonlySet<string>
): StreamingMessageContentByMessageId => {
  const keys = Object.keys(streamingMessages).filter(
    (key) => streamingMessages[key].sessionId === sessionId && !retainedMessageIds.has(key)
  )
  if (keys.length === 0) return streamingMessages
  const next = { ...streamingMessages }
  for (const key of keys) delete next[key]
  return next
}

export const stripTransientMessageState = (message: ChatMessage): PersistedChatMessage => {
  const { sortIndex, ...persistedMessage } = message

  void sortIndex

  return persistedMessage
}

// Serializes one in-memory session into the durable per-file projection saved by the main process.
// In-flight streaming text is folded into its Message first so a flush mid-stream never loses
// chunks that have not been committed to session.messages yet.
export const toPersistedSession = (
  session: ChatSession,
  streamingMessages?: StreamingMessageContentByMessageId
): PersistedChatSession => {
  if (session.contentLoaded === false) {
    throw new Error('Session content must be loaded before persistence.')
  }
  if (session.conversationGraphSyncBlocked) {
    throw new Error(
      'Session persistence is blocked after conversation graph synchronization failed.'
    )
  }

  const {
    activities,
    activityGroups,
    isPending,
    delegationPolicyAuthorityPending,
    unsavedTitle,
    interrupted,
    fixLoopActive,
    compacting,
    agentStatus,
    awaitingFirstAgentOutput,
    agentPromptInFlight,
    activeRunRuntimeSegmentId,
    branchContextResetRequired,
    specialistSwitchResetRequired,
    elicitationHistoryReplayRequestId,
    branchSwitchBlocked,
    conversationGraphSyncBlocked,
    pendingContextReplayMessageId,
    interactionState,
    activePlanProjection,
    contentLoaded,
    activeMessageCount,
    artifactCount,
    presentedActivityAt,
    planHistoryProjections,
    runtimeContext,
    artifacts,
    messages,
    ...persistedSession
  } = session

  void isPending
  void delegationPolicyAuthorityPending
  void unsavedTitle
  void interrupted
  void fixLoopActive
  void compacting
  void agentStatus
  void awaitingFirstAgentOutput
  void agentPromptInFlight
  void activeRunRuntimeSegmentId
  void branchContextResetRequired
  void specialistSwitchResetRequired
  void elicitationHistoryReplayRequestId
  void branchSwitchBlocked
  void conversationGraphSyncBlocked
  void pendingContextReplayMessageId
  void interactionState
  void activePlanProjection
  void contentLoaded
  void activeMessageCount
  void artifactCount
  void presentedActivityAt
  void runtimeContext

  const persistedPlanHistory = sanitizePlanHistoryProjections(planHistoryProjections)
  const persistedActivities = activities
    ?.map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => !!activity)
  const persistedActivityGroups = activityGroups
    ?.map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => !!group)

  const persistedMessages = streamingMessages
    ? messages.map((message) => {
        const entry = streamingMessages[message.id]
        return entry && entry.sessionId === session.id
          ? {
              ...message,
              content: entry.content,
              eventIds: entry.eventIds,
              updatedAt: Math.max(message.updatedAt, entry.updatedAt)
            }
          : message
      })
    : messages

  return materializeSessionConversationGraph({
    ...(artifacts
      ? {
          artifacts: artifacts.map(({ isPublished, ...artifact }) => {
            void isPublished
            return artifact
          })
        }
      : {}),
    ...persistedSession,
    messages: persistedMessages.map(stripTransientMessageState),
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
export const hydrateSession = (session: PersistedChatSession): ChatSession => {
  const hydrated: ChatSession = {
    ...session,
    ...sessionDetails.projectLegacySessionDetails(session),
    permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    activities: session.activities?.map(hydrateToolActivity),
    interrupted:
      session.resumeRecovery?.kind === 'resume-required' ||
      session.error === INTERRUPTED_SESSION_ERROR
        ? true
        : undefined
  }
  return { ...hydrated, interactionState: inferSessionInteractionState(hydrated) }
}

const hydrateSessionSummary = (summary: SessionSummary): ChatSession => ({
  number: summary.number,
  id: summary.id,
  projectId: summary.projectId,
  title: summary.title,
  cwd: '',
  status: summary.presentedStatus,
  pinned: summary.pinned,
  ...(summary.archivedAt !== undefined ? { archivedAt: summary.archivedAt } : {}),
  revision: summary.revision,
  messages: [],
  filesRevision: summary.filesRevision,
  createdAt: summary.createdAt,
  updatedAt: summary.updatedAt,
  contentLoaded: false,
  activeMessageCount: summary.activeMessageCount,
  artifactCount: summary.artifactCount,
  ...(summary.presentedActivityAt !== undefined
    ? { presentedActivityAt: summary.presentedActivityAt }
    : {}),
  interactionState: {
    permission: summary.presentedStatus === 'waiting-permission',
    elicitation: summary.presentedStatus === 'waiting-for-user',
    plan: summary.presentedStatus === 'waiting-plan-approval'
  }
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

const projectRuntimePlanHistoryAuthority = (
  incoming: Pick<PersistedChatSession, 'planHistoryProjections' | 'runtimeContext'>
): ActivePlanProjection[] | undefined => {
  const byArtifactVersionId = new Map<string, ActivePlanProjection>()
  // Runtime lifecycle events carry a complete Main-owned Session projection. An omitted history is
  // therefore an authoritative clear; genuinely older echoes are rejected by the revision guard.
  for (const projection of incoming.planHistoryProjections ?? []) {
    byArtifactVersionId.set(projection.artifactVersionId, projection)
  }

  const currentRuntimeArtifactVersionId = incoming.runtimeContext?.plan?.artifactVersionId
  return sanitizePlanHistoryProjections(
    [...byArtifactVersionId.values()].filter(
      ({ artifactVersionId }) => artifactVersionId !== currentRuntimeArtifactVersionId
    )
  )
}

// A save acknowledgement contains durable descriptors only. Preserve a publication fact only for
// the same immutable Version; a different Version must obtain its own authoritative descriptor.
const retainArtifactPublication = (
  artifacts: PersistedArtifact[] | undefined,
  source: ChatSession
): ChatArtifact[] | undefined => {
  const currentById = new Map((source.artifacts ?? []).map((artifact) => [artifact.id, artifact]))
  return artifacts?.map((artifact) => {
    const current = currentById.get(artifact.id)
    return current?.versionId &&
      current.versionId === artifact.versionId &&
      current.artifactId === artifact.artifactId &&
      current.isPublished !== undefined
      ? { ...artifact, isPublished: current.isPublished }
      : artifact
  })
}

const withTransientSessionState = (
  session: PersistedChatSession,
  source: ChatSession
): ChatSession => {
  const sourceMessages = new Map(source.messages.map((message) => [message.id, message]))
  const hydrated = hydrateSession(session)
  return {
    ...hydrated,
    ...(hydrated.artifacts
      ? { artifacts: retainArtifactPublication(hydrated.artifacts, source) }
      : {}),
    messages: hydrated.messages.map((message) => ({
      ...message,
      sortIndex: sourceMessages.get(message.id)?.sortIndex
    })),
    isPending: source.isPending,
    interrupted: source.interrupted ?? hydrated.interrupted,
    fixLoopActive: source.fixLoopActive,
    compacting: source.compacting,
    agentStatus: source.agentStatus,
    awaitingFirstAgentOutput: source.awaitingFirstAgentOutput,
    agentPromptInFlight: source.agentPromptInFlight,
    activeRunRuntimeSegmentId: source.activeRunRuntimeSegmentId,
    branchContextResetRequired: source.branchContextResetRequired,
    specialistSwitchResetRequired: source.specialistSwitchResetRequired,
    elicitationHistoryReplayRequestId: source.elicitationHistoryReplayRequestId,
    branchSwitchBlocked: source.branchSwitchBlocked,
    conversationGraphSyncBlocked: source.conversationGraphSyncBlocked,
    pendingContextReplayMessageId: source.pendingContextReplayMessageId,
    interactionState: source.interactionState
  }
}

const projectDurablePlanAuthority = (
  current: ChatSession,
  durable: PersistedChatSession
): ChatSession => {
  const incomingRevision = durable.runtimeContext?.revision
  const currentRevision = current.runtimeContext?.revision
  const hasPlanAuthority =
    durable.runtimeContext?.plan !== undefined || current.runtimeContext?.plan !== undefined
  if (
    !hasPlanAuthority ||
    incomingRevision === undefined ||
    (currentRevision !== undefined && incomingRevision < currentRevision)
  ) {
    return current
  }

  const interactionState = {
    ...inferSessionInteractionState(current),
    plan: durable.runtimeContext?.plan?.approval === 'pending'
  }
  const status = current.compacting
    ? current.status
    : resolveSessionInteractionStatus(
        { ...current, runtimeContext: durable.runtimeContext },
        interactionState
      )
  return {
    ...current,
    status,
    interactionState,
    runtimeContext: durable.runtimeContext,
    activePlanProjection: matchesPersistedPlanProjection(current.activePlanProjection, durable)
      ? current.activePlanProjection
      : undefined,
    updatedAt: Math.max(current.updatedAt, durable.updatedAt)
  }
}

const projectDelegationPolicyAuthority = (
  current: ChatSession,
  authority: PersistedChatSession
): ChatSession | undefined => {
  if (sessionRevision(authority) < sessionRevision(current)) return undefined

  return {
    ...current,
    revision: sessionRevision(authority),
    delegationPolicy: normalizeDelegationPolicy(authority.delegationPolicy),
    delegationPolicyAuthorityPending: undefined,
    updatedAt: Math.max(current.updatedAt, authority.updatedAt)
  }
}

export const createSessionPersistenceOwner = <State extends SessionStoreData>(
  set: StoreApi<State>['setState']
): SessionPersistenceActions => ({
  applyDelegationPolicyAuthority: (session) => {
    set((state) => {
      const current = state.sessions.find((candidate) => candidate.id === session.id)
      if (!current) {
        const hydrated = hydrateSession(session)
        markExternallyHydratedSession(hydrated, session)
        return {
          sessions: [hydrated, ...state.sessions].sort(
            (left, right) => right.updatedAt - left.updatedAt
          )
        } as Partial<State>
      }

      const projected = projectDelegationPolicyAuthority(current, session)
      if (!projected) return state

      markExternallyHydratedSession(projected, session)
      return {
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id ? projected : candidate
        )
      } as Partial<State>
    })
  },

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

  hydrateSessionSummaries: (summaries, selected, manifest, selection) => {
    const selectedById = selected ? new Map([[selected.id, selected]]) : new Map()
    const hydrated = [...summaries]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((summary) => {
        const authority = selectedById.get(summary.id)
        return authority ? hydrateSession(authority) : hydrateSessionSummary(summary)
      })
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
      if (existing?.contentLoaded === false) {
        const loaded = hydrateSession(session)
        const hydrated: ChatSession = {
          ...loaded,
          number: existing.number ?? loaded.number,
          title: existing.title,
          pinned: existing.pinned,
          archivedAt: existing.archivedAt,
          revision: Math.max(existing.revision ?? 0, loaded.revision ?? 0),
          filesRevision: Math.max(existing.filesRevision ?? 0, loaded.filesRevision ?? 0),
          updatedAt: Math.max(existing.updatedAt, loaded.updatedAt),
          ...(existing.unsavedTitle ? { unsavedTitle: true } : {})
        }
        markExternallyHydratedSession(hydrated, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? hydrated : candidate
          ),
          streamingMessages: pruneStreamingMessageContent(
            state.streamingMessages,
            session.id,
            new Set(hydrated.messages.map((message) => message.id))
          )
        } as Partial<State>
      }
      const incomingSessionRevision = sessionRevision(session)
      const existingSessionRevision = existing ? sessionRevision(existing) : -1
      if (
        existing &&
        (existingSessionRevision > incomingSessionRevision ||
          (existingSessionRevision === incomingSessionRevision &&
            existing.updatedAt >= session.updatedAt))
      ) {
        const incomingRuntimeRevision = session.runtimeContext?.revision ?? -1
        const existingRuntimeRevision = existing.runtimeContext?.revision ?? -1
        const runtimeAdvanced = incomingRuntimeRevision > existingRuntimeRevision
        const sameTimestamp = existing.updatedAt === session.updatedAt
        const runtimeIdentityMerge =
          sameTimestamp && incomingRuntimeRevision === existingRuntimeRevision
        const filesAdvanced = (session.filesRevision ?? 0) > (existing.filesRevision ?? 0)
        const fileIdentityMerge =
          sameTimestamp && (session.filesRevision ?? 0) === (existing.filesRevision ?? 0)
        const archiveChanged = existing.archivedAt !== session.archivedAt
        const flat = sameTimestamp
          ? mergeDurableUploadProjection(existing.messages, existing.messages, session.messages)
          : { messages: existing.messages, changed: false }
        if (
          !runtimeAdvanced &&
          !runtimeIdentityMerge &&
          !filesAdvanced &&
          !fileIdentityMerge &&
          !archiveChanged &&
          !flat.changed
        ) {
          return state
        }
        const withoutPreviousArchive = { ...existing }
        delete withoutPreviousArchive.archivedAt
        const artifactsById = new Map(
          [
            ...(existing.artifacts ?? []),
            ...(retainArtifactPublication(session.artifacts, existing) ?? [])
          ].map((artifact) => [artifact.id, artifact])
        )
        const projected: ChatSession = {
          ...withoutPreviousArchive,
          ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
          messages: flat.messages,
          ...(runtimeAdvanced || runtimeIdentityMerge
            ? mergePersistedRuntimeIdentityProjection(existing, session, {
                // A continuation removes completedAt without changing the Frame's createdAt, so
                // runtime revision—not Frame timestamps—owns lifecycle.
                incomingOwnsFrameConflicts: runtimeAdvanced,
                // A delayed delegated completion can advance its own runtime revision without
                // owning newer root-session state such as Reading context.
                incomingOwnsRuntimeContext: !(
                  existing.updatedAt > session.updatedAt && session.runtimeContext?.delegatedWork
                )
              })
            : {}),
          ...(filesAdvanced || fileIdentityMerge
            ? {
                filesRevision: Math.max(existing.filesRevision ?? 0, session.filesRevision ?? 0),
                artifacts: [...artifactsById.values()]
              }
            : {})
        }
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      const incomingProjection =
        existing &&
        (incomingSessionRevision > existingSessionRevision ||
          (incomingSessionRevision === existingSessionRevision &&
            session.updatedAt > existing.updatedAt))
          ? mergeNewerPersistedSessionByIdentity(existing, session)
          : session
      const hydratedSession = existing
        ? withTransientSessionState(incomingProjection, existing)
        : hydrateSession(session)
      const currentPlanProjection = matchesPersistedPlanProjection(
        existing?.activePlanProjection,
        incomingProjection
      )
        ? { activePlanProjection: existing.activePlanProjection }
        : {}
      const retainedPlanHistory =
        !hydratedSession.planHistoryProjections && existing?.planHistoryProjections
          ? { planHistoryProjections: existing.planHistoryProjections }
          : {}
      const unsavedLocalTitle =
        existing?.unsavedTitle === true && existing.title !== session.title
          ? { title: existing.title, unsavedTitle: true as const }
          : {}
      const hydratedWithTransientState = {
        ...hydratedSession,
        ...retainedPlanHistory,
        ...currentPlanProjection,
        ...unsavedLocalTitle
      }
      markExternallyHydratedSession(hydratedWithTransientState, session)
      const nextSessions = [
        hydratedWithTransientState,
        ...state.sessions.filter((candidate) => candidate.id !== session.id)
      ].sort((left, right) => right.updatedAt - left.updatedAt)

      return {
        sessions: nextSessions,
        streamingMessages: pruneStreamingMessageContent(
          state.streamingMessages,
          session.id,
          new Set(hydratedWithTransientState.messages.map((message) => message.id))
        )
      } as Partial<State>
    })
  },

  applyDurableSessionProjection: ({ source, session, mode = 'merge-upload-identities' }) => {
    set((state) => {
      const current = state.sessions.find((candidate) => candidate.id === session.id)
      if (!current) return state

      if (mode === 'compute-host-access-authority') {
        const projected: ChatSession = {
          ...current,
          revision: Math.max(sessionRevision(current), sessionRevision(session)),
          enabledComputeHosts: session.enabledComputeHosts && [...session.enabledComputeHosts],
          selectedComputeHosts: session.selectedComputeHosts && [...session.selectedComputeHosts],
          computeConcurrencyLimit: session.computeConcurrencyLimit,
          updatedAt: Math.max(current.updatedAt, session.updatedAt)
        }
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      if (mode === 'session-details-authority') {
        const projected = sessionDetails.projectSessionDetailsAuthority(current, session)
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      if (mode === 'permission-authority') {
        const currentRevision = current.runtimeContext?.revision
        const incomingRevision = session.runtimeContext?.revision
        if (
          currentRevision !== undefined &&
          incomingRevision !== undefined &&
          incomingRevision < currentRevision
        )
          return state

        const permissionPending = session.runtimeContext?.permission?.state === 'pending'
        const interactionState = {
          ...inferSessionInteractionState(current),
          permission: permissionPending
        }
        const status = resolveSessionInteractionStatus(
          { ...current, runtimeContext: session.runtimeContext },
          interactionState
        )
        const projected: ChatSession = {
          ...current,
          revision: Math.max(sessionRevision(current), sessionRevision(session)),
          status,
          interactionState,
          runtimeContext: session.runtimeContext,
          activePlanProjection: retainRuntimePlanProjection(current, session),
          updatedAt: Math.max(current.updatedAt, session.updatedAt)
        }
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      if (mode === 'runtime-context-authority') {
        const currentRevision = current.runtimeContext?.revision
        const incomingRevision = session.runtimeContext?.revision
        if (
          currentRevision !== undefined &&
          incomingRevision !== undefined &&
          incomingRevision < currentRevision
        ) {
          return state
        }

        const activePlanProjection = matchesPersistedPlanProjection(
          current.activePlanProjection,
          session
        )
          ? current.activePlanProjection
          : retainRuntimePlanProjection(current, session)
        const projectionIsNewer =
          activePlanProjection !== undefined &&
          incomingRevision !== undefined &&
          activePlanProjection.revision > incomingRevision
        const interactionState = {
          ...inferSessionInteractionState(current),
          permission: session.runtimeContext?.permission?.state === 'pending',
          plan: projectionIsNewer
            ? activePlanProjection.approval === 'pending'
            : session.runtimeContext?.plan?.approval === 'pending'
        }
        const status = current.compacting
          ? current.status
          : resolveSessionInteractionStatus(
              { ...current, runtimeContext: session.runtimeContext },
              interactionState
            )
        const projected: ChatSession = {
          ...current,
          ...mergeRuntimeConversationAuthority(current, session),
          revision: Math.max(sessionRevision(current), sessionRevision(session)),
          status,
          interactionState,
          runtimeContext: session.runtimeContext,
          activePlanProjection,
          planHistoryProjections: projectRuntimePlanHistoryAuthority(session),
          updatedAt: Math.max(current.updatedAt, session.updatedAt)
        }
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

      if (mode === 'delegated-authority') {
        const authority = mergeDelegatedWorkAuthorityProjection(current, session)
        const projected: ChatSession = {
          ...current,
          ...authority,
          revision: Math.max(sessionRevision(current), sessionRevision(session))
        }
        markExternallyHydratedSession(projected, session)
        return {
          sessions: state.sessions.map((candidate) =>
            candidate.id === session.id ? projected : candidate
          )
        } as Partial<State>
      }

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
        const authorityProjected = projectDurablePlanAuthority(current, session)
        if (
          !flat.changed &&
          !graph?.changed &&
          authorityProjected === current &&
          sessionRevision(session) <= sessionRevision(current)
        )
          return state
        projected =
          flat.changed || graph?.changed
            ? projectDurablePlanAuthority(withTransientSessionState(session, current), session)
            : authorityProjected
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
        const merged: ChatSession = {
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
        projected = projectDurablePlanAuthority(merged, session)
        if (
          !flat.changed &&
          !graph?.changed &&
          projected === merged &&
          sessionRevision(session) <= sessionRevision(current)
        ) {
          const acknowledged = sessionDetails.withAcknowledgedUnsavedTitle(current, session)
          if (acknowledged === current) return state
          markExternallyHydratedSession(acknowledged, session)
          return {
            sessions: state.sessions.map((candidate) =>
              candidate.id === session.id ? acknowledged : candidate
            )
          } as Partial<State>
        }
      }

      projected = sessionDetails.withAcknowledgedUnsavedTitle(
        {
          ...projected,
          // Whole-Session saves and continuation acknowledgements do not own Delegation policy.
          // Keep the last dedicated mutation result even when a later ordinary projection carries
          // a newer Session revision from unrelated running activity.
          delegationPolicy: current.delegationPolicy,
          delegationPolicyAuthorityPending: current.delegationPolicyAuthorityPending,
          revision: Math.max(sessionRevision(projected), sessionRevision(session))
        },
        session
      )
      markExternallyHydratedSession(projected, session)
      return {
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id ? projected : candidate
        )
      } as Partial<State>
    })
  }
})

export const isExternallyHydratedSession = (session: ChatSession): boolean =>
  externallyHydratedSessionAuthorities.has(session)

export const getExternallyHydratedSessionAuthority = (
  session: ChatSession
): PersistedChatSession | undefined => externallyHydratedSessionAuthorities.get(session)

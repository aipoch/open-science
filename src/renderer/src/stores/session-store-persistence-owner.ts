import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'
import type { StoreApi } from 'zustand'

import type { ElicitationProjection } from '../../../shared/acp'
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
  sessionRevision,
  sanitizeToolActivity,
  type PersistedActiveRun,
  type PersistedActivityGroup,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageRole,
  type PersistedMessageStatus,
  type PersistedSessionManifest,
  type PersistedSessionStatus,
  type PersistedToolActivity
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
  mode?:
    | 'merge-upload-identities'
    | 'replace-persisted-if-current'
    | 'permission-authority'
    | 'runtime-context-authority'
    | 'compute-host-access-authority'
    | 'delegated-authority'
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

const externallyHydratedSessionAuthorities = new WeakMap<ChatSession, PersistedChatSession>()

const markExternallyHydratedSession = (
  session: ChatSession,
  authority: PersistedChatSession
): void => {
  externallyHydratedSessionAuthorities.set(session, structuredClone(authority))
}

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
    planHistoryProjections,
    runtimeContext,
    messages,
    ...persistedSession
  } = session

  void isPending
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
export const hydrateSession = (session: PersistedChatSession): ChatSession => {
  const hydrated: ChatSession = {
    ...session,
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

const withAcknowledgedUnsavedTitle = (
  projected: ChatSession,
  durable: PersistedChatSession
): ChatSession => {
  if (projected.unsavedTitle !== true || projected.title !== durable.title) return projected
  const next = { ...projected }
  delete next.unsavedTitle
  return next
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
          [...(existing.artifacts ?? []), ...(session.artifacts ?? [])].map((artifact) => [
            artifact.id,
            artifact
          ])
        )
        const projected: ChatSession = {
          ...withoutPreviousArchive,
          ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
          messages: flat.messages,
          ...(runtimeAdvanced || runtimeIdentityMerge
            ? mergePersistedRuntimeIdentityProjection(existing, session, {
                // A continuation removes completedAt without changing the Frame's createdAt, so
                // runtime revision—not Frame timestamps—owns lifecycle.
                incomingOwnsFrameConflicts: runtimeAdvanced
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

      return { sessions: nextSessions } as Partial<State>
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
          updatedAt: Math.max(current.updatedAt, session.updatedAt)
        }
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

        const interactionState = {
          ...inferSessionInteractionState(current),
          permission: session.runtimeContext?.permission?.state === 'pending',
          plan: session.runtimeContext?.plan?.approval === 'pending'
        }
        const status = current.compacting
          ? current.status
          : resolveSessionInteractionStatus(
              { ...current, runtimeContext: session.runtimeContext },
              interactionState
            )
        const activePlanProjection = matchesPersistedPlanProjection(
          current.activePlanProjection,
          session
        )
          ? current.activePlanProjection
          : retainRuntimePlanProjection(current, session)
        const projected: ChatSession = {
          ...current,
          ...mergeRuntimeConversationAuthority(current, session),
          revision: Math.max(sessionRevision(current), sessionRevision(session)),
          status,
          interactionState,
          runtimeContext: session.runtimeContext,
          activePlanProjection,
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
          const acknowledged = withAcknowledgedUnsavedTitle(current, session)
          if (acknowledged === current) return state
          markExternallyHydratedSession(acknowledged, session)
          return {
            sessions: state.sessions.map((candidate) =>
              candidate.id === session.id ? acknowledged : candidate
            )
          } as Partial<State>
        }
      }

      projected = withAcknowledgedUnsavedTitle(
        {
          ...projected,
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

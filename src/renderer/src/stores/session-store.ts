import { create } from 'zustand'
import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'

import type { ArtifactFile } from '../../../shared/artifacts'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import { sanitizeActivityGroupTitle } from '../../../shared/activity-groups'
import {
  MAX_ACP_SESSION_IMAGE_BYTES,
  normalizeClaudeCodeRefusalText,
  sanitizeAcpMessageImage,
  type AcpContextUsage,
  type AcpMessageImage,
  type AcpTurnTokenUsage
} from '../../../shared/acp'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import {
  sanitizeMessageImages,
  type PersistedActivityGroup,
  type PersistedArtifact,
  type PersistedChatSession,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'
import type { UpdateSessionArchiveRequest } from '../../../shared/session-persistence'
import { isReportableRunFailure } from '../../../shared/run-error-classification'
import { createPersistedUpload } from './session-store-message-graph-helpers'
import {
  createMessageId,
  createSessionMessageGraphOwner,
  createSortIndex,
  synchronizeSessionGraph
} from './session-store-message-graph-owner'
import type {
  AppendMessageResult,
  SessionMessageGraphActions
} from './session-store-message-graph-helpers'
import {
  createInitialSessionState,
  createSessionPersistenceOwner,
  hydrateSession,
  type ChatMessage,
  type ChatSession,
  type SessionStatus,
  type SessionPersistenceActions,
  type SessionStoreData,
  type ToolActivity,
  type ToolActivityStatus
} from './session-store-persistence-owner'

export {
  createInitialSessionState,
  isExternallyHydratedSession,
  toPersistedSession,
  type ActiveRun,
  type ChatMessage,
  type ChatMessageRole,
  type ChatMessageStatus,
  type ChatSession,
  type SessionHydrationSelection,
  type SessionStatus,
  type ToolActivity,
  type ToolActivityStatus
} from './session-store-persistence-owner'

export type { BranchInNewSessionInput } from './session-store-message-graph-helpers'

type AppendAgentMessageChunkInput = {
  sessionId: string
  streamId: string
  eventId: string
  promptMessageId?: string
  content?: string
  image?: AcpMessageImage
}

type UpsertToolActivityInput = {
  sessionId: string
  toolCallId: string
  eventId: string
  timestamp?: number
  promptMessageId?: string
  title?: string
  status?: string
  providerToolName?: string
  toolKind?: ToolKind
  toolContent?: ToolCallContent[]
  toolLocations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
}

type AttachRunArtifactsInput = {
  sessionId: string
  runId: string
  promptMessageId?: string
  eventId: string
  artifacts: ArtifactFile[]
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
}

type ReplaceMessageArtifactsInput = {
  sessionId: string
  messageId: string
  artifacts: ArtifactFile[]
}

type ReplaceMessageUploadsInput = {
  sessionId: string
  messageId: string
  uploads: PersistedUploadedAttachment[]
}

type SessionStore = SessionStoreData &
  SessionPersistenceActions &
  SessionMessageGraphActions & {
    selectSession: (sessionId: string) => void
    clearSelection: () => void
    appendAgentMessageChunk: (
      input: AppendAgentMessageChunkInput
    ) => AppendMessageResult | undefined
    setAwaitingFirstAgentOutput: (sessionId: string, waiting: boolean) => void
    setAgentPromptInFlight: (sessionId: string, inFlight: boolean) => void
    attachRunArtifacts: (input: AttachRunArtifactsInput) => AppendMessageResult | undefined
    replaceMessageArtifacts: (input: ReplaceMessageArtifactsInput) => void
    replaceMessageUploads: (input: ReplaceMessageUploadsInput) => void
    recordArtifactError: (sessionId: string, error: string) => void
    clearArtifactError: (sessionId: string) => void
    finishRun: (sessionId: string, turnUsage?: AcpTurnTokenUsage, promptMessageId?: string) => void
    // opts.reportable overrides the report-affordance decision: pass false for a model-provider failure
    // (the agent relayed an upstream LLM/HTTP error), true to force it, or omit to let the store derive it
    // from the message (an app-crafted reminder → not reportable; anything else → reportable).
    failRun: (sessionId: string, error: string, opts?: { reportable?: boolean }) => void
    // Sets the transient agent status line shown in the waiting indicator; only applies while running.
    setAgentStatus: (sessionId: string, text: string) => void
    // Enters the auto-recovery "compacting" state after a request-size overflow: clears the error so the
    // UI shows a neutral note instead of a dead-end, without blocking the recovery re-send.
    beginCompaction: (sessionId: string, options?: { supersedeActiveRun?: boolean }) => void
    // Compaction completion/failure may arrive after a recovery retry has started. These transitions
    // apply only while the session still owns the compacting state and never settle a newer run.
    finishCompaction: (sessionId: string) => void
    failCompaction: (sessionId: string, error: string) => void
    markResumed: (
      sessionId: string,
      agentFrameworkId?: PersistedChatSession['agentFrameworkId'],
      agentBackendId?: PersistedChatSession['agentBackendId']
    ) => void
    markDisconnected: (sessionId: string, reason?: string) => void
    setBranchSwitchBlocked: (sessionId: string, blocked: boolean) => void
    clearBranchContextReset: (sessionId: string) => void
    markSpecialistSwitchResetRequired: (sessionId: string) => void
    clearSpecialistSwitchResetRequired: (sessionId: string) => void
    upsertToolActivity: (input: UpsertToolActivityInput) => void
    setActivePlanProjection: (sessionId: string, projection: ActivePlanProjection) => void
    beginActivityGroup: (
      sessionId: string,
      groupId: string,
      title: string,
      promptMessageId?: string
    ) => void
    completeActivityGroup: (sessionId: string, promptMessageId?: string) => void
    setPermissionPending: (sessionId: string) => void
    clearPermissionPending: (sessionId: string) => void
    setContextUsage: (sessionId: string, contextUsage: AcpContextUsage | undefined) => void
    setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => void
    // Persists the per-session auto-review toggle. true = on; false = off (default).
    setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
    // Sets the per-session enabled compute hosts (single-select, stored as array for extensibility).
    setEnabledComputeHosts: (sessionId: string, providerIds: string[]) => void
    // Updates the persisted specialist UUID for an existing session after reconfigure succeeds.
    // Passing undefined clears the binding (Main Agent). Persistence only stores the UUID.
    setSessionSpecialistId: (sessionId: string, specialistId: string | undefined) => void
    // Toggles whether a conversation is pinned to the top section of the sidebar.
    togglePinned: (sessionId: string) => void
    updateSessionArchive: (request: UpdateSessionArchiveRequest) => Promise<ChatSession>
    // Sets or clears the per-session fix loop active flag. When true, the composer send button is
    // disabled for this session; when false (loop ended or cancelled), send is re-enabled.
    setFixLoopActive: (sessionId: string, active: boolean) => void
    renameSession: (sessionId: string, title: string) => void
    deleteSession: (sessionId: string) => void
    removeSessionsForProject: (projectId: string) => void
  }

const ARTIFACT_ERROR_PREFIX = 'Generated file finalization failed'
const CONVERSATION_GRAPH_SYNC_ERROR =
  'Conversation history could not be finalized safely. Restart the app to restore the last saved conversation state, then report this issue.'

const CLEARED_AGENT_RUN_STATE = {
  activeRun: undefined,
  agentStatus: undefined,
  awaitingFirstAgentOutput: undefined,
  agentPromptInFlight: undefined,
  compacting: undefined
} satisfies Pick<
  ChatSession,
  'activeRun' | 'agentStatus' | 'awaitingFirstAgentOutput' | 'agentPromptInFlight' | 'compacting'
>

const settleConversationGraphSyncFailure = (
  session: ChatSession,
  input: {
    messages: ChatMessage[]
    activities?: ToolActivity[]
    activityGroups?: PersistedActivityGroup[]
    now: number
    cause: unknown
    runError?: string
  }
): ChatSession => {
  console.error('[session-store] conversation graph synchronization failed', {
    sessionId: session.id,
    cause: input.cause
  })

  return {
    ...session,
    status: 'error',
    ...CLEARED_AGENT_RUN_STATE,
    error: input.runError
      ? `${input.runError}\n\n${CONVERSATION_GRAPH_SYNC_ERROR}`
      : CONVERSATION_GRAPH_SYNC_ERROR,
    errorReportable: true,
    messages: input.messages,
    activities: input.activities,
    activityGroups: input.activityGroups,
    conversationGraph: session.conversationGraph,
    conversationGraphSyncBlocked: true,
    updatedAt: input.now
  }
}

const completeOpenActivityGroups = (
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

// Converts main-process artifact metadata into the compact persisted renderer reference shape.
const createPersistedArtifact = (artifact: ArtifactFile): PersistedArtifact => {
  const persisted: PersistedArtifact = {
    id: artifact.id,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs
  }
  if (artifact.artifactId) persisted.artifactId = artifact.artifactId
  if (artifact.versionId) persisted.versionId = artifact.versionId
  if (artifact.versionNumber !== undefined) persisted.versionNumber = artifact.versionNumber
  if (artifact.checksum) persisted.sha256 = artifact.checksum
  return persisted
}

// Compare only persisted file metadata, in stable array order, before advancing filesRevision. This
// keeps text/status-only session updates on the repository revision fast path.
const arePersistedUploadsEqual = (
  left: PersistedUploadedAttachment[] | undefined,
  right: PersistedUploadedAttachment[]
): boolean => {
  const current = left ?? []
  return (
    current.length === right.length &&
    current.every((item, index) => {
      const next = right[index]
      return (
        item.id === next.id &&
        item.sessionId === next.sessionId &&
        item.name === next.name &&
        item.originalName === next.originalName &&
        item.path === next.path &&
        item.mimeType === next.mimeType &&
        item.size === next.size
      )
    })
  )
}

const arePersistedArtifactsEqual = (
  left: PersistedArtifact[] | undefined,
  right: PersistedArtifact[]
): boolean => {
  const current = left ?? []
  return (
    current.length === right.length &&
    current.every((item, index) => {
      const next = right[index]
      return (
        item.id === next.id &&
        item.kind === next.kind &&
        item.path === next.path &&
        item.fileUrl === next.fileUrl &&
        item.name === next.name &&
        item.mimeType === next.mimeType &&
        item.size === next.size &&
        item.mtimeMs === next.mtimeMs &&
        item.sha256 === next.sha256
      )
    })
  )
}

const areStringArraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

// Merges artifacts by id so replayed runtime events update paths without duplicating file cards.
const upsertArtifacts = (
  existingArtifacts: PersistedArtifact[] | undefined,
  incomingArtifacts: PersistedArtifact[]
): PersistedArtifact[] => {
  const artifactsById = new Map<string, PersistedArtifact>()

  for (const artifact of existingArtifacts ?? []) {
    artifactsById.set(artifact.id, artifact)
  }
  for (const artifact of incomingArtifacts) {
    artifactsById.set(artifact.id, artifact)
  }

  return Array.from(artifactsById.values())
}

// Appends ids while preserving the first-seen order used by messages and file lists.
const appendUniqueStrings = (
  existingItems: string[] | undefined,
  incomingItems: string[]
): string[] => Array.from(new Set([...(existingItems ?? []), ...incomingItems]))

// Distinguishes artifact finalization failures from prompt failures when a run later stops normally.
const isArtifactFinalizationError = (error: string | undefined): boolean =>
  error?.startsWith(ARTIFACT_ERROR_PREFIX) ?? false

// Explicit prompt identity lets app-owned continuations mutate their originating turn after the
// ordinary activeRun has settled. Legacy events retain the active-run fallback.
const hasKnownPrompt = (session: ChatSession, promptMessageId: string | undefined): boolean =>
  promptMessageId
    ? session.messages.some((message) => message.id === promptMessageId && message.role === 'user')
    : Boolean(session.activeRun)

// Marks open streams complete and attaches whole-turn usage to the final Agent message responding to
// the active prompt. A turn can emit multiple message ids, so only its last response owns the footer.
const completeStreamingMessages = (
  messages: ChatMessage[],
  promptMessageId: string | undefined,
  turnUsage: AcpTurnTokenUsage | undefined,
  now: number
): ChatMessage[] => {
  const usageFooterMessageId = promptMessageId
    ? [...messages]
        .reverse()
        .find(
          (message) => message.role === 'agent' && message.responseToMessageId === promptMessageId
        )?.id
    : undefined

  return messages.map((message) => {
    const completesStream = message.status === 'streaming'
    const ownsTurnUsageFooter = message.id === usageFooterMessageId
    if (!completesStream && !ownsTurnUsageFooter) return message
    const recordsCompletion =
      completesStream ||
      (ownsTurnUsageFooter && message.status === 'complete' && message.completedAt === undefined)

    return {
      ...message,
      ...(completesStream ? { status: 'complete' as const } : {}),
      ...(recordsCompletion ? { completedAt: now } : {}),
      ...(ownsTurnUsageFooter
        ? turnUsage
          ? { turnUsage }
          : { turnUsageUnavailable: true as const }
        : {}),
      updatedAt: now
    }
  })
}

// Marks partial streamed messages as errored when a run fails.
const failStreamingMessages = (messages: ChatMessage[], now = Date.now()): ChatMessage[] =>
  messages.map((message) =>
    message.status === 'streaming'
      ? {
          ...message,
          status: 'error',
          failedAt: message.failedAt ?? now,
          updatedAt: now
        }
      : message
  )

const TOOL_ACTIVITY_STATUSES = new Set<ToolActivityStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed'
])

// Accepts only ACP statuses that the workspace activity UI knows how to render.
const normalizeToolActivityStatus = (status: string | undefined): ToolActivityStatus | undefined =>
  status && TOOL_ACTIVITY_STATUSES.has(status as ToolActivityStatus)
    ? (status as ToolActivityStatus)
    : undefined

// Terminal tool statuses should not be overwritten by late or duplicate follow-up events.
const isTerminalToolActivityStatus = (status: ToolActivityStatus): boolean =>
  status === 'completed' || status === 'failed'

// Merges follow-up status updates while preserving completed/failed terminal states.
const mergeToolActivityStatus = (
  currentStatus: ToolActivityStatus,
  nextStatus: ToolActivityStatus | undefined
): ToolActivityStatus => {
  if (!nextStatus) return currentStatus
  if (isTerminalToolActivityStatus(currentStatus)) return currentStatus
  return nextStatus
}

// Uses an empty title for search/fetch rows so the UI can derive the visible query separately.
const createToolActivityTitle = (
  title: string | undefined,
  toolKind: ToolKind | undefined
): string => {
  const trimmedTitle = title?.trim()

  if (trimmedTitle) return trimmedTitle
  if (toolKind === 'fetch' || toolKind === 'search') return ''
  return 'Tool activity'
}

// Marks still-running activities complete when the agent run finishes normally.
const completeOpenActivities = (
  activities: ToolActivity[] | undefined
): ToolActivity[] | undefined =>
  activities?.map((activity) =>
    activity.status === 'pending' || activity.status === 'in_progress'
      ? {
          ...activity,
          status: 'completed',
          updatedAt: Date.now()
        }
      : activity
  )

// Marks still-running activities failed when the agent run errors.
const failOpenActivities = (activities: ToolActivity[] | undefined): ToolActivity[] | undefined =>
  activities?.map((activity) =>
    activity.status === 'pending' || activity.status === 'in_progress'
      ? {
          ...activity,
          status: 'failed',
          updatedAt: Date.now()
        }
      : activity
  )

// Keeps human-decision waits sticky while tool updates continue to stream in. In particular, the
// terminal generate_plan activity arrives after the Plan projection and must not overwrite the
// composer card's waiting state with `running`.
const getToolActivitySessionStatus = (session: ChatSession): SessionStatus => {
  if (session.status === 'waiting-permission' || session.status === 'waiting-plan-approval') {
    return session.status
  }

  return session.activeRun ? 'running' : session.status
}

// Stores all transient workspace conversation state for the renderer process.
export const useSessionStore = create<SessionStore>((set, get) => ({
  ...createInitialSessionState(),

  // Selects only existing sessions so deleted ids cannot remain active.
  selectSession: (sessionId) => {
    if (!get().sessions.some((session) => session.id === sessionId)) return

    set({ selectedSessionId: sessionId })
  },

  // Clears visible conversation selection without deleting session history.
  clearSelection: () => {
    set({ selectedSessionId: undefined })
  },

  ...createSessionMessageGraphOwner<SessionStore>(set, get),
  ...createSessionPersistenceOwner<SessionStore>(set),

  // Appends or extends a streamed agent message using a stable stream id.
  appendAgentMessageChunk: ({
    sessionId,
    streamId,
    eventId,
    promptMessageId,
    content = '',
    image
  }) => {
    let sanitizedImage = sanitizeAcpMessageImage(image)

    if (!sessionId || !streamId || !eventId || (content.length === 0 && !sanitizedImage)) {
      return undefined
    }

    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)

    if (!session) return undefined
    const responseToMessageId = promptMessageId ?? session.activeRun?.promptMessageId
    const replayedGraphMessage = session.conversationGraph?.messages.find(
      (message) =>
        message.role === 'agent' &&
        message.responseToMessageId === responseToMessageId &&
        message.eventIds.includes(eventId)
    )

    // Branch switches remove downstream messages only from the flat projection. Ignore a bounded
    // runtime event already owned by another Branch instead of appending it to the active Branch.
    if (replayedGraphMessage) return { sessionId, messageId: replayedGraphMessage.id }
    const sessionImageBytes = session.messages.reduce(
      (total, message) =>
        total + (message.images ?? []).reduce((sum, candidate) => sum + candidate.byteLength, 0),
      0
    )
    if (
      sanitizedImage &&
      sessionImageBytes + sanitizedImage.byteLength > MAX_ACP_SESSION_IMAGE_BYTES
    ) {
      sanitizedImage = undefined
      if (content.length === 0) return undefined
    }
    const hasVisibleOutput = content.trim().length > 0 || Boolean(sanitizedImage)

    const existingMessage = session.messages.find(
      (message) => message.role === 'agent' && message.streamId === streamId
    )
    const mergedContent = (current = ''): string => {
      const text = `${current}${content}`
      return session.agentFrameworkId === 'claude-code'
        ? normalizeClaudeCodeRefusalText(text)
        : text
    }
    const messageId = existingMessage?.id ?? createMessageId()
    const now = Date.now()

    set({
      sessions: state.sessions.map((item) => {
        if (item.id !== sessionId) return item

        if (existingMessage) {
          const hasEvent = existingMessage.eventIds.includes(eventId)

          // Duplicate events are complete no-ops so finished sessions stay finished.
          if (hasEvent) {
            return item
          }

          return {
            ...item,
            status: item.status === 'waiting-permission' ? 'waiting-permission' : 'running',
            awaitingFirstAgentOutput: hasVisibleOutput ? undefined : item.awaitingFirstAgentOutput,
            messages: item.messages.map((message) =>
              message.id === existingMessage.id
                ? {
                    ...message,
                    content: mergedContent(message.content),
                    images: sanitizedImage
                      ? sanitizeMessageImages([
                          ...(message.images ?? []),
                          { id: eventId, ...sanitizedImage }
                        ])
                      : message.images,
                    eventIds: [...message.eventIds, eventId],
                    updatedAt: now
                  }
                : message
            ),
            updatedAt: now
          }
        }

        // The first chunk starts a new streaming message in the conversation.
        const agentMessage: ChatMessage = {
          id: messageId,
          role: 'agent',
          content: mergedContent(),
          status: 'streaming',
          streamId,
          responseToMessageId,
          eventIds: [eventId],
          images: sanitizedImage ? [{ id: eventId, ...sanitizedImage }] : undefined,
          sortIndex: createSortIndex(),
          createdAt: now,
          updatedAt: now
        }

        return {
          ...item,
          status: item.status === 'waiting-permission' ? 'waiting-permission' : 'running',
          awaitingFirstAgentOutput: hasVisibleOutput ? undefined : item.awaitingFirstAgentOutput,
          messages: [...item.messages, agentMessage],
          updatedAt: now
        }
      })
    })

    return { sessionId, messageId }
  },

  // Tracks the silent gap before the next visible assistant chunk.
  setAwaitingFirstAgentOutput: (sessionId, waiting) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              awaitingFirstAgentOutput: waiting ? true : undefined
            }
          : session
      )
    }))
  },

  // Tracks foreground runtime ownership independently from whether visible output has started.
  setAgentPromptInFlight: (sessionId, inFlight) => {
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const agentPromptInFlight = inFlight ? true : undefined
        return session.agentPromptInFlight === agentPromptInFlight
          ? session
          : { ...session, agentPromptInFlight }
      })
    }))
  },

  // Attaches a runtime artifact event to the best local assistant message before file finalization.
  attachRunArtifacts: ({
    sessionId,
    runId,
    promptMessageId,
    eventId,
    artifacts,
    turnUsage,
    turnUsageUnavailable
  }) => {
    if (!sessionId || !runId || !eventId || artifacts.length === 0) return undefined

    let result: AppendMessageResult | undefined
    const now = Date.now()
    const incomingArtifacts = artifacts.map(createPersistedArtifact)
    const incomingArtifactIds = incomingArtifacts.map((artifact) => artifact.id)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        // Legacy runtime namespaces restarted from `runtime-1` after every app launch, so a historical
        // Message may carry the same event id as this run. Prompt ownership distinguishes a true replay
        // from that collision while artifact events without prompt identity retain the old fallback.
        const ownsArtifactPrompt = (message: ChatMessage): boolean =>
          !promptMessageId || message.responseToMessageId === promptMessageId

        // Runtime event processing can replay visible events; event ids make the mutation idempotent.
        const alreadyAppliedMessage = session.messages.find(
          (message) => message.eventIds.includes(eventId) && ownsArtifactPrompt(message)
        )

        if (alreadyAppliedMessage) {
          result = {
            sessionId,
            messageId: alreadyAppliedMessage.id
          }

          return session
        }

        // Switching revisions projects only the active Branch into `session.messages`, while the
        // durable graph keeps events from every Branch. Runtime replay can therefore deliver an
        // already-finalized Artifact whose owning Message is currently inactive. Resolve that event
        // against the full graph so the main-process claim is replayed with its original Message id;
        // rebinding it to the active response would correctly fail the provenance ownership check.
        const alreadyAppliedGraphMessage = session.conversationGraph?.messages.find(
          (message) => message.eventIds.includes(eventId) && ownsArtifactPrompt(message)
        )

        if (alreadyAppliedGraphMessage) {
          result = {
            sessionId,
            messageId: alreadyAppliedGraphMessage.id
          }

          return session
        }

        const responseToMessageId = promptMessageId ?? session.activeRun?.promptMessageId
        // The app-owned prompt identity survives stop/failure event ordering and is authoritative. The
        // stream-id comparison remains only as a compatibility fallback for older artifact events.
        const agentMessages = [...session.messages]
          .reverse()
          .filter((message) => message.role === 'agent')
        const existingMessage =
          (responseToMessageId
            ? agentMessages.find((message) => message.responseToMessageId === responseToMessageId)
            : undefined) ?? agentMessages.find((message) => message.streamId === runId)

        const promptIsActive = promptMessageId
          ? session.messages.some((message) => message.id === promptMessageId)
          : false

        if (!existingMessage && promptMessageId && !promptIsActive && session.conversationGraph) {
          const graphResponses = session.conversationGraph.messages.filter(
            (message) => message.role === 'agent' && message.responseToMessageId === promptMessageId
          )

          if (graphResponses.length === 1) {
            const graphResponse = graphResponses[0]
            result = { sessionId, messageId: graphResponse.id }
            return {
              ...session,
              artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
              conversationGraph: {
                ...session.conversationGraph,
                messages: session.conversationGraph.messages.map((message) =>
                  message.id === graphResponse.id
                    ? {
                        ...message,
                        eventIds: appendUniqueStrings(message.eventIds, [eventId]),
                        artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
                        updatedAt: now
                      }
                    : message
                ),
                updatedAt: now
              },
              updatedAt: now
            }
          }

          // An explicit prompt from another Branch must never fall through to a new Message on the
          // active Branch. A later replay can be resolved after that Branch is projected again.
          return session
        }

        const messageId = existingMessage?.id ?? createMessageId()
        result = { sessionId, messageId }

        if (existingMessage) {
          const messages = session.messages.map((message) =>
            message.id === existingMessage.id
              ? {
                  ...message,
                  eventIds: appendUniqueStrings(message.eventIds, [eventId]),
                  artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
                  ...(turnUsage
                    ? { turnUsage, turnUsageUnavailable: undefined }
                    : turnUsageUnavailable
                      ? { turnUsage: undefined, turnUsageUnavailable: true as const }
                      : {}),
                  updatedAt: now
                }
              : message
          )
          return {
            ...session,
            artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
            messages,
            conversationGraph: synchronizeSessionGraph(session, messages, now),
            updatedAt: now
          }
        }

        // Some turns only produce files, so create an empty assistant message to host the file list.
        const artifactMessage: ChatMessage = {
          id: messageId,
          role: 'agent',
          content: '',
          status: session.activeRun ? 'streaming' : 'complete',
          streamId: runId,
          responseToMessageId,
          eventIds: [eventId],
          artifactIds: incomingArtifactIds,
          ...(turnUsage
            ? { turnUsage }
            : turnUsageUnavailable
              ? { turnUsageUnavailable: true as const }
              : {}),
          sortIndex: createSortIndex(),
          createdAt: now,
          ...(session.activeRun ? {} : { completedAt: now }),
          updatedAt: now
        }
        const messages = [...session.messages, artifactMessage]

        return {
          ...session,
          artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
          messages,
          conversationGraph: synchronizeSessionGraph(session, messages, now),
          updatedAt: now
        }
      })
    }))

    return result
  },

  // Replaces pending-run artifact references with finalized message-owned file metadata.
  replaceMessageArtifacts: ({ sessionId, messageId, artifacts }) => {
    if (!sessionId || !messageId) return

    const incomingArtifacts = artifacts.map(createPersistedArtifact)
    const incomingArtifactIds = incomingArtifacts.map((artifact) => artifact.id)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const message = session.messages.find((item) => item.id === messageId)
        const graphMessage = session.conversationGraph?.messages.find(
          (item) => item.id === messageId
        )

        if (!message) {
          if (!graphMessage || !session.conversationGraph) return session

          const replacedArtifactIds = new Set(graphMessage.artifactIds ?? [])
          const preservedArtifacts = (session.artifacts ?? []).filter(
            (artifact) => !replacedArtifactIds.has(artifact.id)
          )
          const nextArtifacts = upsertArtifacts(preservedArtifacts, incomingArtifacts)
          const now = Date.now()
          return {
            ...session,
            artifacts: nextArtifacts,
            conversationGraph: {
              ...session.conversationGraph,
              messages: session.conversationGraph.messages.map((item) =>
                item.id === messageId
                  ? { ...item, artifactIds: incomingArtifactIds, updatedAt: now }
                  : item
              ),
              updatedAt: now
            },
            updatedAt: now
          }
        }

        // Remove only the artifacts previously linked to this message, preserving other message files.
        const replacedArtifactIds = new Set(message.artifactIds ?? [])
        const preservedArtifacts = (session.artifacts ?? []).filter(
          (artifact) => !replacedArtifactIds.has(artifact.id)
        )
        const nextArtifacts = upsertArtifacts(preservedArtifacts, incomingArtifacts)

        if (
          arePersistedArtifactsEqual(session.artifacts, nextArtifacts) &&
          areStringArraysEqual(message.artifactIds ?? [], incomingArtifactIds) &&
          areStringArraysEqual(graphMessage?.artifactIds ?? [], incomingArtifactIds)
        ) {
          return session
        }

        const now = Date.now()
        const messages = session.messages.map((item) =>
          item.id === messageId
            ? {
                ...item,
                artifactIds: incomingArtifactIds,
                updatedAt: now
              }
            : item
        )
        const synchronizedGraph = synchronizeSessionGraph(session, messages, now)
        const conversationGraph = {
          ...synchronizedGraph,
          messages: synchronizedGraph.messages.map((item) =>
            item.id === messageId
              ? { ...item, artifactIds: incomingArtifactIds, updatedAt: now }
              : item
          )
        }

        return {
          ...session,
          artifacts: nextArtifacts,
          messages,
          conversationGraph,
          filesRevision: (session.filesRevision ?? 0) + 1,
          updatedAt: now
        }
      })
    }))
  },

  // Replaces upload references after pending files move to the session directory. filesRevision is
  // advanced only when persisted metadata actually changed, which schedules one index rescan.
  replaceMessageUploads: ({ sessionId, messageId, uploads }) => {
    if (!sessionId || !messageId) return

    const incomingUploads = uploads.map(createPersistedUpload)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const targetMessage = session.messages.find((message) => message.id === messageId)
        if (!targetMessage || arePersistedUploadsEqual(targetMessage.uploads, incomingUploads)) {
          return session
        }

        const now = Date.now()
        const messages = session.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                uploads: incomingUploads,
                updatedAt: now
              }
            : message
        )
        const synchronizedGraph = synchronizeSessionGraph(session, messages, now)
        const conversationGraph = {
          ...synchronizedGraph,
          messages: synchronizedGraph.messages.map((message) =>
            message.id === messageId
              ? { ...message, uploads: incomingUploads, updatedAt: now }
              : message
          )
        }

        return {
          ...session,
          messages,
          conversationGraph,
          filesRevision: (session.filesRevision ?? 0) + 1,
          updatedAt: now
        }
      })
    }))
  },

  // Keeps artifact finalization failures visible even if the prompt itself completed successfully.
  recordArtifactError: (sessionId, error) => {
    const message = error.trim()

    if (!sessionId || !message) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'error',
              error: `${ARTIFACT_ERROR_PREFIX}: ${message}`,
              // An app-layer finalization failure IS a reportable bug; set it explicitly so it never
              // inherits a stale `false` from a prior provider error on the same session.
              errorReportable: true,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Clears only artifact-specific errors after a later finalize retry succeeds.
  clearArtifactError: (sessionId) => {
    if (!sessionId) return

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId || !session.error?.startsWith(ARTIFACT_ERROR_PREFIX)) {
          return session
        }

        return {
          ...session,
          status: session.activeRun ? 'running' : 'idle',
          error: undefined,
          errorReportable: undefined,
          updatedAt: Date.now()
        }
      })
    }))
  },

  setActivePlanProjection: (sessionId, projection) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? (() => {
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
              return {
                ...session,
                ...(replaced ? { planHistoryProjections: replaced } : {}),
                activePlanProjection: projection,
                // Restart recovery preserves waiting-plan-approval after clearing activeRun. A Plan
                // whose Agent ended without a decision has already settled to idle and stays read-only.
                status: session.compacting
                  ? session.status
                  : projection.lifecycle === 'awaiting_approval'
                    ? session.activeRun || session.status === 'waiting-plan-approval'
                      ? 'waiting-plan-approval'
                      : 'idle'
                    : projection.lifecycle === 'rejected'
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
                            : session.status,
                updatedAt: Date.now()
              }
            })()
          : session
      )
    }))
  },

  // Tracks runtime tool calls as lightweight activity rows instead of chat messages.
  upsertToolActivity: ({
    sessionId,
    toolCallId,
    eventId,
    timestamp,
    promptMessageId,
    title,
    status,
    providerToolName,
    toolKind,
    toolContent,
    toolLocations,
    rawInput,
    rawOutput,
    terminalOutput,
    terminalExitCode
  }) => {
    if (!sessionId || !toolCallId || !eventId) return

    const nextStatus = normalizeToolActivityStatus(status)
    const now = Date.now()
    const eventTimestamp = timestamp ?? now

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const activities = session.activities ?? []
        const existingActivity = activities.find((activity) => activity.id === toolCallId)

        if (existingActivity) {
          // Duplicate runtime events are no-ops so replayed streams do not mutate history.
          if (existingActivity.eventIds.includes(eventId)) {
            return session
          }

          const activityWasTerminal = isTerminalToolActivityStatus(existingActivity.status)

          return {
            ...session,
            status: getToolActivitySessionStatus(session),
            activities: activities.map((activity) =>
              activity.id === toolCallId
                ? {
                    ...activity,
                    promptMessageId: promptMessageId ?? activity.promptMessageId,
                    title: title?.trim() || activity.title,
                    status: mergeToolActivityStatus(activity.status, nextStatus),
                    providerToolName: providerToolName ?? activity.providerToolName,
                    toolKind: toolKind ?? activity.toolKind,
                    toolContent: toolContent ?? activity.toolContent,
                    toolLocations: toolLocations ?? activity.toolLocations,
                    rawInput: rawInput ?? activity.rawInput,
                    rawOutput: rawOutput ?? activity.rawOutput,
                    terminalOutput: terminalOutput ?? activity.terminalOutput,
                    terminalExitCode: terminalExitCode ?? activity.terminalExitCode,
                    eventIds: [...activity.eventIds, eventId],
                    updatedAt: activityWasTerminal ? activity.updatedAt : eventTimestamp
                  }
                : activity
            ),
            updatedAt: now
          }
        }

        if (!hasKnownPrompt(session, promptMessageId)) {
          return session
        }

        const activeGroup = session.activityGroups?.findLast(
          (group) =>
            group.completedAt === undefined &&
            (!promptMessageId || group.promptMessageId === promptMessageId)
        )

        // New tool calls are transient activity rows, not persisted chat messages.
        const activity: ToolActivity = {
          id: toolCallId,
          kind: 'tool',
          title: createToolActivityTitle(title, toolKind),
          status: nextStatus ?? 'pending',
          eventIds: [eventId],
          sortIndex: createSortIndex(),
          activityGroupId: activeGroup?.id,
          promptMessageId: promptMessageId ?? session.activeRun?.promptMessageId,
          providerToolName,
          toolKind,
          toolContent,
          toolLocations,
          rawInput,
          rawOutput,
          terminalOutput,
          terminalExitCode,
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
                  ? {
                      ...group,
                      activityIds: [...group.activityIds, activity.id],
                      updatedAt: now
                    }
                  : group
              )
            : session.activityGroups,
          updatedAt: now
        }
      })
    }))
  },

  beginActivityGroup: (sessionId, groupId, title, promptMessageId) => {
    const groupTitle = sanitizeActivityGroupTitle(title)
    if (!sessionId || !groupId || !groupTitle) return

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        if (!hasKnownPrompt(session, promptMessageId)) return session
        if (session.activityGroups?.some((group) => group.id === groupId)) return session

        const now = Date.now()
        const completedGroups = completeOpenActivityGroups(session.activityGroups, now) ?? []

        return {
          ...session,
          activityGroups: [
            ...completedGroups,
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
      })
    }))
  },

  completeActivityGroup: (sessionId, promptMessageId) => {
    if (!sessionId) return

    const now = Date.now()
    set((state) => {
      const target = state.sessions.find((session) => session.id === sessionId)
      const hasStartedOpenGroup = target?.activityGroups?.some(
        (group) =>
          group.completedAt === undefined &&
          group.activityIds.length > 0 &&
          (!promptMessageId || group.promptMessageId === promptMessageId)
      )
      if (!hasStartedOpenGroup) return state

      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
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
            : session
        )
      }
    })
  },

  // Completes the active run and any streamed messages for the session.
  finishRun: (sessionId, turnUsage, promptMessageId) => {
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const keepArtifactError = isArtifactFinalizationError(session.error)
        // A deferred Artifact may have inserted the terminal message during the same millisecond.
        // Advance its timestamp so graph synchronization accepts the completed payload as newer.
        const now = Math.max(Date.now(), session.updatedAt + 1)
        const messages = completeStreamingMessages(
          session.messages,
          promptMessageId ?? session.activeRun?.promptMessageId,
          turnUsage,
          now
        )
        const activities = completeOpenActivities(session.activities)
        const activityGroups = completeOpenActivityGroups(session.activityGroups, now)
        // Streaming updates intentionally stay in the lightweight flat projection. Before Branch
        // navigation is re-enabled, publish the terminal response and its activities into the durable
        // graph even when Artifact finalization returned an unchanged immutable descriptor.
        let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
        try {
          conversationGraph = synchronizeSessionGraph(
            { ...session, messages, activities, activityGroups },
            messages,
            now
          )
        } catch (cause) {
          return settleConversationGraphSyncFailure(session, {
            messages,
            activities,
            activityGroups,
            now,
            cause
          })
        }

        return {
          ...session,
          ...CLEARED_AGENT_RUN_STATE,
          status: keepArtifactError ? 'error' : 'idle',
          error: keepArtifactError ? session.error : undefined,
          errorReportable: keepArtifactError ? session.errorReportable : undefined,
          messages,
          activities,
          activityGroups,
          conversationGraph,
          conversationGraphSyncBlocked: undefined,
          updatedAt: now
        }
      })
    }))
  },

  // Fails the active run and records the visible session error.
  failRun: (sessionId, error, opts) => {
    const message = error.trim()

    if (!message) return

    // Resolve the report affordance once and persist it (survives reload): an explicit opts.reportable
    // wins (the runtime passes false for a model-provider failure); otherwise derive it from the message
    // so an app-crafted reminder hides the button while an unknown/opaque failure keeps it.
    const errorReportable = opts?.reportable ?? isReportableRunFailure(message)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const now = Date.now()
        const messages = failStreamingMessages(session.messages, now)
        const activities = failOpenActivities(session.activities)
        const activityGroups = completeOpenActivityGroups(session.activityGroups, now)
        let conversationGraph: NonNullable<PersistedChatSession['conversationGraph']>
        try {
          conversationGraph = synchronizeSessionGraph(
            { ...session, messages, activities, activityGroups },
            messages,
            now
          )
        } catch (cause) {
          return settleConversationGraphSyncFailure(session, {
            messages,
            activities,
            activityGroups,
            now,
            cause,
            runError: message
          })
        }

        return {
          ...session,
          ...CLEARED_AGENT_RUN_STATE,
          status: 'error',
          error: message,
          errorReportable,
          messages,
          activities,
          activityGroups,
          conversationGraph,
          conversationGraphSyncBlocked: undefined,
          updatedAt: now
        }
      })
    }))
  },

  // Records the latest agent status/stderr line for the waiting indicator. Ignored unless the session
  // is running (a stale line must not linger after output starts or the turn ends).
  setAgentStatus: (sessionId, text) => {
    const trimmed = text.trim()

    if (!trimmed) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && session.status === 'running'
          ? { ...session, agentStatus: trimmed }
          : session
      )
    }))
  },

  // Enters the transient "compacting" state after a request-size overflow. Clears the error and settles
  // any half-streamed message so nothing hangs, but leaves the status non-running so the recovery re-send
  // is not blocked by the duplicate-submit guard. The UI shows a neutral note keyed off `compacting`.
  beginCompaction: (sessionId, options) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && (!session.activeRun || options?.supersedeActiveRun)
          ? {
              ...session,
              ...CLEARED_AGENT_RUN_STATE,
              status: 'idle',
              error: undefined,
              errorReportable: undefined,
              compacting: true,
              messages: failStreamingMessages(session.messages),
              activities: failOpenActivities(session.activities),
              activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  finishCompaction: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && session.compacting && !session.activeRun
          ? { ...session, status: 'idle', compacting: undefined, updatedAt: Date.now() }
          : session
      )
    }))
  },

  failCompaction: (sessionId, error) => {
    const message = error.trim()
    if (!message) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && session.compacting && !session.activeRun
          ? {
              ...session,
              status: 'error',
              compacting: undefined,
              error: message,
              errorReportable: false,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Clears the interrupted/error state after a successful resume so the composer is usable again.
  markResumed: (sessionId, agentFrameworkId, agentBackendId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'idle',
              error: undefined,
              errorReportable: undefined,
              interrupted: undefined,
              agentFrameworkId: agentFrameworkId ?? session.agentFrameworkId,
              agentBackendId: agentBackendId ?? session.agentBackendId,
              compacting: undefined,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Flags a session dropped by a live connection loss so the Resume banner appears; like failRun it
  // settles any half-streamed message/open tool so nothing hangs in a perpetually-running state.
  markDisconnected: (sessionId, reason) => {
    // Preserve the specific failure cause (e.g. "Connection timeout") when the caller has one,
    // while keeping the Resume affordance. Fall back to a generic message otherwise.
    const trimmedReason = reason?.trim()
    const error = trimmedReason
      ? `${trimmedReason} — Resume to reconnect and continue.`
      : 'Connection lost — Resume to reconnect and continue.'
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              ...CLEARED_AGENT_RUN_STATE,
              status: 'error',
              interrupted: true,
              error,
              // Cleared so a prior run's report flag can't bleed onto this disconnect (the interrupted
              // banner owns this path anyway; the report button never shows for it).
              errorReportable: undefined,
              messages: failStreamingMessages(session.messages),
              activities: failOpenActivities(session.activities),
              activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  setBranchSwitchBlocked: (sessionId, blocked) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && Boolean(session.branchSwitchBlocked) !== blocked
          ? { ...session, branchSwitchBlocked: blocked || undefined }
          : session
      )
    }))
  },

  clearBranchContextReset: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, branchContextResetRequired: undefined } : session
      )
    }))
  },

  // Marks that a specialist switch replaced the live agent session; the next send replays history
  // into the fresh session so the new specialist keeps conversation continuity. Distinct from
  // branchContextResetRequired because it must NOT shut down the notebook kernel.
  markSpecialistSwitchResetRequired: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, specialistSwitchResetRequired: true } : session
      )
    }))
  },

  clearSpecialistSwitchResetRequired: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, specialistSwitchResetRequired: undefined }
          : session
      )
    }))
  },

  // Marks a session as blocked on a user permission decision.
  setPermissionPending: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'waiting-permission',
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Restores a permission-blocked session to running or idle state.
  clearPermissionPending: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: session.activeRun ? 'running' : 'idle',
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Stores the approval posture with the conversation so resumes and provider switches reapply it.
  setPermissionProfile: (sessionId, profile) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              permissionProfile: profile,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Persists the per-session auto-review toggle so finishRun can skip a review when disabled.
  setAutoReviewEnabled: (sessionId, enabled) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              autoReviewEnabled: enabled,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  setContextUsage: (sessionId, contextUsage) => {
    set((state) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionId)
      if (!session || JSON.stringify(session.contextUsage) === JSON.stringify(contextUsage)) {
        return state
      }

      return {
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, contextUsage } : candidate
        )
      }
    })
  },

  setEnabledComputeHosts: (sessionId, providerIds) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              enabledComputeHosts: providerIds.length > 0 ? providerIds : undefined,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Updates the persisted specialist UUID for an existing session (called after reconfigure succeeds).
  // Passing undefined clears the binding (Main Agent). Session persistence stores only the UUID.
  setSessionSpecialistId: (sessionId, specialistId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              specialistId: specialistId ?? undefined,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Flips the pinned flag so the sidebar can float the conversation into its pinned section. The flag
  // is persisted via the durable projection, but updatedAt is deliberately left untouched so pinning
  // never disturbs the "last active" ordering within a section.
  togglePinned: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, pinned: !session.pinned } : session
      )
    }))
  },

  updateSessionArchive: async (request) => {
    const persisted = await window.api.sessions.updateArchive(request)
    let updated: ChatSession | undefined

    set((state) => {
      const existing = state.sessions.find((session) => session.id === persisted.id)
      if (existing) {
        const withoutPreviousArchive = { ...existing }
        delete withoutPreviousArchive.archivedAt
        updated =
          persisted.archivedAt === undefined
            ? withoutPreviousArchive
            : { ...withoutPreviousArchive, archivedAt: persisted.archivedAt }
      } else {
        updated = hydrateSession(persisted)
      }
      return {
        sessions: state.sessions.map((session) =>
          session.id === persisted.id ? updated! : session
        )
      }
    })

    return updated ?? hydrateSession(persisted)
  },

  // Sets or clears the per-session fix loop active flag. The flag is transient (never persisted)
  // and gates canSendMessage in WorkspacePage: true blocks send for the duration of the fix loop.
  setFixLoopActive: (sessionId, active) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              fixLoopActive: active,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Renames a session while ignoring blank titles.
  renameSession: (sessionId, title) => {
    const trimmedTitle = title.trim()

    if (!trimmedTitle) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: trimmedTitle,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Removes a session and falls selection back to the next session within the same project.
  deleteSession: (sessionId) => {
    set((state) => {
      const deletedSession = state.sessions.find((session) => session.id === sessionId)
      if (!deletedSession) return state

      const sessions = state.sessions.filter((session) => session.id !== sessionId)

      if (state.selectedSessionId !== sessionId) {
        return {
          sessions,
          selectedSessionId: state.selectedSessionId
        }
      }

      // Fall back within the deleted session's own project. `sessions` is newest-first, so this picks the
      // most recent sibling. Using the global sessions[0] could select another project's conversation,
      // which the project-scoped workspace then filters out — leaving a blank center panel.
      const fallbackSession = deletedSession
        ? sessions.find((session) => session.projectId === deletedSession.projectId)
        : undefined

      return {
        sessions,
        selectedSessionId: fallbackSession?.id
      }
    })
  },

  // Drops every session belonging to a deleted project; the persistence bridge removes their files.
  removeSessionsForProject: (projectId) => {
    set((state) => {
      const sessions = state.sessions.filter((session) => session.projectId !== projectId)
      if (sessions.length === state.sessions.length) return state

      const selectedRemoved = !sessions.some((session) => session.id === state.selectedSessionId)

      return {
        sessions,
        selectedSessionId: selectedRemoved ? sessions[0]?.id : state.selectedSessionId
      }
    })
  }
}))

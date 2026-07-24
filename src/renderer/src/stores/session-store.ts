import { create } from 'zustand'
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'

import type { ArtifactFile } from '../../../shared/artifacts'
import { sanitizeActivityGroupTitle } from '../../../shared/activity-groups'
import {
  MAX_ACP_SESSION_IMAGE_BYTES,
  sanitizeAcpMessageImage,
  type AcpMessageImage
} from '../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  sanitizeMessageImages,
  sanitizeToolActivity,
  sanitizeActivityGroup,
  type MessagePart,
  type PersistedActiveRun,
  type PersistedActivityGroup,
  type PersistedArtifact,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageRole,
  type PersistedMessageStatus,
  type PersistedSessionManifest,
  type PersistedUploadedAttachment,
  type PersistedSessionStatus,
  type PersistedToolActivity
} from '../../../shared/session-persistence'
import { isReportableRunFailure } from '../../../shared/run-error-classification'

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
  isPending?: boolean
  // Transient: set at hydration when a session was interrupted by an app restart, so the UI can
  // offer an explicit Resume affordance. Never persisted (stripped in stripTransientSessionState).
  interrupted?: boolean
  // Transient: true while a Phase 3 fix loop is active for this session. Disables the send button
  // for the duration of the loop (across reviewer-review and agent-fix sub-phases). Never persisted.
  fixLoopActive?: boolean
  // Transient: true while the app is auto-recovering a conversation that outgrew the request-size limit
  // (reset agent context + replay a text transcript). The UI shows a neutral "Compacting…" note instead
  // of the overflow error, and the promise-path failure is suppressed. Cleared on the next run/settle.
  compacting?: boolean
  // Transient: latest agent status/stderr line for the in-flight turn, shown in the waiting indicator
  // so a long silent wait (e.g. the agent retrying a slow request) isn't a blank spinner. Not persisted.
  agentStatus?: string
}

type SessionStoreData = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
}

type AppendUserMessageInput = {
  sessionId: string
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  isPending?: boolean
}

type AppendPendingUserMessageInput = {
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
}

type BindPendingSessionInput = {
  pendingSessionId: string
  sessionId: string
  cwd?: string
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
}

type AppendAgentMessageChunkInput = {
  sessionId: string
  streamId: string
  eventId: string
  content?: string
  image?: AcpMessageImage
}

type UpsertToolActivityInput = {
  sessionId: string
  toolCallId: string
  eventId: string
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
  eventId: string
  artifacts: ArtifactFile[]
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

type AppendMessageResult = {
  sessionId: string
  messageId: string
}

type SessionStore = SessionStoreData & {
  selectSession: (sessionId: string) => void
  clearSelection: () => void
  appendUserMessage: (input: AppendUserMessageInput) => AppendMessageResult | undefined
  appendPendingUserMessage: (
    input: AppendPendingUserMessageInput
  ) => AppendMessageResult | undefined
  bindPendingSession: (input: BindPendingSessionInput) => AppendMessageResult | undefined
  appendAgentMessageChunk: (input: AppendAgentMessageChunkInput) => AppendMessageResult | undefined
  attachRunArtifacts: (input: AttachRunArtifactsInput) => AppendMessageResult | undefined
  replaceMessageArtifacts: (input: ReplaceMessageArtifactsInput) => void
  replaceMessageUploads: (input: ReplaceMessageUploadsInput) => void
  recordArtifactError: (sessionId: string, error: string) => void
  clearArtifactError: (sessionId: string) => void
  hydrateSessions: (sessions: PersistedChatSession[], manifest?: PersistedSessionManifest) => void
  upsertPersistedSession: (session: PersistedChatSession) => void
  finishRun: (sessionId: string) => void
  // opts.reportable overrides the report-affordance decision: pass false for a model-provider failure
  // (the agent relayed an upstream LLM/HTTP error), true to force it, or omit to let the store derive it
  // from the message (an app-crafted reminder → not reportable; anything else → reportable).
  failRun: (sessionId: string, error: string, opts?: { reportable?: boolean }) => void
  // Sets the transient agent status line shown in the waiting indicator; only applies while running.
  setAgentStatus: (sessionId: string, text: string) => void
  // Enters the auto-recovery "compacting" state after a request-size overflow: clears the error so the
  // UI shows a neutral note instead of a dead-end, without blocking the recovery re-send.
  beginCompaction: (sessionId: string) => void
  markResumed: (
    sessionId: string,
    agentFrameworkId?: PersistedChatSession['agentFrameworkId'],
    agentBackendId?: PersistedChatSession['agentBackendId']
  ) => void
  markDisconnected: (sessionId: string, reason?: string) => void
  removeMessage: (sessionId: string, messageId: string) => void
  truncateSessionFromMessage: (sessionId: string, messageId: string) => void
  upsertToolActivity: (input: UpsertToolActivityInput) => void
  beginActivityGroup: (sessionId: string, groupId: string, title: string) => void
  completeActivityGroup: (sessionId: string) => void
  setPermissionPending: (sessionId: string) => void
  clearPermissionPending: (sessionId: string) => void
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => void
  // Persists the per-session auto-review toggle. true = on; false = off (default).
  setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
  // Sets the per-session enabled compute hosts (single-select, stored as array for extensibility).
  setEnabledComputeHosts: (sessionId: string, providerIds: string[]) => void
  // Toggles whether a conversation is pinned to the top section of the sidebar.
  togglePinned: (sessionId: string) => void
  // Sets or clears the per-session fix loop active flag. When true, the composer send button is
  // disabled for this session; when false (loop ended or cancelled), send is re-enabled.
  setFixLoopActive: (sessionId: string, active: boolean) => void
  renameSession: (sessionId: string, title: string) => void
  deleteSession: (sessionId: string) => void
  removeSessionsForProject: (projectId: string) => void
}

// Keeps renderer message ids unique across store mutations in this process.
let messageSequence = 0
let pendingSessionSequence = 0
let timelineSequence = 0
const ARTIFACT_ERROR_PREFIX = 'Generated file finalization failed'
const externallyHydratedSessions = new WeakSet<ChatSession>()

// Builds the empty in-memory state used by the app and isolated tests.
export const createInitialSessionState = (): SessionStoreData => ({
  sessions: [],
  selectedSessionId: undefined
})

const stripTransientMessageState = (message: ChatMessage): PersistedChatMessage => {
  const { sortIndex, ...persistedMessage } = message

  void sortIndex

  return persistedMessage
}

const stripTransientSessionState = (session: ChatSession): PersistedChatSession => {
  const {
    activities,
    activityGroups,
    isPending,
    interrupted,
    fixLoopActive,
    compacting,
    agentStatus,
    messages,
    ...persistedSession
  } = session

  void isPending
  void interrupted
  void fixLoopActive
  void compacting
  void agentStatus

  // Persist a bounded projection of tool activities so the transcript survives restarts.
  const persistedActivities = activities
    ?.map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => !!activity)
  const persistedActivityGroups = activityGroups
    ?.map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => !!group)

  return {
    ...persistedSession,
    messages: messages.map(stripTransientMessageState),
    ...(persistedActivities && persistedActivities.length > 0
      ? { activities: persistedActivities }
      : {}),
    ...(persistedActivityGroups && persistedActivityGroups.length > 0
      ? { activityGroups: persistedActivityGroups }
      : {})
  }
}

// Restores a persisted tool activity into the richer runtime shape the UI derives its rows from.
const hydrateToolActivity = (activity: PersistedToolActivity): ToolActivity => ({
  ...activity,
  toolKind: activity.toolKind as ToolKind | undefined,
  toolContent: activity.toolContent as ToolCallContent[] | undefined,
  toolLocations: activity.toolLocations as ToolCallLocation[] | undefined
})

// Maps a persisted session (with bounded activities) back into the in-memory chat session shape.
const hydrateSession = (session: PersistedChatSession): ChatSession => ({
  ...session,
  permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
  activities: session.activities?.map(hydrateToolActivity),
  // Sessions restored as interrupted (see normalizeSessionAfterRestore) carry this exact error;
  // flag them so the composer can surface a Resume button instead of a dead-end error.
  interrupted: session.error === INTERRUPTED_SESSION_ERROR ? true : undefined
})

// Serializes one in-memory session into the durable per-file projection saved by the main process.
export { stripTransientSessionState as toPersistedSession }

// Creates renderer-local message ids while session ids come from the runtime.
const createMessageId = (): string => {
  messageSequence += 1
  return `message-${Date.now()}-${messageSequence}`
}

// Creates a renderer-only session id while the ACP session request is still pending.
const createPendingSessionId = (): string => {
  pendingSessionSequence += 1
  return `pending-session-${Date.now()}-${pendingSessionSequence}`
}

const createSortIndex = (): number => {
  timelineSequence += 1
  return timelineSequence
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

// Derives a compact default title from the first user message.
const createTitleFromMessage = (content: string): string => {
  const normalizedTitle = content.replace(/\s+/g, ' ').trim()

  return normalizedTitle.length > 48 ? `${normalizedTitle.slice(0, 48)}...` : normalizedTitle
}

// Provides a readable conversation title when the first prompt contains only attachments.
const createTitleFromUploads = (uploads: PersistedUploadedAttachment[]): string => {
  if (uploads.length === 1) return `Attached ${uploads[0].originalName || uploads[0].name}`

  return `Attached ${uploads.length} files`
}

// Copies only upload reference fields into store state, never file bytes or renderer extras.
const createPersistedUpload = (
  attachment: PersistedUploadedAttachment
): PersistedUploadedAttachment => ({
  id: attachment.id,
  sessionId: attachment.sessionId,
  name: attachment.name,
  originalName: attachment.originalName,
  path: attachment.path,
  mimeType: attachment.mimeType,
  size: attachment.size
})

// Normalizes message timestamps, ids, stream linkage, and status.
const createMessage = (
  role: ChatMessageRole,
  content: string,
  status: ChatMessageStatus,
  streamId?: string,
  eventIds: string[] = [],
  uploads: PersistedUploadedAttachment[] = [],
  parts?: MessagePart[]
): ChatMessage => {
  const now = Date.now()
  // Normalize upload references before attaching them to durable message state.
  const persistedUploads = uploads.map(createPersistedUpload)

  return {
    id: createMessageId(),
    role,
    content,
    status,
    streamId,
    eventIds,
    uploads: persistedUploads.length > 0 ? persistedUploads : undefined,
    // Structured mention segments drive the styled bubble; omit them when absent.
    parts: parts && parts.length > 0 ? parts : undefined,
    sortIndex: createSortIndex(),
    createdAt: now,
    updatedAt: now
  }
}

// Converts main-process artifact metadata into the compact persisted renderer reference shape.
const createPersistedArtifact = (artifact: ArtifactFile): PersistedArtifact => ({
  id: artifact.id,
  kind: 'managed-file',
  path: artifact.path,
  fileUrl: artifact.fileUrl,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  mtimeMs: artifact.mtimeMs
})

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

// Marks any open streamed messages as completed when a run stops.
const completeStreamingMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) =>
    message.status === 'streaming'
      ? {
          ...message,
          status: 'complete',
          updatedAt: Date.now()
        }
      : message
  )

// Marks partial streamed messages as errored when a run fails.
const failStreamingMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) =>
    message.status === 'streaming'
      ? {
          ...message,
          status: 'error',
          updatedAt: Date.now()
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

// Keeps permission waits sticky while tool updates continue to stream in.
const getToolActivitySessionStatus = (session: ChatSession): SessionStatus => {
  if (session.status === 'waiting-permission') return 'waiting-permission'

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

  // Appends a user prompt, creating the session if this is its first message.
  appendUserMessage: ({
    sessionId,
    content,
    attachments = [],
    parts,
    cwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    isPending
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
      parts
    )
    const activeRun: ActiveRun = {
      promptMessageId: userMessage.id,
      startedAt: now
    }

    // Existing sessions keep their message history and restart their active run.
    if (existingSession) {
      set({
        selectedSessionId: sessionId,
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                status: 'running',
                activeRun,
                ...(session.isPending
                  ? {
                      agentFrameworkId,
                      agentBackendId: normalizedAgentBackendId
                    }
                  : {}),
                agentModel: normalizedAgentModel,
                agentStatus: undefined,
                error: undefined,
                // Clear the prior failure's report flag alongside its text so a later internal error
                // cannot inherit a stale `false` and wrongly hide its Report button.
                errorReportable: undefined,
                compacting: undefined,
                messages: [...session.messages, userMessage],
                updatedAt: now
              }
            : session
        )
      })
    } else {
      // New sessions use the caller-provided id, which may be a pending renderer id.
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
        messages: [userMessage],
        activeRun,
        createdAt: now,
        updatedAt: now
      }

      set({
        selectedSessionId: sessionId,
        sessions: [newSession, ...state.sessions]
      })
    }

    return { sessionId, messageId: userMessage.id }
  },

  // Creates a visible local conversation before ACP returns the durable session id.
  appendPendingUserMessage: ({
    content,
    attachments = [],
    parts,
    cwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel
  }) => {
    return get().appendUserMessage({
      sessionId: createPendingSessionId(),
      content,
      attachments,
      parts,
      cwd,
      projectId,
      permissionProfile,
      agentFrameworkId,
      agentBackendId,
      agentModel,
      isPending: true
    })
  },

  // Replaces the temporary renderer id once ACP returns the real protocol session id.
  bindPendingSession: ({ pendingSessionId, sessionId, cwd, agentFrameworkId, agentBackendId }) => {
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
              updatedAt: now
            }
          : session
      )
    })

    return {
      sessionId,
      messageId: pendingSession.activeRun.promptMessageId
    }
  },

  // Replaces renderer state with the per-session files loaded by the main process. Sessions arrive in
  // filesystem order, so sort newest-first; selection is restored from the manifest when still present.
  hydrateSessions: (sessions, manifest) => {
    const hydrated = [...sessions]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(hydrateSession)
    const requestedSelection = manifest?.lastSessionId
    const selectedSessionId = hydrated.some((session) => session.id === requestedSelection)
      ? requestedSelection
      : hydrated[0]?.id

    set({ sessions: hydrated, selectedSessionId })
  },

  // Applies a durable lifecycle event without letting this client's own save echo replace newer
  // transient runtime state. Newer external snapshots remain authoritative.
  upsertPersistedSession: (session) => {
    set((state) => {
      const existing = state.sessions.find((candidate) => candidate.id === session.id)
      if (existing && existing.updatedAt >= session.updatedAt) return state

      const hydratedSession = hydrateSession(session)
      externallyHydratedSessions.add(hydratedSession)
      const sessions = [
        hydratedSession,
        ...state.sessions.filter((candidate) => candidate.id !== session.id)
      ].sort((left, right) => right.updatedAt - left.updatedAt)

      return { sessions }
    })
  },

  // Appends or extends a streamed agent message using a stable stream id.
  appendAgentMessageChunk: ({ sessionId, streamId, eventId, content = '', image }) => {
    let sanitizedImage = sanitizeAcpMessageImage(image)

    if (!sessionId || !streamId || !eventId || (content.length === 0 && !sanitizedImage)) {
      return undefined
    }

    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)

    if (!session) return undefined
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

    const existingMessage = session.messages.find(
      (message) => message.role === 'agent' && message.streamId === streamId
    )
    const messageId = existingMessage?.id ?? createMessageId()
    const responseToMessageId = session.activeRun?.promptMessageId
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
            messages: item.messages.map((message) =>
              message.id === existingMessage.id
                ? {
                    ...message,
                    content: `${message.content}${content}`,
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
          content,
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
          messages: [...item.messages, agentMessage],
          updatedAt: now
        }
      })
    })

    return { sessionId, messageId }
  },

  // Attaches a runtime artifact event to the best local assistant message before file finalization.
  attachRunArtifacts: ({ sessionId, runId, eventId, artifacts }) => {
    if (!sessionId || !runId || !eventId || artifacts.length === 0) return undefined

    let result: AppendMessageResult | undefined
    const now = Date.now()
    const incomingArtifacts = artifacts.map(createPersistedArtifact)
    const incomingArtifactIds = incomingArtifacts.map((artifact) => artifact.id)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        // Runtime event processing can replay visible events; event ids make the mutation idempotent.
        const alreadyAppliedMessage = session.messages.find((message) =>
          message.eventIds.includes(eventId)
        )

        if (alreadyAppliedMessage) {
          result = {
            sessionId,
            messageId: alreadyAppliedMessage.id
          }

          return session
        }

        const responseToMessageId = session.activeRun?.promptMessageId
        // Prefer the streamed assistant response; otherwise create a file-only assistant message.
        const existingMessage = [...session.messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'agent' &&
              (message.streamId === runId ||
                (responseToMessageId && message.responseToMessageId === responseToMessageId))
          )
        const messageId = existingMessage?.id ?? createMessageId()
        result = { sessionId, messageId }

        if (existingMessage) {
          return {
            ...session,
            artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
            messages: session.messages.map((message) =>
              message.id === existingMessage.id
                ? {
                    ...message,
                    eventIds: appendUniqueStrings(message.eventIds, [eventId]),
                    artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
                    updatedAt: now
                  }
                : message
            ),
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
          sortIndex: createSortIndex(),
          createdAt: now,
          updatedAt: now
        }

        return {
          ...session,
          artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
          messages: [...session.messages, artifactMessage],
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

        if (!message) return session

        // Remove only the artifacts previously linked to this message, preserving other message files.
        const replacedArtifactIds = new Set(message.artifactIds ?? [])
        const preservedArtifacts = (session.artifacts ?? []).filter(
          (artifact) => !replacedArtifactIds.has(artifact.id)
        )
        const nextArtifacts = upsertArtifacts(preservedArtifacts, incomingArtifacts)

        if (
          arePersistedArtifactsEqual(session.artifacts, nextArtifacts) &&
          areStringArraysEqual(message.artifactIds ?? [], incomingArtifactIds)
        ) {
          return session
        }

        const now = Date.now()

        return {
          ...session,
          artifacts: nextArtifacts,
          messages: session.messages.map((item) =>
            item.id === messageId
              ? {
                  ...item,
                  artifactIds: incomingArtifactIds,
                  updatedAt: now
                }
              : item
          ),
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

        return {
          ...session,
          messages: session.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  uploads: incomingUploads,
                  updatedAt: now
                }
              : message
          ),
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

  // Tracks runtime tool calls as lightweight activity rows instead of chat messages.
  upsertToolActivity: ({
    sessionId,
    toolCallId,
    eventId,
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

          return {
            ...session,
            status: getToolActivitySessionStatus(session),
            activities: activities.map((activity) =>
              activity.id === toolCallId
                ? {
                    ...activity,
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
                    updatedAt: now
                  }
                : activity
            ),
            updatedAt: now
          }
        }

        if (!session.activeRun) {
          return session
        }

        const activeGroup = session.activityGroups?.findLast(
          (group) => group.completedAt === undefined
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
          providerToolName,
          toolKind,
          toolContent,
          toolLocations,
          rawInput,
          rawOutput,
          terminalOutput,
          terminalExitCode,
          createdAt: now,
          updatedAt: now
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

  beginActivityGroup: (sessionId, groupId, title) => {
    const groupTitle = sanitizeActivityGroupTitle(title)
    if (!sessionId || !groupId || !groupTitle) return

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId || !session.activeRun) return session
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

  completeActivityGroup: (sessionId) => {
    if (!sessionId) return

    const now = Date.now()
    set((state) => {
      const target = state.sessions.find((session) => session.id === sessionId)
      const hasStartedOpenGroup = target?.activityGroups?.some(
        (group) => group.completedAt === undefined && group.activityIds.length > 0
      )
      if (!hasStartedOpenGroup) return state

      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                activityGroups: completeOpenActivityGroups(session.activityGroups, now),
                updatedAt: now
              }
            : session
        )
      }
    })
  },

  // Completes the active run and any streamed messages for the session.
  finishRun: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        const keepArtifactError = isArtifactFinalizationError(session.error)

        return {
          ...session,
          status: keepArtifactError ? 'error' : 'idle',
          activeRun: undefined,
          agentStatus: undefined,
          compacting: undefined,
          error: keepArtifactError ? session.error : undefined,
          errorReportable: keepArtifactError ? session.errorReportable : undefined,
          messages: completeStreamingMessages(session.messages),
          activities: completeOpenActivities(session.activities),
          activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
          updatedAt: Date.now()
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
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'error',
              activeRun: undefined,
              agentStatus: undefined,
              compacting: undefined,
              error: message,
              errorReportable,
              messages: failStreamingMessages(session.messages),
              activities: failOpenActivities(session.activities),
              activityGroups: completeOpenActivityGroups(session.activityGroups, Date.now()),
              updatedAt: Date.now()
            }
          : session
      )
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
  beginCompaction: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'idle',
              activeRun: undefined,
              agentStatus: undefined,
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
              status: 'error',
              activeRun: undefined,
              interrupted: true,
              compacting: undefined,
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

  // Drops a stale interrupted turn before re-send. Removing a message advances filesRevision only if
  // it also removes upload/artifact references from the indexed projection.
  removeMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const removedMessage = session.messages.find((message) => message.id === messageId)
        if (!removedMessage) return session
        const hasFiles =
          (removedMessage.uploads?.length ?? 0) > 0 || (removedMessage.artifactIds?.length ?? 0) > 0

        return {
          ...session,
          messages: session.messages.filter((message) => message.id !== messageId),
          filesRevision: hasFiles ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
          updatedAt: Date.now()
        }
      })
    }))
  },

  // Drops a message and every turn after it for an edited resend. Activities are cut by timestamp
  // because message sortIndex is transient (stripped on persist) while createdAt is durable on both
  // sides of hydration. The kept turns are what the resend replays into the fresh agent context.
  truncateSessionFromMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const cutIndex = session.messages.findIndex((message) => message.id === messageId)
        if (cutIndex < 0) return session

        const cutMessage = session.messages[cutIndex]
        const removed = session.messages.slice(cutIndex)
        const hasFiles = removed.some(
          (message) => (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
        )
        const activities = session.activities?.filter(
          (activity) => activity.createdAt < cutMessage.createdAt
        )
        const retainedActivityIds = new Set(activities?.map((activity) => activity.id) ?? [])
        const activityGroups = session.activityGroups
          ?.map((group) => ({
            ...group,
            activityIds: group.activityIds.filter((id) => retainedActivityIds.has(id))
          }))
          .filter((group) => group.activityIds.length > 0)

        return {
          ...session,
          status: 'idle',
          messages: session.messages.slice(0, cutIndex),
          activities,
          activityGroups,
          activeRun: undefined,
          agentStatus: undefined,
          error: undefined,
          errorReportable: undefined,
          interrupted: undefined,
          filesRevision: hasFiles ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
          updatedAt: Date.now()
        }
      })
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
      const sessions = state.sessions.filter((session) => session.id !== sessionId)

      if (state.selectedSessionId !== sessionId) {
        return { sessions, selectedSessionId: state.selectedSessionId }
      }

      // Fall back within the deleted session's own project. `sessions` is newest-first, so this picks the
      // most recent sibling. Using the global sessions[0] could select another project's conversation,
      // which the project-scoped workspace then filters out — leaving a blank center panel.
      const fallbackSession = deletedSession
        ? sessions.find((session) => session.projectId === deletedSession.projectId)
        : undefined

      return { sessions, selectedSessionId: fallbackSession?.id }
    })
  },

  // Drops every session belonging to a deleted project; the persistence bridge removes their files.
  removeSessionsForProject: (projectId) => {
    set((state) => {
      const sessions = state.sessions.filter((session) => session.projectId !== projectId)
      const selectedRemoved = !sessions.some((session) => session.id === state.selectedSessionId)

      return {
        sessions,
        selectedSessionId: selectedRemoved ? sessions[0]?.id : state.selectedSessionId
      }
    })
  }
}))

export const isExternallyHydratedSession = (session: ChatSession): boolean =>
  externallyHydratedSessions.has(session)

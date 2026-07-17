import { create } from 'zustand'
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind
} from '@agentclientprotocol/sdk'

import type { ArtifactFile } from '../../../shared/artifacts'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  sanitizeToolActivity,
  type MessagePart,
  type PersistedActiveRun,
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
  isPending?: boolean
}

type AppendPendingUserMessageInput = {
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
}

type BindPendingSessionInput = {
  pendingSessionId: string
  sessionId: string
  cwd?: string
}

type AppendAgentMessageChunkInput = {
  sessionId: string
  streamId: string
  eventId: string
  content: string
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
  finishRun: (sessionId: string) => void
  failRun: (sessionId: string, error: string) => void
  markResumed: (sessionId: string) => void
  markDisconnected: (sessionId: string) => void
  removeMessage: (sessionId: string, messageId: string) => void
  upsertToolActivity: (input: UpsertToolActivityInput) => void
  setPermissionPending: (sessionId: string) => void
  clearPermissionPending: (sessionId: string) => void
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => void
  // Persists the per-session auto-review toggle. true = on (default); false = off.
  setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
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
  const { activities, isPending, interrupted, fixLoopActive, messages, ...persistedSession } =
    session

  void isPending
  void interrupted
  void fixLoopActive

  // Persist a bounded projection of tool activities so the transcript survives restarts.
  const persistedActivities = activities
    ?.map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => !!activity)

  return {
    ...persistedSession,
    messages: messages.map(stripTransientMessageState),
    ...(persistedActivities && persistedActivities.length > 0
      ? { activities: persistedActivities }
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
    isPending
  }) => {
    const trimmedContent = content.trim()
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
                error: undefined,
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
    permissionProfile
  }) => {
    return get().appendUserMessage({
      sessionId: createPendingSessionId(),
      content,
      attachments,
      parts,
      cwd,
      projectId,
      permissionProfile,
      isPending: true
    })
  },

  // Replaces the temporary renderer id once ACP returns the real protocol session id.
  bindPendingSession: ({ pendingSessionId, sessionId, cwd }) => {
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

  // Appends or extends a streamed agent message using a stable stream id.
  appendAgentMessageChunk: ({ sessionId, streamId, eventId, content }) => {
    if (!sessionId || !streamId || !eventId || content.length === 0) return undefined

    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)

    if (!session) return undefined

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

        return {
          ...session,
          artifacts: upsertArtifacts(preservedArtifacts, incomingArtifacts),
          messages: session.messages.map((item) =>
            item.id === messageId
              ? {
                  ...item,
                  artifactIds: incomingArtifactIds,
                  updatedAt: Date.now()
                }
              : item
          ),
          updatedAt: Date.now()
        }
      })
    }))
  },

  // Replaces upload references on the local user message after pending files move to the session dir.
  replaceMessageUploads: ({ sessionId, messageId, uploads }) => {
    if (!sessionId || !messageId) return

    const incomingUploads = uploads.map(createPersistedUpload)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session

        return {
          ...session,
          messages: session.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  uploads: incomingUploads,
                  updatedAt: Date.now()
                }
              : message
          ),
          updatedAt: Date.now()
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

        // New tool calls are transient activity rows, not persisted chat messages.
        const activity: ToolActivity = {
          id: toolCallId,
          kind: 'tool',
          title: createToolActivityTitle(title, toolKind),
          status: nextStatus ?? 'pending',
          eventIds: [eventId],
          sortIndex: createSortIndex(),
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
          updatedAt: now
        }
      })
    }))
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
          error: keepArtifactError ? session.error : undefined,
          messages: completeStreamingMessages(session.messages),
          activities: completeOpenActivities(session.activities),
          updatedAt: Date.now()
        }
      })
    }))
  },

  // Fails the active run and records the visible session error.
  failRun: (sessionId, error) => {
    const message = error.trim()

    if (!message) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'error',
              activeRun: undefined,
              error: message,
              messages: failStreamingMessages(session.messages),
              activities: failOpenActivities(session.activities),
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Clears the interrupted/error state after a successful resume so the composer is usable again.
  markResumed: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'idle',
              error: undefined,
              interrupted: undefined,
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Flags a session dropped by a live connection loss so the Resume banner appears; like failRun it
  // settles any half-streamed message/open tool so nothing hangs in a perpetually-running state.
  markDisconnected: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              status: 'error',
              activeRun: undefined,
              interrupted: true,
              error: 'Connection lost — Resume to reconnect and continue.',
              messages: failStreamingMessages(session.messages),
              activities: failOpenActivities(session.activities),
              updatedAt: Date.now()
            }
          : session
      )
    }))
  },

  // Drops a single message by id (used to remove a stale interrupted user turn before it is re-sent).
  removeMessage: (sessionId, messageId) => {
    if (!sessionId || !messageId) return

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: session.messages.filter((message) => message.id !== messageId),
              updatedAt: Date.now()
            }
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

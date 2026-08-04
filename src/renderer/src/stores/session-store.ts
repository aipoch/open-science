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
  type AcpContextUsage,
  type AcpMessageImage,
  type AcpTurnTokenUsage
} from '../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  materializeSessionConversationGraph,
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
import { PENDING_UPLOAD_SESSION_ID } from '../../../shared/uploads'
import {
  createLinearConversationGraph,
  activateConversationBranch,
  ensureConversationRuntimeSegment,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'

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
  // Transient: the durable active Branch changed while the Agent/Notebook still hold the previous
  // Branch's volatile state. The next continuation must rebuild both contexts before prompting.
  branchContextResetRequired?: boolean
  // Transient: a specialist switch replaced the live agent session (Claude bakes identity into the
  // session at creation). The next continuation must replay conversation history so the new
  // specialist retains continuity, without resetting the notebook kernel (unlike a Branch switch).
  specialistSwitchResetRequired?: boolean
  // Transient aggregate of Reviewer, Notebook, Upload-finalization, and deletion activity that lives
  // outside this store. The workspace projects those operation gates here so direct store callers
  // cannot bypass disabled revision controls.
  branchSwitchBlocked?: boolean
  // Transient: terminal graph synchronization failed, so the in-memory run is settled as an explicit
  // error while persistence keeps the last valid durable graph. Restarting restores that safe copy.
  conversationGraphSyncBlocked?: boolean
  // Transient: identifies the unsent current prompt of a branched pending Session. A creation retry
  // replaces this prompt and rebuilds its copied history replay instead of appending a duplicate turn.
  pendingContextReplayMessageId?: string
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
  // Immutable Specialist UUID; written once on session creation and never changed after.
  specialistId?: string
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
  // Immutable Specialist UUID forwarded from the new-conversation draft picker.
  specialistId?: string
}

// Starts a fresh pending Session from the selected source's visible active path. Runtime settings
// may be supplied by the normal-send path; omitted values retain the source Session's setting.
export type BranchInNewSessionInput = {
  sourceSessionId: string
  content: string
  attachments?: PersistedUploadedAttachment[]
  parts?: MessagePart[]
  permissionProfile?: PermissionProfileId
  agentFrameworkId?: PersistedChatSession['agentFrameworkId']
  agentBackendId?: PersistedChatSession['agentBackendId']
  agentModel?: string
  // `undefined` inherits the source binding; `null` deliberately chooses the Main Agent.
  specialistId?: string | null
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
  promptMessageId?: string
  content?: string
  image?: AcpMessageImage
}

type UpsertToolActivityInput = {
  sessionId: string
  toolCallId: string
  eventId: string
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

type ApplyDurableSessionProjectionInput = {
  source: ChatSession
  session: PersistedChatSession
  mode?: 'merge-upload-identities' | 'replace-persisted-if-current'
}

type AppendMessageResult = {
  sessionId: string
  messageId: string
}

export type SessionHydrationSelection = {
  sessionId: string | undefined
}

type SessionStore = SessionStoreData & {
  selectSession: (sessionId: string) => void
  clearSelection: () => void
  appendUserMessage: (input: AppendUserMessageInput) => AppendMessageResult | undefined
  appendPendingUserMessage: (
    input: AppendPendingUserMessageInput
  ) => AppendMessageResult | undefined
  branchInNewSession: (input: BranchInNewSessionInput) => AppendMessageResult | undefined
  bindPendingSession: (input: BindPendingSessionInput) => AppendMessageResult | undefined
  clearPendingContextReplay: (sessionId: string, messageId: string) => void
  appendAgentMessageChunk: (input: AppendAgentMessageChunkInput) => AppendMessageResult | undefined
  attachRunArtifacts: (input: AttachRunArtifactsInput) => AppendMessageResult | undefined
  replaceMessageArtifacts: (input: ReplaceMessageArtifactsInput) => void
  replaceMessageUploads: (input: ReplaceMessageUploadsInput) => void
  recordArtifactError: (sessionId: string, error: string) => void
  clearArtifactError: (sessionId: string) => void
  hydrateSessions: (
    sessions: PersistedChatSession[],
    manifest?: PersistedSessionManifest,
    selection?: SessionHydrationSelection
  ) => void
  upsertPersistedSession: (session: PersistedChatSession) => void
  applyDurableSessionProjection: (input: ApplyDurableSessionProjectionInput) => void
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
  removeMessage: (sessionId: string, messageId: string) => void
  truncateSessionFromMessage: (sessionId: string, messageId: string) => void
  activateMessageBranch: (sessionId: string, branchId: string) => void
  setBranchSwitchBlocked: (sessionId: string, blocked: boolean) => void
  clearBranchContextReset: (sessionId: string) => void
  markSpecialistSwitchResetRequired: (sessionId: string) => void
  clearSpecialistSwitchResetRequired: (sessionId: string) => void
  upsertToolActivity: (input: UpsertToolActivityInput) => void
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
let conversationBranchSequence = 0
let runtimeSegmentSequence = 0
const ARTIFACT_ERROR_PREFIX = 'Generated file finalization failed'
const CONVERSATION_GRAPH_SYNC_ERROR =
  'Conversation history could not be finalized safely. Restart the app to restore the last saved conversation state, then report this issue.'
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
    branchContextResetRequired,
    specialistSwitchResetRequired,
    branchSwitchBlocked,
    conversationGraphSyncBlocked,
    pendingContextReplayMessageId,
    messages,
    ...persistedSession
  } = session

  void isPending
  void interrupted
  void fixLoopActive
  void compacting
  void agentStatus
  void branchContextResetRequired
  void specialistSwitchResetRequired
  void branchSwitchBlocked
  void conversationGraphSyncBlocked
  void pendingContextReplayMessageId

  // Persist a bounded projection of tool activities so the transcript survives restarts.
  const persistedActivities = activities
    ?.map(sanitizeToolActivity)
    .filter((activity): activity is PersistedToolActivity => !!activity)
  const persistedActivityGroups = activityGroups
    ?.map(sanitizeActivityGroup)
    .filter((group): group is PersistedActivityGroup => !!group)

  return materializeSessionConversationGraph({
    ...persistedSession,
    messages: messages.map(stripTransientMessageState),
    ...(persistedActivities && persistedActivities.length > 0
      ? { activities: persistedActivities }
      : {}),
    ...(persistedActivityGroups && persistedActivityGroups.length > 0
      ? { activityGroups: persistedActivityGroups }
      : {})
  })
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

// A save may resolve after a newer runtime event already replaced the source Session object. Merge
// only the legacy Upload identities proven by that submitted snapshot; never overwrite newer text,
// graph, status, or transient runtime state with an older durable response.
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

const createConversationBranchId = (): string => {
  conversationBranchSequence += 1
  return `message-branch-${Date.now()}-${conversationBranchSequence}`
}

const createRuntimeSegmentId = (): string => {
  runtimeSegmentSequence += 1
  return `runtime-segment-${Date.now()}-${runtimeSegmentSequence}`
}

const synchronizeSessionGraph = (
  session: ChatSession,
  messages: ChatMessage[],
  now: number,
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
    id: createRuntimeSegmentId(),
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
    activeRun: undefined,
    agentStatus: undefined,
    compacting: undefined,
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

// Derives a compact default title from the first user message.
const createTitleFromMessage = (content: string): string => {
  const normalizedTitle = content.replace(/\s+/g, ' ').trim()

  return normalizedTitle.length > 48 ? `${normalizedTitle.slice(0, 48)}...` : normalizedTitle
}

// A branch's title identifies the new request, so unlike the sidebar's first-message default it
// keeps the complete normalized prompt. Sidebar truncation remains a presentation concern.
const createBranchTitleFromMessage = (content: string): string =>
  content.replace(/\s+/g, ' ').trim()

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
  mimeType: attachment.mimeType,
  size: attachment.size,
  versionId: attachment.versionId,
  versionNumber: attachment.versionNumber,
  createdAt: attachment.createdAt,
  sha256: attachment.sha256 ?? attachment.checksum,
  // A staged upload has no Version yet. Keep its main-issued path capability in renderer memory
  // until finalizeSession publishes the immutable Version; the persistence bridge explicitly waits
  // for that transition, so newly written Session JSON remains path-free.
  ...(!attachment.versionId && attachment.sessionId === PENDING_UPLOAD_SESSION_ID && attachment.path
    ? { path: attachment.path }
    : {})
})

// A path-only legacy Upload still needs its source-owned capability long enough for the branch send
// path to publish it as an immutable Version. The child remains pending until that reconciliation
// finishes, so this path is transient and never reaches a newly written Session JSON.
const copySnapshotUpload = (
  attachment: PersistedUploadedAttachment
): PersistedUploadedAttachment => ({
  ...createPersistedUpload(attachment),
  ...(!attachment.versionId && attachment.path ? { path: attachment.path } : {})
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

// Copies the visible transcript without carrying event/stream correlations into the fresh runtime.
const copySnapshotMessage = (message: PersistedChatMessage, sortIndex: number): ChatMessage => ({
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

// Tool rows are rendered as historical transcript only; provider event ids must not be reused by a
// new Session's runtime. The bounded payload is otherwise preserved for the existing detail views.
const createSnapshotActivityId = (sessionId: string, id: string): string =>
  `history:${sessionId}:${id}`

const copySnapshotActivity = (activity: PersistedToolActivity, sessionId: string): ToolActivity =>
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

const copySnapshotActivityGroup = (
  group: PersistedActivityGroup,
  sessionId: string
): PersistedActivityGroup => ({
  ...group,
  id: createSnapshotActivityId(sessionId, group.id),
  activityIds: group.activityIds.map((id) => createSnapshotActivityId(sessionId, id))
})

const canBranchInNewSession = (session: ChatSession): boolean =>
  !session.activeRun &&
  session.status !== 'running' &&
  session.status !== 'waiting-permission' &&
  !session.fixLoopActive &&
  !session.compacting &&
  !session.branchSwitchBlocked &&
  !session.conversationGraphSyncBlocked

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
      parts
    )
    const activeRun: ActiveRun = {
      promptMessageId: userMessage.id,
      startedAt: now
    }

    // Existing sessions keep their message history and restart their active run.
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
        // Specialist UUID written once at creation; never changed after bind.
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
    agentModel,
    specialistId
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
      specialistId,
      isPending: true
    })
  },

  // Creates/selects a fresh pending Session from only the source's current visible Branch. The
  // runtime binds this local id before replaying the bounded history into a new ACP Session.
  branchInNewSession: ({
    sourceSessionId,
    content,
    attachments = [],
    parts,
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

    // `messages`/activities are the store's active-Branch compatibility projection. Reading this
    // single source snapshot keeps message and activity relationships aligned without traversing
    // inactive Graph siblings.
    const sourceMessages = source.messages.map((message, index) => ({
      message: stripTransientMessageState(message),
      // Match the timeline projection fallback so exact-timestamp tool rows keep their position.
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
      parts
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
    })

    return { sessionId, messageId: userMessage.id }
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

  clearPendingContextReplay: (sessionId, messageId) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && session.pendingContextReplayMessageId === messageId
          ? { ...session, pendingContextReplayMessageId: undefined }
          : session
      )
    }))
  },

  // Replaces renderer state with the per-session files loaded by the main process. Sessions arrive in
  // filesystem order, so sort newest-first; selection is restored from the manifest when still present.
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

    set({
      sessions: hydrated,
      selectedSessionId
    })
  },

  // Applies a durable lifecycle event without letting this client's own save echo replace newer
  // transient runtime state. An equal-revision response may still carry a newly published Upload
  // Version, so merge that identity delta instead of discarding the whole event.
  upsertPersistedSession: (session) => {
    set((state) => {
      const existing = state.sessions.find((candidate) => candidate.id === session.id)
      if (existing && existing.updatedAt > session.updatedAt) return state
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
        if (!flat.changed && !graph?.changed) return state
        const projected: ChatSession = {
          ...existing,
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
        }
      }

      const hydratedSession = hydrateSession(session)
      externallyHydratedSessions.add(hydratedSession)
      const sessions = [
        hydratedSession,
        ...state.sessions.filter((candidate) => candidate.id !== session.id)
      ].sort((left, right) => right.updatedAt - left.updatedAt)

      return { sessions }
    })
  },

  // Acknowledges the exact projection returned by this client's save. Conflict recovery may replace
  // the full persisted projection while the submitted source is still current; a later live mutation
  // receives only the immutable Upload identity delta so the response cannot roll it back.
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
      }
    })
  },

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

    const existingMessage = session.messages.find(
      (message) => message.role === 'agent' && message.streamId === streamId
    )
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

  // Tracks runtime tool calls as lightweight activity rows instead of chat messages.
  upsertToolActivity: ({
    sessionId,
    toolCallId,
    eventId,
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
                    updatedAt: now
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
          status: keepArtifactError ? 'error' : 'idle',
          activeRun: undefined,
          agentStatus: undefined,
          compacting: undefined,
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
          status: 'error',
          activeRun: undefined,
          agentStatus: undefined,
          compacting: undefined,
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
        const cutIndex = session.messages.findIndex((message) => message.id === messageId)
        if (cutIndex < 0) return session
        const removedMessages = session.messages.slice(cutIndex)
        const hasFiles = removedMessages.some(
          (message) => (message.uploads?.length ?? 0) > 0 || (message.artifactIds?.length ?? 0) > 0
        )
        const now = Date.now()
        const currentGraph = synchronizeSessionGraph(session, session.messages, now)
        // Interrupted turns are immutable evidence once recorded. Fork before the unanswered prompt
        // so retrying it cannot resurrect the old bubble, while the abandoned Branch remains available
        // to provenance and revision history instead of being destructively rewritten.
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
    }))
  },

  // Switches the whole durable active-path projection without contacting the Agent or Notebook.
  activateMessageBranch: (sessionId, branchId) => {
    if (!sessionId || !branchId) return
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (
          session.id !== sessionId ||
          !session.conversationGraph ||
          session.activeRun ||
          session.status === 'running' ||
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
        const conversationGraph = activateConversationBranch(session.conversationGraph, branchId)
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

export const isExternallyHydratedSession = (session: ChatSession): boolean =>
  externallyHydratedSessions.has(session)

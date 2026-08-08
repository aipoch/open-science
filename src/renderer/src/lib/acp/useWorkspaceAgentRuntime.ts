import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AcpConnectionStatus,
  AcpCreateSessionResponse,
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpMessageImage,
  AcpContextUsage
} from '../../../../shared/acp'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import {
  imageAttachmentMimeType,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from '../../../../shared/uploads'
import type { FileReference } from '../../../../shared/artifacts'
import type { MessagePart } from '../../../../shared/session-persistence'
import { getActiveConversationContext } from '../../../../shared/conversation-graph'
import type { AgentFrameworkId } from '../../../../shared/settings'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import {
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_WORKSPACE_MISSING_MESSAGE
} from '../../../../shared/run-error-classification'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { useSessionStore, type ChatMessage, type ChatSession } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import { useSettingsStore } from '../../stores/settings-store'
import { useAcpRuntime } from './useAcpRuntime'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  resolveSessionHistoryReplayDescriptor,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  applyWorkspaceRuntimeEvent,
  syncWorkspaceAgentFirstOutputState,
  syncWorkspacePermissionState
} from './workspace-events'

type SendWorkspaceMessageInput = {
  sessionId?: string
  // Branch in New Session creates a fresh app/ACP Session from this source Session's active path.
  // It is mutually exclusive with `sessionId`, which continues an existing app Session.
  branchSourceSessionId?: string
  text: string
  turnIntent?: 'plan-first'
  planContinuation?: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'> & {
    pendingAction?: 'review' | 'approve' | 'reject'
  }
  attachments?: UploadedAttachment[]
  cwd?: string
  // Durable owning project stamped on new sessions.
  projectId?: string
  // Storage project the artifact/notebook MCP servers write under (usually the same value).
  projectName?: string
  permissionProfile?: PermissionProfileId
  // Snapshot of the selected agent configuration for this run; persisted for failure diagnostics
  // even when the initial ACP session handshake never completes.
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  historyReplayDescriptor?: HistoryReplayDescriptor
  // Skills the user picked in the composer; force-loaded and nudged for this turn only.
  forcedSkillIds?: string[]
  // Existing files referenced via `@` mentions; attached to the prompt as content blocks.
  referencedArtifacts?: FileReference[]
  // Structured mention segments of the draft, persisted so the sent bubble renders styled pills.
  parts?: MessagePart[]
  // Internal recovery seam for ordinary sends that intentionally replace provider context (for
  // example context-overflow retry). Session Resume owns its replay and continuation separately.
  forceHistoryReplay?: boolean
  // Current Provider capability, injected by the hook so replay can omit unsupported image media.
  supportsImageInput?: boolean
  // Internal edit-resend seam: reset the selected runtime first, then replace the active Branch from
  // this message and replay only the retained prefix into the fresh context.
  truncateFromMessageId?: string
  // Internal overflow-recovery handoff: that flow owns the compacting state and replaces it with the
  // retried run synchronously. Ordinary composer sends must never bypass the local compaction gate.
  allowCompactionRecovery?: boolean
  // Internal retry seam: unlike a normal missing-at-start send, this request belongs to a captured
  // durable session and must abort if that conversation was deleted during an earlier control turn.
  requireExistingSession?: boolean
  // Immutable Specialist UUID from the new-conversation draft picker. Only used when creating a new
  // ACP session (sessionId === undefined). The renderer sends only the UUID; the main process reads
  // the latest Profile. Never passed for existing sessions (specialist binding is immutable).
  specialistId?: string | null
}

type SendWorkspaceMessageResult = {
  sessionId: string
  messageId: string
}

type HistoryReplayContext = {
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpMessageImage[]
}

const isReplayImage = (attachment: Pick<UploadedAttachment, 'name' | 'mimeType'>): boolean =>
  imageAttachmentMimeType(attachment.name, attachment.mimeType) !== undefined

const hasHistoryImages = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) => (message.images?.length ?? 0) > 0 || message.uploads?.some(isReplayImage) === true
  )

const replayAttachmentsForModel = (
  replay: HistoryReplayContext | undefined,
  supportsImageInput: boolean | undefined
): UploadedAttachment[] | undefined => {
  if (supportsImageInput !== false) return replay?.historyAttachments
  const attachments = replay?.historyAttachments?.filter((attachment) => !isReplayImage(attachment))
  return attachments?.length ? attachments : undefined
}

const buildWorkspaceReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor | undefined,
  frameworkId: AgentFrameworkId | undefined,
  projectId?: string,
  supportsImageInput?: boolean
): HistoryReplayContext | undefined =>
  buildWorkspaceHistoryReplay(
    messages,
    descriptor ?? { target: resolveHistoryReplayTarget(frameworkId) },
    projectId,
    supportsImageInput
  )

type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type RuntimeEventDrain = (sessionId?: string) => Promise<void>

type ResumeInterruptedWorkspaceSessionOptions = {
  historyReplayDescriptor?: HistoryReplayDescriptor
  supportsImageInput?: boolean
  flushPersistence?: () => Promise<void>
}

// Payload of an inline edit resend: the adjusted prompt text plus the mentions it carries. The
// session/message ids stay separate because they address the truncation point, not the prompt.
type ResendEditedMessageInput = {
  text: string
  // Structured mention segments of the edited draft, persisted so the resent bubble renders pills.
  parts?: MessagePart[]
  // Skills picked in the inline editor; force-loaded and nudged for the resent turn only.
  forcedSkillIds?: string[]
  // Files referenced via `@` mentions in the inline editor; attached to the resent prompt.
  referencedArtifacts?: FileReference[]
}

type ResendEditedWorkspaceMessageOptions = {
  supportsImageInput?: boolean
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  historyReplayDescriptor?: HistoryReplayDescriptor
  onSendPreparationStateChange?: SendPreparationStateChange
  drainRuntimeEvents?: RuntimeEventDrain
}

type WorkspaceMessageRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'resetSessionContext' | 'sendPrompt'
> &
  Partial<Pick<ReturnType<typeof useAcpRuntime>, 'compactSession' | 'continueInterruptedTurn'>>

type WorkspaceDeletionRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'deleteSession'>
type WorkspaceCancellationRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'cancel'>
type WorkspacePermissionProfileRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'setPermissionProfile'
>
type PersistSessionDeletion = (request: { projectId: string; sessionId: string }) => Promise<void>

type RuntimeEventApplier = (event: AcpRuntimeEvent) => Promise<boolean>

type WorkspaceRuntimeEventProcessor = {
  process: (events: AcpRuntimeEvent[]) => Promise<void>
  drain: (sessionId?: string) => Promise<void>
}

// Runtime adoption and Branch reset intentionally complete before appendUserMessage creates the next
// run. Keep duplicate preparations closed during that idle-looking interval without exposing a
// premature activeRun that a draining runtime's terminal event could settle.
const sessionSendPreparationsInFlight = new Set<string>()

const setWorkspacePermissionProfile = async (
  runtime: WorkspacePermissionProfileRuntime,
  sessionId: string,
  profile: PermissionProfileId
): Promise<boolean> => {
  let persistedProfile = profile
  if (runtime.state.sessionIds.includes(sessionId)) {
    const snapshot = await runtime.setPermissionProfile(sessionId, profile)
    const committedProfile = snapshot?.permissionProfiles[sessionId]?.selectedProfile

    if (!committedProfile) return false
    persistedProfile = committedProfile
  }

  useSessionStore.getState().setPermissionProfile(sessionId, persistedProfile)
  return true
}

// Strips the Electron IPC wrapper ("Error invoking remote method '…': Error: <cause>") and any
// leading "Error:" (or a lone "Error" type label) so the underlying agent message can be shown to the
// user on its own. Used by both resume and createSession failure paths, since either arrives wrapped.
const unwrapIpcErrorDetail = (message: string): string =>
  message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error(?::\s*|$)/i, '')
    .trim()

const RESUME_UNKNOWN_ERROR_MESSAGE = 'Agent session resume failed: Unknown error'
const EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS: string[] = []

// Turns a createSession (conversation-start) failure into the message persisted on the session. The
// error crosses IPC wrapped, so it is unwrapped first — this keeps the app-authored setup guidance
// (settings/service.ts: model-incompat, no provider, Codex bridge, missing Claude executable) matching
// the classifier's prefixes/constants, so a wrong-config start failure hides the report button instead
// of masquerading as a reportable bug behind the "Error invoking remote method" wrapper.
const getCreateSessionFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  return unwrapIpcErrorDetail(message) || 'Agent session could not be created.'
}

// Turns a resume failure into an actionable message. Each branch matches one distinct cause thrown
// along the runtime resume path (runtime.ts): a deleted/moved workspace folder ("cwd does not exist"),
// the bounded handshake timeout, an agent build without the resume capability, or a failure to spawn/
// reconnect the agent process. Anything else is genuinely unexpected, so the underlying cause is kept
// visible instead of collapsing to an opaque "resume failed". (The common session-replaced/not-found
// case never reaches here — the runtime silently adopts a fresh agent session for it.)
const getResumeFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  if (/cwd does not exist/i.test(message)) {
    return RESUME_WORKSPACE_MISSING_MESSAGE
  }

  if (/timed out/i.test(message)) {
    return RESUME_TIMED_OUT_MESSAGE
  }

  if (/does not support session resume/i.test(message)) {
    return RESUME_UNSUPPORTED_MESSAGE
  }

  if (/connection (failed|was superseded)|ACP connection/i.test(message)) {
    return RESUME_RECONNECT_FAILED_MESSAGE
  }

  // Model↔framework mismatch is now flagged proactively in Settings → Model, so keep this soft and
  // actionable rather than an alarming "resume failed" — the fix lives in settings, not here. Anchor
  // to the specific marker from the thrown error (settings/service.ts: "The active model isn't
  // compatible with <framework>…") so unrelated "not compatible with" errors — notably an ACP
  // protocol-version mismatch — fall through to the default message instead of being mislabeled.
  if (/active model isn'?t compatible with/i.test(message)) {
    return RESUME_MODEL_INCOMPATIBLE_MESSAGE
  }

  const detail = unwrapIpcErrorDetail(message)

  // Electron can preserve only the custom RequestError name/message while dropping structured
  // `data.details` across IPC. A bare Internal error supplies no evidence for a network, session, or
  // provider diagnosis, so classify it as unknown. Specific downstream causes stay visible below.
  if (detail === 'RequestError: Internal error' || detail === 'Internal error') {
    return RESUME_UNKNOWN_ERROR_MESSAGE
  }

  return detail ? `Agent session resume failed: ${detail}` : RESUME_UNKNOWN_ERROR_MESSAGE
}

// Keeps attachment-finalization failures displayable without assuming Error instances.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// The id of the most recent prompt-failure error event for a session, or undefined if none. Captured
// before a prompt is dispatched so the rejection path can tell a NEW failure event (this turn) from a
// stale one left by an earlier turn, and never inherit the earlier turn's providerError tag.
const latestPromptFailureEventId = (
  events: AcpRuntimeEvent[],
  sessionId: string
): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.kind === 'error' && event.sessionId === sessionId) return event.id
  }
  return undefined
}

// Classifies a failed prompt against the live connection status: an abnormal drop (status 'closed'/
// 'error') shows the Resume banner so the user can reconnect and continue, while a turn-level error
// (connection still up, e.g. a gateway 5xx) surfaces as a normal session error. Reading the status at
// failure time avoids the race where failRun would flip the session out of 'running' first.
//
// priorErrorEventId is the newest prompt-failure event id observed BEFORE this prompt was dispatched;
// it lets the reportability read below ignore a stale event from an earlier turn.
const failOrMarkDisconnected = async (
  sessionId: string,
  message: string,
  priorErrorEventId?: string
): Promise<void> => {
  // A conversation being auto-compacted after a request-size overflow owns its own outcome (reset +
  // retry). Don't overwrite the neutral compacting state with a dead-end error from the rejected
  // sendPrompt call.
  if (useSessionStore.getState().sessions.find((session) => session.id === sessionId)?.compacting) {
    return
  }

  // The rejection carries no structural tag (IPC strips the Error's data), so read THIS turn's error
  // event from the snapshot to learn whether it was a model-provider failure. The runtime pushes that
  // event (tagged providerError) synchronously before rejecting, so by the time this getState resolves
  // it is already present. Only a provider-tagged event forces reportable=false; everything else is left
  // undefined so failRun's text tier decides — this converges with the event path (workspace-events) and
  // keeps a non-recovered overflow (providerError=false) non-reportable via the text tier instead of
  // being mislabeled reportable. Undefined also covers no NEW event (a stale prior-turn event is ignored).
  let reportable: boolean | undefined
  try {
    const snapshot = await window.api.acp.getState()

    const status = snapshot.sessionConnectionStatuses?.[sessionId] ?? snapshot.status
    if (status === 'closed' || status === 'error') {
      // Keep the specific failure cause (e.g. "Connection timeout") in the Resume banner.
      useSessionStore.getState().markDisconnected(sessionId, message)
      return
    }

    const runError = [...snapshot.events]
      .reverse()
      .find((event) => event.kind === 'error' && event.sessionId === sessionId)
    // Only trust an event that is NEW for this turn, so a provider-error tag from an earlier turn can
    // neither hide this failure's report button nor mislabel it.
    if (runError && runError.id !== priorErrorEventId && runError.providerError) reportable = false
  } catch {
    // Fall back to a plain error if the live status read fails.
  }

  useSessionStore.getState().failRun(sessionId, message, { reportable })
}

// Moves staged uploads into the session directory and updates the already-visible user message.
const finalizeWorkspaceAttachments = async (
  sessionId: string,
  messageId: string,
  attachments: UploadedAttachment[],
  projectId?: string
): Promise<UploadedAttachment[]> => {
  if (attachments.length === 0) return attachments

  // The renderer message is written before runtime work starts, so its upload paths are replaced.
  const finalizedAttachments = await window.api.uploads.finalizeSession({
    projectId,
    sessionId,
    attachments
  })

  useSessionStore.getState().replaceMessageUploads({
    sessionId,
    messageId,
    uploads: finalizedAttachments.map(toPersistedUploadedAttachment)
  })
  // Keep tabs opened from staged attachments pointed at the files after their final move.
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalizedAttachments)

  return finalizedAttachments
}

// Publishes copied staged history under its source Session before the child reuses the Version refs.
const reconcileBranchedHistoryAttachments = async (
  sourceSessionId: string,
  childSessionId: string,
  historyMessages: ChatMessage[],
  projectId: string | undefined
): Promise<void> => {
  const stagedById = new Map<string, UploadedAttachment>()
  for (const message of historyMessages) {
    for (const upload of message.uploads ?? []) {
      if (!upload.versionId && !stagedById.has(upload.id)) {
        stagedById.set(upload.id, toRuntimeUploadedAttachment(upload, projectId))
      }
    }
  }
  if (stagedById.size === 0) return

  const finalized = await window.api.uploads.finalizeSession({
    projectId,
    sessionId: sourceSessionId,
    attachments: [...stagedById.values()]
  })
  const finalizedById = new Map(finalized.map((upload) => [upload.id, upload]))

  for (const stagedId of stagedById.keys()) {
    if (!finalizedById.has(stagedId)) {
      throw new Error(`Upload finalization did not return the staged attachment: ${stagedId}`)
    }
  }

  for (const message of historyMessages) {
    if (!message.uploads?.some((upload) => stagedById.has(upload.id))) continue
    const uploads = message.uploads.map((upload) => {
      const finalizedUpload = finalizedById.get(upload.id)
      return finalizedUpload ? toPersistedUploadedAttachment(finalizedUpload) : upload
    })
    useSessionStore.getState().replaceMessageUploads({
      sessionId: sourceSessionId,
      messageId: message.id,
      uploads
    })
    useSessionStore.getState().replaceMessageUploads({
      sessionId: childSessionId,
      messageId: message.id,
      uploads
    })
  }

  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalized)
}

const getPromptProvenanceContext = (
  sessionId: string,
  promptMessageId: string
): ReturnType<typeof getActiveConversationContext> | { promptMessageId: string } => {
  const graph = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)?.conversationGraph
  return graph ? getActiveConversationContext(graph, promptMessageId) : { promptMessageId }
}

const shutdownNotebookForBranchChange = async (
  sessionId: string,
  workspaceCwd: string,
  projectName?: string
): Promise<void> => {
  if (typeof window === 'undefined' || !window.api?.notebook?.shutdown) return
  await window.api.notebook.shutdown({ sessionId, workspaceCwd, projectName })
}

const processVisibleWorkspaceRuntimeEvents = async (
  events: AcpRuntimeEvent[],
  processedEventIds: Set<string>,
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent,
  processingEventIds = new Set<string>()
): Promise<void> => {
  // Runtime snapshots are bounded, so forget ids that can no longer be replayed from the source list.
  const visibleEventIds = new Set(events.map((event) => event.id))

  for (const eventId of processedEventIds) {
    if (!visibleEventIds.has(eventId)) {
      processedEventIds.delete(eventId)
    }
  }

  for (const eventId of processingEventIds) {
    if (!visibleEventIds.has(eventId)) {
      processingEventIds.delete(eventId)
    }
  }

  for (const event of events) {
    if (processedEventIds.has(event.id) || processingEventIds.has(event.id)) continue

    processingEventIds.add(event.id)
    try {
      // Apply visible events sequentially so message chunks and artifact finalization stay ordered.
      await applyEvent(event)
      processedEventIds.add(event.id)
    } catch {
      // Artifact finalization errors are recorded by the adapter before throwing.
      // Keeping this id unprocessed lets the same visible runtime event retry.
      continue
    } finally {
      processingEventIds.delete(event.id)
    }
  }
}

const createWorkspaceRuntimeEventProcessor = (
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent
): WorkspaceRuntimeEventProcessor => {
  type EventLane = {
    acceptedEvents: Map<string, AcpRuntimeEvent>
    failedEventIds: Set<string>
    processedEventIds: Set<string>
    processingEventIds: Set<string>
    drainInFlight?: Promise<void>
    drainAgain: boolean
  }

  const unscopedEventLane = Symbol('unscoped-workspace-runtime-events')
  const eventLanes = new Map<string | symbol, EventLane>()
  let latestEvents: AcpRuntimeEvent[] = []
  let acceptedEventVersion = 0

  const getEventLaneKey = (event: AcpRuntimeEvent): string | symbol =>
    event.sessionId ?? unscopedEventLane

  const getEventLane = (laneKey: string | symbol): EventLane => {
    let lane = eventLanes.get(laneKey)
    if (!lane) {
      lane = {
        acceptedEvents: new Map<string, AcpRuntimeEvent>(),
        failedEventIds: new Set<string>(),
        processedEventIds: new Set<string>(),
        processingEventIds: new Set<string>(),
        drainAgain: false
      }
      eventLanes.set(laneKey, lane)
    }

    return lane
  }

  const cleanEventLane = (laneKey: string | symbol, lane: EventLane): void => {
    const visibleEventIds = new Set(
      latestEvents.filter((event) => getEventLaneKey(event) === laneKey).map((event) => event.id)
    )

    for (const eventId of lane.acceptedEvents.keys()) {
      if (!visibleEventIds.has(eventId) && lane.processedEventIds.has(eventId)) {
        lane.acceptedEvents.delete(eventId)
        lane.failedEventIds.delete(eventId)
        lane.processedEventIds.delete(eventId)
        lane.processingEventIds.delete(eventId)
      }
    }

    if (lane.acceptedEvents.size === 0 && !lane.drainInFlight) {
      eventLanes.delete(laneKey)
    }
  }

  const drainLane = async (laneKey: string | symbol): Promise<void> => {
    const lane = getEventLane(laneKey)

    if (lane.drainInFlight) {
      lane.drainAgain = true
      return lane.drainInFlight
    }

    lane.drainInFlight = (async () => {
      do {
        lane.drainAgain = false
        await processVisibleWorkspaceRuntimeEvents(
          [...lane.acceptedEvents.values()],
          lane.processedEventIds,
          async (event) => {
            const hadFailed = lane.failedEventIds.has(event.id)
            try {
              const applied = await applyEvent(event)
              lane.failedEventIds.delete(event.id)
              return applied
            } catch (error) {
              const isVisible = latestEvents.some(
                (candidate) => candidate.id === event.id && getEventLaneKey(candidate) === laneKey
              )
              if (hadFailed && !isVisible) {
                lane.acceptedEvents.delete(event.id)
                lane.failedEventIds.delete(event.id)
              } else {
                lane.failedEventIds.add(event.id)
              }
              throw error
            }
          },
          lane.processingEventIds
        )
      } while (lane.drainAgain)
    })()

    try {
      await lane.drainInFlight
    } finally {
      lane.drainInFlight = undefined
      cleanEventLane(laneKey, lane)
    }
  }

  return {
    process: (events) => {
      latestEvents = events
      const visibleLaneKeys = new Set<string | symbol>()

      for (const event of events) {
        const laneKey = getEventLaneKey(event)
        const lane = getEventLane(laneKey)
        visibleLaneKeys.add(laneKey)

        if (
          !lane.processedEventIds.has(event.id) &&
          !lane.processingEventIds.has(event.id) &&
          !lane.acceptedEvents.has(event.id)
        ) {
          // A bounded source snapshot may evict this event before a slow predecessor finishes.
          lane.acceptedEvents.set(event.id, event)
          acceptedEventVersion += 1
        }
      }

      for (const [laneKey, lane] of eventLanes) {
        cleanEventLane(laneKey, lane)
      }

      const drains = [...visibleLaneKeys].map((laneKey) => drainLane(laneKey))
      for (const [laneKey, lane] of eventLanes) {
        if (!visibleLaneKeys.has(laneKey) && lane.acceptedEvents.size > 0) {
          void drainLane(laneKey)
        }
      }

      return Promise.all(drains).then(() => undefined)
    },
    drain: async (sessionId) => {
      if (sessionId !== undefined) {
        if (eventLanes.has(sessionId)) await drainLane(sessionId)
        return
      }

      let drainedVersion: number
      do {
        drainedVersion = acceptedEventVersion
        await Promise.all([...eventLanes.keys()].map((laneKey) => drainLane(laneKey)))
      } while (drainedVersion !== acceptedEventVersion)
    }
  }
}

const liveWorkspaceRuntimeEventProcessor = createWorkspaceRuntimeEventProcessor()

const sessionOwnsActivePrompt = (sessionId: string, messageId: string): boolean => {
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  return session?.status === 'running' && session.activeRun?.promptMessageId === messageId
}

// Finishes the ACP session handshake for a prompt that is already visible locally.
const startPendingSessionPrompt = (
  runtime: WorkspaceMessageRuntime,
  pending: SendWorkspaceMessageResult,
  content: string,
  attachments: UploadedAttachment[],
  cwd: string | undefined,
  projectName: string | undefined,
  permissionProfile: PermissionProfileId,
  forcedSkillIds: string[] | undefined,
  referencedArtifacts: FileReference[] | undefined,
  specialistId: string | undefined,
  turnIntent: SendWorkspaceMessageInput['turnIntent'],
  historyReplay?: HistoryReplayContext,
  contextReset = false
): void => {
  void (async () => {
    if (!sessionOwnsActivePrompt(pending.sessionId, pending.messageId)) return

    let createdSession

    try {
      createdSession = await runtime.createSession(
        cwd,
        projectName,
        permissionProfile,
        specialistId
      )
    } catch (error) {
      // Unwrap the IPC wrapper so an app-authored setup failure (model-incompat / no provider / Codex
      // bridge / missing executable) is recognized by the classifier and hides the report button.
      if (sessionOwnsActivePrompt(pending.sessionId, pending.messageId)) {
        useSessionStore.getState().failRun(pending.sessionId, getCreateSessionFailureMessage(error))
      }
      return
    }

    if (!sessionOwnsActivePrompt(pending.sessionId, pending.messageId)) return

    const runtimeSessionId = createdSession?.sessionId

    if (!runtimeSessionId) {
      useSessionStore.getState().failRun(pending.sessionId, 'Agent session could not be created.')
      return
    }

    const sessionCwd = createdSession.cwd ?? cwd
    if (!sessionCwd) {
      useSessionStore
        .getState()
        .failRun(pending.sessionId, 'Agent session did not return a workspace.')
      return
    }

    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending.sessionId,
      sessionId: runtimeSessionId,
      cwd: sessionCwd,
      agentFrameworkId: createdSession.frameworkId,
      agentBackendId: createdSession.backendId,
      providerSessionId: createdSession.providerSessionId,
      providerContinuityToken: createdSession.providerContinuityToken
    })

    if (!bound) return
    if (!sessionOwnsActivePrompt(runtimeSessionId, bound.messageId)) return

    let promptAttachments = attachments

    try {
      // Pending conversations only learn their durable id after createSession completes.
      if (attachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          runtimeSessionId,
          bound.messageId,
          attachments,
          projectName
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(runtimeSessionId, getErrorMessage(error))
      return
    }

    if (!sessionOwnsActivePrompt(runtimeSessionId, bound.messageId)) return

    // Baseline the newest prompt-failure event before dispatch so the rejection path can tell this
    // turn's error event from a stale one when it derives the report affordance.
    const priorErrorEventId = latestPromptFailureEventId(runtime.state.events, runtimeSessionId)
    const sendPromptArguments = [
      runtimeSessionId,
      content,
      promptAttachments,
      forcedSkillIds,
      referencedArtifacts,
      historyReplay?.historyPreamble,
      historyReplay?.historyAttachments,
      historyReplay?.historyImages,
      undefined,
      getPromptProvenanceContext(runtimeSessionId, bound.messageId),
      contextReset
    ] as const
    const promptRequest = turnIntent
      ? runtime.sendPrompt(...sendPromptArguments, undefined, turnIntent)
      : runtime.sendPrompt(...sendPromptArguments)
    void promptRequest
      .then((snapshot) => {
        useSessionStore.getState().clearPendingContextReplay(runtimeSessionId, bound.messageId)
        return snapshot
      })
      .catch((error) => {
        // A rejected prompt surfaces as a Resume banner if the connection dropped, otherwise a
        // visible session error, instead of being swallowed as an unhandled rejection.
        // Ensure non-empty message to avoid being silently dropped by failRun's empty check.
        const errorMessage = getErrorMessage(error).trim() || 'Agent run failed'
        void failOrMarkDisconnected(runtimeSessionId, errorMessage, priorErrorEventId)
      })
  })()
}

const sendWorkspaceMessage = async (
  runtime: WorkspaceMessageRuntime,
  {
    sessionId,
    branchSourceSessionId,
    text,
    attachments = [],
    cwd,
    projectId,
    projectName,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    historyReplayDescriptor,
    forcedSkillIds,
    referencedArtifacts,
    parts,
    forceHistoryReplay,
    supportsImageInput,
    truncateFromMessageId,
    allowCompactionRecovery,
    requireExistingSession,
    specialistId,
    planContinuation,
    turnIntent
  }: SendWorkspaceMessageInput,
  onSendPreparationStateChange?: SendPreparationStateChange,
  drainRuntimeEvents?: RuntimeEventDrain
): Promise<SendWorkspaceMessageResult | undefined> => {
  const content = text.trim()
  const targetSessionId = sessionId
  const replaySession = targetSessionId
    ? useSessionStore.getState().sessions.find((session) => session.id === targetSessionId)
    : undefined
  const replayPrompt = replaySession?.pendingContextReplayMessageId
    ? replaySession.messages.find(
        (message) => message.id === replaySession.pendingContextReplayMessageId
      )
    : undefined
  const effectiveAttachments =
    attachments.length > 0 || !replayPrompt?.uploads?.length
      ? attachments
      : replayPrompt.uploads.map((upload) =>
          toRuntimeUploadedAttachment(upload, replaySession?.projectId)
        )

  // Empty drafts are allowed only when the user attached at least one file.
  if (!content && effectiveAttachments.length === 0) return undefined

  const targetCwd = cwd

  if (branchSourceSessionId) {
    // The store snapshot is the transaction boundary: it selects precisely the source active path,
    // appends the new prompt once, and makes the pending child Session visible before any async ACP work.
    const pending = useSessionStore.getState().branchInNewSession({
      sourceSessionId: branchSourceSessionId,
      content,
      attachments,
      parts,
      turnIntent,
      permissionProfile,
      agentFrameworkId,
      agentBackendId,
      agentModel,
      specialistId
    })

    if (!pending) return undefined

    const pendingSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === pending.sessionId)
    if (!pendingSession) return undefined

    // The new prompt is already in the snapshot. Replay only the copied prior path so the agent sees
    // this user request exactly once.
    let historyMessages = pendingSession.messages.filter(
      (message) => message.id !== pending.messageId
    )
    // The snapshot owns the child Session's project. Do not let a stale workspace selection route a
    // branched conversation's fresh runtime (or its replayed uploads) to a different project.
    const sessionProjectName = pendingSession.projectId
    try {
      await reconcileBranchedHistoryAttachments(
        branchSourceSessionId,
        pending.sessionId,
        historyMessages,
        sessionProjectName
      )
      const reconciledSession = useSessionStore
        .getState()
        .sessions.find((session) => session.id === pending.sessionId)
      if (!reconciledSession) return undefined
      if (!sessionOwnsActivePrompt(pending.sessionId, pending.messageId)) return pending
      historyMessages = reconciledSession.messages.filter(
        (message) => message.id !== pending.messageId
      )
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, getErrorMessage(error))
      return pending
    }
    let historyReplay: HistoryReplayContext | undefined
    try {
      historyReplay = buildWorkspaceReplay(
        historyMessages,
        historyReplayDescriptor,
        agentFrameworkId,
        sessionProjectName,
        supportsImageInput
      )
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, getErrorMessage(error))
      return pending
    }

    startPendingSessionPrompt(
      runtime,
      pending,
      content,
      attachments,
      pendingSession.cwd || targetCwd,
      sessionProjectName,
      pendingSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      forcedSkillIds,
      referencedArtifacts,
      pendingSession.specialistId,
      turnIntent,
      historyReplay,
      true
    )

    return pending
  }

  if (targetSessionId) {
    const currentSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === targetSessionId)

    if (requireExistingSession && !currentSession) return undefined

    // Runtime ownership is authoritative while native compaction or another control turn is active.
    if (
      runtime.state.promptInFlightSessionIds.includes(targetSessionId) ||
      (currentSession?.compacting && !allowCompactionRecovery) ||
      currentSession?.status === 'running' ||
      currentSession?.status === 'waiting-permission'
    ) {
      return undefined
    }

    // Existing sessions keep their own project; new/pending ones fall back to the caller's project.
    const sessionProjectName = projectName ?? currentSession?.projectId ?? projectId
    if (planContinuation && !sessionProjectName) return undefined

    if (currentSession?.isPending) {
      const retryCwd = targetCwd || currentSession.cwd || undefined
      let historyReplay: HistoryReplayContext | undefined

      if (currentSession.pendingContextReplayMessageId) {
        const historyMessages = currentSession.messages.filter(
          (message) => message.id !== currentSession.pendingContextReplayMessageId
        )
        let replay: HistoryReplayContext | undefined
        try {
          replay = buildWorkspaceReplay(
            historyMessages,
            historyReplayDescriptor,
            agentFrameworkId,
            sessionProjectName,
            supportsImageInput
          )
        } catch (error) {
          useSessionStore.getState().failRun(currentSession.id, getErrorMessage(error))
          return {
            sessionId: currentSession.id,
            messageId: currentSession.pendingContextReplayMessageId
          }
        }

        historyReplay = replay
      }

      const appended = useSessionStore.getState().appendUserMessage({
        sessionId: currentSession.id,
        content,
        attachments: effectiveAttachments,
        parts,
        turnIntent,
        cwd: retryCwd,
        projectId: projectId ?? currentSession.projectId,
        agentFrameworkId,
        agentBackendId,
        agentModel
      })

      if (!appended) return undefined

      startPendingSessionPrompt(
        runtime,
        appended,
        content,
        effectiveAttachments,
        retryCwd,
        sessionProjectName,
        currentSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        forcedSkillIds,
        referencedArtifacts,
        currentSession.pendingContextReplayMessageId ? currentSession.specialistId : undefined,
        turnIntent,
        historyReplay,
        Boolean(currentSession.pendingContextReplayMessageId)
      )
      return appended
    }

    // A framework/backend selection change takes effect at this turn boundary. A retired generation
    // may still expose the old session briefly, so persisted ownership participates in this decision.
    const frameworkChanged = Boolean(
      agentFrameworkId &&
      currentSession?.agentFrameworkId &&
      agentFrameworkId !== currentSession.agentFrameworkId
    )
    const backendChanged = Boolean(
      agentBackendId &&
      currentSession?.agentBackendId &&
      agentBackendId !== currentSession.agentBackendId
    )
    const selectedRuntimeChanged = frameworkChanged || backendChanged
    const runtimeDetached = !runtime.state.sessionIds.includes(targetSessionId)
    const runtimeMustAdoptSession = selectedRuntimeChanged || runtimeDetached
    const branchResetRequired = Boolean(
      truncateFromMessageId || currentSession?.branchContextResetRequired
    )
    const resumeNeedsImageFiltering =
      runtimeMustAdoptSession &&
      supportsImageInput === false &&
      hasHistoryImages(currentSession?.messages ?? [])
    const sendPreparationRequired = branchResetRequired || runtimeMustAdoptSession

    if (sendPreparationRequired) {
      if (sessionSendPreparationsInFlight.has(targetSessionId)) return undefined
      sessionSendPreparationsInFlight.add(targetSessionId)
      onSendPreparationStateChange?.(targetSessionId, true)
    }

    // Branch activation changes only the durable projection. Before the first continuation, drop
    // Notebook context and guarantee a fresh Agent context. A selected-runtime change must adopt first
    // so any required reset executes on the new owner. Only an already-attached selected runtime can
    // reset directly; detached sessions adopt first so a stale coordinator owner cannot receive it.
    let branchContextResetPerformed = false
    let agentContextResetPerformed = false
    let shouldResumeSession = false
    let contextResetFromResume = false

    // A specialist switch on Claude replaced the agent session on the main side (identity is baked
    // into session _meta at creation). The runtime already adopted a fresh session, so here we only
    // need to replay prior turns as a history preamble — no resetSessionContext, no notebook shutdown.
    const specialistSwitchReplay = Boolean(currentSession?.specialistSwitchResetRequired)
    if (specialistSwitchReplay) {
      useSessionStore.getState().clearSpecialistSwitchResetRequired(targetSessionId)
    }

    try {
      if (branchResetRequired) {
        const resetCwd = targetCwd || currentSession?.cwd || runtime.state.cwd
        if (!resetCwd) {
          useSessionStore.getState().failRun(targetSessionId, RESUME_WORKSPACE_MISSING_MESSAGE)
          return undefined
        }

        await shutdownNotebookForBranchChange(targetSessionId, resetCwd, sessionProjectName)
        if (!selectedRuntimeChanged && !runtimeDetached) {
          const reset = await runtime.resetSessionContext(
            targetSessionId,
            resetCwd,
            sessionProjectName,
            currentSession?.permissionProfile ?? permissionProfile
          )
          useSessionStore.getState().markResumed(
            targetSessionId,
            reset
              ? {
                  agentFrameworkId: reset.frameworkId,
                  agentBackendId: reset.backendId,
                  providerSessionId: reset.providerSessionId,
                  providerContinuityToken: reset.providerContinuityToken
                }
              : undefined
          )
          agentContextResetPerformed = true
        }
        branchContextResetPerformed = true
      }

      shouldResumeSession = !agentContextResetPerformed && runtimeMustAdoptSession
      if (shouldResumeSession) {
        // Empty string is treated as missing; fall back to runtime cwd.
        const resumeCwd = targetCwd || runtime.state.cwd
        if (!resumeCwd) {
          useSessionStore.getState().failRun(targetSessionId, RESUME_WORKSPACE_MISSING_MESSAGE)
          return undefined
        }

        const resumeResult = await runtime.resumeSession(
          targetSessionId,
          resumeCwd,
          sessionProjectName,
          currentSession?.permissionProfile ?? permissionProfile,
          currentSession?.agentFrameworkId,
          currentSession?.agentBackendId,
          currentSession?.specialistId,
          currentSession?.providerSessionId,
          currentSession?.providerContinuityToken
        )

        contextResetFromResume = Boolean(resumeResult?.contextReset)
        useSessionStore.getState().markResumed(
          targetSessionId,
          resumeResult
            ? {
                agentFrameworkId: resumeResult.frameworkId,
                agentBackendId: resumeResult.backendId,
                providerSessionId: resumeResult.providerSessionId,
                providerContinuityToken: resumeResult.providerContinuityToken
              }
            : undefined
        )

        // A provider may resume an existing selected-runtime session without resetting its hidden
        // history. Branch isolation and text-only models both require a fresh context in that case.
        if ((branchContextResetPerformed || resumeNeedsImageFiltering) && !contextResetFromResume) {
          const reset = await runtime.resetSessionContext(
            targetSessionId,
            resumeCwd,
            sessionProjectName,
            currentSession?.permissionProfile ?? permissionProfile
          )
          useSessionStore.getState().markResumed(
            targetSessionId,
            reset
              ? {
                  agentFrameworkId: reset.frameworkId,
                  agentBackendId: reset.backendId,
                  providerSessionId: reset.providerSessionId,
                  providerContinuityToken: reset.providerContinuityToken
                }
              : undefined
          )
          contextResetFromResume = true
        }

        // The coordinator waits for the prior owner to stop before committing adoption, but its
        // retained events still cross the asynchronous renderer bridge. Apply the latest accepted
        // snapshot before opening the new optimistic run so a terminal event cannot settle that run.
        await drainRuntimeEvents?.(targetSessionId)
      }
    } catch (error) {
      useSessionStore.getState().failRun(targetSessionId, getResumeFailureMessage(error))
      return undefined
    } finally {
      if (sendPreparationRequired) {
        sessionSendPreparationsInFlight.delete(targetSessionId)
        onSendPreparationStateChange?.(targetSessionId, false)
      }
    }

    const preparedSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === targetSessionId)
    // Preparation crosses async runtime and notebook boundaries. Deletion or hydration may remove the
    // target meanwhile; never let the generic append seam recreate that stale existing-session id.
    if ((currentSession || requireExistingSession) && !preparedSession) return undefined

    // An edited resend replays only the retained Branch prefix.
    const historyCutMessageId = truncateFromMessageId
    const historyCutIndex =
      historyCutMessageId && preparedSession
        ? preparedSession.messages.findIndex((message) => message.id === historyCutMessageId)
        : -1
    if (truncateFromMessageId && historyCutIndex < 0) return undefined
    const pendingHistoryReplay = preparedSession?.pendingHistoryReplay
    const resumeReplayCutMessageId =
      pendingHistoryReplay?.kind === 'before-message' ? pendingHistoryReplay.messageId : undefined
    const resumeReplayCutIndex =
      resumeReplayCutMessageId && preparedSession
        ? preparedSession.messages.findIndex((message) => message.id === resumeReplayCutMessageId)
        : -1
    // A Branch switch can remove the interrupted prompt named by the recovery cutoff. In that case
    // replay the selected Branch in full; keep the marker until prompt acceptance so a failed send
    // remains retryable and switching back can still apply the original cutoff.
    const historyMessages = (
      preparedSession && historyCutIndex >= 0
        ? preparedSession.messages.slice(0, historyCutIndex)
        : preparedSession && resumeReplayCutIndex >= 0
          ? preparedSession.messages.slice(0, resumeReplayCutIndex)
          : preparedSession?.messages
    )?.filter((message) => message.id !== preparedSession?.pendingContextReplayMessageId)

    // Resume before creating the optimistic run. A draining runtime can emit its terminal event while
    // adoption is in flight; keeping the old Runtime Segment active until resume succeeds lets that
    // event settle the prior turn instead of accidentally finishing the incoming prompt.
    let historyPreamble: string | undefined
    let historyAttachments: UploadedAttachment[] | undefined
    let historyImages: AcpMessageImage[] | undefined

    if (truncateFromMessageId) {
      useSessionStore.getState().truncateSessionFromMessage(targetSessionId, truncateFromMessageId)
    }

    const appended = useSessionStore.getState().appendUserMessage({
      sessionId: targetSessionId,
      content,
      attachments: effectiveAttachments,
      parts,
      turnIntent,
      cwd: targetCwd,
      projectId: projectId ?? preparedSession?.projectId,
      // Bind the optimistic prompt to the selected Runtime Segment only when this send adopted
      // that runtime. A local Branch reset otherwise continues on the current owner.
      agentFrameworkId: shouldResumeSession ? agentFrameworkId : preparedSession?.agentFrameworkId,
      agentBackendId: shouldResumeSession ? agentBackendId : preparedSession?.agentBackendId,
      agentModel
    })

    // appendUserMessage can reject stale session ids after local deletion or hydration changes.
    if (!appended) return undefined

    // Replay prior turns only after an intentional context replacement. historyMessages ends before
    // the newly appended user message, so the turn being sent is never duplicated into its preamble.
    if (
      (branchContextResetPerformed ||
        contextResetFromResume ||
        forceHistoryReplay ||
        specialistSwitchReplay ||
        preparedSession?.pendingContextReplayMessageId ||
        pendingHistoryReplay) &&
      historyMessages
    ) {
      const replay = buildWorkspaceReplay(
        historyMessages,
        historyReplayDescriptor,
        agentFrameworkId,
        sessionProjectName,
        supportsImageInput
      )
      historyPreamble = replay?.historyPreamble
      historyAttachments = replayAttachmentsForModel(replay, supportsImageInput)
      historyImages = supportsImageInput === false ? undefined : replay?.historyImages
    }

    const resumeFallback =
      forcedSkillIds && forcedSkillIds.length > 0 && historyMessages
        ? (() => {
            const replay = buildWorkspaceReplay(
              historyMessages,
              historyReplayDescriptor,
              agentFrameworkId,
              sessionProjectName,
              supportsImageInput
            )
            return {
              historyPreamble: replay?.historyPreamble,
              historyAttachments: replayAttachmentsForModel(replay, supportsImageInput),
              historyImages: supportsImageInput === false ? undefined : replay?.historyImages
            }
          })()
        : undefined
    const contextReset = Boolean(
      branchContextResetPerformed ||
      contextResetFromResume ||
      forceHistoryReplay ||
      specialistSwitchReplay ||
      preparedSession?.pendingContextReplayMessageId ||
      pendingHistoryReplay
    )

    let promptAttachments = effectiveAttachments

    try {
      // Existing sessions can finalize immediately because their durable id is already known.
      if (effectiveAttachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          targetSessionId,
          appended.messageId,
          effectiveAttachments,
          sessionProjectName
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(targetSessionId, getErrorMessage(error))
      return appended
    }

    // Baseline the newest prior failure event so the rejection path can tell this turn's error event
    // (carrying the providerError tag) from a stale one left by an earlier turn.
    const priorErrorEventId = latestPromptFailureEventId(runtime.state.events, targetSessionId)

    // The hook returns after local state is updated; event listeners handle the streamed result.
    const sendPromptArguments = [
      targetSessionId,
      content,
      promptAttachments,
      forcedSkillIds,
      referencedArtifacts,
      historyPreamble,
      historyAttachments,
      historyImages,
      resumeFallback,
      getPromptProvenanceContext(targetSessionId, appended.messageId),
      contextReset
    ] as const
    const continuation = planContinuation
      ? {
          projectId: sessionProjectName!,
          artifactVersionId: planContinuation.artifactVersionId,
          expectedRevision: planContinuation.revision,
          ...(planContinuation.pendingAction
            ? { pendingAction: planContinuation.pendingAction }
            : {})
        }
      : undefined
    const promptRequest = turnIntent
      ? runtime.sendPrompt(...sendPromptArguments, continuation, turnIntent)
      : continuation
        ? runtime.sendPrompt(...sendPromptArguments, continuation)
        : runtime.sendPrompt(...sendPromptArguments)

    void promptRequest
      .then((snapshot) => {
        if (branchContextResetPerformed) {
          useSessionStore.getState().clearBranchContextReset(targetSessionId)
        }
        if (preparedSession?.pendingContextReplayMessageId) {
          useSessionStore.getState().clearPendingContextReplay(targetSessionId, appended.messageId)
        }
        if (pendingHistoryReplay) {
          useSessionStore
            .getState()
            .clearPendingHistoryReplay(targetSessionId, pendingHistoryReplay)
        }
        return snapshot
      })
      .catch((error) => {
        // A rejected prompt surfaces as a Resume banner if the connection dropped, otherwise a
        // visible session error, instead of being swallowed as an unhandled rejection.
        // Ensure non-empty message to avoid being silently dropped by failRun's empty check.
        const errorMessage = getErrorMessage(error).trim() || 'Agent run failed'
        void failOrMarkDisconnected(targetSessionId, errorMessage, priorErrorEventId)
      })

    return appended
  }

  const pending = useSessionStore.getState().appendPendingUserMessage({
    content,
    attachments,
    parts,
    turnIntent,
    cwd: targetCwd,
    projectId,
    permissionProfile,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    specialistId: specialistId ?? undefined
  })

  if (!pending) return undefined

  // The visible prompt is already local; ACP creation finishes the session binding later.
  startPendingSessionPrompt(
    runtime,
    pending,
    content,
    attachments,
    targetCwd,
    projectName,
    permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    forcedSkillIds,
    referencedArtifacts,
    specialistId ?? undefined,
    turnIntent
  )

  return pending
}

// Finds the unanswered user turn used only by the explicit context-overflow retry workflow. Session
// Resume identifies its turn from the durable resumeRecovery marker instead.
const findUnansweredUserTurn = (messages: ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]

    if (message.role !== 'user') continue

    const hasSuccessfulReply = messages
      .slice(index + 1)
      .some((later) => later.role === 'agent' && later.status !== 'error')

    return hasSuccessfulReply ? undefined : message
  }

  return undefined
}

// removeMessage creates an abandoned Branch before retry. If preparation fails before the shared send
// appends a replacement prompt, restore the exact transcript/graph projection while preserving newer
// runtime metadata and the failure recorded on the live session.
const restoreRemovedTurnProjection = (sessionBeforeRemoval: ChatSession): void => {
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== sessionBeforeRemoval.id) return session

      return {
        ...session,
        messages: sessionBeforeRemoval.messages,
        conversationGraph: sessionBeforeRemoval.conversationGraph,
        filesRevision: sessionBeforeRemoval.filesRevision,
        updatedAt: Date.now()
      }
    })
  }))
}

// A context reset replaces the provider session without changing the stable application session id.
// Store the replacement identity immediately so cancellation or restart cannot revive the old owner.
const replaceWorkspaceProviderIdentity = (
  sessionId: string,
  replacement: AcpCreateSessionResponse
): void => {
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            agentFrameworkId: replacement.frameworkId ?? session.agentFrameworkId,
            agentBackendId: replacement.backendId ?? session.agentBackendId,
            providerSessionId: replacement.providerSessionId,
            providerContinuityToken: replacement.providerContinuityToken,
            updatedAt: Date.now()
          }
        : session
    )
  }))
}

const continueInterruptedWorkspaceTurn = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  promptMessageId: string,
  contextReset: boolean,
  options?: ResumeInterruptedWorkspaceSessionOptions,
  update?: Parameters<
    ReturnType<typeof useSessionStore.getState>['prepareInterruptedTurnContinuation']
  >[2]
): Promise<boolean> => {
  const prepared = useSessionStore
    .getState()
    .prepareInterruptedTurnContinuation(sessionId, promptMessageId, update, contextReset)
  if (!prepared) return false

  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  if (!session?.projectId) throw new Error('Interrupted Session project is unavailable.')
  if (contextReset && !prepared.runtimeSegmentId) {
    throw new Error('Interrupted Session Runtime Segment could not be created.')
  }

  // Persist the recovery marker, original prompt, and any fresh Runtime Segment before Main reads
  // them. If the app exits before provider acceptance, the same recovery remains retryable.
  await (options?.flushPersistence ?? flushSessionPersistence)()
  if (!runtime.continueInterruptedTurn) {
    throw new Error('Interrupted turn continuation is not available.')
  }
  await runtime.continueInterruptedTurn({
    sessionId,
    projectId: session.projectId,
    promptMessageId,
    ...(contextReset && prepared.runtimeSegmentId
      ? {
          contextReset: {
            runtimeSegmentId: prepared.runtimeSegmentId,
            historyReplayTarget:
              options?.historyReplayDescriptor?.target ??
              resolveHistoryReplayTarget(session.agentFrameworkId),
            ...(options?.historyReplayDescriptor?.contextWindow
              ? { contextWindow: options.historyReplayDescriptor.contextWindow }
              : {}),
            ...(options?.supportsImageInput === undefined
              ? {}
              : { supportsImageInput: options.supportsImageInput })
          }
        }
      : {})
  })
  useSessionStore.getState().completeInterruptedTurnResume(sessionId)
  return true
}

// Re-attaches an interrupted Session and resumes its existing user turn with a hidden continuation
// prompt. On failure the interrupted banner stays so a retry remains possible.
const resumeInterruptedWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  drainRuntimeEvents?: RuntimeEventDrain,
  options?: ResumeInterruptedWorkspaceSessionOptions
): Promise<void> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)

  if (!session) return

  const runtimeAlreadyAttached = runtime.state.sessionIds.includes(sessionId)
  const promptMessageId = session.resumeRecovery?.promptMessageId

  if (runtimeAlreadyAttached) {
    try {
      await drainRuntimeEvents?.(sessionId)
      if (promptMessageId) {
        if (
          !(await continueInterruptedWorkspaceTurn(
            runtime,
            sessionId,
            promptMessageId,
            session.pendingHistoryReplay !== undefined,
            options
          ))
        ) {
          useSessionStore.getState().markResumed(sessionId)
        }
      } else {
        useSessionStore.getState().markResumed(sessionId)
      }
    } catch (error) {
      useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
    }
    return
  }

  // Empty string is treated as missing; fall back to runtime cwd
  const resumeCwd = session.cwd || runtime.state.cwd

  if (!resumeCwd) {
    useSessionStore.getState().failRun(sessionId, RESUME_WORKSPACE_MISSING_MESSAGE)
    return
  }

  try {
    const resumeResult = await runtime.resumeSession(
      sessionId,
      resumeCwd,
      session.projectId,
      session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      session.agentFrameworkId,
      session.agentBackendId,
      session.specialistId,
      session.providerSessionId,
      session.providerContinuityToken
    )
    // Ownership transfer is complete in the coordinator, but accepted events from the previous
    // runtime generation can still be queued in the renderer. Drain them before starting the
    // continuation so a stale terminal event cannot settle the recovered turn.
    await drainRuntimeEvents?.(sessionId)
    const providerUpdate = resumeResult
      ? {
          agentFrameworkId: resumeResult.frameworkId,
          agentBackendId: resumeResult.backendId,
          providerSessionId: resumeResult.providerSessionId,
          providerContinuityToken: resumeResult.providerContinuityToken
        }
      : undefined
    if (promptMessageId) {
      const continued = await continueInterruptedWorkspaceTurn(
        runtime,
        sessionId,
        promptMessageId,
        Boolean(resumeResult?.contextReset || session.pendingHistoryReplay),
        options,
        providerUpdate
      )
      if (!continued) {
        useSessionStore.getState().markResumed(
          sessionId,
          providerUpdate
            ? {
                ...providerUpdate,
                pendingHistoryReplay: resumeResult?.contextReset ? { kind: 'all' } : undefined
              }
            : undefined
        )
      }
    } else {
      useSessionStore.getState().markResumed(
        sessionId,
        providerUpdate
          ? {
              ...providerUpdate,
              pendingHistoryReplay: resumeResult?.contextReset ? { kind: 'all' } : undefined
            }
          : undefined
      )
    }
  } catch (error) {
    useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
  }
}

// After an auto-recovery, ignore further overflow events for this session for a short window so a retry
// that immediately overflows again falls through to a visible error instead of looping. Prevention (the
// per-session inline-image budget) makes a second overflow unlikely, so this is a backstop, not the norm.
const CONTEXT_OVERFLOW_RECOVERY_COOLDOWN_MS = 15_000

// Invokes native compaction only when the runtime snapshot explicitly advertises it for the attached
// session. This capability gate keeps renderer callers independent of framework ids and command syntax.
const compactWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string
): Promise<boolean> => {
  if (
    runtime.compactSession === undefined ||
    runtime.state.nativeContextCompactionSessionIds?.includes(sessionId) !== true
  ) {
    return false
  }

  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
  if (
    !session ||
    session.status !== 'idle' ||
    session.compacting ||
    session.activeRun ||
    runtime.state.promptInFlightSessionIds.includes(sessionId)
  ) {
    return false
  }

  // Acquire the renderer gate synchronously so a second click or fast submit cannot append transcript
  // state before the main-process compaction event/snapshot completes its IPC round trip.
  useSessionStore.getState().beginCompaction(sessionId)

  try {
    const snapshot = await runtime.compactSession(sessionId)
    if (snapshot) return true

    // IPC helpers convert transport failures to an undefined snapshot. Record a session-scoped
    // failure before releasing the local gate so a late main-process event cannot be the only path
    // to a visible error.
    useSessionStore.getState().failCompaction(sessionId, 'Context compaction failed.')
    return false
  } catch (error) {
    useSessionStore
      .getState()
      .failCompaction(sessionId, getErrorMessage(error).trim() || 'Context compaction failed.')
    return false
  } finally {
    // Terminal events normally settle this first. This is also the transport-failure safety net when
    // no compaction event reaches the renderer.
    useSessionStore.getState().finishCompaction(sessionId)
  }
}

// Auto-recovers a conversation whose request outgrew the provider limit. Native-capable frameworks
// compact their attached session first and keep ownership of the summary; older/managed frameworks fall
// back to replacing the agent session and replaying a bounded text transcript. The unanswered turn is
// then retried exactly once. Returns false when there is nothing to recover or both recovery paths fail.
const recoverContextOverflowWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  supportsImageInput?: boolean,
  cancelledSessionIds?: Set<string>,
  historyReplayDescriptor?: HistoryReplayDescriptor,
  planContinuation?: SendWorkspaceMessageInput['planContinuation']
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)

  if (!session) return false

  // Empty string is treated as missing; fall back to runtime cwd
  const resumeCwd = session.cwd || runtime.state.cwd

  if (!resumeCwd) return false

  // The unanswered user turn is what we re-send; if the last turn already got a reply there is nothing
  // to retry (a stray late overflow event), so bail before disturbing the agent session.
  const interruptedTurn = findUnansweredUserTurn(session.messages)

  if (!interruptedTurn) return false

  // Flip to the neutral compacting state up front so the UI never shows the raw overflow error while the
  // reset round-trip is in flight (idempotent with the event-path beginCompaction).
  useSessionStore.getState().beginCompaction(sessionId, { supersedeActiveRun: true })
  const isCompactionStillActive = (): boolean =>
    useSessionStore.getState().sessions.find((item) => item.id === sessionId)?.compacting === true
  const finishCancelledRecovery = (): boolean => {
    if (cancelledSessionIds?.delete(sessionId) !== true) return false
    useSessionStore.getState().finishCompaction(sessionId)
    return true
  }

  const supportsNativeCompaction =
    runtime.state.nativeContextCompactionSessionIds?.includes(sessionId) === true &&
    runtime.compactSession !== undefined
  let nativeCompacted = false
  let postRecoveryState: WorkspaceMessageRuntime['state'] | undefined

  if (supportsNativeCompaction) {
    try {
      postRecoveryState = await runtime.compactSession?.(sessionId, 'overflow-recovery')
      nativeCompacted = Boolean(postRecoveryState)
    } catch {
      // Fall through to the replacement+replay safety net below.
    }

    // Cancellation intent is consumed only after the native control turn actually stops, keeping the
    // composer locked between the cancel acknowledgement and the terminal response.
    if (finishCancelledRecovery()) return false
    // Disconnect handling clears the local compacting state. Respect that terminal transition instead
    // of turning a dropped native control turn into reset-and-replay.
    if (!isCompactionStillActive()) return false
  }

  if (!nativeCompacted) {
    try {
      const replacement = await runtime.resetSessionContext(
        sessionId,
        resumeCwd,
        session.projectId,
        session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
      )
      replaceWorkspaceProviderIdentity(sessionId, replacement)
      const remainingPromptInFlightSessionIds = runtime.state.promptInFlightSessionIds.filter(
        (id) => id !== sessionId
      )
      // resetSessionContext returns session metadata rather than a runtime snapshot. Its terminal
      // response nevertheless releases this session's operation lease, so project that fact into the
      // stale event snapshot retained by this recovery task before applying the authoritative guard.
      postRecoveryState = {
        ...runtime.state,
        promptInFlight: remainingPromptInFlightSessionIds.length > 0,
        promptInFlightSessionIds: remainingPromptInFlightSessionIds
      }
    } catch (error) {
      if (finishCancelledRecovery()) return false
      if (!isCompactionStillActive()) return false
      useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
      return false
    }
  }

  // A user can cancel while the reset request is in flight. The fresh context may already exist, but
  // cancellation still owns the UI decision: leave the unanswered turn intact and do not resend it.
  if (finishCancelledRecovery()) return false
  if (!isCompactionStillActive()) return false

  const retryRuntime = { ...runtime, state: postRecoveryState ?? runtime.state }
  // Do not mutate the transcript unless the terminal compaction/reset response confirms that the
  // runtime released this session. This protects against an adapter returning a premature snapshot.
  if (retryRuntime.state.promptInFlightSessionIds.includes(sessionId)) return false

  // Drop the unanswered turn so the re-send does not duplicate the bubble; the remaining prior turns are
  // replayed as a text preamble via forceHistoryReplay (session.messages was captured before removal).
  useSessionStore.getState().removeMessage(sessionId, interruptedTurn.id)

  // Captured provenance proves that the interrupted turn was explicitly authorized. Durable status
  // updates may have advanced the revision since admission, so refresh only the matching approved
  // Artifact Version and strip the one-shot pending decision before retrying.
  const activePlan = useSessionStore
    .getState()
    .sessions.find((item) => item.id === sessionId)?.activePlanProjection
  const retryPlanContinuation =
    planContinuation &&
    activePlan?.artifactVersionId === planContinuation.artifactVersionId &&
    activePlan.approval === 'approved' &&
    !['completed', 'rejected'].includes(activePlan.lifecycle)
      ? {
          artifactVersionId: activePlan.artifactVersionId,
          revision: activePlan.revision
        }
      : planContinuation

  const retried = await sendWorkspaceMessage(retryRuntime, {
    sessionId,
    text: interruptedTurn.content,
    attachments: (interruptedTurn.uploads ?? []).map((upload) =>
      toRuntimeUploadedAttachment(upload, session.projectId)
    ),
    parts: interruptedTurn.parts,
    cwd: resumeCwd,
    projectId: session.projectId,
    permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    // Native compaction retained its own framework-authored summary. Only a replacement session needs
    // OpenScience to replay the prior transcript into its first prompt.
    forceHistoryReplay: !nativeCompacted,
    allowCompactionRecovery: true,
    supportsImageInput,
    agentModel: session.agentModel,
    historyReplayDescriptor,
    ...(retryPlanContinuation ? { planContinuation: retryPlanContinuation } : {})
  })

  if (!retried) restoreRemovedTurnProjection(session)

  return Boolean(retried)
}

// Cancels the active agent interaction. A successful compaction cancellation also settles the local
// neutral state immediately; overflow recovery observes that transition and does not reset or retry.
const cancelWorkspaceRun = async (
  runtime: WorkspaceCancellationRuntime,
  sessionId: string,
  cancelledSessionIds?: Set<string>
): Promise<void> => {
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  // Pending Sessions have no ACP identity yet. Settle their local run immediately; every startup
  // await revalidates activeRun before it may create, bind, or prompt a runtime Session.
  if (session?.isPending) {
    useSessionStore.getState().finishRun(sessionId, undefined, session.activeRun?.promptMessageId)
    return
  }

  const wasCompacting = session?.compacting === true
  if (wasCompacting) cancelledSessionIds?.add(sessionId)
  const snapshot = await runtime.cancel(sessionId)

  if (!snapshot) {
    cancelledSessionIds?.delete(sessionId)
    useSessionStore.getState().failRun(sessionId, 'Agent cancellation failed')
  }
}

// Resends an inline-edited prompt by forking the conversation at the edited message. The active
// projection switches optimistically while the original downstream Branch remains durable; the
// adjusted prompt's bubble is applied and the run is marked, so the waiting
// indicator shows immediately, like a composer send — then the agent session is reset (ACP has no
// history truncation) and the kept turns are replayed as a text preamble on the resent prompt. A
// failed reset rolls the transcript back so nothing is lost. Returns false when the flow cannot
// start or the reset fails.
const resendEditedWorkspaceMessage = async (
  runtime: WorkspaceMessageRuntime,
  input: ResendEditedMessageInput & { sessionId: string; messageId: string },
  {
    supportsImageInput,
    agentFrameworkId,
    agentBackendId,
    agentModel,
    historyReplayDescriptor,
    onSendPreparationStateChange,
    drainRuntimeEvents
  }: ResendEditedWorkspaceMessageOptions = {}
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)

  if (!session) return false

  const resumeCwd = session.cwd || runtime.state.cwd
  const content = input.text.trim()
  const cutIndex = session.messages.findIndex((message) => message.id === input.messageId)

  if (
    !resumeCwd ||
    !content ||
    cutIndex < 0 ||
    runtime.state.promptInFlightSessionIds.includes(input.sessionId)
  ) {
    return false
  }

  const resent = await sendWorkspaceMessage(
    runtime,
    {
      sessionId: input.sessionId,
      text: content,
      attachments: [],
      parts: input.parts,
      cwd: resumeCwd,
      projectId: session.projectId,
      permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      forcedSkillIds: input.forcedSkillIds,
      referencedArtifacts: input.referencedArtifacts,
      agentFrameworkId,
      agentBackendId,
      agentModel,
      historyReplayDescriptor,
      // Reset/adopt while the old Branch remains visible, then replace it only after preparation.
      truncateFromMessageId: input.messageId,
      supportsImageInput
    },
    onSendPreparationStateChange,
    drainRuntimeEvents
  )

  return Boolean(resent)
}

// Scans runtime error events for the request-size overflow and triggers one auto-recovery per event.
// handledEventIds dedups across the repeated event snapshots a bounded window re-delivers; the recovery
// runs only for attached sessions (a detached one uses the normal Resume path) and only once per cooldown.
const processContextOverflowRecovery = (
  runtime: WorkspaceMessageRuntime,
  events: AcpRuntimeEvent[],
  handledEventIds: Set<string>,
  recoveryCooldownSessionIds: Set<string>,
  activeRecoverySessionIds: Set<string>,
  recover: (
    runtime: WorkspaceMessageRuntime,
    sessionId: string
  ) => Promise<boolean> = recoverContextOverflowWorkspaceSession
): void => {
  for (const event of events) {
    if (handledEventIds.has(event.id)) continue
    if (event.kind !== 'error' || !event.sessionId) continue

    // Prefer the runtime's explicit marker; fall back to matching the message so an unmarked overflow
    // (older event, or a path that didn't tag it) is still recovered.
    const isOverflow =
      event.recoverable === 'context-overflow' ||
      isMediaOverflowError(event.text) ||
      isMediaOverflowError(event.title)

    if (!isOverflow) continue

    handledEventIds.add(event.id)

    const { sessionId } = event

    if (!runtime.state.sessionIds.includes(sessionId)) continue
    if (recoveryCooldownSessionIds.has(sessionId)) continue

    recoveryCooldownSessionIds.add(sessionId)
    activeRecoverySessionIds.add(sessionId)
    void recover(runtime, sessionId).finally(() => {
      activeRecoverySessionIds.delete(sessionId)
      setTimeout(
        () => recoveryCooldownSessionIds.delete(sessionId),
        CONTEXT_OVERFLOW_RECOVERY_COOLDOWN_MS
      )
    })
  }

  // Forget ids that fell out of the bounded runtime event window so the set cannot grow unbounded.
  const visibleIds = new Set(events.map((event) => event.id))

  for (const id of handledEventIds) {
    if (!visibleIds.has(id)) handledEventIds.delete(id)
  }
}

// Flags sessions with an active prompt or native compaction as disconnected on a TRANSITION into a
// dropped connection state. Abnormal drops (agent crash / gateway drop) go through main's
// handleConnectionClosed → status 'closed'; deliberate mid-prompt disconnects use disconnect(false)
// (no 'closed' emit) and idle provider/skills reconnects have no active interaction, so neither reaches
// markDisconnected here.
const markRunningSessionsDisconnectedOnDrop = (
  previousStatus: AcpConnectionStatus,
  currentStatus: AcpConnectionStatus,
  previousSessionStatuses: Partial<Record<string, AcpConnectionStatus>> = {},
  currentSessionStatuses: Partial<Record<string, AcpConnectionStatus>> = {}
): void => {
  const { sessions, markDisconnected } = useSessionStore.getState()

  for (const session of sessions) {
    if (
      session.status !== 'running' &&
      session.status !== 'waiting-permission' &&
      !session.compacting
    ) {
      continue
    }

    const previousOwnedStatus = previousSessionStatuses[session.id]
    const currentOwnedStatus = currentSessionStatuses[session.id]
    const hasOwningRuntimeStatus =
      previousOwnedStatus !== undefined || currentOwnedStatus !== undefined
    const previous = hasOwningRuntimeStatus
      ? (previousOwnedStatus ?? currentOwnedStatus ?? previousStatus)
      : previousStatus
    const current = hasOwningRuntimeStatus
      ? (currentOwnedStatus ?? previousOwnedStatus ?? currentStatus)
      : currentStatus
    const droppedNow =
      (current === 'closed' || current === 'error') && previous !== 'closed' && previous !== 'error'

    if (droppedNow) markDisconnected(session.id)
  }
}

// Copies live context usage into the durable Session. Missing usage clears only attached sessions,
// preserving the last snapshot for detached sessions while invalidating replaced runtime contexts.
const syncWorkspaceContextUsage = (
  sessionIds: readonly string[],
  contextUsageBySession: Record<string, AcpContextUsage>
): void => {
  const { setContextUsage } = useSessionStore.getState()
  for (const sessionId of sessionIds) {
    setContextUsage(sessionId, contextUsageBySession[sessionId])
  }
}

const drainWorkspaceRuntimeEventsForPersistence = async (sessionId?: string): Promise<void> => {
  const snapshot = await window.api.acp.getState()
  void liveWorkspaceRuntimeEventProcessor.process(snapshot.events)
  await liveWorkspaceRuntimeEventProcessor.drain(sessionId)
  syncWorkspaceContextUsage(snapshot.sessionIds, snapshot.contextUsageBySession)
}

// Deletes in three ordered ownership layers: agent runtime, durable JSON/DB coordinator, then renderer
// state. A failure in either authoritative layer leaves the session visible with an actionable error.
const deleteWorkspaceSession = async (
  runtime: WorkspaceDeletionRuntime,
  sessionId: string,
  persistDeletion: PersistSessionDeletion = window.api.sessions.deleteSession
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session?.projectId) return false

  const snapshot = await runtime.deleteSession(sessionId)
  if (!snapshot || snapshot.sessionIds.includes(sessionId)) {
    useSessionStore.getState().failRun(sessionId, 'Agent session deletion failed')
    return false
  }

  try {
    await persistDeletion({ projectId: session.projectId, sessionId })
  } catch (error) {
    useSessionStore
      .getState()
      .failRun(sessionId, `Session deletion failed: ${getErrorMessage(error)}`)
    throw error
  }

  useSessionStore.getState().deleteSession(sessionId)
  return true
}

const useWorkspaceAgentRuntime = (): {
  actionError: string | null
  isConnecting: boolean
  pendingPermissions: AcpPermissionRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  permissionGrants: Record<string, AcpPermissionGrant[]>
  contextUsageBySession: Record<string, AcpContextUsage>
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  nativeContextCompactionSessionIds: string[]
  compactContext: (sessionId: string) => Promise<boolean>
  sendMessage: (input: SendWorkspaceMessageInput) => Promise<SendWorkspaceMessageResult | undefined>
  resendEditedMessage: (
    sessionId: string,
    messageId: string,
    input: ResendEditedMessageInput
  ) => Promise<boolean>
  cancelRun: (sessionId: string) => Promise<void>
  resumeInterruptedSession: (sessionId: string) => Promise<void>
  deleteRuntimeSession: (sessionId: string) => Promise<boolean>
  respondToPermission: (requestId: string, optionId?: string) => Promise<void>
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => Promise<boolean>
  revokePermissionGrant: (sessionId: string, categoryKey: string) => Promise<void>
} => {
  const runtime = useAcpRuntime()
  const activeProvider = useSettingsStore((state) =>
    state.providers.find((candidate) => candidate.id === state.activeProviderId)
  )
  const supportsImageInput = activeProvider?.supportsImageInput ?? false
  const activeModel = useSettingsStore((state) => state.activeModel)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFramework = useSettingsStore((state) =>
    state.agentFrameworks.find((candidate) => candidate.id === state.agentFrameworkId)
  )
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const agentBackendId = activeProviderId ? `${agentFrameworkId}:${activeProviderId}` : undefined
  const historyReplayDescriptor = useMemo<HistoryReplayDescriptor>(
    () => ({
      target: resolveHistoryReplayTarget(agentFrameworkId, activeProvider, agentFramework),
      contextWindow: activeProvider?.vendorId
        ? resolveModelContextWindow(
            activeProvider.vendorId,
            activeModel ?? activeProvider.model ?? activeProvider.models[0]
          )
        : activeProvider?.contextWindow
    }),
    [activeModel, activeProvider, agentFramework, agentFrameworkId]
  )
  const getSessionHistoryReplayDescriptor = useCallback(
    (sessionId: string): HistoryReplayDescriptor => {
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      return session
        ? resolveSessionHistoryReplayDescriptor(session, providers, agentFrameworks)
        : { target: 'codex-bridge' }
    },
    [agentFrameworks, providers]
  )
  const [sendPreparationInFlightSessionIds, setSendPreparationInFlightSessionIds] = useState<
    string[]
  >([])
  const handleSendPreparationStateChange = useCallback<SendPreparationStateChange>(
    (sessionId, inFlight) => {
      setSendPreparationInFlightSessionIds((current) => {
        const containsSession = current.includes(sessionId)
        if (inFlight === containsSession) return current
        return inFlight ? [...current, sessionId] : current.filter((id) => id !== sessionId)
      })
    },
    []
  )
  const drainRuntimeEvents = drainWorkspaceRuntimeEventsForPersistence
  // Tracks the last connection status so the disconnect effect fires only on a transition, not on
  // every unrelated snapshot re-render.
  const previousStatusRef = useRef(runtime.state.status)
  const previousSessionStatusesRef = useRef(runtime.state.sessionConnectionStatuses)
  // Dedup + cooldown state for the request-size overflow auto-recovery, kept across re-renders.
  const handledOverflowEventIds = useRef(new Set<string>())
  const overflowRecoveryCooldownSessionIds = useRef(new Set<string>())
  const activeOverflowRecoverySessionIds = useRef(new Set<string>())
  const cancelledOverflowRecoverySessionIds = useRef(new Set<string>())
  // Overflow retry may replay only authority carried by the interrupted human turn. Never infer
  // authority from the currently active Plan, because an unrelated message can overflow too.
  const planContinuationBySessionId = useRef(
    new Map<string, NonNullable<SendWorkspaceMessageInput['planContinuation']>>()
  )

  // Auto-recovers when a conversation outgrows the provider's request-size limit: asks capable agents
  // to compact natively, with context replacement + text replay as a fallback. Runs
  // BEFORE the event processor below so it can flip the session to `compacting` first — the event
  // processor then shows the neutral note only when a recovery actually started, and surfaces a real
  // error otherwise (e.g. a repeat overflow inside the cooldown), never a stuck "Compacting…".
  useEffect(() => {
    processContextOverflowRecovery(
      runtime,
      runtime.state.events,
      handledOverflowEventIds.current,
      overflowRecoveryCooldownSessionIds.current,
      activeOverflowRecoverySessionIds.current,
      (recoveryRuntime, sessionId) => {
        // Cancellation intent belongs only to this live attempt; never let a stale marker from an
        // already-settled recovery abort a later overflow retry.
        cancelledOverflowRecoverySessionIds.current.delete(sessionId)
        const planContinuation = planContinuationBySessionId.current.get(sessionId)
        return recoverContextOverflowWorkspaceSession(
          recoveryRuntime,
          sessionId,
          supportsImageInput,
          cancelledOverflowRecoverySessionIds.current,
          getSessionHistoryReplayDescriptor(sessionId),
          planContinuation
        ).finally(() => planContinuationBySessionId.current.delete(sessionId))
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runtime is read fresh; fire on new events.
  }, [runtime.state.events, getSessionHistoryReplayDescriptor, supportsImageInput])

  const agentPromptInFlightSessionIds =
    runtime.state.agentPromptInFlightSessionIds ?? EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS

  // Publish ownership before processing the same snapshot's events. A first visible chunk then clears
  // the wait monotonically instead of a later effect rearming it from that snapshot.
  useEffect(() => {
    syncWorkspaceAgentFirstOutputState(agentPromptInFlightSessionIds)
    void liveWorkspaceRuntimeEventProcessor.process(runtime.state.events)
  }, [agentPromptInFlightSessionIds, runtime.state.events])

  // Mirrors pending permission requests into per-session store status.
  useEffect(() => {
    syncWorkspacePermissionState(runtime.state.pendingPermissions)
  }, [runtime.state.pendingPermissions])

  useEffect(() => {
    syncWorkspaceContextUsage(runtime.state.sessionIds, runtime.state.contextUsageBySession)
  }, [runtime.state.sessionIds, runtime.state.contextUsageBySession])

  // An abnormal live drop (agent crash / gateway drop) surfaces as a transition into 'closed'/'error'
  // while a session is still running. Flag those sessions so the Resume banner appears.
  useEffect(() => {
    const previousStatus = previousStatusRef.current
    const previousSessionStatuses = previousSessionStatusesRef.current
    previousStatusRef.current = runtime.state.status
    previousSessionStatusesRef.current = runtime.state.sessionConnectionStatuses
    markRunningSessionsDisconnectedOnDrop(
      previousStatus,
      runtime.state.status,
      previousSessionStatuses,
      runtime.state.sessionConnectionStatuses
    )
  }, [runtime.state.status, runtime.state.sessionConnectionStatuses])

  // Creates a session if needed, records the user message, then starts the prompt in the background.
  const sendMessage = useCallback(
    (input: SendWorkspaceMessageInput): Promise<SendWorkspaceMessageResult | undefined> => {
      if (input.sessionId && input.planContinuation) {
        planContinuationBySessionId.current.set(input.sessionId, input.planContinuation)
      } else if (input.sessionId) {
        planContinuationBySessionId.current.delete(input.sessionId)
      }
      return sendWorkspaceMessage(
        runtime,
        {
          ...input,
          supportsImageInput,
          agentFrameworkId,
          agentBackendId,
          agentModel: activeModel,
          historyReplayDescriptor
        },
        handleSendPreparationStateChange,
        drainRuntimeEvents
      )
    },
    [
      runtime,
      supportsImageInput,
      agentFrameworkId,
      agentBackendId,
      activeModel,
      historyReplayDescriptor,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  // Truncates the conversation at the edited message, then resends the adjusted prompt with the
  // kept history replayed into the reset agent context.
  const resendEditedMessage = useCallback(
    (sessionId: string, messageId: string, input: ResendEditedMessageInput): Promise<boolean> =>
      resendEditedWorkspaceMessage(
        runtime,
        { sessionId, messageId, ...input },
        {
          supportsImageInput,
          agentFrameworkId,
          agentBackendId,
          agentModel: activeModel,
          historyReplayDescriptor,
          onSendPreparationStateChange: handleSendPreparationStateChange,
          drainRuntimeEvents
        }
      ),
    [
      runtime,
      supportsImageInput,
      agentFrameworkId,
      agentBackendId,
      activeModel,
      historyReplayDescriptor,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  const compactContext = useCallback(
    (sessionId: string): Promise<boolean> => compactWorkspaceSession(runtime, sessionId),
    [runtime]
  )

  // Re-attaches and continues the interrupted turn without adding another visible user message.
  const resumeInterruptedSession = useCallback(
    (sessionId: string): Promise<void> =>
      resumeInterruptedWorkspaceSession(runtime, sessionId, drainRuntimeEvents, {
        historyReplayDescriptor: getSessionHistoryReplayDescriptor(sessionId),
        supportsImageInput
      }),
    [runtime, drainRuntimeEvents, getSessionHistoryReplayDescriptor, supportsImageInput]
  )

  // Sends a cancellation request while the runtime waits for the eventual stop event.
  const cancelRun = useCallback(
    (sessionId: string): Promise<void> =>
      cancelWorkspaceRun(
        runtime,
        sessionId,
        activeOverflowRecoverySessionIds.current.has(sessionId)
          ? cancelledOverflowRecoverySessionIds.current
          : undefined
      ),
    [runtime]
  )

  // Deletes the local session only after runtime state confirms it was removed.
  const deleteRuntimeSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      return deleteWorkspaceSession(runtime, sessionId).catch(() => false)
    },
    [runtime]
  )

  // Routes a permission decision back to the runtime permission broker.
  const respondToPermission = useCallback(
    async (requestId: string, optionId?: string): Promise<void> => {
      const request = runtime.state.pendingPermissions.find((item) => item.requestId === requestId)
      try {
        await runtime.respondToPermission(requestId, optionId)
      } catch (error) {
        if (request) useSessionStore.getState().failRun(request.sessionId, getErrorMessage(error))
      }
    },
    [runtime]
  )

  // Applies attached-session mode changes before persisting the selection. Detached sessions store
  // the preference now and reapply it during resume before their next prompt.
  const setPermissionProfile = useCallback(
    (sessionId: string, profile: PermissionProfileId): Promise<boolean> =>
      setWorkspacePermissionProfile(runtime, sessionId, profile),
    [runtime]
  )

  // Revokes one always-allow grant; the returned snapshot refreshes the visible grant list.
  const revokePermissionGrant = useCallback(
    async (sessionId: string, categoryKey: string): Promise<void> => {
      const snapshot = await runtime.revokePermissionGrant(sessionId, categoryKey)

      if (!snapshot) {
        useSessionStore.getState().failRun(sessionId, 'Permission revoke failed')
      }
    },
    [runtime]
  )

  return {
    actionError: runtime.actionError,
    isConnecting: runtime.isConnecting,
    pendingPermissions: runtime.state.pendingPermissions,
    permissionProfiles: runtime.state.permissionProfiles,
    permissionGrants: runtime.state.permissionGrants,
    contextUsageBySession: runtime.state.contextUsageBySession,
    promptInFlightSessionIds: runtime.state.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.state.nativeContextCompactionSessionIds ?? [],
    compactContext,
    sendMessage,
    resendEditedMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

export {
  cancelWorkspaceRun,
  compactWorkspaceSession,
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  getResumeFailureMessage,
  deleteWorkspaceSession,
  markRunningSessionsDisconnectedOnDrop,
  processContextOverflowRecovery,
  processVisibleWorkspaceRuntimeEvents,
  recoverContextOverflowWorkspaceSession,
  resendEditedWorkspaceMessage,
  resumeInterruptedWorkspaceSession,
  sendWorkspaceMessage,
  setWorkspacePermissionProfile,
  syncWorkspaceContextUsage,
  useWorkspaceAgentRuntime
}

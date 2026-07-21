import { useCallback, useEffect, useRef } from 'react'

import type {
  AcpConnectionStatus,
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpMessageImage
} from '../../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type { ArtifactReference } from '../../../../shared/artifacts'
import type { MessagePart } from '../../../../shared/session-persistence'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { useSessionStore, type ChatMessage } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useAcpRuntime } from './useAcpRuntime'
import { buildHistoryPreamble, buildHistoryReplayMedia } from './history-preamble'
import { applyWorkspaceRuntimeEvent, syncWorkspacePermissionState } from './workspace-events'

type SendWorkspaceMessageInput = {
  sessionId?: string
  text: string
  attachments?: UploadedAttachment[]
  cwd?: string
  // Durable owning project stamped on new sessions.
  projectId?: string
  // Storage project the artifact/notebook MCP servers write under (usually the same value).
  projectName?: string
  permissionProfile?: PermissionProfileId
  // Skills the user picked in the composer; force-loaded and nudged for this turn only.
  forcedSkillIds?: string[]
  // Existing files referenced via `@` mentions; attached to the prompt as content blocks.
  referencedArtifacts?: ArtifactReference[]
  // Structured mention segments of the draft, persisted so the sent bubble renders styled pills.
  parts?: MessagePart[]
  // Set by the interrupted-resume path when its own resume already reset the agent's context. The
  // internal re-resume below runs against an already-attached session and can't report the reset
  // again, so this forces the prior turns to be replayed as a history preamble on the re-sent turn.
  forceHistoryReplay?: boolean
  // Current Provider capability, injected by the hook so context replay cannot bypass image gating.
  supportsImageInput?: boolean
}

type SendWorkspaceMessageResult = {
  sessionId: string
  messageId: string
}

type WorkspaceMessageRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'resetSessionContext' | 'sendPrompt'
> & {
  actionError?: string | null
}

type WorkspaceDeletionRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'deleteSession'>
type PersistSessionDeletion = (request: { projectId: string; sessionId: string }) => Promise<void>

type RuntimeEventApplier = (event: AcpRuntimeEvent) => Promise<boolean>

type WorkspaceRuntimeEventProcessor = {
  process: (events: AcpRuntimeEvent[]) => Promise<void>
}

// Strips the Electron IPC wrapper ("Error invoking remote method '…': Error: <cause>") and any
// leading "Error:" so the underlying agent message can be shown to the user on its own.
const unwrapResumeErrorDetail = (message: string): string =>
  message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()

// Turns a resume failure into an actionable message. Each branch matches one distinct cause thrown
// along the runtime resume path (runtime.ts): a deleted/moved workspace folder ("cwd does not exist"),
// the bounded handshake timeout, an agent build without the resume capability, or a failure to spawn/
// reconnect the agent process. Anything else is genuinely unexpected, so the underlying cause is kept
// visible instead of collapsing to an opaque "resume failed". (The common session-replaced/not-found
// case never reaches here — the runtime silently adopts a fresh agent session for it.)
const getResumeFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  if (/cwd does not exist/i.test(message)) {
    return 'Session workspace is missing; start a new conversation.'
  }

  if (/timed out/i.test(message)) {
    return 'Agent session resume timed out; click Resume to try again.'
  }

  if (/does not support session resume/i.test(message)) {
    return 'This agent build cannot resume sessions; start a new conversation.'
  }

  if (/connection (failed|was superseded)|ACP connection/i.test(message)) {
    return 'Could not reconnect to the agent; check it is installed, then click Resume to retry.'
  }

  // Model↔framework mismatch is now flagged proactively in Settings → Model, so keep this soft and
  // actionable rather than an alarming "resume failed" — the fix lives in settings, not here. Anchor
  // to the specific marker from the thrown error (settings/service.ts: "The active model isn't
  // compatible with <framework>…") so unrelated "not compatible with" errors — notably an ACP
  // protocol-version mismatch — fall through to the default message instead of being mislabeled.
  if (/active model isn'?t compatible with/i.test(message)) {
    return "The active model isn't compatible with this agent framework. Open Settings → Model to pick a compatible model or switch frameworks."
  }

  const detail = unwrapResumeErrorDetail(message)

  return detail ? `Agent session resume failed: ${detail}` : 'Agent session resume failed'
}

// Keeps attachment-finalization failures displayable without assuming Error instances.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Classifies a failed prompt against the live connection status: an abnormal drop (status 'closed'/
// 'error') shows the Resume banner so the user can reconnect and continue, while a turn-level error
// (connection still up, e.g. a gateway 5xx) surfaces as a normal session error. Reading the status at
// failure time avoids the race where failRun would flip the session out of 'running' first.
const failOrMarkDisconnected = async (sessionId: string, message: string): Promise<void> => {
  // A conversation being auto-compacted after a request-size overflow owns its own outcome (reset +
  // retry). Don't overwrite the neutral compacting state with a dead-end error from the prompt rejection
  // the runtime swallowed into undefined.
  if (useSessionStore.getState().sessions.find((session) => session.id === sessionId)?.compacting) {
    return
  }

  try {
    const snapshot = await window.api.acp.getState()

    if (snapshot.status === 'closed' || snapshot.status === 'error') {
      useSessionStore.getState().markDisconnected(sessionId)
      return
    }
  } catch {
    // Fall back to a plain error if the live status read fails.
  }

  useSessionStore.getState().failRun(sessionId, message)
}

// Moves staged uploads into the session directory and updates the already-visible user message.
const finalizeWorkspaceAttachments = async (
  sessionId: string,
  messageId: string,
  attachments: UploadedAttachment[]
): Promise<UploadedAttachment[]> => {
  if (attachments.length === 0) return attachments

  // The renderer message is written before runtime work starts, so its upload paths are replaced.
  const finalizedAttachments = await window.api.uploads.finalizeSession({
    sessionId,
    attachments
  })

  useSessionStore.getState().replaceMessageUploads({
    sessionId,
    messageId,
    uploads: finalizedAttachments
  })
  // Keep tabs opened from staged attachments pointed at the files after their final move.
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalizedAttachments)

  return finalizedAttachments
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
  const processedEventIds = new Set<string>()
  const processingEventIds = new Set<string>()
  let latestEvents: AcpRuntimeEvent[] = []
  let drainInFlight: Promise<void> | undefined
  let drainAgain = false

  // Coalesces rapid runtime snapshots while preserving a single ordered drain loop.
  const drain = async (): Promise<void> => {
    if (drainInFlight) {
      drainAgain = true
      return drainInFlight
    }

    drainInFlight = (async () => {
      do {
        drainAgain = false
        await processVisibleWorkspaceRuntimeEvents(
          latestEvents,
          processedEventIds,
          applyEvent,
          processingEventIds
        )
      } while (drainAgain)
    })()

    try {
      await drainInFlight
    } finally {
      drainInFlight = undefined
    }
  }

  return {
    process: (events) => {
      latestEvents = events
      return drain()
    }
  }
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
  referencedArtifacts: ArtifactReference[] | undefined
): void => {
  void (async () => {
    let createdSession

    try {
      createdSession = await runtime.createSession(cwd, projectName, permissionProfile)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, getErrorMessage(error))
      return
    }

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
      agentBackendId: createdSession.backendId
    })

    if (!bound) return

    let promptAttachments = attachments

    try {
      // Pending conversations only learn their durable id after createSession completes.
      if (attachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          runtimeSessionId,
          bound.messageId,
          attachments
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(runtimeSessionId, getErrorMessage(error))
      return
    }

    void runtime
      .sendPrompt(runtimeSessionId, content, promptAttachments, forcedSkillIds, referencedArtifacts)
      .catch((error) => {
        // A rejected prompt surfaces as a Resume banner if the connection dropped, otherwise a
        // visible session error, instead of being swallowed as an unhandled rejection.
        void failOrMarkDisconnected(runtimeSessionId, getErrorMessage(error))
      })
  })()
}

// Records the user's prompt before slow runtime work continues.
const sendWorkspaceMessage = async (
  runtime: WorkspaceMessageRuntime,
  {
    sessionId,
    text,
    attachments = [],
    cwd,
    projectId,
    projectName,
    permissionProfile,
    forcedSkillIds,
    referencedArtifacts,
    parts,
    forceHistoryReplay,
    supportsImageInput
  }: SendWorkspaceMessageInput
): Promise<SendWorkspaceMessageResult | undefined> => {
  const content = text.trim()

  // Empty drafts are allowed only when the user attached at least one file.
  if (!content && attachments.length === 0) return undefined

  const targetSessionId = sessionId
  const targetCwd = cwd

  if (targetSessionId) {
    const currentSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === targetSessionId)

    if (currentSession?.status === 'running' || currentSession?.status === 'waiting-permission') {
      return undefined
    }

    // Existing sessions keep their own project; new/pending ones fall back to the caller's project.
    const sessionProjectName = projectName ?? currentSession?.projectId

    if (currentSession?.isPending) {
      const retryCwd = targetCwd || currentSession.cwd || undefined
      const appended = useSessionStore.getState().appendUserMessage({
        sessionId: currentSession.id,
        content,
        attachments,
        parts,
        cwd: retryCwd,
        projectId: projectId ?? currentSession.projectId
      })

      if (!appended) return undefined

      startPendingSessionPrompt(
        runtime,
        appended,
        content,
        attachments,
        retryCwd,
        sessionProjectName,
        currentSession.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        forcedSkillIds,
        referencedArtifacts
      )
      return appended
    }

    const shouldResumeSession = !runtime.state.sessionIds.includes(targetSessionId)
    let resumeCwd: string | undefined

    if (shouldResumeSession) {
      if (!targetCwd) {
        useSessionStore
          .getState()
          .failRun(targetSessionId, 'Session workspace is missing; start a new conversation.')
        return undefined
      }

      resumeCwd = targetCwd
    }

    const appended = useSessionStore.getState().appendUserMessage({
      sessionId: targetSessionId,
      content,
      attachments,
      parts,
      cwd: targetCwd,
      projectId: projectId ?? currentSession?.projectId
    })

    // appendUserMessage can reject stale session ids after local deletion or hydration changes.
    if (!appended) return undefined

    // Persisted sessions are marked running locally before async resume closes duplicate submits.
    // A resume that lands on a freshly-adopted session (framework switch, or an unresumable restart)
    // lost the agent's context, so replay the prior turns as a preamble on this first prompt.
    let historyPreamble: string | undefined
    let historyAttachments: UploadedAttachment[] | undefined
    let historyImages: AcpMessageImage[] | undefined
    let contextResetFromResume = false

    if (resumeCwd) {
      try {
        const resumeResult = await runtime.resumeSession(
          targetSessionId,
          resumeCwd,
          sessionProjectName,
          currentSession?.permissionProfile ?? permissionProfile,
          currentSession?.agentFrameworkId,
          currentSession?.agentBackendId
        )

        contextResetFromResume = Boolean(resumeResult?.contextReset)
        useSessionStore
          .getState()
          .markResumed(targetSessionId, resumeResult?.frameworkId, resumeResult?.backendId)
      } catch (error) {
        useSessionStore.getState().failRun(targetSessionId, getResumeFailureMessage(error))
        return appended
      }
    }

    // Replay prior turns when this resume reset the agent's context, or the caller already knows a reset
    // happened (interrupted-resume path — its internal re-resume above hits an already-attached session
    // and can't report the reset again). currentSession was captured before the new user message was
    // appended, so this is the prior conversation only — the turn being sent is not duplicated in.
    if ((contextResetFromResume || forceHistoryReplay) && currentSession) {
      historyPreamble = buildHistoryPreamble(currentSession.messages)
      const media = buildHistoryReplayMedia(currentSession.messages)
      if (supportsImageInput === false && media.images.length > 0) {
        useSessionStore
          .getState()
          .failRun(
            targetSessionId,
            'This conversation needs image replay, but the selected model does not support image input.'
          )
        return appended
      }
      historyAttachments = media.attachments
      historyImages = media.images
    }

    const resumeFallback =
      forcedSkillIds && forcedSkillIds.length > 0 && currentSession
        ? (() => {
            const media = buildHistoryReplayMedia(currentSession.messages)
            return {
              historyPreamble: buildHistoryPreamble(currentSession.messages),
              historyAttachments: media.attachments,
              historyImages: supportsImageInput === false ? undefined : media.images
            }
          })()
        : undefined

    let promptAttachments = attachments

    try {
      // Existing sessions can finalize immediately because their durable id is already known.
      if (attachments.length > 0) {
        promptAttachments = await finalizeWorkspaceAttachments(
          targetSessionId,
          appended.messageId,
          attachments
        )
      }
    } catch (error) {
      useSessionStore.getState().failRun(targetSessionId, getErrorMessage(error))
      return appended
    }

    // The hook returns after local state is updated; event listeners handle the streamed result.
    void runtime
      .sendPrompt(
        targetSessionId,
        content,
        promptAttachments,
        forcedSkillIds,
        referencedArtifacts,
        historyPreamble,
        historyAttachments,
        historyImages,
        resumeFallback
      )
      .catch((error) => {
        // A rejected prompt surfaces as a Resume banner if the connection dropped, otherwise a
        // visible session error, instead of being swallowed as an unhandled rejection.
        void failOrMarkDisconnected(targetSessionId, getErrorMessage(error))
      })

    return appended
  }

  const pending = useSessionStore.getState().appendPendingUserMessage({
    content,
    attachments,
    parts,
    cwd: targetCwd,
    projectId,
    permissionProfile
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
    referencedArtifacts
  )

  return pending
}

// Finds the interrupted user turn to continue after a reconnect: the most recent user message that
// has no successful assistant reply after it (a half-streamed reply is failed on disconnect, so it
// does not count). Returns undefined when the last turn was already answered, so a redundant Resume
// does not re-send it.
const findInterruptedUserTurn = (messages: ChatMessage[]): ChatMessage | undefined => {
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

// Explicitly re-attaches an interrupted session's ACP runtime so the user can keep chatting. On
// success the composer is unlocked; on failure the interrupted banner stays so a retry stays possible.
const resumeInterruptedWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  supportsImageInput?: boolean
): Promise<void> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)

  if (!session) return

  // Already attached (e.g. a redundant click after a prior resume): just clear the banner.
  if (runtime.state.sessionIds.includes(sessionId)) {
    useSessionStore.getState().markResumed(sessionId)
    return
  }

  const resumeCwd = session.cwd || runtime.state.cwd

  if (!resumeCwd) {
    useSessionStore
      .getState()
      .failRun(sessionId, 'Session workspace is missing; start a new conversation.')
    return
  }

  let contextReset = false

  try {
    const resumeResult = await runtime.resumeSession(
      sessionId,
      resumeCwd,
      session.projectId,
      session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      session.agentFrameworkId,
      session.agentBackendId
    )
    // Adopting a fresh agent session (framework switch, or an unresumable restart) wipes the agent's
    // context; capture that so the re-sent turn below replays the transcript. The shared send path's
    // own re-resume can't observe this — by then the session is already attached.
    contextReset = Boolean(resumeResult?.contextReset)
    useSessionStore
      .getState()
      .markResumed(sessionId, resumeResult?.frameworkId, resumeResult?.backendId)
  } catch (error) {
    useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
    return
  }

  // Continue the interrupted turn if it never got a successful reply. Removing the stale user message
  // first avoids a duplicate bubble, since the shared send path re-appends and re-prompts it once.
  const interruptedTurn = findInterruptedUserTurn(session.messages)

  if (!interruptedTurn) return

  useSessionStore.getState().removeMessage(sessionId, interruptedTurn.id)

  await sendWorkspaceMessage(runtime, {
    sessionId,
    text: interruptedTurn.content,
    attachments: interruptedTurn.uploads ?? [],
    parts: interruptedTurn.parts,
    cwd: resumeCwd,
    projectId: session.projectId,
    permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    // Replay the prior conversation when this resume adopted a fresh agent session.
    forceHistoryReplay: contextReset,
    supportsImageInput
  })
}

// After an auto-recovery, ignore further overflow events for this session for a short window so a retry
// that immediately overflows again falls through to a visible error instead of looping. Prevention (the
// per-session inline-image budget) makes a second overflow unlikely, so this is a backstop, not the norm.
const CONTEXT_OVERFLOW_RECOVERY_COOLDOWN_MS = 15_000

// Auto-recovers a conversation whose replayed history outgrew the provider's request-size limit
// (accumulated images/attachments → "Request too large" / the backend's compaction failing with
// media_unstrippable). This is the app-level compaction the backend cannot do: reset the agent context
// to a fresh session (no media), then replay a bounded TEXT transcript and re-send the unanswered turn.
// Mirrors resumeInterruptedWorkspaceSession, differing only in resetting rather than resuming. Returns
// false when there is nothing to recover or the reset itself fails, so the caller keeps the visible error.
const recoverContextOverflowWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)

  if (!session) return false

  const resumeCwd = session.cwd || runtime.state.cwd

  if (!resumeCwd) return false

  // The unanswered user turn is what we re-send; if the last turn already got a reply there is nothing
  // to retry (a stray late overflow event), so bail before disturbing the agent session.
  const interruptedTurn = findInterruptedUserTurn(session.messages)

  if (!interruptedTurn) return false

  // Flip to the neutral compacting state up front so the UI never shows the raw overflow error while the
  // reset round-trip is in flight (idempotent with the event-path beginCompaction).
  useSessionStore.getState().beginCompaction(sessionId)

  try {
    await runtime.resetSessionContext(
      sessionId,
      resumeCwd,
      session.projectId,
      session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
    )
  } catch (error) {
    useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
    return false
  }

  // Drop the unanswered turn so the re-send does not duplicate the bubble; the remaining prior turns are
  // replayed as a text preamble via forceHistoryReplay (session.messages was captured before removal).
  useSessionStore.getState().removeMessage(sessionId, interruptedTurn.id)

  await sendWorkspaceMessage(runtime, {
    sessionId,
    text: interruptedTurn.content,
    attachments: interruptedTurn.uploads ?? [],
    parts: interruptedTurn.parts,
    cwd: resumeCwd,
    projectId: session.projectId,
    permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    // A fresh agent session lost the prior context, so replay the transcript on this first prompt.
    forceHistoryReplay: true
  })

  return true
}

// Scans runtime error events for the request-size overflow and triggers one auto-recovery per event.
// handledEventIds dedups across the repeated event snapshots a bounded window re-delivers; the recovery
// runs only for attached sessions (a detached one uses the normal Resume path) and only once per cooldown.
const processContextOverflowRecovery = (
  runtime: WorkspaceMessageRuntime,
  events: AcpRuntimeEvent[],
  handledEventIds: Set<string>,
  recoveringSessionIds: Set<string>,
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
    if (recoveringSessionIds.has(sessionId)) continue

    recoveringSessionIds.add(sessionId)
    void recover(runtime, sessionId).finally(() => {
      setTimeout(
        () => recoveringSessionIds.delete(sessionId),
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

// Flags running sessions as disconnected on a TRANSITION into a dropped connection state. Abnormal
// drops (agent crash / gateway drop) go through main's handleConnectionClosed → status 'closed';
// deliberate mid-prompt disconnects use disconnect(false) (no 'closed' emit) and idle provider/skills
// reconnects have no running session, so neither reaches markDisconnected here.
const markRunningSessionsDisconnectedOnDrop = (
  previousStatus: AcpConnectionStatus,
  currentStatus: AcpConnectionStatus
): void => {
  const droppedNow =
    (currentStatus === 'closed' || currentStatus === 'error') &&
    previousStatus !== 'closed' &&
    previousStatus !== 'error'

  if (!droppedNow) return

  const { sessions, markDisconnected } = useSessionStore.getState()

  for (const session of sessions) {
    if (session.status === 'running' || session.status === 'waiting-permission') {
      markDisconnected(session.id)
    }
  }
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
  sendMessage: (input: SendWorkspaceMessageInput) => Promise<SendWorkspaceMessageResult | undefined>
  cancelRun: (sessionId: string) => Promise<void>
  resumeInterruptedSession: (sessionId: string) => Promise<void>
  deleteRuntimeSession: (sessionId: string) => Promise<boolean>
  respondToPermission: (requestId: string, optionId?: string) => Promise<void>
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => Promise<boolean>
  revokePermissionGrant: (sessionId: string, categoryKey: string) => Promise<void>
} => {
  const runtime = useAcpRuntime()
  const supportsImageInput = useSettingsStore((state) => {
    const provider = state.providers.find((candidate) => candidate.id === state.activeProviderId)
    return provider?.supportsImageInput ?? false
  })
  const eventProcessor = useRef(createWorkspaceRuntimeEventProcessor())
  // Tracks the last connection status so the disconnect effect fires only on a transition, not on
  // every unrelated snapshot re-render.
  const previousStatusRef = useRef(runtime.state.status)
  // Dedup + cooldown state for the request-size overflow auto-recovery, kept across re-renders.
  const handledOverflowEventIds = useRef(new Set<string>())
  const recoveringOverflowSessionIds = useRef(new Set<string>())

  // Auto-recovers when a conversation outgrows the provider's request-size limit: resets the agent
  // context and replays a text-only transcript instead of dead-ending on an unrecoverable error. Runs
  // BEFORE the event processor below so it can flip the session to `compacting` first — the event
  // processor then shows the neutral note only when a recovery actually started, and surfaces a real
  // error otherwise (e.g. a repeat overflow inside the cooldown), never a stuck "Compacting…".
  useEffect(() => {
    processContextOverflowRecovery(
      runtime,
      runtime.state.events,
      handledOverflowEventIds.current,
      recoveringOverflowSessionIds.current
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runtime is read fresh; fire on new events.
  }, [runtime.state.events])

  // Applies each visible runtime event once and trims ids that fell out of the runtime window.
  useEffect(() => {
    void eventProcessor.current.process(runtime.state.events)
  }, [runtime.state.events])

  // Mirrors pending permission requests into per-session store status.
  useEffect(() => {
    syncWorkspacePermissionState(runtime.state.pendingPermissions)
  }, [runtime.state.pendingPermissions])

  // An abnormal live drop (agent crash / gateway drop) surfaces as a transition into 'closed'/'error'
  // while a session is still running. Flag those sessions so the Resume banner appears.
  useEffect(() => {
    const previousStatus = previousStatusRef.current
    previousStatusRef.current = runtime.state.status
    markRunningSessionsDisconnectedOnDrop(previousStatus, runtime.state.status)
  }, [runtime.state.status])

  // Creates a session if needed, records the user message, then starts the prompt in the background.
  const sendMessage = useCallback(
    (input: SendWorkspaceMessageInput): Promise<SendWorkspaceMessageResult | undefined> =>
      sendWorkspaceMessage(runtime, { ...input, supportsImageInput }),
    [runtime, supportsImageInput]
  )

  // Explicitly re-attaches an interrupted session's ACP runtime so the user can keep chatting. On
  // success the composer is unlocked; on failure the interrupted banner stays so a retry stays possible.
  const resumeInterruptedSession = useCallback(
    (sessionId: string): Promise<void> =>
      resumeInterruptedWorkspaceSession(runtime, sessionId, supportsImageInput),
    [runtime, supportsImageInput]
  )

  // Sends a cancellation request while the runtime waits for the eventual stop event.
  const cancelRun = useCallback(
    async (sessionId: string): Promise<void> => {
      const snapshot = await runtime.cancel(sessionId)

      if (!snapshot) {
        useSessionStore.getState().failRun(sessionId, 'Agent cancellation failed')
      }
    },
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
      const snapshot = await runtime.respondToPermission(requestId, optionId)

      if (!snapshot && request) {
        useSessionStore.getState().failRun(request.sessionId, 'Permission response failed')
      }
    },
    [runtime]
  )

  // Applies attached-session mode changes before persisting the selection. Detached sessions store
  // the preference now and reapply it during resume before their next prompt.
  const setPermissionProfile = useCallback(
    async (sessionId: string, profile: PermissionProfileId): Promise<boolean> => {
      if (runtime.state.sessionIds.includes(sessionId)) {
        const snapshot = await runtime.setPermissionProfile(sessionId, profile)

        if (!snapshot) return false
      }

      useSessionStore.getState().setPermissionProfile(sessionId, profile)
      return true
    },
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
    sendMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

export {
  createWorkspaceRuntimeEventProcessor,
  getResumeFailureMessage,
  deleteWorkspaceSession,
  markRunningSessionsDisconnectedOnDrop,
  processContextOverflowRecovery,
  processVisibleWorkspaceRuntimeEvents,
  recoverContextOverflowWorkspaceSession,
  resumeInterruptedWorkspaceSession,
  sendWorkspaceMessage,
  useWorkspaceAgentRuntime
}

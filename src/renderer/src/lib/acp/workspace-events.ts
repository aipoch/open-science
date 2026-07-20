import type { AcpRuntimeEvent, AcpPermissionRequest } from '../../../../shared/acp'
import type { ArtifactFile, FinalizeRunArtifactsRequest } from '../../../../shared/artifacts'
import type { ReviewRunRequest } from '../../../../shared/reviewer'
import { createPreviewFileItem } from '../../pages/workspace/preview-file-item'
import { getPreviewFormatForFile } from '../../pages/workspace/preview-support'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import { useSessionStore } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import { createRuntimeStreamId, isAssistantRuntimeChatMessageEvent } from './chat-events'

// Remembers which sessions were marked as waiting during the previous permission sync.
const pendingPermissionSessionIds = new Set<string>()

// Sessions whose next triggerAutoReview call should be skipped exactly once.
// Used to suppress the re-review that would otherwise be triggered by the [Auditor] correction turn:
// the main process broadcasts reviewer:suppress-next-auto-review before sending the correction prompt;
// the renderer calls suppressNextAutoReview(sessionId) so the correction turn's stop event is ignored.
const suppressAutoReviewOnceFor = new Set<string>()

// Marks the next triggerAutoReview call for a session as suppressed. Cleared on use (one-shot).
const suppressNextAutoReview = (sessionId: string): void => {
  suppressAutoReviewOnceFor.add(sessionId)
}

// Cancels a pending one-shot suppression. Used when the [Auditor] correction turn fails to send:
// no stop event will arrive to consume the flag, so it must be cleared to avoid silently skipping
// the session's next real auto-review.
const clearSuppressNextAutoReview = (sessionId: string): void => {
  suppressAutoReviewOnceFor.delete(sessionId)
}

// Chooses the best user-facing error text from a runtime event.
const getEventErrorText = (event: AcpRuntimeEvent): string =>
  event.text?.trim() || event.title?.trim() || 'Agent run failed'

// Normalizes IPC/finalization failures into storeable session error text.
const getErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type WorkspaceRuntimeEventDependencies = {
  finalizeRunArtifacts?: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
}

// Defaults to the preload artifact API while allowing tests to inject a fake finalizer.
const finalizeRunArtifacts = (request: FinalizeRunArtifactsRequest): Promise<ArtifactFile[]> =>
  window.api.artifacts.finalizeRunArtifacts(request)

// Opens freshly generated molecular-structure artifacts in the preview panel so the OpenChemLib
// viewer renders them without a manual click. Only molecule-format files auto-open; other artifacts
// (charts, tables, …) still wait for an explicit click. Fires only on live-run artifact events.
const openMoleculePreviews = (sessionId: string, artifacts: ArtifactFile[]): void => {
  const workbench = usePreviewWorkbenchStore.getState()

  for (const artifact of artifacts) {
    const format = getPreviewFormatForFile({ name: artifact.name, mimeType: artifact.mimeType })
    if (format !== 'molecule') continue

    workbench.upsertAndActivateItem(
      createPreviewFileItem({
        id: artifact.id,
        sessionId,
        path: artifact.path,
        name: artifact.name,
        mimeType: artifact.mimeType
      })
    )
  }
}

// Assembles a ReviewRunRequest for the last completed agent turn of a session.
// Returns undefined when no agent turn exists (caller should skip the review).
// Shared between the auto path (triggerAutoReview) and the manual "Request review" path,
// so the two can never drift in turn selection or request field construction.
const assembleReviewRunRequest = (sessionId: string): ReviewRunRequest | undefined => {
  const sessionState = useSessionStore.getState()
  const session = sessionState.sessions.find((s) => s.id === sessionId)

  if (!session) return undefined

  // Find the last agent message (the just-completed turn).
  const lastAgentMessage = [...session.messages].reverse().find((m) => m.role === 'agent')

  if (!lastAgentMessage) return undefined

  return {
    sessionId,
    turnMessageId: lastAgentMessage.id,
    projectId: session.projectId ?? '',
    mainSessionId: sessionId,
    model: useSettingsStore.getState().activeModel
  }
}

// Triggers a background auto-review for the just-completed turn when autoReviewEnabled is on. The
// default is off, so a session is auto-reviewed only when the switch was explicitly turned on. Uses
// the shared assembleReviewRunRequest helper so the auto and manual paths pick the same turn and
// assemble the same request fields.
// Fire-and-forget: errors are caught and silently dropped so the main session is never blocked.
const triggerAutoReview = async (sessionId: string): Promise<void> => {
  try {
    // Loop guard: if this session's next review was suppressed (e.g. because the stop comes from
    // the [Auditor] correction turn), skip exactly this one call and clear the flag.
    if (suppressAutoReviewOnceFor.has(sessionId)) {
      suppressAutoReviewOnceFor.delete(sessionId)
      return
    }

    const sessionState = useSessionStore.getState()
    const session = sessionState.sessions.find((s) => s.id === sessionId)

    if (!session) return

    // Auto-review defaults to disabled: run only when the switch was explicitly turned on.
    if (session.autoReviewEnabled !== true) return

    const request = assembleReviewRunRequest(sessionId)

    if (!request) return

    await window.api.reviewer.run(request)
  } catch {
    // Reviewer errors must never surface to the main session.
  }
}

// Applies one runtime event to the workspace store when it affects chat state.
const applyWorkspaceRuntimeEvent = async (
  event: AcpRuntimeEvent,
  dependencies: WorkspaceRuntimeEventDependencies = {}
): Promise<boolean> => {
  const store = useSessionStore.getState()

  // Assistant chat deltas extend the transcript as streamed markdown messages.
  if (isAssistantRuntimeChatMessageEvent(event)) {
    store.appendAgentMessageChunk({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      content: event.text
    })
    return true
  }

  // Tool calls become visible activity rows, including web-search query/result payloads.
  if (event.kind === 'tool' && event.sessionId && event.toolCallId) {
    store.upsertToolActivity({
      sessionId: event.sessionId,
      toolCallId: event.toolCallId,
      eventId: event.id,
      title: event.title,
      status: event.status,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      terminalOutput: event.terminalOutput,
      terminalExitCode: event.terminalExitCode
    })
    return true
  }

  if (event.kind === 'stop' && event.sessionId) {
    store.finishRun(event.sessionId)

    // Trigger a background review for the just-completed turn.
    // We read the session state AFTER finishRun so messages are complete.
    void triggerAutoReview(event.sessionId)

    return true
  }

  if (
    event.kind === 'artifact' &&
    event.sessionId &&
    event.runId &&
    event.artifactClaimId &&
    event.artifacts &&
    event.artifacts.length > 0
  ) {
    // First attach pending artifacts to whichever assistant message represents this run locally.
    const attached = store.attachRunArtifacts({
      sessionId: event.sessionId,
      runId: event.runId,
      eventId: event.id,
      artifacts: event.artifacts
    })

    if (attached) {
      try {
        // Then move files from pending run storage into the final message-owned directory.
        const finalizedArtifacts = await (
          dependencies.finalizeRunArtifacts ?? finalizeRunArtifacts
        )({
          claimId: event.artifactClaimId,
          messageId: attached.messageId
        })

        // Replace temporary run paths with finalized message paths before persistence/UI rendering.
        store.replaceMessageArtifacts({
          sessionId: event.sessionId,
          messageId: attached.messageId,
          artifacts: finalizedArtifacts
        })
        store.clearArtifactError(event.sessionId)

        // Auto-open any molecular-structure files this run produced, using the finalized paths.
        openMoleculePreviews(event.sessionId, finalizedArtifacts)
      } catch (error) {
        store.recordArtifactError(event.sessionId, getErrorText(error))
        throw error
      }
    }

    return true
  }

  if (event.kind === 'error' && event.sessionId) {
    // A recoverable request-size overflow shows the neutral "compacting" note ONLY while a recovery is
    // actually in flight — the workspace runtime flips the session to `compacting` first (its recovery
    // effect runs before this event is applied). If the session is not compacting, no recovery started
    // for this overflow (a repeat overflow inside the cooldown, nothing to replay, or a detached
    // session), so surface a normal error instead of leaving a stuck "Compacting…".
    const isCompacting = store.sessions.find(
      (session) => session.id === event.sessionId
    )?.compacting
    // Same overflow detection the recovery effect uses (marker first, message as a fallback), so the two
    // agree on which errors are recoverable.
    const isOverflow =
      event.recoverable === 'context-overflow' ||
      isMediaOverflowError(event.text) ||
      isMediaOverflowError(event.title)

    if (isOverflow && isCompacting) {
      return true
    }

    store.failRun(event.sessionId, getEventErrorText(event))
    return true
  }

  // Agent stderr/process warnings arrive as session-scoped system warnings. Surface the latest one in
  // the waiting indicator so a long silent turn (e.g. the agent retrying a slow request) shows a hint
  // rather than a blank spinner. setAgentStatus no-ops unless the session is still running.
  if (event.kind === 'system' && event.level === 'warning' && event.sessionId && event.text) {
    store.setAgentStatus(event.sessionId, event.text)
    return true
  }

  if (event.kind === 'tool') {
    // Tool calls do not create preview items; file preview is opened by file-specific actions.
    return false
  }

  return false
}

// Keeps store permission state aligned with the runtime's current pending request set.
const syncWorkspacePermissionState = (requests: AcpPermissionRequest[]): void => {
  const nextSessionIds = new Set(requests.map((request) => request.sessionId))
  const store = useSessionStore.getState()

  // New pending sessions enter the waiting-permission status.
  for (const sessionId of nextSessionIds) {
    if (!pendingPermissionSessionIds.has(sessionId)) {
      store.setPermissionPending(sessionId)
    }
  }

  // Sessions with no pending request return to their prior run-derived status.
  for (const sessionId of pendingPermissionSessionIds) {
    if (!nextSessionIds.has(sessionId)) {
      store.clearPermissionPending(sessionId)
    }
  }

  pendingPermissionSessionIds.clear()

  // Remember the current set for the next sync pass.
  for (const sessionId of nextSessionIds) {
    pendingPermissionSessionIds.add(sessionId)
  }
}

export {
  applyWorkspaceRuntimeEvent,
  assembleReviewRunRequest,
  syncWorkspacePermissionState,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
}

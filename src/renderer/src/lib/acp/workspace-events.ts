import type { AcpRuntimeEvent, AcpPermissionRequest } from '../../../../shared/acp'
import type { ArtifactFile, FinalizeRunArtifactsRequest } from '../../../../shared/artifacts'
import type { ReviewRunNotStartedReason, ReviewRunRequest } from '../../../../shared/reviewer'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createPreviewFileItemFromArtifact } from '../../pages/workspace/preview-file-item'
import { getPreviewFormatForFile } from '../../pages/workspace/preview-support'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../../../shared/activity-groups'
import { toPersistedSession, useSessionStore } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import {
  createRuntimeStreamId,
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  isAssistantRuntimeChatMessageEvent
} from './chat-events'

// Remembers which sessions were marked as waiting during the previous permission sync.
const pendingPermissionSessionIds = new Set<string>()

// Sessions whose next triggerAutoReview call should be skipped exactly once.
// Used to suppress the re-review that would otherwise be triggered by the [Auditor] correction turn:
// the main process broadcasts reviewer:suppress-next-auto-review before sending the correction prompt;
// the renderer calls suppressNextAutoReview(sessionId) so the correction turn's stop event is ignored.
const suppressAutoReviewOnceFor = new Set<string>()
const activityGroupToolCallIdsBySession = new Map<string, Set<string>>()

type DeferredArtifactEvent = {
  event: AcpRuntimeEvent
  dependencies: WorkspaceRuntimeEventDependencies
}

// The runtime deliberately publishes generated files immediately before its stop event. Providers may
// still have a terminal assistant chunk queued behind the tool result, so binding at the artifact event
// can capture an intermediate message. Hold that one event until stop makes the renderer's terminal
// Message/Branch projection authoritative.
const deferredArtifactEventsBySession = new Map<string, DeferredArtifactEvent>()

const resetDeferredArtifactEventsForTests = (): void => {
  deferredArtifactEventsBySession.clear()
}

const isActivityGroupControlEvent = (event: AcpRuntimeEvent): boolean => {
  if (!event.sessionId || !event.toolCallId) return false

  if (isActivityGroupToolEvent(event)) {
    const toolCallIds = activityGroupToolCallIdsBySession.get(event.sessionId) ?? new Set<string>()
    toolCallIds.add(event.toolCallId)
    activityGroupToolCallIdsBySession.set(event.sessionId, toolCallIds)
    return true
  }

  return activityGroupToolCallIdsBySession.get(event.sessionId)?.has(event.toolCallId) === true
}

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

// A terminal message and its Branch projection are persisted by separate runtime events. Even though
// Artifact finalization explicitly saves first, an already-queued Session save can briefly leave the
// main process observing the prior Branch head. Retry only this narrow, fail-closed ownership race;
// root/Frame/Branch identity mismatches and every other validation failure remain terminal.
const isArtifactOwnershipPersistenceRace = (error: unknown): boolean =>
  error instanceof Error &&
  /Artifact finalization (?:message is not a Branch descendant of its prompt|ancestry does not prove message Branch ownership)/.test(
    error.message
  )

// Codex writes two informational diagnostics to stderr during otherwise-successful turns: skill
// descriptions may be compacted to their context budget, and a timed-out WebSocket attempt may fall
// back to working HTTPS. codex-acp can repeat or concatenate them, but neither asks the user to act
// and both otherwise replace the useful waiting status with a large warning block. Suppress only a
// payload made entirely from these exact diagnostics; any additional stderr text remains visible.
const isNonActionableCodexDiagnostic = (text: string): boolean => {
  const withoutSkillBudgetNotice = text.replace(
    /Warning:\s*Skill descriptions were shortened to fit the 2% skills context budget\.\s*Codex can still see every skill, but some descriptions are shorter\.\s*Disable unused skills or plugins to leave more room for the rest\.\s*/gi,
    ''
  )
  const withoutTransportFallback = withoutSkillBudgetNotice.replace(
    /Warning:\s*Falling back from WebSockets to HTTPS transport\.\s*request timed out\s*/gi,
    ''
  )

  return withoutTransportFallback.trim().length === 0
}

type WorkspaceRuntimeEventDependencies = {
  finalizeRunArtifacts?: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
  saveSession?: (session: PersistedChatSession) => Promise<void>
}

// Defaults to the preload artifact API while allowing tests to inject a fake finalizer.
const finalizeRunArtifacts = (request: FinalizeRunArtifactsRequest): Promise<ArtifactFile[]> =>
  window.api.artifacts.finalizeRunArtifacts(request)

// Artifact finalization validates its renderer-selected Message against the durable Session graph.
// Persist that graph explicitly instead of relying on the asynchronous store saver to win the IPC race.
const saveSessionForArtifactFinalization = (session: PersistedChatSession): Promise<void> =>
  window.api.sessions.saveSession(session)

const finalizeArtifactEvent = async (
  event: AcpRuntimeEvent,
  dependencies: WorkspaceRuntimeEventDependencies
): Promise<boolean> => {
  if (
    event.kind !== 'artifact' ||
    !event.sessionId ||
    !event.runId ||
    !event.artifactClaimId ||
    !event.artifacts ||
    event.artifacts.length === 0
  ) {
    return false
  }

  const store = useSessionStore.getState()
  const attached = store.attachRunArtifacts({
    sessionId: event.sessionId,
    runId: event.runId,
    promptMessageId: event.promptMessageId,
    eventId: event.id,
    artifacts: event.artifacts
  })

  if (!attached) return true

  try {
    const persistLatestSession = async (): Promise<void> => {
      const attachedSession = useSessionStore
        .getState()
        .sessions.find((session) => session.id === event.sessionId)
      if (!attachedSession) {
        throw new Error('Artifact finalization Session is no longer available.')
      }
      await (dependencies.saveSession ?? saveSessionForArtifactFinalization)(
        toPersistedSession(attachedSession)
      )
    }

    await persistLatestSession()

    const finalize = dependencies.finalizeRunArtifacts ?? finalizeRunArtifacts
    const finalizeRequest = {
      claimId: event.artifactClaimId,
      messageId: attached.messageId
    }
    let finalizedArtifacts: ArtifactFile[]
    try {
      finalizedArtifacts = await finalize(finalizeRequest)
    } catch (error) {
      if (!isArtifactOwnershipPersistenceRace(error)) throw error
      await persistLatestSession()
      finalizedArtifacts = await finalize(finalizeRequest)
    }

    store.replaceMessageArtifacts({
      sessionId: event.sessionId,
      messageId: attached.messageId,
      artifacts: finalizedArtifacts
    })
    // Auto-review and every main-process provenance reader load the durable Session, not renderer
    // memory. Persist the checksum-bearing finalized Version descriptors before the stop handler may
    // trigger a Review, otherwise it can freeze a pre-finalization scope.
    await persistLatestSession()
    store.clearArtifactError(event.sessionId)
    openMoleculePreviews(event.sessionId, finalizedArtifacts)
    return true
  } catch (error) {
    store.recordArtifactError(event.sessionId, getErrorText(error))
    throw error
  }
}

// Opens freshly generated molecular-structure artifacts in the preview panel so the OpenChemLib
// viewer renders them without a manual click. Only molecule-format files auto-open; other artifacts
// (charts, tables, …) still wait for an explicit click. Fires only on live-run artifact events.
const openMoleculePreviews = (sessionId: string, artifacts: ArtifactFile[]): void => {
  const workbench = usePreviewWorkbenchStore.getState()
  const projectId = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)?.projectId

  for (const artifact of artifacts) {
    const format = getPreviewFormatForFile({ name: artifact.name, mimeType: artifact.mimeType })
    if (format !== 'molecule') continue

    const item = createPreviewFileItemFromArtifact(
      artifact,
      sessionId,
      projectId || artifact.projectName
    )
    if (item) workbench.upsertAndActivateItem(item)
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

// Bounded retry for a started:false auto-review. A brand-new session is persisted through an async
// queue, but this fires the instant the first turn stops — so main's disk load can momentarily miss
// the session and report started:false. Since main treats not-found as "release the lock, no row",
// a retry is safe: it either catches the now-flushed session, hits a genuine dedup/deletion (stays
// false, we give up), or succeeds. Without it, the first turn of a new session is silently un-reviewed.
const AUTO_REVIEW_START_ATTEMPTS = 4
const AUTO_REVIEW_RETRY_DELAY_MS = 400

// Only these started:false reasons are retried — both are transient, create no Review row, and hold no
// in-flight lock, so a retry cannot double-run a turn. 'already-in-flight' and 'run-failed' are omitted
// deliberately (see ReviewRunNotStartedReason): retrying them risks a duplicate review or is pointless.
const RETRYABLE_START_FAILURE_REASONS = new Set<ReviewRunNotStartedReason>([
  'not-found',
  'load-failed',
  // The main-side idempotency lookup threw (fail-closed, no run started) — retry re-runs the check.
  'idempotency-check-failed'
])

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

    // Retry a started:false a bounded number of times, but ONLY for reasons a persistence race can
    // produce (the session may not be flushed to disk yet). Every other reason is terminal for the auto
    // path: 'already-in-flight' / 'already-reviewed' mean the turn is (being) handled, 'run-failed' is a
    // genuine failure for the user's manual Re-run — and a bridge that returns nothing is treated done.
    //
    // Idempotency across the whole retry task is enforced by MAIN, not here: it reserves the in-flight
    // key synchronously and, for origin='auto', refuses a turn that already has a review. So even if
    // another entry starts and finishes during our delay (releasing the lock), the next attempt reaches
    // main and comes back 'already-reviewed' rather than launching a duplicate. A renderer-local store
    // check could only race that cross-process window, so we rely on main's verdict.
    for (let attempt = 0; attempt < AUTO_REVIEW_START_ATTEMPTS; attempt++) {
      const result = await window.api.reviewer.run({ ...request, origin: 'auto' })
      if (result?.started !== false) return
      if (!result.reason || !RETRYABLE_START_FAILURE_REASONS.has(result.reason)) return
      if (attempt < AUTO_REVIEW_START_ATTEMPTS - 1) await delay(AUTO_REVIEW_RETRY_DELAY_MS)
    }
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
    const image = getAcpRuntimeEventImage(event)
    const content = getAcpRuntimeEventText(event)
    const session = store.sessions.find((candidate) => candidate.id === event.sessionId)

    if (
      session?.agentFrameworkId === 'codex' &&
      !image &&
      typeof content === 'string' &&
      content.trim().length > 0 &&
      isNonActionableCodexDiagnostic(content)
    ) {
      return true
    }

    store.completeActivityGroup(event.sessionId)
    store.appendAgentMessageChunk({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      content,
      image
    })
    return true
  }

  // Tool calls become visible activity rows, including web-search query/result payloads.
  if (event.kind === 'tool' && event.sessionId && event.toolCallId) {
    if (isActivityGroupControlEvent(event)) {
      const title = getActivityGroupTitleFromToolEvent(event)
      if (title) store.beginActivityGroup(event.sessionId, event.toolCallId, title)
      return true
    }

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
    activityGroupToolCallIdsBySession.delete(event.sessionId)
    store.finishRun(event.sessionId)

    const deferredArtifact = deferredArtifactEventsBySession.get(event.sessionId)
    if (deferredArtifact) {
      await finalizeArtifactEvent(deferredArtifact.event, deferredArtifact.dependencies)
      deferredArtifactEventsBySession.delete(event.sessionId)
    }

    // Trigger a background review for the just-completed turn.
    // We read the session state after both finishRun and Artifact finalization so the scope includes
    // the terminal message and its finalized Artifact Version ids.
    void triggerAutoReview(event.sessionId)

    return true
  }

  // Native compaction is a framework control turn, not a chat turn. Reflect its lifecycle in the
  // existing neutral compacting state while keeping command/status output out of the transcript.
  if (event.kind === 'compaction' && event.sessionId) {
    if (event.status === 'in_progress') {
      store.beginCompaction(event.sessionId)
    } else if (event.compactionReason === 'overflow-recovery') {
      // The recovery flow owns the terminal transition: keep the composer gated until its retry
      // replaces compacting with a new active run, or its fallback reports a concrete failure.
      return true
    } else if (event.status === 'completed' || event.status === 'cancelled') {
      store.finishCompaction(event.sessionId)
    } else if (event.status === 'failed') {
      store.failCompaction(event.sessionId, getEventErrorText(event))
    }

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
    const session = store.sessions.find((candidate) => candidate.id === event.sessionId)
    if (session?.activeRun) {
      deferredArtifactEventsBySession.set(event.sessionId, { event, dependencies })
      return true
    }

    return finalizeArtifactEvent(event, dependencies)
  }

  if (event.kind === 'error' && event.sessionId) {
    activityGroupToolCallIdsBySession.delete(event.sessionId)
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

    // A model-provider failure (upstream LLM/HTTP error the agent relayed, tagged structurally in the
    // runtime) keeps its message but is not a bug worth a GitHub issue — hide the report button. For
    // everything else, defer to failRun's text tier (undefined) rather than forcing reportable=true: a
    // non-recovered overflow reaches here (repeat inside cooldown, nothing to replay, detached session)
    // with providerError=false but IS a client-side/size failure the text tier recognizes as expected —
    // forcing true here would wrongly show and persist the report button over it. Opaque ACP-layer
    // failures still fall through the text tier to reportable.
    store.failRun(event.sessionId, getEventErrorText(event), {
      reportable: event.providerError ? false : undefined
    })
    return true
  }

  // Agent stderr/process warnings arrive as session-scoped system warnings. Surface the latest one in
  // the waiting indicator so a long silent turn (e.g. the agent retrying a slow request) shows a hint
  // rather than a blank spinner. setAgentStatus no-ops unless the session is still running.
  if (event.kind === 'system' && event.level === 'warning' && event.sessionId && event.text) {
    const session = store.sessions.find((candidate) => candidate.id === event.sessionId)
    if (session?.agentFrameworkId === 'codex' && isNonActionableCodexDiagnostic(event.text)) {
      return true
    }

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
  clearSuppressNextAutoReview,
  resetDeferredArtifactEventsForTests
}

import {
  ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpContextWindowSample,
  type AcpModelCallUsage,
  type AcpRuntimeEvent,
  type AcpTurnTokenUsage
} from '../../../../shared/acp'
import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  type ArtifactFile,
  type FinalizeRunArtifactsRequest,
  type ReconcilePendingArtifactsRequest,
  type ReconcilePendingArtifactsResult
} from '../../../../shared/artifacts'
import type { ReviewRunNotStartedReason, ReviewRunRequest } from '../../../../shared/reviewer'
import {
  INTERRUPTED_TURN_ERROR,
  isHiddenControlMessage,
  isReviewerCorrectionAttribution,
  sanitizeMessageAttribution,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import { createPreviewFileItemFromArtifact } from '../../pages/workspace/preview-file-item'
import { getPreviewFormatForFile } from '../../pages/workspace/preview-support'
import { useNavigationStore } from '../../stores/navigation-store'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import { isClaudeApiResponseInterruption } from '../../../../shared/run-error-classification'
import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../../../shared/activity-groups'
import {
  toPersistedSession,
  useSessionStore,
  type ChatSession,
  type ToolActivity
} from '../../stores/session-store'
import {
  recordAcpChunkEventReceived,
  recordAgentMessageChunkCommit,
  recordTextEventApplied,
  recordToolEventApplied
} from '../streaming-metrics'
import { saveSessionInOrder } from '../session-persistence/session-persistence'
import {
  createRuntimeStreamId,
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  isAssistantRuntimeChatMessageEvent,
  isBufferableAssistantTextEvent,
  isRuntimeChatMessageEvent,
  type RuntimeChatMessageEvent
} from './chat-events'

// One seam for per-chunk metrics so the single and batch apply paths cannot drift apart.
const recordAppliedTextChunk = (
  event: RuntimeChatMessageEvent,
  content: string | undefined
): void => {
  recordAcpChunkEventReceived()
  recordTextEventApplied(
    createRuntimeStreamId(event),
    typeof content === 'string' ? content.length : 0
  )
}

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

type PendingArtifactTurnUsage = {
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
  modelCallUsage?: readonly AcpModelCallUsage[]
}

// The runtime deliberately publishes generated files immediately before its stop event. Providers may
// still have a terminal assistant chunk queued behind the tool result, so binding at the artifact event
// can capture an intermediate message. Hold every event until stop makes the renderer's terminal
// Message/Branch projection authoritative; one turn may publish more than one generated file claim.
const deferredArtifactEventsBySession = new Map<string, DeferredArtifactEvent[]>()
// Some providers reverse that order and publish an artifact-only response just after stop. Keep the
// terminal usage scoped to its prompt until the matching Artifact creates the owning Agent message.
const pendingArtifactTurnUsageBySession = new Map<string, Map<string, PendingArtifactTurnUsage>>()
const MAX_PENDING_ARTIFACT_TURNS_PER_SESSION = 16
const scheduledAutoReviewsBySession = new Map<string, ReturnType<typeof setTimeout>>()
let autoReviewsSuppressedForQuit = false
const AUTO_REVIEW_ARTIFACT_SETTLE_DELAY_MS = 100

const resetDeferredArtifactEventsForTests = (): void => {
  deferredArtifactEventsBySession.clear()
  pendingArtifactTurnUsageBySession.clear()
  for (const timer of scheduledAutoReviewsBySession.values()) clearTimeout(timer)
  scheduledAutoReviewsBySession.clear()
  autoReviewsSuppressedForQuit = false
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

const isTerminalToolActivity = (activity: ToolActivity | undefined): boolean =>
  activity?.status === 'completed' || activity?.status === 'failed'

const hasPendingDurableUserChoice = (
  session: ChatSession | undefined,
  promptMessageId: string | undefined
): boolean =>
  session?.activities?.some((activity) => {
    const elicitation = activity.elicitation
    return (
      elicitation?.state === 'pending' &&
      elicitation.durable?.kind === 'agent-user-choice' &&
      (!elicitation.durable.promptMessageId ||
        !promptMessageId ||
        elicitation.durable.promptMessageId === promptMessageId)
    )
  }) === true

const getCurrentPromptMessageId = (session: ChatSession): string | undefined =>
  session.activeRun?.promptMessageId ??
  session.messages.findLast((message) => message.role === 'user')?.id

const ownsForegroundPrompt = (session: ChatSession): boolean =>
  Boolean(
    session.agentPromptInFlight ||
    (session.activeRun &&
      (session.status === 'running' ||
        session.status === 'waiting-for-user' ||
        session.status === 'waiting-permission'))
  )

// Only a newly accepted terminal transition for the current foreground prompt opens a new silent gap.
const didCurrentToolBecomeTerminal = (
  before: ChatSession | undefined,
  after: ChatSession | undefined,
  toolCallId: string,
  eventId: string
): boolean => {
  if (!after || !ownsForegroundPrompt(after)) return false

  const beforeActivity = before?.activities?.find((activity) => activity.id === toolCallId)
  const afterActivity = after.activities?.find((activity) => activity.id === toolCallId)
  if (
    !afterActivity ||
    beforeActivity?.eventIds.includes(eventId) ||
    isTerminalToolActivity(beforeActivity) ||
    !isTerminalToolActivity(afterActivity) ||
    !afterActivity.eventIds.includes(eventId)
  ) {
    return false
  }

  const promptMessageId = getCurrentPromptMessageId(after)
  return Boolean(promptMessageId && afterActivity.promptMessageId === promptMessageId)
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

const getTerminalContextWindowSample = (
  event: AcpRuntimeEvent
): Omit<AcpContextWindowSample, 'runtimeSegmentId'> | undefined =>
  event.terminalContextWindow
    ? {
        id: event.id,
        timestamp: event.timestamp,
        ...event.terminalContextWindow
      }
    : undefined

// Normalizes IPC/finalization failures into storeable session error text.
const getErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// A terminal message and its Branch projection are persisted by separate runtime events. Retry only
// the main process's explicit persistence-race code; proof identity and publication failures remain
// terminal regardless of their human-readable wording.
const isArtifactOwnershipPersistenceRace = (error: unknown): boolean =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === ARTIFACT_OWNERSHIP_PERSISTENCE_RACE

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
  reconcilePendingArtifacts?: (
    request: ReconcilePendingArtifactsRequest
  ) => Promise<ReconcilePendingArtifactsResult>
  saveSession?: (session: PersistedChatSession) => Promise<PersistedChatSession | void>
}

// Defaults to the preload artifact API while allowing tests to inject a fake finalizer.
const finalizeRunArtifacts = async (
  request: FinalizeRunArtifactsRequest
): Promise<ArtifactFile[]> => {
  const result = await window.api.artifacts.finalizeRunArtifacts(request)
  if (result.ok) return result.artifacts

  const error = new Error(result.message) as Error & { code: typeof result.code }
  error.code = result.code
  throw error
}

const isArtifactFinalizationProofError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === ARTIFACT_FINALIZATION_INVALID_PROOF

// Artifact finalization and auto-review both require the latest renderer-selected Message graph to be
// durable before Main reads it. Persist explicitly instead of racing the asynchronous store saver.
const saveSessionInRuntimeOrder = (session: PersistedChatSession): Promise<PersistedChatSession> =>
  saveSessionInOrder(session)

type FinalizableArtifactEvent = AcpRuntimeEvent & {
  kind: 'artifact'
  sessionId: string
  runId: string
  artifactClaimId: string
  artifacts: ArtifactFile[]
}

const isFinalizableArtifactEvent = (event: AcpRuntimeEvent): event is FinalizableArtifactEvent =>
  event.kind === 'artifact' &&
  Boolean(event.sessionId && event.runId && event.artifactClaimId && event.artifacts?.length)

const attachArtifactEvent = (
  event: FinalizableArtifactEvent,
  turnUsage?: PendingArtifactTurnUsage
): { sessionId: string; messageId: string } | undefined =>
  useSessionStore.getState().attachRunArtifacts({
    sessionId: event.sessionId,
    runId: event.runId,
    promptMessageId: event.promptMessageId,
    eventId: event.id,
    artifacts: event.artifacts,
    turnUsage: turnUsage?.turnUsage,
    turnUsageUnavailable: turnUsage?.turnUsageUnavailable,
    modelCallUsage: turnUsage?.modelCallUsage
  })

const finalizeArtifactEvent = async (
  event: AcpRuntimeEvent,
  dependencies: WorkspaceRuntimeEventDependencies,
  turnUsage?: PendingArtifactTurnUsage
): Promise<boolean> => {
  if (!isFinalizableArtifactEvent(event)) return false

  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === event.sessionId)
  const persistLatestSession = async (): Promise<void> => {
    const attachedSession = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === event.sessionId)
    if (!attachedSession) {
      throw new Error('Artifact finalization Session is no longer available.')
    }
    const submittedSession = toPersistedSession(attachedSession)
    const durableSession = await (dependencies.saveSession ?? saveSessionInRuntimeOrder)(
      submittedSession
    )
    if (durableSession) {
      useSessionStore.getState().applyDurableSessionProjection({
        source: attachedSession,
        session: durableSession
      })
    }
  }
  const ownsArtifactPrompt = (message: { responseToMessageId?: string }): boolean =>
    !event.promptMessageId || message.responseToMessageId === event.promptMessageId
  const appliedMessage = [
    ...(session?.messages ?? []),
    ...(session?.conversationGraph?.messages ?? [])
  ].find((message) => message.eventIds.includes(event.id) && ownsArtifactPrompt(message))
  const appliedArtifactIds = new Set(appliedMessage?.artifactIds ?? [])
  const sessionReferencesOnly = (resolvedArtifactIds: ReadonlySet<string>): boolean =>
    [...(session?.messages ?? []), ...(session?.conversationGraph?.messages ?? [])].every(
      (message) =>
        (message.artifactIds ?? []).every((artifactId) => resolvedArtifactIds.has(artifactId))
    )
  const artifactVersionIds = event.artifacts.flatMap((artifact) =>
    artifact.versionId ? [artifact.versionId] : []
  )
  const artifactProjectId = session?.projectId ?? event.artifacts[0]?.projectId
  if (appliedMessage && artifactProjectId && artifactVersionIds.length > 0) {
    try {
      await persistLatestSession()
      const reconcile =
        dependencies.reconcilePendingArtifacts ?? window.api.artifacts.reconcilePendingArtifacts
      const result = await reconcile({
        projectId: artifactProjectId,
        sessionId: event.sessionId,
        messageId: appliedMessage.id,
        pendingPaths: event.artifacts
          .map((artifact) => artifact.path)
          .filter((path) => path.split(/[\\/]/).includes('.pending')),
        artifactVersionIds
      })
      if (!Array.isArray(result)) {
        const error = new Error(result.message) as Error & { code: typeof result.code }
        error.code = result.code
        throw error
      }
      const reconciledVersionIds = new Set(
        result.flatMap((artifact) => (artifact.versionId ? [artifact.versionId] : []))
      )
      if (artifactVersionIds.every((versionId) => reconciledVersionIds.has(versionId))) {
        // Reconciliation also completes ordinary pre-stop Artifact events. Publish the returned
        // descriptor into the live projection so preview readiness changes without changing bytes.
        useSessionStore.getState().replaceMessageArtifacts({
          sessionId: event.sessionId,
          messageId: appliedMessage.id,
          artifacts: result,
          preserveArtifactIds: appliedMessage.artifactIds
        })
        const resolvedArtifactIds = new Set([
          ...event.artifacts.map((artifact) => artifact.id),
          ...result.map((artifact) => artifact.id)
        ])
        if (
          session?.artifactErrorEventIds?.includes(event.id) ||
          sessionReferencesOnly(resolvedArtifactIds)
        ) {
          useSessionStore.getState().clearArtifactError(event.sessionId, event.id)
        }
        return true
      }
      throw new Error('Artifact reconciliation did not resolve all native Versions.')
    } catch (error) {
      useSessionStore
        .getState()
        .recordArtifactError(
          event.sessionId,
          getErrorText(error),
          !isArtifactFinalizationProofError(error),
          event.id
        )
      throw error
    }
  }
  const resolvedCompatibilityArtifactIds = new Set<string>()
  const eventArtifactsAreFinalized = event.artifacts.every((pendingArtifact) => {
    const finalizedArtifact = session?.artifacts?.find(
      (artifact) =>
        appliedArtifactIds.has(artifact.id) &&
        artifact.name === pendingArtifact.name &&
        artifact.size === pendingArtifact.size &&
        artifact.mtimeMs === pendingArtifact.mtimeMs &&
        !pendingArtifact.versionId &&
        !artifact.path.split(/[\\/]/).includes('.pending')
    )
    if (finalizedArtifact) resolvedCompatibilityArtifactIds.add(finalizedArtifact.id)
    return Boolean(finalizedArtifact)
  })
  if (appliedMessage && eventArtifactsAreFinalized) {
    if (
      session?.artifactErrorEventIds?.includes(event.id) ||
      sessionReferencesOnly(resolvedCompatibilityArtifactIds)
    ) {
      useSessionStore.getState().clearArtifactError(event.sessionId, event.id)
    }
    return true
  }

  const attached = attachArtifactEvent(event, turnUsage)

  if (!attached) return true

  const store = useSessionStore.getState()
  let artifactsFinalized = false

  try {
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
    artifactsFinalized = true

    store.replaceMessageArtifacts({
      sessionId: event.sessionId,
      messageId: attached.messageId,
      artifacts: finalizedArtifacts
    })
    store.clearArtifactError(event.sessionId, event.id)
    openMoleculePreviews(event.sessionId, finalizedArtifacts)
    // Auto-review and every main-process provenance reader load the durable Session, not renderer
    // memory. Persist the checksum-bearing finalized Version descriptors before the stop handler may
    // trigger a Review, otherwise it can freeze a pre-finalization scope.
    await persistLatestSession()
    return true
  } catch (error) {
    if (!artifactsFinalized) {
      store.recordArtifactError(
        event.sessionId,
        getErrorText(error),
        !isArtifactFinalizationProofError(error),
        event.id
      )
    }
    throw error
  }
}

// Opens freshly generated molecular-structure artifacts in the preview panel so the OpenChemLib
// viewer renders them without a manual click. Only molecule-format files auto-open; other artifacts
// (charts, tables, …) still wait for an explicit click. Fires only on live-run artifact events.
const openMoleculePreviews = (sessionId: string, artifacts: ArtifactFile[]): void => {
  const projectId = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)?.projectId
  const navigation = useNavigationStore.getState()
  const items = projectId
    ? artifacts.flatMap((artifact) => {
        const format = getPreviewFormatForFile({ name: artifact.name, mimeType: artifact.mimeType })
        if (format !== 'molecule') return []

        const item = createPreviewFileItemFromArtifact(artifact, sessionId, projectId)
        return item ? [item] : []
      })
    : []

  // Background runs keep finalizing artifacts on every route, but only the owning foreground
  // Workspace may change the visible preview slice or steal preview focus.
  if (
    !projectId ||
    items.length === 0 ||
    navigation.view !== 'workspace' ||
    navigation.activeProjectId !== projectId
  ) {
    return
  }

  const openItems = (): void => {
    const workbench = usePreviewWorkbenchStore.getState()
    for (const item of items) workbench.upsertAndActivateItem(item)
  }

  if (usePreviewWorkbenchStore.getState().activeProjectId === projectId) {
    openItems()
    return
  }

  // Project navigation commits before the persisted preview slice finishes loading. Wait for that
  // existing activation instead of initializing the slice early and suppressing its restore.
  let unsubscribeWorkbench = (): void => undefined
  let unsubscribeNavigation = (): void => undefined
  const dispose = (): void => {
    unsubscribeWorkbench()
    unsubscribeNavigation()
  }
  const tryOpen = (): void => {
    const currentNavigation = useNavigationStore.getState()
    if (currentNavigation.view !== 'workspace' || currentNavigation.activeProjectId !== projectId) {
      dispose()
      return
    }
    if (usePreviewWorkbenchStore.getState().activeProjectId !== projectId) return

    dispose()
    openItems()
  }

  unsubscribeWorkbench = usePreviewWorkbenchStore.subscribe(tryOpen)
  unsubscribeNavigation = useNavigationStore.subscribe(tryOpen)
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
    mainSessionId: sessionId
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
const triggerAutoReview = async (
  sessionId: string,
  saveSession: NonNullable<WorkspaceRuntimeEventDependencies['saveSession']>
): Promise<void> => {
  try {
    if (autoReviewsSuppressedForQuit) return

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

    const reviewedMessage = session.messages.find((message) => message.id === request.turnMessageId)
    if (
      session.messages.some(
        (message) =>
          message.id === reviewedMessage?.responseToMessageId &&
          (isHiddenControlMessage(message) || isReviewerCorrectionAttribution(message.attribution))
      )
    ) {
      return
    }

    // Main resolves Review scope from the durable Session. The renderer's ordinary store saver is
    // intentionally cadence-limited, so a fixed debounce can still expose the previous message graph.
    // This runs inside the fire-and-forget auto-review task: the main turn remains settled while only
    // Reviewer waits for this Session's terminal Message and stop metadata to become readable.
    await saveSession(toPersistedSession(session))

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
      if (autoReviewsSuppressedForQuit) return
      const result = await window.api.reviewer.run({ ...request, origin: 'auto' })
      if (result?.started !== false) return
      if (!result.reason || !RETRYABLE_START_FAILURE_REASONS.has(result.reason)) return
      if (attempt < AUTO_REVIEW_START_ATTEMPTS - 1) await delay(AUTO_REVIEW_RETRY_DELAY_MS)
    }
  } catch {
    // Reviewer errors must never surface to the main session.
  }
}

const cancelScheduledAutoReview = (sessionId: string): void => {
  const timer = scheduledAutoReviewsBySession.get(sessionId)
  if (timer) clearTimeout(timer)
  scheduledAutoReviewsBySession.delete(sessionId)
}

const suppressAutoReviewsForQuit = (): void => {
  autoReviewsSuppressedForQuit = true
  for (const timer of scheduledAutoReviewsBySession.values()) clearTimeout(timer)
  scheduledAutoReviewsBySession.clear()
}

const resumeAutoReviewsAfterQuitAbort = (): void => {
  autoReviewsSuppressedForQuit = false
}

// Stop and artifact events normally arrive together, but some providers publish the Artifact just
// after stop. A short debounced barrier lets that claim finalize before Reviewer freezes its scope.
// A post-stop Artifact cancels this timer immediately and schedules a fresh review after finalization.
const scheduleAutoReview = (
  sessionId: string,
  saveSession: NonNullable<
    WorkspaceRuntimeEventDependencies['saveSession']
  > = saveSessionInRuntimeOrder
): void => {
  if (autoReviewsSuppressedForQuit) return
  cancelScheduledAutoReview(sessionId)
  const timer = setTimeout(() => {
    scheduledAutoReviewsBySession.delete(sessionId)
    void triggerAutoReview(sessionId, saveSession)
  }, AUTO_REVIEW_ARTIFACT_SETTLE_DELAY_MS)
  scheduledAutoReviewsBySession.set(sessionId, timer)
}

// Applies one runtime event to the workspace store when it affects chat state.
const applyWorkspaceRuntimeEvent = async (
  event: AcpRuntimeEvent,
  dependencies: WorkspaceRuntimeEventDependencies = {}
): Promise<boolean> => {
  const store = useSessionStore.getState()

  // Thought chunks never enter the transcript. Exit before the permission / message / tool
  // probes so a thinking-model burst cannot walk Session state once per provider token.
  if (event.kind === 'thought') return false

  if (event.kind === 'permission' && event.sessionId) {
    const permission = store.sessions.find((session) => session.id === event.sessionId)
      ?.runtimeContext?.permission
    if (
      !event.permissionRequestId ||
      (permission && permission.request.requestId !== event.permissionRequestId)
    ) {
      return false
    }
    if (event.title === ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE) {
      store.setPermissionPending(event.sessionId, { rearmAuthority: true })
      return true
    }
    if (
      event.title === ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE ||
      event.title === ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE ||
      event.title === ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE
    ) {
      store.clearPermissionPending(event.sessionId, {
        authority: 'settled',
        requestId: event.permissionRequestId
      })
      return true
    }
  }

  // A routed user Message is persisted by main before broadcast. Project that same Message locally
  // without treating it as a fresh prompt or starting another run.
  if (
    isRuntimeChatMessageEvent(event) &&
    event.role === 'user' &&
    event.sessionId &&
    event.messageId
  ) {
    store.appendRoutedUserMessage({
      sessionId: event.sessionId,
      messageId: event.messageId,
      eventId: event.id,
      content: getAcpRuntimeEventText(event) ?? '',
      createdAt: event.timestamp,
      ...(sanitizeMessageAttribution(event.attribution)
        ? { attribution: sanitizeMessageAttribution(event.attribution) }
        : {}),
      ...(event.promptMessageId && event.promptMessageId !== event.messageId
        ? { responseToMessageId: event.promptMessageId }
        : {}),
      ...(event.uploads && event.uploads.length > 0 ? { uploads: event.uploads } : {}),
      ...(event.parts && event.parts.length > 0 ? { parts: event.parts } : {})
    })
    return true
  }

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

    store.completeActivityGroup(event.sessionId, event.promptMessageId)
    recordAgentMessageChunkCommit(1)
    recordAppliedTextChunk(event, content)
    store.appendAgentMessageChunk({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      promptMessageId: event.promptMessageId,
      content,
      image
    })
    return true
  }

  // Tool calls become visible activity rows, including web-search query/result payloads.
  if (event.kind === 'tool' && event.sessionId && event.toolCallId) {
    if (!isActivityGroupControlEvent(event)) {
      recordToolEventApplied(event.toolCallId, event.title)
    }
    if (isActivityGroupControlEvent(event)) {
      const title = getActivityGroupTitleFromToolEvent(event)
      if (title) {
        store.beginActivityGroup(event.sessionId, event.toolCallId, title, event.promptMessageId)
      }
      return true
    }

    const sessionBeforeToolEvent = store.sessions.find((session) => session.id === event.sessionId)
    store.upsertToolActivity({
      sessionId: event.sessionId,
      toolCallId: event.toolCallId,
      eventId: event.id,
      timestamp: event.timestamp,
      promptMessageId: event.promptMessageId,
      title: event.title,
      status: event.status,
      toolDisposition: event.toolDisposition,
      executionInvocationId: event.executionInvocationId,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      terminalOutput: event.terminalOutput,
      terminalExitCode: event.terminalExitCode,
      elicitation: event.elicitation
    })
    const sessionAfterToolEvent = useSessionStore
      .getState()
      .sessions.find((session) => session.id === event.sessionId)
    if (
      didCurrentToolBecomeTerminal(
        sessionBeforeToolEvent,
        sessionAfterToolEvent,
        event.toolCallId,
        event.id
      )
    ) {
      useSessionStore.getState().setAwaitingFirstAgentOutput(event.sessionId, true)
    }
    return true
  }

  if (event.kind === 'plan' && event.sessionId && event.planProjection) {
    store.setActivePlanProjection(event.sessionId, event.planProjection)
    return true
  }

  if (event.kind === 'stop' && event.sessionId) {
    activityGroupToolCallIdsBySession.delete(event.sessionId)
    const activeSession = store.sessions.find((session) => session.id === event.sessionId)
    const terminalPromptMessageId =
      event.promptMessageId ?? activeSession?.activeRun?.promptMessageId
    const contextWindowSample = getTerminalContextWindowSample(event)
    if (event.text === 'cancelled') {
      deferredArtifactEventsBySession.delete(event.sessionId)
      pendingArtifactTurnUsageBySession.delete(event.sessionId)
      store.interruptRun(
        event.sessionId,
        'cancelled',
        INTERRUPTED_TURN_ERROR,
        terminalPromptMessageId,
        contextWindowSample,
        event.turnUsage,
        event.modelCallUsage
      )
      return true
    }
    const deferredArtifacts = deferredArtifactEventsBySession.get(event.sessionId)
    let deferredAttachmentError: unknown
    let deferredAttachmentFailed = false

    // Artifact-only turns need their terminal Agent message before finishRun chooses the owner of the
    // usage footer. Binding is synchronous; durable finalization still happens after the run settles.
    if (!activeSession?.conversationGraphSyncBlocked && deferredArtifacts) {
      try {
        for (const deferredArtifact of deferredArtifacts) {
          if (isFinalizableArtifactEvent(deferredArtifact.event)) {
            attachArtifactEvent(deferredArtifact.event)
          }
        }
      } catch (error) {
        deferredAttachmentError = error
        deferredAttachmentFailed = true
      }
    }

    store.finishRun(
      event.sessionId,
      event.turnUsage,
      terminalPromptMessageId,
      contextWindowSample,
      event.modelCallUsage
    )

    const terminalSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === event.sessionId)
    if (terminalSession?.conversationGraphSyncBlocked) {
      // The run is visibly settled as an integrity error, but its terminal Message is not proven to
      // belong to the active Branch. Acknowledge the stop without publishing Artifact or Review data.
      deferredArtifactEventsBySession.delete(event.sessionId)
      pendingArtifactTurnUsageBySession.delete(event.sessionId)
      return true
    }

    if (deferredAttachmentFailed) {
      deferredArtifactEventsBySession.delete(event.sessionId)
      throw deferredAttachmentError
    }

    const terminalResponse = terminalPromptMessageId
      ? [...(terminalSession?.messages ?? [])]
          .reverse()
          .find(
            (message) =>
              message.role === 'agent' && message.responseToMessageId === terminalPromptMessageId
          )
      : undefined
    if (terminalPromptMessageId && !terminalResponse) {
      const pendingByPrompt =
        pendingArtifactTurnUsageBySession.get(event.sessionId) ??
        new Map<string, PendingArtifactTurnUsage>()
      pendingByPrompt.set(terminalPromptMessageId, {
        ...(event.turnUsage
          ? { turnUsage: event.turnUsage }
          : { turnUsageUnavailable: true as const }),
        modelCallUsage: event.modelCallUsage
      })
      if (pendingByPrompt.size > MAX_PENDING_ARTIFACT_TURNS_PER_SESSION) {
        const oldestPromptMessageId = pendingByPrompt.keys().next().value
        if (oldestPromptMessageId) pendingByPrompt.delete(oldestPromptMessageId)
      }
      pendingArtifactTurnUsageBySession.set(event.sessionId, pendingByPrompt)
    } else if (terminalPromptMessageId) {
      const pendingByPrompt = pendingArtifactTurnUsageBySession.get(event.sessionId)
      pendingByPrompt?.delete(terminalPromptMessageId)
      if (pendingByPrompt?.size === 0) pendingArtifactTurnUsageBySession.delete(event.sessionId)
    }

    if (deferredArtifacts) {
      deferredArtifactEventsBySession.delete(event.sessionId)
      for (const deferredArtifact of deferredArtifacts) {
        await finalizeArtifactEvent(deferredArtifact.event, deferredArtifact.dependencies)
      }
    }

    // A durable user choice pauses the same logical turn; reviewing the partial response here would
    // freeze an incomplete scope before the hidden continuation resumes it.
    if (!hasPendingDurableUserChoice(terminalSession, terminalPromptMessageId)) {
      // Trigger a background review for the just-completed turn. Read state after both finishRun and
      // Artifact finalization so the scope includes the terminal message and finalized versions.
      scheduleAutoReview(event.sessionId, dependencies.saveSession)
    }

    return true
  }

  // Native compaction is a framework control turn, not a chat Message. Persist one branch-scoped,
  // non-interactive activity row while retaining the existing neutral Session compacting state.
  if (event.kind === 'compaction' && event.sessionId) {
    const sessionBeforeCompaction = store.sessions.find(
      (candidate) => candidate.id === event.sessionId
    )
    const existingActivity = event.toolCallId
      ? sessionBeforeCompaction?.activities?.find((activity) => activity.id === event.toolCallId)
      : undefined
    if (
      existingActivity?.providerToolName === ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME &&
      isTerminalToolActivity(existingActivity)
    ) {
      return true
    }

    if (event.status === 'in_progress') {
      store.beginCompaction(event.sessionId)
    } else if (event.compactionReason !== 'overflow-recovery') {
      if (event.status === 'completed' || event.status === 'cancelled') {
        store.finishCompaction(event.sessionId)
      } else if (event.status === 'failed') {
        store.failCompaction(event.sessionId, getEventErrorText(event))
      }
    }
    // For overflow recovery, the recovery flow owns the terminal Session transition: the activity row
    // still settles below, while the composer stays gated until a retry or fallback takes over.

    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === event.sessionId)
    const promptMessageId =
      event.promptMessageId ?? (session ? getCurrentPromptMessageId(session) : undefined)
    if (event.toolCallId && promptMessageId) {
      store.completeActivityGroup(event.sessionId, promptMessageId)
      store.upsertToolActivity({
        sessionId: event.sessionId,
        toolCallId: event.toolCallId,
        eventId: event.id,
        timestamp: event.timestamp,
        promptMessageId,
        title: event.title,
        status: event.status === 'cancelled' ? 'completed' : event.status,
        providerToolName: ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
        toolKind: 'other'
      })
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
    if (session?.conversationGraphSyncBlocked) return true
    if (session?.activeRun) {
      const deferredArtifacts = deferredArtifactEventsBySession.get(event.sessionId) ?? []
      deferredArtifacts.push({ event, dependencies })
      deferredArtifactEventsBySession.set(event.sessionId, deferredArtifacts)
      return true
    }

    cancelScheduledAutoReview(event.sessionId)
    const pendingByPrompt = pendingArtifactTurnUsageBySession.get(event.sessionId)
    const matchingTurnUsage = event.promptMessageId
      ? pendingByPrompt?.get(event.promptMessageId)
      : undefined
    const wasFinalized = await finalizeArtifactEvent(event, dependencies, matchingTurnUsage)
    if (wasFinalized && matchingTurnUsage && event.promptMessageId) {
      pendingByPrompt?.delete(event.promptMessageId)
      if (pendingByPrompt?.size === 0) pendingArtifactTurnUsageBySession.delete(event.sessionId)
    }
    if (wasFinalized) scheduleAutoReview(event.sessionId, dependencies.saveSession)
    return wasFinalized
  }

  if (event.kind === 'error' && event.sessionId) {
    activityGroupToolCallIdsBySession.delete(event.sessionId)
    pendingArtifactTurnUsageBySession.delete(event.sessionId)
    // A recoverable request-size overflow shows the neutral "compacting" note ONLY while a recovery is
    // actually in flight — the workspace runtime flips the session to `compacting` first (its recovery
    // effect runs before this event is applied). If the session is not compacting, no recovery started
    // for this overflow (a repeat overflow inside the cooldown, nothing to replay, or a detached
    // session), so surface a normal error instead of leaving a stuck "Compacting…".
    const activeSession = store.sessions.find((session) => session.id === event.sessionId)
    const isCompacting = activeSession?.compacting
    // Same overflow detection the recovery effect uses (marker first, message as a fallback), so the two
    // agree on which errors are recoverable.
    const isOverflow =
      event.recoverable === 'context-overflow' ||
      isMediaOverflowError(event.text) ||
      isMediaOverflowError(event.title)

    if (isOverflow && isCompacting) {
      return true
    }

    const errorText = getEventErrorText(event)

    // Claude Code can close its provider stream after partial output. That is not a completed turn or
    // an app defect: settle the partial projection and reuse the durable, user-triggered Resume path.
    // Require both the structural provider tag and the fixed wrapper so unrelated provider failures
    // keep their existing terminal-error behavior.
    if (event.providerError && isClaudeApiResponseInterruption(errorText)) {
      store.interruptRun(
        event.sessionId,
        'connection-lost',
        errorText,
        event.promptMessageId ?? activeSession?.activeRun?.promptMessageId,
        getTerminalContextWindowSample(event),
        event.turnUsage,
        event.modelCallUsage
      )
    } else {
      // A model-provider failure (upstream LLM/HTTP error the agent relayed, tagged structurally in the
      // runtime) keeps its message but is not a bug worth a GitHub issue — hide the report button. For
      // everything else, defer to failRun's text tier (undefined) rather than forcing reportable=true: a
      // non-recovered overflow reaches here (repeat inside cooldown, nothing to replay, detached session)
      // with providerError=false but IS a client-side/size failure the text tier recognizes as expected —
      // forcing true here would wrongly show and persist the report button over it. Opaque ACP-layer
      // failures still fall through the text tier to reportable.
      store.failRun(event.sessionId, errorText, {
        reportable: event.providerError ? false : undefined,
        promptMessageId: event.promptMessageId ?? activeSession?.activeRun?.promptMessageId,
        contextWindowSample: getTerminalContextWindowSample(event)
      })
    }
    const failedSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === event.sessionId)
    if (failedSession?.conversationGraphSyncBlocked) {
      deferredArtifactEventsBySession.delete(event.sessionId)
    }
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

// A presentation tick contains only adjacent text deltas from one Session lane. Projecting the
// complete tick in one store transaction preserves every event id while avoiding one React update
// and growing-Markdown parse per provider token.
const applyWorkspaceRuntimeEventBatch = async (events: AcpRuntimeEvent[]): Promise<boolean> => {
  if (events.length === 0) return true
  if (!events.every(isBufferableAssistantTextEvent)) {
    for (const event of events) await applyWorkspaceRuntimeEvent(event)
    return true
  }

  const store = useSessionStore.getState()
  const inputs: Parameters<typeof store.appendAgentMessageChunks>[0] = []
  const completedActivityGroups = new Set<string>()

  for (const event of events) {
    const content = getAcpRuntimeEventText(event)
    const session = store.sessions.find((candidate) => candidate.id === event.sessionId)
    if (
      session?.agentFrameworkId === 'codex' &&
      typeof content === 'string' &&
      content.trim().length > 0 &&
      isNonActionableCodexDiagnostic(content)
    ) {
      continue
    }

    const activityGroupKey = `${event.sessionId}\0${event.promptMessageId ?? ''}`
    if (!completedActivityGroups.has(activityGroupKey)) {
      store.completeActivityGroup(event.sessionId, event.promptMessageId)
      completedActivityGroups.add(activityGroupKey)
    }
    inputs.push({
      sessionId: event.sessionId,
      streamId: createRuntimeStreamId(event),
      eventId: event.id,
      promptMessageId: event.promptMessageId,
      content
    })
    recordAppliedTextChunk(event, content)
  }

  recordAgentMessageChunkCommit(inputs.length)
  store.appendAgentMessageChunks(inputs)
  return true
}

export {
  applyWorkspaceRuntimeEvent,
  applyWorkspaceRuntimeEventBatch,
  assembleReviewRunRequest,
  resumeAutoReviewsAfterQuitAbort,
  suppressAutoReviewsForQuit,
  suppressNextAutoReview,
  clearSuppressNextAutoReview,
  resetDeferredArtifactEventsForTests
}

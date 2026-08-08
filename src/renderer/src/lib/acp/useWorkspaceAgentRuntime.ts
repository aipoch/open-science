import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AcpCreateSessionResponse,
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpContextUsage
} from '../../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import { RESUME_WORKSPACE_MISSING_MESSAGE } from '../../../../shared/run-error-classification'
import { useSessionStore, type ChatMessage, type ChatSession } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import { useSettingsStore } from '../../stores/settings-store'
import { useAcpRuntime } from './useAcpRuntime'
import {
  resolveHistoryReplayTarget,
  resolveSessionHistoryReplayDescriptor,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  markRunningSessionsDisconnectedOnDrop,
  processVisibleWorkspaceRuntimeEvents,
  processWorkspaceRuntimeEvents,
  syncWorkspaceContextUsage,
  syncWorkspacePermissionState
} from './workspace-runtime-event-owner'
import { getResumeFailureMessage } from './workspace-runtime-prompt-preparation-owner'
import {
  resendEditedWorkspaceMessage,
  sendWorkspaceMessage,
  type ResendEditedMessageInput,
  type SendWorkspaceMessageInput,
  type SendWorkspaceMessageResult
} from './workspace-runtime-command-owner'

type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type RuntimeEventDrain = (sessionId?: string) => Promise<void>

type ResumeInterruptedWorkspaceSessionOptions = {
  historyReplayDescriptor?: HistoryReplayDescriptor
  supportsImageInput?: boolean
  flushPersistence?: () => Promise<void>
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

const EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS: string[] = []
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
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
    void processWorkspaceRuntimeEvents(runtime.state.events, agentPromptInFlightSessionIds)
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
        {
          onSendPreparationStateChange: handleSendPreparationStateChange,
          drainRuntimeEvents
        }
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
  resumeInterruptedWorkspaceSession,
  setWorkspacePermissionProfile,
  syncWorkspaceContextUsage,
  useWorkspaceAgentRuntime
}

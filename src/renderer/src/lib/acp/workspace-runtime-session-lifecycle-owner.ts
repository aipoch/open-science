import type { AcpRuntimeEvent, AcpSessionAgentTarget } from '../../../../shared/acp'
import { DEFAULT_PERMISSION_PROFILE } from '../../../../shared/permission-profiles'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'
import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
import { isMediaOverflowError } from '../../../../shared/media-overflow'
import { RESUME_WORKSPACE_MISSING_MESSAGE } from '../../../../shared/run-error-classification'
import { useSessionStore, type ChatMessage, type ChatSession } from '../../stores/session-store'
import {
  confirmPendingDelegationPolicyAuthority,
  flushSessionPersistence
} from '../session-persistence/session-persistence'
import type { useAcpRuntime } from './useAcpRuntime'
import { resolveHistoryReplayTarget, type HistoryReplayDescriptor } from './history-preamble'
import { getResumeFailureMessage } from './workspace-runtime-prompt-preparation-owner'
import {
  sendWorkspaceMessage,
  type SendWorkspaceMessageIntent
} from './workspace-runtime-command-owner'
import {
  reconfigureWorkspaceMemory,
  replaceWorkspaceProviderIdentity
} from './workspace-runtime-session-memory-owner'

type RuntimeEventDrain = (sessionId?: string) => Promise<void>

type ResumeInterruptedWorkspaceSessionOptions = {
  historyReplayDescriptor?: HistoryReplayDescriptor
  supportsImageInput?: boolean
  agentTarget?: AcpSessionAgentTarget
  flushPersistence?: () => Promise<void>
}

type WorkspaceMessageRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'resetSessionContext' | 'sendPrompt'
> &
  Partial<Pick<ReturnType<typeof useAcpRuntime>, 'compactSession' | 'continueInterruptedTurn'>>

type WorkspaceCancellationRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'cancel'>
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const workspaceSession = (sessionId: string): ChatSession | undefined =>
  useSessionStore.getState().sessions.find((session) => session.id === sessionId)
const findUnansweredUserTurn = (messages: ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]

    if (message.role !== 'user' || isHiddenControlMessage(message)) continue

    const hasSuccessfulReply = messages
      .slice(index + 1)
      .some((later) => later.role === 'agent' && later.status !== 'error')

    return hasSuccessfulReply ? undefined : message
  }

  return undefined
}

const ensureWorkspaceSessionReady = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  agentTarget?: AcpSessionAgentTarget
): Promise<boolean> => {
  if (runtime.state.sessionIds.includes(sessionId) && !agentTarget) return false
  const session = workspaceSession(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const cwd = session.cwd || runtime.state.cwd
  if (!cwd) throw new Error('Choose a workspace folder before resuming this Session.')
  const resumed = await runtime.resumeSession(
    session.id,
    cwd,
    session.projectId,
    session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    session.agentFrameworkId,
    session.agentBackendId,
    session.specialistId,
    session.providerSessionId,
    session.providerContinuityToken,
    session.specialistBindingPending,
    agentTarget,
    session.memoryEnabled !== false
  )
  useSessionStore.getState().markResumed(
    session.id,
    resumed
      ? {
          agentFrameworkId: resumed.frameworkId,
          agentBackendId: resumed.backendId,
          providerSessionId: resumed.providerSessionId,
          providerContinuityToken: resumed.providerContinuityToken
        }
      : undefined
  )
  return resumed?.contextReset === true
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

  const session = workspaceSession(sessionId)
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

const resumeInterruptedWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  drainRuntimeEvents?: RuntimeEventDrain,
  options?: ResumeInterruptedWorkspaceSessionOptions
): Promise<void> => {
  const session = workspaceSession(sessionId)

  if (!session) return
  if (session.delegationPolicyAuthorityPending) {
    try {
      await confirmPendingDelegationPolicyAuthority(session)
    } catch (error) {
      useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
      return
    }
  }

  const runtimeAlreadyAttached =
    runtime.state.sessionIds.includes(sessionId) && !options?.agentTarget
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
      session.providerContinuityToken,
      session.specialistBindingPending,
      options?.agentTarget,
      session.memoryEnabled !== false
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

  const session = workspaceSession(sessionId)
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

// One live recovery may own a Session's compaction projection. Entries never leave renderer memory.
const contextOverflowRecoveryAttempts = new Map<string, object>()

const recoverContextOverflowWorkspaceSession = async (
  runtime: WorkspaceMessageRuntime,
  sessionId: string,
  supportsImageInput?: boolean,
  cancelledSessionIds?: Set<string>,
  historyReplayDescriptor?: HistoryReplayDescriptor,
  agentTarget?: AcpSessionAgentTarget,
  supportsImageRelay?: boolean
): Promise<boolean> => {
  const session = workspaceSession(sessionId)
  if (!session) return false
  const resumeCwd = session.cwd || runtime.state.cwd
  if (!resumeCwd) return false
  const interruptedTurn = findUnansweredUserTurn(session.messages)
  if (!interruptedTurn) return false

  const attempt = {}
  contextOverflowRecoveryAttempts.set(sessionId, attempt)
  useSessionStore.getState().beginCompaction(sessionId, { supersedeActiveRun: true })
  const frameId = session.conversationGraph?.activeFrameId
  const branchId = session.conversationGraph?.frames.find(
    (frame) => frame.id === frameId
  )?.activeBranchId
  let current = true
  const ownsCompaction = (): boolean => {
    const live = workspaceSession(sessionId)
    return (
      current &&
      contextOverflowRecoveryAttempts.get(sessionId) === attempt &&
      live?.compacting === true &&
      !live.activeRun &&
      live.createdAt === session.createdAt &&
      live.projectId === session.projectId &&
      live.conversationGraph?.activeFrameId === frameId &&
      live.conversationGraph?.frames.find((frame) => frame.id === frameId)?.activeBranchId ===
        branchId &&
      findUnansweredUserTurn(live.messages)?.id === interruptedTurn.id
    )
  }
  // Latch invalidation so switching away and back cannot revive a stale async continuation.
  const unsubscribe = useSessionStore.subscribe(() => {
    current = ownsCompaction()
  })
  const isCurrent = (): boolean => ownsCompaction() && !cancelledSessionIds?.has(sessionId)
  const finishCancelledRecovery = (): boolean => {
    if (!ownsCompaction() || cancelledSessionIds?.delete(sessionId) !== true) return false
    useSessionStore.getState().finishCompaction(sessionId)
    return true
  }

  try {
    const supportsNativeCompaction =
      runtime.state.nativeContextCompactionSessionIds?.includes(sessionId) === true &&
      runtime.compactSession !== undefined
    let nativeCompacted = false
    let postRecoveryState: WorkspaceMessageRuntime['state'] | undefined
    if (supportsNativeCompaction) {
      try {
        const compactedState = await runtime.compactSession?.(sessionId, 'overflow-recovery')
        postRecoveryState = compactedState ? { ...runtime.state, ...compactedState } : undefined
        nativeCompacted = Boolean(compactedState)
      } catch {
        // A current failed native control turn can still use replacement and history replay.
      }
      if (finishCancelledRecovery() || !isCurrent()) return false
    }
    if (!nativeCompacted) {
      let replacement
      try {
        replacement = await runtime.resetSessionContext(
          sessionId,
          resumeCwd,
          session.projectId,
          session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
          session.memoryEnabled !== false
        )
      } catch (error) {
        if (!finishCancelledRecovery() && isCurrent()) {
          useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
        }
        return false
      }
      if (finishCancelledRecovery() || !isCurrent()) return false
      replaceWorkspaceProviderIdentity(sessionId, replacement)
      const remainingPromptInFlightSessionIds = runtime.state.promptInFlightSessionIds.filter(
        (id) => id !== sessionId
      )
      postRecoveryState = {
        ...runtime.state,
        promptInFlight: remainingPromptInFlightSessionIds.length > 0,
        promptInFlightSessionIds: remainingPromptInFlightSessionIds
      }
    }
    if (finishCancelledRecovery() || !isCurrent()) return false
    const retryRuntime = { ...runtime, state: postRecoveryState ?? runtime.state }
    // A premature adapter response cannot release runtime ownership of a control turn.
    if (retryRuntime.state.promptInFlightSessionIds.includes(sessionId)) return false

    // Rearm the same unanswered Message. Admission failures must never fork or truncate its Branch.
    const retried = await sendWorkspaceMessage(
      retryRuntime,
      {
        sessionId,
        messageId: interruptedTurn.id,
        requireExistingSession: true,
        preserveSelection: true,
        text: interruptedTurn.content,
        annotations: interruptedTurn.annotations,
        attachments: (interruptedTurn.uploads ?? []).map((upload) =>
          toRuntimeUploadedAttachment(upload, session.projectId)
        ),
        parts: interruptedTurn.parts,
        pdfContext: interruptedTurn.pdfContext,
        cwd: resumeCwd,
        projectId: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        // Native compaction retained its own framework-authored summary. Only a replacement session needs
        // OpenScience to replay the prior transcript into its first prompt.
        forceHistoryReplay: !nativeCompacted,
        allowCompactionRecovery: true,
        supportsImageInput,
        supportsImageRelay,
        agentFrameworkId: agentTarget?.frameworkId,
        agentBackendId: agentTarget
          ? `${agentTarget.frameworkId}:${agentTarget.providerId}`
          : session.agentBackendId,
        agentModel: agentTarget?.model ?? session.agentModel,
        agentConfiguration: agentTarget
          ? {
              providerId: agentTarget.providerId,
              ...(agentTarget.model ? { model: agentTarget.model } : {}),
              reasoningEffort: agentTarget.reasoningEffort
            }
          : session.agentConfiguration,
        historyReplayDescriptor
      },
      { isCurrent }
    )
    if (finishCancelledRecovery()) return false
    if (!retried && isCurrent()) {
      useSessionStore.getState().failCompaction(sessionId, 'Agent run failed')
    }
    return Boolean(retried)
  } catch (error) {
    if (!finishCancelledRecovery() && isCurrent()) {
      useSessionStore
        .getState()
        .failCompaction(sessionId, getErrorMessage(error).trim() || 'Agent run failed')
    }
    return false
  } finally {
    unsubscribe()
    if (contextOverflowRecoveryAttempts.get(sessionId) === attempt) {
      contextOverflowRecoveryAttempts.delete(sessionId)
    }
  }
}

const cancelWorkspaceRun = async (
  runtime: WorkspaceCancellationRuntime,
  sessionId: string,
  cancelledSessionIds?: Set<string>
): Promise<void> => {
  const session = workspaceSession(sessionId)
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
    throw new Error('Agent cancellation failed')
  }
}
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
    void (async () => {
      let recoverySession = workspaceSession(sessionId)
      try {
        const pending = recover(runtime, sessionId)
        recoverySession = workspaceSession(sessionId)
        await pending
      } catch (error) {
        // The recovery owner handles expected failures. Contain unexpected setup/recovery errors
        // without allowing this scheduler fallback to alter a newer Session projection.
        if (workspaceSession(sessionId) === recoverySession) {
          useSessionStore.getState().failCompaction(sessionId, getErrorMessage(error))
        }
      } finally {
        activeRecoverySessionIds.delete(sessionId)
        setTimeout(
          () => recoveryCooldownSessionIds.delete(sessionId),
          CONTEXT_OVERFLOW_RECOVERY_COOLDOWN_MS
        )
      }
    })()
  }

  // Forget ids that fell out of the bounded runtime event window so the set cannot grow unbounded.
  const visibleIds = new Set(events.map((event) => event.id))

  for (const id of handledEventIds) {
    if (!visibleIds.has(id)) handledEventIds.delete(id)
  }
}

// Own retry dedup, cooldown, cancellation and admitted Agent targets across React renders.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the object is the seam.
const createWorkspaceRuntimeSessionLifecycleOwner = () => {
  const handledOverflowEventIds = new Set<string>()
  const overflowRecoveryCooldownSessionIds = new Set<string>()
  const activeOverflowRecoverySessionIds = new Set<string>()
  const cancelledOverflowRecoverySessionIds = new Set<string>()
  const memoryReconfigurationTails = new Map<string, Promise<void>>()
  const admittedAgentTargetBySessionId = new Map<string, AcpSessionAgentTarget>()
  const pruneAdmittedAgentTargets = (): void => {
    const liveSessionIds = new Set(useSessionStore.getState().sessions.map((session) => session.id))
    for (const sessionId of admittedAgentTargetBySessionId.keys()) {
      if (!liveSessionIds.has(sessionId)) admittedAgentTargetBySessionId.delete(sessionId)
    }
  }

  return {
    recordPromptAdmission(
      input: Pick<SendWorkspaceMessageIntent, 'sessionId'> & {
        agentTarget?: AcpSessionAgentTarget
      }
    ): void {
      if (!input.sessionId) return
      pruneAdmittedAgentTargets()
      if (input.agentTarget) {
        admittedAgentTargetBySessionId.set(input.sessionId, input.agentTarget)
      }
    },
    processRuntimeEvents(
      runtime: WorkspaceMessageRuntime,
      events: AcpRuntimeEvent[],
      options: {
        supportsImageRelay?: boolean
        getAgentTarget: (sessionId: string) => AcpSessionAgentTarget | undefined
        getSupportsImageInput: (sessionId: string) => boolean | undefined
        getHistoryReplayDescriptor: (sessionId: string) => HistoryReplayDescriptor
      }
    ): void {
      pruneAdmittedAgentTargets()
      processContextOverflowRecovery(
        runtime,
        events,
        handledOverflowEventIds,
        overflowRecoveryCooldownSessionIds,
        activeOverflowRecoverySessionIds,
        (recoveryRuntime, sessionId) => {
          cancelledOverflowRecoverySessionIds.delete(sessionId)
          return recoverContextOverflowWorkspaceSession(
            recoveryRuntime,
            sessionId,
            options.getSupportsImageInput(sessionId),
            cancelledOverflowRecoverySessionIds,
            options.getHistoryReplayDescriptor(sessionId),
            admittedAgentTargetBySessionId.get(sessionId) ?? options.getAgentTarget(sessionId),
            options.supportsImageRelay
          )
        }
      )
    },
    compact(runtime: WorkspaceMessageRuntime, sessionId: string): Promise<boolean> {
      return compactWorkspaceSession(runtime, sessionId)
    },
    async ensureReady(
      runtime: WorkspaceMessageRuntime,
      sessionId: string,
      agentTarget?: AcpSessionAgentTarget
    ): Promise<void> {
      await ensureWorkspaceSessionReady(runtime, sessionId, agentTarget)
    },
    reconfigureMemory(
      runtime: WorkspaceMessageRuntime,
      sessionId: string,
      enabled: boolean,
      onPreparationStateChange?: (sessionId: string, inFlight: boolean) => void,
      persistSession?: (sessionId: string) => Promise<void>,
      onSessionSizeLimit?: (sessionId: string) => void
    ): Promise<void> {
      const run = (): Promise<void> =>
        reconfigureWorkspaceMemory(
          runtime,
          sessionId,
          enabled,
          persistSession,
          onPreparationStateChange,
          onSessionSizeLimit
        )
      const previous = memoryReconfigurationTails.get(sessionId)
      const operation = previous ? previous.catch(() => undefined).then(run) : run()
      memoryReconfigurationTails.set(sessionId, operation)
      const clear = (): void => {
        if (memoryReconfigurationTails.get(sessionId) === operation) {
          memoryReconfigurationTails.delete(sessionId)
        }
      }
      void operation.then(clear, clear)
      return operation
    },
    resume(
      runtime: WorkspaceMessageRuntime,
      sessionId: string,
      drainRuntimeEvents: RuntimeEventDrain,
      options: ResumeInterruptedWorkspaceSessionOptions
    ): Promise<void> {
      return resumeInterruptedWorkspaceSession(runtime, sessionId, drainRuntimeEvents, options)
    },
    cancel(runtime: WorkspaceCancellationRuntime, sessionId: string): Promise<void> {
      admittedAgentTargetBySessionId.delete(sessionId)
      return cancelWorkspaceRun(
        runtime,
        sessionId,
        activeOverflowRecoverySessionIds.has(sessionId)
          ? cancelledOverflowRecoverySessionIds
          : undefined
      )
    }
  }
}

export {
  cancelWorkspaceRun,
  compactWorkspaceSession,
  createWorkspaceRuntimeSessionLifecycleOwner,
  ensureWorkspaceSessionReady,
  processContextOverflowRecovery,
  recoverContextOverflowWorkspaceSession,
  resumeInterruptedWorkspaceSession
}

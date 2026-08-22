import type { AcpMessageImage, AcpStateSnapshot } from '../../../../shared/acp'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../../../shared/settings'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import {
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_WORKSPACE_MISSING_MESSAGE
} from '../../../../shared/run-error-classification'
import { imageAttachmentMimeType, type UploadedAttachment } from '../../../../shared/uploads'
import {
  projectSessionActionability,
  resolveRootPermissionPending,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '../../stores/session-store'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  type HistoryReplayDescriptor
} from './history-preamble'
import type { useAcpRuntime } from './useAcpRuntime'
import {
  acquireWorkspacePromptPreparation,
  isWorkspacePromptPreparationInFlight
} from './workspace-prompt-preparation-lock'

type WorkspacePromptPreparationRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'resumeSession' | 'resetSessionContext'
>

type HistoryReplayContext = {
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpMessageImage[]
}

type PrepareExistingWorkspacePromptRequest = {
  sessionId: string
  requireExistingSession?: boolean
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  selectedRuntime: {
    frameworkId?: AgentFrameworkId
    backendId?: string
    agentConfiguration?: SessionAgentConfiguration
    supportsImageInput?: boolean
    supportsImageRelay?: boolean
  }
  replay: {
    descriptor?: HistoryReplayDescriptor
    cutMessageId?: string
    force?: boolean
    includeResumeFallback?: boolean
  }
  onPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
}

type PreparedWorkspacePromptReplay = HistoryReplayContext & {
  resumeFallback?: HistoryReplayContext
  contextReset: boolean
}

type PreparedExistingWorkspacePrompt = {
  appendOwnership: {
    projectId?: string
    agentFrameworkId?: AgentFrameworkId
    agentBackendId?: string
  }
  replay: () => PreparedWorkspacePromptReplay
  acceptPrompt: (messageId: string) => void
}

type ExistingWorkspacePromptAdmission = Readonly<{
  sessionId: string
  session: ChatSession | undefined
  runtimeState: Pick<AcpStateSnapshot, 'pendingPermissions' | 'promptInFlightSessionIds'>
  allowCompactionRecovery: boolean
}>

const canPrepareExistingWorkspacePrompt = ({
  sessionId,
  session,
  runtimeState,
  allowCompactionRecovery
}: ExistingWorkspacePromptAdmission): boolean =>
  !isWorkspacePromptPreparationInFlight(sessionId) &&
  !runtimeState.promptInFlightSessionIds.includes(sessionId) &&
  (!session?.compacting || allowCompactionRecovery) &&
  (!session ||
    projectSessionActionability(session, {
      rootPermissionPending: resolveRootPermissionPending(
        runtimeState.pendingPermissions,
        sessionId
      ),
      allowPendingSessionRetry: Boolean(
        session.isPending && (session.status !== 'idle' || !session.branchSource)
      )
    }).actions.startTurn.allowed)

const isReplayImage = (attachment: Pick<UploadedAttachment, 'name' | 'mimeType'>): boolean =>
  imageAttachmentMimeType(attachment.name, attachment.mimeType) !== undefined

const hasHistoryImages = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) => (message.images?.length ?? 0) > 0 || message.uploads?.some(isReplayImage) === true
  )

const supportsReplayImages = (
  runtime: PrepareExistingWorkspacePromptRequest['selectedRuntime']
): boolean | undefined =>
  runtime.supportsImageInput === false
    ? runtime.supportsImageRelay === true
    : runtime.supportsImageInput

const replayAttachmentsForModel = (
  replay: HistoryReplayContext | undefined,
  supportsImageInput: boolean | undefined
): UploadedAttachment[] | undefined => {
  if (supportsImageInput !== false) return replay?.historyAttachments
  const attachments = replay?.historyAttachments?.filter((attachment) => !isReplayImage(attachment))
  return attachments?.length ? attachments : undefined
}

const buildReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor | undefined,
  frameworkId: AgentFrameworkId | undefined,
  projectId: string | undefined,
  supportsImageInput: boolean | undefined
): HistoryReplayContext | undefined =>
  buildWorkspaceHistoryReplay(
    messages,
    descriptor ?? { target: resolveHistoryReplayTarget(frameworkId) },
    projectId,
    supportsImageInput
  )

const shutdownNotebookForBranchChange = async (
  sessionId: string,
  workspaceCwd: string,
  projectId?: string
): Promise<void> => {
  if (typeof window === 'undefined' || !window.api?.notebook?.shutdown) return
  await window.api.notebook.shutdown({ sessionId, workspaceCwd, projectId })
}

const unwrapIpcErrorDetail = (message: string): string =>
  message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error(?::\s*|$)/i, '')
    .trim()

const RESUME_UNKNOWN_ERROR_MESSAGE = 'Agent session resume failed: Unknown error'

const getResumeFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  if (/cwd does not exist/i.test(message)) return RESUME_WORKSPACE_MISSING_MESSAGE
  if (/timed out/i.test(message)) return RESUME_TIMED_OUT_MESSAGE
  if (/does not support session resume/i.test(message)) return RESUME_UNSUPPORTED_MESSAGE
  if (/connection (failed|was superseded)|ACP connection/i.test(message)) {
    return RESUME_RECONNECT_FAILED_MESSAGE
  }
  if (/active model isn'?t compatible with/i.test(message)) {
    return RESUME_MODEL_INCOMPATIBLE_MESSAGE
  }

  const detail = unwrapIpcErrorDetail(message)
  if (detail === 'RequestError: Internal error' || detail === 'Internal error') {
    return RESUME_UNKNOWN_ERROR_MESSAGE
  }
  return detail ? `Agent session resume failed: ${detail}` : RESUME_UNKNOWN_ERROR_MESSAGE
}

const prepareExistingWorkspacePrompt = async (
  runtime: WorkspacePromptPreparationRuntime,
  request: PrepareExistingWorkspacePromptRequest
): Promise<PreparedExistingWorkspacePrompt | undefined> => {
  const { sessionId } = request
  const currentSession = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)
  const selectedRuntimeChanged = Boolean(
    (request.selectedRuntime.frameworkId &&
      currentSession?.agentFrameworkId &&
      request.selectedRuntime.frameworkId !== currentSession.agentFrameworkId) ||
    (request.selectedRuntime.backendId &&
      currentSession?.agentBackendId &&
      request.selectedRuntime.backendId !== currentSession.agentBackendId)
  )
  const runtimeDetached = !runtime.state.sessionIds.includes(sessionId)
  // An explicit Session target must pass through resume even when the aggregate coordinator snapshot
  // still shows this app Session as attached. A provider/model/effort change can keep the same backend
  // id, while ownership still needs to move to the runtime generation keyed by the new target.
  const runtimeMustAdoptSession =
    Boolean(request.selectedRuntime.frameworkId && request.selectedRuntime.agentConfiguration) ||
    selectedRuntimeChanged ||
    runtimeDetached
  const branchResetRequired = Boolean(
    request.replay.cutMessageId || currentSession?.branchContextResetRequired
  )
  const resumeNeedsImageFiltering =
    runtimeMustAdoptSession &&
    request.selectedRuntime.supportsImageInput === false &&
    hasHistoryImages(currentSession?.messages ?? [])
  const replaySupportsImageInput = supportsReplayImages(request.selectedRuntime)
  const preparationRequired = branchResetRequired || runtimeMustAdoptSession

  const releasePreparation = preparationRequired
    ? acquireWorkspacePromptPreparation(sessionId, request.onPreparationStateChange)
    : undefined
  if (preparationRequired && !releasePreparation) return undefined

  let branchContextResetPerformed = false
  let agentContextResetPerformed = false
  let shouldResumeSession = false
  let contextResetFromResume = false
  const specialistSwitchReplay = Boolean(currentSession?.specialistSwitchResetRequired)
  if (specialistSwitchReplay) {
    useSessionStore.getState().clearSpecialistSwitchResetRequired(sessionId)
  }

  try {
    if (branchResetRequired) {
      const resetCwd = request.cwd || currentSession?.cwd || runtime.state.cwd
      if (!resetCwd) {
        useSessionStore.getState().failRun(sessionId, RESUME_WORKSPACE_MISSING_MESSAGE)
        return undefined
      }

      await shutdownNotebookForBranchChange(sessionId, resetCwd, request.projectId)
      if (!selectedRuntimeChanged && !runtimeDetached) {
        const reset = await runtime.resetSessionContext(
          sessionId,
          resetCwd,
          request.projectId,
          currentSession?.permissionProfile ?? request.permissionProfile
        )
        useSessionStore.getState().markResumed(
          sessionId,
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
      const resumeCwd = request.cwd || runtime.state.cwd
      if (!resumeCwd) {
        useSessionStore.getState().failRun(sessionId, RESUME_WORKSPACE_MISSING_MESSAGE)
        return undefined
      }

      const resumeArguments = [
        sessionId,
        resumeCwd,
        request.projectId,
        currentSession?.permissionProfile ?? request.permissionProfile,
        currentSession?.agentFrameworkId,
        currentSession?.agentBackendId,
        currentSession?.specialistId,
        currentSession?.providerSessionId,
        currentSession?.providerContinuityToken,
        currentSession?.specialistBindingPending
      ] as const
      const target =
        request.selectedRuntime.frameworkId && request.selectedRuntime.agentConfiguration
          ? {
              frameworkId: request.selectedRuntime.frameworkId,
              ...request.selectedRuntime.agentConfiguration
            }
          : undefined
      const resumeResult = target
        ? await runtime.resumeSession(...resumeArguments, target)
        : await runtime.resumeSession(...resumeArguments)
      contextResetFromResume = Boolean(resumeResult?.contextReset)
      useSessionStore.getState().markResumed(
        sessionId,
        resumeResult
          ? {
              agentFrameworkId: resumeResult.frameworkId,
              agentBackendId: resumeResult.backendId,
              providerSessionId: resumeResult.providerSessionId,
              providerContinuityToken: resumeResult.providerContinuityToken
            }
          : undefined
      )

      if ((branchContextResetPerformed || resumeNeedsImageFiltering) && !contextResetFromResume) {
        const reset = await runtime.resetSessionContext(
          sessionId,
          resumeCwd,
          request.projectId,
          currentSession?.permissionProfile ?? request.permissionProfile
        )
        useSessionStore.getState().markResumed(
          sessionId,
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

      // #936: accepted events from the retired generation must settle before the next run opens.
      await request.drainRuntimeEvents?.(sessionId)
    }
  } catch (error) {
    useSessionStore.getState().failRun(sessionId, getResumeFailureMessage(error))
    return undefined
  } finally {
    releasePreparation?.()
  }

  const preparedSession = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)
  // A known existing session deleted during async adoption must not be recreated. An attached runtime
  // id without a local projection still uses appendUserMessage's existing generic creation seam.
  if ((currentSession || request.requireExistingSession) && !preparedSession) return undefined

  const historyCutIndex = request.replay.cutMessageId
    ? (preparedSession?.messages.findIndex(
        (message) => message.id === request.replay.cutMessageId
      ) ?? -1)
    : -1
  if (request.replay.cutMessageId && historyCutIndex < 0) return undefined

  const pendingHistoryReplay = preparedSession?.pendingHistoryReplay
  const resumeReplayCutMessageId =
    pendingHistoryReplay?.kind === 'before-message' ? pendingHistoryReplay.messageId : undefined
  const resumeReplayCutIndex = resumeReplayCutMessageId
    ? (preparedSession?.messages.findIndex((message) => message.id === resumeReplayCutMessageId) ??
      -1)
    : -1
  // If the selected Branch no longer contains an interrupted prompt cutoff, replay the Branch in full.
  const historyMessages = (
    preparedSession && historyCutIndex >= 0
      ? preparedSession.messages.slice(0, historyCutIndex)
      : preparedSession && resumeReplayCutIndex >= 0
        ? preparedSession.messages.slice(0, resumeReplayCutIndex)
        : preparedSession?.messages
  )?.filter((message) => message.id !== preparedSession?.pendingContextReplayMessageId)
  const contextReset = Boolean(
    branchContextResetPerformed ||
    contextResetFromResume ||
    request.replay.force ||
    specialistSwitchReplay ||
    preparedSession?.pendingContextReplayMessageId ||
    pendingHistoryReplay
  )

  const createReplay = (): PreparedWorkspacePromptReplay => {
    const replay =
      contextReset && historyMessages
        ? buildReplay(
            historyMessages,
            request.replay.descriptor,
            request.selectedRuntime.frameworkId,
            request.projectId,
            replaySupportsImageInput
          )
        : undefined
    const includeResumeFallback = Boolean(request.replay.includeResumeFallback && historyMessages)
    const fallback =
      includeResumeFallback && historyMessages
        ? buildReplay(
            historyMessages,
            request.replay.descriptor,
            request.selectedRuntime.frameworkId,
            request.projectId,
            replaySupportsImageInput
          )
        : undefined

    return {
      historyPreamble: replay?.historyPreamble,
      historyAttachments: replayAttachmentsForModel(replay, replaySupportsImageInput),
      historyImages: replaySupportsImageInput === false ? undefined : replay?.historyImages,
      resumeFallback: includeResumeFallback
        ? {
            historyPreamble: fallback?.historyPreamble,
            historyAttachments: replayAttachmentsForModel(fallback, replaySupportsImageInput),
            historyImages: replaySupportsImageInput === false ? undefined : fallback?.historyImages
          }
        : undefined,
      contextReset
    }
  }

  return {
    appendOwnership: {
      projectId: preparedSession?.projectId,
      agentFrameworkId: shouldResumeSession
        ? request.selectedRuntime.frameworkId
        : preparedSession?.agentFrameworkId,
      agentBackendId: shouldResumeSession
        ? request.selectedRuntime.backendId
        : preparedSession?.agentBackendId
    },
    replay: createReplay,
    acceptPrompt: (messageId) => {
      if (branchContextResetPerformed) {
        useSessionStore.getState().clearBranchContextReset(sessionId)
      }
      if (preparedSession?.pendingContextReplayMessageId) {
        useSessionStore.getState().clearPendingContextReplay(sessionId, messageId)
      }
      if (pendingHistoryReplay) {
        useSessionStore.getState().clearPendingHistoryReplay(sessionId, pendingHistoryReplay)
      }
    }
  }
}

export {
  acquireWorkspacePromptPreparation,
  canPrepareExistingWorkspacePrompt,
  getResumeFailureMessage,
  isWorkspacePromptPreparationInFlight,
  prepareExistingWorkspacePrompt,
  shutdownNotebookForBranchChange
}
export type { PrepareExistingWorkspacePromptRequest, PreparedExistingWorkspacePrompt }

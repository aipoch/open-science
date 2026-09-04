import {
  isDurableAgentUserChoiceRequest,
  type AcpSessionAgentTarget,
  type ElicitationResponse
} from '../../../../shared/acp'
import { DEFAULT_PERMISSION_PROFILE } from '../../../../shared/permission-profiles'
import { RESUME_WORKSPACE_MISSING_MESSAGE } from '../../../../shared/run-error-classification'
import type { AgentFrameworkId } from '../../../../shared/settings'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import { useSessionStore, type ChatMessage, type ChatSession } from '../../stores/session-store'
import type { useAcpRuntime } from './useAcpRuntime'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  type HistoryReplayDescriptor
} from './history-preamble'
import { syncWorkspaceInteractionStateFromSnapshot } from './useWorkspaceAgentRuntime'
import { acquireWorkspacePromptPreparation } from './workspace-prompt-preparation-lock'

type WorkspaceElicitationRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'resumeSession' | 'respondToElicitation'
> &
  Partial<Pick<ReturnType<typeof useAcpRuntime>, 'resetSessionContext'>>

type WorkspaceElicitationOptions = {
  supportsImageInput?: boolean
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  agentTarget?: AcpSessionAgentTarget
  historyReplayDescriptor?: HistoryReplayDescriptor
  onSendPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
  flushPersistence?: () => Promise<void>
}

const buildElicitationReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor | undefined,
  frameworkId: AgentFrameworkId | undefined,
  projectId: string | undefined,
  supportsImageInput: boolean | undefined
): ReturnType<typeof buildWorkspaceHistoryReplay> =>
  buildWorkspaceHistoryReplay(
    messages,
    descriptor ?? { target: resolveHistoryReplayTarget(frameworkId) },
    projectId,
    supportsImageInput
  )

const assertElicitationRevisionIdle = (
  runtime: WorkspaceElicitationRuntime,
  session: ChatSession
): void => {
  if (
    session.status === 'running' ||
    session.status === 'waiting-for-user' ||
    session.status === 'waiting-permission' ||
    session.activeRun ||
    runtime.state.promptInFlightSessionIds.includes(session.id)
  ) {
    throw new Error('Wait for the current Agent run to finish before changing this answer.')
  }
}

const isMessageBeforeElicitation = (
  message: ChatMessage,
  activity: { createdAt: number; sortIndex: number }
): boolean =>
  message.createdAt < activity.createdAt ||
  (message.createdAt === activity.createdAt &&
    message.sortIndex !== undefined &&
    message.sortIndex < activity.sortIndex)

const restoreElicitationRevisionProjection = (projection: ChatSession): void => {
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((candidate) =>
      candidate.id === projection.id
        ? {
            ...candidate,
            status: projection.status,
            messages: projection.messages,
            activities: projection.activities,
            activityGroups: projection.activityGroups,
            conversationGraph: projection.conversationGraph,
            activeRun: projection.activeRun,
            filesRevision: projection.filesRevision,
            updatedAt: projection.updatedAt,
            branchContextResetRequired: true
          }
        : candidate
    )
  }))
}

const shutdownNotebookForElicitationRevision = async (
  sessionId: string,
  workspaceCwd: string,
  projectId?: string
): Promise<void> => {
  if (typeof window === 'undefined' || !window.api?.notebook?.shutdown) return
  await window.api.notebook.shutdown({ sessionId, workspaceCwd, projectId })
}

const reviseWorkspaceElicitation = async (
  runtime: WorkspaceElicitationRuntime,
  response: ElicitationResponse,
  options: WorkspaceElicitationOptions
): Promise<void> => {
  const restoredRequest = response.request?.durable ? response.request : undefined
  if (!restoredRequest?.durable) {
    throw new Error('The answered question is no longer available to edit.')
  }
  if (!runtime.resetSessionContext) {
    throw new Error('The selected Agent cannot rewind this answer.')
  }

  const sessionId = restoredRequest.sessionId
  const releasePreparation = acquireWorkspacePromptPreparation(
    sessionId,
    options.onSendPreparationStateChange
  )
  if (!releasePreparation) {
    throw new Error('Another Agent context update is already in progress.')
  }

  let rollbackProjection: ChatSession | undefined
  let contextMayNeedReplay = false
  try {
    let session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    assertElicitationRevisionIdle(runtime, session)

    const selectedRuntimeChanged = Boolean(
      options.agentTarget ||
      (options.agentFrameworkId && options.agentFrameworkId !== session.agentFrameworkId) ||
      (options.agentBackendId && options.agentBackendId !== session.agentBackendId)
    )
    const runtimeDetached = !runtime.state.sessionIds.includes(sessionId)
    let contextResetFromResume = false
    const cwd = session.cwd || runtime.state.cwd
    if (!cwd) throw new Error(RESUME_WORKSPACE_MISSING_MESSAGE)

    if (selectedRuntimeChanged || runtimeDetached) {
      contextMayNeedReplay = true
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
        options.agentTarget,
        session.memoryEnabled !== false
      )
      contextResetFromResume = Boolean(resumed?.contextReset)
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
      await options.drainRuntimeEvents?.(session.id)
      session = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
    }

    assertElicitationRevisionIdle(runtime, session)
    const activity = session.activities?.find(
      (candidate) => candidate.id === restoredRequest.toolCallId
    )
    if (!activity?.elicitation?.durable) {
      throw new Error('The answered question is no longer available to edit.')
    }

    const promptMessageId = activity.promptMessageId ?? restoredRequest.durable.promptMessageId
    const promptIndex = promptMessageId
      ? session.messages.findIndex((message) => message.id === promptMessageId)
      : -1
    const retainedMessages = session.messages.filter(
      (message, index) => isMessageBeforeElicitation(message, activity) || index <= promptIndex
    )
    if (retainedMessages.length === 0) {
      throw new Error('The conversation before this question could not be restored.')
    }
    const replay = buildElicitationReplay(
      retainedMessages,
      options.historyReplayDescriptor,
      session.agentFrameworkId,
      session.projectId,
      options.supportsImageInput
    )
    if (!replay) {
      throw new Error('The conversation before this question could not be restored.')
    }

    rollbackProjection = session
    contextMayNeedReplay = true
    await shutdownNotebookForElicitationRevision(session.id, cwd, session.projectId)
    if (!contextResetFromResume) {
      const reset = await runtime.resetSessionContext(
        session.id,
        cwd,
        session.projectId,
        session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        session.memoryEnabled !== false
      )
      useSessionStore.getState().markResumed(
        session.id,
        reset
          ? {
              agentFrameworkId: reset.frameworkId,
              agentBackendId: reset.backendId,
              providerSessionId: reset.providerSessionId,
              providerContinuityToken: reset.providerContinuityToken
            }
          : undefined
      )
      rollbackProjection =
        useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId) ??
        rollbackProjection
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === sessionId
          ? { ...candidate, agentModel: options.agentModel?.trim() || undefined }
          : candidate
      )
    }))
    session = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)!
    rollbackProjection = session

    const responseToSend: ElicitationResponse = {
      ...response,
      request: {
        ...restoredRequest,
        toolCallId: `ask-user-question-revision-${globalThis.crypto.randomUUID()}`,
        durable: {
          ...restoredRequest.durable,
          ...(promptMessageId ? { promptMessageId } : {})
        }
      },
      historyReplay: replay
    }

    if (!useSessionStore.getState().reviseSessionFromElicitation(session.id, activity.id)) {
      throw new Error('The conversation could not rewind to this question.')
    }
    await (options.flushPersistence ?? flushSessionPersistence)()
    const snapshot = await runtime.respondToElicitation(responseToSend)
    const acceptedSnapshot = syncWorkspaceInteractionStateFromSnapshot(snapshot)
    if (
      acceptedSnapshot &&
      !snapshot.pendingElicitations?.some(
        (request) =>
          request.sessionId === restoredRequest.sessionId &&
          isDurableAgentUserChoiceRequest(request)
      )
    ) {
      useSessionStore.getState().setElicitationPending(restoredRequest.sessionId, false)
    }
  } catch (error) {
    if (rollbackProjection) {
      restoreElicitationRevisionProjection(rollbackProjection)
    } else if (contextMayNeedReplay) {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId
            ? { ...candidate, branchContextResetRequired: true }
            : candidate
        )
      }))
    }
    throw error
  } finally {
    releasePreparation()
  }
}

const respondToWorkspaceElicitation = async (
  runtime: WorkspaceElicitationRuntime,
  response: ElicitationResponse,
  options: WorkspaceElicitationOptions = {}
): Promise<void> => {
  if (response.replacePreviousAnswer) {
    await reviseWorkspaceElicitation(runtime, response, options)
    return
  }

  let responseToSend = response
  const restoredRequest = response.request?.durable ? response.request : undefined
  let session = restoredRequest
    ? useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === restoredRequest.sessionId)
    : undefined
  if (restoredRequest && !session) {
    throw new Error(`Session not found: ${restoredRequest.sessionId}`)
  }

  if (restoredRequest && session && !runtime.state.sessionIds.includes(restoredRequest.sessionId)) {
    const cwd = session.cwd || runtime.state.cwd
    if (!cwd) throw new Error(RESUME_WORKSPACE_MISSING_MESSAGE)

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
      options.agentTarget,
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
    useSessionStore.getState().setElicitationPending(session.id, true)
    session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === restoredRequest.sessionId)
    if (!session) throw new Error(`Session not found: ${restoredRequest.sessionId}`)

    if (resumed?.contextReset) {
      useSessionStore
        .getState()
        .setElicitationHistoryReplayRequest(session.id, restoredRequest.requestId)
    }
  }

  const historyReplayRequired =
    !!restoredRequest &&
    useSessionStore
      .getState()
      .sessions.some(
        (candidate) =>
          candidate.id === restoredRequest.sessionId &&
          candidate.elicitationHistoryReplayRequestId === restoredRequest.requestId
      )
  if (session && historyReplayRequired) {
    const replay = buildElicitationReplay(
      session.messages,
      options.historyReplayDescriptor,
      session.agentFrameworkId,
      session.projectId,
      options.supportsImageInput
    )
    responseToSend = {
      ...response,
      historyReplay: {
        historyPreamble: replay?.historyPreamble,
        historyAttachments: replay?.historyAttachments,
        historyImages: replay?.historyImages
      }
    }
  }

  const snapshot = await runtime.respondToElicitation(responseToSend)
  const acceptedSnapshot = syncWorkspaceInteractionStateFromSnapshot(snapshot)
  const sessionId =
    response.request?.sessionId ??
    runtime.state.pendingElicitations?.find((request) => request.requestId === response.requestId)
      ?.sessionId
  if (
    acceptedSnapshot &&
    sessionId &&
    !snapshot.pendingElicitations?.some(
      (request) => request.sessionId === sessionId && isDurableAgentUserChoiceRequest(request)
    )
  ) {
    useSessionStore.getState().setElicitationPending(sessionId, false)
  }
  if (session && historyReplayRequired) {
    useSessionStore.getState().setElicitationHistoryReplayRequest(session.id)
  }
}

export { respondToWorkspaceElicitation }
export type { WorkspaceElicitationOptions, WorkspaceElicitationRuntime }

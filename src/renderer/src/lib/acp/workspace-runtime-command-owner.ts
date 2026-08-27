import type { AcpMessageImage, AcpRuntimeEvent } from '../../../../shared/acp'
import type { FileReference } from '../../../../shared/artifacts'
import * as annotationProtocol from '../../../../shared/annotations'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import {
  collectSessionReferences,
  type MessagePart,
  type SessionReference
} from '../../../../shared/session-persistence'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../../../shared/settings'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import {
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from '../../../../shared/uploads'
import { getActiveConversationContext } from '../../../../shared/conversation-graph'
import { saveSessionInOrder } from '../session-persistence/session-persistence'
import { toPersistedSession, useSessionStore, type ChatMessage } from '../../stores/session-store'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  canAdmitExistingWorkspacePrompt,
  prepareExistingWorkspacePrompt
} from './workspace-runtime-prompt-preparation-owner'
import {
  branchWorkspaceSessionFromMessage,
  reconcileBranchedAttachments
} from './workspace-runtime-session-branch-owner'
import {
  finalizeWorkspaceAttachments,
  partitionWorkspacePromptAttachments
} from './workspace-runtime-attachment-owner'
import type { useAcpRuntime } from './useAcpRuntime'
import { validateImageAnnotationSourcesBeforeSend } from '../../pages/workspace/annotations/image-annotation-source-validation'
type SendWorkspaceMessageIntent = {
  sessionId?: string
  branchSourceSessionId?: string
  branchSourceMessageId?: string
  text: string
  turnIntent?: 'plan-first'
  planContinuation?: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'> & {
    pendingAction?: 'review' | 'approve' | 'reject'
  }
  attachments?: UploadedAttachment[]
  annotations?: annotationProtocol.Annotation[]
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  parts?: MessagePart[]
  specialistId?: string | null
  enabledComputeHosts?: string[]
  selectedComputeHosts?: string[]
  agentConfiguration?: SessionAgentConfiguration
  preserveSelection?: boolean
}
type SendWorkspaceMessageCommand = SendWorkspaceMessageIntent & {
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  historyReplayDescriptor?: HistoryReplayDescriptor
  forceHistoryReplay?: boolean
  supportsImageInput?: boolean
  supportsImageRelay?: boolean
  truncateFromMessageId?: string
  allowCompactionRecovery?: boolean
  requireExistingSession?: boolean
}
type SendWorkspaceMessageResult = { sessionId: string; messageId: string }
type WorkspaceCommandLifecycle = {
  onSendPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void
}
type ResendEditedMessageInput = {
  text: string
  annotations?: annotationProtocol.Annotation[]
  parts?: MessagePart[]
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
}
type ResendEditedWorkspaceMessageOptions = WorkspaceCommandLifecycle & {
  supportsImageInput?: boolean
  supportsImageRelay?: boolean
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  agentConfiguration?: SessionAgentConfiguration
  historyReplayDescriptor?: HistoryReplayDescriptor
}
type WorkspaceCommandRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'resetSessionContext' | 'sendPrompt'
> &
  Partial<Pick<ReturnType<typeof useAcpRuntime>, 'currentRuntimeEvents' | 'deleteSession'>>
type HistoryReplayContext = {
  historyPreamble?: string
  historyAttachments?: UploadedAttachment[]
  historyImages?: AcpMessageImage[]
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const createSessionFailureMessage = (error: unknown): string =>
  errorMessage(error)
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error(?::\s*|$)/i, '')
    .trim() || 'Agent session could not be created.'
const latestFailureId = (events: AcpRuntimeEvent[], sessionId: string): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.kind === 'error' && event.sessionId === sessionId) return event.id
  }
  return undefined
}
const failPrompt = async (
  sessionId: string,
  message: string,
  priorErrorEventId?: string
): Promise<void> => {
  if (useSessionStore.getState().sessions.find((item) => item.id === sessionId)?.compacting) return

  let reportable: boolean | undefined
  try {
    const snapshot = await window.api.acp.getState()
    const status = snapshot.sessionConnectionStatuses?.[sessionId] ?? snapshot.status
    if (status === 'closed' || status === 'error') {
      useSessionStore.getState().markDisconnected(sessionId, message)
      return
    }
    const event = [...snapshot.events]
      .reverse()
      .find((item) => item.kind === 'error' && item.sessionId === sessionId)
    if (event && event.id !== priorErrorEventId && event.providerError) reportable = false
  } catch {
    reportable = undefined
  }
  useSessionStore.getState().failRun(sessionId, message, { reportable })
}
const replayHistory = (
  messages: ChatMessage[],
  input: SendWorkspaceMessageCommand,
  projectId?: string
): HistoryReplayContext | undefined =>
  buildWorkspaceHistoryReplay(
    messages,
    input.historyReplayDescriptor ?? { target: resolveHistoryReplayTarget(input.agentFrameworkId) },
    projectId,
    input.supportsImageInput === true || input.supportsImageRelay === true
      ? true
      : input.supportsImageInput
  )

const promptContext = (
  sessionId: string,
  messageId: string
): ReturnType<typeof getActiveConversationContext> | { promptMessageId: string } => {
  const graph = useSessionStore
    .getState()
    .sessions.find((item) => item.id === sessionId)?.conversationGraph
  return graph ? getActiveConversationContext(graph, messageId) : { promptMessageId: messageId }
}

const ownsPrompt = (sessionId: string, messageId: string): boolean => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
  return session?.status === 'running' && session.activeRun?.promptMessageId === messageId
}

const isOverlappingPromptRejection = (error: unknown): boolean =>
  /An ACP (?:prompt|interaction) is already running/i.test(errorMessage(error))

type PromptDispatch = {
  sessionId: string
  messageId: string
  content: string
  annotations?: annotationProtocol.Annotation[]
  attachments: UploadedAttachment[]
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  referencedSessions?: SessionReference[]
  replay?: HistoryReplayContext & {
    resumeFallback?: HistoryReplayContext
    contextReset?: boolean
  }
  continuation?: Parameters<WorkspaceCommandRuntime['sendPrompt']>[11]
  turnIntent?: SendWorkspaceMessageIntent['turnIntent']
  accepted?: () => void
}

const dispatchPrompt = (runtime: WorkspaceCommandRuntime, request: PromptDispatch): void => {
  const priorErrorEventId = latestFailureId(
    [...(runtime.currentRuntimeEvents?.() ?? runtime.state.events)],
    request.sessionId
  )
  const preparedAnnotations = annotationProtocol.prepareAnnotationsForAgent(
    request.content,
    request.annotations ?? [],
    request.referencedArtifacts
  )
  const args = [
    request.sessionId,
    preparedAnnotations.promptText,
    request.attachments,
    request.forcedSkillIds,
    preparedAnnotations.referencedArtifacts,
    request.replay?.historyPreamble,
    request.replay?.historyAttachments,
    request.replay?.historyImages,
    request.replay?.resumeFallback,
    promptContext(request.sessionId, request.messageId),
    request.replay?.contextReset
  ] as const
  const result = request.referencedSessions?.length
    ? runtime.sendPrompt(
        ...args,
        request.continuation,
        request.turnIntent,
        request.referencedSessions
      )
    : request.turnIntent
      ? runtime.sendPrompt(...args, request.continuation, request.turnIntent)
      : request.continuation
        ? runtime.sendPrompt(...args, request.continuation)
        : runtime.sendPrompt(...args)
  void result
    .then(() => request.accepted?.())
    .catch((error) => {
      if (isOverlappingPromptRejection(error) && !ownsPrompt(request.sessionId, request.messageId))
        return
      const message = errorMessage(error).trim() || 'Agent run failed'
      void failPrompt(request.sessionId, message, priorErrorEventId)
    })
}

type PendingPromptRequest = SendWorkspaceMessageCommand & {
  pending: SendWorkspaceMessageResult
  content: string
  attachments: UploadedAttachment[]
  permissionProfile: PermissionProfileId
  specialistId?: string
  replay?: HistoryReplayContext
  contextReset?: boolean
}

const startPendingPrompt = (
  runtime: WorkspaceCommandRuntime,
  request: PendingPromptRequest,
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void
): void => {
  void (async () => {
    const pending = request.pending
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return
    let created
    try {
      const target =
        request.agentFrameworkId && request.agentConfiguration
          ? { frameworkId: request.agentFrameworkId, ...request.agentConfiguration }
          : undefined
      created = target
        ? await runtime.createSession(
            request.cwd,
            request.projectId,
            request.permissionProfile,
            request.specialistId ?? undefined,
            target
          )
        : await runtime.createSession(
            request.cwd,
            request.projectId,
            request.permissionProfile,
            request.specialistId ?? undefined
          )
    } catch (error) {
      if (ownsPrompt(pending.sessionId, pending.messageId)) {
        useSessionStore.getState().failRun(pending.sessionId, createSessionFailureMessage(error))
      }
      return
    }
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return
    if (!created?.sessionId) {
      useSessionStore.getState().failRun(pending.sessionId, 'Agent session could not be created.')
      return
    }
    const cwd = created.cwd ?? request.cwd
    if (!cwd) {
      useSessionStore
        .getState()
        .failRun(pending.sessionId, 'Agent session did not return a workspace.')
      return
    }
    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending.sessionId,
      sessionId: created.sessionId,
      cwd,
      agentFrameworkId: created.frameworkId,
      agentBackendId: created.backendId,
      providerSessionId: created.providerSessionId,
      providerContinuityToken: created.providerContinuityToken
    })
    onSessionBound?.(pending.sessionId, created.sessionId)
    const boundMessageId = bound?.messageId
    if (!boundMessageId || !ownsPrompt(created.sessionId, boundMessageId)) return

    let attachments = request.attachments
    try {
      attachments = await finalizeWorkspaceAttachments({
        sessionId: created.sessionId,
        attachments,
        projectId: request.projectId
      })
      useSessionStore.getState().replaceMessageUploads({
        sessionId: created.sessionId,
        messageId: boundMessageId,
        uploads: attachments.map(toPersistedUploadedAttachment)
      })
    } catch (error) {
      useSessionStore.getState().failRun(created.sessionId, errorMessage(error))
      return
    }
    if (!ownsPrompt(created.sessionId, boundMessageId)) return

    const boundSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === created.sessionId)
    if (boundSession?.enabledComputeHosts?.length) {
      try {
        await saveSessionInOrder(toPersistedSession(boundSession))
      } catch (error) {
        try {
          const snapshot = await runtime.deleteSession?.(created.sessionId)
          if (
            runtime.deleteSession &&
            (!snapshot || snapshot.sessionIds.includes(created.sessionId))
          ) {
            console.warn('Agent Session cleanup after persistence failure did not complete')
          }
        } catch (cleanupError) {
          console.warn('Agent Session cleanup after persistence failure failed', cleanupError)
        }
        if (ownsPrompt(created.sessionId, boundMessageId)) {
          useSessionStore.getState().failRun(created.sessionId, errorMessage(error))
        }
        return
      }
      if (!ownsPrompt(created.sessionId, boundMessageId)) return
    }

    dispatchPrompt(runtime, {
      sessionId: created.sessionId,
      messageId: boundMessageId,
      content: request.content,
      annotations: request.annotations,
      attachments,
      forcedSkillIds: request.forcedSkillIds,
      referencedArtifacts: request.referencedArtifacts,
      referencedSessions: collectSessionReferences(request.parts),
      replay: { ...request.replay, contextReset: Boolean(request.contextReset) },
      turnIntent: request.turnIntent,
      accepted: () =>
        useSessionStore.getState().clearPendingContextReplay(created.sessionId, boundMessageId)
    })
  })()
}

const sendWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: SendWorkspaceMessageCommand,
  lifecycle: WorkspaceCommandLifecycle = {}
): Promise<SendWorkspaceMessageResult | undefined> => {
  if (input.branchSourceSessionId && input.branchSourceMessageId) {
    return branchWorkspaceSessionFromMessage(runtime, {
      sourceSessionId: input.branchSourceSessionId,
      sourceMessageId: input.branchSourceMessageId,
      agentFrameworkId: input.agentFrameworkId,
      agentBackendId: input.agentBackendId,
      agentModel: input.agentModel,
      agentConfiguration: input.agentConfiguration,
      specialistId: input.specialistId
    })
  }
  const content = input.text.trim()
  const replaySession = input.sessionId
    ? useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
    : undefined
  const replayPrompt = replaySession?.pendingContextReplayMessageId
    ? replaySession.messages.find((item) => item.id === replaySession.pendingContextReplayMessageId)
    : undefined
  const attachments = input.attachments ?? []
  const annotations = input.annotations ?? []
  if (annotationProtocol.validateAnnotations(annotations, content)) return undefined
  await validateImageAnnotationSourcesBeforeSend(annotations)
  const effectiveAttachments =
    attachments.length > 0 || !replayPrompt?.uploads?.length
      ? attachments
      : replayPrompt.uploads.map((upload) =>
          toRuntimeUploadedAttachment(upload, replaySession?.projectId)
        )
  if (!content && effectiveAttachments.length === 0 && annotations.length === 0) return undefined

  if (input.branchSourceSessionId) {
    const pending = useSessionStore.getState().branchInNewSession({
      sourceSessionId: input.branchSourceSessionId,
      content,
      attachments,
      annotations,
      parts: input.parts,
      turnIntent: input.turnIntent,
      permissionProfile: input.permissionProfile,
      agentFrameworkId: input.agentFrameworkId,
      agentBackendId: input.agentBackendId,
      agentModel: input.agentModel,
      agentConfiguration: input.agentConfiguration,
      specialistId: input.specialistId
    })
    if (!pending?.messageId) return undefined
    const pendingPrompt = { sessionId: pending.sessionId, messageId: pending.messageId }
    const session = useSessionStore
      .getState()
      .sessions.find((item) => item.id === pending.sessionId)
    if (!session) return undefined
    let history = session.messages.filter((message) => message.id !== pendingPrompt.messageId)
    try {
      await reconcileBranchedAttachments(
        input.branchSourceSessionId,
        pending.sessionId,
        history,
        session.projectId
      )
      const reconciled = useSessionStore
        .getState()
        .sessions.find((item) => item.id === pending.sessionId)
      if (!reconciled) return undefined
      if (!ownsPrompt(pendingPrompt.sessionId, pendingPrompt.messageId)) return pendingPrompt
      history = reconciled.messages.filter((message) => message.id !== pendingPrompt.messageId)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, errorMessage(error))
      return pendingPrompt
    }
    let replay: HistoryReplayContext | undefined
    try {
      replay = replayHistory(history, input, session.projectId)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, errorMessage(error))
      return pendingPrompt
    }
    startPendingPrompt(
      runtime,
      {
        ...input,
        pending: pendingPrompt,
        content,
        attachments,
        cwd: session.cwd || input.cwd,
        projectId: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        specialistId: session.specialistId,
        replay,
        contextReset: true
      },
      lifecycle.onSessionBound
    )
    return pendingPrompt
  }

  if (input.sessionId) {
    const sessionId = input.sessionId
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
    if (input.requireExistingSession && !session) return undefined
    if (!canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
    const projectId = input.projectId ?? session?.projectId
    if (input.planContinuation && !projectId) return undefined

    if (session?.isPending) {
      const cwd = input.cwd || session.cwd || undefined
      let replay: HistoryReplayContext | undefined
      if (session.pendingContextReplayMessageId) {
        try {
          replay = replayHistory(
            session.messages.filter((item) => item.id !== session.pendingContextReplayMessageId),
            input,
            projectId
          )
        } catch (error) {
          useSessionStore.getState().failRun(session.id, errorMessage(error))
          return { sessionId: session.id, messageId: session.pendingContextReplayMessageId }
        }
      }
      const appended = useSessionStore.getState().appendUserMessage({
        sessionId,
        content,
        attachments: effectiveAttachments,
        annotations,
        parts: input.parts,
        turnIntent: input.turnIntent,
        cwd,
        projectId: input.projectId ?? session.projectId,
        agentFrameworkId: input.agentFrameworkId,
        agentBackendId: input.agentBackendId,
        agentModel: input.agentModel,
        agentConfiguration: input.agentConfiguration,
        preserveSelection: input.preserveSelection
      })
      if (!appended) return undefined
      startPendingPrompt(
        runtime,
        {
          ...input,
          pending: appended,
          content,
          attachments: effectiveAttachments,
          cwd,
          projectId,
          permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
          specialistId: session.pendingContextReplayMessageId ? session.specialistId : undefined,
          replay,
          contextReset: Boolean(session.pendingContextReplayMessageId)
        },
        lifecycle.onSessionBound
      )
      return appended
    }

    const prepared = await prepareExistingWorkspacePrompt(runtime, {
      sessionId,
      requireExistingSession: input.requireExistingSession,
      cwd: input.cwd,
      projectId,
      permissionProfile: input.permissionProfile,
      selectedRuntime: {
        frameworkId: input.agentFrameworkId,
        backendId: input.agentBackendId,
        agentModel: input.agentModel,
        agentConfiguration: input.agentConfiguration,
        supportsImageInput: input.supportsImageInput,
        supportsImageRelay: input.supportsImageRelay
      },
      replay: {
        descriptor: input.historyReplayDescriptor,
        cutMessageId: input.truncateFromMessageId,
        force: input.forceHistoryReplay,
        includeResumeFallback: Boolean(input.forcedSkillIds?.length)
      },
      onPreparationStateChange: lifecycle.onSendPreparationStateChange,
      drainRuntimeEvents: lifecycle.drainRuntimeEvents
    })
    if (!prepared) return undefined
    let promptAttachments
    try {
      promptAttachments = await finalizeWorkspaceAttachments({
        sessionId,
        attachments: effectiveAttachments,
        projectId,
        preserveSourceOwnership: Boolean(input.truncateFromMessageId)
      })
    } catch (error) {
      useSessionStore.getState().failRun(sessionId, errorMessage(error))
      return undefined
    }
    if (!canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
    if (input.truncateFromMessageId) {
      if (promptAttachments.length > 0) {
        useSessionStore.getState().replaceMessageUploads({
          sessionId,
          messageId: input.truncateFromMessageId,
          uploads: promptAttachments.map(toPersistedUploadedAttachment)
        })
      }
      useSessionStore.getState().truncateSessionFromMessage(sessionId, input.truncateFromMessageId)
    }
    const appended = useSessionStore.getState().appendUserMessage({
      sessionId,
      content,
      attachments: promptAttachments,
      annotations,
      parts: input.parts,
      turnIntent: input.turnIntent,
      cwd: input.cwd,
      projectId: input.projectId ?? prepared.appendOwnership.projectId,
      agentFrameworkId: prepared.appendOwnership.agentFrameworkId,
      agentBackendId: prepared.appendOwnership.agentBackendId,
      agentModel: input.agentModel,
      agentConfiguration: input.agentConfiguration,
      preserveSelection: input.preserveSelection
    })
    if (!appended) return undefined
    const replay = prepared.replay()
    const continuation = input.planContinuation
      ? {
          projectId: projectId!,
          artifactVersionId: input.planContinuation.artifactVersionId,
          expectedRevision: input.planContinuation.revision,
          ...(input.planContinuation.pendingAction
            ? { pendingAction: input.planContinuation.pendingAction }
            : {})
        }
      : undefined
    const promptMedia =
      input.truncateFromMessageId && promptAttachments.length > 0
        ? partitionWorkspacePromptAttachments({
            historyAttachments: replay?.historyAttachments,
            latestAttachments: promptAttachments,
            supportsImageInput: input.supportsImageInput,
            supportsImageRelay: input.supportsImageRelay
          })
        : undefined
    dispatchPrompt(runtime, {
      sessionId,
      messageId: appended.messageId,
      content,
      annotations,
      attachments: promptMedia?.currentAttachments ?? promptAttachments,
      forcedSkillIds: input.forcedSkillIds,
      referencedArtifacts: input.referencedArtifacts,
      referencedSessions: collectSessionReferences(input.parts),
      replay: promptMedia
        ? { ...replay, historyAttachments: promptMedia.historyAttachments }
        : replay,
      continuation,
      turnIntent: input.turnIntent,
      accepted: () => prepared.acceptPrompt(appended.messageId)
    })
    return appended
  }

  const pending = useSessionStore.getState().appendPendingUserMessage({
    content,
    attachments,
    annotations,
    parts: input.parts,
    turnIntent: input.turnIntent,
    cwd: input.cwd,
    projectId: input.projectId,
    permissionProfile: input.permissionProfile,
    agentFrameworkId: input.agentFrameworkId,
    agentBackendId: input.agentBackendId,
    agentModel: input.agentModel,
    agentConfiguration: input.agentConfiguration,
    specialistId: input.specialistId ?? undefined,
    enabledComputeHosts: input.enabledComputeHosts,
    selectedComputeHosts: input.selectedComputeHosts
  })
  if (!pending) return undefined
  startPendingPrompt(
    runtime,
    {
      ...input,
      pending,
      content,
      attachments,
      cwd: input.cwd,
      projectId: input.projectId,
      permissionProfile: input.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      specialistId: input.specialistId ?? undefined,
      turnIntent: input.turnIntent
    },
    lifecycle.onSessionBound
  )
  return pending
}

const resendEditedWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: ResendEditedMessageInput & { sessionId: string; messageId: string },
  options: ResendEditedWorkspaceMessageOptions = {}
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
  if (!session) return false
  const sourceMessage = session.messages.find((message) => message.id === input.messageId)
  const annotations = input.annotations ?? sourceMessage?.annotations ?? []
  const cwd = session.cwd || runtime.state.cwd
  if (
    !cwd ||
    (!input.text.trim() && annotations.length === 0) ||
    !sourceMessage ||
    runtime.state.promptInFlightSessionIds.includes(input.sessionId)
  )
    return false
  let attachments: UploadedAttachment[]
  try {
    attachments = (sourceMessage.uploads ?? []).map((upload) =>
      toRuntimeUploadedAttachment(upload, session.projectId)
    )
  } catch (error) {
    useSessionStore.getState().failRun(input.sessionId, errorMessage(error))
    return false
  }
  return Boolean(
    await sendWorkspaceMessage(
      runtime,
      {
        sessionId: input.sessionId,
        text: input.text.trim(),
        attachments,
        annotations,
        parts: input.parts,
        cwd,
        projectId: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        forcedSkillIds: input.forcedSkillIds,
        referencedArtifacts: input.referencedArtifacts,
        agentFrameworkId: options.agentFrameworkId,
        agentBackendId: options.agentBackendId,
        agentModel: options.agentModel,
        agentConfiguration: options.agentConfiguration,
        historyReplayDescriptor: options.historyReplayDescriptor,
        truncateFromMessageId: input.messageId,
        supportsImageInput: options.supportsImageInput,
        supportsImageRelay: options.supportsImageRelay
      },
      options
    )
  )
}
export { resendEditedWorkspaceMessage, sendWorkspaceMessage }
export type { ResendEditedMessageInput, SendWorkspaceMessageIntent, SendWorkspaceMessageResult }

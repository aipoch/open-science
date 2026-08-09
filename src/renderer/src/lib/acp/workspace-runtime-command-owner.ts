import type { AcpMessageImage, AcpRuntimeEvent } from '../../../../shared/acp'
import type { FileReference } from '../../../../shared/artifacts'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import type { MessagePart } from '../../../../shared/session-persistence'
import type { AgentFrameworkId } from '../../../../shared/settings'
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
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'
import { useSessionStore, type ChatMessage } from '../../stores/session-store'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  isWorkspacePromptPreparationInFlight,
  prepareExistingWorkspacePrompt
} from './workspace-runtime-prompt-preparation-owner'
import type { useAcpRuntime } from './useAcpRuntime'

type SendWorkspaceMessageIntent = {
  sessionId?: string
  branchSourceSessionId?: string
  text: string
  turnIntent?: 'plan-first'
  planContinuation?: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'> & {
    pendingAction?: 'review' | 'approve' | 'reject'
  }
  attachments?: UploadedAttachment[]
  cwd?: string
  projectId?: string
  projectName?: string
  permissionProfile?: PermissionProfileId
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  parts?: MessagePart[]
  specialistId?: string | null
}

type SendWorkspaceMessageCommand = SendWorkspaceMessageIntent & {
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  historyReplayDescriptor?: HistoryReplayDescriptor
  forceHistoryReplay?: boolean
  supportsImageInput?: boolean
  truncateFromMessageId?: string
  allowCompactionRecovery?: boolean
  requireExistingSession?: boolean
}

type SendWorkspaceMessageResult = { sessionId: string; messageId: string }
type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type RuntimeEventDrain = (sessionId?: string) => Promise<void>
type WorkspaceCommandLifecycle = {
  onSendPreparationStateChange?: SendPreparationStateChange
  drainRuntimeEvents?: RuntimeEventDrain
}
type ResendEditedMessageInput = {
  text: string
  parts?: MessagePart[]
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
}
type ResendEditedWorkspaceMessageOptions = WorkspaceCommandLifecycle & {
  supportsImageInput?: boolean
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  historyReplayDescriptor?: HistoryReplayDescriptor
}
type WorkspaceCommandRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'createSession' | 'resumeSession' | 'resetSessionContext' | 'sendPrompt'
>
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
    // The persisted run error remains useful when the live runtime snapshot is unavailable.
  }
  useSessionStore.getState().failRun(sessionId, message, { reportable })
}

const finalizeAttachments = async (
  sessionId: string,
  messageId: string,
  attachments: UploadedAttachment[],
  projectId?: string
): Promise<UploadedAttachment[]> => {
  if (attachments.length === 0) return attachments
  const finalized = await window.api.uploads.finalizeSession({ projectId, sessionId, attachments })
  useSessionStore.getState().replaceMessageUploads({
    sessionId,
    messageId,
    uploads: finalized.map(toPersistedUploadedAttachment)
  })
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalized)
  return finalized
}

const reconcileBranchedAttachments = async (
  sourceSessionId: string,
  childSessionId: string,
  messages: ChatMessage[],
  projectId?: string
): Promise<void> => {
  const stagedById = new Map<string, UploadedAttachment>()
  for (const message of messages) {
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
  for (const message of messages) {
    if (!message.uploads?.some((upload) => stagedById.has(upload.id))) continue
    const uploads = message.uploads.map((upload) => {
      const replacement = finalizedById.get(upload.id)
      return replacement ? toPersistedUploadedAttachment(replacement) : upload
    })
    for (const sessionId of [sourceSessionId, childSessionId]) {
      useSessionStore
        .getState()
        .replaceMessageUploads({ sessionId, messageId: message.id, uploads })
    }
  }
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalized)
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
    input.supportsImageInput
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

type PromptDispatch = {
  sessionId: string
  messageId: string
  content: string
  attachments: UploadedAttachment[]
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  replay?: HistoryReplayContext & {
    resumeFallback?: HistoryReplayContext
    contextReset?: boolean
  }
  continuation?: Parameters<WorkspaceCommandRuntime['sendPrompt']>[11]
  turnIntent?: SendWorkspaceMessageIntent['turnIntent']
  accepted?: () => void
}

const dispatchPrompt = (runtime: WorkspaceCommandRuntime, request: PromptDispatch): void => {
  const priorErrorEventId = latestFailureId(runtime.state.events, request.sessionId)
  const args = [
    request.sessionId,
    request.content,
    request.attachments,
    request.forcedSkillIds,
    request.referencedArtifacts,
    request.replay?.historyPreamble,
    request.replay?.historyAttachments,
    request.replay?.historyImages,
    request.replay?.resumeFallback,
    promptContext(request.sessionId, request.messageId),
    request.replay?.contextReset
  ] as const
  const result = request.turnIntent
    ? runtime.sendPrompt(...args, request.continuation, request.turnIntent)
    : request.continuation
      ? runtime.sendPrompt(...args, request.continuation)
      : runtime.sendPrompt(...args)
  void result
    .then(() => request.accepted?.())
    .catch((error) => {
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
  request: PendingPromptRequest
): void => {
  void (async () => {
    const pending = request.pending
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return
    let created
    try {
      created = await runtime.createSession(
        request.cwd,
        request.projectName,
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
    if (!bound || !ownsPrompt(created.sessionId, bound.messageId)) return

    let attachments = request.attachments
    try {
      attachments = await finalizeAttachments(
        created.sessionId,
        bound.messageId,
        attachments,
        request.projectName
      )
    } catch (error) {
      useSessionStore.getState().failRun(created.sessionId, errorMessage(error))
      return
    }
    if (!ownsPrompt(created.sessionId, bound.messageId)) return
    dispatchPrompt(runtime, {
      sessionId: created.sessionId,
      messageId: bound.messageId,
      content: request.content,
      attachments,
      forcedSkillIds: request.forcedSkillIds,
      referencedArtifacts: request.referencedArtifacts,
      replay: { ...request.replay, contextReset: Boolean(request.contextReset) },
      turnIntent: request.turnIntent,
      accepted: () =>
        useSessionStore.getState().clearPendingContextReplay(created.sessionId, bound.messageId)
    })
  })()
}

const sendWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: SendWorkspaceMessageCommand,
  lifecycle: WorkspaceCommandLifecycle = {}
): Promise<SendWorkspaceMessageResult | undefined> => {
  const content = input.text.trim()
  const replaySession = input.sessionId
    ? useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
    : undefined
  const replayPrompt = replaySession?.pendingContextReplayMessageId
    ? replaySession.messages.find((item) => item.id === replaySession.pendingContextReplayMessageId)
    : undefined
  const attachments = input.attachments ?? []
  const effectiveAttachments =
    attachments.length > 0 || !replayPrompt?.uploads?.length
      ? attachments
      : replayPrompt.uploads.map((upload) =>
          toRuntimeUploadedAttachment(upload, replaySession?.projectId)
        )
  if (!content && effectiveAttachments.length === 0) return undefined

  if (input.branchSourceSessionId) {
    const pending = useSessionStore.getState().branchInNewSession({
      sourceSessionId: input.branchSourceSessionId,
      content,
      attachments,
      parts: input.parts,
      turnIntent: input.turnIntent,
      permissionProfile: input.permissionProfile,
      agentFrameworkId: input.agentFrameworkId,
      agentBackendId: input.agentBackendId,
      agentModel: input.agentModel,
      specialistId: input.specialistId
    })
    if (!pending) return undefined
    const session = useSessionStore
      .getState()
      .sessions.find((item) => item.id === pending.sessionId)
    if (!session) return undefined
    let history = session.messages.filter((message) => message.id !== pending.messageId)
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
      if (!ownsPrompt(pending.sessionId, pending.messageId)) return pending
      history = reconciled.messages.filter((message) => message.id !== pending.messageId)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, errorMessage(error))
      return pending
    }
    let replay: HistoryReplayContext | undefined
    try {
      replay = replayHistory(history, input, session.projectId)
    } catch (error) {
      useSessionStore.getState().failRun(pending.sessionId, errorMessage(error))
      return pending
    }
    startPendingPrompt(runtime, {
      ...input,
      pending,
      content,
      attachments,
      cwd: session.cwd || input.cwd,
      projectName: session.projectId,
      permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      specialistId: session.specialistId,
      replay,
      contextReset: true
    })
    return pending
  }

  if (input.sessionId) {
    const sessionId = input.sessionId
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
    if (input.requireExistingSession && !session) return undefined
    if (isWorkspacePromptPreparationInFlight(sessionId)) return undefined
    if (
      runtime.state.promptInFlightSessionIds.includes(sessionId) ||
      (session?.compacting && !input.allowCompactionRecovery) ||
      session?.status === 'running' ||
      session?.status === 'waiting-for-user' ||
      session?.status === 'waiting-permission'
    ) {
      return undefined
    }
    const projectName = input.projectName ?? session?.projectId ?? input.projectId
    if (input.planContinuation && !projectName) return undefined

    if (session?.isPending) {
      const cwd = input.cwd || session.cwd || undefined
      let replay: HistoryReplayContext | undefined
      if (session.pendingContextReplayMessageId) {
        try {
          replay = replayHistory(
            session.messages.filter((item) => item.id !== session.pendingContextReplayMessageId),
            input,
            projectName
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
        parts: input.parts,
        turnIntent: input.turnIntent,
        cwd,
        projectId: input.projectId ?? session.projectId,
        agentFrameworkId: input.agentFrameworkId,
        agentBackendId: input.agentBackendId,
        agentModel: input.agentModel
      })
      if (!appended) return undefined
      startPendingPrompt(runtime, {
        ...input,
        pending: appended,
        content,
        attachments: effectiveAttachments,
        cwd,
        projectName,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        specialistId: session.pendingContextReplayMessageId ? session.specialistId : undefined,
        replay,
        contextReset: Boolean(session.pendingContextReplayMessageId)
      })
      return appended
    }

    const prepared = await prepareExistingWorkspacePrompt(runtime, {
      sessionId,
      requireExistingSession: input.requireExistingSession,
      cwd: input.cwd,
      projectName,
      permissionProfile: input.permissionProfile,
      selectedRuntime: {
        frameworkId: input.agentFrameworkId,
        backendId: input.agentBackendId,
        supportsImageInput: input.supportsImageInput
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
    if (input.truncateFromMessageId) {
      useSessionStore.getState().truncateSessionFromMessage(sessionId, input.truncateFromMessageId)
    }
    const appended = useSessionStore.getState().appendUserMessage({
      sessionId,
      content,
      attachments: effectiveAttachments,
      parts: input.parts,
      turnIntent: input.turnIntent,
      cwd: input.cwd,
      projectId: input.projectId ?? prepared.appendOwnership.projectId,
      agentFrameworkId: prepared.appendOwnership.agentFrameworkId,
      agentBackendId: prepared.appendOwnership.agentBackendId,
      agentModel: input.agentModel
    })
    if (!appended) return undefined
    const replay = prepared.replay()
    let promptAttachments = effectiveAttachments
    try {
      promptAttachments = await finalizeAttachments(
        sessionId,
        appended.messageId,
        effectiveAttachments,
        projectName
      )
    } catch (error) {
      useSessionStore.getState().failRun(sessionId, errorMessage(error))
      return appended
    }
    const continuation = input.planContinuation
      ? {
          projectId: projectName!,
          artifactVersionId: input.planContinuation.artifactVersionId,
          expectedRevision: input.planContinuation.revision,
          ...(input.planContinuation.pendingAction
            ? { pendingAction: input.planContinuation.pendingAction }
            : {})
        }
      : undefined
    dispatchPrompt(runtime, {
      sessionId,
      messageId: appended.messageId,
      content,
      attachments: promptAttachments,
      forcedSkillIds: input.forcedSkillIds,
      referencedArtifacts: input.referencedArtifacts,
      replay,
      continuation,
      turnIntent: input.turnIntent,
      accepted: () => prepared.acceptPrompt(appended.messageId)
    })
    return appended
  }

  const pending = useSessionStore.getState().appendPendingUserMessage({
    content,
    attachments,
    parts: input.parts,
    turnIntent: input.turnIntent,
    cwd: input.cwd,
    projectId: input.projectId,
    permissionProfile: input.permissionProfile,
    agentFrameworkId: input.agentFrameworkId,
    agentBackendId: input.agentBackendId,
    agentModel: input.agentModel,
    specialistId: input.specialistId ?? undefined
  })
  if (!pending) return undefined
  startPendingPrompt(runtime, {
    ...input,
    pending,
    content,
    attachments,
    cwd: input.cwd,
    projectName: input.projectName,
    permissionProfile: input.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    specialistId: input.specialistId ?? undefined,
    turnIntent: input.turnIntent
  })
  return pending
}

const resendEditedWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: ResendEditedMessageInput & { sessionId: string; messageId: string },
  options: ResendEditedWorkspaceMessageOptions = {}
): Promise<boolean> => {
  const session = useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
  if (!session) return false
  const cwd = session.cwd || runtime.state.cwd
  if (
    !cwd ||
    !input.text.trim() ||
    !session.messages.some((message) => message.id === input.messageId) ||
    runtime.state.promptInFlightSessionIds.includes(input.sessionId)
  ) {
    return false
  }
  return Boolean(
    await sendWorkspaceMessage(
      runtime,
      {
        sessionId: input.sessionId,
        text: input.text.trim(),
        attachments: [],
        parts: input.parts,
        cwd,
        projectId: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        forcedSkillIds: input.forcedSkillIds,
        referencedArtifacts: input.referencedArtifacts,
        agentFrameworkId: options.agentFrameworkId,
        agentBackendId: options.agentBackendId,
        agentModel: options.agentModel,
        historyReplayDescriptor: options.historyReplayDescriptor,
        truncateFromMessageId: input.messageId,
        supportsImageInput: options.supportsImageInput
      },
      options
    )
  )
}

export { resendEditedWorkspaceMessage, sendWorkspaceMessage }
export type { ResendEditedMessageInput, SendWorkspaceMessageIntent, SendWorkspaceMessageResult }

import type { AcpMessageImage, AcpRuntimeEvent } from '../../../../shared/acp'
import type { FileReference } from '../../../../shared/artifacts'
import * as annotationProtocol from '../../../../shared/annotations'
import { withPdfContext as withPdf } from '../../../../shared/session-pdf-context'
import {
  collectSessionReferences,
  isSessionSizeLimitError,
  MAX_SESSION_PDF_CONTEXTS,
  type DelegationPolicy,
  type MessageAttribution,
  type MessagePdfContextSnapshot,
  type MessagePart,
  type PersistedMessageAgentTarget,
  type PdfReadingPosition,
  type SessionPdfContextSource,
  type SessionRuntimeContext,
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
import {
  confirmPendingDelegationPolicyAuthority,
  saveSessionInOrder,
  toPersistedSessionForAuthorityMaterialization
} from '../session-persistence/session-persistence'
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
import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
type SendWorkspaceMessageIntent = {
  sessionId?: string
  // Optional durable caller identity for restart-safe application-owned prompts.
  messageId?: string
  branchSourceSessionId?: string
  branchSourceMessageId?: string
  text: string
  attribution?: MessageAttribution
  requireExistingSession?: boolean
  turnIntent?: 'plan-first'
  attachments?: UploadedAttachment[]
  annotations?: annotationProtocol.Annotation[]
  cwd?: string
  projectId?: string
  permissionProfile?: PermissionProfileId
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  pdfContext?: MessagePdfContextSnapshot
  pdfReadingPosition?: PdfReadingPosition
  pendingPdfContextAttachmentIds?: string[]
  pendingPdfContextVersions?: SessionPdfContextSource[]
  parts?: MessagePart[]
  specialistId?: string | null
  enabledComputeHosts?: string[]
  selectedComputeHosts?: string[]
  agentConfiguration?: SessionAgentConfiguration
  memoryEnabled?: boolean
  delegationPolicy?: DelegationPolicy
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
}
type SendWorkspaceMessageResult = { sessionId: string; messageId: string }
type WorkspaceCommandLifecycle = {
  awaitPendingPreparation?: boolean
  onSendPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void
  onPdfContextLinked?: (sessionId: string, pdfContext: MessagePdfContextSnapshot) => void
  onSessionSizeLimit?: (sessionId: string) => void
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

// Snapshots the target a send actually runs with. Only a complete identity (framework + admitted
// provider configuration) is stamped; a partial snapshot would mark false config changes.
// Unpinned configurations omit model; catalog fallbacks on agentModel are not persisted.
const resolveSendAgentTarget = (
  input: Readonly<{
    agentFrameworkId?: AgentFrameworkId
    agentBackendId?: string
    agentConfiguration?: SessionAgentConfiguration
  }>
): PersistedMessageAgentTarget | undefined => {
  const configuration = input.agentConfiguration
  if (!input.agentFrameworkId || !configuration) return undefined
  const backendId = input.agentBackendId?.trim()
  const model = configuration.model?.trim() || undefined
  return {
    frameworkId: input.agentFrameworkId,
    ...(backendId ? { backendId } : {}),
    providerId: configuration.providerId,
    ...(model ? { model } : {}),
    reasoningEffort: configuration.reasoningEffort
  }
}
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
    request.replay?.contextReset,
    request.turnIntent,
    useSessionStore.getState().sessions.find((session) => session.id === request.sessionId)
      ?.memoryEnabled !== false
  ] as const
  const currentImages = preparedAnnotations.images
  const referencedSessions = request.referencedSessions?.length
    ? request.referencedSessions
    : undefined
  const result = currentImages?.length
    ? runtime.sendPrompt(...args, referencedSessions, currentImages)
    : referencedSessions
      ? runtime.sendPrompt(...args, referencedSessions)
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

const linkPdfContextForSend = async ({
  sessionId,
  messageId,
  projectId,
  sources,
  pdfReadingPosition,
  excludeSinglePage = false,
  persistSessionBeforeLink = false,
  materializedRuntimeRevision
}: {
  sessionId: string
  messageId?: string
  projectId: string | undefined
  sources: SessionPdfContextSource[]
  pdfReadingPosition?: PdfReadingPosition
  excludeSinglePage?: boolean
  persistSessionBeforeLink?: boolean
  materializedRuntimeRevision?: number
}): Promise<MessagePdfContextSnapshot | undefined> => {
  if (!projectId) throw new Error('The PDF Project is unavailable for Session context.')
  let source = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
  if (!source) throw new Error(`Session not found: ${sessionId}`)
  const previousBindings = source.runtimeContext?.pdfContext?.bindings ?? []
  let expectedRevision = materializedRuntimeRevision ?? source.runtimeContext?.revision ?? 0

  // A new Agent Session is bound in memory before its first durable save. Materialize that Session
  // before asking Main's PDF-context owner to patch its runtime context.
  if (persistSessionBeforeLink) {
    const durable = await saveSessionInOrder(toPersistedSessionForAuthorityMaterialization(source))
    expectedRevision = durable.runtimeContext?.revision ?? 0
  }

  const runtimeContext: SessionRuntimeContext = await window.api.sessions.linkPdfContext({
    projectId,
    sessionId,
    expectedRevision,
    sources,
    ...(excludeSinglePage ? { excludeSinglePage: true } : {})
  })
  const pdfContext = runtimeContext.pdfContext
  const activeBinding = sources
    .map(({ sourceKind, sourceVersionId }) =>
      pdfContext?.bindings.find(
        (binding) =>
          binding.sourceKind === sourceKind && binding.sourceVersionId === sourceVersionId
      )
    )
    .find((binding) => binding !== undefined)
  const activeBindingWasAlreadyLinked = activeBinding
    ? previousBindings.some(({ bindingId }) => bindingId === activeBinding.bindingId)
    : false
  const canApplyReadingPosition =
    activeBinding !== undefined &&
    pdfReadingPosition !== undefined &&
    (previousBindings.length === 0 || activeBindingWasAlreadyLinked)
  const messagePdfContext: MessagePdfContextSnapshot | undefined = pdfContext
    ? {
        ...pdfContext,
        ...(activeBinding ? { activeBindingId: activeBinding.bindingId } : {}),
        ...(canApplyReadingPosition ? { readingPosition: pdfReadingPosition } : {})
      }
    : undefined

  source = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
  if (!source) throw new Error(`Session not found: ${sessionId}`)
  useSessionStore.getState().applyDurableSessionProjection({
    source,
    session: {
      ...toPersistedSession(source),
      runtimeContext,
      updatedAt: Math.max(source.updatedAt, Date.now())
    },
    mode: 'runtime-context-authority'
  })
  if (messageId && messagePdfContext) {
    useSessionStore.getState().replaceMessagePdfContext({
      sessionId,
      messageId,
      pdfContext: messagePdfContext
    })
    const linked = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)
    if (linked) {
      await saveSessionInOrder(toPersistedSessionForAuthorityMaterialization(linked))
    }
  }
  return messagePdfContext
}

const finalizedPdfContextSources = ({
  attachmentIds,
  attachments
}: {
  attachmentIds: string[]
  attachments: UploadedAttachment[]
}): SessionPdfContextSource[] => {
  const selected = attachmentIds.map((attachmentId) =>
    attachments.find((candidate) => candidate.id === attachmentId)
  )
  if (selected.some((attachment) => !attachment?.versionId)) {
    throw new Error('The staged PDF could not be finalized for Session context.')
  }
  return selected.map((attachment) => ({
    sourceKind: 'upload-version',
    sourceFileId: attachment!.id,
    sourceVersionId: attachment!.versionId!
  }))
}

const filterPendingPdfContext = async (
  request: Pick<
    PendingPromptRequest,
    'attachments' | 'pendingPdfContextAttachmentIds' | 'pendingPdfContextVersions' | 'projectId'
  >
): Promise<{
  attachmentIds: string[]
  versions: SessionPdfContextSource[]
}> => {
  const selectedAttachmentIds = new Set(request.pendingPdfContextAttachmentIds ?? [])
  const pendingAttachments: Array<{
    attachmentId: string
    path: string
    name: string
    mimeType?: string
  }> = []
  const versions: SessionPdfContextSource[] = [...(request.pendingPdfContextVersions ?? [])]
  for (const attachmentId of selectedAttachmentIds) {
    const attachment = request.attachments.find((candidate) => candidate.id === attachmentId)
    if (!attachment) throw new Error('The staged PDF is no longer attached to this message.')
    if (attachment.versionId) {
      versions.push({
        sourceKind: 'upload-version',
        sourceFileId: attachment.id,
        sourceVersionId: attachment.versionId
      })
      continue
    }
    pendingAttachments.push({
      attachmentId,
      path: attachment.path,
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
    })
  }
  const uniqueVersions = Array.from(
    new Map(
      versions.map((source) => [`${source.sourceKind}:${source.sourceVersionId}`, source])
    ).values()
  )
  if (uniqueVersions.length === 0 && pendingAttachments.length === 0) {
    return { attachmentIds: [], versions: [] }
  }
  if (!request.projectId) throw new Error('PDF context requires a Project.')
  const eligible = await window.api.sessions.filterPdfContextCandidates({
    projectId: request.projectId,
    sources: uniqueVersions,
    ...(pendingAttachments.length > 0 ? { pendingAttachments } : {})
  })
  return {
    attachmentIds: [...eligible.pendingAttachmentIds],
    versions: [...eligible.sources]
  }
}

const startPendingPrompt = (
  runtime: WorkspaceCommandRuntime,
  request: PendingPromptRequest,
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void,
  onPdfContextLinked?: (sessionId: string, pdfContext: MessagePdfContextSnapshot) => void,
  onSessionSizeLimit?: (sessionId: string) => void
): Promise<boolean> => {
  return (async () => {
    const pending = request.pending
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return false
    let created
    let eligiblePendingPdfContext: Awaited<ReturnType<typeof filterPendingPdfContext>>
    try {
      eligiblePendingPdfContext = await filterPendingPdfContext(request)
      const literatureContext =
        (request.pdfContext?.bindings.length ?? 0) > 0 ||
        eligiblePendingPdfContext.attachmentIds.length > 0 ||
        eligiblePendingPdfContext.versions.length > 0
      const target =
        request.agentFrameworkId && request.agentConfiguration
          ? { frameworkId: request.agentFrameworkId, ...request.agentConfiguration }
          : undefined
      const createSessionArgs = [
        request.cwd,
        request.projectId,
        request.permissionProfile,
        request.specialistId ?? undefined,
        target,
        request.memoryEnabled !== false
      ] as const
      created = literatureContext
        ? await runtime.createSession(...createSessionArgs, true)
        : await runtime.createSession(...createSessionArgs)
    } catch (error) {
      if (ownsPrompt(pending.sessionId, pending.messageId)) {
        useSessionStore.getState().failRun(pending.sessionId, createSessionFailureMessage(error))
      }
      return false
    }
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return false
    if (!created?.sessionId) {
      useSessionStore.getState().failRun(pending.sessionId, 'Agent session could not be created.')
      return false
    }
    const cwd = created.cwd ?? request.cwd
    if (!cwd) {
      useSessionStore
        .getState()
        .failRun(pending.sessionId, 'Agent session did not return a workspace.')
      return false
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
    if (!boundMessageId || !ownsPrompt(created.sessionId, boundMessageId)) return false

    const boundSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === created.sessionId)
    let sessionMaterialized = false
    let materializedRuntimeRevision: number | undefined
    if (
      boundSession &&
      (boundSession.delegationPolicyAuthorityPending || boundSession.enabledComputeHosts?.length)
    ) {
      try {
        if (boundSession.delegationPolicyAuthorityPending) {
          const authoritative = await confirmPendingDelegationPolicyAuthority(boundSession)
          materializedRuntimeRevision = authoritative?.runtimeContext?.revision ?? 0
        } else {
          const materialized = await saveSessionInOrder(
            toPersistedSessionForAuthorityMaterialization(boundSession)
          )
          materializedRuntimeRevision = materialized.runtimeContext?.revision ?? 0
        }
        sessionMaterialized = true
      } catch (error) {
        if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(created.sessionId)
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
        return false
      }
      if (!ownsPrompt(created.sessionId, boundMessageId)) return false
    }

    let attachments = request.attachments
    let pdfContext = request.pdfContext
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
      const pdfContextSources = [
        ...finalizedPdfContextSources({
          attachmentIds: eligiblePendingPdfContext.attachmentIds,
          attachments
        }),
        ...eligiblePendingPdfContext.versions
      ].slice(0, Math.max(0, MAX_SESSION_PDF_CONTEXTS - (pdfContext?.bindings.length ?? 0)))
      if (pdfContextSources.length > 0) {
        pdfContext = await linkPdfContextForSend({
          sessionId: created.sessionId,
          messageId: boundMessageId,
          projectId: request.projectId,
          sources: pdfContextSources,
          pdfReadingPosition: request.pdfReadingPosition,
          excludeSinglePage: true,
          persistSessionBeforeLink: !sessionMaterialized,
          materializedRuntimeRevision
        })
      }
      if (
        pdfContext &&
        (eligiblePendingPdfContext.attachmentIds.length > 0 ||
          eligiblePendingPdfContext.versions.length > 0)
      ) {
        onPdfContextLinked?.(created.sessionId, pdfContext)
      }
    } catch (error) {
      if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(created.sessionId)
      useSessionStore.getState().failRun(created.sessionId, errorMessage(error))
      return false
    }
    if (!ownsPrompt(created.sessionId, boundMessageId)) return false

    dispatchPrompt(runtime, {
      sessionId: created.sessionId,
      messageId: boundMessageId,
      content: request.content,
      annotations: request.annotations,
      attachments,
      forcedSkillIds: request.forcedSkillIds,
      referencedArtifacts: withPdf(request.projectId, request.referencedArtifacts, pdfContext),
      referencedSessions: collectSessionReferences(request.parts),
      replay: { ...request.replay, contextReset: Boolean(request.contextReset) },
      turnIntent: request.turnIntent,
      accepted: () =>
        useSessionStore.getState().clearPendingContextReplay(created.sessionId, boundMessageId)
    })
    return true
  })()
}

const sendWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: SendWorkspaceMessageCommand,
  lifecycle: WorkspaceCommandLifecycle = {}
): Promise<SendWorkspaceMessageResult | undefined> => {
  if (input.branchSourceSessionId && input.branchSourceMessageId) {
    return branchWorkspaceSessionFromMessage(
      runtime,
      {
        sourceSessionId: input.branchSourceSessionId,
        sourceMessageId: input.branchSourceMessageId,
        agentFrameworkId: input.agentFrameworkId,
        agentBackendId: input.agentBackendId,
        agentModel: input.agentModel,
        agentConfiguration: input.agentConfiguration,
        delegationPolicy: input.delegationPolicy,
        specialistId: input.specialistId
      },
      lifecycle.onSessionSizeLimit
    )
  }
  const content = input.text.trim()
  const replaySession = input.sessionId
    ? useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
    : undefined
  const replayPrompt = replaySession?.pendingContextReplayMessageId
    ? replaySession.messages.find((item) => item.id === replaySession.pendingContextReplayMessageId)
    : undefined
  let pdfContext = replayPrompt
    ? replayPrompt.pdfContext
    : input.pdfContext && input.pdfReadingPosition
      ? {
          ...input.pdfContext,
          activeBindingId:
            input.pdfContext.activeBindingId ?? input.pdfContext.bindings[0]?.bindingId,
          readingPosition: input.pdfReadingPosition
        }
      : input.pdfContext
  const attachments = input.attachments ?? []
  const annotations = input.annotations ?? []
  if (annotationProtocol.validateAnnotations(annotations, content)) return undefined
  if (
    input.supportsImageInput !== true &&
    input.supportsImageRelay !== true &&
    annotations.some(
      (annotation) => annotation.kind === 'pdf' && annotation.selector.kind === 'region'
    )
  ) {
    throw new Error(VISION_MODEL_NOT_CONFIGURED_MESSAGE)
  }
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
      agentTarget: resolveSendAgentTarget(input),
      delegationPolicy: input.delegationPolicy,
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
    const preparation = startPendingPrompt(
      runtime,
      {
        ...input,
        pdfContext: undefined,
        ...(pdfContext
          ? {
              pendingPdfContextVersions: pdfContext.bindings.map(
                ({ sourceKind, sourceFileId, sourceVersionId }) => ({
                  sourceKind,
                  sourceFileId,
                  sourceVersionId
                })
              ),
              pdfReadingPosition: pdfContext.readingPosition
            }
          : {}),
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
      lifecycle.onSessionBound,
      lifecycle.onPdfContextLinked,
      lifecycle.onSessionSizeLimit
    )
    if (lifecycle.awaitPendingPreparation) {
      return (await preparation) ? pendingPrompt : undefined
    }
    void preparation
    return pendingPrompt
  }

  if (input.sessionId) {
    const sessionId = input.sessionId
    let session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
    const stableMessageId = input.messageId?.trim()
    if (input.messageId !== undefined && !stableMessageId) return undefined
    let existingStableMessage = stableMessageId
      ? session?.messages.find((message) => message.id === stableMessageId)
      : undefined
    const graphStableMessage = stableMessageId
      ? session?.conversationGraph?.messages.find((message) => message.id === stableMessageId)
      : undefined
    if (!existingStableMessage && graphStableMessage && session) {
      if (graphStableMessage.role !== 'user' || graphStableMessage.content !== content) {
        return undefined
      }
      useSessionStore
        .getState()
        .activateMessageBranch(sessionId, graphStableMessage.introducedOnBranchId)
      session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
      existingStableMessage = session?.messages.find((message) => message.id === stableMessageId)
      if (!existingStableMessage) return undefined
    }
    let rearmExistingStableMessage = false
    if (existingStableMessage) {
      if (existingStableMessage.role !== 'user' || existingStableMessage.content !== content) {
        return undefined
      }
      const hasResponse = session?.messages.some(
        (message) =>
          message.role === 'agent' && message.responseToMessageId === existingStableMessage.id
      )
      if (hasResponse || session?.activeRun?.promptMessageId === existingStableMessage.id) {
        return { sessionId, messageId: existingStableMessage.id }
      }
      rearmExistingStableMessage = true
    }
    if (input.requireExistingSession && !session) return undefined
    if (!canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
    if (session?.delegationPolicyAuthorityPending) {
      try {
        await confirmPendingDelegationPolicyAuthority(session)
        session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
      } catch (error) {
        useSessionStore.getState().failRun(sessionId, errorMessage(error))
        return undefined
      }
    }
    const projectId = input.projectId ?? session?.projectId
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
        pdfContext,
        turnIntent: input.turnIntent,
        attribution: input.attribution,
        cwd,
        projectId: input.projectId ?? session.projectId,
        agentFrameworkId: input.agentFrameworkId,
        agentBackendId: input.agentBackendId,
        agentModel: input.agentModel,
        agentConfiguration: input.agentConfiguration,
        agentTarget: resolveSendAgentTarget(input),
        preserveSelection: input.preserveSelection
      })
      if (!appended) return undefined
      const preparation = startPendingPrompt(
        runtime,
        {
          ...input,
          pdfContext,
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
        lifecycle.onSessionBound,
        lifecycle.onPdfContextLinked,
        lifecycle.onSessionSizeLimit
      )
      if (lifecycle.awaitPendingPreparation) {
        return (await preparation) ? appended : undefined
      }
      void preparation
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
        excludeMessageId: rearmExistingStableMessage ? existingStableMessage?.id : undefined,
        force: input.forceHistoryReplay,
        includeResumeFallback: Boolean(input.forcedSkillIds?.length)
      },
      onPreparationStateChange: lifecycle.onSendPreparationStateChange,
      drainRuntimeEvents: lifecycle.drainRuntimeEvents
    })
    if (!prepared) return undefined
    let promptAttachments
    try {
      const eligiblePendingPdfContext = await filterPendingPdfContext({
        attachments: effectiveAttachments,
        pendingPdfContextAttachmentIds: input.pendingPdfContextAttachmentIds,
        pendingPdfContextVersions: input.pendingPdfContextVersions,
        projectId
      })
      promptAttachments = await finalizeWorkspaceAttachments({
        sessionId,
        attachments: effectiveAttachments,
        projectId,
        preserveSourceOwnership: Boolean(input.truncateFromMessageId)
      })
      const pdfContextSources = [
        ...finalizedPdfContextSources({
          attachmentIds: eligiblePendingPdfContext.attachmentIds,
          attachments: promptAttachments
        }),
        ...eligiblePendingPdfContext.versions
      ].slice(0, Math.max(0, MAX_SESSION_PDF_CONTEXTS - (pdfContext?.bindings.length ?? 0)))
      if (pdfContextSources.length > 0) {
        pdfContext = await linkPdfContextForSend({
          sessionId,
          projectId,
          sources: pdfContextSources,
          pdfReadingPosition: input.pdfReadingPosition,
          excludeSinglePage: true
        })
      }
      if (
        pdfContext &&
        (eligiblePendingPdfContext.attachmentIds.length > 0 ||
          eligiblePendingPdfContext.versions.length > 0)
      ) {
        lifecycle.onPdfContextLinked?.(sessionId, pdfContext)
      }
    } catch (error) {
      if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
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
      messageId: stableMessageId,
      rearmExisting: rearmExistingStableMessage,
      content,
      attachments: promptAttachments,
      annotations,
      parts: input.parts,
      pdfContext,
      turnIntent: input.turnIntent,
      attribution: input.attribution,
      cwd: input.cwd,
      projectId: input.projectId ?? prepared.appendOwnership.projectId,
      agentFrameworkId: prepared.appendOwnership.agentFrameworkId,
      agentBackendId: prepared.appendOwnership.agentBackendId,
      agentModel: input.agentModel,
      agentConfiguration: input.agentConfiguration,
      agentTarget: resolveSendAgentTarget({
        agentFrameworkId: prepared.appendOwnership.agentFrameworkId ?? input.agentFrameworkId,
        agentBackendId: prepared.appendOwnership.agentBackendId ?? input.agentBackendId,
        agentConfiguration: input.agentConfiguration
      }),
      preserveSelection: input.preserveSelection
    })
    if (!appended) return undefined
    if (stableMessageId) {
      const durableSession = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!durableSession) return undefined
      try {
        await saveSessionInOrder(toPersistedSession(durableSession))
      } catch (error) {
        if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
        useSessionStore.getState().failRun(sessionId, errorMessage(error))
        return undefined
      }
      if (!ownsPrompt(sessionId, appended.messageId)) return undefined
    }
    const replay = prepared.replay()
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
      referencedArtifacts: withPdf(projectId, input.referencedArtifacts, pdfContext),
      referencedSessions: collectSessionReferences(input.parts),
      replay: promptMedia
        ? { ...replay, historyAttachments: promptMedia.historyAttachments }
        : replay,
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
    pdfContext,
    turnIntent: input.turnIntent,
    cwd: input.cwd,
    projectId: input.projectId,
    permissionProfile: input.permissionProfile,
    agentFrameworkId: input.agentFrameworkId,
    agentBackendId: input.agentBackendId,
    agentModel: input.agentModel,
    agentConfiguration: input.agentConfiguration,
    memoryEnabled: input.memoryEnabled,
    agentTarget: resolveSendAgentTarget(input),
    specialistId: input.specialistId ?? undefined,
    delegationPolicy: input.delegationPolicy,
    enabledComputeHosts: input.enabledComputeHosts,
    selectedComputeHosts: input.selectedComputeHosts
  })
  if (!pending) return undefined
  const preparation = startPendingPrompt(
    runtime,
    {
      ...input,
      pdfContext,
      pending,
      content,
      attachments,
      cwd: input.cwd,
      projectId: input.projectId,
      permissionProfile: input.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      specialistId: input.specialistId ?? undefined,
      turnIntent: input.turnIntent
    },
    lifecycle.onSessionBound,
    lifecycle.onPdfContextLinked,
    lifecycle.onSessionSizeLimit
  )
  if (lifecycle.awaitPendingPreparation) {
    return (await preparation) ? pending : undefined
  }
  void preparation
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
        pdfContext: sourceMessage.pdfContext,
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

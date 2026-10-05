import { prepareDiscussionSendAnnotations } from '../../pages/workspace/discussion-send-context'
import type { SessionDiscussionCapture } from '../../pages/workspace/replay/replay-context'
import {
  clearWorkspaceOperationError,
  reportWorkspaceOperationError
} from './workspace-operation-error'
import {
  attemptWorkspacePromptRollback,
  describeWorkspacePromptRollbackFailure,
  hasPendingWorkspacePromptRollback,
  ownsWorkspacePromptPreparation,
  prepareWorkspacePrompt,
  retryPendingWorkspacePromptRollback,
  rollbackWorkspacePrompt,
  type WorkspacePromptPreparation
} from './workspace-prompt-preparation'
import { i18next } from '../../i18n'
import type { AcpMessageImage } from '../../../../shared/acp'
import type { FileReference } from '../../../../shared/artifacts'
import * as annotationProtocol from '../../../../shared/annotations'
import {
  type PdfReadingPositionSource,
  withPdfContext as withPdf
} from '../../../../shared/session-pdf-context'
import {
  collectSessionReferences,
  materializeSessionConversationGraph,
  isSessionSizeLimitError,
  MAX_SESSION_PDF_CONTEXTS,
  type DelegationPolicy,
  type MessageAttribution,
  type MessagePdfContextSnapshot,
  type MessagePart,
  type ResearchMembership,
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
  DEFAULT_UPLOAD_PROJECT_ID,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from '../../../../shared/uploads'
import {
  getActiveConversationContext,
  rebindConversationGraphSessionId
} from '../../../../shared/conversation-graph'
import {
  confirmPendingDelegationPolicyAuthority,
  deleteSession,
  flushSessionPersistence,
  isSessionPersistenceDeferredError,
  saveSessionInOrder
} from '../session-persistence/session-persistence'
import { toPersistedSession, useSessionStore, type ChatMessage } from '../../stores/session-store'
import {
  buildWorkspaceHistoryReplay,
  resolveHistoryReplayTarget,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  canAdmitExistingWorkspacePrompt,
  consumePendingSessionRetry,
  isPendingSessionRetryable,
  markPendingSessionRetryable,
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
  expectedFrameworkId?: AgentFrameworkId
  sessionId?: string
  // Optional durable caller identity for restart-safe application-owned prompts.
  messageId?: string
  // Renderer-only notification: the real message now replaces the composer's pending preview.
  onMessageAppended?: (message: SendWorkspaceMessageResult) => void
  onPreparationRejected?: (
    error: string,
    sessionId?: string,
    attachments?: UploadedAttachment[]
  ) => void
  branchSourceSessionId?: string
  branchSourceMessageId?: string
  text: string
  attribution?: MessageAttribution
  requireExistingSession?: boolean
  turnIntent?: 'plan-first'
  attachments?: UploadedAttachment[]
  annotations?: annotationProtocol.Annotation[]
  discussionFocus?: SessionDiscussionCapture
  cwd?: string
  projectId?: string
  researchMembership?: ResearchMembership
  permissionProfile?: PermissionProfileId
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  pdfContext?: MessagePdfContextSnapshot
  pdfReadingPosition?: PdfReadingPosition
  pdfReadingPositionSource?: PdfReadingPositionSource
  pendingPdfContextAttachmentIds?: string[]
  pendingPdfContextVersions?: SessionPdfContextSource[]
  parts?: MessagePart[]
  specialistId?: string | null
  enabledComputeHosts?: string[]
  selectedComputeHosts?: string[]
  agentConfiguration?: SessionAgentConfiguration
  memoryEnabled?: boolean
  autoReviewEnabled?: boolean
  delegationPolicy?: DelegationPolicy
  preserveSelection?: boolean
  // Async preparation may finish after the user has opened another composer.
  isOriginCurrent?: () => boolean
  setupSessionToken?: string
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
  // Ownership of asynchronous admission, before the command establishes its own prompt run.
  isCurrent?: () => boolean
  awaitPendingPreparation?: boolean
  awaitPromptAdmission?: boolean
  flushPersistence?: (target?: string) => Promise<void>
  onSendPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void
  onPdfContextLinked?: (sessionId: string, pdfContext: MessagePdfContextSnapshot) => void
  onSessionSizeLimit?: (sessionId: string) => void
}
type ResendEditedMessageInput = {
  expectedFrameworkId?: AgentFrameworkId
  agentConfiguration?: SessionAgentConfiguration
  onMessageAppended?: (message: SendWorkspaceMessageResult) => void
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
const rejectPreparedPrompt = async (
  sessionId: string,
  message: string,
  preparation?: WorkspacePromptPreparation,
  rejected?: (error: string, sessionId?: string, attachments?: UploadedAttachment[]) => void
): Promise<void> => {
  const source = useSessionStore.getState().sessions.find(({ id }) => id === sessionId)
  const prompt = preparation
    ? (source?.conversationGraph?.messages.find(({ id }) => id === preparation.promptMessageId) ??
      source?.messages.find(({ id }) => id === preparation.promptMessageId))
    : undefined
  const restoredAttachments = prompt?.uploads?.map((upload) =>
    toRuntimeUploadedAttachment(upload, source?.projectId)
  )
  let reported = message
  if (preparation) {
    const { rolledBack, failure } = await attemptWorkspacePromptRollback(preparation)
    if (failure !== undefined) {
      // The failed preparation is retained for retry; keep the draft and report both failures.
      reported = describeWorkspacePromptRollbackFailure(message, failure)
    } else if (!rolledBack) return
  }
  reportWorkspaceOperationError(sessionId, reported)
  rejected?.(reported, sessionId, restoredAttachments)
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

type PromptDispatch = {
  sessionId: string
  messageId: string
  content: string
  annotations?: annotationProtocol.Annotation[]
  attachments: UploadedAttachment[]
  forcedSkillIds?: string[]
  referencedArtifacts?: FileReference[]
  referencedSessions?: SessionReference[]
  parts?: MessagePart[]
  replay?: HistoryReplayContext & {
    resumeFallback?: HistoryReplayContext
    contextReset?: boolean
  }
  turnIntent?: SendWorkspaceMessageIntent['turnIntent']
  accepted?: () => void
  preparation?: WorkspacePromptPreparation
  rejected?: (error: string, sessionId?: string, attachments?: UploadedAttachment[]) => void
}

const dispatchPrompt = (
  runtime: WorkspaceCommandRuntime,
  request: PromptDispatch
): Promise<boolean> => {
  // Recovery can rearm the same Message, so its ID cannot identify a dispatch attempt.
  const admittedRun = useSessionStore
    .getState()
    .sessions.find((session) => session.id === request.sessionId)?.activeRun
  const isCurrent = (): boolean => {
    if (request.preparation) return ownsWorkspacePromptPreparation(request.preparation)
    const current = useSessionStore
      .getState()
      .sessions.find((session) => session.id === request.sessionId)?.activeRun
    return (
      admittedRun !== undefined &&
      current?.promptMessageId === admittedRun.promptMessageId &&
      current.startedAt === admittedRun.startedAt
    )
  }
  let resolveAdmission!: (accepted: boolean) => void
  const admission = new Promise<boolean>((resolve) => {
    resolveAdmission = resolve
  })
  const unsubscribe = useSessionStore.subscribe(() => {
    if (!request.preparation) return
    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === request.sessionId)
    if (
      session?.runtimeSessionAdmissions?.some(
        ({ promptMessageId, executionId }) =>
          promptMessageId === request.messageId &&
          !request.preparation!.previousAdmissionIds.has(executionId)
      )
    ) {
      unsubscribe()
      resolveAdmission(true)
    }
  })
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
  let result: ReturnType<WorkspaceCommandRuntime['sendPrompt']>
  try {
    result =
      currentImages?.length || request.parts?.length
        ? runtime.sendPrompt(...args, referencedSessions, currentImages, request.parts)
        : referencedSessions
          ? runtime.sendPrompt(...args, referencedSessions)
          : runtime.sendPrompt(...args)
  } catch (error) {
    unsubscribe()
    throw error
  }
  void result
    .then(() => {
      unsubscribe()
      request.accepted?.()
      resolveAdmission(true)
    })
    .catch(async (error) => {
      unsubscribe()
      if (isCurrent()) {
        const message = errorMessage(error).trim() || 'Agent run failed'
        await rejectPreparedPrompt(
          request.sessionId,
          message,
          request.preparation,
          request.rejected
        )
      }
      resolveAdmission(false)
    })
  return admission
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

const readingSourceForSend = (
  request: Pick<SendWorkspaceMessageIntent, 'pdfReadingPositionSource' | 'pdfContext'>,
  attachments: UploadedAttachment[]
): SessionPdfContextSource | undefined => {
  const identity = request.pdfReadingPositionSource
  if (!identity) {
    return request.pdfContext?.bindings.find(
      (binding) =>
        binding.bindingId ===
        (request.pdfContext?.activeBindingId ?? request.pdfContext?.bindings[0]?.bindingId)
    )
  }
  if (!('attachmentId' in identity)) return identity
  const attachment = attachments.find(({ id }) => id === identity.attachmentId)
  return attachment?.versionId
    ? { sourceKind: 'upload-version', sourceVersionId: attachment.versionId }
    : undefined
}

const linkPdfContextForSend = async ({
  sessionId,
  pendingSessionId,
  projectId,
  sources,
  pdfReadingPosition,
  readingSource,
  excludeSinglePage = false,
  materializedRuntimeRevision
}: {
  sessionId: string
  pendingSessionId?: string
  projectId: string | undefined
  sources: SessionPdfContextSource[]
  pdfReadingPosition?: PdfReadingPosition
  readingSource?: SessionPdfContextSource
  excludeSinglePage?: boolean
  materializedRuntimeRevision?: number
}): Promise<MessagePdfContextSnapshot | undefined> => {
  if (!projectId) throw new Error('The PDF Project is unavailable for Session context.')
  const localSessionId = pendingSessionId ?? sessionId
  let source = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === localSessionId)
  if (!source) throw new Error(`Session not found: ${localSessionId}`)
  const expectedRevision = materializedRuntimeRevision ?? source.runtimeContext?.revision ?? 0

  const runtimeContext: SessionRuntimeContext = await window.api.sessions.linkPdfContext({
    projectId,
    sessionId,
    expectedRevision,
    sources,
    ...(excludeSinglePage ? { excludeSinglePage: true } : {})
  })
  const pdfContext = runtimeContext.pdfContext
  const readingBinding = readingSource
    ? pdfContext?.bindings.find(
        (binding) =>
          binding.sourceKind === readingSource.sourceKind &&
          binding.sourceVersionId === readingSource.sourceVersionId
      )
    : undefined
  const activeBinding =
    readingBinding ??
    sources
      .map(({ sourceKind, sourceVersionId }) =>
        pdfContext?.bindings.find(
          (binding) =>
            binding.sourceKind === sourceKind && binding.sourceVersionId === sourceVersionId
        )
      )
      .find((binding) => binding !== undefined)
  const canApplyReadingPosition = readingBinding !== undefined && pdfReadingPosition !== undefined
  const messagePdfContext: MessagePdfContextSnapshot | undefined = pdfContext
    ? {
        ...pdfContext,
        ...(activeBinding ? { activeBindingId: activeBinding.bindingId } : {}),
        ...(canApplyReadingPosition ? { readingPosition: pdfReadingPosition } : {})
      }
    : undefined

  source = useSessionStore.getState().sessions.find((candidate) => candidate.id === localSessionId)
  if (!source) throw new Error(`Session not found: ${localSessionId}`)
  useSessionStore.getState().applyDurableSessionProjection({
    source,
    session: {
      ...toPersistedSession(source),
      runtimeContext,
      updatedAt: Math.max(source.updatedAt, Date.now())
    },
    mode: 'runtime-context-authority'
  })
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
  const missingLiterature = (request.pendingPdfContextVersions ?? []).filter(
    (source) =>
      source.sourceKind === 'literature-attachment-version' &&
      !eligible.sources.some(
        (available) =>
          available.sourceKind === source.sourceKind &&
          available.sourceVersionId === source.sourceVersionId
      )
  )
  if (missingLiterature.length) {
    throw new Error(
      i18next.t(
        'Selected literature versions are unavailable: {{versions}}. Remove or reselect them before sending.',
        { versions: missingLiterature.map(({ sourceVersionId }) => sourceVersionId).join(', ') }
      )
    )
  }
  return {
    attachmentIds: [...eligible.pendingAttachmentIds],
    versions: [...eligible.sources]
  }
}

const pendingPromptSeed = (
  source: Parameters<typeof toPersistedSession>[0],
  promptMessageId: string,
  sessionId = source.id
): ReturnType<typeof toPersistedSession> => {
  const seed = toPersistedSession(source)
  const graph =
    seed.conversationGraph &&
    rebindConversationGraphSessionId(seed.conversationGraph, source.id, sessionId)
  const prompt = graph?.messages.find(({ id }) => id === promptMessageId)
  return {
    ...seed,
    id: sessionId,
    status: 'idle',
    delegationPolicy: source.delegationPolicyAuthorityPending ? 'allow' : seed.delegationPolicy,
    activeRun: undefined,
    error: undefined,
    errorReportable: undefined,
    messages: seed.messages.filter(({ id }) => id !== promptMessageId),
    ...(graph
      ? {
          conversationGraph: {
            ...graph,
            messages: graph.messages.filter(({ id }) => id !== promptMessageId),
            branches: graph.branches.map((branch) =>
              branch.headMessageId === promptMessageId
                ? { ...branch, headMessageId: prompt?.parentMessageId }
                : branch
            )
          }
        }
      : {})
  }
}
const rejectUnboundPendingPrompt = async (
  pending: SendWorkspaceMessageResult,
  message: string,
  rejected?: (error: string, sessionId?: string, attachments?: UploadedAttachment[]) => void
): Promise<void> => {
  const source = useSessionStore.getState().sessions.find(({ id }) => id === pending.sessionId)
  if (source?.isPending) markPendingSessionRetryable(source.id)
  if (source?.isPending && source.activeRun?.promptMessageId === pending.messageId) {
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: pendingPromptSeed(source, pending.messageId),
      mode: 'prompt-rollback-authority'
    })
    // A rejected pending admission may have a queued start-run command replayed by the
    // authority projection. Keep the optimistic pending Session idle so the same composer can
    // retry without exposing a renderer-owned terminal error state.
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === pending.sessionId && candidate.isPending
          ? {
              ...candidate,
              status: 'idle',
              activeRun: undefined,
              activeRunRuntimeSegmentId: undefined,
              agentStatus: undefined,
              awaitingFirstAgentOutput: undefined,
              agentPromptInFlight: undefined
            }
          : candidate
      )
    }))
  }
  await rejectPreparedPrompt(pending.sessionId, message, undefined, rejected)
}

const discardUnboundSeedSession = async (
  runtime: WorkspaceCommandRuntime,
  projectId: string,
  sessionId: string
): Promise<string | undefined> => {
  try {
    // The terminal deletion owner removes runtime, JSON and file relations in order.
    const result = await deleteSession({ projectId, sessionId })
    if (result.status === 'deleted') return undefined
    return i18next.t('Agent Session cleanup did not complete.')
  } catch (error) {
    try {
      await runtime.deleteSession?.(sessionId)
    } catch {
      // The reported failure below already names the Session cleanup problem.
    }
    return errorMessage(error)
  }
}

const startPendingPrompt = (
  runtime: WorkspaceCommandRuntime,
  request: PendingPromptRequest,
  onSessionBound?: (pendingSessionId: string, sessionId: string) => void,
  onPdfContextLinked?: (sessionId: string, pdfContext: MessagePdfContextSnapshot) => void,
  onSessionSizeLimit?: (sessionId: string) => void
): Promise<SendWorkspaceMessageResult | undefined> => {
  let bindingSessionId: string | undefined
  return (async () => {
    let promptPreparation: WorkspacePromptPreparation | undefined
    const pending = request.pending
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return undefined
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
        ? await runtime.createSession(...createSessionArgs, true, request.setupSessionToken)
        : await runtime.createSession(...createSessionArgs, undefined, request.setupSessionToken)
    } catch (error) {
      if (ownsPrompt(pending.sessionId, pending.messageId)) {
        await rejectUnboundPendingPrompt(
          pending,
          createSessionFailureMessage(error),
          request.onPreparationRejected
        )
      }
      return undefined
    }
    if (!ownsPrompt(pending.sessionId, pending.messageId)) return undefined
    if (!created?.sessionId) {
      await rejectUnboundPendingPrompt(
        pending,
        'Agent session could not be created.',
        request.onPreparationRejected
      )
      return undefined
    }
    const cwd = created.cwd ?? request.cwd
    if (!cwd) {
      await rejectUnboundPendingPrompt(
        pending,
        'Agent session did not return a workspace.',
        request.onPreparationRejected
      )
      return undefined
    }
    const pendingSession = useSessionStore
      .getState()
      .sessions.find((session) => session.id === pending.sessionId)
    if (!pendingSession) return undefined
    // Persist an empty/copied-history seed while the optimistic prompt remains isPending and
    // invisible to the saver. Main then captures a real baseline before binding publishes it.
    const seed = pendingPromptSeed(pendingSession, pending.messageId, created.sessionId)
    Object.assign(seed, {
      cwd,
      agentFrameworkId: created.frameworkId,
      agentBackendId: created.backendId,
      providerSessionId: created.providerSessionId,
      providerContinuityToken: created.providerContinuityToken
    })
    let attachments = request.attachments
    let pdfContext = request.pdfContext
    let delegationAuthority: ReturnType<typeof toPersistedSession> | undefined
    const bindPreparedPrompt = (): string | undefined => {
      const bound = useSessionStore.getState().bindPendingSession({
        pendingSessionId: pending.sessionId,
        sessionId: created.sessionId,
        cwd,
        agentFrameworkId: created.frameworkId,
        agentBackendId: created.backendId,
        providerSessionId: created.providerSessionId,
        providerContinuityToken: created.providerContinuityToken,
        wslSetup: created.wslSetup,
        preparationId: promptPreparation!.id,
        preparationBaseline: promptPreparation!.authority
      })
      if (!bound) return undefined
      onSessionBound?.(pending.sessionId, created.sessionId)
      if (delegationAuthority)
        useSessionStore.getState().applyDelegationPolicyAuthority(promptPreparation!.authority)
      return bound?.messageId
    }
    const rollbackCancelledPreparation = async (): Promise<void> => {
      const current = useSessionStore.getState().sessions.find(({ id }) => id === pending.sessionId)
      // Keep Stop/retry attached to the created identity, but never bind a newer pending run
      // to this attempt's preparation after Stop followed by Send.
      if (
        current?.isPending &&
        !current.activeRun &&
        current.messages.some(({ id }) => id === pending.messageId)
      )
        bindPreparedPrompt()
      const rollback = await attemptWorkspacePromptRollback(promptPreparation!)
      if (rollback.failure !== undefined) {
        if (!useSessionStore.getState().sessions.some(({ id }) => id === created.sessionId))
          useSessionStore.getState().upsertPersistedSession(promptPreparation!.authority)
        reportWorkspaceOperationError(
          created.sessionId,
          describeWorkspacePromptRollbackFailure(undefined, rollback.failure)
        )
      }
    }
    // Main publishes the seed before preparation finishes. Keep that authority in the store,
    // but present only its optimistic row until binding replaces the two identities atomically.
    bindingSessionId = created.sessionId
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === pending.sessionId && session.isPending
          ? { ...session, pendingBindingSessionId: bindingSessionId }
          : session
      )
    }))
    let seedPersisted = false
    try {
      const durableSeed = await saveSessionInOrder(seed)
      seedPersisted = true
      if (!ownsPrompt(pending.sessionId, pending.messageId)) return undefined
      promptPreparation = await prepareWorkspacePrompt(durableSeed, pending.messageId, 'new')
      if (!ownsPrompt(pending.sessionId, pending.messageId)) {
        await rollbackCancelledPreparation()
        return undefined
      }
      // Keep the optimistic prompt pending until its immutable inputs are complete. Binding
      // publishes append/start intents and makes the Session visible to the background saver.
      if (pendingSession.delegationPolicyAuthorityPending) {
        delegationAuthority = await window.api.sessions.setDelegationPolicy(
          durableSeed.projectId,
          durableSeed.id,
          pendingSession.delegationPolicy ?? 'allow'
        )
        promptPreparation.authority = delegationAuthority
        if (!ownsPrompt(pending.sessionId, pending.messageId)) {
          await rollbackCancelledPreparation()
          return undefined
        }
      }
      attachments = await finalizeWorkspaceAttachments({
        sessionId: created.sessionId,
        attachments,
        projectId: request.projectId
      })
      useSessionStore.getState().replaceMessageUploads({
        sessionId: pending.sessionId,
        messageId: pending.messageId,
        uploads: attachments.map(toPersistedUploadedAttachment)
      })
      if (!ownsPrompt(pending.sessionId, pending.messageId)) {
        await rollbackCancelledPreparation()
        return undefined
      }
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
          pendingSessionId: pending.sessionId,
          projectId: request.projectId,
          sources: pdfContextSources,
          pdfReadingPosition: request.pdfReadingPosition,
          readingSource: readingSourceForSend(request, attachments),
          excludeSinglePage: true,
          materializedRuntimeRevision:
            (delegationAuthority ?? durableSeed).runtimeContext?.revision ?? 0
        })
        if (!ownsPrompt(pending.sessionId, pending.messageId)) {
          await rollbackCancelledPreparation()
          return undefined
        }
        if (pdfContext)
          useSessionStore.getState().replaceMessagePdfContext({
            sessionId: pending.sessionId,
            messageId: pending.messageId,
            pdfContext
          })
      }
    } catch (error) {
      if (promptPreparation) {
        if (!ownsPrompt(pending.sessionId, pending.messageId)) {
          await rollbackCancelledPreparation()
          return undefined
        }
        const messageId = bindPreparedPrompt()
        if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(created.sessionId)
        if (pendingSession.delegationPolicyAuthorityPending && !delegationAuthority) {
          try {
            await runtime.deleteSession?.(created.sessionId)
          } catch (cleanupError) {
            console.warn('Agent Session cleanup after persistence failure failed', cleanupError)
          }
        }
        if (messageId && ownsPrompt(created.sessionId, messageId))
          await rejectPreparedPrompt(
            created.sessionId,
            errorMessage(error),
            promptPreparation,
            request.onPreparationRejected
          )
        return undefined
      }
      if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(pending.sessionId)
      // The pending Session retries by creating a new Agent Session, so the seed persisted under
      // created.sessionId (it may carry copied Branch history) would otherwise remain as a ghost.
      // Only this attempt's own new Session is deleted; a Branch source is never touched.
      const cleanupFailure = seedPersisted
        ? await discardUnboundSeedSession(runtime, pendingSession.projectId, created.sessionId)
        : undefined
      const message = errorMessage(error)
      await rejectUnboundPendingPrompt(
        pending,
        cleanupFailure === undefined
          ? message
          : `${message}\n\n${i18next.t('The unsent Session could not be removed ({{failure}}).', {
              failure: cleanupFailure
            })}`,
        request.onPreparationRejected
      )
      return undefined
    }
    const boundMessageId = bindPreparedPrompt()
    if (!boundMessageId || !ownsPrompt(created.sessionId, boundMessageId)) return undefined

    if (
      pdfContext &&
      (eligiblePendingPdfContext.attachmentIds.length > 0 ||
        eligiblePendingPdfContext.versions.length > 0)
    )
      onPdfContextLinked?.(created.sessionId, pdfContext)

    try {
      const ready = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === created.sessionId)
      if (!ready) return undefined
      await saveSessionInOrder(toPersistedSession(ready))
    } catch (error) {
      if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(created.sessionId)
      await rejectPreparedPrompt(
        created.sessionId,
        errorMessage(error),
        promptPreparation,
        request.onPreparationRejected
      )
      return undefined
    }
    if (!ownsPrompt(created.sessionId, boundMessageId)) {
      await rollbackWorkspacePrompt(promptPreparation)
      return undefined
    }
    try {
      dispatchPrompt(runtime, {
        sessionId: created.sessionId,
        messageId: boundMessageId,
        content: request.content,
        annotations: request.annotations,
        attachments,
        forcedSkillIds: request.forcedSkillIds,
        referencedArtifacts: withPdf(request.projectId, request.referencedArtifacts, pdfContext),
        referencedSessions: collectSessionReferences(request.parts),
        parts: request.parts,
        replay: {
          ...request.replay,
          ...(request.specialistId ? { resumeFallback: request.replay } : {}),
          contextReset: Boolean(request.contextReset)
        },
        turnIntent: request.turnIntent,
        preparation: promptPreparation,
        rejected: request.onPreparationRejected,
        accepted: () =>
          useSessionStore.getState().clearPendingContextReplay(created.sessionId, boundMessageId)
      })
    } catch (error) {
      if (ownsWorkspacePromptPreparation(promptPreparation)) {
        await rejectPreparedPrompt(
          created.sessionId,
          errorMessage(error),
          promptPreparation,
          request.onPreparationRejected
        )
      }
      return undefined
    }
    return { sessionId: created.sessionId, messageId: boundMessageId }
  })().finally(() => {
    if (!bindingSessionId) return
    // Release on every exit, including cancellation and failed preparation. An older attempt
    // must not release a newer retry's binding or hide an orphan whose cleanup failed.
    useSessionStore.setState((state) => {
      if (
        !state.sessions.some(
          (session) =>
            session.id === request.pending.sessionId &&
            session.pendingBindingSessionId === bindingSessionId
        )
      )
        return state
      return {
        sessions: state.sessions.map((session) =>
          session.id === request.pending.sessionId &&
          session.pendingBindingSessionId === bindingSessionId
            ? { ...session, pendingBindingSessionId: undefined }
            : session
        )
      }
    })
  })
}

const performSendWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: SendWorkspaceMessageCommand,
  lifecycle: WorkspaceCommandLifecycle = {}
): Promise<SendWorkspaceMessageResult | undefined> => {
  let promptPreparation: WorkspacePromptPreparation | undefined
  if (input.sessionId) clearWorkspaceOperationError(input.sessionId)
  if (input.sessionId && hasPendingWorkspacePromptRollback(input.sessionId)) {
    // A prior rejected preparation whose rollback failed still owns the Session in Main.
    const { failure } = await retryPendingWorkspacePromptRollback(input.sessionId)
    if (failure !== undefined) {
      reportWorkspaceOperationError(input.sessionId, failure)
      return undefined
    }
  }
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
  if (lifecycle.isCurrent?.() === false) return undefined
  const content = input.text.trim()
  const replaySession = input.sessionId
    ? useSessionStore.getState().sessions.find((item) => item.id === input.sessionId)
    : undefined
  const replayPrompt = replaySession?.pendingContextReplayMessageId
    ? replaySession.messages.find((item) => item.id === replaySession.pendingContextReplayMessageId)
    : undefined
  const initialReadingSource = readingSourceForSend(input, [])
  const initialReadingBinding = input.pdfContext?.bindings.find(
    (binding) =>
      binding.sourceKind === initialReadingSource?.sourceKind &&
      binding.sourceVersionId === initialReadingSource.sourceVersionId
  )
  let pdfContext = replayPrompt
    ? replayPrompt.pdfContext
    : input.pdfContext && input.pdfReadingPosition && initialReadingBinding
      ? {
          ...input.pdfContext,
          activeBindingId: initialReadingBinding.bindingId,
          readingPosition: input.pdfReadingPosition
        }
      : input.pdfContext
  const attachments = input.attachments ?? []
  const annotations =
    input.discussionFocus && !replayPrompt
      ? await prepareDiscussionSendAnnotations(input.annotations ?? [], input.discussionFocus)
      : (input.annotations ?? [])
  if (lifecycle.isCurrent?.() === false) return undefined
  input = { ...input, annotations }
  if (annotationProtocol.validateAnnotations(annotations, content)) return undefined
  if (
    input.supportsImageInput !== true &&
    input.supportsImageRelay !== true &&
    annotations.some(
      (annotation) =>
        annotation.kind === 'pdf' &&
        annotation.selector.kind === 'region' &&
        !!annotation.selector.image
    )
  ) {
    throw new Error(VISION_MODEL_NOT_CONFIGURED_MESSAGE)
  }
  await validateImageAnnotationSourcesBeforeSend(annotations)
  if (lifecycle.isCurrent?.() === false) return undefined
  const effectiveAttachments =
    attachments.length > 0 || !replayPrompt?.uploads?.length
      ? attachments
      : replayPrompt.uploads.map((upload) =>
          toRuntimeUploadedAttachment(upload, replaySession?.projectId)
        )
  if (!content && effectiveAttachments.length === 0 && annotations.length === 0) return undefined

  // Validate explicit library choices before adding a message or creating a pending Session,
  // so the composer's existing rejection path preserves the draft and selection.
  const selectedLiterature = input.pendingPdfContextVersions?.filter(
    ({ sourceKind }) => sourceKind === 'literature-attachment-version'
  )
  if (selectedLiterature?.length) {
    await filterPendingPdfContext({
      projectId: input.projectId ?? replaySession?.projectId,
      attachments: [],
      pendingPdfContextVersions: selectedLiterature
    })
    if (lifecycle.isCurrent?.() === false) return undefined
  }

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
    input.onMessageAppended?.(pendingPrompt)
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
      await rejectUnboundPendingPrompt(
        pendingPrompt,
        errorMessage(error),
        input.onPreparationRejected
      )
      return undefined
    }
    let replay: HistoryReplayContext | undefined
    try {
      replay = replayHistory(history, input, session.projectId)
    } catch (error) {
      await rejectUnboundPendingPrompt(
        pendingPrompt,
        errorMessage(error),
        input.onPreparationRejected
      )
      return undefined
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
              pdfReadingPosition: pdfContext.readingPosition,
              pdfReadingPositionSource: readingSourceForSend({ pdfContext }, [])
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
      return preparation
    }
    void preparation.catch((error) =>
      rejectUnboundPendingPrompt(pendingPrompt, errorMessage(error), input.onPreparationRejected)
    )
    return pendingPrompt
  }

  if (input.sessionId) {
    const sessionId = input.sessionId
    let session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
    const stableMessageId = input.messageId?.trim()
    const submissionMessageId = stableMessageId ?? `message-${crypto.randomUUID()}`
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
          message.role === 'agent' &&
          message.responseToMessageId === existingStableMessage.id &&
          !(input.allowCompactionRecovery && message.status === 'error')
      )
      if (hasResponse || session?.activeRun?.promptMessageId === existingStableMessage.id) {
        return { sessionId, messageId: existingStableMessage.id }
      }
      rearmExistingStableMessage = true
    }
    if (input.requireExistingSession && !session) return undefined
    const pendingRetry = Boolean(session?.isPending && isPendingSessionRetryable(sessionId))
    if (!pendingRetry && !canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
    if (session?.delegationPolicyAuthorityPending) {
      try {
        await confirmPendingDelegationPolicyAuthority(session)
        if (lifecycle.isCurrent?.() === false) return undefined
        session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
      } catch (error) {
        if (lifecycle.isCurrent?.() === false) return undefined
        if (session?.isPending) markPendingSessionRetryable(sessionId)
        reportWorkspaceOperationError(sessionId, errorMessage(error))
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
          markPendingSessionRetryable(session.id)
          reportWorkspaceOperationError(session.id, errorMessage(error))
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
        preserveSelection: input.preserveSelection || input.isOriginCurrent?.() === false
      })
      if (!appended) return undefined
      // This submission now owns the retry; a concurrent send must not also bypass admission.
      consumePendingSessionRetry(sessionId)
      input.onMessageAppended?.(appended)
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
        return preparation
      }
      void preparation
      return appended
    }

    // An unresolved earlier save must not append another unsent user Message on every retry.
    // Stable application-owned messages already have identity-based retry handling below.
    if (!stableMessageId) {
      try {
        await (lifecycle.flushPersistence ?? flushSessionPersistence)(`session:${sessionId}`)
      } catch (error) {
        if (lifecycle.isCurrent?.() === false) return undefined
        if (isSessionPersistenceDeferredError(error)) return undefined
        if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
        reportWorkspaceOperationError(sessionId, errorMessage(error))
        return undefined
      }
      if (lifecycle.isCurrent?.() === false) return undefined
      if (!canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
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
        includeResumeFallback: Boolean(input.forcedSkillIds?.length || session?.specialistId)
      },
      onPreparationStateChange: lifecycle.onSendPreparationStateChange,
      drainRuntimeEvents: lifecycle.drainRuntimeEvents,
      isCurrent: lifecycle.isCurrent
    })
    if (lifecycle.isCurrent?.() === false) return undefined
    if (!prepared) return undefined
    let promptAttachments
    try {
      const eligiblePendingPdfContext = await filterPendingPdfContext({
        attachments: effectiveAttachments,
        pendingPdfContextAttachmentIds: input.pendingPdfContextAttachmentIds,
        pendingPdfContextVersions: input.pendingPdfContextVersions,
        projectId
      })
      if (lifecycle.isCurrent?.() === false) return undefined
      promptAttachments = await finalizeWorkspaceAttachments({
        sessionId,
        attachments: effectiveAttachments,
        projectId,
        preserveSourceOwnership: Boolean(input.truncateFromMessageId)
      })
      if (lifecycle.isCurrent?.() === false) return undefined
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
          readingSource: readingSourceForSend(input, promptAttachments),
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
      if (lifecycle.isCurrent?.() === false) return undefined
      if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
      reportWorkspaceOperationError(sessionId, errorMessage(error))
      return undefined
    }
    if (lifecycle.isCurrent?.() === false) return undefined
    if (!canAdmitExistingWorkspacePrompt(runtime.state, input)) return undefined
    // Replay conversion may reject malformed media; complete it before establishing a run.
    const replay = prepared.replay()
    let preparationSource = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)
    if (!preparationSource) {
      const now = Date.now()
      const seed = materializeSessionConversationGraph({
        id: sessionId,
        projectId: projectId ?? DEFAULT_UPLOAD_PROJECT_ID,
        title: content.slice(0, 80),
        cwd: input.cwd ?? runtime.state.cwd ?? '',
        status: 'idle',
        messages: [],
        createdAt: now,
        updatedAt: now,
        permissionProfile: input.permissionProfile,
        agentFrameworkId: input.agentFrameworkId,
        agentBackendId: input.agentBackendId,
        agentConfiguration: input.agentConfiguration,
        memoryEnabled: input.memoryEnabled,
        researchMembership: input.researchMembership,
        autoReviewEnabled: input.autoReviewEnabled
      })
      try {
        const durable = await saveSessionInOrder(seed)
        if (lifecycle.isCurrent?.() === false) return undefined
        useSessionStore.getState().upsertPersistedSession(durable)
        preparationSource = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
      } catch (error) {
        if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
        await rejectPreparedPrompt(
          sessionId,
          errorMessage(error),
          undefined,
          input.onPreparationRejected
        )
        return undefined
      }
    }
    if (!preparationSource) return undefined
    try {
      // Establish the receipt before the first append or edit Branch command can be saved.
      promptPreparation = await prepareWorkspacePrompt(
        toPersistedSession(preparationSource),
        submissionMessageId,
        rearmExistingStableMessage ? (preparationSource.resumeRecovery ? 'resume' : 'rearm') : 'new'
      )
    } catch (error) {
      if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
      await rejectPreparedPrompt(
        sessionId,
        errorMessage(error),
        undefined,
        input.onPreparationRejected
      )
      return undefined
    }
    if (lifecycle.isCurrent?.() === false) {
      await rollbackWorkspacePrompt(promptPreparation)
      return undefined
    }
    if (input.truncateFromMessageId) {
      useSessionStore
        .getState()
        .truncateSessionFromMessage(sessionId, input.truncateFromMessageId, promptPreparation.id)
    }
    const appended = useSessionStore.getState().appendUserMessage({
      sessionId,
      messageId: submissionMessageId,
      preparationId: promptPreparation.id,
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
      preserveSelection: input.preserveSelection || input.isOriginCurrent?.() === false
    })
    if (!appended) return undefined
    input.onMessageAppended?.(appended)
    // Application-owned stable identities need an explicit save because they may be dispatched
    // outside the mounted store saver. Ordinary user Messages are already queued by that saver;
    // drain it before provider dispatch so Delegation cannot authenticate against a stale root
    // conversation snapshot. Main-owned recovery also persists its new start-run command before
    // dispatch, even though the user Message already exists in the durable transcript.
    const mainOwnedRecovery =
      input.allowCompactionRecovery &&
      rearmExistingStableMessage &&
      useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
        ?.runtimeTranscriptOwner === 'main'
    if (
      stableMessageId &&
      (!(input.allowCompactionRecovery && rearmExistingStableMessage) || mainOwnedRecovery)
    ) {
      const durableSession = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!durableSession) return undefined
      try {
        await saveSessionInOrder(toPersistedSession(durableSession))
      } catch (error) {
        if (isSessionPersistenceDeferredError(error)) return undefined
        if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
        await rejectPreparedPrompt(
          sessionId,
          errorMessage(error),
          promptPreparation,
          input.onPreparationRejected
        )
        return undefined
      }
      if (!ownsPrompt(sessionId, appended.messageId)) return undefined
    } else if (!rearmExistingStableMessage) {
      try {
        await (lifecycle.flushPersistence ?? flushSessionPersistence)(`session:${sessionId}`)
      } catch (error) {
        if (isSessionPersistenceDeferredError(error)) return undefined
        if (isSessionSizeLimitError(error)) lifecycle.onSessionSizeLimit?.(sessionId)
        await rejectPreparedPrompt(
          sessionId,
          errorMessage(error),
          promptPreparation,
          input.onPreparationRejected
        )
        return undefined
      }
      if (!ownsPrompt(sessionId, appended.messageId)) return undefined
    }
    const promptMedia =
      input.truncateFromMessageId && promptAttachments.length > 0
        ? partitionWorkspacePromptAttachments({
            historyAttachments: replay?.historyAttachments,
            latestAttachments: promptAttachments,
            supportsImageInput: input.supportsImageInput,
            supportsImageRelay: input.supportsImageRelay
          })
        : undefined
    try {
      const admission = dispatchPrompt(runtime, {
        sessionId,
        messageId: appended.messageId,
        content,
        annotations,
        attachments: promptMedia?.currentAttachments ?? promptAttachments,
        forcedSkillIds: input.forcedSkillIds,
        referencedArtifacts: withPdf(projectId, input.referencedArtifacts, pdfContext),
        referencedSessions: collectSessionReferences(input.parts),
        parts: input.parts,
        replay: promptMedia
          ? { ...replay, historyAttachments: promptMedia.historyAttachments }
          : replay,
        turnIntent: input.turnIntent,
        accepted: () => prepared.acceptPrompt(appended.messageId),
        preparation: promptPreparation,
        rejected: input.onPreparationRejected
      })
      if (lifecycle.awaitPromptAdmission && !(await admission)) return undefined
    } catch (error) {
      if (ownsWorkspacePromptPreparation(promptPreparation)) {
        await rejectPreparedPrompt(
          sessionId,
          errorMessage(error),
          promptPreparation,
          input.onPreparationRejected
        )
      }
      return undefined
    }
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
    autoReviewEnabled: input.autoReviewEnabled,
    agentTarget: resolveSendAgentTarget(input),
    specialistId: input.specialistId ?? undefined,
    delegationPolicy: input.delegationPolicy,
    enabledComputeHosts: input.enabledComputeHosts,
    selectedComputeHosts: input.selectedComputeHosts,
    researchMembership: input.researchMembership,
    preserveSelection: input.preserveSelection || input.isOriginCurrent?.() === false
  })
  if (!pending) return undefined
  input.onMessageAppended?.(pending)
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
    return preparation
  }
  void preparation.catch((error) =>
    rejectUnboundPendingPrompt(pending, errorMessage(error), input.onPreparationRejected)
  )
  return pending
}

const preparingSessionIds = new Set<string>()
const sendWorkspaceMessage = async (
  runtime: WorkspaceCommandRuntime,
  input: SendWorkspaceMessageCommand,
  lifecycle: WorkspaceCommandLifecycle = {}
): Promise<SendWorkspaceMessageResult | undefined> => {
  const sessionId = input.sessionId
  // Establish the local admission gate before the first persistence/preparation await. An idle
  // Session stays idle until append; two commands must not both capture that same baseline.
  if (sessionId && preparingSessionIds.has(sessionId)) return undefined
  if (sessionId) preparingSessionIds.add(sessionId)
  try {
    return await performSendWorkspaceMessage(runtime, input, lifecycle)
  } finally {
    if (sessionId) preparingSessionIds.delete(sessionId)
  }
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
    reportWorkspaceOperationError(input.sessionId, errorMessage(error))
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
        turnIntent:
          sourceMessage.turnIntent === 'plan-first' ? sourceMessage.turnIntent : undefined,
        agentFrameworkId: options.agentFrameworkId,
        agentBackendId: options.agentBackendId,
        agentModel: options.agentModel,
        agentConfiguration: options.agentConfiguration,
        onMessageAppended: input.onMessageAppended,
        historyReplayDescriptor: options.historyReplayDescriptor,
        truncateFromMessageId: input.messageId,
        supportsImageInput: options.supportsImageInput,
        supportsImageRelay: options.supportsImageRelay
      },
      { ...options, awaitPromptAdmission: true }
    )
  )
}
export { resendEditedWorkspaceMessage, sendWorkspaceMessage }
export type { ResendEditedMessageInput, SendWorkspaceMessageIntent, SendWorkspaceMessageResult }

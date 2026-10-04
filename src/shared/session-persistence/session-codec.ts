import { researchMembershipSchema } from './session'
import { sanitizePromptPreparation, resolvePreparationNoticeBaseline } from './prompt-preparation'
import {
  type PersistedSessionStatus,
  type PersistedActiveRun,
  type PersistedSessionResumeRecovery,
  type PersistedPendingHistoryReplay,
  type PersistedSessionBranchSource,
  type PersistedChatSession,
  normalizeDelegationPolicy,
  type PersistedRuntimeSessionAdmission,
  SESSION_DETAILS_DESCRIPTION_MAX_LENGTH
} from './session'
import {
  asString,
  isRecord,
  asNumber,
  hasOnlyFields,
  asStringArray,
  AGENT_FRAMEWORK_IDS
} from './primitives'
import {
  type SessionAgentConfiguration,
  isReasoningEffort,
  type AgentFrameworkId
} from '../settings'
import { sanitizeArtifact, sanitizeSessionMessageImages } from './message-content'
import {
  type PersistedArtifact,
  type PersistedToolActivity,
  type PersistedActivityGroup,
  type PersistedChatMessage,
  isHumanUserMessage,
  isHiddenControlMessage
} from './message'
import { sanitizeToolActivity, sanitizeActivityGroup } from './tool-activity'
import {
  normalizeActivityGroupAfterRestore,
  normalizeSessionAfterRestore,
  rearmUnacceptedElicitationContinuations,
  restorePendingElicitationWait,
  resolveRestorablePermissionToolAuthority,
  normalizeActivityAfterRestore
} from './restore'
import { DEFAULT_PERMISSION_PROFILE, normalizePermissionProfile } from '../permission-profiles'
import { sanitizeMessage } from './message-codec'
import { sanitizeSessionDetailsGeneration } from './details'
import { packageOriginSchema } from '../session-package'
import { sanitizeAcpContextUsage } from '../acp'
import { sanitizeSessionRuntimeContext } from './runtime-context'
import { sanitizePlanHistoryProjections } from './plan'
import { sanitizeConversationGraph } from './conversation-graph'
import { projectActiveNestedDelegateActivities } from '../session-conversation-graph-materialization'
import {
  resolveActiveConversationMessages,
  projectConversationMessage,
  createLinearConversationGraph
} from '../conversation-graph'

const SESSION_STATUSES = new Set<PersistedSessionStatus>([
  'idle',
  'running',
  'waiting-for-user',
  'waiting-permission',
  'waiting-plan-approval',
  'error'
])

// Defaults unknown session statuses to idle instead of restoring phantom runtime state.
const asSessionStatus = (value: unknown): PersistedSessionStatus => {
  const status = asString(value) as PersistedSessionStatus | undefined

  return status && SESSION_STATUSES.has(status) ? status : 'idle'
}

// Keeps the active run pointer only when both its message id and timestamp are valid.
const sanitizeActiveRun = (activeRun: unknown): PersistedActiveRun | undefined => {
  if (!isRecord(activeRun)) return undefined

  const promptMessageId = asString(activeRun.promptMessageId)
  const startedAt = asNumber(activeRun.startedAt)

  return promptMessageId && startedAt !== undefined ? { promptMessageId, startedAt } : undefined
}

const sanitizeSessionResumeRecovery = (
  recovery: unknown
): PersistedSessionResumeRecovery | undefined => {
  if (!isRecord(recovery) || recovery.kind !== 'resume-required') return undefined
  if (
    recovery.cause !== 'app-restart' &&
    recovery.cause !== 'cancelled' &&
    recovery.cause !== 'connection-lost'
  ) {
    return undefined
  }
  const promptMessageId = asString(recovery.promptMessageId)
  return {
    kind: 'resume-required',
    cause: recovery.cause,
    ...(promptMessageId ? { promptMessageId } : {})
  }
}

const sanitizePendingHistoryReplay = (
  replay: unknown
): PersistedPendingHistoryReplay | undefined => {
  if (!isRecord(replay)) return undefined
  if (replay.kind === 'all') return { kind: 'all' }
  if (replay.kind !== 'before-message') return undefined
  const messageId = asString(replay.messageId)
  return messageId ? { kind: 'before-message', messageId } : undefined
}

const sanitizeSessionBranchSource = (value: unknown): PersistedSessionBranchSource | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['sessionId', 'agentFrameId', 'messageBranchId', 'headMessageId'])
  ) {
    return undefined
  }

  const sessionId = asString(value.sessionId)
  const agentFrameId = asString(value.agentFrameId)
  const messageBranchId = asString(value.messageBranchId)
  const headMessageId = asString(value.headMessageId)
  if (
    !sessionId ||
    (value.agentFrameId !== undefined && !agentFrameId) ||
    (value.messageBranchId !== undefined && !messageBranchId) ||
    (value.headMessageId !== undefined && !headMessageId)
  ) {
    return undefined
  }

  return {
    sessionId,
    ...(agentFrameId ? { agentFrameId } : {}),
    ...(messageBranchId ? { messageBranchId } : {}),
    ...(headMessageId ? { headMessageId } : {})
  }
}

const sanitizeSessionAgentConfiguration = (
  value: unknown
): SessionAgentConfiguration | undefined => {
  if (!isRecord(value) || !hasOnlyFields(value, ['providerId', 'model', 'reasoningEffort'])) {
    return undefined
  }
  const providerId = asString(value.providerId)
  const model = asString(value.model)
  if (!providerId || !isReasoningEffort(value.reasoningEffort)) return undefined
  if (value.model !== undefined && !model) return undefined
  return {
    providerId,
    ...(model ? { model } : {}),
    reasoningEffort: value.reasoningEffort
  }
}

// Rebuilds a persisted chat session and normalizes any runtime-only interrupted state.
export const sanitizeSession = (
  session: unknown,
  options: { preserveLegacyUploadPaths?: boolean; preserveRuntimeState?: boolean } = {}
): PersistedChatSession | undefined => {
  if (!isRecord(session)) return undefined

  const id = asString(session.id)

  if (!id) return undefined

  const artifacts = Array.isArray(session.artifacts)
    ? session.artifacts.map(sanitizeArtifact).filter((item): item is PersistedArtifact => !!item)
    : []
  const activities = Array.isArray(session.activities)
    ? session.activities
        .map(sanitizeToolActivity)
        .filter((item): item is PersistedToolActivity => !!item)
    : []
  const activityGroups = Array.isArray(session.activityGroups)
    ? session.activityGroups
        .map(sanitizeActivityGroup)
        .filter((item): item is PersistedActivityGroup => !!item)
        .map((group) =>
          options.preserveRuntimeState ? group : normalizeActivityGroupAfterRestore(group)
        )
    : []
  const revision = asNumber(session.revision)
  const number = asNumber(session.number)
  let sanitized: PersistedChatSession = {
    id,
    ...(Number.isSafeInteger(number) && (number ?? 0) > 0 ? { number } : {}),
    // Content value is a hint; the repository overrides it with the session file's directory on load.
    projectId: asString(session.projectId) ?? '',
    revision: Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision : 0,
    title: asString(session.title) ?? id,
    cwd: asString(session.cwd) ?? '',
    status: asSessionStatus(session.status),
    permissionProfile:
      session.permissionProfile === undefined
        ? DEFAULT_PERMISSION_PROFILE
        : normalizePermissionProfile(session.permissionProfile),
    // Auto-review defaults off: a missing or non-boolean value restores as disabled, and only an
    // explicit true turns it on.
    autoReviewEnabled: session.autoReviewEnabled === true ? true : false,
    // Memory predates its per-conversation switch, so historical or malformed values retain the
    // previous enabled behavior. Only an explicit false opts this Session out.
    memoryEnabled: session.memoryEnabled === false ? false : true,
    // Only deny changes behavior; missing/malformed historical values preserve delegation.
    delegationPolicy: normalizeDelegationPolicy(session.delegationPolicy),
    messages: Array.isArray(session.messages)
      ? session.messages
          .map((message) => sanitizeMessage(message, options))
          .filter((item): item is PersistedChatMessage => !!item)
      : [],
    createdAt: asNumber(session.createdAt) ?? 0,
    updatedAt: asNumber(session.updatedAt) ?? 0
  }
  const activeRun = sanitizeActiveRun(session.activeRun)
  const taskRunCommitId = asString(session.taskRunCommitId)
  const resumeRecovery = sanitizeSessionResumeRecovery(session.resumeRecovery)
  const branchSource = sanitizeSessionBranchSource(session.branchSource)
  const pendingHistoryReplay =
    sanitizePendingHistoryReplay(session.pendingHistoryReplay) ??
    // Migrate feature-preview files that used the cutoff id as a top-level scalar.
    (() => {
      const messageId = asString(session.pendingHistoryReplayBeforeMessageId)
      return messageId ? ({ kind: 'before-message', messageId } as const) : undefined
    })()
  const error = asString(session.error)
  const agentFrameworkId = asString(session.agentFrameworkId) as AgentFrameworkId | undefined
  const agentBackendId = asString(session.agentBackendId)
  const providerSessionId = asString(session.providerSessionId)
  const providerContinuityToken = asString(session.providerContinuityToken)
  const agentModel = asString(session.agentModel)
  const agentConfiguration = sanitizeSessionAgentConfiguration(session.agentConfiguration)
  const description = asString(session.description)
  const sessionDetailsSource =
    session.sessionDetailsSource === 'fallback' ||
    session.sessionDetailsSource === 'generated' ||
    session.sessionDetailsSource === 'manual'
      ? session.sessionDetailsSource
      : undefined
  const sessionDetailsGeneration = sanitizeSessionDetailsGeneration(
    session.sessionDetailsGeneration
  )
  const enabledComputeHosts = Array.isArray(session.enabledComputeHosts)
    ? session.enabledComputeHosts.filter(
        (item): item is string => typeof item === 'string' && item.startsWith('ssh:')
      )
    : []
  const hasSelectedComputeHosts = Object.prototype.hasOwnProperty.call(
    session,
    'selectedComputeHosts'
  )
  const selectedComputeHostCandidates = hasSelectedComputeHosts
    ? Array.isArray(session.selectedComputeHosts)
      ? session.selectedComputeHosts.filter(
          (item): item is string => typeof item === 'string' && item.startsWith('ssh:')
        )
      : []
    : enabledComputeHosts
  const enabledComputeHostSet = new Set(enabledComputeHosts)
  const selectedComputeHosts = selectedComputeHostCandidates.filter((providerId) =>
    enabledComputeHostSet.has(providerId)
  )
  const computeConcurrencyLimit = asNumber(session.computeConcurrencyLimit)
  if (
    session.computeConcurrencyLimit !== undefined &&
    (!Number.isInteger(computeConcurrencyLimit) ||
      (computeConcurrencyLimit ?? 0) < 1 ||
      (computeConcurrencyLimit ?? 0) > 500)
  ) {
    return undefined
  }

  if (activeRun) sanitized.activeRun = activeRun
  if (taskRunCommitId) sanitized.taskRunCommitId = taskRunCommitId
  if (session.runtimeTranscriptOwner === 'main') {
    sanitized.runtimeTranscriptOwner = 'main'
    const preparation = sanitizePromptPreparation(session.promptPreparation, sanitized)
    if (preparation) sanitized.promptPreparation = preparation
    const reviewOwner = session.runtimeTranscriptReviewOwner
    if (
      isRecord(reviewOwner) &&
      typeof reviewOwner.promptMessageId === 'string' &&
      reviewOwner.promptMessageId.length > 0 &&
      reviewOwner.promptMessageId.length <= 256 &&
      (reviewOwner.owner === 'task' || reviewOwner.owner === 'renderer')
    ) {
      sanitized.runtimeTranscriptReviewOwner = {
        promptMessageId: reviewOwner.promptMessageId,
        owner: reviewOwner.owner
      }
    }
    sanitized.runtimeTranscriptLastRun = sanitizeActiveRun(session.runtimeTranscriptLastRun)
    if (Array.isArray(session.runtimeSessionAdmissions)) {
      const admissions = new Map<string, PersistedRuntimeSessionAdmission>()
      const conflicts = new Set<string>()
      const keys = [
        'executionId',
        'promptMessageId',
        'promptRuntimeSegmentId',
        'rootFrameId',
        'agentFrameId',
        'messageBranchId',
        'runtimeSegmentId'
      ] as const
      for (const value of session.runtimeSessionAdmissions) {
        if (
          !isRecord(value) ||
          !keys.every(
            (key) =>
              typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256
          )
        )
          continue
        const admission = Object.fromEntries(
          keys.map((key) => [key, value[key]])
        ) as PersistedRuntimeSessionAdmission
        const previous = admissions.get(admission.executionId)
        if (previous && keys.some((key) => previous[key] !== admission[key]))
          conflicts.add(admission.executionId)
        admissions.set(admission.executionId, admission)
      }
      sanitized.runtimeSessionAdmissions = [...admissions.values()].filter(
        ({ executionId }) => !conflicts.has(executionId)
      )
    }
    if (Array.isArray(session.runtimeConversationCommandIds)) {
      sanitized.runtimeConversationCommandIds = session.runtimeConversationCommandIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256)
        .slice(-256)
    }
  }
  if (resumeRecovery) sanitized.resumeRecovery = resumeRecovery
  if (branchSource) sanitized.branchSource = branchSource
  if (session.researchMembership !== undefined) {
    const membership = researchMembershipSchema.safeParse(session.researchMembership)
    // An invalid local grouping must not silently move a discussion into the ordinary list.
    if (!membership.success) return undefined
    sanitized.researchMembership = membership.data
  }
  if (session.packageOrigin !== undefined) {
    const origin = packageOriginSchema.safeParse(session.packageOrigin)
    if (!origin.success) return undefined
    sanitized.packageOrigin = origin.data
  }
  if (session.forkOrigin !== undefined) {
    const origin = packageOriginSchema.safeParse(session.forkOrigin)
    if (!origin.success) return undefined
    sanitized.forkOrigin = origin.data
    const forkHeadMessageId = asString(session.forkHeadMessageId)
    if (forkHeadMessageId) sanitized.forkHeadMessageId = forkHeadMessageId
  }
  if (pendingHistoryReplay) sanitized.pendingHistoryReplay = pendingHistoryReplay
  if (session.branchContextResetRequired === true) sanitized.branchContextResetRequired = true
  if (error) sanitized.error = error
  // Only meaningful alongside an error; persisted only when explicitly false (absent = reportable).
  if (error && session.errorReportable === false) sanitized.errorReportable = false
  const artifactErrorEventIds = [...new Set(asStringArray(session.artifactErrorEventIds))]
  if (error?.startsWith('Generated file finalization') && artifactErrorEventIds.length > 0) {
    sanitized.artifactErrorEventIds = artifactErrorEventIds
  }
  if (agentFrameworkId && AGENT_FRAMEWORK_IDS.has(agentFrameworkId)) {
    sanitized.agentFrameworkId = agentFrameworkId
  }
  if (agentBackendId) sanitized.agentBackendId = agentBackendId
  if (providerSessionId) sanitized.providerSessionId = providerSessionId
  if (providerContinuityToken) sanitized.providerContinuityToken = providerContinuityToken
  if (agentModel) sanitized.agentModel = agentModel
  if (agentConfiguration) sanitized.agentConfiguration = agentConfiguration
  if (description !== undefined && description.length <= SESSION_DETAILS_DESCRIPTION_MAX_LENGTH) {
    sanitized.description = description
  }
  if (sessionDetailsSource) sanitized.sessionDetailsSource = sessionDetailsSource
  // Restore the pin only from an explicit true so malformed or legacy files stay unpinned.
  if (session.pinned === true) sanitized.pinned = true
  const archivedAt = asNumber(session.archivedAt)
  if (archivedAt !== undefined && Number.isSafeInteger(archivedAt) && archivedAt > 0) {
    sanitized.archivedAt = archivedAt
  }
  if (artifacts.length > 0) sanitized.artifacts = artifacts
  const filesRevision = asNumber(session.filesRevision)
  if (filesRevision !== undefined && Number.isInteger(filesRevision) && filesRevision >= 0) {
    sanitized.filesRevision = filesRevision
  }
  if (activities.length > 0) sanitized.activities = activities
  if (activityGroups.length > 0) sanitized.activityGroups = activityGroups
  if (enabledComputeHosts.length > 0) sanitized.enabledComputeHosts = enabledComputeHosts
  if (hasSelectedComputeHosts || enabledComputeHosts.length > 0) {
    sanitized.selectedComputeHosts = selectedComputeHosts
  }
  if (computeConcurrencyLimit !== undefined) {
    sanitized.computeConcurrencyLimit = computeConcurrencyLimit
  }
  // Specialist ID: accept any non-empty string. The main process validates it against SpecialistService
  // at send time; the sanitizer only ensures the value is safe to re-persist.
  const specialistId = asString(session.specialistId)
  if (specialistId) sanitized.specialistId = specialistId
  // Pending is a fail-closed marker: only the explicit true value survives sanitization. Historical
  // files omit it and retain the pre-marker behavior (their desired binding is considered applied).
  if (session.specialistBindingPending === true) sanitized.specialistBindingPending = true
  const contextUsage = sanitizeAcpContextUsage(session.contextUsage)
  if (contextUsage) sanitized.contextUsage = contextUsage
  const runtimeContext = sanitizeSessionRuntimeContext(session.runtimeContext)
  if (runtimeContext) sanitized.runtimeContext = runtimeContext
  const planHistoryProjections = sanitizePlanHistoryProjections(session.planHistoryProjections)
  if (planHistoryProjections) sanitized.planHistoryProjections = planHistoryProjections
  if (
    sanitized.status === 'waiting-plan-approval' &&
    runtimeContext?.plan?.approval !== 'pending'
  ) {
    // Approval waiting is meaningful only with a restorable pending Plan. A corrupt or settled
    // context must not leave the conversation permanently blocked with nothing to approve.
    sanitized.status = 'idle'
    sanitized.activeRun = undefined
  }
  if (
    sanitized.status === 'waiting-for-user' &&
    !activities.some(
      (activity) => activity.elicitation?.state === 'pending' && activity.elicitation.durable
    )
  ) {
    // A user-input wait is restorable only while its durable question remains actionable.
    sanitized.status = 'idle'
    sanitized.activeRun = undefined
  }

  // Normalize before graph creation so a legacy flat transcript never seeds a streaming message or
  // loses the active prompt identity while activeRun is cleared.
  if (!options.preserveRuntimeState) {
    sanitized = normalizeSessionAfterRestore(sanitized, { deferPermissionValidation: true })
  }

  if (session.conversationGraph !== undefined) {
    // Persisted graph IDs are durable identities referenced by Artifact Versions and other stores.
    // A historical pending-session prefix is not permission to rebind only the Session side.
    const graph = sanitizeConversationGraph(session.conversationGraph, options)
    if (!graph) return undefined
    const nestedDelegateActivities = projectActiveNestedDelegateActivities(graph)
    const activityIds = new Set((sanitized.activities ?? []).map(({ id }) => id))
    sanitized.conversationGraph = graph
    sanitized.messages = resolveActiveConversationMessages(graph).map(projectConversationMessage)
    sanitized.activities = [
      ...(sanitized.activities ?? []),
      ...nestedDelegateActivities.filter(({ id }) => !activityIds.has(id))
    ]
  } else {
    sanitized.conversationGraph = createLinearConversationGraph({
      sessionId: sanitized.id,
      messages: sanitized.messages,
      frameworkId: sanitized.agentFrameworkId,
      providerId: sanitized.agentConfiguration?.providerId,
      backendId: sanitized.agentBackendId,
      model: sanitized.agentModel,
      createdAt: sanitized.createdAt,
      updatedAt: sanitized.updatedAt
    })
  }

  const canonicalGraph = sanitized.conversationGraph
  // Call IDs are Session-scoped keys; drop every colliding Turn's detail rather than choose one.
  const modelCallIdCounts = new Map<string, number>()
  for (const message of canonicalGraph.messages) {
    for (const call of message.modelCallUsage ?? []) {
      modelCallIdCounts.set(call.id, (modelCallIdCounts.get(call.id) ?? 0) + 1)
    }
  }
  sanitized.conversationGraph = {
    ...canonicalGraph,
    messages: canonicalGraph.messages.map((message) =>
      message.modelCallUsage?.some((call) => (modelCallIdCounts.get(call.id) ?? 0) > 1)
        ? { ...message, modelCallUsage: undefined }
        : message
    )
  }
  sanitized.messages = resolveActiveConversationMessages(sanitized.conversationGraph).map(
    projectConversationMessage
  )

  const firstSessionDetailsMessageId = sanitized.messages.find(
    (message) => isHumanUserMessage(message) && !isHiddenControlMessage(message)
  )?.id
  if (
    sessionDetailsGeneration &&
    !branchSource &&
    sessionDetailsGeneration.sourceMessageId === firstSessionDetailsMessageId
  ) {
    sanitized.sessionDetailsGeneration = sessionDetailsGeneration
  }
  if (
    session.sessionDetailsGenerationEligible === true &&
    !branchSource &&
    session.sessionDetailsGeneration === undefined
  ) {
    sanitized.sessionDetailsGenerationEligible = true
  }

  if (sanitized.promptPreparation) {
    const preparation = sanitized.promptPreparation
    if (preparation.noticeBaseline && !resolvePreparationNoticeBaseline(sanitized))
      delete preparation.noticeBaseline
    const ownsPrompt = sanitized.messages.some(
      (message) => message.id === preparation.promptMessageId && message.role === 'user'
    )
    if (!ownsPrompt && (preparation.mode !== 'new' || preparation.runStartedAt !== undefined))
      delete sanitized.promptPreparation
  }

  // Normalize only after resolving the canonical active Branch. Recovery references and the durable
  // interrupted marker must never be inferred from an abandoned Branch.
  if (!options.preserveRuntimeState) {
    // The pre-graph restore may have classified a pending question as an interrupted run or
    // an idle approved Plan; older releases may have saved that projection. Resolve its actual
    // wait only with sanitized active-Branch authority.
    if (
      session.status === 'running' ||
      session.status === 'waiting-for-user' ||
      session.status === 'idle' ||
      session.status === 'error'
    ) {
      sanitized = restorePendingElicitationWait(sanitized)
    }
    sanitized = rearmUnacceptedElicitationContinuations(sanitized)
    sanitized = normalizeSessionAfterRestore(sanitized, { reconcileCompletedRecovery: true })
  }
  if (!options.preserveRuntimeState) {
    const permissionAuthority = resolveRestorablePermissionToolAuthority(sanitized)
    sanitized = {
      ...sanitized,
      ...(sanitized.activities
        ? {
            activities: sanitized.activities.map((activity) =>
              normalizeActivityAfterRestore(activity, permissionAuthority)
            )
          }
        : {}),
      ...(sanitized.conversationGraph
        ? {
            conversationGraph: {
              ...sanitized.conversationGraph,
              activities: sanitized.conversationGraph.activities.map((activity) => ({
                ...activity,
                ...normalizeActivityAfterRestore(activity, permissionAuthority)
              }))
            }
          }
        : {})
    }
  }
  const activeUserMessageIds = new Set(
    sanitized.messages.filter((message) => message.role === 'user').map((message) => message.id)
  )
  if (
    sanitized.resumeRecovery?.promptMessageId &&
    !activeUserMessageIds.has(sanitized.resumeRecovery.promptMessageId)
  ) {
    sanitized.resumeRecovery = {
      kind: 'resume-required',
      cause: sanitized.resumeRecovery.cause
    }
  }
  if (
    sanitized.pendingHistoryReplay?.kind === 'before-message' &&
    !activeUserMessageIds.has(sanitized.pendingHistoryReplay.messageId)
  ) {
    sanitized.pendingHistoryReplay = undefined
  }
  const recoveryPromptMessageId = sanitized.resumeRecovery?.promptMessageId
  if (recoveryPromptMessageId && sanitized.conversationGraph) {
    sanitized.conversationGraph = {
      ...sanitized.conversationGraph,
      messages: sanitized.conversationGraph.messages.map((message) =>
        message.id === recoveryPromptMessageId && message.role === 'user'
          ? { ...message, interrupted: true }
          : message
      )
    }
  }

  return sanitizeSessionMessageImages(sanitized)
}

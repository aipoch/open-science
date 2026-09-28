import type {
  PersistedMessageRole,
  PersistedMessageStatus,
  MessageAttribution,
  PersistedMessagePresentation,
  PersistedChatMessage,
  PersistedMessageAgentTarget
} from './message'
import {
  isRecord,
  asString,
  AGENT_FRAMEWORK_IDS,
  hasOnlyFields,
  asNumber,
  asStringArray
} from './primitives'
import { type AgentFrameworkId, isReasoningEffort } from '../settings'
import type { DelegatedCallerSource } from '../session-runtime-context'
import {
  sanitizeUploadedAttachment,
  sanitizeMessageParts,
  sanitizeMessageImages
} from './message-content'
import type { PersistedUploadedAttachment } from '../uploads'
import { sanitizeAnnotations } from '../annotations'
import { sanitizeMessagePdfContextSnapshot } from './pdf-context'
import {
  sanitizeAcpTurnTokenUsage,
  sanitizeAcpModelCallUsage,
  type AcpModelCallUsage,
  sanitizeAcpContextWindowSample,
  type AcpContextWindowSample
} from '../acp'

const MESSAGE_ROLES = new Set<PersistedMessageRole>(['user', 'agent'])

const MESSAGE_STATUSES = new Set<PersistedMessageStatus>(['complete', 'streaming', 'error'])

export const isReviewerCorrectionAttribution = (
  value: unknown
): value is Extract<MessageAttribution, { feature: 'reviewer' }> => {
  if (!isRecord(value)) return false
  return !(
    Object.keys(value).some(
      (key) => !['kind', 'feature', 'purpose', 'causeReviewId', 'continuation'].includes(key)
    ) ||
    value.kind !== 'application' ||
    value.feature !== 'reviewer' ||
    value.purpose !== 'correction' ||
    typeof value.causeReviewId !== 'string' ||
    value.causeReviewId.length === 0 ||
    (value.continuation !== undefined &&
      (!isRecord(value.continuation) ||
        !hasOnlyFields(value.continuation, ['round', 'maxRounds', 'findingIds']) ||
        !Number.isInteger(value.continuation.round) ||
        !Number.isInteger(value.continuation.maxRounds) ||
        Number(value.continuation.round) < 0 ||
        Number(value.continuation.maxRounds) <= Number(value.continuation.round) ||
        !Array.isArray(value.continuation.findingIds) ||
        value.continuation.findingIds.length === 0 ||
        value.continuation.findingIds.some((id) => typeof id !== 'string' || !id)))
  )
}

export const isComputeJobCompletionAttribution = (
  value: unknown
): value is Extract<MessageAttribution, { feature: 'compute' }> => {
  if (!isRecord(value)) return false
  return !(
    Object.keys(value).some(
      (key) => !['kind', 'feature', 'purpose', 'deliveryKey', 'jobIds'].includes(key)
    ) ||
    value.kind !== 'application' ||
    value.feature !== 'compute' ||
    value.purpose !== 'job-completion-analysis' ||
    typeof value.deliveryKey !== 'string' ||
    value.deliveryKey.length === 0 ||
    !Array.isArray(value.jobIds) ||
    value.jobIds.length === 0 ||
    value.jobIds.some((jobId) => typeof jobId !== 'string' || jobId.length === 0) ||
    new Set(value.jobIds).size !== value.jobIds.length
  )
}

export const isAgentResultDeliveryAttribution = (
  value: unknown
): value is Extract<MessageAttribution, { feature: 'background-results' }> => {
  if (!isRecord(value)) return false
  return !(
    Object.keys(value).some(
      (key) => !['kind', 'feature', 'purpose', 'deliveryKey', 'deliveryIds'].includes(key)
    ) ||
    value.kind !== 'application' ||
    value.feature !== 'background-results' ||
    value.purpose !== 'agent-result-delivery' ||
    typeof value.deliveryKey !== 'string' ||
    value.deliveryKey.length === 0 ||
    !Array.isArray(value.deliveryIds) ||
    value.deliveryIds.length === 0 ||
    value.deliveryIds.some(
      (deliveryId) => typeof deliveryId !== 'string' || deliveryId.length === 0
    ) ||
    new Set(value.deliveryIds).size !== value.deliveryIds.length
  )
}

export const sanitizeMessageAttribution = (value: unknown): MessageAttribution | undefined => {
  if (isReviewerCorrectionAttribution(value)) {
    return {
      kind: value.kind,
      feature: value.feature,
      purpose: value.purpose,
      causeReviewId: value.causeReviewId,
      ...(value.continuation
        ? {
            continuation: { ...value.continuation, findingIds: [...value.continuation.findingIds] }
          }
        : {})
    }
  }
  if (isComputeJobCompletionAttribution(value)) {
    return {
      kind: value.kind,
      feature: value.feature,
      purpose: value.purpose,
      deliveryKey: value.deliveryKey,
      jobIds: [...value.jobIds]
    }
  }
  if (isAgentResultDeliveryAttribution(value)) {
    return {
      kind: value.kind,
      feature: value.feature,
      purpose: value.purpose,
      deliveryKey: value.deliveryKey,
      deliveryIds: [...value.deliveryIds]
    }
  }
  return undefined
}

export const sanitizeMessagePresentation = (
  value: unknown
): PersistedMessagePresentation | undefined => {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'kind') ||
    value.kind !== 'compute-job-completion'
  ) {
    return undefined
  }
  return { kind: value.kind }
}

export const isComputeJobCompletionPresentation = (
  message: Pick<PersistedChatMessage, 'presentation'>
): boolean => message.presentation?.kind === 'compute-job-completion'

// Keeps only fully-valid send-target snapshots; a partial or unknown target would mark false
// config changes, so the whole field drops instead of degrading to a torn snapshot.
const sanitizeMessageAgentTarget = (value: unknown): PersistedMessageAgentTarget | undefined => {
  if (!isRecord(value)) return undefined
  const frameworkId = asString(value.frameworkId)
  const providerId = asString(value.providerId)
  if (
    !frameworkId ||
    !AGENT_FRAMEWORK_IDS.has(frameworkId as AgentFrameworkId) ||
    !providerId ||
    !isReasoningEffort(value.reasoningEffort)
  ) {
    return undefined
  }
  const backendId = asString(value.backendId)
  const model = asString(value.model)
  return {
    frameworkId: frameworkId as AgentFrameworkId,
    ...(backendId ? { backendId } : {}),
    providerId,
    ...(model ? { model } : {}),
    reasoningEffort: value.reasoningEffort
  }
}

const sanitizeDelegatedCallerSource = (value: unknown): DelegatedCallerSource | undefined => {
  if (!isRecord(value) || !hasOnlyFields(value, ['rootMessageId', 'toolInvocationId'])) {
    return undefined
  }
  const rootMessageId = asString(value.rootMessageId)
  const toolInvocationId = asString(value.toolInvocationId)
  return rootMessageId && toolInvocationId ? { rootMessageId, toolInvocationId } : undefined
}

// Accepts only known message roles from persisted data.
const asMessageRole = (value: unknown): PersistedMessageRole | undefined => {
  const role = asString(value) as PersistedMessageRole | undefined

  return role && MESSAGE_ROLES.has(role) ? role : undefined
}

// Defaults unknown message statuses to complete so old or partial data stays displayable.
const asMessageStatus = (value: unknown): PersistedMessageStatus => {
  const status = asString(value) as PersistedMessageStatus | undefined

  return status && MESSAGE_STATUSES.has(status) ? status : 'complete'
}

const sanitizeStructuredJson = (
  value: unknown,
  limits: { bytes: number; nodes: number; depth: number; properties: number; items: number }
): unknown | undefined => {
  try {
    let nodes = 0
    const inspect = (candidate: unknown, depth: number): boolean => {
      nodes += 1
      if (nodes > limits.nodes || depth > limits.depth) return false
      if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
        return true
      if (typeof candidate === 'number')
        return Number.isFinite(candidate) && !Object.is(candidate, -0)
      if (Array.isArray(candidate)) {
        return (
          candidate.length <= limits.items &&
          Object.keys(candidate).length === candidate.length &&
          candidate.every((item) => inspect(item, depth + 1))
        )
      }
      if (!isRecord(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype)
        return false
      const keys = Object.keys(candidate)
      return (
        keys.length <= limits.properties &&
        !keys.some((key) => key === '__proto__' || key === 'prototype' || key === 'constructor') &&
        keys.every((key) => inspect(candidate[key], depth + 1))
      )
    }
    if (!inspect(value, 0)) return undefined
    const serialized = JSON.stringify(value)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > limits.bytes)
      return undefined
    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

const sanitizeStructuredOutputEvidence = (
  value: unknown
): PersistedChatMessage['structuredOutputEvidence'] | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['attemptId', 'dialect', 'profile', 'schemaDigest', 'schema', 'accepted'])
  )
    return undefined
  const attemptId = asString(value.attemptId)
  const schemaDigest = asString(value.schemaDigest)
  if (
    !attemptId ||
    value.dialect !== '2020-12' ||
    value.profile !== 'ajv-8-draft-2020-12-v1' ||
    !schemaDigest ||
    !/^[a-f0-9]{64}$/.test(schemaDigest)
  )
    return undefined
  const schema = sanitizeStructuredJson(value.schema, {
    bytes: 64 * 1024,
    nodes: 1_000,
    depth: 32,
    properties: 128,
    items: 128
  })
  if (schema === undefined || (typeof schema !== 'boolean' && !isRecord(schema))) return undefined
  let accepted: { value: unknown; acceptedAt: number } | undefined
  if (value.accepted !== undefined) {
    if (!isRecord(value.accepted) || !hasOnlyFields(value.accepted, ['value', 'acceptedAt']))
      return undefined
    const acceptedAt = asNumber(value.accepted.acceptedAt)
    const acceptedValue = sanitizeStructuredJson(value.accepted.value, {
      bytes: 256 * 1024,
      nodes: 5_000,
      depth: 32,
      properties: 256,
      items: 1_000
    })
    if (acceptedAt === undefined || acceptedAt < 0 || acceptedValue === undefined) return undefined
    accepted = { value: acceptedValue, acceptedAt }
  }
  return {
    attemptId,
    dialect: '2020-12',
    profile: 'ajv-8-draft-2020-12-v1',
    schemaDigest,
    schema,
    ...(accepted ? { accepted } : {})
  }
}

// Rebuilds a message from durable UI fields and strips unknown renderer payload.
export const sanitizeMessage = (
  message: unknown,
  options: { preserveLegacyUploadPaths?: boolean } = {}
): PersistedChatMessage | undefined => {
  if (!isRecord(message)) return undefined

  const id = asString(message.id)
  const role = asMessageRole(message.role)
  const content = asString(message.content)

  if (!id || !role || content === undefined) return undefined

  const sanitized: PersistedChatMessage = {
    id,
    role,
    content,
    status: asMessageStatus(message.status),
    eventIds: asStringArray(message.eventIds),
    createdAt: asNumber(message.createdAt) ?? 0,
    updatedAt: asNumber(message.updatedAt) ?? 0
  }
  const attribution = sanitizeMessageAttribution(message.attribution)
  const presentation =
    role === 'user' ? sanitizeMessagePresentation(message.presentation) : undefined
  const streamId = asString(message.streamId)
  const responseToMessageId = asString(message.responseToMessageId)
  const artifactIds = asStringArray(message.artifactIds)
  const delegatedTask = asString(message.delegatedTask)
  const delegatedInputVersionIds = asStringArray(message.delegatedInputVersionIds)
  const explicitDelegatedCallerSource = sanitizeDelegatedCallerSource(message.delegatedCallerSource)
  const legacyCallerMessageId = asString(message.delegatedCallerMessageId)
  const legacyToolInvocationId = asString(message.delegatedToolInvocationId)
  const delegatedCallerSource =
    explicitDelegatedCallerSource ??
    (legacyCallerMessageId && legacyToolInvocationId
      ? { rootMessageId: legacyCallerMessageId, toolInvocationId: legacyToolInvocationId }
      : undefined)
  const uploads = Array.isArray(message.uploads)
    ? message.uploads
        .map((attachment) =>
          sanitizeUploadedAttachment(attachment, {
            preserveLegacyPath: options.preserveLegacyUploadPaths
          })
        )
        .filter((item): item is PersistedUploadedAttachment => !!item)
    : []
  const parts = sanitizeMessageParts(message.parts)
  const annotations = role === 'user' ? sanitizeAnnotations(message.annotations) : []
  const pdfContext =
    role === 'user' ? sanitizeMessagePdfContextSnapshot(message.pdfContext) : undefined
  const images = sanitizeMessageImages(message.images)
  const turnUsage = role === 'agent' ? sanitizeAcpTurnTokenUsage(message.turnUsage) : undefined
  const candidateModelCallUsage =
    role === 'agent' && turnUsage?.turnCount && Array.isArray(message.modelCallUsage)
      ? message.modelCallUsage.map(sanitizeAcpModelCallUsage)
      : []
  const modelCallUsage =
    candidateModelCallUsage.length === turnUsage?.turnCount &&
    candidateModelCallUsage.every(
      (call, index): call is AcpModelCallUsage => call !== undefined && call.index === index
    ) &&
    new Set(candidateModelCallUsage.map((call) => call?.id)).size === candidateModelCallUsage.length
      ? candidateModelCallUsage
      : []
  const modelCallTotals = modelCallUsage.reduce(
    (totals, call) => ({
      inputTokens: totals.inputTokens + call.inputTokens,
      cacheTokens: totals.cacheTokens + call.cacheTokens,
      outputTokens: totals.outputTokens + call.outputTokens
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0 }
  )
  const hasMatchingModelCallTotals =
    !!turnUsage &&
    Number.isSafeInteger(modelCallTotals.inputTokens) &&
    Number.isSafeInteger(modelCallTotals.cacheTokens) &&
    Number.isSafeInteger(modelCallTotals.outputTokens) &&
    modelCallTotals.inputTokens === turnUsage.inputTokens &&
    modelCallTotals.cacheTokens === turnUsage.cacheTokens &&
    modelCallTotals.outputTokens === turnUsage.outputTokens
  const turnUsageUnavailable =
    role === 'agent' && !turnUsage && message.turnUsageUnavailable === true
  const contextWindowSamples =
    role === 'user' && Array.isArray(message.contextWindowSamples)
      ? message.contextWindowSamples
          .map(sanitizeAcpContextWindowSample)
          .filter((sample): sample is AcpContextWindowSample => !!sample)
      : []
  const completedAt = asNumber(message.completedAt)
  const failedAt = asNumber(message.failedAt)
  const structuredOutputEvidence = sanitizeStructuredOutputEvidence(
    message.structuredOutputEvidence
  )

  if (streamId) sanitized.streamId = streamId
  if (attribution) sanitized.attribution = attribution
  if (presentation) sanitized.presentation = presentation
  // Older application-routed user Messages could persist their own id as the response target.
  // The edge carries no information, so canonicalize that known legacy shape on every read path.
  if (responseToMessageId && (role !== 'user' || responseToMessageId !== id)) {
    sanitized.responseToMessageId = responseToMessageId
  }
  if (artifactIds.length > 0) sanitized.artifactIds = artifactIds
  if (delegatedTask) sanitized.delegatedTask = delegatedTask
  if (delegatedInputVersionIds.length > 0) {
    sanitized.delegatedInputVersionIds = delegatedInputVersionIds
  }
  if (delegatedCallerSource) sanitized.delegatedCallerSource = delegatedCallerSource
  if (uploads.length > 0) sanitized.uploads = uploads
  if (parts.length > 0) sanitized.parts = parts
  if (annotations.length > 0) sanitized.annotations = annotations
  if (pdfContext) sanitized.pdfContext = pdfContext
  if (
    role === 'user' &&
    (message.turnIntent === 'plan-first' || message.turnIntent === 'save-as-skill')
  ) {
    sanitized.turnIntent = message.turnIntent
  }
  if (
    role === 'user' &&
    isRecord(message.relayedFrom) &&
    message.relayedFrom.kind === 'side-chat' &&
    message.relayedFrom.direction === 'to-main'
  ) {
    sanitized.relayedFrom = { kind: 'side-chat', direction: 'to-main' }
  }
  if (images) sanitized.images = images
  if (isRecord(message.usageOrigin)) {
    const sessionId = asString(message.usageOrigin.sessionId)
    const messageId = asString(message.usageOrigin.messageId)
    if (sessionId && messageId) sanitized.usageOrigin = { sessionId, messageId }
  }
  if (turnUsage) sanitized.turnUsage = turnUsage
  if (hasMatchingModelCallTotals) sanitized.modelCallUsage = modelCallUsage
  if (contextWindowSamples.length > 0) sanitized.contextWindowSamples = contextWindowSamples
  if (turnUsageUnavailable) sanitized.turnUsageUnavailable = true
  if (structuredOutputEvidence) sanitized.structuredOutputEvidence = structuredOutputEvidence
  if (
    message.structuredOutputEvidenceInvalid === true ||
    (message.structuredOutputEvidence !== undefined && !structuredOutputEvidence)
  ) {
    sanitized.structuredOutputEvidenceInvalid = true
  }
  if (role === 'user' && message.interrupted === true) sanitized.interrupted = true
  if (role === 'user') {
    const agentTarget = sanitizeMessageAgentTarget(message.agentTarget)
    if (agentTarget) sanitized.agentTarget = agentTarget
  }
  if (role === 'agent' && sanitized.status === 'complete') {
    sanitized.completedAt = completedAt ?? sanitized.updatedAt
  }
  if (role === 'agent' && sanitized.status === 'error') {
    sanitized.failedAt = failedAt ?? sanitized.updatedAt
  }

  return sanitized
}

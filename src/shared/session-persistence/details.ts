import type {
  PersistedSessionDetailsGeneration,
  SessionDetailsClaim,
  SessionDetailsAdmission,
  SessionDetailsUsageCapture
} from './session'
import { isRecord, asString, AGENT_FRAMEWORK_IDS, hasOnlyFields } from './primitives'
import { type AgentFrameworkId, isReasoningEffort } from '../settings'
import { sanitizeAcpTurnTokenUsage } from '../acp'

const SESSION_DETAILS_CLAIM_FIELDS = ['status', 'sourceMessageId', 'requestId', 'queuedAt'] as const

const SESSION_DETAILS_ADMISSION_FIELDS = [
  'startedAt',
  'frameworkId',
  'providerId',
  'model',
  'reasoningEffort'
] as const

const SESSION_DETAILS_USAGE_FIELDS = ['usage', 'usageUnavailable'] as const

const isSessionDetailsTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const sanitizeSessionDetailsGeneration = (
  value: unknown
): PersistedSessionDetailsGeneration | undefined => {
  if (!isRecord(value)) return undefined
  const sourceMessageId = asString(value.sourceMessageId)
  const requestId = asString(value.requestId)
  if (!sourceMessageId || !requestId || !isSessionDetailsTimestamp(value.queuedAt)) return undefined

  const claim: SessionDetailsClaim = {
    sourceMessageId,
    requestId,
    queuedAt: value.queuedAt
  }
  const admission = (): SessionDetailsAdmission | undefined => {
    const frameworkId = asString(value.frameworkId) as AgentFrameworkId | undefined
    const providerId = asString(value.providerId)
    const model = asString(value.model)
    if (
      !isSessionDetailsTimestamp(value.startedAt) ||
      !frameworkId ||
      !AGENT_FRAMEWORK_IDS.has(frameworkId) ||
      !model ||
      !isReasoningEffort(value.reasoningEffort) ||
      (value.providerId !== undefined && !providerId)
    ) {
      return undefined
    }
    return {
      startedAt: value.startedAt,
      frameworkId,
      ...(providerId ? { providerId } : {}),
      model,
      reasoningEffort: value.reasoningEffort
    }
  }
  const usageCapture = (): SessionDetailsUsageCapture | undefined => {
    if (value.usageUnavailable === true && value.usage === undefined) {
      return { usageUnavailable: true }
    }
    if (value.usageUnavailable === undefined && value.usage !== undefined) {
      const usage = sanitizeAcpTurnTokenUsage(value.usage)
      return usage ? { usage } : undefined
    }
    return undefined
  }
  const completedAt = value.completedAt

  switch (value.status) {
    case 'queued':
      return hasOnlyFields(value, SESSION_DETAILS_CLAIM_FIELDS)
        ? { ...claim, status: 'queued' }
        : undefined
    case 'running': {
      if (
        !hasOnlyFields(value, [
          ...SESSION_DETAILS_CLAIM_FIELDS,
          ...SESSION_DETAILS_ADMISSION_FIELDS
        ])
      ) {
        return undefined
      }
      const admitted = admission()
      return admitted ? { ...claim, ...admitted, status: 'running' } : undefined
    }
    case 'succeeded': {
      if (
        !hasOnlyFields(value, [
          ...SESSION_DETAILS_CLAIM_FIELDS,
          ...SESSION_DETAILS_ADMISSION_FIELDS,
          ...SESSION_DETAILS_USAGE_FIELDS,
          'completedAt'
        ]) ||
        !isSessionDetailsTimestamp(completedAt)
      ) {
        return undefined
      }
      const admitted = admission()
      const captured = usageCapture()
      return admitted && captured
        ? { ...claim, ...admitted, ...captured, status: 'succeeded', completedAt }
        : undefined
    }
    case 'failed': {
      if (
        !hasOnlyFields(value, [
          ...SESSION_DETAILS_CLAIM_FIELDS,
          ...SESSION_DETAILS_ADMISSION_FIELDS,
          ...SESSION_DETAILS_USAGE_FIELDS,
          'completedAt'
        ]) ||
        !isSessionDetailsTimestamp(completedAt)
      ) {
        return undefined
      }
      const admitted = admission()
      const captured = usageCapture()
      if (admitted && captured) {
        return { ...claim, ...admitted, ...captured, status: 'failed', completedAt }
      }
      const hasAdmissionField = SESSION_DETAILS_ADMISSION_FIELDS.some(
        (field) => value[field] !== undefined
      )
      return !hasAdmissionField && value.usageUnavailable === true && value.usage === undefined
        ? { ...claim, status: 'failed', completedAt, usageUnavailable: true }
        : undefined
    }
    case 'disabled':
      return hasOnlyFields(value, [...SESSION_DETAILS_CLAIM_FIELDS, 'completedAt']) &&
        isSessionDetailsTimestamp(completedAt)
        ? { ...claim, status: 'disabled', completedAt }
        : undefined
    case 'superseded': {
      if (
        !hasOnlyFields(value, [
          ...SESSION_DETAILS_CLAIM_FIELDS,
          ...SESSION_DETAILS_ADMISSION_FIELDS,
          ...SESSION_DETAILS_USAGE_FIELDS,
          'completedAt'
        ]) ||
        !isSessionDetailsTimestamp(completedAt)
      ) {
        return undefined
      }
      const hasAdmissionField = SESSION_DETAILS_ADMISSION_FIELDS.some(
        (field) => value[field] !== undefined
      )
      const hasUsageField = SESSION_DETAILS_USAGE_FIELDS.some((field) => value[field] !== undefined)
      if (!hasAdmissionField && !hasUsageField) {
        return { ...claim, status: 'superseded', completedAt }
      }
      const admitted = admission()
      if (!admitted) return undefined
      if (!hasUsageField) return { ...claim, ...admitted, status: 'superseded', completedAt }
      const captured = usageCapture()
      return captured
        ? { ...claim, ...admitted, ...captured, status: 'superseded', completedAt }
        : undefined
    }
    default:
      return undefined
  }
}

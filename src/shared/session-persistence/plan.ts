import type {
  SessionPlanApproval,
  SessionPlanDelivery,
  SessionPlanRuntimeContext,
  SessionPlanStepStatus
} from '../session-plan/contract'
import {
  type ActivePlanProjection,
  type PlanDocumentV1,
  type PlanLifecycle,
  derivePlanLifecycle,
  parsePlanDocumentV1,
  planStepTitles,
  projectPlanStepStates
} from '../session-plan/contract'
import { asNumber, asString, isRecord, sanitizeRuntimeContextValue } from './primitives'

const SESSION_PLAN_APPROVALS = new Set<SessionPlanApproval>(['pending', 'approved', 'rejected'])

const SESSION_PLAN_STEP_STATUSES = new Set<SessionPlanStepStatus>([
  'in_progress',
  'completed',
  'blocked',
  'skipped'
])

const PLAN_LIFECYCLES = new Set<PlanLifecycle>([
  'awaiting_approval',
  'approved',
  'in_progress',
  'blocked',
  'completed',
  'rejected'
])

const MAX_PLAN_HISTORY_PROJECTIONS = 100

const MAX_PLAN_HISTORY_PROJECTION_JSON_CHARS = 512_000

const MAX_PLAN_HISTORY_JSON_CHARS = 2_000_000

export const sanitizeSessionPlanRuntimeContext = (
  value: unknown
): SessionPlanRuntimeContext | undefined => {
  if (!isRecord(value)) return undefined
  if (
    Object.keys(value).some(
      (field) =>
        ![
          'artifactId',
          'artifactVersionId',
          'artifactChecksum',
          'document',
          'originatingPromptMessageId',
          'originatingTaskRunId',
          'materializedAt',
          'approval',
          'reviewFeedbackMessageId',
          'externalResponse',
          'delivery',
          'continuation',
          'stepStatuses'
        ].includes(field)
    )
  ) {
    return undefined
  }

  const artifactId = asString(value.artifactId)
  const artifactVersionId = asString(value.artifactVersionId)
  const artifactChecksum = asString(value.artifactChecksum)
  let document: PlanDocumentV1 | undefined
  if (value.document !== undefined) {
    try {
      document = parsePlanDocumentV1(value.document)
    } catch {
      return undefined
    }
  }
  const originatingPromptMessageId =
    value.originatingPromptMessageId === undefined
      ? undefined
      : asString(value.originatingPromptMessageId)
  const materializedAt =
    value.materializedAt === undefined ? undefined : asNumber(value.materializedAt)
  const originatingTaskRunId = asString(value.originatingTaskRunId)
  const approval = asString(value.approval) as SessionPlanApproval | undefined
  if (
    !artifactId ||
    !artifactVersionId ||
    !artifactChecksum ||
    (value.originatingPromptMessageId !== undefined && !originatingPromptMessageId) ||
    (value.originatingTaskRunId !== undefined && !originatingTaskRunId) ||
    (value.materializedAt !== undefined && (materializedAt === undefined || materializedAt < 0)) ||
    !approval ||
    !SESSION_PLAN_APPROVALS.has(approval) ||
    !isRecord(value.stepStatuses)
  ) {
    return undefined
  }
  const reviewFeedbackMessageId =
    approval === 'pending' ? asString(value.reviewFeedbackMessageId) : undefined
  const externalResponse = sanitizeExternalPlanResponse(value.externalResponse)

  const stepStatuses: Record<
    string,
    { status: SessionPlanStepStatus; updatedAt: number; notes?: string }
  > = {}
  for (const [title, rawStatus] of Object.entries(value.stepStatuses)) {
    if (!title || !isRecord(rawStatus)) return undefined
    if (Object.keys(rawStatus).some((field) => !['status', 'updatedAt', 'notes'].includes(field))) {
      return undefined
    }
    const status = asString(rawStatus.status) as SessionPlanStepStatus | undefined
    const updatedAt = asNumber(rawStatus.updatedAt)
    const notes = rawStatus.notes === undefined ? undefined : asString(rawStatus.notes)
    if (
      !status ||
      !SESSION_PLAN_STEP_STATUSES.has(status) ||
      updatedAt === undefined ||
      updatedAt < 0 ||
      (rawStatus.notes !== undefined && notes === undefined)
    ) {
      return undefined
    }
    Object.defineProperty(stepStatuses, title, {
      value: { status, updatedAt, ...(notes !== undefined ? { notes } : {}) },
      enumerable: true,
      configurable: true,
      writable: true
    })
  }

  const rawDelivery = Object.hasOwn(value, 'delivery') ? value.delivery : value.continuation
  const delivery = (() => {
    if (!isRecord(rawDelivery)) return undefined
    if (
      Object.keys(rawDelivery).some(
        (field) =>
          !['commandId', 'kind', 'state', 'originatingPromptMessageId', 'createdAt'].includes(field)
      )
    ) {
      return undefined
    }
    const commandId = asString(rawDelivery.commandId)
    const deliveryOriginatingPromptMessageId = asString(rawDelivery.originatingPromptMessageId)
    const state: SessionPlanDelivery['state'] | undefined =
      rawDelivery.state === 'queued' ||
      rawDelivery.state === 'delivering' ||
      rawDelivery.state === 'accepted' ||
      rawDelivery.state === 'interrupted'
        ? rawDelivery.state
        : rawDelivery.state === 'continuing'
          ? 'delivering'
          : undefined
    const kind: SessionPlanDelivery['kind'] | undefined =
      rawDelivery.kind === 'approved-plan' ||
      rawDelivery.kind === 'rejected-plan' ||
      rawDelivery.kind === 'review-feedback'
        ? rawDelivery.kind
        : undefined
    const createdAt = asNumber(rawDelivery.createdAt)
    const kindMatchesApproval =
      (kind === 'approved-plan' && approval === 'approved') ||
      (kind === 'rejected-plan' && approval === 'rejected') ||
      (kind === 'review-feedback' && approval === 'pending' && !!reviewFeedbackMessageId)
    const expectedOriginatingMessageId =
      kind === 'review-feedback' ? reviewFeedbackMessageId : originatingPromptMessageId
    if (
      !kindMatchesApproval ||
      !kind ||
      !state ||
      !commandId ||
      !deliveryOriginatingPromptMessageId ||
      deliveryOriginatingPromptMessageId !== expectedOriginatingMessageId ||
      createdAt === undefined ||
      createdAt < 0
    ) {
      return undefined
    }
    return {
      commandId,
      kind,
      state,
      originatingPromptMessageId: deliveryOriginatingPromptMessageId,
      createdAt
    }
  })()

  return {
    artifactId,
    artifactVersionId,
    artifactChecksum,
    ...(document ? { document } : {}),
    ...(originatingPromptMessageId ? { originatingPromptMessageId } : {}),
    ...(originatingTaskRunId ? { originatingTaskRunId } : {}),
    ...(materializedAt !== undefined ? { materializedAt } : {}),
    approval,
    ...(reviewFeedbackMessageId ? { reviewFeedbackMessageId } : {}),
    ...(externalResponse ? { externalResponse } : {}),
    ...(delivery ? { delivery } : {}),
    stepStatuses
  }
}

const sanitizeExternalPlanResponse = (
  value: unknown
): SessionPlanRuntimeContext['externalResponse'] => {
  if (!isRecord(value)) return undefined
  const { action, source, reviewedRevision } = value
  const commandId = asString(value.commandId)
  const promptMessageId = asString(value.promptMessageId)
  const feedbackChecksum = asString(value.feedbackChecksum)
  if (
    (source !== 'user_relay' && source !== 'delegated_agent') ||
    (action !== 'approved' && action !== 'rejected' && action !== 'revise') ||
    typeof reviewedRevision !== 'number' ||
    !Number.isSafeInteger(reviewedRevision) ||
    reviewedRevision < 0 ||
    !commandId ||
    !promptMessageId ||
    (action === 'revise' && !feedbackChecksum?.match(/^[a-f0-9]{64}$/))
  ) {
    return undefined
  }
  return {
    source,
    reviewedRevision,
    action,
    commandId,
    promptMessageId,
    ...(value.handedOff === true ? { handedOff: true as const } : {}),
    ...(action === 'revise' && feedbackChecksum ? { feedbackChecksum } : {})
  }
}

// Historical projections are presentation-only snapshots. Rebuild all derived fields from the
// validated Plan document and statuses so persisted JSON cannot manufacture lifecycle state or
// inconsistent counters. A prompt binding is mandatory because unbound history cannot be isolated
// safely across Message Branches.
const sanitizeHistoricalPlanProjection = (
  value: unknown
): { projection: ActivePlanProjection; jsonChars: number } | undefined => {
  const sanitizedJson = sanitizeRuntimeContextValue(value, { remaining: 10_000 })
  if (!isRecord(sanitizedJson)) return undefined
  const jsonChars = JSON.stringify(sanitizedJson).length
  if (jsonChars > MAX_PLAN_HISTORY_PROJECTION_JSON_CHARS) return undefined

  const originatingPromptMessageId = asString(sanitizedJson.originatingPromptMessageId)
  const revision = asNumber(sanitizedJson.revision)
  const lifecycle = asString(sanitizedJson.lifecycle)
  if (
    !originatingPromptMessageId ||
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !lifecycle ||
    (!PLAN_LIFECYCLES.has(lifecycle as PlanLifecycle) && lifecycle !== 'interrupted')
  ) {
    return undefined
  }

  const runtimePlan = sanitizeSessionPlanRuntimeContext({
    artifactId: sanitizedJson.artifactId,
    artifactVersionId: sanitizedJson.artifactVersionId,
    artifactChecksum: sanitizedJson.artifactChecksum,
    originatingPromptMessageId,
    originatingTaskRunId: sanitizedJson.originatingTaskRunId,
    approval: sanitizedJson.approval,
    stepStatuses: sanitizedJson.stepStatuses
  })
  if (!runtimePlan) return undefined

  let document
  try {
    document = parsePlanDocumentV1(sanitizedJson.document)
  } catch {
    return undefined
  }
  const titles = planStepTitles(document)
  const externalResponse = sanitizeExternalPlanResponse(sanitizedJson.externalResponse)
  return {
    jsonChars,
    projection: {
      artifactId: runtimePlan.artifactId,
      artifactVersionId: runtimePlan.artifactVersionId,
      artifactChecksum: runtimePlan.artifactChecksum,
      originatingPromptMessageId,
      ...(runtimePlan.originatingTaskRunId
        ? { originatingTaskRunId: runtimePlan.originatingTaskRunId }
        : {}),
      revision,
      ...(externalResponse ? { externalResponse } : {}),
      approval: runtimePlan.approval,
      lifecycle: derivePlanLifecycle(document, runtimePlan.approval, runtimePlan.stepStatuses),
      document,
      stepStatuses: runtimePlan.stepStatuses,
      stepStates: projectPlanStepStates(document, runtimePlan.stepStatuses),
      counts: {
        phases: document.phases.length,
        delegations: document.phases.reduce((sum, phase) => sum + phase.delegations.length, 0),
        steps: titles.length,
        completed: titles.filter((title) => {
          const status = runtimePlan.stepStatuses[title]?.status
          return status === 'completed' || status === 'skipped'
        }).length,
        inProgress: titles.filter((title) => {
          const status = runtimePlan.stepStatuses[title]?.status
          return status === 'in_progress'
        }).length
      }
    }
  }
}

export const sanitizePlanHistoryProjections = (
  value: unknown
): ActivePlanProjection[] | undefined => {
  if (!Array.isArray(value)) return undefined
  let remainingPlanHistoryChars = MAX_PLAN_HISTORY_JSON_CHARS
  const projections: ActivePlanProjection[] = []
  for (const candidate of value.slice(-MAX_PLAN_HISTORY_PROJECTIONS).toReversed()) {
    const sanitizedProjection = sanitizeHistoricalPlanProjection(candidate)
    if (!sanitizedProjection) continue
    if (sanitizedProjection.jsonChars > remainingPlanHistoryChars) break
    remainingPlanHistoryChars -= sanitizedProjection.jsonChars
    projections.unshift(sanitizedProjection.projection)
  }
  return projections.length > 0 ? projections : undefined
}

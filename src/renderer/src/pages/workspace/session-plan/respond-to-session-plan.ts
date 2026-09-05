import {
  parsePlanDocumentV1,
  type ActivePlanProjection
} from '../../../../../shared/session-plan/contract'
import { isSessionSizeLimitError } from '../../../../../shared/session-persistence'
import { useSessionStore } from '@/stores/session-store'

type SessionPlanResponseTarget = Readonly<{
  projectId: string
  sessionId: string
  projection: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const PLAN_APPROVALS = new Set<ActivePlanProjection['approval']>([
  'pending',
  'approved',
  'rejected'
])
const PLAN_LIFECYCLES = new Set<ActivePlanProjection['lifecycle']>([
  'awaiting_approval',
  'approved',
  'in_progress',
  'blocked',
  'completed',
  'rejected'
])
const PLAN_RUNTIME_STEP_STATUSES = new Set<ActivePlanProjection['stepStatuses'][string]['status']>([
  'in_progress',
  'completed',
  'blocked',
  'skipped'
])
const PLAN_PROJECTED_STEP_STATUSES = new Set<ActivePlanProjection['stepStates'][string]['status']>([
  'not_started',
  'not_run',
  'in_progress',
  'completed',
  'blocked',
  'skipped'
])
const PLAN_COUNT_FIELDS = [
  'phases',
  'delegations',
  'steps',
  'completed',
  'inProgress'
] as const satisfies readonly (keyof ActivePlanProjection['counts'])[]

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  isNonNegativeFiniteNumber(value) && Number.isSafeInteger(value)

const hasValidStepStatuses = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return Object.entries(value).every(
    ([title, status]) =>
      title.length > 0 &&
      isRecord(status) &&
      PLAN_RUNTIME_STEP_STATUSES.has(
        status.status as ActivePlanProjection['stepStatuses'][string]['status']
      ) &&
      isNonNegativeFiniteNumber(status.updatedAt) &&
      (status.notes === undefined || typeof status.notes === 'string')
  )
}

const hasValidStepStates = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return Object.entries(value).every(
    ([title, state]) =>
      title.length > 0 &&
      isRecord(state) &&
      PLAN_PROJECTED_STEP_STATUSES.has(
        state.status as ActivePlanProjection['stepStates'][string]['status']
      ) &&
      (state.notes === undefined || typeof state.notes === 'string')
  )
}

const hasValidCounts = (value: unknown): boolean =>
  isRecord(value) && PLAN_COUNT_FIELDS.every((field) => isNonNegativeSafeInteger(value[field]))

const isActivePlanProjection = (value: unknown): value is ActivePlanProjection => {
  if (!isRecord(value)) return false
  if (
    !isNonEmptyString(value.artifactId) ||
    !isNonEmptyString(value.artifactVersionId) ||
    !isNonEmptyString(value.artifactChecksum) ||
    (value.originatingPromptMessageId !== undefined &&
      !isNonEmptyString(value.originatingPromptMessageId)) ||
    (value.materializedAt !== undefined && !isNonNegativeFiniteNumber(value.materializedAt)) ||
    !isNonNegativeSafeInteger(value.revision) ||
    !PLAN_APPROVALS.has(value.approval as ActivePlanProjection['approval']) ||
    !PLAN_LIFECYCLES.has(value.lifecycle as ActivePlanProjection['lifecycle']) ||
    !hasValidStepStatuses(value.stepStatuses) ||
    !hasValidStepStates(value.stepStates) ||
    !hasValidCounts(value.counts)
  ) {
    return false
  }
  try {
    parsePlanDocumentV1(value.document)
  } catch {
    return false
  }
  return true
}

const projectionFromResponse = (result: unknown): ActivePlanProjection | undefined => {
  if (!isRecord(result)) return undefined
  return isActivePlanProjection(result.projection) ? result.projection : undefined
}

const projectReturnedFeedbackMessage = (sessionId: string, result: unknown): boolean => {
  if (!isRecord(result) || result.kind !== 'feedback' || !isRecord(result.message)) return false
  const message = result.message
  if (
    typeof message.id !== 'string' ||
    typeof message.content !== 'string' ||
    typeof message.createdAt !== 'number'
  ) {
    return false
  }
  useSessionStore.getState().appendRoutedUserMessage({
    sessionId,
    messageId: message.id,
    eventId: `session-user-message-${message.id}`,
    content: message.content,
    createdAt: message.createdAt,
    ...(typeof message.responseToMessageId === 'string'
      ? { responseToMessageId: message.responseToMessageId }
      : {})
  })
  return true
}

const refreshSessionPlanProjection = async ({
  projectId,
  sessionId,
  authoritativeProjection
}: Pick<SessionPlanResponseTarget, 'projectId' | 'sessionId'> & {
  authoritativeProjection?: ActivePlanProjection
}): Promise<void> => {
  const current = await window.api.acp.getPlanProjection(projectId, sessionId)
  if (!current) return
  if (
    authoritativeProjection &&
    current.artifactVersionId === authoritativeProjection.artifactVersionId &&
    current.revision < authoritativeProjection.revision
  ) {
    return
  }
  useSessionStore.getState().setActivePlanProjection(sessionId, current)
}

export const respondToSessionPlan = async (
  target: SessionPlanResponseTarget,
  response: 'approved' | 'rejected' | { decision: 'approved' | 'rejected' } | { feedback: string },
  options: Readonly<{ onSessionSizeLimit?: (sessionId: string) => void }> = {}
): Promise<void> => {
  const payload = typeof response === 'string' ? { decision: response } : response
  let authoritativeProjection: ActivePlanProjection | undefined
  try {
    const request =
      'feedback' in payload
        ? { projectId: target.projectId, sessionId: target.sessionId, feedback: payload.feedback }
        : {
            projectId: target.projectId,
            sessionId: target.sessionId,
            artifactVersionId: target.projection.artifactVersionId,
            expectedRevision: target.projection.revision,
            decision: payload.decision
          }
    const result = await window.api.acp.respondPlan(request)
    authoritativeProjection = 'feedback' in payload ? undefined : projectionFromResponse(result)
    if (authoritativeProjection) {
      useSessionStore.getState().setActivePlanProjection(target.sessionId, authoritativeProjection)
    }
    const projectedReturnedMessage = projectReturnedFeedbackMessage(target.sessionId, result)
    if ('feedback' in payload && !projectedReturnedMessage) {
      const localMessageId = `local-user-message-${Date.now()}`
      useSessionStore.getState().appendRoutedUserMessage({
        sessionId: target.sessionId,
        messageId: localMessageId,
        eventId: localMessageId,
        content: payload.feedback,
        createdAt: Date.now()
      })
    }
  } catch (error) {
    if (isSessionSizeLimitError(error)) options.onSessionSizeLimit?.(target.sessionId)
    try {
      await refreshSessionPlanProjection(target)
    } catch {
      // Preserve the authoritative response error when recovery hydration also fails.
    }
    throw error
  }
  await refreshSessionPlanProjection({ ...target, authoritativeProjection })
}

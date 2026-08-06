import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useSessionStore } from '@/stores/session-store'

type SessionPlanResponseTarget = Readonly<{
  projectId: string
  sessionId: string
  projection: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  sessionId
}: Pick<SessionPlanResponseTarget, 'projectId' | 'sessionId'>): Promise<void> => {
  const current = await window.api.acp.getPlanProjection(projectId, sessionId)
  if (current) useSessionStore.getState().setActivePlanProjection(sessionId, current)
}

export const respondToSessionPlan = async (
  target: SessionPlanResponseTarget,
  response: 'approved' | 'rejected' | { decision: 'approved' | 'rejected' } | { feedback: string }
): Promise<void> => {
  const payload = typeof response === 'string' ? { decision: response } : response
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
    if ('feedback' in payload) return
  } catch (error) {
    try {
      await refreshSessionPlanProjection(target)
    } catch {
      // Preserve the authoritative response error when recovery hydration also fails.
    }
    throw error
  }
  await refreshSessionPlanProjection(target)
}

import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { derivePlanLifecycle } from '../../shared/session-plan/contract'
import type {
  ReviewerFileEvidenceDescriptor,
  ReviewerSourceEvidenceDescriptor,
  ReviewerTurnPlanDescriptor,
  TurnScope
} from '../../shared/reviewer'
import { resolveReviewTurnProjection } from './scope'

export type ReviewerFileEvidenceRecord = ReviewerFileEvidenceDescriptor & {
  messageId?: string
  executionId?: string
  directlyRead: boolean
}

export type ReviewerFileEvidenceResolver = (request: {
  projectId: string
  sessionId: string
  artifactVersionIds: readonly string[]
  messageIds: readonly string[]
}) => Promise<ReviewerFileEvidenceRecord[]>

export type ResolvedReviewerTurnEvidence = {
  turnPlan?: ReviewerTurnPlanDescriptor
  planEvidenceLimitation?: string
  fileEvidenceByBlockId: ReadonlyMap<string, ReviewerFileEvidenceDescriptor[]>
  sourceDocumentEvidence: ReviewerSourceEvidenceDescriptor[]
  sourceDocumentVersionIds: string[]
}

const effectivePlanForTurn = (
  session: PersistedChatSession,
  userMessageId: string | undefined
): Pick<ResolvedReviewerTurnEvidence, 'turnPlan' | 'planEvidenceLimitation'> => {
  if (!userMessageId) return {}
  const authority = session.runtimeContext?.plan
  // Main archives the outgoing authority on replacement, preserving its final approval/progress.
  // Select the last authority for THIS prompt before checking approval: searching for any approved
  // entry would resurrect a requirement whose replacement was subsequently rejected.
  const history = session.planHistoryProjections ?? []
  const ownsCurrentPlan = authority?.originatingPromptMessageId === userMessageId
  const plan = ownsCurrentPlan
    ? history.find(
        (candidate) =>
          candidate.artifactVersionId === authority.artifactVersionId &&
          candidate.artifactChecksum === authority.artifactChecksum &&
          candidate.originatingPromptMessageId === userMessageId &&
          candidate.approval === authority.approval
      )
    : history.findLast((candidate) => candidate.originatingPromptMessageId === userMessageId)
  const approval = ownsCurrentPlan ? authority.approval : plan?.approval
  if (approval && approval !== 'approved') return {}
  if (!plan)
    return {
      planEvidenceLimitation:
        'Approved plan evidence is unavailable for this turn; plan compliance was not assessed.'
    }

  const lifecycle = derivePlanLifecycle(
    plan.document,
    plan.approval,
    ownsCurrentPlan ? authority.stepStatuses : plan.stepStatuses
  )
  const status: ReviewerTurnPlanDescriptor['status'] =
    lifecycle === 'completed' ? 'completed' : lifecycle === 'approved' ? 'approved' : 'active'
  return {
    turnPlan: {
      versionId: plan.artifactVersionId,
      checksum: plan.artifactChecksum,
      status,
      content: plan.document,
      binding: 'current-turn'
    }
  }
}

const containsRunIdentity = (value: unknown, runId: string, depth = 0): boolean => {
  if (depth > 8 || value === null || value === undefined) return false
  if (typeof value === 'string') return value === runId
  if (Array.isArray(value)) return value.some((item) => containsRunIdentity(item, runId, depth + 1))
  if (typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      ((key === 'runId' || key === 'producerRunId') && item === runId) ||
      containsRunIdentity(item, runId, depth + 1)
  )
}

const activityForRun = (
  activities: readonly PersistedToolActivity[],
  runId: string | undefined
): PersistedToolActivity | undefined => {
  if (!runId) return undefined
  return activities.find(
    (activity) =>
      activity.executionInvocationId === runId ||
      containsRunIdentity(activity.rawOutput, runId) ||
      containsRunIdentity(activity.toolContent, runId)
  )
}

const withoutAssociation = <RecordType extends ReviewerFileEvidenceRecord>(
  record: RecordType
): Omit<RecordType, 'messageId' | 'executionId' | 'directlyRead'> => {
  const { messageId, executionId, directlyRead, ...descriptor } = record
  void messageId
  void executionId
  void directlyRead
  return descriptor
}

export const resolveReviewerTurnEvidence = async (
  session: PersistedChatSession,
  scope: TurnScope,
  resolveFiles?: ReviewerFileEvidenceResolver
): Promise<ResolvedReviewerTurnEvidence> => {
  const projection = resolveReviewTurnProjection(
    session,
    scope.turnMessageId,
    scope.messageBranchId
  )
  const scopedMessageIds = scope.blocks
    .filter((block) => block.kind === 'message')
    .map((block) => block.sourceId)
  const userMessageId = scope.blocks.find((block) => {
    if (block.kind !== 'message') return false
    return projection.messages.find((message) => message.id === block.sourceId)?.role === 'user'
  })?.sourceId
  const records = resolveFiles
    ? await resolveFiles({
        projectId: session.projectId,
        sessionId: session.id,
        artifactVersionIds: scope.artifactVersionIds,
        messageIds: scopedMessageIds
      })
    : []
  const planEvidence = effectivePlanForTurn(session, userMessageId)
  const fileEvidenceByBlockId = new Map<string, ReviewerFileEvidenceDescriptor[]>()
  const append = (blockId: string, descriptor: ReviewerFileEvidenceDescriptor): void => {
    const descriptors = fileEvidenceByBlockId.get(blockId) ?? []
    if (!descriptors.some((candidate) => candidate.versionId === descriptor.versionId)) {
      descriptors.push(descriptor)
      fileEvidenceByBlockId.set(blockId, descriptors)
    }
  }

  for (const record of records) {
    if (record.role === 'work_product' && record.messageId) {
      const block = scope.blocks.find(
        (candidate) => candidate.kind === 'message' && candidate.sourceId === record.messageId
      )
      if (block) append(block.id, withoutAssociation(record))
      continue
    }
    if (record.role !== 'source_document' || !record.directlyRead) continue
    const activity = activityForRun(projection.activities, record.executionId)
    const block = activity
      ? scope.blocks.find(
          (candidate) => candidate.kind === 'activity' && candidate.sourceId === activity.id
        )
      : undefined
    if (block) append(block.id, withoutAssociation(record))
  }

  return {
    ...planEvidence,
    fileEvidenceByBlockId,
    sourceDocumentEvidence: [
      ...new Map(
        records
          .filter(
            (record): record is ReviewerFileEvidenceRecord & ReviewerSourceEvidenceDescriptor =>
              record.role === 'source_document'
          )
          .map((record) => [record.versionId, withoutAssociation(record)])
      ).values()
    ],
    sourceDocumentVersionIds: [
      ...new Set(
        records.flatMap((record) => (record.role === 'source_document' ? [record.versionId] : []))
      )
    ]
  }
}

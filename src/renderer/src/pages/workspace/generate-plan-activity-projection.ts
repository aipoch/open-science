import type { ToolActivity } from '@/stores/session-store'
import { createPlanDocumentV1, type PlanDocumentV1 } from '../../../../shared/session-plan/contract'

type PlanTranscriptStep = Readonly<{
  number: number
  title: string
  description: string
}>

type GeneratePlanActivityProjection =
  | Readonly<{
      kind: 'content'
      heading: string
      taskSummary: string
      steps: readonly PlanTranscriptStep[]
      feasibility: Readonly<{
        confidence: 'high' | 'medium' | 'low'
        summary: string
      }>
    }>
  | Readonly<{
      kind: 'approved' | 'rejected' | 'already-pending' | 'unavailable' | 'failed'
      heading: string
    }>
  | Readonly<{ kind: 'revision-conflict'; heading: string; detail: string }>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const PLAN_CONTENT_FIELDS = ['task_summary', 'phases', 'desired_outputs', 'feasibility'] as const
const PLAN_ALREADY_AWAITING_APPROVAL = 'A Session Plan is already awaiting approval.'

const structuredPlanErrorCode = (rawOutput: unknown): string | undefined => {
  if (!isRecord(rawOutput)) return undefined
  const payload = isRecord(rawOutput.structuredContent) ? rawOutput.structuredContent : rawOutput
  const error = payload.error
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

// ACP providers either expose the MCP arguments directly or retain the protocol envelope.
const unwrapArguments = (rawInput: unknown): unknown =>
  isRecord(rawInput) && isRecord(rawInput.arguments) ? rawInput.arguments : rawInput

const contentHeading = (activity: ToolActivity, hasDurablePlanAuthority: boolean): string =>
  !hasDurablePlanAuthority && (activity.status === 'pending' || activity.status === 'in_progress')
    ? 'Creating execution Plan'
    : 'Created execution Plan'

const buildPlanDocument = (input: unknown): PlanDocumentV1 | undefined => {
  if (isRecord(input)) {
    const hasPlanContent = PLAN_CONTENT_FIELDS.some((field) => input[field] !== undefined)
    const hasDecisionInput = input.decision !== undefined || 'approve' in input
    const hasDecisionAndLegacyApproval = input.decision !== undefined && 'approve' in input
    if ((hasDecisionInput && hasPlanContent) || hasDecisionAndLegacyApproval) return undefined
  }

  try {
    return createPlanDocumentV1(input)
  } catch {
    return undefined
  }
}

const parseGeneratePlanDocument = (rawInput: unknown): PlanDocumentV1 | undefined =>
  buildPlanDocument(unwrapArguments(rawInput))

const projectGeneratePlanActivity = (
  activity: ToolActivity,
  hasDurablePlanAuthority = false
): GeneratePlanActivityProjection => {
  const planErrorCode = structuredPlanErrorCode(activity.rawOutput)
  if (planErrorCode === 'approval-already-pending') {
    return {
      kind: 'already-pending',
      heading: 'Execution Plan already awaiting approval'
    }
  }
  if (planErrorCode === 'plan-review-pending') {
    return {
      kind: 'revision-conflict',
      heading: 'Plan revision not submitted',
      detail: 'Review or dismiss the current execution Plan before submitting a revision.'
    }
  }

  if (
    typeof activity.rawOutput === 'string' &&
    activity.rawOutput.trim() === PLAN_ALREADY_AWAITING_APPROVAL
  ) {
    return {
      kind: 'already-pending',
      heading: 'Execution Plan already awaiting approval'
    }
  }

  if (activity.status === 'failed' && !hasDurablePlanAuthority) {
    return { kind: 'failed', heading: 'Failed to create execution Plan' }
  }

  const input = unwrapArguments(activity.rawInput)
  if (isRecord(input)) {
    const hasPlanContent = PLAN_CONTENT_FIELDS.some((field) => input[field] !== undefined)
    const hasDecisionInput = input.decision !== undefined || 'approve' in input
    const hasDecisionAndLegacyApproval = input.decision !== undefined && 'approve' in input
    if ((hasDecisionInput && hasPlanContent) || hasDecisionAndLegacyApproval) {
      return { kind: 'unavailable', heading: contentHeading(activity, hasDurablePlanAuthority) }
    }
    if (input.decision === 'approved' || input.approve === true) {
      return { kind: 'approved', heading: 'Approved execution Plan' }
    }
    if (input.decision === 'rejected') {
      return { kind: 'rejected', heading: 'Dismissed execution Plan' }
    }
  }

  const document = buildPlanDocument(input)
  if (document) {
    const steps = document.phases.flatMap((phase) =>
      phase.delegations.flatMap((delegation) => delegation.steps)
    )

    return {
      kind: 'content',
      heading: contentHeading(activity, hasDurablePlanAuthority),
      taskSummary: document.task_summary,
      steps: steps.map((step, index) => ({ number: index + 1, ...step })),
      feasibility: {
        confidence: document.feasibility.confidence,
        summary: document.feasibility.rationale
      }
    }
  }

  return { kind: 'unavailable', heading: contentHeading(activity, hasDurablePlanAuthority) }
}

export { parseGeneratePlanDocument, projectGeneratePlanActivity }
export type { GeneratePlanActivityProjection, PlanTranscriptStep }

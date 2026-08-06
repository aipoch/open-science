import type { ToolActivity } from '@/stores/session-store'
import { createPlanDocumentV1 } from '../../../../shared/session-plan/contract'

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
  | Readonly<{ kind: 'approved' | 'rejected' | 'unavailable' | 'failed'; heading: string }>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const PLAN_CONTENT_FIELDS = ['task_summary', 'phases', 'desired_outputs', 'feasibility'] as const

// ACP providers either expose the MCP arguments directly or retain the protocol envelope.
const unwrapArguments = (rawInput: unknown): unknown =>
  isRecord(rawInput) && isRecord(rawInput.arguments) ? rawInput.arguments : rawInput

const contentHeading = (activity: ToolActivity): string =>
  activity.status === 'pending' || activity.status === 'in_progress'
    ? 'Creating execution Plan'
    : 'Created execution Plan'

const projectGeneratePlanActivity = (activity: ToolActivity): GeneratePlanActivityProjection => {
  if (activity.status === 'failed') {
    return { kind: 'failed', heading: 'Failed to create execution Plan' }
  }

  const input = unwrapArguments(activity.rawInput)
  if (isRecord(input)) {
    const hasPlanContent = PLAN_CONTENT_FIELDS.some((field) => input[field] !== undefined)
    const hasDecisionInput = input.decision !== undefined || 'approve' in input
    const hasDecisionAndLegacyApproval = input.decision !== undefined && 'approve' in input
    if ((hasDecisionInput && hasPlanContent) || hasDecisionAndLegacyApproval) {
      return { kind: 'unavailable', heading: contentHeading(activity) }
    }
    if (input.decision === 'approved' || input.approve === true) {
      return { kind: 'approved', heading: 'Approved execution Plan' }
    }
    if (input.decision === 'rejected') {
      return { kind: 'rejected', heading: 'Dismissed execution Plan' }
    }
  }

  try {
    const document = createPlanDocumentV1(input)
    const steps = document.phases.flatMap((phase) =>
      phase.delegations.flatMap((delegation) => delegation.steps)
    )

    return {
      kind: 'content',
      heading: contentHeading(activity),
      taskSummary: document.task_summary,
      steps: steps.map((step, index) => ({ number: index + 1, ...step })),
      feasibility: {
        confidence: document.feasibility.confidence,
        summary: document.feasibility.rationale
      }
    }
  } catch {
    return { kind: 'unavailable', heading: contentHeading(activity) }
  }
}

export { projectGeneratePlanActivity }
export type { GeneratePlanActivityProjection, PlanTranscriptStep }

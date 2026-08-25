import type {
  SessionPlanApproval,
  SessionPlanRuntimeContext,
  SessionPlanStepStatus
} from '../session-persistence'
import { z } from 'zod'

export const planConfidenceSchema = z
  .enum(['high', 'medium', 'low'])
  .describe('How confident the planner is that the proposed work can be completed.')

export type PlanConfidence = z.infer<typeof planConfidenceSchema>

export const planStepSchema = z
  .object({
    title: z.string().describe('A unique, concise step title used for exact status updates.'),
    description: z
      .string()
      .describe('The concrete work to perform and the result this step should produce.')
  })
  .describe('One executable step within a delegation.')

export const planDelegationSchema = z
  .object({
    name: z.string().describe('A human-readable name for this independent work track.'),
    steps: z
      .array(planStepSchema, {
        error:
          'Every delegation must include a non-empty `steps` array of `{ title, description }` objects.'
      })
      .describe(
        'Required ordered executable steps for this delegation. Use a non-empty array of `{ title, description }` objects.'
      )
  })
  .describe('An independent work track within a phase.')

export const planPhaseSchema = z
  .object({
    name: z.string().describe('A human-readable name for this ordered phase.'),
    delegations: z
      .array(planDelegationSchema)
      .describe(
        'The independent work tracks that make up this phase. Include at least one delegation.'
      )
  })
  .describe('An ordered phase of the Session Plan.')

export const planFeasibilitySchema = z
  .object({
    confidence: planConfidenceSchema,
    rationale: z
      .string()
      .describe('Why the selected confidence level is appropriate for the proposed work.')
  })
  .describe('An assessment of whether the Plan can be completed with available inputs.')

export const generatePlanContentSchema = z
  .object({
    task_summary: z
      .string()
      .describe(
        "A concise summary of the user's multi-stage objective. Required in generation mode."
      ),
    phases: z
      .array(planPhaseSchema)
      .describe(
        'The ordered phases of work. Shape each item as `{ name, delegations: [{ name, steps: [{ title, description }] }] }`; every phase, delegation, and steps array must be non-empty.'
      ),
    desired_outputs: z
      .array(
        z.string().describe('A concrete artifact, finding, or decision expected from the Plan.')
      )
      .describe(
        'The artifacts, findings, or decisions expected when the Plan completes. This may be an empty array.'
      ),
    feasibility: planFeasibilitySchema
  })
  .describe('The four content fields required to generate a complete Session Plan.')

export const generatePlanContentToolSchema = generatePlanContentSchema.partial()

export type GeneratePlanContent = z.infer<typeof generatePlanContentSchema>

export type PlanDocumentV1 = GeneratePlanContent & Readonly<{ schema_version: 1 }>

export type PlanStepProjectionStatus = SessionPlanStepStatus | 'not_started' | 'not_run'

export type PlanStepProjection = Readonly<{
  status: PlanStepProjectionStatus
  notes?: string
}>

export type PlanLifecycle =
  | 'awaiting_approval'
  | 'approved'
  | 'in_progress'
  | 'interrupted'
  | 'blocked'
  | 'completed'
  | 'rejected'

export type ActivePlanProjection = Readonly<{
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  originatingPromptMessageId?: string
  materializedAt?: number
  revision: number
  approval: SessionPlanApproval
  lifecycle: PlanLifecycle
  continuationState?: NonNullable<SessionPlanRuntimeContext['continuation']>['state']
  requiresExplicitContinuation: boolean
  document: PlanDocumentV1
  stepStatuses: SessionPlanRuntimeContext['stepStatuses']
  stepStates: Readonly<Record<string, PlanStepProjection>>
  counts: Readonly<{
    phases: number
    delegations: number
    steps: number
    completed: number
    inProgress: number
  }>
}>

const compactPlanContextText = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, 500)

export const formatPlanProtectedContext = (projection: ActivePlanProjection): string => {
  const steps = planStepTitles(projection.document).map((title) => {
    const state = projection.stepStates[title] ?? { status: 'not_started' as const }
    const notes =
      state.status !== 'completed' && state.notes ? ` — ${compactPlanContextText(state.notes)}` : ''
    return `- ${compactPlanContextText(title)}: ${state.status}${notes}`
  })
  return [
    '<open_science_protected_plan_context>',
    `approval=${projection.approval} lifecycle=${projection.lifecycle}`,
    `task=${compactPlanContextText(projection.document.task_summary)}`,
    ...steps,
    'Do not execute this Plan without interaction-bound authority from Open Science.',
    '</open_science_protected_plan_context>'
  ].join('\n')
}

export const PLAN_COMMAND_ERROR_CODES = [
  'invalid-plan',
  'no-active-plan',
  'plan-review-pending',
  'approval-already-pending',
  'approval-already-decided',
  'stale-plan',
  'unknown-step',
  'invalid-transition',
  'dependency-not-satisfied',
  'plan-not-approved',
  'artifact-unavailable',
  'revision-conflict',
  'continuation-required',
  'interaction-mismatch'
] as const

export type PlanCommandErrorCode = (typeof PLAN_COMMAND_ERROR_CODES)[number]

export const isPlanCommandErrorCode = (value: unknown): value is PlanCommandErrorCode =>
  typeof value === 'string' && PLAN_COMMAND_ERROR_CODES.includes(value as PlanCommandErrorCode)

type PlanResponseIdentity = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
}>

export type PlanResponseCommand =
  | (PlanResponseIdentity & Readonly<{ decision: 'approved' | 'rejected'; feedback?: never }>)
  | Readonly<{
      projectId: string
      sessionId: string
      feedback: string
      decision?: never
      artifactVersionId?: never
      expectedRevision?: never
    }>

export class PlanCommandError extends Error {
  constructor(
    readonly code: PlanCommandErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PlanCommandError'
  }
}

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PlanCommandError('invalid-plan', `${label} must be non-empty.`)
  }
  return value.trim()
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsePlanText = (schema: z.ZodString, value: unknown, label: string): string => {
  const parsed = schema.safeParse(value)
  return requireText(parsed.success ? parsed.data : value, label)
}

export const createPlanDocumentV1 = (input: unknown): PlanDocumentV1 => {
  if (!isRecord(input)) {
    throw new PlanCommandError('invalid-plan', 'Plan document must be an object.')
  }
  if ('schema_version' in input && input.schema_version !== 1) {
    throw new PlanCommandError('invalid-plan', 'schema_version must be 1.')
  }
  const shape = generatePlanContentSchema.shape
  const taskSummary = parsePlanText(shape.task_summary, input.task_summary, 'task_summary')

  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new PlanCommandError('invalid-plan', 'A Plan requires at least one phase.')
  }
  const titles = new Set<string>()
  const phases = input.phases.map((phaseValue) => {
    const phase = isRecord(phaseValue) ? phaseValue : {}
    const name = parsePlanText(planPhaseSchema.shape.name, phase.name, 'phase name')
    if (!Array.isArray(phase.delegations) || phase.delegations.length === 0) {
      throw new PlanCommandError('invalid-plan', 'Each phase requires at least one delegation.')
    }
    const delegations = phase.delegations.map((delegationValue) => {
      const delegation = isRecord(delegationValue) ? delegationValue : {}
      const delegationName = parsePlanText(
        planDelegationSchema.shape.name,
        delegation.name,
        'delegation name'
      )
      if (!Array.isArray(delegation.steps) || delegation.steps.length === 0) {
        throw new PlanCommandError('invalid-plan', 'Each delegation requires at least one step.')
      }
      const steps = delegation.steps.map((stepValue) => {
        const step = isRecord(stepValue) ? stepValue : {}
        const title = parsePlanText(planStepSchema.shape.title, step.title, 'step title')
        const description = parsePlanText(
          planStepSchema.shape.description,
          step.description,
          'step description'
        )
        if (titles.has(title)) {
          throw new PlanCommandError('invalid-plan', `Duplicate step title: ${title}`)
        }
        titles.add(title)
        return { title, description }
      })
      return { name: delegationName, steps }
    })
    return { name, delegations }
  })

  if (!Array.isArray(input.desired_outputs)) {
    throw new PlanCommandError('invalid-plan', 'desired_outputs must be an array.')
  }
  const desiredOutputs = input.desired_outputs.map((output) =>
    parsePlanText(shape.desired_outputs.element, output, 'desired output')
  )

  const feasibility = isRecord(input.feasibility) ? input.feasibility : {}
  const confidenceParsed = planFeasibilitySchema.shape.confidence.safeParse(feasibility.confidence)
  if (!confidenceParsed.success) {
    throw new PlanCommandError('invalid-plan', 'feasibility confidence is invalid.')
  }
  const rationale = parsePlanText(
    planFeasibilitySchema.shape.rationale,
    feasibility.rationale,
    'feasibility rationale'
  )
  const content = generatePlanContentSchema.parse({
    task_summary: taskSummary,
    phases,
    desired_outputs: desiredOutputs,
    feasibility: { confidence: confidenceParsed.data, rationale }
  })
  return { schema_version: 1, ...content }
}

export const parsePlanDocumentV1 = (input: unknown): PlanDocumentV1 => {
  if (!isRecord(input) || input.schema_version !== 1) {
    throw new PlanCommandError('invalid-plan', 'schema_version must be 1.')
  }
  return createPlanDocumentV1(input)
}

export const planStepTitles = (document: PlanDocumentV1): string[] =>
  document.phases.flatMap((phase) =>
    phase.delegations.flatMap((delegation) => delegation.steps.map((step) => step.title))
  )

const runtimeStatusFor = (
  statuses: SessionPlanRuntimeContext['stepStatuses'],
  title: string
): SessionPlanRuntimeContext['stepStatuses'][string] | undefined =>
  Object.hasOwn(statuses, title) ? statuses[title] : undefined

export const projectPlanStepStates = (
  document: PlanDocumentV1,
  statuses: SessionPlanRuntimeContext['stepStatuses']
): Readonly<Record<string, PlanStepProjection>> => {
  const blockedPhaseIndex = document.phases.findIndex((phase) =>
    phase.delegations.some((delegation) =>
      delegation.steps.some((step) => runtimeStatusFor(statuses, step.title)?.status === 'blocked')
    )
  )
  return Object.fromEntries(
    document.phases.flatMap((phase, phaseIndex) =>
      phase.delegations.flatMap((delegation) => {
        const delegationStarted = delegation.steps.some(
          (step) => runtimeStatusFor(statuses, step.title) !== undefined
        )
        const delegationBlocked = delegation.steps.some(
          (step) => runtimeStatusFor(statuses, step.title)?.status === 'blocked'
        )
        return delegation.steps.map((step) => {
          const runtime = runtimeStatusFor(statuses, step.title)
          if (runtime) {
            return [
              step.title,
              { status: runtime.status, ...(runtime.notes ? { notes: runtime.notes } : {}) }
            ]
          }
          const unreachable =
            blockedPhaseIndex >= 0 &&
            (phaseIndex > blockedPhaseIndex ||
              (phaseIndex === blockedPhaseIndex && (!delegationStarted || delegationBlocked)))
          return [step.title, { status: unreachable ? 'not_run' : 'not_started' }]
        })
      })
    )
  )
}

export const isPlanComplete = (
  document: PlanDocumentV1,
  statuses: Readonly<Record<string, Readonly<{ status: SessionPlanStepStatus }>>>
): boolean =>
  planStepTitles(document).every((title) => {
    const status = Object.hasOwn(statuses, title) ? statuses[title]?.status : undefined
    return status === 'completed' || status === 'skipped'
  })

export const isPlanTerminalOutcome = (
  document: PlanDocumentV1,
  statuses: SessionPlanRuntimeContext['stepStatuses']
): boolean => {
  if (isPlanComplete(document, statuses)) return true
  const states = Object.values(projectPlanStepStates(document, statuses))
  return (
    states.some((step) => step.status === 'blocked') &&
    states.every((step) => step.status !== 'not_started' && step.status !== 'in_progress')
  )
}

export const derivePlanLifecycle = (
  document: PlanDocumentV1,
  approval: SessionPlanApproval,
  statuses: Readonly<Record<string, Readonly<{ status: SessionPlanStepStatus }>>>,
  interactionIsLive = false
): PlanLifecycle => {
  if (approval === 'pending') return 'awaiting_approval'
  if (approval === 'rejected') return 'rejected'
  const values = planStepTitles(document).map((title) =>
    Object.hasOwn(statuses, title) ? statuses[title]?.status : undefined
  )
  if (isPlanComplete(document, statuses)) return 'completed'
  if (values.includes('in_progress')) return interactionIsLive ? 'in_progress' : 'interrupted'
  if (values.includes('blocked')) return 'blocked'
  return 'approved'
}

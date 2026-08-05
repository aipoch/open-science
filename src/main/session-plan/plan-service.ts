import { createHash, randomUUID } from 'node:crypto'

import type {
  PersistedChatMessage,
  SessionPlanRuntimeContext,
  SessionPlanStepStatus,
  SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  isPlanComplete,
  parsePlanDocumentV1,
  PlanCommandError,
  projectPlanStepStates,
  planStepTitles,
  type ActivePlanProjection,
  type GeneratePlanContent,
  type PlanDocumentV1,
  type PlanResponseCommand
} from '../../shared/session-plan/contract'

type ArtifactWriteResult = Readonly<{
  artifactId?: string
  versionId?: string
  checksum?: string
  name: string
}>

type PlanServiceDependencies = Readonly<{
  writeArtifactForActiveTurn: (
    sessionId: string,
    input: { filename: string; content: string; mimeType: string; kind: 'plan' }
  ) => Promise<ArtifactWriteResult>
  readArtifactVersion: (input: {
    projectId: string
    sessionId: string
    artifactId: string
    artifactVersionId: string
  }) => Promise<{ content: string; checksum: string }>
  readRuntimeContext: (projectId: string, sessionId: string) => Promise<SessionRuntimeContext>
  patchRuntimeContext: (input: {
    projectId: string
    sessionId: string
    expectedRevision: number
    plan: SessionPlanRuntimeContext | undefined
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle'
  }) => Promise<SessionRuntimeContext>
  isRevisionConflict: (error: unknown) => boolean
  persistUserMessage: (input: {
    projectId: string
    sessionId: string
    content: string
    interactionId: string
  }) => Promise<PersistedChatMessage>
  now?: () => number
  createId?: () => string
}>

type PlanIdentityCommand = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
}>

type PlanDecisionResult = { projection: ActivePlanProjection; changed: boolean }
type PlanFeedbackResult = {
  kind: 'feedback'
  routeToInteractionId: string
  artifactVersionId: string
  text: string
  message: PersistedChatMessage
}
type PlanResponseResult = PlanDecisionResult | PlanFeedbackResult

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const isTerminalStepStatus = (status: SessionPlanStepStatus): boolean =>
  status === 'completed' || status === 'blocked' || status === 'skipped'

const parseDocument = (content: string): PlanDocumentV1 => {
  try {
    return parsePlanDocumentV1(JSON.parse(content))
  } catch {
    throw new PlanCommandError('artifact-unavailable', 'The active Plan Artifact is unreadable.')
  }
}

class PlanService {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly livePlanInteractions = new Map<
    string,
    { artifactVersionId: string; interactionId: string }
  >()
  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => randomUUID().slice(0, 8))
  }

  async generate(input: {
    projectId: string
    sessionId: string
    interactionId: string
    content: GeneratePlanContent
  }): Promise<{ projection: ActivePlanProjection; pauseInteraction: true }> {
    const document = createPlanDocumentV1(input.content)
    const serialized = JSON.stringify(document, null, 2)
    const artifact = await this.dependencies.writeArtifactForActiveTurn(input.sessionId, {
      filename: `plan-${this.createId()}.json`,
      content: serialized,
      mimeType: 'application/json',
      kind: 'plan'
    })
    if (!artifact.artifactId || !artifact.versionId || !artifact.checksum) {
      throw new PlanCommandError('artifact-unavailable', 'Plan Artifact provenance is incomplete.')
    }
    const verified = await this.dependencies.readArtifactVersion({
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId
    })
    if (
      verified.content !== serialized ||
      verified.checksum !== artifact.checksum ||
      sha256(verified.content) !== artifact.checksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'Plan Artifact checksum verification failed.'
      )
    }
    const current = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan: SessionPlanRuntimeContext = {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      artifactChecksum: artifact.checksum,
      originatingPromptMessageId: input.interactionId,
      approval: 'pending',
      stepStatuses: {}
    }
    let next: SessionRuntimeContext
    try {
      next = await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: current.revision,
        plan,
        sessionStatus: 'waiting-plan-approval'
      })
    } catch (error) {
      if (this.dependencies.isRevisionConflict(error)) {
        throw new PlanCommandError('revision-conflict', 'The Session Plan changed concurrently.')
      }
      throw error
    }
    this.livePlanInteractions.set(input.sessionId, {
      artifactVersionId: plan.artifactVersionId,
      interactionId: input.interactionId
    })
    return { projection: this.project(document, plan, next.revision), pauseInteraction: true }
  }

  async respond(
    input: PlanIdentityCommand &
      Readonly<{ decision: 'approved' | 'rejected'; interactionIsLive?: boolean }>
  ): Promise<PlanDecisionResult>
  async respond(
    input: Readonly<{ projectId: string; sessionId: string; feedback: string }>
  ): Promise<PlanFeedbackResult>
  async respond(
    input: PlanResponseCommand & Readonly<{ interactionIsLive?: boolean }>
  ): Promise<PlanResponseResult>
  async respond(
    input: PlanResponseCommand & Readonly<{ interactionIsLive?: boolean }>
  ): Promise<PlanResponseResult> {
    if (input.decision === undefined) {
      const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
      const plan = context.plan
      if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
      if (plan.approval !== 'pending') {
        throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
      }
      const text = input.feedback.trim()
      if (!text) throw new PlanCommandError('invalid-plan', 'Plan feedback must be non-empty.')
      const live = this.livePlanInteractions.get(input.sessionId)
      if (!live || live.artifactVersionId !== plan.artifactVersionId) {
        throw new PlanCommandError(
          'stale-plan',
          'The Plan interaction is no longer available for revision feedback.'
        )
      }
      const message = await this.dependencies.persistUserMessage({
        projectId: input.projectId,
        sessionId: input.sessionId,
        content: text,
        interactionId: live.interactionId
      })
      this.livePlanInteractions.delete(input.sessionId)
      return {
        kind: 'feedback',
        routeToInteractionId: live.interactionId,
        artifactVersionId: plan.artifactVersionId,
        text,
        message
      }
    }
    const { context, plan, document } = await this.loadActive(input, input.decision)
    if (plan.approval === input.decision) {
      this.livePlanInteractions.delete(input.sessionId)
      return {
        projection: this.project(document, plan, context.revision, input.interactionIsLive),
        changed: false
      }
    }
    if (plan.approval !== 'pending') {
      throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
    }
    const updated = { ...plan, approval: input.decision }
    const next = await this.patch(input, updated, input.interactionIsLive ? 'running' : 'idle')
    this.livePlanInteractions.delete(input.sessionId)
    return {
      projection: this.project(document, updated, next.revision, input.interactionIsLive),
      changed: true
    }
  }

  async updateStepStatus(
    input: PlanIdentityCommand &
      Readonly<{ title: string; status: SessionPlanStepStatus; notes?: string }>
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }> {
    const { context, plan, document } = await this.loadActive(input, undefined, {
      title: input.title,
      status: input.status
    })
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('plan-not-approved', 'The Plan must be approved before execution.')
    }
    if (!planStepTitles(document).includes(input.title)) {
      throw new PlanCommandError('unknown-step', `Unknown Plan step: ${input.title}`)
    }
    const previous = plan.stepStatuses[input.title]?.status
    const sameTerminal = previous === input.status && isTerminalStepStatus(input.status)
    if (sameTerminal) {
      return { projection: this.project(document, plan, context.revision, true), changed: false }
    }
    const startsStep = !previous && (input.status === 'in_progress' || input.status === 'skipped')
    const valid =
      startsStep ||
      (previous === 'in_progress' && ['in_progress', 'completed', 'blocked'].includes(input.status))
    if (!valid) throw new PlanCommandError('invalid-transition', 'Invalid Plan step transition.')
    if (startsStep) this.requireStartDependencies(document, plan, input.title)
    const updated: SessionPlanRuntimeContext = {
      ...plan,
      stepStatuses: {
        ...plan.stepStatuses,
        [input.title]: {
          status: input.status,
          updatedAt: this.now(),
          ...(input.notes ? { notes: input.notes } : {})
        }
      }
    }
    const next = await this.patch(input, updated, 'running')
    return { projection: this.project(document, updated, next.revision, true), changed: true }
  }

  async getProjection(
    projectId: string,
    sessionId: string,
    options: Readonly<{ interactionIsLive?: boolean }> = {}
  ): Promise<ActivePlanProjection | null> {
    const context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    if (!context.plan) return null
    try {
      const document = await this.readDocument(projectId, sessionId, context.plan)
      return this.project(
        document,
        context.plan,
        context.revision,
        options.interactionIsLive ?? false
      )
    } catch (error) {
      if (!(error instanceof PlanCommandError) || error.code !== 'artifact-unavailable') throw error
      await this.dropUnavailableAuthority(projectId, sessionId, context)
      return null
    }
  }

  async authorizeContinuation(input: PlanIdentityCommand): Promise<ActivePlanProjection> {
    const { context, plan, document } = await this.loadActive(input)
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('plan-not-approved', 'The Plan must be approved before execution.')
    }
    if (isPlanComplete(document, plan.stepStatuses)) {
      throw new PlanCommandError('invalid-transition', 'The Plan is already complete.')
    }
    return this.project(document, plan, context.revision, true)
  }

  async checkTurnCompletion(input: {
    projectId: string
    sessionId: string
  }): Promise<{ allow: boolean; lifecycle?: ActivePlanProjection['lifecycle'] }> {
    const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    if (!context.plan || context.plan.approval !== 'approved') return { allow: true }
    const document = await this.readDocument(input.projectId, input.sessionId, context.plan)
    const projection = this.project(document, context.plan, context.revision, true)
    const cleanlyBlocked =
      projection.lifecycle === 'blocked' &&
      !Object.values(projection.stepStates).some((step) => step.status === 'not_started')
    return {
      allow: projection.lifecycle === 'completed' || cleanlyBlocked,
      lifecycle: projection.lifecycle
    }
  }

  private async loadActive(
    input: PlanIdentityCommand,
    idempotentDecision?: 'approved' | 'rejected',
    idempotentStep?: Readonly<{ title: string; status: SessionPlanStepStatus }>
  ): Promise<{
    context: SessionRuntimeContext
    plan: SessionPlanRuntimeContext
    document: PlanDocumentV1
  }> {
    const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan = context.plan
    if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
    if (plan.artifactVersionId !== input.artifactVersionId) {
      throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
    }
    const repeatsTerminalStep =
      idempotentStep !== undefined &&
      isTerminalStepStatus(idempotentStep.status) &&
      plan.stepStatuses[idempotentStep.title]?.status === idempotentStep.status
    if (
      context.revision !== input.expectedRevision &&
      plan.approval !== idempotentDecision &&
      !repeatsTerminalStep
    ) {
      throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
    }
    return {
      context,
      plan,
      document: await this.readDocument(input.projectId, input.sessionId, plan)
    }
  }

  private async dropUnavailableAuthority(
    projectId: string,
    sessionId: string,
    observed: SessionRuntimeContext
  ): Promise<void> {
    let current = observed
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.dependencies.patchRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: current.revision,
          plan: undefined,
          sessionStatus: 'idle'
        })
        return
      } catch (error) {
        if (!this.dependencies.isRevisionConflict(error)) throw error
        const latest = await this.dependencies.readRuntimeContext(projectId, sessionId)
        if (!latest.plan || !observed.plan) return
        if (
          latest.plan.artifactId !== observed.plan.artifactId ||
          latest.plan.artifactVersionId !== observed.plan.artifactVersionId ||
          latest.plan.artifactChecksum !== observed.plan.artifactChecksum
        ) {
          return
        }
        current = latest
      }
    }
  }

  private async readDocument(
    projectId: string,
    sessionId: string,
    plan: SessionPlanRuntimeContext
  ): Promise<PlanDocumentV1> {
    let result: { content: string; checksum: string }
    try {
      result = await this.dependencies.readArtifactVersion({
        projectId,
        sessionId,
        artifactId: plan.artifactId,
        artifactVersionId: plan.artifactVersionId
      })
    } catch {
      throw new PlanCommandError('artifact-unavailable', 'The active Plan Artifact is unreadable.')
    }
    if (
      result.checksum !== plan.artifactChecksum ||
      sha256(result.content) !== plan.artifactChecksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'The active Plan Artifact failed verification.'
      )
    }
    return parseDocument(result.content)
  }

  private async patch(
    input: PlanIdentityCommand,
    plan: SessionPlanRuntimeContext,
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle'
  ): Promise<SessionRuntimeContext> {
    try {
      return await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        plan,
        sessionStatus
      })
    } catch (error) {
      if (this.dependencies.isRevisionConflict(error)) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision changed concurrently.')
      }
      throw error
    }
  }

  private requireStartDependencies(
    document: PlanDocumentV1,
    plan: SessionPlanRuntimeContext,
    title: string
  ): void {
    const phaseIndex = document.phases.findIndex((phase) =>
      phase.delegations.some((delegation) => delegation.steps.some((step) => step.title === title))
    )
    const phase = document.phases[phaseIndex]
    const delegation = phase.delegations.find((candidate) =>
      candidate.steps.some((step) => step.title === title)
    )!
    const stepIndex = delegation.steps.findIndex((step) => step.title === title)
    const isNormallyFinished = (stepTitle: string): boolean => {
      const status = plan.stepStatuses[stepTitle]?.status
      return status === 'completed' || status === 'skipped'
    }
    const priorStepSatisfied = delegation.steps
      .slice(0, stepIndex)
      .every((step) => isNormallyFinished(step.title))
    const priorPhasesSatisfied = document.phases
      .slice(0, phaseIndex)
      .every((priorPhase) =>
        priorPhase.delegations.every((priorDelegation) =>
          priorDelegation.steps.every((step) => isNormallyFinished(step.title))
        )
      )
    const blockedTitle = Object.entries(plan.stepStatuses).find(
      ([, value]) => value.status === 'blocked'
    )?.[0]
    const delegationStartedBeforeBlock = delegation.steps.some(
      (step) => plan.stepStatuses[step.title] !== undefined
    )
    if (
      !priorStepSatisfied ||
      !priorPhasesSatisfied ||
      (blockedTitle !== undefined && !delegationStartedBeforeBlock)
    ) {
      throw new PlanCommandError(
        'dependency-not-satisfied',
        'The Plan step dependencies are not satisfied.'
      )
    }
  }

  private project(
    document: PlanDocumentV1,
    plan: SessionPlanRuntimeContext,
    revision: number,
    interactionIsLive = false
  ): ActivePlanProjection {
    const titles = planStepTitles(document)
    return {
      artifactId: plan.artifactId,
      artifactVersionId: plan.artifactVersionId,
      artifactChecksum: plan.artifactChecksum,
      ...(plan.originatingPromptMessageId
        ? { originatingPromptMessageId: plan.originatingPromptMessageId }
        : {}),
      revision,
      approval: plan.approval,
      lifecycle: derivePlanLifecycle(document, plan.approval, plan.stepStatuses, interactionIsLive),
      requiresExplicitContinuation:
        !interactionIsLive &&
        plan.approval === 'approved' &&
        !isPlanComplete(document, plan.stepStatuses),
      document,
      stepStatuses: plan.stepStatuses,
      stepStates: projectPlanStepStates(document, plan.stepStatuses),
      counts: {
        phases: document.phases.length,
        delegations: document.phases.reduce((sum, phase) => sum + phase.delegations.length, 0),
        steps: titles.length,
        completed: titles.filter((title) => {
          const status = plan.stepStatuses[title]?.status
          return status === 'completed' || status === 'skipped'
        }).length,
        inProgress: titles.filter((title) => plan.stepStatuses[title]?.status === 'in_progress')
          .length
      }
    }
  }
}

export { PlanService }
export type { PlanResponseResult, PlanServiceDependencies }

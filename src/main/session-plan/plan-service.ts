import { createHash, randomUUID } from 'node:crypto'

import type {
  PersistedChatMessage,
  SessionPlanDelivery,
  SessionPlanRuntimeContext,
  SessionPlanStepStatus,
  SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  isPlanTerminalOutcome,
  parsePlanDocumentV1,
  PlanCommandError,
  projectPlanStepStates,
  planStepTitles,
  type ActivePlanProjection,
  type GeneratePlanContent,
  type PlanDocumentV1,
  type PlanResponseCommand
} from '../../shared/session-plan/contract'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'
import { matchPlanDelivery } from './plan-delivery'

type ArtifactWriteResult = Readonly<{
  artifactId?: string
  versionId?: string
  checksum?: string
  name: string
}>

type SessionPlanIdentityOwner = Pick<
  SessionPlanInteractionOwner,
  'register' | 'interactionIdFor' | 'release'
>

type PlanServiceDependencies = Readonly<{
  interactions: SessionPlanIdentityOwner
  writeArtifactForExecution: (
    executionId: string,
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
    archivePlanProjection?: ActivePlanProjection
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle'
    beforePersist?: () => void
  }) => Promise<SessionRuntimeContext>
  isRevisionConflict: (error: unknown) => boolean
  persistUserMessage: (input: {
    projectId: string
    sessionId: string
    content: string
    interactionId: string
    beforePersist?: () => void
    markPlanReview?: Readonly<{
      expectedRevision: number
      plan: SessionPlanRuntimeContext
      commandId: string
      createdAt: number
    }>
  }) => Promise<PersistedChatMessage>
  now?: () => number
  createId?: () => string
  createCommandId?: () => string
  onApprovalRequested?: (request: {
    projectId: string
    sessionId: string
    artifactVersionId: string
    summary: string
  }) => void
  onApprovalSettled?: (request: {
    projectId: string
    sessionId: string
    artifactVersionId: string
    state: 'resolved' | 'rejected' | 'expired' | 'cancelled'
  }) => void
}>

type PlanIdentityCommand = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
}>

type PlanStepStatusUpdate = Readonly<{
  title: string
  status: SessionPlanStepStatus
  notes?: string
}>

type ActivePlanStepStatusCommand = Readonly<{
  projectId: string
  sessionId: string
  authorizeUpdate: (projection: ActivePlanProjection) => void | Promise<void>
}> &
  PlanStepStatusUpdate

type PlanDecisionCommitPrecondition = Readonly<{
  beforeDecisionCommit?: () => boolean
}>

type PlanFeedbackCommitPrecondition = Readonly<{
  beforeFeedbackPersist?: () => void
}>

type PlanDecisionResult = {
  projection: ActivePlanProjection
  changed: boolean
  deliveryCommandId?: string
}
type PlanFeedbackResult = {
  kind: 'feedback'
  routeToInteractionId: string
  artifactVersionId: string
  text: string
  message: PersistedChatMessage
  planRevision: number
  deliveryCommandId: string
}
type PlanResponseResult = PlanDecisionResult | PlanFeedbackResult

type PlanDeliveryContext = Readonly<{
  delivery: SessionPlanDelivery
  projection: ActivePlanProjection
  reviewFeedbackMessageId?: string
}>

type PlanDeliveryDescriptor = Pick<SessionPlanDelivery, 'kind' | 'originatingPromptMessageId'>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const isTerminalStepStatus = (status: SessionPlanStepStatus): boolean =>
  status === 'completed' || status === 'blocked' || status === 'skipped'

const runtimeStatusFor = (
  plan: SessionPlanRuntimeContext,
  title: string
): SessionPlanRuntimeContext['stepStatuses'][string] | undefined =>
  Object.hasOwn(plan.stepStatuses, title) ? plan.stepStatuses[title] : undefined

const withoutDelivery = (plan: SessionPlanRuntimeContext): SessionPlanRuntimeContext => {
  const settled = { ...plan }
  Reflect.deleteProperty(settled, 'delivery')
  return settled
}

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
  private readonly createCommandId: () => string
  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => randomUUID().slice(0, 8))
    this.createCommandId = dependencies.createCommandId ?? randomUUID
  }

  async generate(input: {
    projectId: string
    sessionId: string
    executionId: string
    interactionId: string
    content: GeneratePlanContent
  }): Promise<{ projection: ActivePlanProjection; pauseInteraction: true }> {
    const document = createPlanDocumentV1(input.content)
    const serialized = JSON.stringify(document, null, 2)
    const checksum = sha256(serialized)
    const current = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    if (current.plan?.approval === 'pending') {
      if (current.plan.artifactChecksum === checksum) {
        this.dependencies.interactions.register({
          sessionId: input.sessionId,
          artifactVersionId: current.plan.artifactVersionId,
          interactionId: input.interactionId
        })
        return {
          projection: this.project(document, current.plan, current.revision),
          pauseInteraction: true
        }
      }
      if (!current.plan.reviewFeedbackMessageId) {
        throw new PlanCommandError(
          'plan-review-pending',
          'The existing Session Plan is still awaiting review.'
        )
      }
    }
    let archivePlanProjection: ActivePlanProjection | undefined
    if (current.plan) {
      try {
        archivePlanProjection = this.project(
          await this.readDocument(input.projectId, input.sessionId, current.plan),
          current.plan,
          current.revision
        )
      } catch (error) {
        if (!(error instanceof PlanCommandError) || error.code !== 'artifact-unavailable')
          throw error
      }
    }
    const artifact = await this.dependencies.writeArtifactForExecution(input.executionId, {
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
    const plan: SessionPlanRuntimeContext = {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      artifactChecksum: artifact.checksum,
      document,
      originatingPromptMessageId: input.interactionId,
      materializedAt: this.now(),
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
        ...(archivePlanProjection ? { archivePlanProjection } : {}),
        sessionStatus: 'waiting-plan-approval'
      })
    } catch (error) {
      if (this.dependencies.isRevisionConflict(error)) {
        throw new PlanCommandError('revision-conflict', 'The Session Plan changed concurrently.')
      }
      throw error
    }
    this.dependencies.interactions.register({
      sessionId: input.sessionId,
      artifactVersionId: plan.artifactVersionId,
      interactionId: input.interactionId
    })
    if (
      current.plan?.approval === 'pending' &&
      current.plan.artifactVersionId !== plan.artifactVersionId
    ) {
      this.dependencies.onApprovalSettled?.({
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: current.plan.artifactVersionId,
        state: 'cancelled'
      })
    }
    this.dependencies.onApprovalRequested?.({
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: plan.artifactVersionId,
      summary: input.content.task_summary
    })
    return { projection: this.project(document, plan, next.revision), pauseInteraction: true }
  }

  async respond(
    input: PlanIdentityCommand &
      Readonly<{ decision: 'approved' | 'rejected'; interactionIsLive?: boolean }> &
      PlanDecisionCommitPrecondition
  ): Promise<PlanDecisionResult>
  async respond(
    input: Readonly<{ projectId: string; sessionId: string; feedback: string }> &
      PlanFeedbackCommitPrecondition
  ): Promise<PlanFeedbackResult>
  async respond(
    input: PlanResponseCommand &
      Readonly<{ interactionIsLive?: boolean }> &
      PlanDecisionCommitPrecondition &
      PlanFeedbackCommitPrecondition
  ): Promise<PlanResponseResult>
  async respond(
    input: PlanResponseCommand &
      Readonly<{ interactionIsLive?: boolean }> &
      PlanDecisionCommitPrecondition &
      PlanFeedbackCommitPrecondition
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
      const interactionId = this.dependencies.interactions.interactionIdFor(
        input.sessionId,
        plan.artifactVersionId
      )
      if (!interactionId) {
        throw new PlanCommandError(
          'stale-plan',
          'The Plan interaction is no longer available for revision feedback.'
        )
      }
      await this.readDocument(input.projectId, input.sessionId, plan)
      const deliveryCommandId = this.createCommandId()
      const deliveryCreatedAt = this.now()
      const message = await this.dependencies.persistUserMessage({
        projectId: input.projectId,
        sessionId: input.sessionId,
        content: text,
        interactionId,
        ...(input.beforeFeedbackPersist ? { beforePersist: input.beforeFeedbackPersist } : {}),
        markPlanReview: {
          expectedRevision: context.revision,
          plan,
          commandId: deliveryCommandId,
          createdAt: deliveryCreatedAt
        }
      })
      this.dependencies.interactions.release(input.sessionId, plan.artifactVersionId)
      this.dependencies.onApprovalSettled?.({
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: plan.artifactVersionId,
        state: 'resolved'
      })
      return {
        kind: 'feedback',
        routeToInteractionId: interactionId,
        artifactVersionId: plan.artifactVersionId,
        text,
        message,
        planRevision: context.revision + 1,
        deliveryCommandId
      }
    }
    const { context, plan, document } = await this.loadActive(input, input.decision)
    if (plan.approval === input.decision) {
      this.dependencies.interactions.release(input.sessionId, plan.artifactVersionId)
      this.dependencies.onApprovalSettled?.({
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: plan.artifactVersionId,
        state: input.decision === 'rejected' ? 'rejected' : 'resolved'
      })
      return {
        projection: this.project(document, plan, context.revision),
        changed: false,
        ...(plan.delivery ? { deliveryCommandId: plan.delivery.commandId } : {})
      }
    }
    if (plan.approval !== 'pending') {
      throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
    }
    if (!plan.originatingPromptMessageId) {
      throw new PlanCommandError(
        'invalid-plan',
        'The Plan cannot be delivered because its originating user Message is unavailable.'
      )
    }
    const settledPlan = { ...plan }
    const existingDelivery = plan.delivery
    Reflect.deleteProperty(settledPlan, 'reviewFeedbackMessageId')
    if (existingDelivery?.kind === 'review-feedback') {
      Reflect.deleteProperty(settledPlan, 'delivery')
    }
    const updated: SessionPlanRuntimeContext = {
      ...settledPlan,
      ...(existingDelivery && existingDelivery.kind !== 'review-feedback'
        ? { delivery: existingDelivery }
        : {}),
      approval: input.decision,
      delivery: {
        commandId: this.createCommandId(),
        kind: input.decision === 'approved' ? 'approved-plan' : 'rejected-plan',
        state: 'queued',
        originatingPromptMessageId: plan.originatingPromptMessageId,
        createdAt: this.now()
      }
    }
    const beforePersist = input.beforeDecisionCommit
      ? (): void => {
          if (!input.beforeDecisionCommit?.()) {
            throw new PlanCommandError(
              'interaction-mismatch',
              'The Session Plan decision authorization was revoked before commit.'
            )
          }
        }
      : undefined
    const next = await this.patch(
      input,
      updated,
      input.interactionIsLive ? 'running' : 'idle',
      beforePersist
    )
    this.dependencies.interactions.release(input.sessionId, plan.artifactVersionId)
    this.dependencies.onApprovalSettled?.({
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: plan.artifactVersionId,
      state: input.decision === 'rejected' ? 'rejected' : 'resolved'
    })
    return {
      projection: this.project(document, updated, next.revision),
      changed: true,
      deliveryCommandId: updated.delivery!.commandId
    }
  }

  async queueSettledDecisionDelivery(
    input: PlanIdentityCommand & Readonly<{ decision: 'approved' | 'rejected' }>
  ): Promise<PlanDecisionResult> {
    const kind = input.decision === 'approved' ? 'approved-plan' : 'rejected-plan'
    return this.enqueueDelivery(input, (plan) => {
      if (plan.approval !== input.decision) {
        throw new PlanCommandError(
          'approval-already-decided',
          'The Plan decision changed before delivery handoff.'
        )
      }
      if (!plan.originatingPromptMessageId) {
        throw new PlanCommandError(
          'invalid-plan',
          'The Plan cannot be delivered because its originating user Message is unavailable.'
        )
      }
      return { kind, originatingPromptMessageId: plan.originatingPromptMessageId }
    })
  }

  async queueReviewFeedbackDelivery(
    input: PlanIdentityCommand & Readonly<{ feedbackMessageId: string }>
  ): Promise<PlanDecisionResult> {
    return this.enqueueDelivery(input, (plan) => {
      if (plan.approval !== 'pending' || plan.reviewFeedbackMessageId !== input.feedbackMessageId) {
        throw new PlanCommandError(
          'interaction-mismatch',
          'The persisted Plan review feedback changed before delivery handoff.'
        )
      }
      return {
        kind: 'review-feedback',
        originatingPromptMessageId: input.feedbackMessageId
      }
    })
  }

  private async enqueueDelivery(
    input: PlanIdentityCommand,
    describeDelivery: (plan: SessionPlanRuntimeContext) => PlanDeliveryDescriptor
  ): Promise<PlanDecisionResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
      const plan = context.plan
      if (!plan || plan.artifactVersionId !== input.artifactVersionId) {
        throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
      }
      const descriptor = describeDelivery(plan)
      const document = await this.readDocument(input.projectId, input.sessionId, plan)
      if (plan.delivery) {
        if (
          plan.delivery.kind === descriptor.kind &&
          plan.delivery.originatingPromptMessageId === descriptor.originatingPromptMessageId
        ) {
          return {
            projection: this.project(document, plan, context.revision),
            changed: false,
            deliveryCommandId: plan.delivery.commandId
          }
        }
        throw new PlanCommandError(
          'interaction-mismatch',
          'A different Plan delivery receipt is already active.'
        )
      }
      const queued: SessionPlanRuntimeContext = {
        ...plan,
        delivery: {
          commandId: this.createCommandId(),
          kind: descriptor.kind,
          state: 'queued',
          originatingPromptMessageId: descriptor.originatingPromptMessageId,
          createdAt: this.now()
        }
      }
      try {
        const next = await this.dependencies.patchRuntimeContext({
          projectId: input.projectId,
          sessionId: input.sessionId,
          expectedRevision: context.revision,
          plan: queued,
          sessionStatus: 'idle'
        })
        return {
          projection: this.project(document, queued, next.revision),
          changed: true,
          deliveryCommandId: queued.delivery!.commandId
        }
      } catch (error) {
        if (!this.dependencies.isRevisionConflict(error) || attempt === 2) {
          if (this.dependencies.isRevisionConflict(error)) {
            throw new PlanCommandError(
              'revision-conflict',
              'The Plan delivery receipt changed concurrently.'
            )
          }
          throw error
        }
      }
    }
    throw new PlanCommandError(
      'revision-conflict',
      'The Plan delivery receipt changed concurrently.'
    )
  }

  async updateStepStatus(
    input: PlanIdentityCommand & PlanStepStatusUpdate
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }>
  async updateStepStatus(
    input: ActivePlanStepStatusCommand
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }>
  async updateStepStatus(
    input: (PlanIdentityCommand & PlanStepStatusUpdate) | ActivePlanStepStatusCommand
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }> {
    let loaded: Awaited<ReturnType<PlanService['loadActive']>>
    let identity: PlanIdentityCommand
    if ('authorizeUpdate' in input) {
      const current = await this.loadCurrent(input.projectId, input.sessionId)
      if (!current) {
        throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
      }
      loaded = current
      const { context, plan, document } = current
      identity = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: plan.artifactVersionId,
        expectedRevision: context.revision
      }
      await input.authorizeUpdate(this.project(document, plan, context.revision))
    } else {
      identity = input
      loaded = await this.loadActive(input, undefined, {
        title: input.title,
        status: input.status
      })
    }
    const { plan, document } = loaded
    if (plan.approval !== 'approved') {
      throw new PlanCommandError(
        'plan-not-approved',
        'The Plan must be approved before its steps can be updated.'
      )
    }
    if (!planStepTitles(document).includes(input.title)) {
      throw new PlanCommandError('unknown-step', `Unknown Plan step: ${input.title}`)
    }
    const previous = runtimeStatusFor(plan, input.title)?.status
    const sameTerminal = previous === input.status && isTerminalStepStatus(input.status)
    if (sameTerminal) {
      const latestContext = await this.dependencies.readRuntimeContext(
        input.projectId,
        input.sessionId
      )
      const latestPlan = latestContext.plan
      const sameArtifactVersion =
        latestPlan?.artifactId === plan.artifactId &&
        latestPlan.artifactVersionId === plan.artifactVersionId &&
        latestPlan.artifactChecksum === plan.artifactChecksum
      if (
        !sameArtifactVersion ||
        latestPlan.approval !== 'approved' ||
        runtimeStatusFor(latestPlan, input.title)?.status !== input.status
      ) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision changed concurrently.')
      }
      return {
        projection: this.project(document, latestPlan, latestContext.revision),
        changed: false
      }
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
    const settled = isPlanTerminalOutcome(document, updated.stepStatuses)
      ? withoutDelivery(updated)
      : updated
    const next = await this.patch(identity, settled, 'running')
    return { projection: this.project(document, settled, next.revision), changed: true }
  }

  async getProjection(projectId: string, sessionId: string): Promise<ActivePlanProjection | null> {
    const current = await this.loadCurrent(projectId, sessionId)
    if (!current) return null
    return this.project(current.document, current.plan, current.context.revision)
  }

  async getDeliveryContext(input: {
    projectId: string
    sessionId: string
    commandId: string
  }): Promise<PlanDeliveryContext> {
    const current = await this.loadCurrent(input.projectId, input.sessionId)
    if (!current?.plan.delivery) {
      throw new PlanCommandError('no-active-plan', 'The Session has no pending Plan delivery.')
    }
    const delivery = matchPlanDelivery(current.plan, { commandId: input.commandId })
    if (!delivery) {
      throw new PlanCommandError('revision-conflict', 'The Plan delivery receipt changed.')
    }
    return {
      delivery,
      projection: this.project(current.document, current.plan, current.context.revision),
      ...(current.plan.reviewFeedbackMessageId
        ? { reviewFeedbackMessageId: current.plan.reviewFeedbackMessageId }
        : {})
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
      runtimeStatusFor(plan, idempotentStep.title)?.status === idempotentStep.status
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

  private async loadCurrent(
    projectId: string,
    sessionId: string
  ): Promise<{
    context: SessionRuntimeContext
    plan: SessionPlanRuntimeContext
    document: PlanDocumentV1
  } | null> {
    const context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    if (!context.plan) return null
    try {
      return {
        context,
        plan: context.plan,
        document: await this.readDocument(projectId, sessionId, context.plan)
      }
    } catch (error) {
      if (!(error instanceof PlanCommandError) || error.code !== 'artifact-unavailable') throw error
      await this.dropUnavailablePlan(projectId, sessionId, context)
      return null
    }
  }

  private async dropUnavailablePlan(
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
        if (observed.plan?.approval === 'pending') {
          this.dependencies.onApprovalSettled?.({
            projectId,
            sessionId,
            artifactVersionId: observed.plan.artifactVersionId,
            state: 'expired'
          })
        }
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
    if (plan.document) {
      let document: PlanDocumentV1
      try {
        document = parsePlanDocumentV1(plan.document)
      } catch {
        throw new PlanCommandError(
          'artifact-unavailable',
          'The active Plan document is unreadable.'
        )
      }
      if (sha256(JSON.stringify(document, null, 2)) !== plan.artifactChecksum) {
        throw new PlanCommandError(
          'artifact-unavailable',
          'The active Plan document failed verification.'
        )
      }
      return document
    }
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
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle',
    beforePersist?: () => void
  ): Promise<SessionRuntimeContext> {
    try {
      return await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        plan,
        sessionStatus,
        ...(beforePersist ? { beforePersist } : {})
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
      const status = runtimeStatusFor(plan, stepTitle)?.status
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
      (step) => runtimeStatusFor(plan, step.title) !== undefined
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
    revision: number
  ): ActivePlanProjection {
    const titles = planStepTitles(document)
    const lifecycle = derivePlanLifecycle(document, plan.approval, plan.stepStatuses)
    return {
      artifactId: plan.artifactId,
      artifactVersionId: plan.artifactVersionId,
      artifactChecksum: plan.artifactChecksum,
      ...(plan.originatingPromptMessageId
        ? { originatingPromptMessageId: plan.originatingPromptMessageId }
        : {}),
      ...(plan.materializedAt !== undefined ? { materializedAt: plan.materializedAt } : {}),
      revision,
      approval: plan.approval,
      lifecycle,
      document,
      stepStatuses: plan.stepStatuses,
      stepStates: projectPlanStepStates(document, plan.stepStatuses),
      counts: {
        phases: document.phases.length,
        delegations: document.phases.reduce((sum, phase) => sum + phase.delegations.length, 0),
        steps: titles.length,
        completed: titles.filter((title) => {
          const status = runtimeStatusFor(plan, title)?.status
          return status === 'completed' || status === 'skipped'
        }).length,
        inProgress: titles.filter(
          (title) => runtimeStatusFor(plan, title)?.status === 'in_progress'
        ).length
      }
    }
  }
}

export { PlanService }
export type { PlanDeliveryContext, PlanResponseResult, PlanServiceDependencies }

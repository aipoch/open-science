import type { AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import type {
  ActivePlanProjection,
  GeneratePlanContent,
  PlanResponseCommand
} from '../../shared/session-plan/contract'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { SessionPlanStepStatus } from '../../shared/session-persistence'
import { createLogger, errorLogFields } from '../logger'
import type { PlanResponseResult } from '../session-plan/plan-service'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpPromptTurnPlanContext, AcpPromptTurnPlanWorkflow } from './prompt-turn-workflow'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'

type AcpSessionPlanCall = Readonly<{
  projectId: string
  sessionId: string
  operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus'
  input?: unknown
}>

const log = createLogger('acp')

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Plan projection and the original operation result take precedence over diagnostics.
  }
}

const safeLogInfo = (message: string, fields: Record<string, unknown>): void => {
  try {
    log.info(message, fields)
  } catch {
    // Plan state and the original operation result take precedence over diagnostics.
  }
}

// Composes ACP-facing Session Plan application policy around the authoritative Plan, interaction,
// Artifact, durable-branch, and publication owners. It owns no mutable state of its own.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimePlanWorkflow = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners
) => {
  const service = base.planService
  const interactions = base.planInteractions
  const sessionInteractions = base.sessionInteractions
  const planSessions = options.plan?.sessions
  const pushEvent = (
    event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>
  ): void => session.publication.pushEvent(event)
  const publishProjection = (sessionId: string, projection: ActivePlanProjection): void => {
    try {
      pushEvent({
        id: `session-plan-${projection.artifactVersionId}-${projection.revision}`,
        timestamp: Date.now(),
        kind: 'plan',
        level: 'info',
        sessionId,
        title: 'Session Plan updated',
        planProjection: projection
      })
    } catch (error) {
      safeLogError('Session Plan projection callback failed', error)
    }
  }
  const assertVisibleToDurableBranch = async (
    projectId: string,
    sessionId: string,
    projection: ActivePlanProjection
  ): Promise<void> => {
    const origin = projection.originatingPromptMessageId
    if (
      !origin ||
      !planSessions ||
      !(await planSessions.containsMessageOnActiveBranch(projectId, sessionId, origin))
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The active Session Plan does not belong to the durable active Message Branch.'
      )
    }
  }
  const bindExecutionToCurrentInteraction = (
    sessionId: string,
    artifactVersionId: string
  ): void => {
    const interaction = sessionInteractions.current(sessionId)
    if (!interaction || interaction.kind !== 'prompt') return
    interactions.bindExecution({
      sessionId,
      interactionSequence: interaction.sequence,
      artifactVersionId
    })
  }
  const rejectApprovalForInteraction = (
    sessionId: string,
    interactionId: string,
    reason: string
  ): void => {
    interactions.releaseApprovalReservation(sessionId, interactionId)
    if (interactions.approvalInteractionIdFor(sessionId) !== interactionId) return
    interactions.rejectApproval(sessionId, reason)
  }
  const call = async (input: AcpSessionPlanCall): Promise<unknown> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    if (input.operation === 'generate') {
      const interactionId = base.artifactTurns?.promptMessageIdFor(input.sessionId)
      if (!interactionId) throw new Error('No active interaction can generate a Session Plan.')
      interactions.reserveApproval(input.sessionId, interactionId)
      let result: Awaited<ReturnType<NonNullable<typeof service>['generate']>>
      try {
        result = await service.generate({
          projectId: input.projectId,
          sessionId: input.sessionId,
          interactionId,
          content: input.input as GeneratePlanContent
        })
      } catch (error) {
        interactions.releaseApprovalReservation(input.sessionId, interactionId)
        const current = await service.getProjection(input.projectId, input.sessionId)
        if (current) publishProjection(input.sessionId, current)
        throw error
      }
      let approval: Promise<unknown>
      try {
        approval = interactions.parkReservedApproval(input.sessionId, interactionId)
      } catch (error) {
        interactions.release(input.sessionId, result.projection.artifactVersionId)
        throw error
      }
      safeLogInfo('Session Plan generated', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: result.projection.artifactVersionId,
        revision: result.projection.revision
      })
      publishProjection(input.sessionId, result.projection)
      return approval
    }
    const projection = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive: sessionInteractions.current(input.sessionId) !== undefined
    })
    if (!projection) throw new Error('The Session has no active Plan.')
    await assertVisibleToDurableBranch(input.projectId, input.sessionId, projection)
    const identity = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: projection.artifactVersionId,
      expectedRevision: projection.revision
    }
    if (input.operation === 'approve' || input.operation === 'reject') {
      const interaction = sessionInteractions.current(input.sessionId)
      const interactionIsLive = interaction !== undefined
      const decision = input.operation === 'approve' ? 'approved' : 'rejected'
      const requiresHumanFeedback = projection.approval === 'pending'
      const authorization =
        interaction?.kind === 'prompt'
          ? {
              sessionId: input.sessionId,
              artifactVersionId: projection.artifactVersionId,
              interactionSequence: interaction.sequence
            }
          : undefined
      if (
        requiresHumanFeedback &&
        (!authorization || !interactions.isAgentDecisionAuthorized(authorization))
      ) {
        throw new PlanCommandError(
          'interaction-mismatch',
          'A pending Session Plan decision requires post-generation human feedback.'
        )
      }
      const executionBinding = interactions.executionBindingFor(input.sessionId)
      let decisionAuthorizationConsumed = false
      const beforeDecisionCommit =
        requiresHumanFeedback && authorization
          ? (): boolean => {
              const currentInteraction = sessionInteractions.current(input.sessionId)
              decisionAuthorizationConsumed =
                currentInteraction?.kind === 'prompt' &&
                currentInteraction.sequence === authorization.interactionSequence &&
                interactions.consumeAgentDecisionAuthorization(authorization)
              return decisionAuthorizationConsumed
            }
          : undefined
      const result = await service
        .respond({
          ...identity,
          decision,
          interactionIsLive,
          ...(beforeDecisionCommit ? { beforeDecisionCommit } : {})
        })
        .catch((error: unknown) => {
          const currentInteraction = sessionInteractions.current(input.sessionId)
          if (
            decisionAuthorizationConsumed &&
            authorization &&
            currentInteraction?.kind === 'prompt' &&
            currentInteraction.sequence === authorization.interactionSequence
          ) {
            interactions.authorizeAgentDecision(authorization)
          }
          throw error
        })
      if (decision === 'approved') {
        if (requiresHumanFeedback && authorization) {
          if (result.changed) {
            const currentExecution = interactions.executionBindingFor(input.sessionId)
            if (
              !currentExecution ||
              currentExecution.interactionSequence <= authorization.interactionSequence
            ) {
              interactions.bindExecution({
                sessionId: input.sessionId,
                interactionSequence: authorization.interactionSequence,
                artifactVersionId: result.projection.artifactVersionId
              })
            }
          } else {
            interactions.releaseAgentDecisionAuthorization(
              input.sessionId,
              authorization.interactionSequence
            )
          }
        } else {
          bindExecutionToCurrentInteraction(input.sessionId, result.projection.artifactVersionId)
        }
      } else if (executionBinding) {
        interactions.releaseExecution(input.sessionId, executionBinding.interactionSequence)
      }
      interactions.resolveApproval(input.sessionId, result)
      safeLogInfo('Session Plan response accepted', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: result.projection.artifactVersionId,
        revision: result.projection.revision,
        source: requiresHumanFeedback ? 'agent-after-feedback' : 'agent-continuation',
        decision,
        changed: result.changed
      })
      publishProjection(input.sessionId, result.projection)
      return result
    }
    const update = input.input as {
      title: string
      status: SessionPlanStepStatus
      notes?: string
      expectedArtifactVersionId?: string
    }
    if (projection.approval !== 'approved') {
      throw new PlanCommandError(
        'plan-not-approved',
        'The Plan is still pending. Interpret the user Message, then call generate_plan with decision:"approved" or decision:"rejected" before updating steps.'
      )
    }
    const interaction = sessionInteractions.current(input.sessionId)
    const binding = interactions.executionBindingFor(input.sessionId)
    if (!binding) {
      throw new PlanCommandError(
        'continuation-required',
        'Continuing this Plan requires an explicit user continuation.'
      )
    }
    if (!interaction || binding.interactionSequence !== interaction.sequence) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is not authorized to execute the active Plan.'
      )
    }
    if (
      binding.artifactVersionId !== projection.artifactVersionId ||
      (update.expectedArtifactVersionId !== undefined &&
        update.expectedArtifactVersionId !== binding.artifactVersionId)
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is bound to a different Plan Artifact Version.'
      )
    }
    const result = await service.updateStepStatus({
      ...identity,
      artifactVersionId: update.expectedArtifactVersionId ?? identity.artifactVersionId,
      title: update.title,
      status: update.status,
      ...(update.notes ? { notes: update.notes } : {})
    })
    safeLogInfo('Session Plan step status updated', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: result.projection.artifactVersionId,
      revision: result.projection.revision,
      status: update.status,
      changed: result.changed
    })
    publishProjection(input.sessionId, result.projection)
    return result
  }
  const projection = (projectId: string, sessionId: string): Promise<ActivePlanProjection | null> =>
    service?.getProjection(projectId, sessionId, {
      interactionIsLive: sessionInteractions.current(sessionId) !== undefined
    }) ?? Promise.resolve(null)
  const respond = async (input: PlanResponseCommand): Promise<PlanResponseResult> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    const approvalInteractionId = interactions.approvalInteractionIdFor(input.sessionId)
    const feedbackInteraction =
      input.decision === undefined ? sessionInteractions.current(input.sessionId) : undefined
    if (input.decision === undefined) {
      if (
        !approvalInteractionId ||
        feedbackInteraction?.kind !== 'prompt' ||
        feedbackInteraction.promptMessageId !== approvalInteractionId
      ) {
        if (approvalInteractionId) {
          rejectApprovalForInteraction(
            input.sessionId,
            approvalInteractionId,
            'The paused Session Plan interaction was superseded before feedback was routed.'
          )
        }
        throw new Error('The paused Session Plan interaction is no longer available.')
      }
    }
    const interactionIsLive = approvalInteractionId !== undefined
    const current = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive
    })
    if (!current) throw new Error('The Session has no active Plan.')
    await assertVisibleToDurableBranch(input.projectId, input.sessionId, current)
    const beforeFeedbackPersist =
      input.decision === undefined &&
      approvalInteractionId &&
      feedbackInteraction?.kind === 'prompt'
        ? (): void => {
            const activeInteraction = sessionInteractions.current(input.sessionId)
            if (
              interactions.approvalInteractionIdFor(input.sessionId) === approvalInteractionId &&
              interactions.interactionIdFor(input.sessionId, current.artifactVersionId) ===
                approvalInteractionId &&
              activeInteraction?.kind === 'prompt' &&
              activeInteraction.sequence === feedbackInteraction.sequence &&
              activeInteraction.promptMessageId === feedbackInteraction.promptMessageId
            ) {
              return
            }
            rejectApprovalForInteraction(
              input.sessionId,
              approvalInteractionId,
              'The paused Session Plan interaction was superseded before feedback was persisted.'
            )
            throw new PlanCommandError(
              'interaction-mismatch',
              'The paused Session Plan interaction is no longer available.'
            )
          }
        : undefined
    const result = await service.respond({
      ...input,
      interactionIsLive,
      ...(beforeFeedbackPersist ? { beforeFeedbackPersist } : {})
    })
    if ('projection' in result) {
      const interaction = sessionInteractions.current(input.sessionId)
      if (interactionIsLive && result.projection.approval === 'approved') {
        bindExecutionToCurrentInteraction(input.sessionId, result.projection.artifactVersionId)
      }
      if (interaction?.kind === 'prompt') {
        interactions.releaseAgentDecisionAuthorization(input.sessionId, interaction.sequence)
      }
      if (interactionIsLive) interactions.resolveApproval(input.sessionId, result)
      safeLogInfo('Session Plan response accepted', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: result.projection.artifactVersionId,
        revision: result.projection.revision,
        source: 'human-button',
        decision: result.projection.approval,
        changed: result.changed
      })
      publishProjection(input.sessionId, result.projection)
      return result
    }
    if (
      !approvalInteractionId ||
      !feedbackInteraction ||
      feedbackInteraction.kind !== 'prompt' ||
      result.routeToInteractionId !== approvalInteractionId
    ) {
      if (approvalInteractionId) {
        rejectApprovalForInteraction(
          input.sessionId,
          approvalInteractionId,
          'The paused Session Plan interaction was superseded while feedback was routed.'
        )
      }
      throw new Error('The paused Session Plan interaction is no longer available.')
    }
    const currentInteraction = sessionInteractions.current(input.sessionId)
    const interactionIsCurrent =
      currentInteraction?.kind === 'prompt' &&
      currentInteraction.sequence === feedbackInteraction.sequence &&
      currentInteraction.promptMessageId === feedbackInteraction.promptMessageId
    try {
      pushEvent({
        id: `session-user-message-${result.message.id}`,
        timestamp: result.message.createdAt,
        kind: 'message',
        level: 'info',
        sessionId: input.sessionId,
        promptMessageId: result.message.responseToMessageId,
        messageId: result.message.id,
        role: 'user',
        text: result.message.content
      })
    } catch (error) {
      safeLogError('Routed user Message projection callback failed', error)
    }
    if (interactionIsCurrent) {
      interactions.authorizeAgentDecision({
        sessionId: input.sessionId,
        artifactVersionId: result.artifactVersionId,
        interactionSequence: feedbackInteraction.sequence
      })
    }
    if (!interactions.resolveApproval(input.sessionId, result) && interactionIsCurrent) {
      interactions.releaseAgentDecisionAuthorization(input.sessionId, feedbackInteraction.sequence)
    }
    safeLogInfo('Session Plan feedback routed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: result.artifactVersionId,
      revision: current.revision,
      source: 'human-feedback'
    })
    return result
  }

  const preflight = (
    request: AcpPromptRequest
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> => {
    const projectId = session.sessionEnvironment.projectName(request.sessionId)
    if (request.planContinuation && request.planContinuation.projectId !== projectId) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The Plan continuation belongs to a different Project.'
      )
    }
    if (request.planContinuation && !service) {
      throw new Error('Session Plan capability is not configured.')
    }
    const continuation = request.planContinuation
    if (continuation?.pendingAction === undefined && continuation) {
      return service!
        .authorizeContinuation({
          projectId: continuation.projectId,
          sessionId: request.sessionId,
          artifactVersionId: continuation.artifactVersionId,
          expectedRevision: continuation.expectedRevision
        })
        .then(async (authorized) => {
          await assertVisibleToDurableBranch(continuation.projectId, request.sessionId, authorized)
          return Object.freeze({ authorized })
        })
    }
    if (!continuation) return Object.freeze({})
    return service!
      .getProjection(continuation.projectId, request.sessionId, {
        interactionIsLive: false
      })
      .then(async (protectedPending) => {
        if (!protectedPending) {
          throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
        }
        if (protectedPending.artifactVersionId !== continuation.artifactVersionId) {
          throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
        }
        if (protectedPending.revision !== continuation.expectedRevision) {
          throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
        }
        if (protectedPending.approval !== 'pending') {
          throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
        }
        await assertVisibleToDurableBranch(
          continuation.projectId,
          request.sessionId,
          protectedPending
        )
        return Object.freeze({ protectedPending })
      })
  }
  const admit = (
    request: AcpPromptRequest,
    interaction: AcpPromptSessionInteractionScope,
    plan: AcpPromptTurnPlanContext
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> => {
    let { authorized, protectedPending } = plan
    const continuation = request.planContinuation
    const decision = continuation?.pendingAction
    const committed = (): AcpPromptTurnPlanContext => {
      if (authorized) {
        interactions.bindExecution({
          sessionId: request.sessionId,
          interactionSequence: interaction.sequence,
          artifactVersionId: authorized.artifactVersionId
        })
      }
      return Object.freeze({
        ...(authorized ? { authorized } : {}),
        ...(protectedPending ? { protectedPending } : {})
      })
    }
    if (continuation && (decision === 'approve' || decision === 'reject')) {
      const executionBinding = interactions.executionBindingFor(request.sessionId)
      return service!
        .respond({
          projectId: continuation.projectId,
          sessionId: request.sessionId,
          artifactVersionId: continuation.artifactVersionId,
          expectedRevision: continuation.expectedRevision,
          decision: decision === 'approve' ? 'approved' : 'rejected',
          interactionIsLive: true
        })
        .then((result) => {
          interactions.releaseAgentDecisionAuthorization(request.sessionId, interaction.sequence)
          if (decision === 'approve') authorized = result.projection
          else {
            protectedPending = result.projection
            if (executionBinding) {
              interactions.releaseExecution(request.sessionId, executionBinding.interactionSequence)
            }
          }
          interactions.resolveApproval(request.sessionId, result)
          safeLogInfo('Session Plan response accepted', {
            projectId: continuation.projectId,
            sessionId: request.sessionId,
            artifactVersionId: result.projection.artifactVersionId,
            revision: result.projection.revision,
            source: 'human-button',
            decision: result.projection.approval,
            changed: result.changed
          })
          publishProjection(request.sessionId, result.projection)
          return committed()
        })
    }
    if (continuation?.pendingAction === 'review' && protectedPending) {
      interactions.authorizeAgentDecision({
        sessionId: request.sessionId,
        interactionSequence: interaction.sequence,
        artifactVersionId: protectedPending.artifactVersionId
      })
    }
    return committed()
  }
  const beforeRelease = (
    sessionId: string,
    interaction: AcpPromptSessionInteractionScope
  ): void => {
    interactions.releaseExecution(sessionId, interaction.sequence)
    interactions.releaseAgentDecisionAuthorization(sessionId, interaction.sequence)
    if (interaction.promptMessageId) {
      rejectApprovalForInteraction(
        sessionId,
        interaction.promptMessageId,
        'The Session Plan interaction ended before approval.'
      )
    }
  }
  const afterRelease = async (sessionId: string): Promise<void> => {
    if (!service) return
    try {
      const current = await service.getProjection(
        session.sessionEnvironment.projectName(sessionId),
        sessionId,
        { interactionIsLive: false }
      )
      if (current) publishProjection(sessionId, current)
    } catch (error) {
      safeLogError('Session Plan terminal projection failed', error)
    }
  }
  const prompt: AcpPromptTurnPlanWorkflow = Object.freeze({
    preflight,
    admit,
    beforeRelease,
    afterRelease
  })
  const capturePromptCancellation = (sessionId: string): (() => void) => {
    const interaction = sessionInteractions.current(sessionId)
    const interactionSequence = interaction?.kind === 'prompt' ? interaction.sequence : undefined
    const interactionId =
      (interaction?.kind === 'prompt' ? interaction.promptMessageId : undefined) ??
      interactions.approvalInteractionIdFor(sessionId)
    return () => {
      if (interactionSequence !== undefined) {
        interactions.releaseAgentDecisionAuthorization(sessionId, interactionSequence)
      }
      if (interactionId) {
        rejectApprovalForInteraction(
          sessionId,
          interactionId,
          'The Session Plan interaction was cancelled.'
        )
      }
    }
  }
  const sessionDeleted = (sessionId: string): void => {
    interactions.clearSession(sessionId, 'The Session Plan interaction was deleted.')
  }

  return Object.freeze({
    call,
    projection,
    respond,
    prompt,
    capturePromptCancellation,
    sessionDeleted
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimePlanWorkflow = ReturnType<typeof composeAcpRuntimePlanWorkflow>

export { composeAcpRuntimePlanWorkflow }
export type { AcpRuntimePlanWorkflow, AcpSessionPlanCall }

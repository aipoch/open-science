import type { AcpPromptRequest, AcpRuntimeEventInput } from '../../shared/acp'
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
import type { SessionPlanContinuationOwner } from './session-plan-continuation-owner'

type AcpSessionPlanCall = Readonly<{
  projectId: string
  sessionId: string
  operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus'
  input?: unknown
  signal?: AbortSignal
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

const waitForPlanApproval = (
  approval: Promise<unknown>,
  signal?: AbortSignal,
  onTransportDetached?: () => void
): Promise<unknown> => {
  if (!signal) return approval
  if (signal.aborted) {
    onTransportDetached?.()
    return Promise.reject(new Error('Session Plan RPC transport disconnected.'))
  }
  return new Promise((resolve, reject) => {
    const detached = (): void => {
      signal.removeEventListener('abort', detached)
      onTransportDetached?.()
      reject(new Error('Session Plan RPC transport disconnected.'))
    }
    signal.addEventListener('abort', detached, { once: true })
    void approval.then(
      (value) => {
        signal.removeEventListener('abort', detached)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', detached)
        reject(error)
      }
    )
  })
}

// Composes ACP-facing Session Plan application policy around the authoritative Plan, interaction,
// Artifact, durable-branch, and publication owners. It owns no mutable state of its own.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimePlanWorkflow = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  hooks: Readonly<{
    continuations?: Pick<SessionPlanContinuationOwner, 'begin' | 'clear' | 'rearmUndispatched'>
  }> = {}
) => {
  const service = base.planService
  const interactions = base.planInteractions
  const sessionInteractions = base.sessionInteractions
  const planSessions = options.plan?.sessions
  const continuationOwner = hooks.continuations
  const pushEvent = (event: AcpRuntimeEventInput): void => session.publication.pushEvent(event)
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
  const beginContinuationReceipt = async (
    projectId: string,
    sessionId: string,
    commandId: string
  ): Promise<boolean> => {
    if (!continuationOwner) return false
    return continuationOwner.begin(projectId, sessionId, commandId)
  }
  const clearContinuationReceipt = async (
    projectId: string,
    sessionId: string,
    commandId: string
  ): Promise<void> => {
    if (!(await continuationOwner?.clear(projectId, sessionId, commandId))) {
      throw new Error('The Plan continuation receipt changed before live handoff completed.')
    }
  }
  const rearmContinuationReceipt = async (
    projectId: string,
    sessionId: string,
    commandId: string
  ): Promise<void> => {
    if (!(await continuationOwner?.rearmUndispatched(projectId, sessionId, commandId))) {
      throw new Error('The Plan continuation receipt could not be rearmed after handoff loss.')
    }
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
      const execution = sessionInteractions.current(input.sessionId)
      if (!execution || execution.kind !== 'prompt') {
        throw new Error('No active interaction can generate a Session Plan.')
      }
      const interactionId = base.artifactTurns?.snapshot(
        base.artifactTurns.handleForExecution(execution.turnToken)
      ).promptMessageId
      if (!interactionId) throw new Error('No active interaction can generate a Session Plan.')
      interactions.reserveApproval(input.sessionId, interactionId)
      let result: Awaited<ReturnType<NonNullable<typeof service>['generate']>>
      try {
        result = await service.generate({
          projectId: input.projectId,
          sessionId: input.sessionId,
          executionId: execution.turnToken,
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
      return waitForPlanApproval(approval, input.signal, () =>
        rejectApprovalForInteraction(
          input.sessionId,
          interactionId,
          'The Session Plan RPC transport disconnected while awaiting approval.'
        )
      )
    }
    if (input.operation === 'approve' || input.operation === 'reject') {
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
      if (
        result.continuationCommandId &&
        (!interactionIsLive ||
          !(await beginContinuationReceipt(
            input.projectId,
            input.sessionId,
            result.continuationCommandId
          )))
      ) {
        publishProjection(input.sessionId, result.projection)
        return result
      }
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
      if (result.continuationCommandId) {
        await clearContinuationReceipt(
          input.projectId,
          input.sessionId,
          result.continuationCommandId
        )
      }
      const handedOffProjection = result.continuationCommandId
        ? ((await service.getProjection(input.projectId, input.sessionId, {
            interactionIsLive: true
          })) ?? result.projection)
        : result.projection
      const handedOffResult = { ...result, projection: handedOffProjection }
      Reflect.deleteProperty(handedOffResult, 'continuationCommandId')
      safeLogInfo('Session Plan response accepted', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: result.projection.artifactVersionId,
        revision: handedOffProjection.revision,
        source: requiresHumanFeedback ? 'agent-after-feedback' : 'agent-continuation',
        decision,
        changed: result.changed
      })
      publishProjection(input.sessionId, handedOffProjection)
      return handedOffResult
    }
    const update = input.input as {
      title: string
      status: SessionPlanStepStatus
      notes?: string
      expectedArtifactVersionId?: string
    }
    let result: Awaited<ReturnType<NonNullable<typeof service>['updateStepStatus']>>
    try {
      result = await service.updateStepStatus({
        projectId: input.projectId,
        sessionId: input.sessionId,
        title: update.title,
        status: update.status,
        ...(update.notes ? { notes: update.notes } : {}),
        authorizeUpdate: async (projection) => {
          await assertVisibleToDurableBranch(input.projectId, input.sessionId, projection)
          if (projection.approval !== 'approved') {
            throw new PlanCommandError(
              'plan-not-approved',
              'The Plan is still pending. Interpret the user Message, then call generate_plan with decision:"approved" or decision:"rejected" before updating steps.'
            )
          }
          const currentInteraction = sessionInteractions.current(input.sessionId)
          const currentBinding = interactions.executionBindingFor(input.sessionId)
          if (!currentBinding) {
            throw new PlanCommandError(
              'continuation-required',
              'Continuing this Plan requires an explicit user continuation.'
            )
          }
          if (
            !currentInteraction ||
            currentBinding.interactionSequence !== currentInteraction.sequence
          ) {
            throw new PlanCommandError(
              'interaction-mismatch',
              'This interaction is not authorized to execute the active Plan.'
            )
          }
          if (
            currentBinding.artifactVersionId !== projection.artifactVersionId ||
            (update.expectedArtifactVersionId !== undefined &&
              update.expectedArtifactVersionId !== currentBinding.artifactVersionId)
          ) {
            throw new PlanCommandError(
              'interaction-mismatch',
              'This interaction is bound to a different Plan Artifact Version.'
            )
          }
        }
      })
    } catch (error) {
      if (error instanceof PlanCommandError && error.code === 'no-active-plan') {
        throw new Error('The Session has no active Plan.')
      }
      throw error
    }
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
  const projection = (
    projectId: string,
    sessionId: string
  ): Promise<ActivePlanProjection | null> => {
    if (!service) return Promise.resolve(null)
    return service.getProjection(projectId, sessionId, {
      interactionIsLive: sessionInteractions.current(sessionId) !== undefined
    })
  }
  const respond = async (input: PlanResponseCommand): Promise<PlanResponseResult> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    const approvalInteractionId = interactions.approvalInteractionIdFor(input.sessionId)
    const feedbackInteraction =
      input.decision === undefined ? sessionInteractions.current(input.sessionId) : undefined
    const detachedFeedback = input.decision === undefined && approvalInteractionId === undefined
    if (input.decision === undefined && !detachedFeedback) {
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
    if (detachedFeedback) {
      const interactionId = current.originatingPromptMessageId
      if (!interactionId) {
        throw new PlanCommandError(
          'interaction-mismatch',
          'The durable Session Plan interaction is unavailable for feedback.'
        )
      }
      interactions.register({
        sessionId: input.sessionId,
        artifactVersionId: current.artifactVersionId,
        interactionId
      })
    }
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
    const beforeDecisionCommit =
      input.decision !== undefined && approvalInteractionId
        ? (): boolean =>
            interactions.approvalInteractionIdFor(input.sessionId) === approvalInteractionId &&
            interactions.interactionIdFor(input.sessionId, current.artifactVersionId) ===
              approvalInteractionId
        : undefined
    let result: PlanResponseResult
    let retriedAfterDecisionDetach = false
    try {
      result = await service.respond({
        ...input,
        interactionIsLive,
        ...(beforeDecisionCommit ? { beforeDecisionCommit } : {}),
        ...(beforeFeedbackPersist ? { beforeFeedbackPersist } : {})
      })
    } catch (error) {
      if (detachedFeedback) {
        interactions.release(input.sessionId, current.artifactVersionId)
      }
      const waiterDetached =
        input.decision !== undefined &&
        approvalInteractionId !== undefined &&
        interactions.approvalInteractionIdFor(input.sessionId) !== approvalInteractionId
      if (!waiterDetached) throw error
      retriedAfterDecisionDetach = true
      result = await service.respond({
        ...input,
        interactionIsLive: false
      })
    }
    if ('projection' in result) {
      const interaction = sessionInteractions.current(input.sessionId)
      if (interaction?.kind === 'prompt') {
        interactions.releaseAgentDecisionAuthorization(input.sessionId, interaction.sequence)
      }
      const sameWaiterIsLive =
        interactionIsLive &&
        !retriedAfterDecisionDetach &&
        approvalInteractionId !== undefined &&
        interactions.approvalInteractionIdFor(input.sessionId) === approvalInteractionId
      if (result.continuationCommandId && !sameWaiterIsLive) {
        publishProjection(input.sessionId, result.projection)
        return result
      }
      if (
        result.continuationCommandId &&
        !(await beginContinuationReceipt(
          input.projectId,
          input.sessionId,
          result.continuationCommandId
        ))
      ) {
        publishProjection(input.sessionId, result.projection)
        return result
      }
      const handedOffResult = { ...result }
      const resolved =
        interactionIsLive && interactions.resolveApproval(input.sessionId, handedOffResult)
      if (result.continuationCommandId && !resolved) {
        await rearmContinuationReceipt(
          input.projectId,
          input.sessionId,
          result.continuationCommandId
        )
        const queuedProjection =
          (await service.getProjection(input.projectId, input.sessionId, {
            interactionIsLive: false
          })) ?? result.projection
        const rearmed = { ...result, projection: queuedProjection }
        publishProjection(input.sessionId, queuedProjection)
        return rearmed
      }
      if (resolved && result.projection.approval === 'approved') {
        bindExecutionToCurrentInteraction(input.sessionId, result.projection.artifactVersionId)
      }
      if (result.continuationCommandId) {
        await clearContinuationReceipt(
          input.projectId,
          input.sessionId,
          result.continuationCommandId
        )
      }
      const handedOffProjection = result.continuationCommandId
        ? ((await service.getProjection(input.projectId, input.sessionId, {
            interactionIsLive: true
          })) ?? result.projection)
        : result.projection
      handedOffResult.projection = handedOffProjection
      Reflect.deleteProperty(handedOffResult, 'continuationCommandId')
      safeLogInfo('Session Plan response accepted', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        artifactVersionId: result.projection.artifactVersionId,
        revision: handedOffProjection.revision,
        source: 'human-button',
        decision: result.projection.approval,
        changed: result.changed
      })
      publishProjection(input.sessionId, handedOffProjection)
      return handedOffResult
    }
    if (!detachedFeedback) {
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
    }
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
    if (detachedFeedback) {
      return result
    }
    if (!approvalInteractionId || feedbackInteraction?.kind !== 'prompt') {
      throw new Error('The paused Session Plan interaction is no longer available.')
    }
    const currentInteraction = sessionInteractions.current(input.sessionId)
    const interactionIsCurrent =
      currentInteraction?.kind === 'prompt' &&
      currentInteraction.sequence === feedbackInteraction.sequence &&
      currentInteraction.promptMessageId === feedbackInteraction.promptMessageId
    const sameFeedbackWaiterIsLive =
      interactionIsCurrent &&
      interactions.approvalInteractionIdFor(input.sessionId) === approvalInteractionId
    if (!sameFeedbackWaiterIsLive) {
      return result
    }
    if (
      !(await beginContinuationReceipt(
        input.projectId,
        input.sessionId,
        result.continuationCommandId
      ))
    ) {
      return result
    }
    if (interactionIsCurrent) {
      interactions.authorizeAgentDecision({
        sessionId: input.sessionId,
        artifactVersionId: result.artifactVersionId,
        interactionSequence: feedbackInteraction.sequence
      })
    }
    const handedOffFeedback = { ...result }
    const feedbackResolved = interactions.resolveApproval(input.sessionId, handedOffFeedback)
    if (!feedbackResolved && interactionIsCurrent) {
      interactions.releaseAgentDecisionAuthorization(input.sessionId, feedbackInteraction.sequence)
    }
    if (!feedbackResolved) {
      await rearmContinuationReceipt(input.projectId, input.sessionId, result.continuationCommandId)
      const queuedProjection = await service.getProjection(input.projectId, input.sessionId, {
        interactionIsLive: false
      })
      if (queuedProjection) {
        result = { ...result, continuationProjection: queuedProjection }
        publishProjection(input.sessionId, queuedProjection)
      }
      return result
    }
    await clearContinuationReceipt(input.projectId, input.sessionId, result.continuationCommandId)
    Reflect.deleteProperty(handedOffFeedback, 'continuationCommandId')
    Reflect.deleteProperty(handedOffFeedback, 'continuationProjection')
    safeLogInfo('Session Plan feedback routed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: result.artifactVersionId,
      revision: current.revision,
      source: 'human-feedback'
    })
    return handedOffFeedback
  }

  const preflight = (
    request: AcpPromptRequest
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> => {
    const projectId = session.sessionEnvironment.projectId(request.sessionId)
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
    if (continuation?.settledAction === 'rejected') {
      return service!
        .getProjection(continuation.projectId, request.sessionId, { interactionIsLive: false })
        .then(async (protectedRejected) => {
          if (!protectedRejected) {
            throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
          }
          if (protectedRejected.artifactVersionId !== continuation.artifactVersionId) {
            throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
          }
          if (protectedRejected.revision !== continuation.expectedRevision) {
            throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
          }
          if (protectedRejected.approval !== 'rejected') {
            throw new PlanCommandError(
              'approval-already-decided',
              'The Plan rejection changed before continuation.'
            )
          }
          await assertVisibleToDurableBranch(
            continuation.projectId,
            request.sessionId,
            protectedRejected
          )
          return Object.freeze({ protectedRejected })
        })
    }
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
    const { protectedRejected } = plan
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
        ...(protectedPending ? { protectedPending } : {}),
        ...(protectedRejected ? { protectedRejected } : {})
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
        session.sessionEnvironment.projectId(sessionId),
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

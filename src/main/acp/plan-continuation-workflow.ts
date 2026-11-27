import type { PromptResponse } from '@agentclientprotocol/sdk'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import type { AcpPromptRequest } from '../../shared/acp'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { matchPlanDelivery } from '../session-plan/plan-delivery'
import type { AcpAppContinuationOwner, AcpContinuationOutcome } from './app-continuation-owner'
import type { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'
import type { AcpRuntimeOptions } from './runtime-contract'
import type { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { SessionPlanDeliveryOwner } from './session-plan-delivery-owner'

type PlanContinuationDelivery = Readonly<{
  projectId: string
  commandId: string
  externalOriginPromptId?: string
  externalOriginRunId?: string
}>

type PlanContinuationDependencies = Readonly<{
  deliveries?: SessionPlanDeliveryOwner
  sessions?: NonNullable<AcpRuntimeOptions['plan']>['sessions']
  hasActiveSession: (sessionId: string) => boolean
  context: Pick<AcpDurableContinuationContextOwner, 'prepare'>
  continuations: Pick<AcpAppContinuationOwner, 'set'>
  publication: Pick<AcpRuntimePublicationOwner, 'pushEvent' | 'emitState'>
  projection: (projectId: string, sessionId: string) => Promise<ActivePlanProjection | null>
  send: (
    request: AcpPromptRequest,
    delivery: PlanContinuationDelivery | undefined,
    onProviderDispatched: () => void
  ) => Promise<PromptResponse>
  scheduleContinuation: (sessionId: string) => void
}>

const log = createLogger('acp')
const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}
const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

const PLAN_DELIVERY_CLAIM_MAX_ATTEMPTS = 3
const PLAN_DELIVERY_CLAIM_RETRY_BASE_DELAY_MS = 25
type PlanDeliveryClaimRetry = {
  commandId: string
  failedAttempts: number
  timer?: ReturnType<typeof setTimeout>
}

// Coalesces preparation wakeups separately from the generation-blocking continuation queue.
// Teardown callers clear retries both before and after asynchronous disposal: teardown may
// schedule another retry. This workflow remains reusable after disconnect/update refusal.
class AcpPlanContinuationWorkflow {
  private durablePlanDeliveries?: Map<string, PlanContinuationDelivery>
  private readonly planDeliveryClaimRetries = new Map<string, PlanDeliveryClaimRetry>()
  private readonly planDeliveryPreparations = new Set<string>()
  private readonly planDeliveryPreparationRequests = new Map<string, string | undefined>()
  constructor(private readonly deps: PlanContinuationDependencies) {}
  clearRetry(sessionId: string, commandId?: string): void {
    const retry = this.planDeliveryClaimRetries.get(sessionId)
    if (!retry || (commandId && retry.commandId !== commandId)) return
    if (retry.timer) clearTimeout(retry.timer)
    this.planDeliveryClaimRetries.delete(sessionId)
  }

  clearRetries(): void {
    for (const sessionId of this.planDeliveryClaimRetries.keys()) {
      this.clearRetry(sessionId)
    }
  }

  private retryPlanDeliveryClaim(projectId: string, sessionId: string, commandId: string): void {
    const current = this.planDeliveryClaimRetries.get(sessionId)
    if (current && current.commandId !== commandId) {
      this.clearRetry(sessionId)
    }
    const failedAttempts = current?.commandId === commandId ? current.failedAttempts + 1 : 1
    const retry: PlanDeliveryClaimRetry = { commandId, failedAttempts }
    this.planDeliveryClaimRetries.set(sessionId, retry)
    if (failedAttempts >= PLAN_DELIVERY_CLAIM_MAX_ATTEMPTS) {
      this.deps.publication.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId,
        title: 'Could not claim the Plan delivery',
        text: 'The Plan delivery remained safely queued after concurrent Session updates.'
      })
      this.deps.publication.emitState()
      return
    }
    const delay = PLAN_DELIVERY_CLAIM_RETRY_BASE_DELAY_MS * 2 ** (failedAttempts - 1)
    retry.timer = setTimeout(() => {
      const pending = this.planDeliveryClaimRetries.get(sessionId)
      if (pending !== retry) return
      retry.timer = undefined
      this.schedule(projectId, sessionId, commandId)
    }, delay)
  }

  schedule(projectId: string, sessionId: string, expectedCommandId?: string): void {
    queueMicrotask(() => {
      void this.queueDurablePlanDelivery(projectId, sessionId, expectedCommandId).catch((error) => {
        this.deps.publication.pushEvent({
          kind: 'error',
          level: 'error',
          sessionId,
          title: 'Could not prepare the Plan delivery',
          text: errorMessage(error)
        })
        this.deps.publication.emitState()
      })
    })
  }

  private async queueDurablePlanDelivery(
    projectId: string,
    sessionId: string,
    expectedCommandId?: string
  ): Promise<void> {
    // A resume scan can still be reading the old context when a response commits a
    // new command. Coalesce wakeups, not commands: every wakeup must get a fresh read
    // after the current inspection, while durable receipts still own dispatch.
    if (!this.planDeliveryPreparationRequests.has(sessionId)) {
      this.planDeliveryPreparationRequests.set(sessionId, expectedCommandId)
    } else if (this.planDeliveryPreparationRequests.get(sessionId) !== expectedCommandId) {
      // Mixed command-specific retries and general wakeups must inspect the current
      // command, rather than letting a stale retry mask a newer committed response.
      this.planDeliveryPreparationRequests.set(sessionId, undefined)
    }
    if (this.planDeliveryPreparations.has(sessionId)) return
    this.planDeliveryPreparations.add(sessionId)
    try {
      while (this.planDeliveryPreparationRequests.has(sessionId)) {
        const commandId = this.planDeliveryPreparationRequests.get(sessionId)
        this.planDeliveryPreparationRequests.delete(sessionId)
        await this.prepareDurablePlanDelivery(projectId, sessionId, commandId)
      }
    } finally {
      this.planDeliveryPreparations.delete(sessionId)
      if (this.planDeliveryPreparationRequests.has(sessionId)) {
        const commandId = this.planDeliveryPreparationRequests.get(sessionId)
        this.planDeliveryPreparationRequests.delete(sessionId)
        this.schedule(projectId, sessionId, commandId)
      }
    }
  }

  private async prepareDurablePlanDelivery(
    projectId: string,
    sessionId: string,
    expectedCommandId?: string
  ): Promise<void> {
    const owner = this.deps.deliveries
    const sessions = this.deps.sessions
    if (
      !owner ||
      !sessions ||
      !this.deps.hasActiveSession(sessionId) ||
      this.durablePlanDeliveries?.has(sessionId)
    ) {
      return
    }

    const observed = await sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = observed.plan
    const rawCommand = plan?.delivery
    const claimRetry = this.planDeliveryClaimRetries.get(sessionId)
    if (expectedCommandId && rawCommand?.commandId !== expectedCommandId) {
      this.clearRetry(sessionId, expectedCommandId)
      return
    }
    if (claimRetry && claimRetry.commandId !== rawCommand?.commandId) {
      this.clearRetry(sessionId)
    } else if (
      claimRetry?.timer ||
      claimRetry?.failedAttempts === PLAN_DELIVERY_CLAIM_MAX_ATTEMPTS
    ) {
      return
    }
    const command = matchPlanDelivery(plan)
    if (!plan || !command) {
      if (rawCommand) this.clearRetry(sessionId, rawCommand.commandId)
      return
    }
    if (command.state === 'accepted') {
      if (!(await owner.clear(projectId, sessionId, command.commandId))) {
        this.retryPlanDeliveryClaim(projectId, sessionId, command.commandId)
      } else {
        this.clearRetry(sessionId, command.commandId)
        await this.publishCurrentPlanProjection(projectId, sessionId)
      }
      return
    }
    if (command.state === 'delivering') {
      this.clearRetry(sessionId, command.commandId)
      // Persisted delivering alone cannot prove that the provider never received this command.
      this.deps.publication.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId,
        title: 'Plan delivery outcome is uncertain',
        text: 'This Plan delivery may already have been accepted by the Agent. It was not sent again. Check the conversation before sending another execution request.'
      })
      this.deps.publication.emitState()
      return
    }
    if (command.state !== 'queued') {
      this.clearRetry(sessionId, command.commandId)
      return
    }

    const continuation = await this.deps.context.prepare({
      projectId,
      sessionId,
      promptMessageId: command.originatingPromptMessageId,
      replayIfContextReset: true
    })
    const reviewFeedback =
      command.kind === 'review-feedback'
        ? (await sessions.loadSessionForContinuation(projectId, sessionId)).messages.find(
            (message) =>
              message.id === command.originatingPromptMessageId &&
              message.role === 'user' &&
              message.status === 'complete'
          )
        : undefined
    if (command.kind === 'review-feedback' && !reviewFeedback) {
      throw new Error('The durable Plan review feedback Message is unavailable.')
    }
    const durablePlanDeliveries =
      this.durablePlanDeliveries ?? new Map<string, PlanContinuationDelivery>()
    this.durablePlanDeliveries = durablePlanDeliveries
    durablePlanDeliveries.set(sessionId, {
      projectId,
      commandId: command.commandId,
      ...(plan.externalResponse?.commandId === command.commandId && plan.originatingPromptMessageId
        ? {
            externalOriginPromptId: plan.originatingPromptMessageId,
            externalOriginRunId: plan.originatingTaskRunId
          }
        : {})
    })
    const rejected = command.kind === 'rejected-plan'
    const reviewed = command.kind === 'review-feedback'
    const request: AcpPromptRequest = {
      sessionId,
      text: reviewed
        ? 'The user provided review feedback for the pending Session Plan. Interpret the ' +
          'feedback, then call generate_plan with decision:"approved", decision:"rejected", ' +
          'or a revised Plan as appropriate. Do not treat the feedback text itself as a decision.\n\n' +
          `Review feedback:\n${reviewFeedback?.content}`
        : rejected
          ? 'The user rejected the pending Session Plan. Acknowledge that decision and do not ' +
            `execute that rejected Plan Artifact Version (artifact_version_id=${plan.artifactVersionId}). ` +
            "Await or follow the user's next request without reviving the rejected Plan."
          : 'The user approved the pending Session Plan. Continue execution of exactly that ' +
            `approved Plan Artifact Version (artifact_version_id=${plan.artifactVersionId}). ` +
            'Do not regenerate, broaden, or reinterpret the approved Plan.',
      memoryEnabled: continuation.memoryEnabled,
      suppressUserMessage: true,
      provenanceContext: continuation.provenanceContext,
      ...(continuation.referencedSessions?.length
        ? { referencedSessions: continuation.referencedSessions }
        : {}),
      ...(continuation.parts?.length ? { parts: continuation.parts } : {}),
      ...(continuation.historyReplay?.historyPreamble
        ? { historyPreamble: continuation.historyReplay.historyPreamble }
        : {}),
      ...(continuation.historyReplay?.historyAttachments.length
        ? { historyAttachments: continuation.historyReplay.historyAttachments }
        : {}),
      ...(continuation.historyReplay?.historyImages.length
        ? { historyImages: continuation.historyReplay.historyImages }
        : {})
    }
    this.deps.continuations.set(sessionId, {
      condition: 'always',
      request,
      send: (request, onProviderDispatched) => {
        const delivery = this.durablePlanDeliveries?.get(sessionId)
        return this.deps.send(request, delivery, onProviderDispatched)
      },
      settle: (outcome) => this.settlePlanContinuation(sessionId, outcome),
      beforeSend: async () => {
        if (!(await owner.begin(projectId, sessionId, command.commandId))) {
          durablePlanDeliveries.delete(sessionId)
          const latest = await sessions.readSessionRuntimeContext(projectId, sessionId)
          if (
            latest.plan?.delivery?.commandId === command.commandId &&
            latest.plan.delivery.state === 'queued'
          ) {
            this.retryPlanDeliveryClaim(projectId, sessionId, command.commandId)
          } else {
            this.clearRetry(sessionId, command.commandId)
          }
          return undefined
        }
        this.clearRetry(sessionId, command.commandId)
        let dispatchReady = false
        try {
          const claimed = await sessions.readSessionRuntimeContext(projectId, sessionId)
          const claimedPlan = claimed.plan
          if (
            !matchPlanDelivery(claimedPlan, {
              artifactVersionId: plan.artifactVersionId,
              commandId: command.commandId,
              state: 'delivering',
              kind: command.kind,
              originatingPromptMessageId: command.originatingPromptMessageId
            })
          ) {
            throw new Error('The Plan delivery changed before dispatch.')
          }
          dispatchReady = true
          return request
        } finally {
          if (!dispatchReady) {
            durablePlanDeliveries.delete(sessionId)
            await owner.rearmUnaccepted(projectId, sessionId, command.commandId)
          }
        }
      }
    })
    this.deps.scheduleContinuation(sessionId)
  }

  private async settlePlanContinuation(
    sessionId: string,
    outcome: AcpContinuationOutcome
  ): Promise<void> {
    const durablePlan = this.durablePlanDeliveries?.get(sessionId)
    if (outcome.stopReason === 'cancelled' && durablePlan && this.deps.deliveries) {
      try {
        await this.deps.deliveries.interrupt(
          durablePlan.projectId,
          sessionId,
          durablePlan.commandId
        )
      } catch (error) {
        this.deps.publication.pushEvent({
          kind: 'error',
          level: 'error',
          sessionId,
          title: 'Could not mark the Plan delivery as interrupted',
          text: errorMessage(error)
        })
      }
    } else if (outcome.stopReason !== undefined && durablePlan && this.deps.deliveries) {
      try {
        await this.clearSettledPlanDelivery(sessionId, durablePlan)
      } catch (error) {
        this.deps.publication.pushEvent({
          kind: 'error',
          level: 'error',
          sessionId,
          title: 'Could not settle the Plan delivery',
          text: errorMessage(error)
        })
      }
    }
    if (durablePlan) await this.publishCurrentPlanProjection(durablePlan.projectId, sessionId)
    if (durablePlan) this.durablePlanDeliveries?.delete(sessionId)
  }

  private async clearSettledPlanDelivery(
    sessionId: string,
    durablePlan: Readonly<{ projectId: string; commandId: string }>
  ): Promise<void> {
    const owner = this.deps.deliveries
    const sessions = this.deps.sessions
    if (!owner || !sessions) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await owner.clear(durablePlan.projectId, sessionId, durablePlan.commandId)) return
      const current = await sessions.readSessionRuntimeContext(durablePlan.projectId, sessionId)
      const delivery = current.plan?.delivery
      if (!delivery) return
      if (
        delivery.commandId !== durablePlan.commandId ||
        (delivery.state !== 'accepted' && delivery.state !== 'delivering')
      ) {
        throw new Error('The Plan delivery changed before settlement.')
      }
    }
    throw new Error('The Plan delivery could not be settled after concurrent updates.')
  }

  private async publishCurrentPlanProjection(projectId: string, sessionId: string): Promise<void> {
    try {
      const projection = await this.deps.projection(projectId, sessionId)
      if (!projection) return
      this.deps.publication.pushEvent({
        id: `session-plan-${projection.artifactVersionId}-${projection.revision}`,
        timestamp: Date.now(),
        kind: 'plan',
        level: 'info',
        sessionId,
        title: 'Session Plan updated',
        planProjection: projection
      })
    } catch (error) {
      safeLogError('Session Plan delivery projection failed', errorLogFields(error))
    }
  }
}
export { AcpPlanContinuationWorkflow }
export type { PlanContinuationDependencies }

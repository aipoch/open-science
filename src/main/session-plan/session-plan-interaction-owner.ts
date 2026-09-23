import { randomUUID } from 'node:crypto'
import { PlanCommandError } from '../../shared/session-plan/contract'

type SessionPlanInteractionIdentity = Readonly<{
  artifactVersionId: string
  interactionId: string
}>

type SessionPlanApprovalParking = Readonly<{
  interactionId: string
  response: Promise<unknown>
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}>

type SessionPlanAgentDecisionAuthorization = Readonly<{
  artifactVersionId: string
  interactionSequence: number
}>

type SessionPlanProviderPause = {
  interactionSequence: number
  response: Promise<unknown>
  stopObserved: boolean
  dispose: () => void
}

type SessionPlanInteractionRow = {
  reviewRequest?: Readonly<{ artifactVersionId: string; id: string }>
  providerPause?: SessionPlanProviderPause
  identity?: SessionPlanInteractionIdentity
  approvalReservation?: string
  approval?: SessionPlanApprovalParking
  agentDecisionAuthorization?: SessionPlanAgentDecisionAuthorization
}

class SessionPlanInteractionOwner {
  private readonly rows = new Map<string, SessionPlanInteractionRow>()

  register({
    sessionId,
    artifactVersionId,
    interactionId
  }: SessionPlanInteractionIdentity & Readonly<{ sessionId: string }>): void {
    const row = this.rows.get(sessionId) ?? {}
    row.identity = { artifactVersionId, interactionId }
    delete row.agentDecisionAuthorization
    this.rows.set(sessionId, row)
  }

  interactionIdFor(sessionId: string, artifactVersionId: string): string | undefined {
    const identity = this.rows.get(sessionId)?.identity
    return identity?.artifactVersionId === artifactVersionId ? identity.interactionId : undefined
  }

  release(sessionId: string, artifactVersionId: string): boolean {
    const row = this.rows.get(sessionId)
    if (row?.identity?.artifactVersionId !== artifactVersionId) return false
    delete row.identity
    this.prune(sessionId, row)
    return true
  }

  hasPendingApproval(sessionId: string): boolean {
    const row = this.rows.get(sessionId)
    return Boolean(row?.approvalReservation || row?.approval || row?.providerPause)
  }

  reserveApproval(sessionId: string, interactionId: string): void {
    const row = this.rows.get(sessionId) ?? {}
    if (row.approvalReservation || row.approval) {
      throw new PlanCommandError(
        'approval-already-pending',
        'A Session Plan is already awaiting approval.'
      )
    }
    row.approvalReservation = interactionId
    this.rows.set(sessionId, row)
  }

  releaseApprovalReservation(sessionId: string, interactionId: string): boolean {
    const row = this.rows.get(sessionId)
    if (row?.approvalReservation !== interactionId) return false
    delete row.approvalReservation
    this.prune(sessionId, row)
    return true
  }

  parkReservedApproval(sessionId: string, interactionId: string): Promise<unknown> {
    const row = this.rows.get(sessionId)
    if (row?.approvalReservation !== interactionId) {
      throw new Error('The Session Plan approval reservation is no longer available.')
    }
    delete row.approvalReservation
    return this.parkApproval(sessionId, interactionId)
  }

  parkApproval(sessionId: string, interactionId: string): Promise<unknown> {
    const row = this.rows.get(sessionId) ?? {}
    if (row.approvalReservation || row.approval) {
      throw new PlanCommandError(
        'approval-already-pending',
        'A Session Plan is already awaiting approval.'
      )
    }
    this.rows.set(sessionId, row)
    let resolve!: (result: unknown) => void
    let reject!: (error: Error) => void
    const response = new Promise((accept, fail) => {
      resolve = accept
      reject = fail
    })
    row.approval = { interactionId, response, resolve, reject }
    if (row.identity) {
      // Keep this identity after settlement so receipt refreshes do not reopen the
      // submitted card. Only another actual approval wait creates a new review.
      row.reviewRequest = { artifactVersionId: row.identity.artifactVersionId, id: randomUUID() }
    }
    return response
  }

  approvalResponseFor(sessionId: string): Promise<unknown> | undefined {
    return this.rows.get(sessionId)?.approval?.response
  }

  reviewRequestIdFor(sessionId: string, artifactVersionId: string): string | undefined {
    const review = this.rows.get(sessionId)?.reviewRequest
    return review?.artifactVersionId === artifactVersionId ? review.id : undefined
  }

  suspendProvider(
    sessionId: string,
    interactionSequence: number,
    response: Promise<unknown>,
    requestStop: () => () => void
  ): void {
    const row = this.rows.get(sessionId)
    if (!row?.approval || row.providerPause)
      throw new Error('No Plan approval can suspend the Provider.')
    // Publish ownership before requesting cancellation: an immediate provider stop must find it.
    const pause: SessionPlanProviderPause = {
      interactionSequence,
      response,
      stopObserved: false,
      dispose: () => undefined
    }
    row.providerPause = pause
    pause.dispose = requestStop()
    if (pause.stopObserved) pause.dispose()
  }

  providerPauseFor(
    sessionId: string,
    interactionSequence?: number
  ): SessionPlanProviderPause | undefined {
    const pause = this.rows.get(sessionId)?.providerPause
    return interactionSequence === undefined || pause?.interactionSequence === interactionSequence
      ? pause
      : undefined
  }

  observeProviderStop(
    sessionId: string,
    interactionSequence: number
  ): SessionPlanProviderPause | undefined {
    const pause = this.providerPauseFor(sessionId, interactionSequence)
    if (pause) {
      pause.stopObserved = true
      pause.dispose()
    }
    return pause
  }

  releaseProviderPause(sessionId: string, expected: SessionPlanProviderPause): boolean {
    const row = this.rows.get(sessionId)
    if (row?.providerPause !== expected) return false
    expected.dispose()
    delete row.providerPause
    this.prune(sessionId, row)
    return true
  }

  approvalInteractionIdFor(sessionId: string): string | undefined {
    return this.rows.get(sessionId)?.approval?.interactionId
  }

  // The parking object is an opaque, non-reusable identity, including when a prompt ID is reused.
  approvalTokenFor(sessionId: string): object | undefined {
    return this.rows.get(sessionId)?.approval
  }

  resolveApproval(sessionId: string, result: unknown, expectedToken: object | undefined): boolean {
    const row = this.rows.get(sessionId)
    const approval = row?.approval
    if (!row || !approval || approval !== expectedToken) return false
    delete row.approval
    this.prune(sessionId, row)
    approval.resolve(result)
    return true
  }

  rejectApproval(sessionId: string, reason: string): boolean {
    const row = this.rows.get(sessionId)
    const approval = row?.approval
    if (!row || !approval) return false
    delete row.approval
    this.prune(sessionId, row)
    approval.reject(new Error(reason))
    return true
  }

  authorizeAgentDecision({
    sessionId,
    artifactVersionId,
    interactionSequence
  }: SessionPlanAgentDecisionAuthorization & Readonly<{ sessionId: string }>): void {
    const row = this.rows.get(sessionId) ?? {}
    row.agentDecisionAuthorization = { artifactVersionId, interactionSequence }
    this.rows.set(sessionId, row)
  }

  isAgentDecisionAuthorized({
    sessionId,
    artifactVersionId,
    interactionSequence
  }: SessionPlanAgentDecisionAuthorization & Readonly<{ sessionId: string }>): boolean {
    const authorization = this.rows.get(sessionId)?.agentDecisionAuthorization
    return (
      authorization?.artifactVersionId === artifactVersionId &&
      authorization.interactionSequence === interactionSequence
    )
  }

  consumeAgentDecisionAuthorization(
    input: SessionPlanAgentDecisionAuthorization & Readonly<{ sessionId: string }>
  ): boolean {
    if (!this.isAgentDecisionAuthorized(input)) return false
    const row = this.rows.get(input.sessionId)
    if (!row) return false
    delete row.agentDecisionAuthorization
    this.prune(input.sessionId, row)
    return true
  }

  releaseAgentDecisionAuthorization(sessionId: string, interactionSequence: number): boolean {
    const row = this.rows.get(sessionId)
    if (row?.agentDecisionAuthorization?.interactionSequence !== interactionSequence) return false
    delete row.agentDecisionAuthorization
    this.prune(sessionId, row)
    return true
  }

  clearSession(sessionId: string, approvalReason: string): void {
    const row = this.rows.get(sessionId)
    if (!row) return
    this.rows.delete(sessionId)
    row.providerPause?.dispose()
    row.approval?.reject(new Error(approvalReason))
  }

  clearAll(approvalReason: string): void {
    const approvals = [...this.rows.values()].flatMap((row) => (row.approval ? [row.approval] : []))
    for (const row of this.rows.values()) {
      row.providerPause?.dispose()
    }
    this.rows.clear()
    for (const approval of approvals) approval.reject(new Error(approvalReason))
  }

  private prune(sessionId: string, row: SessionPlanInteractionRow): void {
    if (
      !row.providerPause &&
      !row.reviewRequest &&
      !row.identity &&
      !row.approvalReservation &&
      !row.approval &&
      !row.agentDecisionAuthorization
    ) {
      this.rows.delete(sessionId)
    }
  }
}

export { SessionPlanInteractionOwner }

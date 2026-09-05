import { PlanCommandError } from '../../shared/session-plan/contract'

type SessionPlanInteractionIdentity = Readonly<{
  artifactVersionId: string
  interactionId: string
}>

type SessionPlanApprovalParking = Readonly<{
  interactionId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}>

type SessionPlanAgentDecisionAuthorization = Readonly<{
  artifactVersionId: string
  interactionSequence: number
}>

type SessionPlanInteractionRow = {
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
    return new Promise((resolve, reject) => {
      row.approval = { interactionId, resolve, reject }
    })
  }

  approvalInteractionIdFor(sessionId: string): string | undefined {
    return this.rows.get(sessionId)?.approval?.interactionId
  }

  resolveApproval(sessionId: string, result: unknown): boolean {
    const row = this.rows.get(sessionId)
    const approval = row?.approval
    if (!row || !approval) return false
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
    row.approval?.reject(new Error(approvalReason))
  }

  clearAll(approvalReason: string): void {
    const approvals = [...this.rows.values()].flatMap((row) => (row.approval ? [row.approval] : []))
    this.rows.clear()
    for (const approval of approvals) approval.reject(new Error(approvalReason))
  }

  private prune(sessionId: string, row: SessionPlanInteractionRow): void {
    if (
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

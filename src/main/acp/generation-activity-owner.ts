export type AcpGenerationActivityBlockers = Readonly<{
  reconnect: boolean
  retirement: boolean
}>
export type AcpGenerationStartupToken = symbol

type AcpGenerationActivityOwnerOptions = Readonly<{
  activityChanged: () => void
  hasActivePrompts: () => boolean
  hasActiveReviewerSessions: () => boolean
}>

// Owns the balanced leases and startup membership for one backend generation. Transition intent stays
// in AcpConnectionTransitionOwner, which observes only this immutable blocker projection.
export class AcpGenerationActivityOwner {
  private activityLeaseCount = 0
  private operationLeaseCount = 0
  private readonly startupTokens = new Set<AcpGenerationStartupToken>()
  private additionalActivity: (() => boolean) | undefined

  constructor(private readonly options: AcpGenerationActivityOwnerOptions) {}

  blockers(): AcpGenerationActivityBlockers {
    const reconnect =
      this.options.hasActivePrompts() ||
      this.options.hasActiveReviewerSessions() ||
      this.additionalActivity?.() === true ||
      this.activityLeaseCount > 0 ||
      this.startupTokens.size > 0
    return Object.freeze({
      reconnect,
      retirement: reconnect || this.operationLeaseCount > 0
    })
  }

  bindAdditionalActivity(probe: () => boolean): void {
    if (this.additionalActivity) {
      throw new Error('ACP generation additional activity is already bound.')
    }
    this.additionalActivity = probe
  }

  async withOperation<T>(work: () => Promise<T>): Promise<T> {
    this.operationLeaseCount += 1
    try {
      return await work()
    } finally {
      this.operationLeaseCount -= 1
      this.options.activityChanged()
    }
  }

  async withActivity<T>(work: () => Promise<T>): Promise<T> {
    this.activityLeaseCount += 1
    try {
      return await work()
    } finally {
      this.activityLeaseCount -= 1
      this.options.activityChanged()
    }
  }

  acquireStartup(token: AcpGenerationStartupToken): void {
    this.changeStartupFacts(() => this.startupTokens.add(token))
  }

  releaseStartup(token: AcpGenerationStartupToken): void {
    this.changeStartupFacts(() => this.startupTokens.delete(token))
  }

  invalidateStartups(): void {
    this.changeStartupFacts(() => this.startupTokens.clear())
  }

  private changeStartupFacts(change: () => void): void {
    // Session and Reviewer startups run inside an operation. Coalesce their synchronous
    // startup-token-to-active-owner handoff so transition arbitration never observes a false idle gap.
    if (this.operationLeaseCount > 0) {
      change()
      return
    }
    this.changeFacts(change)
  }

  private changeFacts(change: () => void): void {
    const before = this.blockers()
    change()
    const after = this.blockers()
    if (before.reconnect !== after.reconnect || before.retirement !== after.retirement) {
      this.options.activityChanged()
    }
  }
}

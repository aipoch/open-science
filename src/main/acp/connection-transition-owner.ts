export type AcpConnectionTransitionBlockers = Readonly<{
  reconnect: boolean
  retirement: boolean
}>

type AcpConnectionTransitionOwnerOptions = Readonly<{
  blockers: () => AcpConnectionTransitionBlockers
  connectionGeneration: () => number
  disconnect: (emitClosedStatus: boolean) => Promise<unknown>
  onRetired: () => void
  publishIdle: () => void
  recoverFailedDeferredDisconnect: (error: unknown) => void | Promise<void>
  reportFailure: (message: string, error: unknown) => void
}>

// Owns provider, skills, and retirement replacement intents plus the barrier awaited by connection
// startup. Prompt/Reviewer/startup/activity leases remain with Runtime and are observed as one narrow
// blocker snapshot; physical resources remain exclusively owned by AcpConnectionResourceOwner.
export class AcpConnectionTransitionOwner {
  private providerIntent = false
  private skillsIntent = false
  private retirementIntent = false
  private retirementStarted = false
  private barrierPromise: Promise<void> | undefined
  private resolveBarrier: (() => void) | undefined
  private barrierGeneration = 0

  constructor(private readonly options: AcpConnectionTransitionOwnerOptions) {}

  get barrier(): Promise<void> | undefined {
    return this.barrierPromise
  }

  get providerReconnectPending(): boolean {
    return this.providerIntent
  }

  async requestProviderReconnect(): Promise<void> {
    if (this.options.blockers().reconnect) {
      this.providerIntent = true
      this.armBarrier()
      return
    }

    this.providerIntent = false
    await this.disconnectPlanned()
  }

  requestSkillsReload(): void {
    this.skillsIntent = true
    this.activityChanged()
  }

  async requestRetirement(): Promise<void> {
    if (this.retirementStarted) return
    this.retirementIntent = true
    if (this.options.blockers().retirement) return
    await this.startRetirement()
  }

  activityChanged(): void {
    if (this.retirementIntent) {
      if (this.options.blockers().retirement) return
      void this.startRetirement()
      return
    }

    if (this.options.blockers().reconnect) return
    if (!this.providerIntent && !this.skillsIntent) return

    this.providerIntent = false
    this.skillsIntent = false
    void this.disconnectDeferred()
  }

  async settleTeardown<T>(teardown: () => Promise<T>): Promise<T> {
    const expectedBarrierGeneration = this.barrierGeneration
    try {
      return await teardown()
    } finally {
      this.completeReconnect(expectedBarrierGeneration)
    }
  }

  resetReconnect(): void {
    this.completeReconnect()
  }

  private async disconnectDeferred(): Promise<void> {
    const expectedBarrierGeneration = this.barrierGeneration
    try {
      await this.disconnectPlanned()
    } catch (error) {
      this.reportFailure('deferred reconnect disconnect failed', error)
      try {
        await this.options.recoverFailedDeferredDisconnect(error)
      } catch (recoveryError) {
        this.reportFailure('failed deferred reconnect recovery failed', recoveryError)
      }
    } finally {
      // A newer provider intent may have armed another generation while teardown settled.
      this.completeReconnect(expectedBarrierGeneration)
    }
  }

  private async disconnectPlanned(): Promise<void> {
    const disconnect = this.options.disconnect(false)
    const teardownGeneration = this.options.connectionGeneration()
    await disconnect
    if (teardownGeneration === this.options.connectionGeneration()) this.options.publishIdle()
  }

  private async startRetirement(): Promise<void> {
    if (this.retirementStarted) return
    this.retirementStarted = true
    this.retirementIntent = false
    this.providerIntent = false
    this.skillsIntent = false

    try {
      await this.options.disconnect(false)
    } catch (error) {
      this.reportFailure('retired runtime disconnect failed', error)
    } finally {
      this.completeReconnect()
      try {
        this.options.onRetired()
      } catch (error) {
        this.reportFailure('retired runtime callback failed', error)
      }
    }
  }

  private armBarrier(): void {
    this.barrierGeneration += 1
    if (this.barrierPromise) return
    this.barrierPromise = new Promise<void>((resolve) => {
      this.resolveBarrier = resolve
    })
  }

  private completeReconnect(expectedBarrierGeneration?: number): void {
    if (
      expectedBarrierGeneration !== undefined &&
      expectedBarrierGeneration !== this.barrierGeneration
    ) {
      return
    }
    this.providerIntent = false
    this.skillsIntent = false
    const resolve = this.resolveBarrier
    this.barrierPromise = undefined
    this.resolveBarrier = undefined
    resolve?.()
  }

  private reportFailure(message: string, error: unknown): void {
    try {
      this.options.reportFailure(message, error)
    } catch {
      // Intent cleanup and barrier release take precedence over diagnostic sinks.
    }
  }
}

export const ACP_IDLE_RELEASE_DELAY_MS = 60_000
const MAX_IDLE_CONNECTIONS = 2

export type AcpConnectionTransitionBlockers = Readonly<{
  reconnect: boolean
  retirement: boolean
}>

type AcpConnectionTransitionOwnerOptions = Readonly<{
  blockers: () => AcpConnectionTransitionBlockers
  connectionGeneration: () => number
  disconnect: (emitClosedStatus: boolean) => Promise<unknown>
  cleanupConfirmed: () => boolean
  onRetired: () => void
  publishIdle: () => void
  recoverFailedDeferredDisconnect: (
    error: unknown,
    disconnectedGeneration: number
  ) => void | Promise<void>
  reportFailure: (message: string, error: unknown) => void
}>

// Owns provider, skills, and retirement replacement intents plus the barrier awaited by connection
// startup. Prompt/Reviewer/startup/activity leases remain with Runtime and are observed as one narrow
// blocker snapshot; physical resources remain exclusively owned by AcpConnectionResourceOwner.
export class AcpConnectionTransitionOwner {
  // Process-wide reuse budget; active and cleanup-owned resources are never cache entries.
  private static readonly idleConnections = new Map<AcpConnectionTransitionOwner, () => void>()
  private providerIntent = false
  private skillsIntent = false
  private idleReleaseIntent = false
  private idleReleaseTimer: ReturnType<typeof setTimeout> | undefined
  private retirementIntent = false
  private retirementCompleted = false
  private retirementInFlight: Promise<void> | undefined
  private plannedDisconnect: Promise<void> | undefined
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
    this.cancelIdleReleaseTimer()
    if (this.plannedDisconnect) return this.plannedDisconnect
    if (this.options.blockers().reconnect) {
      this.providerIntent = true
      this.armBarrier()
      return
    }

    this.providerIntent = false
    await this.disconnectPlanned()
  }

  requestSkillsReload(): void {
    this.cancelIdleReleaseTimer()
    this.skillsIntent = true
    this.activityChanged()
  }

  requestIdleRelease(): void {
    this.idleReleaseIntent = true
    this.activityChanged()
  }

  async requestRetirement(): Promise<void> {
    if (this.retirementCompleted) return
    if (this.retirementInFlight) return this.retirementInFlight
    this.cancelIdleReleaseTimer()
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

    if (this.plannedDisconnect) return
    if (this.options.blockers().reconnect) {
      this.cancelIdleReleaseTimer()
      return
    }
    if (!this.providerIntent && !this.skillsIntent) {
      if (!this.idleReleaseIntent || this.options.blockers().retirement) {
        this.cancelIdleReleaseTimer()
        return
      }
      if (!this.idleReleaseTimer) {
        const generation = this.options.connectionGeneration()
        const releaseIdleConnection = (): void => {
          this.cancelIdleReleaseTimer()
          if (generation !== this.options.connectionGeneration()) {
            this.idleReleaseIntent = false
            return
          }
          if (this.options.blockers().retirement || this.options.blockers().reconnect) return
          this.idleReleaseIntent = false
          void this.disconnectDeferred()
        }
        this.idleReleaseTimer = setTimeout(releaseIdleConnection, ACP_IDLE_RELEASE_DELAY_MS)
        this.idleReleaseTimer.unref?.()
        AcpConnectionTransitionOwner.idleConnections.set(this, releaseIdleConnection)
        while (AcpConnectionTransitionOwner.idleConnections.size > MAX_IDLE_CONNECTIONS) {
          AcpConnectionTransitionOwner.idleConnections.values().next().value!()
        }
      }
      return
    }

    this.providerIntent = false
    this.skillsIntent = false
    this.idleReleaseIntent = false
    void this.disconnectDeferred()
  }

  async settleTeardown<T>(teardown: () => Promise<T>): Promise<T> {
    this.cancelIdleReleaseTimer()
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
    // Active reviewer work may send more prompts before releasing its lease. Block startup only
    // once this deferred intent can actually begin tearing down the connection.
    this.armBarrier()
    const expectedBarrierGeneration = this.barrierGeneration
    const disconnectedGeneration = this.options.connectionGeneration()
    try {
      await this.disconnectPlanned()
    } catch (error) {
      this.reportFailure('deferred reconnect disconnect failed', error)
      try {
        await this.options.recoverFailedDeferredDisconnect(error, disconnectedGeneration)
      } catch (recoveryError) {
        this.reportFailure('failed deferred reconnect recovery failed', recoveryError)
      }
    } finally {
      // A newer provider intent may have armed another generation while teardown settled.
      this.completeReconnect(expectedBarrierGeneration)
    }
  }

  private disconnectPlanned(): Promise<void> {
    if (this.plannedDisconnect) return this.plannedDisconnect
    const completion = Promise.withResolvers<void>()
    // Publish ownership before disconnect's synchronous cleanup can notify activity changes.
    this.plannedDisconnect = completion.promise.finally(() => {
      this.plannedDisconnect = undefined
    })
    void this.performPlannedDisconnect().then(completion.resolve, completion.reject)
    return this.plannedDisconnect
  }

  private async performPlannedDisconnect(): Promise<void> {
    const disconnect = this.options.disconnect(false)
    const teardownGeneration = this.options.connectionGeneration()
    await disconnect
    if (teardownGeneration === this.options.connectionGeneration()) this.options.publishIdle()
  }

  private startRetirement(): Promise<void> {
    if (this.retirementInFlight) return this.retirementInFlight
    if (this.retirementCompleted) return Promise.resolve()
    const completion = Promise.withResolvers<void>()
    this.retirementInFlight = completion.promise
    const clear = (): void => {
      this.retirementInFlight = undefined
    }
    void completion.promise.then(clear, clear)
    void this.performRetirement().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async performRetirement(): Promise<void> {
    this.providerIntent = false
    this.skillsIntent = false
    this.idleReleaseIntent = false

    try {
      await (this.plannedDisconnect ?? this.options.disconnect(false))
      // Ordinary disconnect also resolves when a process cannot be reaped. Retirement must keep
      // ownership in that case, including when it joined an already planned disconnect.
      if (!this.options.cleanupConfirmed()) throw new Error('ACP runtime cleanup is not confirmed.')
      this.retirementCompleted = true
      this.retirementIntent = false
    } catch (error) {
      this.reportFailure('retired runtime disconnect failed', error)
      // Retry only on a later request or activity notification, never recursively from settlement.
    } finally {
      this.completeReconnect()
    }
    if (!this.retirementCompleted) return
    try {
      this.options.onRetired()
    } catch (error) {
      this.reportFailure('retired runtime callback failed', error)
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
    this.cancelIdleReleaseTimer()
    this.providerIntent = false
    this.skillsIntent = false
    const resolve = this.resolveBarrier
    this.idleReleaseIntent = false
    this.barrierPromise = undefined
    this.resolveBarrier = undefined
    resolve?.()
  }

  private cancelIdleReleaseTimer(): void {
    AcpConnectionTransitionOwner.idleConnections.delete(this)
    if (this.idleReleaseTimer) clearTimeout(this.idleReleaseTimer)
    this.idleReleaseTimer = undefined
  }

  private reportFailure(message: string, error: unknown): void {
    try {
      this.options.reportFailure(message, error)
    } catch {
      // Intent cleanup and barrier release take precedence over diagnostic sinks.
    }
  }
}
